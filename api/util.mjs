// Helpers with no dependencies beyond the Node runtime, so the Lambda can be
// deployed as a plain zip with no npm install in CI.
import { createHash, createHmac, randomUUID } from 'node:crypto';

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');
export const hmac = (key, s) => createHmac('sha256', key).update(s).digest();
export { randomUUID };

/* ---------------------------------------------------------------------------
 * SigV4 presigned S3 PUT.
 *
 * Written out longhand rather than importing @aws-sdk/s3-request-presigner:
 * the managed Node runtime bundles the SDK clients but the presigner is not
 * guaranteed, and a missing module would only surface at runtime in CI.
 * ------------------------------------------------------------------------- */
export function presignPut({ bucket, key, region, expires = 900, creds }) {
  const host = `${bucket}.s3.${region}.amazonaws.com`;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${region}/s3/aws4_request`;

  const q = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${creds.accessKeyId}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expires),
    'X-Amz-SignedHeaders': 'host',
  };
  if (creds.sessionToken) q['X-Amz-Security-Token'] = creds.sessionToken;

  const canonicalQuery = Object.keys(q)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(q[k])}`)
    .join('&');

  // Each path segment is encoded, but the separators must stay literal.
  const canonicalUri = '/' + key.split('/').map(encodeURIComponent).join('/');

  const canonicalRequest = [
    'PUT',
    canonicalUri,
    canonicalQuery,
    `host:${host}\n`,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256(canonicalRequest),
  ].join('\n');

  const kDate = hmac(`AWS4${creds.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, 's3');
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  return `https://${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

/* ---------------------------------------------------------------------------
 * EXIF GPS extraction from a JPEG buffer.
 *
 * Read server-side rather than trusting a client-supplied coordinate: the
 * whole eligibility rule rests on the photo having really been taken in Osun,
 * so a value the browser could fabricate is worthless for that purpose.
 * ------------------------------------------------------------------------- */
export function readGps(buf) {
  try {
    if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null; // not JPEG

    // Walk the JPEG marker segments looking for APP1/Exif.
    let off = 2;
    let exif = null;
    while (off + 4 <= buf.length) {
      if (buf[off] !== 0xff) break;
      const marker = buf[off + 1];
      if (marker === 0xda) break; // start of scan; no metadata past here
      const size = buf.readUInt16BE(off + 2);
      if (marker === 0xe1 && buf.toString('ascii', off + 4, off + 8) === 'Exif') {
        exif = off + 10;
        break;
      }
      off += 2 + size;
    }
    if (exif === null) return null;

    const le = buf.toString('ascii', exif, exif + 2) === 'II';
    const u16 = (p) => (le ? buf.readUInt16LE(p) : buf.readUInt16BE(p));
    const u32 = (p) => (le ? buf.readUInt32LE(p) : buf.readUInt32BE(p));

    // IFD0, then follow the GPS sub-IFD pointer (tag 0x8825).
    const ifd0 = exif + u32(exif + 4);
    let gpsPtr = 0;
    const n0 = u16(ifd0);
    for (let i = 0; i < n0; i++) {
      const e = ifd0 + 2 + i * 12;
      if (u16(e) === 0x8825) gpsPtr = exif + u32(e + 8);
    }
    if (!gpsPtr) return null;

    // GPS coordinates are three RATIONALs: degrees, minutes, seconds.
    const rational3 = (p) => {
      const v = [];
      for (let i = 0; i < 3; i++) {
        const num = u32(p + i * 8);
        const den = u32(p + i * 8 + 4);
        v.push(den ? num / den : 0);
      }
      return v[0] + v[1] / 60 + v[2] / 3600;
    };

    let lat = null, lon = null, latRef = 'N', lonRef = 'E';
    const nG = u16(gpsPtr);
    for (let i = 0; i < nG; i++) {
      const e = gpsPtr + 2 + i * 12;
      const tag = u16(e);
      const valOff = exif + u32(e + 8);
      if (tag === 1) latRef = String.fromCharCode(buf[e + 8]);
      else if (tag === 3) lonRef = String.fromCharCode(buf[e + 8]);
      else if (tag === 2) lat = rational3(valOff);
      else if (tag === 4) lon = rational3(valOff);
    }
    if (lat === null || lon === null) return null;
    if (latRef === 'S') lat = -lat;
    if (lonRef === 'W') lon = -lon;
    return { lat, lon };
  } catch {
    return null; // a malformed photo is "no location", never a 500
  }
}

// Osun State bounding box, deliberately a little generous so a GPS fix that
// is merely imprecise at the state border still counts.
export const OSUN = { minLat: 6.9, maxLat: 8.2, minLon: 3.95, maxLon: 5.2 };

export const inOsun = (gps) =>
  !!gps &&
  gps.lat >= OSUN.minLat && gps.lat <= OSUN.maxLat &&
  gps.lon >= OSUN.minLon && gps.lon <= OSUN.maxLon;

/* ---------------------------------------------------------------------------
 * Turn Textract lines into { PARTY: votes }.
 * ------------------------------------------------------------------------- */
export const PARTIES = [
  'A', 'AA', 'AAC', 'ADC', 'ADP', 'APC', 'APGA', 'APM', 'APP', 'BP', 'LP',
  'NNPP', 'NRM', 'PDP', 'PRP', 'SDP', 'YPP', 'ZLP', 'NCP', 'ANDP', 'YP', 'ACD',
];

// OCR routinely reads O for 0, I/l for 1, S for 5 in the digit column.
const digits = (s) =>
  s.replace(/[OoQD]/g, '0').replace(/[IlL|]/g, '1').replace(/[Ss]/g, '5').replace(/[^\d]/g, '');

// Accepts either Textract LINE blocks ({ text, box }) or bare strings.
//
// A result sheet is a table, and Textract emits each cell as its OWN line --
// "APC" and "212" arrive as separate blocks, not as one "APC 212" line. So the
// party and its score are matched by position: same row, score to the right.
// Bare strings fall back to reading order, which is the sequence Textract
// returns cells in anyway.
export function parseResults(input) {
  const items = (input || []).map((b) => {
    const text = typeof b === 'string' ? b : (b.text ?? b.Text ?? '');
    const box = typeof b === 'string' ? null : (b.box ?? b.Box ?? null);
    const clean = String(text).toUpperCase().replace(/[^A-Z0-9\s.|-]/g, ' ').trim();
    return { clean, box, tokens: clean.split(/\s+/).filter(Boolean) };
  }).filter((i) => i.clean);

  const partyOf = (it) => {
    const t = it.tokens.find((x) => PARTIES.includes(x.replace(/[^A-Z]/g, '')));
    return t ? t.replace(/[^A-Z]/g, '') : null;
  };

  // A cell counts as a score only if it is *nothing but* a number, so
  // "TOTAL VALID VOTES" can never be mistaken for one.
  const scoreOf = (it) => {
    if (it.tokens.length !== 1) return null;
    const d = digits(it.tokens[0]);
    if (!d || d.length > 6) return null;
    const n = parseInt(d, 10);
    return Number.isNaN(n) ? null : n;
  };

  const out = {};
  const used = new Set();
  const record = (code, votes) => { out[code] = Math.max(out[code] ?? 0, votes); };

  // Pass 1 -- party and score already on the same line.
  items.forEach((it, i) => {
    const code = partyOf(it);
    if (!code || it.tokens.length < 2) return;
    for (let k = it.tokens.length - 1; k >= 0; k--) {
      if (it.tokens[k].replace(/[^A-Z]/g, '') === code) break;
      const d = digits(it.tokens[k]);
      if (d && d.length <= 6) { record(code, parseInt(d, 10)); used.add(i); return; }
    }
  });

  // Pass 2 -- separate cells. Prefer geometry; fall back to reading order.
  const centre = (b) => b.Top + b.Height / 2;

  items.forEach((it, i) => {
    const code = partyOf(it);
    if (!code || out[code] !== undefined) return;

    if (it.box) {
      let best = null;
      items.forEach((other, j) => {
        if (i === j || used.has(j) || !other.box) return;
        const score = scoreOf(other);
        if (score === null) return;
        // Same row, and to the right of the party name.
        const sameRow = Math.abs(centre(other.box) - centre(it.box)) < it.box.Height * 0.6;
        if (!sameRow || other.box.Left <= it.box.Left) return;
        if (!best || other.box.Left < best.box.Left) best = { j, score, box: other.box };
      });
      if (best) { record(code, best.score); used.add(best.j); return; }
    }

    // No geometry: take the next unconsumed numeric cell in reading order.
    for (let j = i + 1; j < items.length; j++) {
      if (used.has(j)) continue;
      if (partyOf(items[j])) break; // ran into the next party row
      const score = scoreOf(items[j]);
      if (score !== null) { record(code, score); used.add(j); return; }
    }
  });

  return out;
}

// Canonical string for "are these two photos the same result?".
export const signature = (r) =>
  Object.keys(r).sort().map((k) => `${k}=${r[k]}`).join(',');

export const json = (statusCode, body, extra = {}) => ({
  statusCode,
  headers: { 'content-type': 'application/json', ...extra },
  body: JSON.stringify(body),
});
