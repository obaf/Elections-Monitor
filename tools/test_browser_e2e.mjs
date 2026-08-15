/* Real browser, real clicks, real network.
 *
 * Drives the deployed site in Chrome: log in as admin, expand a polling unit's
 * extracted result, amend the figures in the table, add a party OCR missed,
 * press "Approve these figures into the totals", and check the totals on the
 * page actually change. This is the path the reported failure was on, so it is
 * the only test that can honestly say "it works in the browser".
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire('file:///C:/PHD_RESEARCH/_e2e/');
const { chromium } = require('playwright-core');

const BASE = process.argv[2] || 'https://www.irev2.com';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PU = '29-01-01-005';

const creds = readFileSync('admin user and pwd.txt', 'utf8');
const USER = creds.match(/Username\s*:\s*(\S+)/)[1];
const PASS = creds.match(/Password\s*:\s*(\S+)/)[1];

let fails = 0;
const check = (label, ok, detail = '') => {
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) fails++;
};

const api = async (path, payload, token) => {
  const r = await fetch(BASE + path, {
    method: payload ? 'POST' : 'GET',
    headers: {
      ...(payload ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => null) };
};

/* --- put a photo on the unit so there is something to approve --------------- */
const signed = await api('/api/upload-url', { puCode: PU });
await fetch(signed.json.url, {
  method: 'PUT', headers: { 'content-type': 'image/jpeg' },
  body: readFileSync('tools/seed/repro.jpg'),
});
const up = await api('/api/upload-done', { puCode: PU, key: signed.json.key, deviceId: 'e2e-browser' });
console.log(`setup: OCR read ${JSON.stringify(up.json.extracted)}, verified=${up.json.verified}\n`);

/* --- drive the browser ----------------------------------------------------- */
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });

const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

// Cache-bust so this can never test a stale bundle.
await page.goto(`${BASE}/?e2e=${Date.now()}`, { waitUntil: 'networkidle' });

console.log('1. the page loads and hides admin controls from a visitor');
check('heading present', (await page.textContent('h1')).includes('OSUN ELECTION MONITORING PORTAL'));
check('See Breakdown visible', await page.isVisible('a.btn-breakdown'));
check('upload-count button hidden', !(await page.isVisible('#upload-count-btn')));
check('messages button hidden', !(await page.isVisible('#admin-msgs-btn')));

console.log('\n2. admin login through the dialog');
await page.click('#admin-login-btn');
await page.fill('#admin-u', USER);
await page.fill('#admin-p', PASS);
await page.click('#admin-go');
await page.waitForSelector('#admin-flag:visible', { timeout: 15000 });
check('ADMIN MODE flag shown', await page.isVisible('#admin-flag'));
check('upload-count button now visible', await page.isVisible('#upload-count-btn'));
check('messages button now visible', await page.isVisible('#admin-msgs-btn'));

console.log('\n3. find the polling unit and open its extracted result');
await page.fill('#q-pu', PU);
await page.waitForSelector(`tr[data-code="${PU}"]`, { timeout: 15000 });
// The search is debounced by 140ms and re-renders the whole row list, which
// would wipe a panel opened before it fires. Let it settle first.
await page.waitForTimeout(600);
await page.click(`tr[data-code="${PU}"] button[data-act="extract"]`);
await page.waitForSelector('tr.detail table.edit-tbl', { timeout: 20000 });
check('editable table rendered for admin', await page.isVisible('tr.detail table.edit-tbl'));

const before = await page.$$eval('tr.detail table.edit-tbl tbody tr', (rows) =>
  rows.map((r) => [r.querySelector('.p-in').value, r.querySelector('.v-in').value]));
check('table prefilled from OCR', JSON.stringify(before) === JSON.stringify([['PDP', '60'], ['APC', '50']]),
  JSON.stringify(before));

console.log('\n4. amend the figures and add a party OCR missed');
// Correct APC 50 -> 55 in whichever row holds it.
const rows = await page.$$('tr.detail table.edit-tbl tbody tr');
for (const r of rows) {
  const party = await r.$eval('.p-in', (i) => i.value);
  if (party === 'APC') { await r.$eval('.v-in', (i) => { i.value = '55'; }); }
}
await page.click('tr.detail button[data-act="addrow"]');
const added = (await page.$$('tr.detail table.edit-tbl tbody tr')).at(-1);
await added.$eval('.p-in', (i) => { i.value = 'ACCORD'; });
await added.$eval('.v-in', (i) => { i.value = '12'; });
const typed = await page.$$eval('tr.detail table.edit-tbl tbody tr', (rs) =>
  rs.map((r) => `${r.querySelector('.p-in').value} ${r.querySelector('.v-in').value}`).join(', '));
console.log(`   typed: ${typed}`);

console.log('\n5. press "Approve these figures into the totals"');
const label = await page.textContent('tr.detail button[data-act="approve"]');
check('button label matches the report', label.trim() === 'Approve these figures into the totals', label.trim());
await page.click('tr.detail button[data-act="approve"]');

// The login toast may still be on screen; wait for the text to actually change
// rather than reading whatever happens to be showing.
const priorToast = await page.evaluate(() =>
  document.querySelector('#toast').hidden ? '' : document.querySelector('#toast').textContent.trim());
await page.waitForFunction((prev) => {
  const t = document.querySelector('#toast');
  return !t.hidden && t.textContent.trim() !== prev;
}, priorToast, { timeout: 30000 });
const toast = (await page.textContent('#toast')).trim();
console.log(`   toast: "${toast}"`);
check('toast reports success', /^Approved/.test(toast));
check('no inline error shown', !(await page.isVisible('tr.detail .edit-err')));

console.log('\n6. the totals on the page update without a reload');
await page.waitForFunction(
  () => [...document.querySelectorAll('#totals .tile')].length >= 3, null, { timeout: 25000 });
const tiles = await page.$$eval('#totals .tile', (ts) => {
  const o = {};
  for (const t of ts) o[t.querySelector('.p').textContent.trim()] =
    Number(t.querySelector('.v').textContent.replace(/[^\d]/g, ''));
  return o;
});
console.log(`   tiles: ${JSON.stringify(tiles)}`);
check('APC shows the amended 55', tiles.APC === 55, String(tiles.APC));
check('PDP shows 60', tiles.PDP === 60, String(tiles.PDP));
check('ACCORD (added by hand) shows 12', tiles.ACCORD === 12, String(tiles.ACCORD));

console.log('\n7. the server agrees');
const summary = await api('/api/summary');
const norm = (o) => JSON.stringify(Object.fromEntries(Object.entries(o || {}).sort()));
check('summary matches the amendment',
  norm(summary.json.totals) === norm({ APC: 55, PDP: 60, ACCORD: 12 }), norm(summary.json.totals));

console.log('\n8. no javascript errors in the console');
check('console clean', consoleErrors.length === 0, consoleErrors.join(' | ').slice(0, 200));

await page.screenshot({ path: 'tools/seed/e2e-approved.png', fullPage: false });
console.log('\n   screenshot: tools/seed/e2e-approved.png');

await browser.close();
console.log('\n' + (fails ? `${fails} FAILED` : 'ALL PASSED'));
process.exit(fails ? 1 : 0);
