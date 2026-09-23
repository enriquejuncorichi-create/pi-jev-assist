import { BENCHMARK_VERSION, BUDGET, CASES_ACCEPTED, SUITE_HASH_ACCEPTED, digest, gradeArtifact, parseApproval, referencePrefix, schedule, type Role } from '../bench/accepted-result-suite.js';
import { RUN_CONTRACT } from '../bench/accepted-result-protocol.js';
import { parseRoute, routeKey, WORKER_ROLES } from './worker-routing.js';
import { TASK_FAMILIES, type TaskEvidence, type TaskFamily } from './worker-task-contract.js';

export const EVIDENCE_BYTE_LIMIT = 8 * 1024 * 1024;
type ObjectValue = Record<string, unknown>;
function requireEvidence(ok: unknown, detail: string): asserts ok {
  if (!ok) throw new Error(`Invalid benchmark evidence: ${detail}`);
}
function object(value: unknown): ObjectValue {
  requireEvidence(value !== null && typeof value === 'object' && !Array.isArray(value), 'object required');
  return value as ObjectValue;
}
function array(value: unknown): unknown[] { requireEvidence(Array.isArray(value), 'array required'); return value; }
function finite(value: unknown, positive = false): number {
  requireEvidence(typeof value === 'number' && Number.isFinite(value) && (positive ? value > 0 : value >= 0), 'finite non-negative measurement required');
  return value;
}
function hash(value: unknown): void { requireEvidence(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), 'SHA256 required'); }
function timestamp(value: unknown): void { requireEvidence(typeof value === 'string' && Number.isFinite(Date.parse(value)), 'timestamp required'); }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => `${JSON.stringify(key)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}
function equal(a: unknown, b: unknown, detail: string): void { requireEvidence(canonical(a) === canonical(b), detail); }
export function exactEvidenceRoute(value: unknown): string {
  requireEvidence(typeof value === 'string', 'exact route required');
  const slash = value.indexOf('/');
  const route = parseRoute({ provider: value.slice(0, slash), model: value.slice(slash + 1) });
  requireEvidence(slash > 0 && route && ['openai-codex', 'xai'].includes(route.provider), 'native exact route required');
  return routeKey(route);
}
const usageKeys = ['input', 'output', 'cacheRead', 'cacheWrite', 'catalogueListPriceEquivalentUsd'] as const;
function usage(value: unknown): number[] {
  const u = object(value);
  requireEvidence(u.actualChargeUsd === null, 'actual charge must remain unknown');
  return usageKeys.map(key => {
    const n = finite(u[key]);
    requireEvidence(key === 'catalogueListPriceEquivalentUsd' || Number.isSafeInteger(n), 'integer token usage required');
    return n;
  });
}
function reconcile(value: unknown, parts: number[][]): number[] {
  const actual = usage(value);
  const expected = usageKeys.map((_, index) => parts.reduce((sum, part) => sum + part[index]!, 0));
  actual.forEach((n, index) => {
    const sum = expected[index]!;
    // Floating point cost accumulation can differ by grouping, token counts cannot.
    requireEvidence(Number.isFinite(sum) && (index === 4 ? Math.abs(n - sum) <= Number.EPSILON * Math.max(1, n, sum) * 16 : n === sum), 'usage does not reconcile');
  });
  return actual;
}
function check(value: unknown): boolean {
  const c = object(value);
  requireEvidence(['publicPassed', 'hiddenPassed', 'scopePassed'].every(key => typeof c[key] === 'boolean') && typeof c.evidence === 'string', 'invalid acceptance check');
  return c.publicPassed === true && c.hiddenPassed === true && c.scopePassed === true;
}
function median(values: number[]): number {
  values.sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  return values.length % 2 ? values[middle]! : (values[middle - 1]! / 2 + values[middle]! / 2);
}
export interface EvidenceMetrics {
  benchmarkVersion: typeof BENCHMARK_VERSION; suiteHash: string; baseline: string;
  medianAcceptedMs: number; baselineMedianAcceptedMs: number; acceptedSamples: number;
  taskEvidence: TaskEvidence[];
}
/** Structural consistency, not provenance attestation or universal non-inferiority. */
export function validateWorkerEvidence(bytes: Uint8Array, selectedRoute: string, selectedRole: Role): EvidenceMetrics {
  requireEvidence(bytes.byteLength <= EVIDENCE_BYTE_LIMIT, '8 MiB evidence bound exceeded');
  exactEvidenceRoute(selectedRoute);
  requireEvidence(WORKER_ROLES.includes(selectedRole), 'exact role required');
  const run = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown);
  for (const [key, value] of Object.entries(RUN_CONTRACT)) equal(run[key], value, `unsupported run ${key}`);
  requireEvidence(run.status === 'completed' && run.error === null, 'run must be completed without error');
  timestamp(run.startedAt); finite(run.elapsedMs, true);
  hash(run.implementationHash);
  const fingerprints = object(run.sourceFingerprints);
  requireEvidence(Object.keys(fingerprints).length > 0, 'source fingerprints required');
  Object.values(fingerprints).forEach(hash);
  requireEvidence(digest(JSON.stringify(fingerprints)) === run.implementationHash, 'implementation fingerprint mismatch');
  const routes = array(run.routes).map(exactEvidenceRoute);
  requireEvidence(routes.length <= 4 && routes.includes(selectedRoute), 'selected route absent');
  const baseline = exactEvidenceRoute(run.baseline);
  requireEvidence(typeof run.seed === 'string' && run.seed.length > 0 && typeof run.repeats === 'number', 'schedule seed and repeats required');
  const planned = schedule(routes, baseline, run.repeats, run.seed);
  equal(run.planned, planned, 'planned schedule differs from recomputed suite');
  const rows = array(run.rows);
  requireEvidence(rows.length === planned.length, 'incomplete or duplicate coverage');
  const times = new Map<string, number>();
  let elapsed = 0;
  for (const [index, value] of rows.entries()) {
    const row = object(value), key = planned[index]!;
    equal(row.key, key, 'observation schedule mismatch or duplicate');
    requireEvidence(row.baseline === baseline && row.suiteHash === SUITE_HASH_ACCEPTED && row.benchmarkVersion === BENCHMARK_VERSION, 'observation identity mismatch');
    requireEvidence(row.status === 'completed' && row.error === null && row.qualityPassed === true && row.independentApproved === true, 'failed candidate or baseline');
    timestamp(row.startedAt);
    const item = CASES_ACCEPTED.find(candidate => candidate.id === key.caseId)!;
    requireEvidence(row.contextFingerprint === digest(JSON.stringify({ ...item.files, 'ACCEPTANCE.md': item.spec, ...(item.publicTest ? { 'public.test.mjs': item.publicTest } : {}) })), 'fixture context fingerprint mismatch');
    requireEvidence(row.prefixFingerprint === digest(referencePrefix(key.condition, key.pairId)), 'prefix fingerprint mismatch');
    requireEvidence(typeof row.fixtureRoot === 'string' && row.fixtureRoot.length > 0, 'fixture identity required');
    const duration = finite(row.elapsedMs, true);
    requireEvidence(finite(row.acceptedMs, true) === duration, 'accepted latency must include full observation');
    elapsed += duration;
    const calls = array(row.calls).map(object);
    const kinds = calls.map(call => call.kind);
    requireEvidence(canonical(kinds) === canonical(['initial', 'review']) || canonical(kinds) === canonical(['initial', 'review', 'repair', 'review']), 'invalid call sequence');
    const checks = array(row.checks);
    requireEvidence(checks.length === calls.length / 2, 'check coverage mismatch');
    const outcomes = checks.map(check);
    requireEvidence(row.workerOnlyPassed === outcomes[0] && outcomes.at(-1) === true, 'acceptance checks failed or inconsistent');
    let callElapsed = 0;
    const sessions = new Set<string>();
    const usages = calls.map(call => {
      const review = call.kind === 'review';
      requireEvidence(call.route === (review ? baseline : key.route) && call.access === (review || key.role !== 'implement' ? 'read-only' : 'write'), 'call route or access mismatch');
      requireEvidence(call.status === 'completed' && call.error === null, 'call failed');
      timestamp(call.startedAt); hash(call.promptFingerprint);
      callElapsed += finite(call.elapsedMs);
      requireEvidence(call.maxTurns === (review ? BUDGET.reviewMaxTurns : BUDGET.maxTurns) && call.timeoutMs === BUDGET.callTimeoutMs, 'call budget mismatch');
      requireEvidence(typeof call.sessionId === 'string' && call.sessionId.length > 0 && !sessions.has(call.sessionId), 'fresh call session required');
      sessions.add(call.sessionId);
      requireEvidence(typeof call.output === 'string' && call.approval === (review ? parseApproval(call.output) : null), 'review parsing mismatch');
      const messages = array(call.messages).map(object);
      requireEvidence(messages.length > 0 && messages.length <= Number(call.maxTurns), 'message coverage or turn bound');
      const messageUsage = messages.map(message => {
        requireEvidence(message.route === call.route && message.error === null && ['stop', 'length', 'toolUse'].includes(String(message.stopReason)), 'message route or terminal failure');
        return usage(message.usage);
      });
      return reconcile(call.usage, messageUsage);
    });
    if (key.role !== 'implement') {
      for (const [checkIndex, recorded] of checks.entries()) {
        requireEvidence(object(recorded).publicPassed === true && object(recorded).hiddenPassed === gradeArtifact(key.caseId, String(calls[checkIndex * 2]!.output)), 'structured artefact check mismatch');
      }
    }
    requireEvidence(callElapsed <= duration, 'call time exceeds accepted latency');
    reconcile(row.total, usages);
    requireEvidence(calls.at(-1)!.approval === true, 'final review did not approve');
    requireEvidence(calls.length === 4 ? !outcomes[0] || calls[1]!.approval !== true : outcomes[0] && calls[1]!.approval === true, 'repair decision inconsistent');
    const scope = object(row.scope);
    requireEvidence(scope.passed === true && scope.parentUnchanged === true && typeof scope.diff === 'string', 'scope or parent changed');
    const paths = array(scope.paths);
    const allowed = item.allowed;
    requireEvidence(paths.every(path => typeof path === 'string' && allowed.includes(path)) && new Set(paths).size === paths.length, 'scope paths outside allowed files');
    const hashes = object(scope.hashes);
    equal(Object.keys(hashes).sort(), [...paths].sort(), 'scope hashes do not cover changed paths');
    Object.values(hashes).forEach(hash);
    times.set(`${key.pairId}:${key.route}`, duration);
  }
  requireEvidence(Number.isFinite(elapsed) && elapsed <= Number(run.elapsedMs), 'run time excludes observations');
  const selected = planned.filter(key => key.route === selectedRoute && key.role === selectedRole);
  requireEvidence(selected.length > 0, 'role coverage missing');
  // Only the frozen case mapped to a family supports that family's measurements.
  const taskEvidence: TaskEvidence[] = (Object.keys(TASK_FAMILIES) as TaskFamily[]).flatMap(family => {
    const definition = TASK_FAMILIES[family];
    if (definition.role !== selectedRole) return [];
    const cases = selected.filter(key => key.caseId === definition.caseId);
    if (!cases.length) return [];
    return [{ family, acceptedSamples: cases.length,
      medianAcceptedMs: median(cases.map(key => times.get(`${key.pairId}:${selectedRoute}`)!)),
      baselineMedianAcceptedMs: median(cases.map(key => times.get(`${key.pairId}:${baseline}`)!)) }];
  });
  return { benchmarkVersion: BENCHMARK_VERSION, suiteHash: SUITE_HASH_ACCEPTED, baseline, taskEvidence,
    acceptedSamples: selected.length,
    medianAcceptedMs: median(selected.map(key => times.get(`${key.pairId}:${selectedRoute}`)!)),
    baselineMedianAcceptedMs: median(selected.map(key => times.get(`${key.pairId}:${baseline}`)!)) };
}
