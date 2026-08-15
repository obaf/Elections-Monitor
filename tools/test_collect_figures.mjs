/* Exercises the real collectFigures() from site/app.js against a fake table.
 * This is the gate that decides whether an approve request is sent at all, so a
 * false rejection here looks to the admin like the button doing nothing. */
import { readFileSync } from 'node:fs';

const src = readFileSync('site/app.js', 'utf8');
const body = src.match(/function collectFigures[\s\S]*?\n}/)[0];

function run(rows) {
  const table = {
    querySelectorAll: () => rows.map((r) => ({
      querySelector: (sel) => ({ value: sel === '.p-in' ? r[0] : r[1] }),
    })),
  };
  const sandbox = {
    document: { querySelector: () => table },
    CSS: { escape: (s) => s },
    Number, Object,
  };
  const fn = new Function(...Object.keys(sandbox), body + '\n;return collectFigures;')(...Object.values(sandbox));
  return fn('any-id');
}

let fails = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) { console.log(`         got  ${JSON.stringify(got)}`); console.log(`         want ${JSON.stringify(want)}`); fails++; }
};

console.log('accepted');
check('plain figures', run([['APC', '212'], ['PDP', '178']]).figures, { APC: 212, PDP: 178 });
check('lowercase party uppercased', run([['apc', '5']]).figures, { APC: 5 });
check('party with spaces/punctuation cleaned', run([[' a.p.c ', '5']]).figures, { APC: 5 });
check('thousands separator accepted', run([['APC', '1,080']]).figures, { APC: 1080 });
check('spaces inside the number accepted', run([['APC', '1 080']]).figures, { APC: 1080 });
check('zero is a valid score', run([['APC', '0']]).figures, { APC: 0 });
check('blank row ignored', run([['APC', '7'], ['', '']]).figures, { APC: 7 });
check('a party OCR missed can be added', run([['APC', '7'], ['ACCORD', '3']]).figures, { APC: 7, ACCORD: 3 });

console.log('\nrejected with a reason the admin can act on');
const err = (rows) => run(rows).error;
check('missing score', typeof err([['APC', '']]), 'string');
check('missing party name', typeof err([['', '10']]), 'string');
check('non-numeric score', typeof err([['APC', 'twelve']]), 'string');
check('decimal score', typeof err([['APC', '10.5']]), 'string');
check('negative score', typeof err([['APC', '-5']]), 'string');
check('duplicate party', typeof err([['APC', '1'], ['APC', '2']]), 'string');
check('all rows blank', typeof err([['', '']]), 'string');
check('rejection never returns figures', run([['APC', 'twelve']]).figures, undefined);

console.log('\nthe reason text names the offending party');
const m = err([['PDP', 'twelve']]);
check('mentions PDP', m.includes('PDP'), true);
check('quotes what was typed', m.includes('twelve'), true);

console.log('\n' + (fails ? `${fails} FAILED` : 'ALL PASSED'));
process.exit(fails ? 1 : 0);
