import test from 'node:test';
import assert from 'node:assert/strict';
import { claimsFrom, claimQuestions, claimAdvice, buildClaimState, parseCallers, callerQuestions, MAX_CLAIMS, MAX_DIFF_BYTES } from '../src/autonomous.js';

test('claims are the assertions about the work, not questions or filler', () => {
  const claims = claimsFrom([
    'Done.',
    '- Added a guard to assertSchedulerTarget so a paused scheduler cannot be resumed with an arbitrary payload.',
    '- Updated the tests to cover the resume path and the pause path.',
    'Would you like me to open a pull request for this change as well?',
    'The weather is irrelevant and this sentence asserts nothing about any work at all.',
  ].join('\n'));
  assert.equal(claims.length, 2);
  assert.match(claims[0]!, /^Added a guard/);
  assert.ok(!claims.some(c => c.endsWith('?')), 'a question is not a claim');
});

test('a negative claim is never judged for support', () => {
  // Caught live: asked to assert things it had not done, an assistant instead
  // said so plainly, and the checker accused that honest disclaimer at 0.35 —
  // a negative claim is TRUE exactly when the diff lacks the thing.
  const claims = claimsFrom([
    'I changed add in calc.js to return the sum of its arguments.',
    'I did **not** add input validation, and I did not change other.js.',
    'I have not updated the documentation for this change yet.',
    'I did not touch the scheduler configuration at all.',
  ].join('\n'));
  assert.equal(claims.length, 1);
  assert.match(claims[0]!, /^I changed add/);
});

test('a guard described by what it PREVENTS is still a positive claim', () => {
  // "cannot" here describes the new behaviour, not a negation of the author's
  // action. A broader negation filter dropped this, losing exactly the
  // security-shaped claims most worth checking.
  const claims = claimsFrom([
    'Added a guard to assertSchedulerTarget so a paused scheduler cannot be resumed with an arbitrary payload.',
    'Updated the resume action so it can no longer accept an unvalidated template.',
  ].join('\n'));
  assert.equal(claims.length, 2);
});

test('claims are capped and short fragments ignored', () => {
  const many = Array.from({length: 30}, (_, i) => `- Added feature number ${i} to the system in a clearly stated way.`).join('\n');
  assert.equal(claimsFrom(many).length, MAX_CLAIMS);
  assert.deepEqual(claimsFrom('Fixed it.'), []);
});

test('a claim the diff more likely lacks than contains is reported', () => {
  // The boundary is measured, not chosen: in a live run the assistant claimed
  // input validation it never wrote, scoring 0.34, while its one true claim
  // scored 0.98. An earlier <= 0.3 cutoff reported nothing at all.
  const claims = ['true claim', 'false claim', 'unassessable'];
  const advice = claimAdvice({
    assessable_0: {noul: 1}, supported_0: {noul: 0.98},
    assessable_1: {noul: 1}, supported_1: {noul: 0.34},
    assessable_2: {noul: 0.1}, supported_2: {noul: 0.02},
  }, claims);
  assert.deepEqual(advice.unsupported.map(u => u.claim), ['false claim']);
  assert.deepEqual(advice.scores, [0.98, 0.34]);
  assert.equal(advice.checked, 2);
  assert.equal(advice.abstained, 1, 'an unassessable claim is not a finding');
});

test('an exactly-even score is not a finding', () => {
  // 0.5 is the audit failing to decide; accusing on it would be noise.
  const advice = claimAdvice({assessable_0: {noul: 1}, supported_0: {noul: 0.5}}, ['x']);
  assert.deepEqual(advice.unsupported, []);
});

test('a missing answer abstains rather than accusing', () => {
  const advice = claimAdvice({}, ['a']);
  assert.deepEqual(advice.unsupported, []);
  assert.equal(advice.abstained, 1);
});

test('the claim state carries the diff, bounded, and says what a diff cannot settle', () => {
  const state = buildClaimState(['x'], 'd'.repeat(MAX_DIFF_BYTES * 2)) as {diff: string; note: string};
  assert.ok(state.diff.length <= MAX_DIFF_BYTES + 120, 'diff is clipped to the budget');
  assert.match(state.note, /never that it works/);
  assert.equal(Object.keys(claimQuestions(['a', 'b'])).length, 4);
});

test('caller lines parse and workspace tallies are not mistaken for references', () => {
  const callers = parseCallers([
    '   ● doThing — 2 reference(s):',
    '         2 in apps/web',
    '         apps/web/a.ts:12:  doThing();',
    '         apps/web/b.ts:3:  doThing(1);',
    '   ● other — no references outside its own file',
    '         this line belongs to nothing',
  ].join('\n'));
  assert.equal(callers.length, 2);
  assert.deepEqual(callers.map(c => c.line), [12, 3]);
  assert.ok(callers.every(c => c.symbol === 'doThing'));
  assert.equal(Object.keys(callerQuestions(callers)).length, 2);
});
