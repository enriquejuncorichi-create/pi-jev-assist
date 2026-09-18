import test from 'node:test';
import assert from 'node:assert/strict';
import { splitDiff, readClaims, claimQuestions, coverageQuestions, verdict } from '../scripts/claim-check.js';

test('a diff splits per file and every path is recovered', () => {
  const raw = [
    'diff --git a/packages/jobs/src/a.ts b/packages/jobs/src/a.ts',
    '--- a/packages/jobs/src/a.ts',
    '+++ b/packages/jobs/src/a.ts',
    '@@ -1 +1 @@',
    '-old',
    '+new',
    'diff --git a/apps/sp/b.svelte b/apps/sp/b.svelte',
    '--- a/apps/sp/b.svelte',
    '+++ b/apps/sp/b.svelte',
    '@@ -1 +1 @@',
    '+x',
  ].join('\n');
  const files = splitDiff(raw);
  assert.deepEqual(files.map(f => f.path), ['packages/jobs/src/a.ts', 'apps/sp/b.svelte']);
  assert.ok(files[0]!.diff.includes('+new'));
});

test('claims ignore blanks and comments, keeping order', () => {
  assert.deepEqual(readClaims('# note\n\nfirst claim\n  second claim  \n\n# trailing'), ['first claim', 'second claim']);
});

test('an overstated flag demotes a tick instead of decorating it', () => {
  // Measured on PR #989: the single false claim this missed scored
  // implemented 0.84 WITH overstated 0.70. A tick with a warning underneath
  // reads as a pass, which is the false green this whole tool is against.
  assert.equal(verdict(1, 0.84, 0.72), 'verify-by-hand');
  assert.equal(verdict(1, 0.91, 0.1), 'implemented');
  assert.equal(verdict(1, 0.13, 0.1), 'absent');
  assert.equal(verdict(1, 0.5, 0.1), 'unclear');
});

test('abstention is reserved for claims a diff cannot settle, never for false ones', () => {
  // The original wording abstained whenever the change was absent, so every
  // FALSE claim came back "not settleable" — absence is an answer, not an
  // inability to judge. Both deliberately-false test claims hid behind that.
  assert.equal(verdict(0.2, 0.9, 0), 'not-settleable');
  assert.equal(verdict(1, undefined, 0), 'not-settleable');
  assert.equal(verdict(1, 0.05, 0), 'absent');
  const q = claimQuestions(['x']) as Record<string, {instructions: string}>;
  assert.match(q.assessable_0!.instructions, /ABSENT from the diff is still settleable/);
  assert.match(q.assessable_0!.instructions, /ONLY when settling it requires running/);
});

test('every claim gets three questions and every file one coverage question', () => {
  assert.equal(Object.keys(claimQuestions(['a', 'b'])).length, 6);
  assert.equal(Object.keys(coverageQuestions([{path: 'a.ts', diff: 'd'}])).length, 1);
});
