/* The Osun/presidential split, tested where it can actually go wrong.
 *
 * The whole archiving approach rests on one property: Osun keeps the ORIGINAL
 * key layout, so separating the two elections rewrites no existing item. If a
 * refactor ever gives Osun a prefix, every Osun result silently disappears
 * from the site while still sitting in the table. That is the thing worth a
 * test, so it is asserted against the literal strings the live data uses.
 */

import { keysFor, electionOf, ELECTIONS, CURRENT_ELECTION, PARTIES } from '../api/util.mjs';

let pass = 0, fail = 0;
const ok = (name, cond) => {
  if (cond) { pass++; console.log(`   PASS  ${name}`); }
  else { fail++; console.log(`   FAIL  ${name}`); }
};
const eq = (name, got, want) => {
  const good = got === want;
  if (!good) console.log(`         got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
  ok(name, good);
};

console.log('\n1. Osun keeps the pre-split keys exactly — this is the no-migration guarantee');
{
  const K = keysFor('osun');
  eq('totals item is still AGG/TOTALS', K.totals, 'TOTALS');
  eq('parties item is still AGG/PARTIES', K.parties, 'PARTIES');
  eq('counter partition is still CNT', K.cnt, 'CNT');
  eq('recent-uploads feed is still UPL', K.upl, 'UPL');
  eq('audit partition is still AUDIT', K.audit, 'AUDIT');
  eq('upload partition is still PU#<code>', K.pu('29-01-01-001'), 'PU#29-01-01-001');
  eq('photo prefix is still photos', K.photoPrefix, 'photos');
}

console.log('\n2. The presidential election is namespaced away from all of it');
{
  const P = keysFor('presidential');
  const O = keysFor('osun');
  ok('totals differ', P.totals !== O.totals);
  ok('counters differ', P.cnt !== O.cnt);
  ok('audit differs', P.audit !== O.audit);
  ok('upload partitions differ', P.pu('29-01-01-001') !== O.pu('29-01-01-001'));
  ok('party registries differ', P.parties !== O.parties);
  ok('photo prefixes differ', P.photoPrefix !== O.photoPrefix);
  // A presidential photo key must not be mistakable for an Osun one, or the
  // /upload-done prefix check would accept a cross-election key.
  ok('a presidential key is not under the Osun prefix pattern',
     !P.photoPrefix.match(/^photos\/?$/));
}

console.log('\n3. Photo URLs point at the right origin');
{
  const O = keysFor('osun');
  const P = keysFor('presidential');
  eq('Osun photos are served from the archive path',
     O.photoUrl('photos/29-01-01-001/abc.jpg'),
     '/osun-archive/photos/29-01-01-001/abc.jpg');
  eq('presidential photos are served from the live photo path',
     P.photoUrl('photos/presidential/29-01-01-001/abc.jpg'),
     '/photos/presidential/29-01-01-001/abc.jpg');
  // The archive key and the URL must agree, otherwise CloudFront would need a
  // path-rewriting function at the edge that does not exist.
  const key = 'photos/29-01-01-001/abc.jpg';
  eq('archive URL is exactly the archive object key',
     O.photoUrl(key), '/' + 'osun-archive/' + key);
}

console.log('\n4. An unknown or missing election never silently reads the wrong one');
{
  eq('missing falls back to the live election', electionOf(undefined), CURRENT_ELECTION);
  eq('empty falls back to the live election', electionOf(''), CURRENT_ELECTION);
  eq('nonsense falls back to the live election', electionOf('../../etc'), CURRENT_ELECTION);
  eq('case is normalised', electionOf('OSUN'), 'osun');
  eq('whitespace is trimmed', electionOf('  osun '), 'osun');
  eq('an explicit fallback is honoured', electionOf('nope', 'osun'), 'osun');
  // keysFor must never throw on junk: it is called on every request.
  ok('keysFor on junk returns the live election', keysFor('junk').id === CURRENT_ELECTION);
}

console.log('\n5. The live election is the presidential one, and Osun is archived');
{
  eq('current election', CURRENT_ELECTION, 'presidential');
  ok('Osun is marked archived', ELECTIONS.osun.archived === true);
  ok('presidential is not archived', ELECTIONS.presidential.archived === false);
  eq('Osun label', ELECTIONS.osun.label, 'Osun Election Results');
  eq('presidential label', ELECTIONS.presidential.label, 'Presidential Election Results');
}

console.log('\n6. The parties shown on an empty presidential row are the ones on the ballot');
{
  const want = ['NDC', 'APC', 'PDP'];
  eq('display parties', JSON.stringify(ELECTIONS.presidential.display), JSON.stringify(want));
  // Discovery must recognise them on a real sheet, not invent them fresh.
  for (const p of want) ok(`${p} is in the seed party list`, PARTIES.includes(p));
  eq('Osun display parties match the published totals',
     JSON.stringify(ELECTIONS.osun.display), JSON.stringify(['ACCORD', 'APC', 'ADC']));
}

console.log(`\n${fail ? 'FAILURES: ' + fail : 'ALL PASSED'}  (${pass} checks)\n`);
process.exit(fail ? 1 : 0);
