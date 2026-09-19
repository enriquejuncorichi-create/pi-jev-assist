import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FAILURE_ADVICE, looksFailed, failureAdvice } from '../src/failure.js';
import { existingHits, parseHits } from '../src/hits.js';

test('failure advice is a table, not Jev prose', () => {
  assert.match(FAILURE_ADVICE.code_bug, /compiler or tests/);
  assert.equal(failureAdvice({ kind: { choice: 'code_bug', confidence: 0.9 } }), FAILURE_ADVICE.code_bug);
  assert.equal(failureAdvice({ kind: { choice: 'code_bug', confidence: 0.4 } }), '');
  assert.equal(failureAdvice({ kind: { choice: 'invented', confidence: 0.99 } }), '');
});

test('only modest bash failures are classified', () => {
  assert.equal(looksFailed('bash', true, 'EACCES'), true);
  assert.equal(looksFailed('read', true, 'EACCES'), false);
  assert.equal(looksFailed('bash', false, 'ok'), false);
  assert.equal(looksFailed('bash', false, 'x'.repeat(9000)), false);
});

test('search hits that are not files never reach Jev', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hits-'));
  writeFileSync(join(dir, 'real.ts'), 'export const a = 1\n');
  const hits = parseHits(`${dir}/real.ts:1:export const a = 1\nmissing.ts:2:nope\n-----:3:sep`);
  const kept = existingHits(hits, dir);
  assert.equal(kept.length, 1);
  assert.match(kept[0]!.path, /real\.ts/);
});
