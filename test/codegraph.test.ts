import test from 'node:test';
import assert from 'node:assert/strict';
import { CodeGraph } from '../src/codegraph.js';
import { changedSymbols } from '../src/autonomous.js';

test('only symbols whose DEFINITION the diff touched are traced', () => {
  const diff = [
    'diff --git a/src/a.ts b/src/a.ts',
    '+++ b/src/a.ts',
    '@@',
    '+export async function assertThing(a: string) {',
    '+  const helper = 1;',
    '+  return callSomethingElse(helper);',
    '+}',
    '+export interface ThingOptions { x: number }',
    '-export function removedOne() {}',
  ].join('\n');
  const names = changedSymbols(diff);
  assert.ok(names.includes('assertThing'));
  assert.ok(names.includes('ThingOptions'));
  // A symbol merely CALLED on a changed line has not had its own contract moved.
  assert.ok(!names.includes('callSomethingElse'));
  // A removed line is not an added definition.
  assert.ok(!names.includes('removedOne'));
});

test('a missing vortexd is reported, never mistaken for "no callers"', async () => {
  // The whole point of preferring the graph is that it refuses rather than
  // returning an empty list. A transport failure must surface the same way.
  const graph = new CodeGraph('definitely-not-a-real-binary-xyz');
  await assert.rejects(() => graph.blastRadius('x::y', '/tmp'), /unavailable|ENOENT|spawn/i);
  assert.equal(await graph.watch('/tmp'), false, 'watch is best-effort and never throws');
  graph.dispose();
});

test('a broken transport is not retried on every run', async () => {
  const graph = new CodeGraph('definitely-not-a-real-binary-xyz');
  await assert.rejects(() => graph.blastRadius('x::y', '/tmp'));
  const started = Date.now();
  await assert.rejects(() => graph.blastRadius('x::y', '/tmp'), /unavailable/);
  // Second call short-circuits rather than paying for another failed spawn.
  assert.ok(Date.now() - started < 500);
  graph.dispose();
});
