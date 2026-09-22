import test from 'node:test';
import assert from 'node:assert/strict';
import { CASES, SUITE_HASH, grade } from '../bench/routing-cases.js';

test('frozen routing oracles accept every reference answer', () => {
  assert.equal(CASES.length, 4);
  assert.match(SUITE_HASH, /^[a-f0-9]{64}$/);
  for (const item of CASES) assert.equal(grade(item.id, JSON.stringify(item.expected)).pass, true);
});

test('oracles reject empty answers, prose, extra keys and missing constraints', () => {
  for (const item of CASES) {
    assert.equal(grade(item.id, '{}').pass, false);
    assert.equal(grade(item.id, `Here is the answer: ${JSON.stringify(item.expected)}`).pass, false);
    assert.equal(grade(item.id, JSON.stringify({ ...item.expected, invented: true })).pass, false);
  }
  assert.equal(grade('curation-constraints-and-failure-v1', JSON.stringify({ keep: ['R1', 'R3', 'R6'], unresolved: ['R3'] })).pass, false);
});

test('oracles reject paid fallback and incomplete transitive reach', () => {
  assert.equal(grade('debug-exact-route-selection-v1', '{"patch":"A","selected":"api/m1","fallbackAllowed":true}').pass, false);
  assert.equal(grade('scout-transitive-callers-v1', JSON.stringify({ directCallers: ['basket.ts', 'report.ts'], transitiveCallers: ['basket.ts', 'report.ts'] })).pass, false);
  assert.throws(() => grade('not-a-case', '{}'), /Unknown benchmark/);
});
