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
const puScript = readFileSync('site/pu-data.js', 'utf8');

/* The real index/per-state shape the site now serves: the units live in a
   separate file keyed by state, and the PU code is rebuilt from the ward's
   prefix rather than stored on every row. */
const INDEX = {
  v: 2,
  states: [['OSUN', '29']],
  lgas: [['01 - ATAKUMOSA EAST', 0]],
  wards: [['01 - IWARA', 0, '29-01-01']],
  counts: { '29': 2 },
};
const STATE_29 = {
  state: '29',
  pus: [
    ['001', 'TOWN HALL IWARA', 0],
    ['002', 'UNITY PRY. SCHOOL, IWARA', 0],
  ],
};

/* A polling unit that was counted with CORRECTED figures: OCR misread APC as
   100 and missed NDC entirely, and the admin fixed both before approving. The
   page must show what was approved, not what was read. */
let PU_RESPONSE = {
  election: 'presidential',
  archived: false,
  counted: true,
  status: 'added',
  results: { APC: 100, NDC: 300, ADC: 1, PDP: 1 },
  uploads: [{
    uploadId: 'u1',
    ts: '2026-09-01T23:20:58.000Z',
    url: '/photos/presidential/29-01-01-002/a.jpg',
    extracted: { APC: 180, ADC: 1, PDP: 1 },
    inOsun: false,
    device: 'f320a7',
  }],
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
    _id: '',
    addEventListener() {},
    insertAdjacentHTML(_pos, h) { this.innerHTML += h; },
    showModal() {}, close() {},
    closest() { return null; },
    querySelector() { return makeEl(); },
    // toggleExtract builds a detail row and inserts it after the unit's row.
    after(node) { this.nextElementSibling = node; },
    remove() {},
    nextElementSibling: null,
  };
}

async function render({ search = '', admin = false, openPu = null, query = null } = {}) {
  const els = new Map();
  const dangerOn = new Set();
  const el = (id) => {
    if (!els.has(id)) {
      const e = makeEl();
      e._id = id;
      // Record .btn-danger toggles so "is the test button red?" is observable.
      e.classList = {
        toggle: (cls, on) => { if (cls === 'btn-danger') { on ? dangerOn.add(id) : dangerOn.delete(id); } },
        add: (cls) => { if (cls === 'btn-danger') dangerOn.add(id); },
        remove: (cls) => { if (cls === 'btn-danger') dangerOn.delete(id); },
      };
      els.set(id, e);
    }
    return els.get(id);
  };
  const store = new Map();
  if (admin) store.set('irev2-admin', 'fake.token');

  const sandbox = {
    document: {
      querySelector: (s) => (s.startsWith('#') ? el(s.slice(1)) : makeEl()),
      querySelectorAll: () => [],
      addEventListener() {},
      createElement: () => makeEl(),
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
      text: async () => JSON.stringify(PU_RESPONSE),
      json: async () => {
        if (url.includes('polling-units')) return INDEX;
        if (/\/pu\/\d+\.json/.test(url)) return STATE_29;
        if (url.includes('/pu?')) return PU_RESPONSE;
        if (url.includes('/parties')) return { parties: [] };
        return SUMMARY;
      },
    }),
    setTimeout, clearTimeout, Intl, Date, Object, Array, JSON, console, String, Number, Math,
  };

  /* pu-data.js is evaluated for real rather than stubbed: the code-to-state
     routing it does is the thing that decides which file the page fetches, so
     a fake would test nothing. */
  const fakeWindow = {};
  new Function('window', 'fetch', puScript)(fakeWindow, sandbox.fetch);
  sandbox.PU = fakeWindow.PU;

  const fn = new Function(
    ...Object.keys(sandbox),
    script + '\n;return { totals: document.querySelector("#totals"), rows: document.querySelector("#rows"), line: document.querySelector("#approve-line"), link: document.querySelector("#approve-link"), toggleExtract, applyFilter };',
  );
  const out = fn(...Object.values(sandbox));
  await new Promise((r) => setTimeout(r, 40));   // let init()'s promises settle

  /* The grid is search-driven now: with 176,595 units nationally it does not
     list everything, so a test that wants rows has to ask for them. */
  if (query !== null) {
    els.get('q-pu').value = query;
    await out.applyFilter();
    await new Promise((r) => setTimeout(r, 40));
  }

  /* Open one polling unit's detail row, which is where the figures under a
     photo are drawn. Driven through the real toggleExtract rather than by
     re-implementing its markup here. */
  let detail = '';
  if (openPu) {
    const tr = makeEl();
    tr.classList = { contains: () => false, toggle() {}, add() {}, remove() {} };
    await out.toggleExtract(openPu, tr);
    await new Promise((r) => setTimeout(r, 40));
    detail = tr.nextElementSibling ? tr.nextElementSibling.innerHTML : '';
  }

  return {
    detail,
    countLine: els.get('count-line')?.textContent ?? '',
    uploadsBtn: els.get('uploads-toggle-btn')?.textContent ?? '',
    testBtnDanger: dangerOn.has('test-toggle-btn'),
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

console.log('\n  the grid is search-driven, not a list of the whole country');
ok('with an empty search it prompts rather than listing 176k units',
   live.rows === '' && /Enter your full PU code/.test(live.countLine), live.countLine);

const searched = await render({ query: '29-01-01' });
ok('searching a PU code renders the matching units',
   searched.rows.includes('TOWN HALL IWARA'), searched.rows.slice(0, 200));
ok('and the code is shown in full on the row',
   searched.rows.includes('29-01-01-001'), searched.rows.slice(0, 200));
ok('the upload button is present but disabled while uploads are closed',
   searched.rows.includes('btn-up'), searched.rows.slice(0, 200));

console.log('\nARCHIVE view (?election=osun)');
const arch = await render({ search: '?election=osun' });
ok('still shows both labelled rows', (arch.totals.match(/totals-row/g) || []).length === 2);
ok('the archive grid drops the upload button entirely',
   !arch.rows.includes('btn-up'),
   'a finished election must not offer an upload control');
const archSearched = await render({ search: '?election=osun', query: '29-01-01' });
ok('the archive grid still lists polling units when searched',
   archSearched.rows.includes('TOWN HALL IWARA'), archSearched.rows.slice(0, 200));
ok('and still offers the extracted result', archSearched.rows.includes('view extracted result'));
ok('but never an upload button', !archSearched.rows.includes('btn-up'));

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

console.log('\nfigures shown under a photo after approval');
{
  SUMMARY.current = 'presidential';
  SUMMARY.testMode = false;
  delete SUMMARY.elections.test;

  const r = await render({ admin: true, openPu: '29-01-01-002' });
  const d = r.detail;

  ok('the approved figures are shown', /APC[^]*?100/.test(d) && /NDC[^]*?300/.test(d),
     d.slice(0, 400));
  ok('the misread extraction is NOT shown as the result',
     !/<td>180<\/td>/.test(d), 'APC 180 was what OCR read, not what was approved');
  ok('the figures are captioned as approved', /Approved figures/.test(d), d.slice(0, 300));
  ok('and flagged as corrected', /corrected before approval/.test(d));
  ok('what OCR originally read is still visible for reference',
     /Originally read:/.test(d) && /180/.test(d));

  // A unit that has NOT been counted still shows the extraction, uncaptioned.
  PU_RESPONSE = {
    ...PU_RESPONSE, counted: false, status: 'pending', results: {},
  };
  const p = await render({ openPu: '29-01-01-002' });
  ok('an uncounted unit shows the extraction', /<td>180<\/td>/.test(p.detail), p.detail.slice(0, 300));
  ok('with no approved caption', !/Approved figures/.test(p.detail));
}

console.log('\nthe uploads button names its switch and its state');
{
  SUMMARY.current = 'presidential';
  SUMMARY.testMode = false;
  delete SUMMARY.elections.test;

  SUMMARY.uploadsEnabled = false;
  const off = await render({ admin: true });
  ok('uploads blocked reads "Disable uploads: ON"',
     off.uploadsBtn === 'Disable uploads: ON', off.uploadsBtn);

  SUMMARY.uploadsEnabled = true;
  const on = await render({ admin: true });
  ok('uploads open reads "Disable uploads: OFF"',
     on.uploadsBtn === 'Disable uploads: OFF', on.uploadsBtn);

  /* Test mode permits uploads WITHOUT touching the uploads switch. Reading the
     effective "can anyone upload right now" state here made the button claim
     uploads were open while the switch was still closed. */
  SUMMARY.uploadsEnabled = false;
  SUMMARY.testMode = true;
  SUMMARY.current = 'test';
  SUMMARY.elections.test = {
    id: 'test', label: 'TEST MODE Results', archived: false, ephemeral: true,
    display: ['NDC', 'APC', 'PDP', 'ADC'], totals: {}, counts: {},
  };
  const inTest = await render({ admin: true });
  ok('test mode does not flip the label: still "Disable uploads: ON"',
     inTest.uploadsBtn === 'Disable uploads: ON', inTest.uploadsBtn);

  SUMMARY.testMode = false;
  SUMMARY.current = 'presidential';
  delete SUMMARY.elections.test;
  SUMMARY.uploadsEnabled = false;   // leave it as the site actually sits
}

console.log('\ntest mode turns its button red');
{
  SUMMARY.uploadsEnabled = false;
  SUMMARY.testMode = false;
  delete SUMMARY.elections.test;
  const off = await render({ admin: true });
  ok('the test button is not red while test mode is off', off.testBtnDanger === false);

  SUMMARY.testMode = true;
  SUMMARY.current = 'test';
  SUMMARY.elections.test = {
    id: 'test', label: 'TEST MODE Results', archived: false, ephemeral: true,
    display: ['NDC', 'APC', 'PDP', 'ADC'], totals: {}, counts: {},
  };
  const on = await render({ admin: true });
  ok('the test button is red while test mode is on', on.testBtnDanger === true);

  SUMMARY.testMode = false;
  SUMMARY.current = 'presidential';
  delete SUMMARY.elections.test;
}

console.log(`\n${fails ? 'FAILURES: ' + fails : 'ALL PASSED'}\n`);
process.exit(fails ? 1 : 0);
