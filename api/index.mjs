import { createHmac, randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { ddb, textract, ssm, s3Get, s3List, s3Delete, item, plain, av } from './aws.mjs';
import {
  presignPut, readGps, inOsun, parseResults, signature, json, PARTIES,
  ELECTIONS, CURRENT_ELECTION, REAL_ELECTIONS, TEST_ELECTION, electionOf, keysFor,
} from './util.mjs';

const TABLE = process.env.TABLE;
const BUCKET = process.env.PHOTO_BUCKET;
const REGION = process.env.AWS_REGION || 'us-east-1';

const UPLOAD_ACK =
  'Once two photos from two different phones have been uploaded, and they’re ' +
  'the same, the result will be automatically added to the totals above';
const NO_LOCATION_ACK =
  'Thank you, but ensure location services are “turned on” in your phone ' +
  'settings to allow automatic addition to the totals';
const UPLOADS_OFF =
  'Uploads are currently closed. They are opened by the administrator while ' +
  'an election is being monitored.';

/* 409, not the obvious 403.
 *
 * CloudFront's custom_error_response is distribution-wide and maps 403 to the
 * site's HTML error page -- the same trap already documented for 404 in
 * infra/main.tf. A 403 here reached the browser as "Not Found" markup instead
 * of this JSON, so the visitor was told the page did not exist rather than
 * that uploads were closed. Any status the distribution rewrites is unusable
 * for an API error. */
const UPLOADS_OFF_STATUS = 409;

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

/* ------------------------------ site config ------------------------------ */

/* Uploads are closed between elections: the portal stays up and viewable, but
 * nothing new can be sent in. Absent config means CLOSED -- an election portal
 * that accepts photos because a settings row has not been written yet is the
 * wrong failure direction. */
let configCache = { at: 0, val: null };

async function siteConfig() {
  if (configCache.val && Date.now() - configCache.at < 15_000) return configCache.val;
  const rec = await get('AGG', 'CONFIG');
  const val = {
    uploadsEnabled: !!rec?.uploadsEnabled,
    testMode: !!rec?.testMode,
    election: rec?.election || CURRENT_ELECTION,
  };
  configCache = { at: Date.now(), val };
  return val;
}

// One writer for the config item, so a change to either switch cannot drop the
// other by writing a partial item.
async function patchConfig(patch) {
  const cur = await siteConfig();
  const next = { ...cur, ...patch };
  await put({
    pk: 'AGG', sk: 'CONFIG',
    uploadsEnabled: !!next.uploadsEnabled,
    testMode: !!next.testMode,
    election: next.election || CURRENT_ELECTION,
    updatedAt: new Date().toISOString(),
  });
  configCache = { at: 0, val: null };
  return next;
}

/* While test mode is on, the live election IS the test election. Every upload
 * and every approval is routed here, so nothing a tester does can be written
 * under a real election's keys even by mistake. */
const liveElection = (cfg) => (cfg.testMode ? TEST_ELECTION : CURRENT_ELECTION);

/* ----------------------------- test-mode wipe ---------------------------- */

/* Switching test mode off erases everything done while it was on.
 *
 * The safety here is structural rather than careful: every key deleted is
 * built from keysFor('test'), whose partitions all carry '#TEST' and whose
 * photos all sit under 'photos/test/'. Osun's keys are unprefixed and the
 * presidential ones carry '#PRESIDENTIAL', so no real key can be produced by
 * this function at all. The assertion below states that as an invariant rather
 * than leaving it to be re-derived by the next reader -- if a refactor ever
 * makes the test namespace collide with a real one, this throws instead of
 * deleting an election.
 */
function assertTestNamespace(K) {
  const safe = K.id === TEST_ELECTION &&
    K.ephemeral === true &&
    K.cnt.includes('#TEST') &&
    K.upl.includes('#TEST') &&
    K.audit.includes('#TEST') &&
    K.totals.includes('#TEST') &&
    K.parties.includes('#TEST') &&
    K.photoPrefix === 'photos/test' &&
    K.pu('X').startsWith('PU#TEST#');
  if (!safe) {
    throw new Error(`refusing to wipe: ${K.id} is not the isolated test namespace`);
  }
}

// DynamoDB has no "delete this partition", so items are collected and removed
// in batches of 25, which is the BatchWriteItem limit.
async function deleteKeys(keys) {
  for (let i = 0; i < keys.length; i += 25) {
    const batch = keys.slice(i, i + 25);
    await ddb('DynamoDB_20120810.BatchWriteItem', {
      RequestItems: {
        [TABLE]: batch.map((k) => ({ DeleteRequest: { Key: item({ pk: k.pk, sk: k.sk }) } })),
      },
    });
  }
  return keys.length;
}

async function wipeTestData() {
  const K = keysFor(TEST_ELECTION);
  assertTestNamespace(K);

  const keys = [];

  // The per-polling-unit upload partitions are the only ones whose names are
  // not known up front, so the codes are gathered from both places an upload
  // records one. Using both means a partially written upload still gets swept.
  const codes = new Set();

  for (const pk of [K.cnt, K.upl, K.audit]) {
    for (const row of await query(pk)) {
      keys.push({ pk, sk: row.sk });
      if (pk === K.cnt) codes.add(row.sk);
      if (row.puCode) codes.add(row.puCode);
    }
  }

  for (const code of codes) {
    const pk = K.pu(code);
    for (const row of await query(pk)) keys.push({ pk, sk: row.sk });
  }

  keys.push({ pk: 'AGG', sk: K.totals });
  keys.push({ pk: 'AGG', sk: K.parties });

  // Belt and braces: nothing without a test marker leaves this function.
  const unsafe = keys.filter((k) => !k.pk.includes('TEST') && !k.sk.includes('TEST'));
  if (unsafe.length) {
    throw new Error(`refusing to wipe non-test keys: ${JSON.stringify(unsafe.slice(0, 3))}`);
  }

  const items = await deleteKeys(keys);

  // Test photos live under their own prefix, so the same reasoning applies.
  let photos = 0;
  const objects = await s3List(BUCKET, `${K.photoPrefix}/`);
  for (const key of objects) {
    if (!key.startsWith(`${K.photoPrefix}/`)) continue;   // never delete outside the prefix
    await s3Delete(BUCKET, key);
    photos++;
  }

  partyCache[K.id] = null;
  console.log(`test wipe: removed ${items} items and ${photos} photos`);
  return { items, photos, pollingUnits: codes.size };
}

async function bumpCount(K, puCode) {
  await ddb('DynamoDB_20120810.UpdateItem', {
    TableName: TABLE,
    Key: item({ pk: K.cnt, sk: puCode }),
    UpdateExpression: 'SET n = if_not_exists(n, :z) + :one',
    ExpressionAttributeValues: item({ ':z': 0, ':one': 1 }),
  });
}

// The figures actually applied are snapshotted onto the counter item, so a
// later revoke subtracts exactly what was added rather than re-deriving it
// from the photos (which an admin may since have approved differently).
async function markCounted(K, puCode, results) {
  await ddb('DynamoDB_20120810.UpdateItem', {
    TableName: TABLE,
    Key: item({ pk: K.cnt, sk: puCode }),
    UpdateExpression: 'SET v = :one, n = if_not_exists(n, :z), st = :added, res = :r',
    ExpressionAttributeValues: item({ ':one': 1, ':z': 0, ':added': 'added', ':r': results || {} }),
  });
}

// Append-only: every entry is a fresh item under one partition, and nothing in
// the code updates or deletes them. Changing a total on an election portal is
// a contestable act, so the record of who did it and why has to outlive the
// state it changed.
async function audit(K, action, puCode, detail) {
  const ts = new Date().toISOString();
  await put({
    pk: K.audit,
    sk: `${ts}#${randomUUID()}`,
    ts, action, puCode,
    election: K.id,
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
async function revokeCounted(K, puCode, reason, actor) {
  const cnt = await get(K.cnt, puCode);
  if (!cnt || !cnt.v) return { ok: false, reason: 'not currently added' };

  const applied = cnt.res || {};
  const negated = Object.fromEntries(Object.entries(applied).map(([k, v]) => [k, -v]));
  await addTotals(K, negated);

  await ddb('DynamoDB_20120810.UpdateItem', {
    TableName: TABLE,
    Key: item({ pk: K.cnt, sk: puCode }),
    // revRes keeps what was withdrawn, so the breakdown can still show the
    // figures a revoked unit used to contribute.
    UpdateExpression: 'SET v = :zero, st = :revoked, rsn = :why, rvk = :ts, revRes = :applied REMOVE res',
    ExpressionAttributeValues: item({
      ':zero': 0, ':revoked': 'revoked', ':why': reason,
      ':ts': new Date().toISOString(), ':applied': applied,
    }),
  });

  await audit(K, 'revoke', puCode, { reason, actor, figures: applied });
  return { ok: true, removed: applied, reason };
}

// Totals live in one item as a party -> votes map, updated with an additive
// SET so concurrent uploads for different polling units cannot clobber it.
async function addTotals(K, results) {
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
    Key: item({ pk: 'AGG', sk: K.totals }),
    UpdateExpression: 'SET ' + sets.join(', '),
    ExpressionAttributeNames: ean,
    ExpressionAttributeValues: eav,
  };
  try {
    await ddb('DynamoDB_20120810.UpdateItem', args);
  } catch (e) {
    // First write: the p map does not exist yet, so create it and retry.
    if (!/ValidationException/.test(String(e))) throw e;
    await put({ pk: 'AGG', sk: K.totals, p: {} });
    await ddb('DynamoDB_20120810.UpdateItem', args);
  }
}

/* ----------------------------- party registry ---------------------------- */

/* The seed list in util.mjs cannot know every party on a real ballot, so the
 * set grows: parties read off a sheet, and parties an admin types into the
 * edit table, are both remembered. Once registered, a party is recognised on
 * every later photo even when it appears alongside unfamiliar text.
 *
 * Kept per election: a party learned off an Osun sheet should not seed the
 * presidential registry, since the ballots are not the same. */
const partyCache = {};

async function knownParties(K) {
  // Cached per container for a minute; a missed party is picked up on the next
  // upload rather than costing a read on every request.
  const c = partyCache[K.id];
  if (c?.set && Date.now() - c.at < 60_000) return c.set;
  const rec = await get('AGG', K.parties);
  const set = new Set(Object.keys(rec?.p || {}));
  partyCache[K.id] = { at: Date.now(), set };
  return set;
}

async function registerParties(K, codes) {
  const fresh = [...new Set(codes)]
    .map((c) => String(c).toUpperCase().replace(/[^A-Z0-9]/g, ''))
    .filter((c) => c && c.length <= 12 && !PARTIES.includes(c));
  if (!fresh.length) return [];

  const known = await knownParties(K);
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
    Key: item({ pk: 'AGG', sk: K.parties }),
    UpdateExpression: 'SET ' + sets.join(', '),
    ExpressionAttributeNames: ean,
    ExpressionAttributeValues: eav,
  };
  try {
    await ddb('DynamoDB_20120810.UpdateItem', args);
  } catch (e) {
    // First write: the p map does not exist yet.
    if (!/ValidationException/.test(String(e))) throw e;
    await put({ pk: 'AGG', sk: K.parties, p: {} });
    await ddb('DynamoDB_20120810.UpdateItem', args);
  }
  partyCache[K.id] = null;   // force a reload so the next parse sees them
  return add;
}

/* ------------------------------ upload flow ------------------------------ */

async function processUpload(K, { puCode, key, deviceId }) {
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
    extracted = parseResults(blocks, { known: await knownParties(K), discovered });
    if (discovered.size) {
      const added = await registerParties(K, [...discovered]);
      if (added.length) console.log('new parties learned from upload:', added.join(', '));
    }
  } catch (e) {
    console.error('textract failed', String(e));
  }

  const uploadId = randomUUID();
  const ts = new Date().toISOString();
  const sig = signature(extracted);

  const record = {
    pk: K.pu(puCode),
    sk: `UPLOAD#${ts}#${uploadId}`,
    uploadId, puCode, key, ts, deviceId,
    election: K.id,
    gps: gps ? { lat: gps.lat, lon: gps.lon } : null,
    inOsun: located,
    extracted, sig,
    lines: lines.slice(0, 60),
    approved: false,
    counted: false,
  };
  await put(record);
  // Mirror into a recent-uploads feed the admin screen can read cheaply.
  await put({ ...record, pk: K.upl, sk: `${ts}#${uploadId}` });
  await bumpCount(K, puCode);

  const verdict = await tryVerify(K, puCode);
  return { uploadId, extracted, inOsun: located, hasGps: !!gps, verified: verdict, ts };
}

// Eligible when two photos agree, both carry Osun coordinates, and they came
// from different devices. Runs after every upload; the CNT.v flag makes it
// idempotent so a third matching photo cannot double-count.
async function tryVerify(K, puCode) {
  const cnt = await get(K.cnt, puCode);
  if (cnt?.v) return true;
  // A revoked result stays revoked: the admin made a judgement, and a further
  // matching photo must not silently undo it. Re-approval is explicit.
  if (cnt?.st === 'revoked') return false;

  const uploads = (await query(K.pu(puCode))).filter((u) => u.sk?.startsWith('UPLOAD#'));
  const eligible = uploads.filter((u) => u.inOsun && u.sig && Object.keys(u.extracted || {}).length);

  for (let i = 0; i < eligible.length; i++) {
    for (let j = i + 1; j < eligible.length; j++) {
      if (eligible[i].sig !== eligible[j].sig) continue;
      if (eligible[i].deviceId === eligible[j].deviceId) continue;
      await addTotals(K, eligible[i].extracted);
      await markCounted(K, puCode, eligible[i].extracted);
      return true;
    }
  }
  return false;
}

/* Reads one election's public state. Used for both elections on every front
 * page load, so it stays two cheap single-partition reads. */
async function electionSummary(K) {
  const [totals, counts] = await Promise.all([
    get('AGG', K.totals),
    query(K.cnt, { ProjectionExpression: 'sk, n, v, st' }),
  ]);
  const c = {};
  // Third element is the status; older clients read only the first two.
  for (const r of counts) c[r.sk] = [r.n || 0, r.v ? 1 : 0, r.st || ''];
  return {
    id: K.id,
    label: K.label,
    archived: K.archived,
    display: K.display,
    totals: totals?.p || {},
    counts: c,
  };
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
    /* Every data route is scoped to an election. A read may name one; anything
     * unnamed follows whichever election is currently live -- which is the TEST
     * election while test mode is on. That default is what keeps an admin
     * approving in test mode from writing into the real presidential totals
     * without having to remember to pass a parameter. */
    const CFG = await siteConfig();
    const K = keysFor(electionOf(qs.election ?? body.election, liveElection(CFG)));

    // Site-wide admin actions are recorded against the real election, not the
    // ephemeral test one, so the record of them survives a test wipe.
    const LIVE = keysFor(CURRENT_ELECTION);

    /* ---- public ---- */

    if (method === 'POST' && path === '/upload-url') {
      const cfg = CFG;
      // Test mode exists to exercise the upload path while no election is
      // running, so it opens uploads on its own -- into the test namespace.
      if (!cfg.uploadsEnabled && !cfg.testMode) return json(UPLOADS_OFF_STATUS, { error: UPLOADS_OFF });
      const W = keysFor(liveElection(cfg));
      const puCode = String(body.puCode || '').trim();
      if (!/^[0-9-]{6,20}$/.test(puCode)) return json(400, { error: 'bad polling unit' });
      const key = `${W.photoPrefix}/${puCode}/${randomUUID()}.jpg`;
      const url = presignPut({
        bucket: BUCKET, key, region: REGION,
        creds: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
          sessionToken: process.env.AWS_SESSION_TOKEN,
        },
      });
      return json(200, { url, key, election: W.id });
    }

    if (method === 'POST' && path === '/upload-done') {
      const cfg = CFG;
      if (!cfg.uploadsEnabled && !cfg.testMode) return json(UPLOADS_OFF_STATUS, { error: UPLOADS_OFF });
      const W = keysFor(liveElection(cfg));
      const puCode = String(body.puCode || '').trim();
      const key = String(body.key || '');
      const deviceId = String(body.deviceId || '').slice(0, 64);
      // The prefix check is what stops a client naming a key in another
      // election's namespace and having its photo counted there.
      if (!key.startsWith(`${W.photoPrefix}/${puCode}/`)) return json(400, { error: 'bad key' });
      const r = await processUpload(W, { puCode, key, deviceId });
      return json(200, {
        ...r,
        election: W.id,
        message: r.hasGps && r.inOsun ? UPLOAD_ACK : NO_LOCATION_ACK,
      });
    }

    /* One request carries every election the front page shows. Splitting it
     * per election would double the Lambda invocations on the request every
     * visitor makes, which is exactly the cost this portal is built to avoid.
     * The flat `totals`/`counts` keys mirror the live election so an older
     * cached copy of app.js keeps working. */
    if (method === 'GET' && path === '/summary') {
      const cfg = CFG;
      // The test election is only ever shown while test mode is on, so an
      // ordinary visitor never sees a row that is about to be deleted.
      const ids = cfg.testMode ? [...REAL_ELECTIONS, TEST_ELECTION] : REAL_ELECTIONS;
      const list = await Promise.all(ids.map((id) => electionSummary(keysFor(id))));
      const elections = Object.fromEntries(list.map((e) => [e.id, e]));
      const current = liveElection(cfg);
      const live = elections[current];
      return json(200, {
        elections,
        current,
        uploadsEnabled: cfg.uploadsEnabled,
        testMode: cfg.testMode,
        totals: live.totals,
        counts: live.counts,
      }, {
        // While test mode is on the figures change as fast as an admin clicks,
        // and a stale row reads as "approving did nothing". Not cached.
        'cache-control': cfg.testMode ? 'no-store' : 'public, max-age=15',
      });
    }

    // Per-polling-unit figures behind the totals, so the headline number can
    // be traced back to the units that produced it.
    if (method === 'GET' && path === '/breakdown') {
      const rows = await query(K.cnt);
      return json(200, {
        election: K.id,
        label: K.label,
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
      const learned = await knownParties(K);
      const all = [...new Set([...PARTIES, ...learned])]
        .sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
      return json(200, { parties: all }, { 'cache-control': 'public, max-age=60' });
    }

    if (method === 'GET' && path === '/pu') {
      const code = String(qs.code || '').trim();
      const uploads = (await query(K.pu(code)))
        .filter((u) => u.sk?.startsWith('UPLOAD#'))
        .map((u) => ({
          uploadId: u.uploadId, ts: u.ts, url: K.photoUrl(u.key),
          extracted: u.extracted, inOsun: u.inOsun, approved: u.approved,
          device: u.deviceId ? createHash('sha256').update(u.deviceId).digest('hex').slice(0, 6) : '?',
        }));
      const cnt = await get(K.cnt, code);
      return json(200, { election: K.id, archived: K.archived, uploads, counted: !!cnt?.v });
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

      /* Opening and closing uploads. Recorded in the audit trail like any
       * other admin act: "why was nothing collected that day" needs the same
       * accountability as "why did that total change". */
      if (path === '/admin/uploads-enabled') {
        if (method === 'GET') {
          const c = await siteConfig();
          return json(200, { uploadsEnabled: c.uploadsEnabled, testMode: c.testMode });
        }
        if (method === 'POST') {
          const enabled = !!body.enabled;
          await patchConfig({ uploadsEnabled: enabled });
          const cfg = await adminConfig();
          await audit(LIVE, enabled ? 'uploads-enabled' : 'uploads-disabled', '', {
            actor: cfg.username,
            reason: String(body.reason || '').slice(0, 500).trim(),
          });
          console.log(`uploads ${enabled ? 'ENABLED' : 'DISABLED'} by ${cfg.username}`);
          return json(200, { ok: true, uploadsEnabled: enabled });
        }
      }

      /* Test mode. Switching it OFF is the destructive half: everything done
       * while it was on is deleted. The wipe runs before the flag is cleared,
       * so a failure leaves test mode on with its data intact rather than
       * stranding orphaned test rows under a flag that says they are gone. */
      if (path === '/admin/test-mode') {
        if (method === 'GET') {
          const c = await siteConfig();
          const T = await electionSummary(keysFor(TEST_ELECTION));
          return json(200, { testMode: c.testMode, totals: T.totals, units: Object.keys(T.counts).length });
        }
        if (method === 'POST') {
          const enabled = !!body.enabled;
          const cfg = await adminConfig();
          const before = await siteConfig();

          if (!enabled) {
            const removed = await wipeTestData();
            await patchConfig({ testMode: false });
            await audit(LIVE, 'test-mode-off', '', {
              actor: cfg.username,
              reason: `wiped ${removed.items} items, ${removed.photos} photos, ` +
                      `${removed.pollingUnits} polling units`,
            });
            console.log(`test mode OFF by ${cfg.username}; ${JSON.stringify(removed)}`);
            return json(200, { ok: true, testMode: false, removed });
          }

          await patchConfig({ testMode: true });
          if (!before.testMode) {
            await audit(LIVE, 'test-mode-on', '', { actor: cfg.username });
          }
          console.log(`test mode ON by ${cfg.username}`);
          return json(200, { ok: true, testMode: true });
        }
      }

      /* "Approve upload": every upload not yet counted, newest first, with the
       * figures OCR read so the admin can see what they are approving without
       * opening each polling unit separately. */
      if (method === 'GET' && path === '/admin/pending') {
        const items = await query(K.upl, { ScanIndexForward: false, Limit: 200 });
        const seen = new Set();
        const rows = [];
        for (const u of items) {
          if (!u.uploadId || seen.has(u.uploadId)) continue;
          seen.add(u.uploadId);
          const cnt = await get(K.cnt, u.puCode);
          rows.push({
            uploadId: u.uploadId, puCode: u.puCode, ts: u.ts,
            url: K.photoUrl(u.key),
            extracted: u.extracted || {},
            inOsun: !!u.inOsun,
            status: cnt?.v ? 'added' : (cnt?.st || 'pending'),
          });
        }
        return json(200, {
          election: K.id,
          archived: K.archived,
          rows,
          totals: (await get('AGG', K.totals))?.p || {},
        });
      }

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
        const items = await query(K.upl, { ScanIndexForward: false, Limit: 100 });
        return json(200, {
          election: K.id,
          uploads: items.map((u) => ({
            uploadId: u.uploadId, puCode: u.puCode, ts: u.ts, url: K.photoUrl(u.key),
            extracted: u.extracted, inOsun: u.inOsun, counted: u.counted,
          })),
        });
      }

      // Manual override: admin accepts a photo the automatic rule rejected.
      if (method === 'POST' && path === '/admin/approve') {
        // An archived election is settled. Approving into it would change a
        // published historical total, so it is refused outright.
        if (K.archived) {
          return json(409, { error: `The ${K.label} are archived and can no longer be changed.` });
        }
        const puCode = String(body.puCode || '');
        const uploadId = String(body.uploadId || '');
        const all = (await query(K.pu(puCode))).filter((u) => u.sk?.startsWith('UPLOAD#'));
        const uploads = all.filter((u) => u.uploadId === uploadId);
        if (!uploads.length) {
          console.log(`approve: uploadId ${uploadId} not under ${K.pu(puCode)}; ` +
                      `have ${all.map((u) => u.uploadId).join(',') || 'none'}`);
          // 422 rather than 404: CloudFront maps 403/404 to the site's error
          // page distribution-wide, which would replace this JSON with HTML.
          return json(422, {
            error: 'That photo is no longer listed for this polling unit. Reload the page and try again.',
          });
        }
        const cnt = await get(K.cnt, puCode);
        if (cnt?.v) {
          // 409, not 200: reporting success for a no-op is how "it didn't work"
          // becomes impossible to diagnose.
          return json(409, {
            error: 'This polling unit has already been counted. Revoke it first if the figures need changing.',
            totals: (await get('AGG', K.totals))?.p || {},
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
        await registerParties(K, Object.keys(figures));
        await addTotals(K, figures);
        await markCounted(K, puCode, figures);
        const cfg = await adminConfig();
        await audit(K, cnt?.st === 'revoked' ? 're-approve' : 'approve', puCode, {
          reason, actor: cfg.username, figures,
          edited: !!edited && JSON.stringify(edited) !== JSON.stringify(ocr),
          ocr,
        });
        const after = await get('AGG', K.totals);
        console.log(`approve OK ${K.id}/${puCode} added=${JSON.stringify(figures)} edited=${!!edited}`);
        // Returning the new totals lets the page show the effect without a
        // second read that a browser cache could answer staleley.
        return json(200, { ok: true, added: figures, totals: after?.p || {} });
      }

      if (method === 'POST' && path === '/admin/revoke') {
        if (K.archived) {
          return json(409, { error: `The ${K.label} are archived and can no longer be changed.` });
        }
        const puCode = String(body.puCode || '');
        const reason = String(body.reason || '').slice(0, 500).trim();
        // Required, not optional: a revoke with no stated reason is exactly the
        // thing that cannot be defended later.
        if (reason.length < 3) return json(400, { error: 'a reason is required to revoke a result' });
        const cfg = await adminConfig();
        const r = await revokeCounted(K, puCode, reason, cfg.username);
        return json(r.ok ? 200 : 409, r);
      }

      // Every polling unit that has had at least one photo, counted or not.
      if (method === 'GET' && path === '/admin/upload-counts') {
        const rows = await query(K.cnt, { ProjectionExpression: 'sk, n, v, st' });
        return json(200, {
          election: K.id,
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
        const entries = await query(K.audit, { ScanIndexForward: false, Limit: 200 });
        return json(200, {
          election: K.id,
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
