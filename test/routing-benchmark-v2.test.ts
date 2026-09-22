import test from 'node:test';
import assert from 'node:assert/strict';
import { grade, SUITE_HASH } from '../bench/routing-cases.js';
import { CASES_V2, gradeV2, SUITE_HASH_V2 } from '../bench/routing-cases-v2.js';

test('v2 reference answers pass and rubric is independently versioned', () => {
  assert.notEqual(SUITE_HASH_V2, SUITE_HASH);
  for (const item of CASES_V2) assert.equal(gradeV2(item.id, JSON.stringify(item.expected)).pass, true, item.id);
});

test('research requires claim support without demanding redundant sources', () => {
  const answer = { answer: 'path-dependent', supportingSources: ['S2', 'S4'], unknowns: ['account-entitlement', 'current-price'] };
  const id = 'research-conflicting-evidence-v2';
  assert.equal(gradeV2(id, JSON.stringify(answer)).pass, true);
  assert.equal(grade('research-conflicting-evidence-v1', JSON.stringify(answer)).pass, false);
  assert.equal(gradeV2(id, JSON.stringify({ ...answer, supportingSources: ['S1', 'S2', 'S4'] })).pass, true);
  for (const supportingSources of [['S1', 'S2'], ['S4'], ['S2', 'S3', 'S4'], ['S2', 'S2', 'S4'], ['S4', 'S2'], ['S2 official-worker-guide', 'S4']]) {
    assert.equal(gradeV2(id, JSON.stringify({ ...answer, supportingSources })).pass, false);
  }
  assert.equal(gradeV2(id, JSON.stringify({ ...answer, unknowns: [] })).pass, false);
  assert.equal(gradeV2(id, JSON.stringify({ ...answer, extra: 'value' })).pass, false);
});
