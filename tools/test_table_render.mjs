/* Renders breakdown.html's real script against a stub DOM and asserts the
 * table shape. Checks the thing that is easy to get wrong by eye: that a
 * visitor sees only the tabulation, and that TOTAL is the column sum. */
import { readFileSync } from 'node:fs';

const html = readFileSync('site/breakdown.html', 'utf8');
const script = html.match(/<script>([\s\S]*)<\/script>/)[1];

const UNITS = {
  lgas: ['01 - ATAKUMOSA EAST'],
  wards: [['01 - IWARA', 0]],
  pus: [
    ['29-01-01-001', 'TOWN HALL IWARA', 0],
    ['29-01-01-002', 'UNITY PRY. SCHOOL, IWARA', 0],
    ['29-01-01-003', 'L.A. SCHOOL, IWIKUN', 0],   // no photos at all
    ['29-01-01-004', 'METHODIST PRY. SCHOOL', 0], // photos, not counted
    ['29-01-01-005', 'L.A. PRY. SCHOOL', 0],      // revoked
  ],
};

const BREAKDOWN = {
  rows: [
    { puCode: '29-01-01-001', uploads: 2, status: 'added',
      results: { PDP: 20, APC: 20, Accord: 30, LP: 20 }, reason: '', revokedFigures: {} },
    { puCode: '29-01-01-002', uploads: 2, status: 'added',
      results: { PDP: 20, APC: 20, Accord: 30, LP: 20 }, reason: '', revokedFigures: {} },
    { puCode: '29-01-01-004', uploads: 1, status: 'pending', results: {}, reason: '', revokedFigures: {} },
    { puCode: '29-01-01-005', uploads: 2, status: 'revoked', results: {},
      reason: 'figures do not match the sheet', revokedAt: '2026-08-15T12:00:00.000Z',
      revokedFigures: { PDP: 5, APC: 5 } },
  ],
};

function makeEl() {
  return {
    innerHTML: '', textContent: '', value: '', hidden: false, checked: false, disabled: false,
    dataset: {},
    addEventListener() {},
    insertAdjacentHTML(_pos, h) { this.innerHTML += h; },
    showModal() {}, close() {},
    closest() { return null; },
  };
}

async function render({ admin }) {
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
    sessionStorage: {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => store.set(k, v),
      removeItem: (k) => store.delete(k),
    },
    IntersectionObserver: class { observe() {} },
    fetch: async (url) => ({
      ok: true, status: 200,
      json: async () => (url.includes('polling-units') ? UNITS : BREAKDOWN),
    }),
    setTimeout, clearTimeout, Intl, Date, Object, Array, JSON, console, String, Number,
  };

  const fn = new Function(...Object.keys(sandbox), script + '\n;return {head:document.querySelector("#head"),rows:document.querySelector("#rows"),foot:document.querySelector("#foot"),wd:document.querySelector("#withdrawn"),wdl:document.querySelector("#withdrawn-list"),intro:document.querySelector("#intro")};');
  const out = fn(...Object.values(sandbox));
  await new Promise((r) => setTimeout(r, 40));   // let load()'s promises settle
  return {
    head: out.head.innerHTML, rows: out.rows.innerHTML,
    foot: out.foot.innerHTML, wdHidden: out.wd.hidden, wdList: out.wdl.innerHTML,
    intro: out.intro.innerHTML,
  };
}

let fails = 0;
const check = (label, got, want) => {
  const ok = got === want;
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) { console.log(`         got  ${JSON.stringify(got)}`); console.log(`         want ${JSON.stringify(want)}`); fails++; }
};

console.log('VISITOR view');
const v = await render({ admin: false });
const vCols = [...v.head.matchAll(/<th[^>]*>([^<]*)</g)].map((m) => m[1].trim());
check('columns are the unit plus parties, alphabetical',
  vCols.join('|'), 'Polling Unit Name|Accord|APC|LP|PDP');
check('no Status column', /Status/.test(v.head), false);
check('no Admin column', /Admin/.test(v.head), false);
check('only counted units listed', (v.rows.match(/<tr /g) || []).length, 2);
check('uncounted unit absent', /METHODIST/.test(v.rows), false);
check('unit with no photos absent', /IWIKUN/.test(v.rows), false);
check('revoked unit not in the tabulation', /L\.A\. PRY/.test(v.rows), false);
const vFoot = [...v.foot.matchAll(/<td class="num">([^<]*)</g)].map((m) => m[1]);
check('TOTAL row is the column sum', vFoot.join(','), '60,40,40,40');
check('TOTAL label present', /TOTAL/.test(v.foot), true);
check('withdrawn section shown', v.wdHidden, false);
check('withdrawn lists the reason', /figures do not match the sheet/.test(v.wdList), true);

console.log('\nADMIN view');
const a = await render({ admin: true });
check('Status column added', /Status/.test(a.head), true);
check('Admin column added', /Admin/.test(a.head), true);
check('sees uncounted unit too', /METHODIST/.test(a.rows), true);
check('sees revoked unit', /L\.A\. PRY/.test(a.rows), true);
check('revoke button on counted rows', (a.rows.match(/data-revoke=/g) || []).length, 2);
check('status pills rendered', /pill-added/.test(a.rows) && /pill-revoked/.test(a.rows), true);
const aFoot = [...a.foot.matchAll(/<td class="num">([^<]*)</g)].map((m) => m[1]);
check('TOTAL unchanged by admin view', aFoot.slice(0, 4).join(','), '60,40,40,40');

/* A real ballot carries far more parties than this sample, and they arrive at
 * different times. New ones must slot into their alphabetical place rather than
 * being appended, otherwise a column moves under the reader between loads. */
console.log('\nMANY PARTIES — new arrivals slot into place, not onto the end');
BREAKDOWN.rows[0].results = { ZLP: 3, ADC: 7, PDP: 20, APC: 20, Accord: 30, LP: 20, NNPP: 9, AA: 1 };
const m = await render({ admin: false });
const mCols = [...m.head.matchAll(/<th[^>]*>([^<]*)</g)].map((x) => x[1].trim());
check('all parties present, alphabetical',
  mCols.join('|'), 'Polling Unit Name|AA|Accord|ADC|APC|LP|NNPP|PDP|ZLP');
check('wide-table hint shown', /scroll the table sideways/.test(m.intro), true);
const mFoot = [...m.foot.matchAll(/<td class="num">([^<]*)</g)].map((x) => x[1]);
// Unit 1 has all eight parties; unit 2 only the original four.
check('TOTAL sums each column independently', mFoot.join(','), '1,60,7,40,40,9,40,3');

console.log('\n' + (fails ? `${fails} FAILED` : 'ALL PASSED'));
process.exit(fails ? 1 : 0);
