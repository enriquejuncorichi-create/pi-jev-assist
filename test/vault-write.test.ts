import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePrepareWrite, vaultWriteAdvice, isVortexWriteTool } from '../src/vault-write.js';

const SAMPLE = JSON.stringify({
  preflight_id: 'pw_1',
  similar: [
    { noteId: 'abc', title: 'Lessons — skill/its-cli', score: 0.82, snippet: 'its-cli must not run on prod' },
    { noteId: 'def', title: 'Unrelated piano', score: 0.61, snippet: 'notes' },
  ],
  title_duplicates: [{ title: 'Lessons — skill/its-cli' }],
});

test('parses prepare_write JSON even when wrapped in prose', () => {
  const p = parsePrepareWrite(`here\n${SAMPLE}\n`);
  assert.equal(p?.similar[0]?.noteId, 'abc');
  assert.equal(p?.titleDuplicates, 1);
  assert.equal(p?.preflightId, 'pw_1');
});

test('advice is a table keyed by Jev choice', () => {
  const similar = [{ noteId: 'abc', title: 'Lessons — skill/its-cli', score: 0.82 }];
  assert.match(vaultWriteAdvice({ decision: { choice: 'UPDATE', confidence: 0.9 } }, similar), /update_note note abc/);
  assert.match(vaultWriteAdvice({ decision: { choice: 'NOOP', confidence: 0.9 } }, similar), /NOOP/);
  assert.equal(vaultWriteAdvice({ decision: { choice: 'UPDATE', confidence: 0.4 } }, similar), '');
});

test('only vortex vault tools are treated as write surfaces', () => {
  assert.equal(isVortexWriteTool('vortex_vortex_vault'), true);
  assert.equal(isVortexWriteTool('bash'), false);
});
