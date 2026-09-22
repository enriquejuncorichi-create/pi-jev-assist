import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseWorkerPolicy, taskContractFromAnswers } from '../src/worker-task-contract.js';
import { loadConfig, saveConfig } from '../src/settings.js';

const answers = { taskFamily: { choice: 'source-impact-location', confidence: 0.99 }, needsVision: { noul: 0.01 }, needsReasoning: { noul: 0.99 } };
test('task contract requires confident role-matching family and complete capability judgements', () => {
  assert.deepEqual(taskContractFromAnswers(answers, 'scout'), { family: 'source-impact-location', requiredCapabilities: ['reasoning'] });
  assert.throws(() => taskContractFromAnswers(answers, 'implement'), /task-family/);
  assert.throws(() => taskContractFromAnswers({ ...answers, taskFamily: { choice: 'source-impact-location', confidence: 0.5 } }, 'scout'), /task-family/);
  assert.throws(() => taskContractFromAnswers({ ...answers, needsVision: undefined }, 'scout'), /capabilities/);
  assert.throws(() => taskContractFromAnswers({ ...answers, needsReasoning: { noul: 0.5 } }, 'scout'), /capabilities/);
  assert.deepEqual(taskContractFromAnswers({ ...answers, taskFamily: { choice: 'uncovered', confidence: 0.99 } }, 'implement').family, 'uncovered');
});
test('policy parser requires explicit valid modes and nonempty unique exact allowlists', () => {
  for (const mode of ['automatic', 'prefer-other-provider']) assert.deepEqual(parseWorkerPolicy({ mode }), { mode });
  assert.deepEqual(parseWorkerPolicy({ mode: 'allowlist', routes: ['xai/grok-fixture'] }), { mode: 'allowlist', routes: ['xai/grok-fixture'] });
  for (const value of [null, {}, { mode: 'automatic', routes: [] }, { mode: 'allowlist', routes: [] }, { mode: 'allowlist', routes: ['grok'] }, { mode: 'allowlist', routes: ['xai/grok', 'xai/grok'] }]) assert.throws(() => parseWorkerPolicy(value));
});
test('policy persists without changing unrelated settings and malformed allowlists remain refusing', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'jev-policy-')), 'config.json');
  writeFileSync(path, JSON.stringify({ pin: 'Retain this', workerRouting: true, workerPolicy: { mode: 'allowlist', routes: [] } }));
  const invalid = loadConfig(path);
  assert.equal(invalid.workerRouting, false);
  assert.equal(invalid.pin, 'Retain this');
  assert.throws(() => parseWorkerPolicy(invalid.workerPolicy));
  saveConfig({ ...invalid, workerPolicy: { mode: 'prefer-other-provider' } }, path);
  assert.deepEqual(loadConfig(path).workerPolicy, { mode: 'prefer-other-provider' });
  assert.equal(loadConfig(path).pin, 'Retain this');
  writeFileSync(path, JSON.stringify({ workerRouting: true, workerPolicy: null }));
  assert.equal(loadConfig(path).workerRouting, false);
  assert.throws(() => parseWorkerPolicy(loadConfig(path).workerPolicy));
  writeFileSync(path, JSON.stringify({ workerRouting: false }));
  assert.deepEqual(loadConfig(path).workerPolicy, { mode: 'automatic' });
  assert.equal(loadConfig(path).workerRoutingMode, 'rubric');
  writeFileSync(path, JSON.stringify({ workerRouting: true, workerPolicy: { mode: 'automatic' } }));
  assert.equal(loadConfig(path).workerRoutingMode, 'qualified', 'existing enabled configs retain qualified selection');
  writeFileSync(path, JSON.stringify({ workerRouting: true, workerRoutingMode: 'rubric', workerRouteRubrics: [{ route: { provider: 'xai', model: 'grok' }, role: 'scout', use_when: 'Locate', not_for: 'Code edits', boundary: 'Read only' }] }));
  assert.equal(loadConfig(path).workerRouteRubrics.length, 1);
  assert.equal(loadConfig(path).workerRouting, true);
  writeFileSync(path, JSON.stringify({ workerRouting: true, workerRoutingMode: 'unknown' }));
  assert.equal(loadConfig(path).workerRouting, false);
  writeFileSync(path, JSON.stringify({ workerRouting: true, workerRoutingMode: 'rubric', workerRouteRubrics: [{}] }));
  assert.equal(loadConfig(path).workerRouting, false);
});
