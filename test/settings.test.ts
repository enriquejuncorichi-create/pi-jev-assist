import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULTS, loadConfig, saveConfig, formatStatus, FEATURES } from '../src/settings.js';
import { withCache } from '../src/cache.js';
import { reconstruct } from '../src/preedit.js';
import { injectionWarning } from '../src/injection.js';
import type { AssistService } from '../src/service.js';

test('config round-trip keeps feature flags', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
  const path = join(dir, 'config.json');
  saveConfig({ ...DEFAULTS, livePrune: false, pin: 'fix auth' }, path);
  const loaded = loadConfig(path);
  assert.equal(loaded.livePrune, false);
  assert.equal(loaded.pin, 'fix auth');
  assert.equal(loaded.hitIndex, true);
  assert.match(formatStatus(loaded, { requests: 1 }), /○ livePrune/);
  assert.ok(FEATURES.includes('review'));
});

test('cache returns the first success and coalesces inflight', async () => {
  let n = 0;
  const inner = {
    usage: () => ({ requests: n, inputTokens: 0, outputTokens: 0, failures: 0 }),
    beginRun: () => {},
    evaluate: async () => { n++; return { ok: true as const, answers: { a: n }, model: 'jev', elapsedMs: 1, usage: { input_tokens: 1, output_tokens: 0 } }; },
  } as AssistService;
  const s = withCache(inner, () => 60_000);
  const req = { state: { x: 1 }, questions: { a: { type: 'noul' } } };
  const a = await s.evaluate(req);
  const b = await s.evaluate(req);
  assert.equal(n, 1);
  assert.deepEqual(a, b);
});

test('reconstruct applies sequential unique edits', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ed-'));
  const file = join(dir, 'a.ts');
  writeFileSync(file, 'export const a = 1;\nexport const b = 2;\n');
  const out = reconstruct(file, dir, { edits: [{ oldText: 'a = 1', newText: 'a = 3' }] });
  assert.match(out!, /a = 3/);
  assert.match(out!, /b = 2/);
});

test('injection warning only at high probability', () => {
  assert.equal(injectionWarning({ injected: { noul: 0.4 } }), '');
  assert.match(injectionWarning({ injected: { noul: 0.91 } }), /instructions for an AI/);
});
