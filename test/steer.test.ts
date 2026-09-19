import test from 'node:test';
import assert from 'node:assert/strict';
import { MODE_HINT, attachSteer, modeHint, constraintLine, toolFingerprint, steerRequest } from '../src/steer.js';

test('Jev only picks a mode key; the hint is fixed in code', () => {
  assert.match(modeHint({ mode: { choice: 'implement', confidence: 0.9 } }), /run the tests/);
  assert.equal(modeHint({ mode: { choice: 'chat', confidence: 0.9 } }), '');
  assert.equal(modeHint({ mode: { choice: 'implement', confidence: 0.4 } }), '');
  assert.equal(modeHint({ mode: { choice: 'invented', confidence: 0.99 } }), '');
  assert.equal(MODE_HINT.investigate.includes('Do not edit'), true);
});

test('a hard constraint is echoed verbatim, never rewritten', () => {
  const task = 'Fix the test. Never edit src/generated.ts\nThanks';
  assert.match(constraintLine(task, { hard_constraint: { noul: 0.92 } }), /Never edit src\/generated/);
  assert.equal(constraintLine(task, { hard_constraint: { noul: 0.4 } }), '');
});

test('fingerprints collide only on the exact same read or bash', () => {
  assert.equal(toolFingerprint('read', { path: 'a.ts' }), 'read:a.ts');
  assert.equal(toolFingerprint('bash', { command: ' bun test ' }), 'bash:bun test');
  assert.notEqual(toolFingerprint('bash', { command: 'bun test' }), toolFingerprint('bash', { command: 'bun test -t foo' }));
  assert.equal(toolFingerprint('edit', { path: 'a.ts' }), undefined);
});

test('steer questions attach without dropping existing ones', () => {
  const out = attachSteer({ state: { x: 1 }, questions: { s0: { type: 'noul' } } });
  assert.equal((out.questions as { s0: unknown }).s0 != null, true);
  assert.equal((out.questions as { mode: unknown }).mode != null, true);
  assert.ok(steerRequest('who calls reviewAdvice').questions.mode);
});
