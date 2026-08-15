/* Party discovery: an unregistered party must be picked up from a sheet, and
 * headings must never be mistaken for one. Run against the captured Textract
 * fixture plus synthetic rows for parties nobody has registered. */
import { readFileSync } from 'node:fs';
import { parseResults, PARTIES } from '../api/util.mjs';

let fails = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) { console.log(`         got  ${JSON.stringify(got)}`); console.log(`         want ${JSON.stringify(want)}`); fails++; }
};

// Two-column layout matching a real sheet: party on the left, score on the right.
const row = (text, top, left) => ({ Text: text, Box: { Top: top, Left: left, Height: 0.02, Width: 0.1 } });
const sheet = (pairs, extra = []) => {
  const out = [row('PARTY', 0.10, 0.06), row('VOTES', 0.10, 0.64), ...extra];
  pairs.forEach(([p, v], i) => {
    const top = 0.20 + i * 0.04;
    out.push(row(p, top, 0.06), row(String(v), top, 0.64));
  });
  return out;
};

console.log('1. a party nobody registered is read and reported');
{
  // ZENITH and AAP are not in the seed list.
  const discovered = new Set();
  const got = parseResults(sheet([['APC', 100], ['ZENITH', 42], ['AAP', 7]]), { discovered });
  check('figures include the unknown parties', got, { APC: 100, ZENITH: 42, AAP: 7 });
  check('both reported for registration', [...discovered].sort(), ['AAP', 'ZENITH']);
  check('the seed party is not reported as new', discovered.has('APC'), false);
}

console.log('\n2. headings and sheet furniture are never treated as parties');
{
  const discovered = new Set();
  const extra = [
    row('FORM', 0.02, 0.06), row('EC8A', 0.02, 0.30),
    row('STATE', 0.05, 0.06), row('OSUN', 0.05, 0.30),
    row('TOTAL', 0.60, 0.06), row('484', 0.60, 0.64),
    row('POLLING', 0.65, 0.06), row('12', 0.65, 0.64),
  ];
  const got = parseResults(sheet([['APC', 212], ['PDP', 178]]), { discovered, extra: null });
  check('only real parties counted', got, { APC: 212, PDP: 178 });

  const d2 = new Set();
  const got2 = parseResults(sheet([['APC', 212]], extra), { discovered: d2 });
  check('TOTAL not counted as a party', got2.TOTAL, undefined);
  check('OSUN not counted as a party', got2.OSUN, undefined);
  check('POLLING not counted as a party', got2.POLLING, undefined);
  check('EC8A not counted as a party', got2.ECA ?? got2.EC8A, undefined);
  check('nothing bogus registered', [...d2], []);
}

console.log('\n3. an unpaired word is not a party');
{
  const d = new Set();
  // WIDGET sits alone with no score anywhere on its row.
  const blocks = sheet([['APC', 50]]).concat([row('WIDGET', 0.40, 0.06)]);
  const got = parseResults(blocks, { discovered: d });
  check('unpaired word ignored', got, { APC: 50 });
  check('nothing registered from it', [...d], []);
}

console.log('\n4. a previously learned party is treated as known');
{
  const d = new Set();
  const got = parseResults(sheet([['ZENITH', 9]]), { known: new Set(['ZENITH']), discovered: d });
  check('still parsed', got, { ZENITH: 9 });
  check('not re-reported once registered', [...d], []);
}

console.log('\n5. real Textract fixture still parses unchanged');
{
  const blocks = JSON.parse(readFileSync('tools/fixtures/textract-lines.json', 'utf8'));
  const d = new Set();
  check('fixture figures', parseResults(blocks, { discovered: d }),
    { APC: 212, PDP: 178, LP: 64, NNPP: 21, ADC: 9 });
  check('no spurious discoveries from a real sheet', [...d], []);
}

console.log('\n6. Accord from the sample table is recognised');
check('ACCORD is in the seed list now', PARTIES.includes('ACCORD'), true);

console.log('\n' + (fails ? `${fails} FAILED` : 'ALL PASSED'));
process.exit(fails ? 1 : 0);
