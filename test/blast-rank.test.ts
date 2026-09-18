import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBlastRadius, rankQuestions } from '../scripts/blast-rank.js';

// Verbatim shape emitted by ccd-platform's scripts/blast-radius.sh.
const OUTPUT = [
  "▸ blast radius of 'assertDeclaredTemplate' (declared in packages/jobs/src/scheduler-status.ts) — BEFORE any change",
  '  Mechanical enumeration. Every caller listed is one you must check.',
  '',
  '══ packages/jobs/src/scheduler-status.ts',
  '   ● assertDeclaredTemplate — 3 reference(s):',
  '         2 in packages/jobs',
  '          1 in apps/sp',
  '         packages/jobs/src/scheduler-target.test.ts:56:  assertDeclaredTemplate,',
  '         packages/jobs/src/scheduler-target.test.ts:135:      assertDeclaredTemplate(',
  '         apps/sp/src/routes/admin/scheduled-jobs/+page.server.ts:247:\t\t\tawait assertDeclaredTemplate(queueName, jobName, getRedis(), templateData);',
  '   ● assertInspectableQueue — no references outside its own file',
  '       Either genuinely internal, or reached dynamically (string key,',
  '',
].join('\n');

test('parses every enumerated reference and attributes it to its symbol', () => {
  const { refs, unparsed } = parseBlastRadius(OUTPUT);
  assert.equal(refs.length, 3);
  assert.equal(unparsed, 0);
  assert.deepEqual(refs.map(r => r.symbol), Array(3).fill('assertDeclaredTemplate'));
  assert.deepEqual(refs.map(r => r.line), [56, 135, 247]);
  assert.equal(refs[2]!.path, 'apps/sp/src/routes/admin/scheduled-jobs/+page.server.ts');
  assert.equal(refs[2]!.text, 'await assertDeclaredTemplate(queueName, jobName, getRedis(), templateData);');
});

test('a no-references symbol contributes nothing and does not capture later lines', () => {
  // Attributing a later hit to the wrong symbol would rank it against the wrong
  // change; a silently mis-parsed enumeration is the same false all-clear the
  // enumerator itself refuses.
  const { refs } = parseBlastRadius(OUTPUT);
  assert.ok(!refs.some(r => r.symbol === 'assertInspectableQueue'));
});

test('summary and prose lines are never mistaken for references', () => {
  const { refs, unparsed } = parseBlastRadius([
    '   ● sym — 1 reference(s):',
    '         1 in apps/web',
    '         apps/web/a.ts:3:call();',
    '',
    '──────────────────────────────────────────────',
    '4 reference(s) across 1 changed file(s).',
  ].join('\n'));
  assert.equal(refs.length, 1);
  assert.equal(unparsed, 0);
});

test('every call site gets an abstention gate before it gets a score', () => {
  const refs = [
    { symbol: 's', path: 'a.ts', line: 1, text: 'x' },
    { symbol: 's', path: 'b.ts', line: 2, text: 'y' },
  ];
  const q = rankQuestions(refs, 'change the signature') as Record<string, {type: string; criteria?: unknown}>;
  assert.equal(q.assessable_0!.type, 'noul');
  assert.equal(q.risk_0!.type, 'score');
  assert.equal(q.assessable_1!.type, 'noul');
  assert.equal(Object.keys(q).length, 4);
  // Four levels, and the lowest must be "not affected" rather than "safe", so a
  // low score never reads as a clearance.
  assert.equal((q.risk_0!.criteria as string[]).length, 4);
  assert.match((q.risk_0!.criteria as string[])[0]!, /Not affected/);
});

test('batching stays under the 32-question ceiling', () => {
  const refs = Array.from({ length: 15 }, (_, i) => ({ symbol: 's', path: `f${i}.ts`, line: i, text: 'x' }));
  assert.ok(Object.keys(rankQuestions(refs, 'c')).length <= 32);
});
