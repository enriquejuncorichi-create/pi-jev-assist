import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GOLD, seed, execute, parseJev, matchGold, piMatchesGold } from '../src/tool-ab.js';

test('gold execution is deterministic and isolated', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tool-ab-'));
  try {
    seed(dir);
    for (const g of GOLD) {
      const out = execute(dir, g);
      assert.equal(out.ok, true, g.id);
      if (g.tool === 'count_lines') assert.equal(out.stdout, '3');
      if (g.tool === 'none') assert.equal(out.stdout, '');
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('parseJev only consumes args the chosen tool needs', () => {
  assert.deepEqual(parseJev({ tool: { choice: 'list_files' }, file: { choice: 'a.ts' } }), { tool: 'list_files' });
  assert.deepEqual(parseJev({ tool: { choice: 'count_lines' }, file: { choice: 'b.ts' } }), { tool: 'count_lines', file: 'b.ts' });
  assert.deepEqual(parseJev({ tool: { choice: 'run_test' }, suite: { choice: 'mul' } }), { tool: 'run_test', suite: 'mul' });
});

test('pi heuristic accepts equivalent bash, rejects weather fetches', () => {
  assert.equal(piMatchesGold(GOLD[0]!, ['wc -l a.ts']), true);
  assert.equal(piMatchesGold(GOLD[5]!, ['curl wttr.in/Lima']), false);
  assert.equal(piMatchesGold(GOLD[5]!, ['ls -la'], ['bash']), false, 'listing files is an over-call on a weather prompt');
  assert.equal(piMatchesGold(GOLD[1]!, [], ['read']), true, 'Pi read tool counts as read_file');
  assert.equal(piMatchesGold(GOLD[3]!, ['node --test add.test.js']), true);
});

test('a wrong tool never matches gold', () => {
  assert.equal(matchGold(GOLD[0]!, { tool: 'read_file', file: 'a.ts' }), false);
  assert.equal(matchGold(GOLD[0]!, { tool: 'count_lines', file: 'a.ts' }), true);
});
