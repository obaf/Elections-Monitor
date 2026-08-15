import { createHmac, randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { ddb, textract, ssm, s3Get, item, plain, av } from './aws.mjs';
import { presignPut, readGps, inOsun, parseResults, signature, json, PARTIES } from './util.mjs';

const TABLE = process.env.TABLE;
const BUCKET = process.env.PHOTO_BUCKET;
const REGION = process.env.AWS_REGION || 'us-east-1';

const UPLOAD_ACK =
  'Once two photos from two different phones have been uploaded, and they’re ' +
  'the same, the result will be automatically added to the totals above';
const NO_LOCATION_ACK =
  'Thank you, but ensure location services are “turned on” in your phone ' +
  'settings to allow automatic addition to the totals';

/* ------------------------------- admin auth ------------------------------ */

let adminCache = null;
async function adminConfig() {
  if (adminCache) return adminCache;
  const r = await ssm('AmazonSSM.GetParameter', {
    Name: process.env.ADMIN_PARAM,
    WithDecryption: true,
  });
  adminCache = JSON.parse(r.Parameter.Value);
  return adminCache;
}

const tokenFor = (cfg, exp) =>
  createHmac('sha256', cfg.salt + cfg.hash).update(`${cfg.username}|${exp}`).digest('hex');

async function requireAdmin(event) {
  const auth = (event.headers?.authorization || event.headers?.Authorization || '').replace(/^Bearer\s+/i, '');
  const [exp, sig] = auth.split('.');
  if (!exp || !sig) return false;
  if (Number(exp) < Date.now()) return false;
  const cfg = await adminConfig();
  const want = tokenFor(cfg, exp);
  // Constant-time compare so the token cannot be probed byte by byte.
  const a = Buffer.from(sig, 'hex');
  const b = Buffer.from(want, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/* --------------------------------- data ---------------------------------- */

const put = (obj) => ddb('DynamoDB_20120810.PutItem', { TableName: TABLE, Item: item(obj) });

const get = async (pk, sk) => {
  const r = await ddb('DynamoDB_20120810.GetItem', {
    TableName: TABLE,
    Key: item({ pk, sk }),
  });
  return plain(r.Item);
};

const query = async (pk, extra = {}) => {
  const r = await ddb('DynamoDB_20120810.Query', {
    TableName: TABLE,
    KeyConditionExpression: 'pk = :p',
    ExpressionAttributeValues: { ':p': av(pk) },
    ...extra,
  });
  return (r.Items || []).map(plain);
};

async function bumpCount(puCode, counted) {
  await ddb('DynamoDB_20120810.UpdateItem', {
    TableName: TABLE,
    Key: item({ pk: 'CNT', sk: puCode }),
    UpdateExpression: 'SET n = if_not_exists(n, :z) + :one' + (counted ? ', v = :one' : ''),
    ExpressionAttributeValues: item(counted ? { ':z': 0, ':one': 1 } : { ':z': 0, ':one': 1 }),
  });
}

// The figures actually applied are snapshotted onto the counter item, so a
// later revoke subtracts exactly what was added rather than re-deriving it
// from the photos (which an admin may since have approved differently).
async function markCounted(puCode, results) {
  await ddb('DynamoDB_20120810.UpdateItem', {
    TableName: TABLE,
    Key: item({ pk: 'CNT', sk: puCode }),
    UpdateExpression: 'SET v = :one, n = if_not_exists(n, :z), st = :added, res = :r',
    ExpressionAttributeValues: item({ ':one': 1, ':z': 0, ':added': 'added', ':r': results || {} }),
  });
}

// Append-only: every entry is a fresh item under one partition, and nothing in
// the code updates or deletes them. Changing a total on an election portal is
// a contestable act, so the record of who did it and why has to outlive the
// state it changed.
async function audit(action, puCode, detail) {
  const ts = new Date().toISOString();
  await put({
    pk: 'AUDIT',
    sk: `${ts}#${randomUUID()}`,
    ts, action, puCode,
    actor: detail.actor || 'admin',
    reason: detail.reason || '',
    figures: detail.figures || {},
    // Records that a human changed the numbers away from what OCR read, and
    // what OCR had originally said, so an edit is never silent.
    edited: !!detail.edited,
    ocr: detail.ocr || {},
  });
}

/* An admin may correct a misread figure or add a party OCR missed entirely, so
 * these numbers arrive from a form rather than from Textract. Re-validated here
 * because a client that can post figures can post anything. */
function sanitiseFigures(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    const party = String(k).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
    if (!party) continue;
    const votes = Number(v);
    if (!Number.isInteger(votes) || votes < 0 || votes > 1_000_000) continue;
    out[party] = votes;
  }
  return Object.keys(out).length ? out : null;
}

// Subtracts the snapshot back out and records the decision. Kept as a distinct
// state rather than deleting the row, so the totals page can show that a
// result was deliberately withdrawn instead of never having arrived.
async function revokeCounted(puCode, reason, actor) {
  const cnt = await get('CNT', puCode);
  if (!cnt || !cnt.v) return { ok: false, reason: 'not currently added' };

  const applied = cnt.res || {};
  const negated = Object.fromEntries(Object.entries(applied).map(([k, v]) => [k, -v]));
  await addTotals(negated);

  await ddb('DynamoDB_20120810.UpdateItem', {
    TableName: TABLE,
    Key: item({ pk: 'CNT', sk: puCode }),
    // revRes keeps what was withdrawn, so the breakdown can still show the
    // figures a revoked unit used to contribute.
    UpdateExpression: 'SET v = :zero, st = :revoked, rsn = :why, rvk = :ts, revRes = :applied REMOVE res',
    ExpressionAttributeValues: item({
      ':zero': 0, ':revoked': 'revoked', ':why': reason,
      ':ts': new Date().toISOString(), ':applied': applied,
    }),
  });

  await audit('revoke', puCode, { reason, actor, figures: applied });
  return { ok: true, removed: applied, reason };
}

// Totals live in one item as a party -> votes map, updated with an additive
// SET so concurrent uploads for different polling units cannot clobber it.
async function addTotals(results) {
  const names = Object.keys(results);
  if (!names.length) return;
  const sets = [], eav = { ':z': av(0) }, ean = { '#p': 'p' };
  names.forEach((party, i) => {
    ean[`#k${i}`] = party;
    eav[`:v${i}`] = av(results[party]);
    sets.push(`#p.#k${i} = if_not_exists(#p.#k${i}, :z) + :v${i}`);
  });
  const args = {
    TableName: TABLE,
    Key: item({ pk: 'AGG', sk: 'TOTALS' }),
    UpdateExpression: 'SET ' + sets.join(', '),
    ExpressionAttributeNames: ean,
    ExpressionAttributeValues: eav,
  };
  try {
    await ddb('DynamoDB_20120810.UpdateItem', args);
  } catch (e) {
    // First write: the p map does not exist yet, so create it and retry.
    if (!/ValidationException/.test(String(e))) throw e;
    await put({ pk: 'AGG', sk: 'TOTALS', p: {} });
    await ddb('DynamoDB_20120810.UpdateItem', args);
  }
}

/* ----------------------------- party registry ---------------------------- */

/* The seed list in util.mjs cannot know every party on a real ballot, so the
 * set grows: parties read off a sheet, and parties an admin types into the
 * edit table, are both remembered. Once registered, a party is recognised on
 * every later photo even when it appears alongside unfamiliar text. */
let partyCache = { at: 0, set: null };

async function knownParties() {
  // Cached per container for a minute; a missed party is picked up on the next
  // upload rather than costing a read on every request.
  if (partyCache.set && Date.now() - partyCache.at < 60_000) return partyCache.set;
  const rec = await get('AGG', 'PARTIES');
  partyCache = { at: Date.now(), set: new Set(Object.keys(rec?.p || {})) };
  return partyCache.set;
}

async function registerParties(codes) {
  const fresh = [...new Set(codes)]
    .map((c) => String(c).toUpperCase().replace(/[^A-Z0-9]/g, ''))
    .filter((c) => c && c.length <= 12 && !PARTIES.includes(c));
  if (!fresh.length) return [];

  const known = await knownParties();
  const add = fresh.filter((c) => !known.has(c));
  if (!add.length) return [];

  const ts = new Date().toISOString();
  const sets = [], ean = { '#p': 'p' }, eav = { ':t': av(ts) };
  add.forEach((c, i) => {
    ean[`#k${i}`] = c;
    sets.push(`#p.#k${i} = if_not_exists(#p.#k${i}, :t)`);
  });
  const args = {
    TableName: TABLE,
    Key: item({ pk: 'AGG', sk: 'PARTIES' }),
    UpdateExpression: 'SET ' + sets.join(', '),
    ExpressionAttributeNames: ean,
    ExpressionAttributeValues: eav,
  };
  try {
    await ddb('DynamoDB_20120810.UpdateItem', args);
  } catch (e) {
    // First write: the p map does not exist yet.
    if (!/ValidationException/.test(String(e))) throw e;
    await put({ pk: 'AGG', sk: 'PARTIES', p: {} });
    await ddb('DynamoDB_20120810.UpdateItem', args);
  }
  partyCache = { at: 0, set: null };   // force a reload so the next parse sees them
  return add;
}

/* ------------------------------ upload flow ------------------------------ */

async function processUpload({ puCode, key, deviceId }) {
  // Pull the object once and use the same bytes for both EXIF and OCR.
  const buf = await s3Get(BUCKET, key);
  const gps = readGps(buf);
  const located = inOsun(gps);

  let extracted = {}, lines = [];
  try {
    const r = await textract('Textract.DetectDocumentText', {
      Document: { S3Object: { Bucket: BUCKET, Name: key } },
    });
    const blocks = (r.Blocks || [])
      .filter((b) => b.BlockType === 'LINE')
      .map((b) => ({ text: b.Text, box: b.Geometry?.BoundingBox }));
    lines = blocks.map((b) => b.text);
    // Geometry matters: the sheet is a table and each cell arrives as its own
    // line, so the score is found by position rather than by string proximity.
    const discovered = new Set();
    extracted = parseResults(blocks, { known: await knownParties(), discovered });
    if (discovered.size) {
      const added = await registerParties([...discovered]);
      if (added.length) console.log('new parties learned from upload:', added.join(', '));
    }
  } catch (e) {
    console.error('textract failed', String(e));
  }

  const uploadId = randomUUID();
  const ts = new Date().toISOString();
  const sig = signature(extracted);

  const record = {
    pk: `PU#${puCode}`,
    sk: `UPLOAD#${ts}#${uploadId}`,
    uploadId, puCode, key, ts, deviceId,
    gps: gps ? { lat: gps.lat, lon: gps.lon } : null,
    inOsun: located,
    extracted, sig,
    lines: lines.slice(0, 60),
    approved: false,
    counted: false,
  };
  await put(record);
  // Mirror into a recent-uploads feed the admin screen can read cheaply.
  await put({ ...record, pk: 'UPL', sk: `${ts}#${uploadId}` });
  await bumpCount(puCode, false);

  const verdict = await tryVerify(puCode);
  return { uploadId, extracted, inOsun: located, hasGps: !!gps, verified: verdict, ts };
}

// Eligible when two photos agree, both carry Osun coordinates, and they came
// from different devices. Runs after every upload; the CNT.v flag makes it
// idempotent so a third matching photo cannot double-count.
async function tryVerify(puCode) {
  const cnt = await get('CNT', puCode);
  if (cnt?.v) return true;
  // A revoked result stays revoked: the admin made a judgement, and a further
  // matching photo must not silently undo it. Re-approval is explicit.
  if (cnt?.st === 'revoked') return false;

  const uploads = (await query(`PU#${puCode}`)).filter((u) => u.sk?.startsWith('UPLOAD#'));
  const eligible = uploads.filter((u) => u.inOsun && u.sig && Object.keys(u.extracted || {}).length);

  for (let i = 0; i < eligible.length; i++) {
    for (let j = i + 1; j < eligible.length; j++) {
      if (eligible[i].sig !== eligible[j].sig) continue;
      if (eligible[i].deviceId === eligible[j].deviceId) continue;
      await addTotals(eligible[i].extracted);
      await markCounted(puCode, eligible[i].extracted);
      return true;
    }
  }
  return false;
}

/* -------------------------------- routing -------------------------------- */

export const handler = async (event) => {
  const method = event.requestContext?.http?.method || 'GET';
  const path = (event.rawPath || '/').replace(/^\/api/, '') || '/';
  const qs = event.queryStringParameters || {};
  let body = {};
  if (event.body) {
    try {
      body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString() : event.body);
    } catch { body = {}; }
  }

  try {
    /* ---- public ---- */

    if (method === 'POST' && path === '/upload-url') {
      const puCode = String(body.puCode || '').trim();
      if (!/^[0-9-]{6,20}$/.test(puCode)) return json(400, { error: 'bad polling unit' });
      const key = `photos/${puCode}/${randomUUID()}.jpg`;
      const url = presignPut({
        bucket: BUCKET, key, region: REGION,
        creds: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
          sessionToken: process.env.AWS_SESSION_TOKEN,
        },
      });
      return json(200, { url, key });
    }

    if (method === 'POST' && path === '/upload-done') {
      const puCode = String(body.puCode || '').trim();
      const key = String(body.key || '');
      const deviceId = String(body.deviceId || '').slice(0, 64);
      if (!key.startsWith(`photos/${puCode}/`)) return json(400, { error: 'bad key' });
      const r = await processUpload({ puCode, key, deviceId });
      return json(200, {
        ...r,
        message: r.hasGps && r.inOsun ? UPLOAD_ACK : NO_LOCATION_ACK,
      });
    }

    if (method === 'GET' && path === '/summary') {
      const [totals, counts] = await Promise.all([
        get('AGG', 'TOTALS'),
        query('CNT', { ProjectionExpression: 'sk, n, v, st' }),
      ]);
      const c = {};
      // Third element is the status; older clients read only the first two.
      for (const r of counts) c[r.sk] = [r.n || 0, r.v ? 1 : 0, r.st || ''];
      return json(200, { totals: totals?.p || {}, counts: c }, { 'cache-control': 'public, max-age=15' });
    }

    // Per-polling-unit figures behind the totals, so the headline number can
    // be traced back to the units that produced it.
    if (method === 'GET' && path === '/breakdown') {
      const rows = await query('CNT');
      return json(200, {
        // Upload counts are deliberately NOT here: they are admin-only, served
        // by /admin/upload-counts. Leaking them on the public breakdown would
        // defeat that.
        rows: rows.map((r) => ({
          puCode: r.sk,
          status: r.st || (r.v ? 'added' : 'pending'),
          results: r.res || {},
          // Shown publicly on a revoked unit: withdrawing a result from a public
          // tally should be accountable to everyone, not only to the admin.
          reason: r.rsn || '',
          revokedAt: r.rvk || '',
          revokedFigures: r.revRes || {},
        })),
      }, { 'cache-control': 'public, max-age=15' });
    }

    // Feeds the admin edit table's suggestion list, so the growing set of
    // parties is visible where the corrections are actually typed.
    if (method === 'GET' && path === '/parties') {
      const learned = await knownParties();
      const all = [...new Set([...PARTIES, ...learned])]
        .sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
      return json(200, { parties: all }, { 'cache-control': 'public, max-age=60' });
    }

    if (method === 'GET' && path === '/pu') {
      const code = String(qs.code || '').trim();
      const uploads = (await query(`PU#${code}`))
        .filter((u) => u.sk?.startsWith('UPLOAD#'))
        .map((u) => ({
          uploadId: u.uploadId, ts: u.ts, url: `/${u.key}`,
          extracted: u.extracted, inOsun: u.inOsun, approved: u.approved,
          device: u.deviceId ? createHash('sha256').update(u.deviceId).digest('hex').slice(0, 6) : '?',
        }));
      const cnt = await get('CNT', code);
      return json(200, { uploads, counted: !!cnt?.v });
    }

    /* ---- messages to admin ---- */

    if (method === 'POST' && path === '/messages') {
      const threadId = String(body.threadId || '').match(/^[\w-]{8,40}$/) ? body.threadId : randomUUID();
      const text = String(body.text || '').slice(0, 4000).trim();
      if (!text) return json(400, { error: 'empty message' });
      const ts = new Date().toISOString();
      await put({ pk: `THREAD#${threadId}`, sk: `MSG#${ts}`, from: 'user', text, ts });
      await put({ pk: 'THREADS', sk: threadId, threadId, lastTs: ts, preview: text.slice(0, 120) });
      return json(200, { threadId });
    }

    if (method === 'GET' && path === '/messages') {
      const threadId = String(qs.threadId || '');
      if (!/^[\w-]{8,40}$/.test(threadId)) return json(200, { messages: [] });
      const msgs = (await query(`THREAD#${threadId}`))
        .filter((m) => m.sk?.startsWith('MSG#'))
        .map((m) => ({ from: m.from, text: m.text, ts: m.ts }));
      return json(200, { messages: msgs });
    }

    /* ---- admin ---- */

    if (method === 'POST' && path === '/admin/login') {
      const cfg = await adminConfig();
      const okUser = String(body.username || '') === cfg.username;
      const okPass = createHash('sha256').update(cfg.salt + String(body.password || '')).digest('hex') === cfg.hash;
      if (!okUser || !okPass) return json(401, { error: 'invalid credentials' });
      const exp = Date.now() + 12 * 3600 * 1000;
      return json(200, { token: `${exp}.${tokenFor(cfg, exp)}` });
    }

    if (path.startsWith('/admin/')) {
      if (!(await requireAdmin(event))) {
        console.log(`admin DENIED ${method} ${path} — bad or missing token`);
        return json(401, { error: 'unauthorised' });
      }
      // Admin actions move public numbers. When one appears not to work there
      // has to be a record of what was asked for and what came back.
      console.log(`admin ${method} ${path} ${JSON.stringify(body).slice(0, 400)}`);

      if (method === 'GET' && path === '/admin/threads') {
        const threads = await query('THREADS');
        for (const t of threads) {
          t.messages = (await query(`THREAD#${t.threadId}`))
            .filter((m) => m.sk?.startsWith('MSG#'))
            .map((m) => ({ from: m.from, text: m.text, ts: m.ts }));
        }
        threads.sort((a, b) => String(b.lastTs).localeCompare(String(a.lastTs)));
        return json(200, { threads });
      }

      if (method === 'POST' && path === '/admin/reply') {
        const threadId = String(body.threadId || '');
        const text = String(body.text || '').slice(0, 4000).trim();
        if (!/^[\w-]{8,40}$/.test(threadId) || !text) return json(400, { error: 'bad reply' });
        const ts = new Date().toISOString();
        await put({ pk: `THREAD#${threadId}`, sk: `MSG#${ts}`, from: 'admin', text, ts });
        await put({ pk: 'THREADS', sk: threadId, threadId, lastTs: ts, preview: text.slice(0, 120) });
        return json(200, { ok: true });
      }

      if (method === 'GET' && path === '/admin/recent') {
        const items = await query('UPL', { ScanIndexForward: false, Limit: 100 });
        return json(200, {
          uploads: items.map((u) => ({
            uploadId: u.uploadId, puCode: u.puCode, ts: u.ts, url: `/${u.key}`,
            extracted: u.extracted, inOsun: u.inOsun, counted: u.counted,
          })),
        });
      }

      // Manual override: admin accepts a photo the automatic rule rejected.
      if (method === 'POST' && path === '/admin/approve') {
        const puCode = String(body.puCode || '');
        const uploadId = String(body.uploadId || '');
        const all = (await query(`PU#${puCode}`)).filter((u) => u.sk?.startsWith('UPLOAD#'));
        const uploads = all.filter((u) => u.uploadId === uploadId);
        if (!uploads.length) {
          console.log(`approve: uploadId ${uploadId} not under PU#${puCode}; ` +
                      `have ${all.map((u) => u.uploadId).join(',') || 'none'}`);
          // 422 rather than 404: CloudFront maps 403/404 to the site's error
          // page distribution-wide, which would replace this JSON with HTML.
          return json(422, {
            error: 'That photo is no longer listed for this polling unit. Reload the page and try again.',
          });
        }
        const cnt = await get('CNT', puCode);
        if (cnt?.v) {
          // 409, not 200: reporting success for a no-op is how "it didn't work"
          // becomes impossible to diagnose.
          return json(409, {
            error: 'This polling unit has already been counted. Revoke it first if the figures need changing.',
            totals: (await get('AGG', 'TOTALS'))?.p || {},
          });
        }
        // Approving after a revoke is a deliberate reversal and is allowed.
        const ocr = uploads[0].extracted || {};

        /* Two distinct cases, and conflating them was a real defect: if the
         * caller SENT figures but none survive validation, falling back to the
         * OCR numbers would approve figures the admin never agreed to and
         * report success. An absent `figures` key means "no edit intended". */
        const sentFigures = Object.prototype.hasOwnProperty.call(body, 'figures') &&
                            body.figures !== null;
        const edited = sentFigures ? sanitiseFigures(body.figures) : null;
        if (sentFigures && !edited) {
          console.log(`approve: rejected unusable figures ${JSON.stringify(body.figures)}`);
          return json(400, {
            error: 'None of those figures could be used. Every row needs a party name ' +
                   'and a whole-number score of zero or more.',
          });
        }

        const figures = edited || ocr;
        if (!Object.keys(figures).length) {
          console.log(`approve: nothing to approve; ocr=${JSON.stringify(ocr)}`);
          return json(400, {
            error: 'Nothing was read from this photo, so enter the figures by hand before approving.',
          });
        }
        const reason = String(body.reason || '').slice(0, 500).trim();
        // An admin typing a party the OCR missed is the most reliable signal we
        // get that it exists, so register it for every future photo.
        await registerParties(Object.keys(figures));
        await addTotals(figures);
        await markCounted(puCode, figures);
        const cfg = await adminConfig();
        await audit(cnt?.st === 'revoked' ? 're-approve' : 'approve', puCode, {
          reason, actor: cfg.username, figures,
          edited: !!edited && JSON.stringify(edited) !== JSON.stringify(ocr),
          ocr,
        });
        const after = await get('AGG', 'TOTALS');
        console.log(`approve OK ${puCode} added=${JSON.stringify(figures)} edited=${!!edited}`);
        // Returning the new totals lets the page show the effect without a
        // second read that a browser cache could answer staleley.
        return json(200, { ok: true, added: figures, totals: after?.p || {} });
      }

      if (method === 'POST' && path === '/admin/revoke') {
        const puCode = String(body.puCode || '');
        const reason = String(body.reason || '').slice(0, 500).trim();
        // Required, not optional: a revoke with no stated reason is exactly the
        // thing that cannot be defended later.
        if (reason.length < 3) return json(400, { error: 'a reason is required to revoke a result' });
        const cfg = await adminConfig();
        const r = await revokeCounted(puCode, reason, cfg.username);
        return json(r.ok ? 200 : 409, r);
      }

      // Every polling unit that has had at least one photo, counted or not.
      if (method === 'GET' && path === '/admin/upload-counts') {
        const rows = await query('CNT', { ProjectionExpression: 'sk, n, v, st' });
        return json(200, {
          rows: rows
            .filter((r) => (r.n || 0) > 0)
            .map((r) => ({
              puCode: r.sk,
              uploads: r.n || 0,
              status: r.st || (r.v ? 'added' : 'pending'),
            })),
        });
      }

      if (method === 'GET' && path === '/admin/audit') {
        const entries = await query('AUDIT', { ScanIndexForward: false, Limit: 200 });
        return json(200, {
          entries: entries.map((e) => ({
            ts: e.ts, action: e.action, puCode: e.puCode,
            actor: e.actor, reason: e.reason, figures: e.figures || {},
            edited: !!e.edited, ocr: e.ocr || {},
          })),
        });
      }
    }

    return json(404, { error: 'not found' });
  } catch (e) {
    console.error(e);
    return json(500, { error: 'server error' });
  }
};
