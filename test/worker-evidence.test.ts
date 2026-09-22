import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { BUDGET, BENCHMARK_VERSION, SUITE_HASH_ACCEPTED, CASES_ACCEPTED, digest, referencePrefix, schedule } from '../bench/accepted-result-suite.js';
import { RUN_CONTRACT, emptyUsage, totalUsage, type Observation, type CallEvidence } from '../bench/accepted-result-protocol.js';
import { EVIDENCE_BYTE_LIMIT, validateWorkerEvidence } from '../src/worker-evidence.js';
import { importQualification, loadQualifications, loadRoutingQualifications, parseTrustedQualification, qualificationInventory, saveQualifications } from '../src/worker-qualifications.js';
import { TASK_FAMILIES, type TaskFamily } from '../src/worker-task-contract.js';
import { prepareImportBundle } from '../bench/prepare-import-bundle.js';

/** Deterministic synthetic evidence for parser tests only; no live qualification claim. */
export function syntheticRun() {
  const baseline = 'openai-codex/baseline', routes = ['openai-codex/fast', baseline];
  const seed = 'synthetic-parser-fixture', repeats = 2;
  const planned = schedule(routes, baseline, repeats, seed);
  const sourceFingerprints = { 'synthetic-host.ts': digest('test fixture, not live evidence') };
  const rows: Observation[] = planned.map((key, index): Observation => {
    const item = CASES_ACCEPTED.find(candidate => candidate.id === key.caseId)!;
    const artefacts: Record<string, string> = {
      scout: JSON.stringify({ direct: ['preview.mjs', 'session.mjs'], transitive: ['controller.mjs', 'preview.mjs', 'session.mjs'] }),
      research: JSON.stringify({ answer: 'path-dependent', sources: ['S2', 'S4'], unknowns: ['account-entitlement', 'current-price'] }),
      curate: JSON.stringify({ keep: ['R1', 'R3', 'R4', 'R6'], unresolved: ['R3'] }),
    };
    const calls: CallEvidence[] = (['initial', 'review'] as const).map((kind, callIndex) => {
      const route = kind === 'review' ? baseline : key.route;
      const usage = { ...emptyUsage(), input: 10, output: 5, cacheRead: 2, catalogueListPriceEquivalentUsd: 0.01 };
      return { kind, route, access: kind === 'review' || key.role !== 'implement' ? 'read-only' : 'write',
        startedAt: '2026-01-01T00:00:00.000Z', elapsedMs: 10, maxTurns: kind === 'review' ? BUDGET.reviewMaxTurns : BUDGET.maxTurns,
        timeoutMs: BUDGET.callTimeoutMs, status: 'completed', sessionId: `synthetic-${index}-${callIndex}`,
        promptFingerprint: digest('synthetic prompt'), output: kind === 'review' ? '{"approved":true,"reason":"synthetic fixture"}' : artefacts[key.role] ?? 'Synthetic implementation fixture',
        approval: kind === 'review' ? true : null, usage, messages: [{ route, stopReason: 'stop', usage: { ...usage }, error: null }], error: null };
    });
    const elapsedMs = key.route === baseline ? 200 : 100;
    return { key, baseline, suiteHash: SUITE_HASH_ACCEPTED, benchmarkVersion: BENCHMARK_VERSION, status: 'completed',
      startedAt: '2026-01-01T00:00:00.000Z', elapsedMs, workerOnlyPassed: true, qualityPassed: true, independentApproved: true,
      acceptedMs: elapsedMs, calls, checks: [{ publicPassed: true, hiddenPassed: true, scopePassed: true, evidence: 'synthetic oracle' }],
      scope: { paths: key.role === 'implement' ? ['solution.mjs'] : [], hashes: key.role === 'implement' ? { 'solution.mjs': digest('synthetic fix') } : {}, diff: '', parentUnchanged: true, passed: true },
      contextFingerprint: digest(JSON.stringify({ ...item.files, 'ACCEPTANCE.md': item.spec, ...(item.publicTest ? { 'public.test.mjs': item.publicTest } : {}) })), prefixFingerprint: digest(referencePrefix(key.condition, key.pairId)), fixtureRoot: '/synthetic/fixture', error: null, total: totalUsage(calls) };
  });
  return { ...RUN_CONTRACT, baseline, routes, seed, repeats, planned, rows, status: 'completed', error: null,
    startedAt: '2026-01-01T00:00:00.000Z', elapsedMs: 100_000, sourceFingerprints, implementationHash: digest(JSON.stringify(sourceFingerprints)),
    profiles: [{ medianAcceptedMs: -999, qualified: false }], consumptionEnvelope: { synthetic: true } };
}
export const syntheticEvidence = () => JSON.stringify(syntheticRun());
export function syntheticProfile(evidence = syntheticEvidence()) {
  return { schemaVersion: 1, benchmarkVersion: BENCHMARK_VERSION, route: { provider: 'openai-codex', model: 'fast' }, baseline: { provider: 'openai-codex', model: 'baseline' },
    roles: ['scout'], evidenceRef: 'evidence.txt', evidenceHash: createHash('sha256').update(evidence).digest('hex'), suiteHash: SUITE_HASH_ACCEPTED,
    expiresAt: Date.now() + 60_000, qualityPassed: true, endToEnd: true, medianAcceptedMs: 100, baselineMedianAcceptedMs: 200, acceptedSamples: 4, reviewIncluded: true, repairIncluded: true };
}
const validate = (run: unknown) => validateWorkerEvidence(Buffer.from(JSON.stringify(run)), 'openai-codex/fast', 'scout');
test('derive paired metrics from complete schedule, ignoring profile assertions and optional metadata', () => {
  const run = syntheticRun();
  run.rows[0]!.calls[0]!.effectiveTransport = 'sse';
  assert.deepEqual(validate(run), { benchmarkVersion: BENCHMARK_VERSION, suiteHash: SUITE_HASH_ACCEPTED, baseline: run.baseline, acceptedSamples: 4, medianAcceptedMs: 100, baselineMedianAcceptedMs: 200,
    taskEvidence: [{ family: 'source-impact-location', acceptedSamples: 4, medianAcceptedMs: 100, baselineMedianAcceptedMs: 200 }] });
});
test('family metrics use only mapped cases, selected roles and exact paired routes', () => {
  const run = syntheticRun();
  const latencies: Record<TaskFamily, [number, number]> = {
    'session-state-preservation': [100, 200], 'exact-match-filtering': [300, 800],
    'failure-state-handling': [500, 400], 'source-impact-location': [700, 1000],
    'provided-source-comparison': [900, 600], 'failure-context-curation': [1100, 1200],
  };
  for (const row of run.rows) {
    const family = (Object.keys(TASK_FAMILIES) as TaskFamily[]).find(family => TASK_FAMILIES[family].caseId === row.key.caseId)!;
    const base = latencies[family][row.key.route === run.baseline ? 1 : 0];
    row.acceptedMs = row.elapsedMs = base + row.key.repeat * 20 + (row.key.condition === 'mutated' ? 8 : 0);
  }
  const bytes = Buffer.from(JSON.stringify(run));
  for (const role of ['implement', 'scout', 'research', 'curate'] as const) {
    const metrics = validateWorkerEvidence(bytes, 'openai-codex/fast', role);
    const expected = (Object.keys(TASK_FAMILIES) as TaskFamily[]).filter(family => TASK_FAMILIES[family].role === role).map(family => ({
      family, acceptedSamples: 4, medianAcceptedMs: latencies[family][0] + 14, baselineMedianAcceptedMs: latencies[family][1] + 14,
    }));
    assert.deepEqual(metrics.taskEvidence, expected);
    assert.equal(metrics.acceptedSamples, role === 'implement' ? 12 : 4);
    if (role === 'implement') {
      assert.equal(metrics.medianAcceptedMs, 314);
      assert.equal(metrics.baselineMedianAcceptedMs, 414);
    }
    const baseline = validateWorkerEvidence(bytes, run.baseline, role);
    assert.deepEqual(baseline.taskEvidence, expected.map(item => ({ ...item, medianAcceptedMs: item.baselineMedianAcceptedMs })));
  }
  assert.throws(() => validateWorkerEvidence(bytes, 'xai/absent', 'implement'), /selected route absent/);
});
test('supported repair includes initial failure, both independent reviews and all usage', () => {
  const run = syntheticRun(), row = run.rows.find(candidate => candidate.key.role === 'implement')!;
  row.checks.unshift({ publicPassed: false, hiddenPassed: false, scopePassed: true, evidence: 'synthetic failed first check' });
  row.workerOnlyPassed = false;
  row.calls.push({ ...structuredClone(row.calls[0]!), kind: 'repair', sessionId: 'repair' }, { ...structuredClone(row.calls[1]!), sessionId: 'second-review' });
  row.total = totalUsage(row.calls);
  assert.doesNotThrow(() => validate(run));
});
test('fail closed on arbitrary, incomplete, duplicate, failed baseline and inconsistent evidence', () => {
  assert.throws(() => validate({}));
  assert.throws(() => validateWorkerEvidence(Buffer.from('arbitrary bytes'), 'openai-codex/fast', 'scout'));
  const mutations: Array<(run: ReturnType<typeof syntheticRun>) => void> = [
    run => { run.status = 'incomplete'; }, run => { run.rows.pop(); }, run => { run.rows[1] = structuredClone(run.rows[0]!); },
    run => { run.planned.pop(); }, run => { run.rows.find(row => row.key.route === run.baseline)!.qualityPassed = false; },
    run => { run.rows[0]!.calls[0]!.route = run.baseline + '-foreign'; },
    run => { run.rows[0]!.calls[1]!.access = 'write'; }, run => { run.rows[0]!.calls[0]!.kind = 'repair'; },
    run => { run.rows[0]!.calls[0]!.messages[0]!.usage.input++; }, run => { run.rows[0]!.total.input++; },
    run => { run.rows[0]!.acceptedMs = 1; }, run => { run.rows[0]!.elapsedMs = Infinity; },
    run => { run.rows[0]!.calls[0]!.usage.output = -1; }, run => { run.rows[0]!.calls[1]!.approval = false; },
    run => { run.rows[0]!.checks[0]!.hiddenPassed = false; }, run => { run.rows[0]!.scope!.parentUnchanged = false; },
    run => { run.rows[0]!.scope!.paths.push('outside.txt'); }, run => { run.rows[0]!.suiteHash = 'a'.repeat(64); },
  ];
  for (const mutate of mutations) { const run = syntheticRun(); mutate(run); assert.throws(() => validate(run), mutate.toString()); }
});
test('offline converter to import roundtrip; explicit expiry, exact selection and bounded evidence', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jev-offline-'))), evidencePath = join(dir, 'run.json');
  writeFileSync(evidencePath, syntheticEvidence());
  const options = { evidencePath, outputDirectory: join(dir, 'bundle'), route: 'openai-codex/fast', role: 'scout' as const, expiresAt: Date.now() + 60_000 };
  const { profilePath } = prepareImportBundle(options);
  const imported = importQualification(profilePath);
  assert.equal(imported.acceptedSamples, 4);
  assert.equal(Object.hasOwn(imported, 'taskEvidence'), false);
  const store = join(dir, 'store.json');
  assert.equal(existsSync(store), false);
  saveQualifications([imported], store);
  assert.deepEqual(loadQualifications(store), [imported]);
  assert.deepEqual(qualificationInventory(store), [imported]);
  const taskEvidence = [{ family: 'source-impact-location', acceptedSamples: 4, medianAcceptedMs: 100, baselineMedianAcceptedMs: 200 }];
  const runtime = loadRoutingQualifications(store);
  assert.deepEqual(runtime, [{ ...imported, taskEvidence }]);
  assert.throws(() => parseTrustedQualification(runtime[0]), /unsupported qualification evidence/);
  assert.throws(() => parseTrustedQualification({ ...imported, taskEvidence: [] }), /unsupported qualification evidence/);
  runtime[0]!.taskEvidence![0]!.acceptedSamples = 999;
  assert.deepEqual(loadRoutingQualifications(store), [{ ...imported, taskEvidence }]);
  assert.deepEqual(loadQualifications(store), [imported]);
  assert.throws(() => prepareImportBundle(options));
  for (const change of [{ expiresAt: 1 }, { route: 'fast' }, { route: 'xai/absent' }]) {
    assert.throws(() => prepareImportBundle({ ...options, outputDirectory: join(dir, 'invalid'), ...change }));
    assert.equal(existsSync(join(dir, 'invalid')), false);
  }
  writeFileSync(evidencePath, Buffer.alloc(EVIDENCE_BYTE_LIMIT + 1));
  assert.throws(() => prepareImportBundle({ ...options, outputDirectory: join(dir, 'oversized') }), /bound/);
  assert.equal(existsSync(join(dir, 'oversized')), false);
});
test('tampered metrics and hash-matched arbitrary files fail import and every reload', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jev-tamper-'))), file = join(dir, 'profile.json'), store = join(dir, 'store.json');
  const evidence = syntheticEvidence();
  writeFileSync(join(dir, 'evidence.txt'), evidence);
  for (const change of [{ acceptedSamples: 99 }, { medianAcceptedMs: 1 }, { baselineMedianAcceptedMs: 1 }, { suiteHash: 'b'.repeat(64) }]) {
    writeFileSync(file, JSON.stringify({ ...syntheticProfile(evidence), ...change }));
    assert.throws(() => importQualification(file), /metrics/);
  }
  writeFileSync(file, JSON.stringify(syntheticProfile(evidence)));
  const profile = importQualification(file);
  saveQualifications([{ ...profile, medianAcceptedMs: 1 }], store);
  assert.deepEqual(loadQualifications(store), []);
  assert.deepEqual(loadRoutingQualifications(store), []);
  saveQualifications([profile], store);
  assert.equal(loadRoutingQualifications(store).length, 1);
  writeFileSync(join(dir, 'evidence.txt'), evidence + '\n');
  assert.deepEqual(loadRoutingQualifications(store), []);
  assert.deepEqual(qualificationInventory(store), [profile]);
  const junk = 'hash matched but unsupported';
  writeFileSync(join(dir, 'evidence.txt'), junk);
  writeFileSync(file, JSON.stringify(syntheticProfile(junk)));
  assert.throws(() => importQualification(file));
  saveQualifications([{ ...profile, evidenceHash: syntheticProfile(junk).evidenceHash }], store);
  assert.deepEqual(loadQualifications(store), []);
  assert.deepEqual(loadRoutingQualifications(store), []);
});
