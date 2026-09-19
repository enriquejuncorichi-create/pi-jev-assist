import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHits, hitRequest, selectHits, renderHits, looksLikeSearch } from '../src/hits.js';

const DUMP = [
  'src/decisions.ts:172:export function reviewAdvice(answers: Record<string, unknown>',
  'index.ts:313:    try { advice=reviewAdvice(result.answers',
  'test/decisions.test.ts:49: assert.equal(reviewAdvice(answers,[],true,false,true).flags.length,0);',
  'scripts/rank-files.ts:3:/** Unique files from rg reviewAdvice',
  'src/decisions.ts:180:  const flags = [];',
].join('\n');

test('parseHits keeps the first line per path', () => {
  const hits = parseHits(DUMP);
  assert.deepEqual(hits.map(h => h.path), ['src/decisions.ts', 'index.ts', 'test/decisions.test.ts', 'scripts/rank-files.ts']);
  assert.match(hits[0]!.excerpt, /function reviewAdvice/);
});

test('low confidence keeps every file', () => {
  const hits = parseHits(DUMP);
  const picked = selectHits(hits, { read: { choice: 'f3', confidence: 0.4 } });
  assert.equal(picked.dropped.length, 0);
});

test('a confident choice keeps implementation then caller, drops the rest', () => {
  const hits = parseHits(DUMP);
  const picked = selectHits(hits, {
    read: { choice: 'f0', confidence: 0.92 },
    read2: { choice: 'f1', confidence: 0.8 },
  });
  assert.deepEqual(picked.keep.map(h => h.path), ['src/decisions.ts', 'index.ts']);
  const out = renderHits(DUMP, picked.keep, picked.dropped);
  assert.match(out, /function reviewAdvice/);
  assert.match(out, /dropped 2 file/);
  assert.ok(!out.includes('rank-files.ts:3'));
});

test('the request is a choice over path+excerpt, not a noul per path', () => {
  const req = hitRequest('who calls reviewAdvice', parseHits(DUMP));
  const hits = (req.state as { hits: Array<{ excerpt: string }> }).hits;
  assert.match(hits[0]!.excerpt, /reviewAdvice/);
  const q = req.questions as { read: { type: string; criteria: Record<string, string> } };
  assert.equal(q.read.type, 'choice');
  assert.match(q.read.criteria.f0!, /decisions\.ts/);
});

test('only rg/grep look like a search', () => {
  assert.equal(looksLikeSearch('grep', {}), true);
  assert.equal(looksLikeSearch('bash', { command: 'rg -n reviewAdvice' }), true);
  assert.equal(looksLikeSearch('bash', { command: 'bun test' }), false);
});
