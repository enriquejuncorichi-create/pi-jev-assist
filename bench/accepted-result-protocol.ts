import { BENCHMARK_VERSION, BUDGET, CASES_ACCEPTED, LIMITS, SUITE_HASH_ACCEPTED, parseApproval, redactError, type ObservationKey, type Role } from './accepted-result-suite.js';

export interface HostRequest { live: true; key: ObservationKey; baseline: string; suiteHash: string; output: string; bun: string; budget?: { maxRequests: number; maxOutputTokens: number; maxTokensPerRequest: number } }
export interface Usage { input: number; output: number; cacheRead: number; cacheWrite: number; catalogueListPriceEquivalentUsd: number; actualChargeUsd: null }
export interface CallEvidence {
  kind: 'initial' | 'review' | 'repair'; route: string; access: 'read-only' | 'write';
  effectiveTransport?: string;
  startedAt: string; elapsedMs: number; maxTurns: number; timeoutMs: number;
  status: string; sessionId: string | null; promptFingerprint: string;
  output: string; approval: boolean | null; usage: Usage;
  messages: Array<{ route: string; stopReason: string; usage: Usage; error: ReturnType<typeof redactError> | null }>;
  error: ReturnType<typeof redactError> | null;
}
export interface CheckEvidence { publicPassed: boolean; hiddenPassed: boolean; scopePassed: boolean; evidence: string }
export interface Observation {
  key: ObservationKey; baseline: string; suiteHash: string; benchmarkVersion: string;
  status: 'running' | 'completed' | 'incomplete'; startedAt: string; elapsedMs: number;
  workerOnlyPassed: boolean; qualityPassed: boolean; independentApproved: boolean;
  acceptedMs: number | null; calls: CallEvidence[]; checks: CheckEvidence[];
  scope: { paths: string[]; hashes: Record<string, string>; diff: string; parentUnchanged: boolean; passed: boolean } | null;
  contextFingerprint: string; prefixFingerprint: string; fixtureRoot: string;
  error: ReturnType<typeof redactError> | null;
  total: Usage;
}
export function emptyUsage(): Usage { return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, catalogueListPriceEquivalentUsd: 0, actualChargeUsd: null }; }
export function totalUsage(calls: CallEvidence[]): Usage {
  const total = emptyUsage();
  for (const call of calls) for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'catalogueListPriceEquivalentUsd'] as const) total[key] += call.usage[key];
  return total;
}
export interface ProfileCandidate {
  schema: 'jev-reviewed-profile-candidate-v1'; route: string; exactBaseline: string; role: Role;
  suiteHash: string; benchmarkVersion: string; expiresAt: string | null; endToEnd: true;
  qualityPassed: boolean; medianAcceptedMs: number | null; qualified: false;
  qualificationEligible: boolean; independentApproved: boolean; completedPairedCases: number;
  measurementLimits: readonly string[]; review: 'human-review-required';
}
export function profiles(rows: Observation[], planned: ObservationKey[], baseline: string, complete: boolean): ProfileCandidate[] {
  const routes = [...new Set(planned.map(key => key.route))];
  const roles = [...new Set(CASES_ACCEPTED.map(item => item.role))];
  const valid = (row: Observation) => {
    const review = row.calls.at(-1);
    const check = row.checks.at(-1);
    return row.status === 'completed' && row.qualityPassed && row.independentApproved
      && row.suiteHash === SUITE_HASH_ACCEPTED && row.baseline === baseline && row.benchmarkVersion === BENCHMARK_VERSION
      && row.acceptedMs !== null && Number.isFinite(row.acceptedMs) && row.acceptedMs >= 0
      && row.scope?.passed === true && check?.publicPassed === true && check.hiddenPassed && check.scopePassed
      && review?.kind === 'review' && review.route === baseline && review.access === 'read-only'
      && review.status === 'completed' && review.approval === true && parseApproval(review.output)
      && row.calls.every(call => call.status === 'completed' && !call.error);
  };
  const identity = (key: ObservationKey) => `${key.pairId}:${key.route}`;
  return routes.flatMap(route => roles.map(role => {
    const expected = planned.filter(key => key.route === route && key.role === role);
    const selected = rows.filter(row => row.key.route === route && row.key.role === role);
    const paired = expected.filter(key => {
      const matching = rows.filter(row => identity(row.key) === identity(key));
      const baselineRows = rows.filter(row => row.key.pairId === key.pairId && row.key.route === baseline);
      return matching.length === 1 && baselineRows.length === 1 && valid(matching[0]!) && valid(baselineRows[0]!);
    }).length;
    const qualityPassed = complete && expected.length > 0 && selected.length === expected.length && paired === expected.length;
    const times = selected.filter(valid).map(row => row.acceptedMs).filter((v): v is number => v !== null).sort((a, b) => a - b);
    const middle = Math.floor(times.length / 2);
    const median = times.length ? times.length % 2 ? times[middle]! : (times[middle - 1]! + times[middle]!) / 2 : null;
    return { schema: 'jev-reviewed-profile-candidate-v1' as const, route, exactBaseline: baseline, role, suiteHash: SUITE_HASH_ACCEPTED, benchmarkVersion: BENCHMARK_VERSION, expiresAt: null, endToEnd: true as const, qualityPassed, medianAcceptedMs: median, qualified: false as const, qualificationEligible: qualityPassed, independentApproved: selected.length > 0 && selected.every(row => row.independentApproved), completedPairedCases: paired, measurementLimits: LIMITS, review: 'human-review-required' as const };
  }));
}
export const RUN_CONTRACT = { schema: 'jev-accepted-result-run-v1', benchmarkVersion: BENCHMARK_VERSION, suiteHash: SUITE_HASH_ACCEPTED, budget: BUDGET, measurementLimits: LIMITS, actualChargeUsd: null, qualified: false } as const;
