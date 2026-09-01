// Minimal SigV4 request signer over node:https.
//
// The managed Node runtime bundles *some* AWS SDK v3 clients, and which ones
// is not contractual. Signing the four calls this app makes (DynamoDB,
// Textract, SSM, S3 GetObject) by hand keeps the Lambda a dependency-free zip:
// nothing to npm install in CI, and no chance of a missing-module failure that
// only appears after deploy.
import { request } from 'node:https';
import { createHash, createHmac } from 'node:crypto';

const REGION = process.env.AWS_REGION || 'us-east-1';
const sha256hex = (s) => createHash('sha256').update(s).digest('hex');
const hmac = (k, s) => createHmac('sha256', k).update(s).digest();

const creds = () => ({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  sessionToken: process.env.AWS_SESSION_TOKEN,
});

function signedFetch({ service, host, method = 'POST', path = '/', query = null, headers = {}, body = '', raw = false }) {
  const c = creds();
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${REGION}/${service}/aws4_request`;
  const payloadHash = sha256hex(body);

  const h = {
    host,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
    ...headers,
  };
  if (c.sessionToken) h['x-amz-security-token'] = c.sessionToken;

  const signedHeaders = Object.keys(h).map((k) => k.toLowerCase()).sort();
  const canonicalHeaders = signedHeaders.map((k) => {
    const key = Object.keys(h).find((x) => x.toLowerCase() === k);
    return `${k}:${String(h[key]).trim()}\n`;
  }).join('');

  // SigV4 wants the query sorted by encoded key, and S3 rejects a signature
  // computed over a different string than the one actually sent -- so the same
  // value is used for both the signature and the request line.
  const canonicalQuery = query
    ? Object.keys(query).sort()
      .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k])}`)
      .join('&')
    : '';

  const canonicalRequest = [
    method,
    path,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders.join(';'),
    payloadHash,
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256hex(canonicalRequest),
  ].join('\n');

  const kSigning = ['aws4_request'].reduce(
    (k, s) => hmac(k, s),
    hmac(hmac(hmac(`AWS4${c.secretAccessKey}`, dateStamp), REGION), service),
  );
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  h.Authorization =
    `AWS4-HMAC-SHA256 Credential=${c.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders.join(';')}, Signature=${signature}`;

  return new Promise((resolve, reject) => {
    const url = canonicalQuery ? `${path}?${canonicalQuery}` : path;
    const req = request({ host, method, path: url, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (res.statusCode >= 300) {
          return reject(new Error(`${service} ${res.statusCode}: ${buf.toString('utf8').slice(0, 500)}`));
        }
        resolve(raw ? buf : JSON.parse(buf.toString('utf8') || '{}'));
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const target = (service, host, contentType) => (op, payload) =>
  signedFetch({
    service,
    host: `${host}.${REGION}.amazonaws.com`,
    headers: { 'content-type': contentType, 'x-amz-target': op },
    body: JSON.stringify(payload),
  });

export const ddb = target('dynamodb', 'dynamodb', 'application/x-amz-json-1.0');
export const textract = target('textract', 'textract', 'application/x-amz-json-1.1');
export const ssm = target('ssm', 'ssm', 'application/x-amz-json-1.1');

const s3Path = (key) => '/' + key.split('/').map(encodeURIComponent).join('/');

export const s3Get = (bucket, key) =>
  signedFetch({
    service: 's3',
    host: `${bucket}.s3.${REGION}.amazonaws.com`,
    method: 'GET',
    path: s3Path(key),
    raw: true,
  });

/* Listing and deleting exist for exactly one purpose: wiping test-mode photos
 * when test mode is switched off.
 *
 * S3's REST list returns XML, not JSON. Pulling in a parser would break the
 * zero-dependency rule the whole Lambda is built on, so the keys are read out
 * with a regex -- adequate for a response whose shape is fixed by the API, and
 * not something to reuse for arbitrary XML. */
export async function s3List(bucket, prefix) {
  const keys = [];
  let token = null;
  do {
    const q = { 'list-type': '2', prefix, 'max-keys': '1000' };
    if (token) q['continuation-token'] = token;
    const xml = (await signedFetch({
      service: 's3',
      host: `${bucket}.s3.${REGION}.amazonaws.com`,
      method: 'GET',
      path: '/',
      query: q,
      raw: true,
    })).toString('utf8');

    for (const m of xml.matchAll(/<Key>([^<]*)<\/Key>/g)) keys.push(m[1].replace(/&amp;/g, '&'));

    const more = /<IsTruncated>true<\/IsTruncated>/.test(xml);
    const next = xml.match(/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/);
    token = more && next ? next[1] : null;
  } while (token);
  return keys;
}

export const s3Delete = (bucket, key) =>
  signedFetch({
    service: 's3',
    host: `${bucket}.s3.${REGION}.amazonaws.com`,
    method: 'DELETE',
    path: s3Path(key),
    raw: true,
  });

/* --- DynamoDB attribute-value marshalling (only the types this app uses) --- */
export function av(v) {
  if (v === null || v === undefined) return { NULL: true };
  if (typeof v === 'string') return { S: v };
  if (typeof v === 'number') return { N: String(v) };
  if (typeof v === 'boolean') return { BOOL: v };
  if (Array.isArray(v)) return { L: v.map(av) };
  return { M: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, av(x)])) };
}

export function unav(a) {
  if (!a) return undefined;
  if ('S' in a) return a.S;
  if ('N' in a) return Number(a.N);
  if ('BOOL' in a) return a.BOOL;
  if ('NULL' in a) return null;
  if ('L' in a) return a.L.map(unav);
  if ('M' in a) return Object.fromEntries(Object.entries(a.M).map(([k, x]) => [k, unav(x)]));
  return undefined;
}

export const item = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, av(v)]));
export const plain = (o) => (o ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, unav(v)])) : null);
