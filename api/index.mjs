import { createHmac, randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { ddb, textract, ssm, s3Get, item, plain, av } from './aws.mjs';
import { presignPut, readGps, inOsun, parseResults, signature, json } from './util.mjs';

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

async function markCounted(puCode) {
  await ddb('DynamoDB_20120810.UpdateItem', {
    TableName: TABLE,
    Key: item({ pk: 'CNT', sk: puCode }),
    UpdateExpression: 'SET v = :one, n = if_not_exists(n, :z)',
    ExpressionAttributeValues: item({ ':one': 1, ':z': 0 }),
  });
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
    lines = (r.Blocks || []).filter((b) => b.BlockType === 'LINE').map((b) => b.Text);
    extracted = parseResults(lines);
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

  const uploads = (await query(`PU#${puCode}`)).filter((u) => u.sk?.startsWith('UPLOAD#'));
  const eligible = uploads.filter((u) => u.inOsun && u.sig && Object.keys(u.extracted || {}).length);

  for (let i = 0; i < eligible.length; i++) {
    for (let j = i + 1; j < eligible.length; j++) {
      if (eligible[i].sig !== eligible[j].sig) continue;
      if (eligible[i].deviceId === eligible[j].deviceId) continue;
      await addTotals(eligible[i].extracted);
      await markCounted(puCode);
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
        query('CNT', { ProjectionExpression: 'sk, n, v' }),
      ]);
      const c = {};
      for (const r of counts) c[r.sk] = [r.n || 0, r.v ? 1 : 0];
      return json(200, { totals: totals?.p || {}, counts: c }, { 'cache-control': 'public, max-age=15' });
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
      if (!(await requireAdmin(event))) return json(401, { error: 'unauthorised' });

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
        const uploads = (await query(`PU#${puCode}`)).filter((u) => u.uploadId === uploadId);
        if (!uploads.length) return json(404, { error: 'upload not found' });
        const cnt = await get('CNT', puCode);
        if (cnt?.v) return json(200, { ok: true, note: 'already counted' });
        await addTotals(uploads[0].extracted || {});
        await markCounted(puCode);
        return json(200, { ok: true });
      }
    }

    return json(404, { error: 'not found' });
  } catch (e) {
    console.error(e);
    return json(500, { error: 'server error' });
  }
};
