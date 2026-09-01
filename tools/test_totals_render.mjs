/* Renders the front page's real script against a stub DOM.
 *
 * The two things worth pinning down here are the ones a reader would notice
 * immediately and a test would not: that the finished Osun figures and the
 * live presidential ones are drawn as two separately LABELLED rows rather than
 * summed into one, and that the presidential row still has a shape -- the
 * parties on the ballot at 000 -- before a single result exists.
 */
import { readFileSync } from 'node:fs';

const script = readFileSync('site/app.js', 'utf8');

const UNITS = {
  lgas: ['01 - ATAKUMOSA EAST'],
  wards: [['01 - IWARA', 0]],
  pus: [
    ['29-01-01-001', 'TOWN HALL IWARA', 0],
    ['29-01-01-002', 'UNITY PRY. SCHOOL, IWARA', 0],
  ],
};

// Shaped exactly like the live /api/summary response.
const SUMMARY = {
  current: 'presidential',
  uploadsEnabled: false,
  elections: {
    osun: {
      id: 'osun', label: 'Osun Election Results', archived: true, ephemeral: false,
      display: ['ACCORD', 'APC', 'ADC'],
      totals: { ACCORD: 3491, APC: 2046, ADC: 179 },
      counts: { '29-01-01-001': [2, 1, 'added'] },
    },
    presidential: {
      id: 'presidential', label: 'Presidential Election Results', archived: false, ephemeral: false,
      display: ['NDC', 'APC', 'PDP', 'ADC'],
      totals: {},
      // Deliberately lopsided: 9 photos across 2 polling units. The approve
      // line must say 2, not 9.
      counts: {
        '29-01-01-001': [7, 0, ''],
        '29-01-01-002': [2, 0, ''],
      },
    },
  },
  totals: {},
  counts: {},
};

function makeEl() {
  return {
    innerHTML: '', textContent: '', value: '', hidden: false, checked: false,
    disabled: false, title: '', dataset: {},
    classList: { toggle() {}, add() {}, remove() {} },
    addEventListener() {},
    insertAdjacentHTML(_pos, h) { this.innerHTML += h; },
    showModal() {}, close() {},
    closest() { return null; },
    querySelector() { return makeEl(); },
  };
}

async function render({ search = '', admin = false } = {}) {
  const els = new Map();
  const el = (id) => { if (!els.has(id)) els.set(id, makeEl()); return els.get(id); };
  const store = new Map();
  if (admin) store.set('irev2-admin', 'fake.token');

  const sandbox = {
    document: {
      querySelector: (s) => (s.startsWith('#') ? el(s.slice(1)) : makeEl()),
      querySelectorAll: () => [],
      addEventListener() {},
    },
    location: { search },
    URLSearchParams,
    sessionStorage: {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => store.set(k, v),
      removeItem: (k) => store.delete(k),
    },
    localStorage: {
      getItem: () => 'device-1',
      setItem() {},
    },
    crypto: { randomUUID: () => 'uuid-1' },
    CSS: { escape: (s) => s },
    IntersectionObserver: class { observe() {} },
    fetch: async (url) => ({
      ok: true, status: 200,
      json: async () => (url.includes('polling-units') ? UNITS : SUMMARY),
    }),
    setTimeout, clearTimeout, Intl, Date, Object, Array, JSON, console, String, Number, Math,
  };

  const fn = new Function(
    ...Object.keys(sandbox),
    script + '\n;return { totals: document.querySelector("#totals"), rows: document.querySelector("#rows"), line: document.querySelector("#approve-line"), link: document.querySelector("#approve-link") };',
  );
  const out = fn(...Object.values(sandbox));
  await new Promise((r) => setTimeout(r, 40));   // let init()'s promises settle
  return {
    totals: out.totals.innerHTML,
    rows: out.rows.innerHTML,
    approveHidden: out.line.hidden,
    approveText: out.link.textContent,
    approveHref: out.link.href ?? '/approve.html',
  };
}

let fails = 0;
const ok = (label, cond, detail) => {
  console.log(`   ${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) { if (detail) console.log(`         ${detail}`); fails++; }
};

console.log('\nLIVE view (the presidential election)');
const live = await render();

ok('the Osun row is labelled', live.totals.includes('Osun Election Results:'));
ok('the presidential row is labelled', live.totals.includes('Presidential Election Results:'));
ok('two labelled rows, not one merged total',
   (live.totals.match(/totals-row/g) || []).length === 2,
   `found ${(live.totals.match(/totals-row/g) || []).length}`);

// Osun comes first: it is the finished contest, and the specified layout reads
// top-down from the archive to the live election.
ok('Osun is drawn above presidential',
   live.totals.indexOf('Osun Election Results') < live.totals.indexOf('Presidential Election Results'));

console.log('\n  the Osun figures survive the split intact');
for (const [party, value] of [['ACCORD', '3,491'], ['APC', '2,046'], ['ADC', '179']]) {
  ok(`${party} shows ${value}`, live.totals.includes(value), live.totals.slice(0, 400));
}

console.log('\n  the presidential row has a shape before any result exists');
const presRow = live.totals.slice(live.totals.indexOf('Presidential Election Results'));
const PRES_PARTIES = ['NDC', 'APC', 'PDP', 'ADC'];
for (const party of PRES_PARTIES) {
  ok(`${party} is listed`, presRow.includes(`>${party}<`), presRow.slice(0, 300));
}
ok('its figures read 000',
   (presRow.match(/>000</g) || []).length === PRES_PARTIES.length,
   `found ${(presRow.match(/>000</g) || []).length} of ${PRES_PARTIES.length}`);
// ADC also appears in the Osun row with a real figure, so the placeholder must
// be the presidential one and not a stray match from the row above.
ok('ADC on the presidential row is a placeholder, not the Osun figure',
   presRow.includes('>ADC<') && !presRow.includes('179'));
ok('no Osun figure leaked into the presidential row',
   !presRow.includes('3,491') && !presRow.includes('2,046'));

console.log('\n  uploads are closed, so the grid offers no upload button');
ok('upload buttons are rendered but disabled, not missing',
   live.rows.includes('btn-up'), 'the live election still lists its units');

console.log('\nARCHIVE view (?election=osun)');
const arch = await render({ search: '?election=osun' });
ok('still shows both labelled rows', (arch.totals.match(/totals-row/g) || []).length === 2);
ok('the archive grid drops the upload button entirely',
   !arch.rows.includes('btn-up'),
   'a finished election must not offer an upload control');
ok('the archive grid still lists polling units', arch.rows.includes('TOWN HALL IWARA'));
ok('and still offers the extracted result', arch.rows.includes('view extracted result'));

console.log('\nTEST MODE view (the server reports test as current)');
{
  // Exactly the payload /api/summary returns while test mode is on.
  SUMMARY.current = 'test';
  SUMMARY.testMode = true;
  SUMMARY.elections.test = {
    id: 'test', label: 'TEST MODE Results', archived: false, ephemeral: true,
    display: ['NDC', 'APC', 'PDP', 'ADC'],
    totals: {}, counts: {},
  };
  const t = await render();

  ok('three rows are drawn', (t.totals.match(/totals-row/g) || []).length === 3,
     `found ${(t.totals.match(/totals-row/g) || []).length}`);

  const iOsun = t.totals.indexOf('Osun Election Results');
  const iTest = t.totals.indexOf('TEST MODE Results');
  const iPres = t.totals.indexOf('Presidential Election Results');

  /* The specified layout is Osun, then the test row, then the live election.
     This was previously right by accident: the server did not send `ephemeral`,
     so the sort fell through and the order came from the payload instead. */
  ok('Osun is first', iOsun >= 0 && iOsun < iTest);
  ok('the test row sits above the presidential row', iTest >= 0 && iTest < iPres);

  const testRow = t.totals.slice(iTest, iPres);
  for (const party of ['NDC', 'APC', 'PDP', 'ADC']) {
    ok(`the test row lists ${party}`, testRow.includes(`>${party}<`));
  }
  ok('the test figures read 000', (testRow.match(/>000</g) || []).length === 4,
     `found ${(testRow.match(/>000</g) || []).length} of 4`);
  ok('the Osun figures are untouched by test mode', t.totals.includes('3,491'));
}

console.log('\nthe "Click to approve uploaded results" line');
{
  /* Set the state this block needs rather than inheriting whatever the block
     above left behind -- the test-mode section mutates the shared SUMMARY, and
     depending on that ordering is how a test starts passing for the wrong
     reason (or, as here, failing for one). */
  SUMMARY.current = 'presidential';
  SUMMARY.testMode = false;
  delete SUMMARY.elections.test;

  // Admin only, and the count is POLLING UNITS with photos -- not photos.
  const visitor = await render();
  ok('hidden from an ordinary visitor', visitor.approveHidden === true);

  const admin = await render({ admin: true });
  ok('shown to an admin', admin.approveHidden === false);
  ok('counts polling units, not photos (2 units / 9 photos)',
     admin.approveText === '2 uploads', `got ${JSON.stringify(admin.approveText)}`);
  ok('the link points at the approve page',
     admin.approveHref === '/approve.html', admin.approveHref);

  // A finished election has nothing to approve.
  const arch = await render({ search: '?election=osun', admin: true });
  ok('hidden on the Osun archive', arch.approveHidden === true);
}

console.log(`\n${fails ? 'FAILURES: ' + fails : 'ALL PASSED'}\n`);
process.exit(fails ? 1 : 0);
