/* Test mode's isolation and its wipe.
 *
 * The dangerous half of test mode is the erase: switching it off deletes data,
 * and a key-building mistake there would delete a real election instead. So
 * the tests below are about the boundary rather than the happy path -- that
 * the test namespace cannot collide with a real one, and that the guard which
 * stands in front of the delete actually rejects a real namespace.
 */

import { keysFor, ELECTIONS, REAL_ELECTIONS, TEST_ELECTION, CURRENT_ELECTION, electionOf }
  from '../api/util.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`   PASS  ${name}`); }
  else { fail++; console.log(`   FAIL  ${name}${detail ? '  — ' + detail : ''}`); }
};
const eq = (name, got, want) => ok(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const T = keysFor(TEST_ELECTION);
const O = keysFor('osun');
const P = keysFor('presidential');

console.log('\n1. Every test key is marked, and no real key is');
{
  const testKeys = [T.totals, T.parties, T.cnt, T.upl, T.audit, T.pu('29-01-01-001')];
  for (const k of testKeys) ok(`${k} carries TEST`, k.includes('TEST'));

  const realKeys = [
    O.totals, O.parties, O.cnt, O.upl, O.audit, O.pu('29-01-01-001'),
    P.totals, P.parties, P.cnt, P.upl, P.audit, P.pu('29-01-01-001'),
  ];
  for (const k of realKeys) ok(`${k} does NOT carry TEST`, !k.includes('TEST'));
}

console.log('\n2. No test key equals any real key');
{
  const t = new Set([T.totals, T.parties, T.cnt, T.upl, T.audit, T.pu('X'), T.photoPrefix]);
  const r = [O, P].flatMap((K) => [K.totals, K.parties, K.cnt, K.upl, K.audit, K.pu('X'), K.photoPrefix]);
  const clash = r.filter((k) => t.has(k));
  ok('no collision between the test and real namespaces', clash.length === 0, clash.join(','));
}

console.log('\n3. Test photos are confined to their own prefix');
{
  eq('test photo prefix', T.photoPrefix, 'photos/test');
  // The wipe deletes by this prefix, and IAM restricts DeleteObject to it, so
  // a real photo key must never begin with it.
  const osunKey = 'photos/29-01-01-001/abc.jpg';
  const presKey = 'photos/presidential/29-01-01-001/abc.jpg';
  ok('an Osun photo key is outside the test prefix', !osunKey.startsWith(T.photoPrefix + '/'));
  ok('a presidential photo key is outside the test prefix', !presKey.startsWith(T.photoPrefix + '/'));
  ok('a test photo key is inside it',
     `${T.photoPrefix}/29-01-01-001/abc.jpg`.startsWith(T.photoPrefix + '/'));
}

console.log('\n4. The wipe guard rejects anything that is not the test namespace');
{
  // Mirrors assertTestNamespace in api/index.mjs. If that guard is weakened,
  // this drifts and the mismatch is the signal.
  const guard = (K) => K.id === TEST_ELECTION &&
    K.ephemeral === true &&
    K.cnt.includes('#TEST') &&
    K.upl.includes('#TEST') &&
    K.audit.includes('#TEST') &&
    K.totals.includes('#TEST') &&
    K.parties.includes('#TEST') &&
    K.photoPrefix === 'photos/test' &&
    K.pu('X').startsWith('PU#TEST#');

  ok('accepts the test namespace', guard(T));
  ok('rejects Osun', !guard(O));
  ok('rejects presidential', !guard(P));
  // A namespace that merely claims to be test must still fail the shape check.
  ok('rejects an impostor with the right id but real keys',
     !guard({ ...O, id: TEST_ELECTION, ephemeral: true }));
  ok('rejects a test-shaped namespace that is not marked ephemeral',
     !guard({ ...T, ephemeral: false }));
}

console.log('\n5. Test is never a default and never a real election');
{
  eq('the unnamed default is still presidential', electionOf(undefined), CURRENT_ELECTION);
  ok('test is not in the real-election list', !REAL_ELECTIONS.includes(TEST_ELECTION));
  ok('osun and presidential are', REAL_ELECTIONS.includes('osun') && REAL_ELECTIONS.includes('presidential'));
  ok('only the test election is ephemeral',
     ELECTIONS.test.ephemeral === true &&
     !ELECTIONS.osun.ephemeral && !ELECTIONS.presidential.ephemeral);
  ok('a real election is never ephemeral', !O.ephemeral && !P.ephemeral);
  ok('the test election is', T.ephemeral === true);
}

console.log('\n6. Test mode is reachable when explicitly named');
{
  eq('election=test resolves', electionOf('test'), 'test');
  eq('and is case-insensitive', electionOf('TEST'), 'test');
  eq('the test label says what it is', T.label, 'TEST MODE Results');
}

console.log(`\n${fail ? 'FAILURES: ' + fail : 'ALL PASSED'}  (${pass} checks)\n`);
process.exit(fail ? 1 : 0);
