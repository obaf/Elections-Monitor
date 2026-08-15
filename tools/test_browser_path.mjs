/* Runs the REAL approve() and collectFigures() from site/app.js against the
 * LIVE api, with a stub DOM standing in for a rendered edit table.
 *
 * The previous test drove the API from Python. That proves the server works; it
 * says nothing about the client, which is where the reported failure is. This
 * closes that gap: same code the browser runs, same network calls.
 */
import { readFileSync } from 'node:fs';

const BASE = process.argv[2] || 'https://www.irev2.com';
const PU = '29-01-01-005';
const src = readFileSync('site/app.js', 'utf8');

// Pull the two functions verbatim out of the shipped file.
const grab = (re) => { const m = src.match(re); if (!m) throw new Error('could not find ' + re); return m[0]; };
const collectSrc = grab(/function collectFigures[\s\S]*?\n}/);
const approveSrc = grab(/async function approve[\s\S]*?\n}\n/);

const log = [];

function makeTable(rows) {
  return {
    querySelectorAll: () => rows.map((r) => ({
      querySelector: (sel) => ({ value: sel === '.p-in' ? r[0] : r[1] }),
    })),
  };
}

async function runApprove({ code, uploadId, rows, token }) {
  const errEl = { textContent: '', hidden: true };
  const btn = { disabled: false, textContent: 'Approve these figures into the totals' };
  const table = makeTable(rows);

  const sandbox = {
    API: '/api',
    adminToken: token,
    document: {
      querySelector: (sel) => {
        if (sel.startsWith('[data-err')) return errEl;
        if (sel.startsWith('[data-edit')) return table;
        return null;                       // no <tr> to redraw in the harness
      },
      querySelectorAll: () => [],
    },
    CSS: { escape: (s) => s },
    sessionStorage: { removeItem() {} },
    nf: new Intl.NumberFormat('en-NG'),
    toast: (m) => log.push(['toast', m]),
    refreshAdminUi() {},
    refreshRow() {},
    toggleExtract() {},
    loadSummary: async () => log.push(['loadSummary', 'called']),
    // Real network, absolute URL so node can resolve it.
    fetch: (url, opts) => fetch(BASE + url, opts),
    console, Object, Number, JSON, Date, Error, Intl,
  };

  const body = `${collectSrc}\n${approveSrc}\n;return approve(code, uploadId, btn);`;
  const fn = new Function(...Object.keys(sandbox), 'code', 'uploadId', 'btn', body);
  await fn(...Object.values(sandbox), code, uploadId, btn);
  return { err: errEl.hidden ? null : errEl.textContent, btn: btn.textContent, log: [...log] };
}

/* ------------------------------ live fixtures ----------------------------- */

const api = async (path, payload, token) => {
  const r = await fetch(BASE + path, {
    method: payload ? 'POST' : 'GET',
    headers: {
      ...(payload ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text: text.slice(0, 120) };
};

const creds = readFileSync('admin user and pwd.txt', 'utf8');
const username = creds.match(/Username\s*:\s*(\S+)/)[1];
const password = creds.match(/Password\s*:\s*(\S+)/)[1];

console.log(`target: ${BASE}\n`);

const login = await api('/api/admin/login', { username, password });
if (login.status !== 200) { console.log('LOGIN FAILED', login); process.exit(1); }
const token = login.json.token;
console.log('admin login: OK');

// Put a photo on a unit so there is something to approve.
const signed = await api('/api/upload-url', { puCode: PU });
await fetch(signed.json.url, {
  method: 'PUT',
  headers: { 'content-type': 'image/jpeg' },
  body: readFileSync('tools/seed/repro.jpg'),
});
const done = await api('/api/upload-done', { puCode: PU, key: signed.json.key, deviceId: 'browser-path' });
console.log('upload     : OCR read', JSON.stringify(done.json.extracted), '| verified:', done.json.verified);

const pu = await api(`/api/pu?code=${PU}`);
const uploadId = pu.json.uploads[pu.json.uploads.length - 1].uploadId;

console.log('\n--- running the browser\'s approve() with amended figures ---');
console.log('    typed into the table: APC 55 (was 50), PDP 60, ACCORD 12 (added)');
const res = await runApprove({
  code: PU, uploadId, token,
  rows: [['APC', '55'], ['PDP', '60'], ['ACCORD', '12']],
});

console.log('\n    inline error :', res.err ?? '(none)');
console.log('    button label :', res.btn);
for (const [k, v] of res.log) console.log(`    ${k.padEnd(12)}: ${v}`);

const after = await api('/api/summary');
console.log('\n    totals now   :', JSON.stringify(after.json.totals));

// Compare by content, not key order -- DynamoDB returns map keys unordered.
const norm = (o) => JSON.stringify(Object.fromEntries(Object.entries(o || {}).sort()));
const ok = norm(after.json.totals) === norm({ APC: 55, PDP: 60, ACCORD: 12 });
console.log('\n' + (ok
  ? 'RESULT: the browser code path WORKS — amended figures reached the totals.'
  : 'RESULT: the browser code path FAILED — totals did not match the amendment.'));
process.exit(ok ? 0 : 1);
