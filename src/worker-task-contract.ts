import { chosen, probability } from './decisions.js';

export const TASK_FAMILIES = {
  'session-state-preservation': { role: 'implement', caseId: 'cache-session-identity', description: 'A bounded local fix preserving session identity, history and immutable state during updates; not general debugging or architecture.' },
  'exact-match-filtering': { role: 'implement', caseId: 'exact-route-filtering', description: 'A bounded local exact-match predicate or filter with explicit acceptance checks; not security-policy design.' },
  'failure-state-handling': { role: 'implement', caseId: 'failure-preservation', description: 'A bounded local fix preserving error, cancellation or result state; not distributed recovery design.' },
  'source-impact-location': { role: 'scout', caseId: 'scout-coding-impact', description: 'Locate relevant source symbols/callers and cite evidence in a bounded supplied code context.' },
  'provided-source-comparison': { role: 'research', caseId: 'research-route-contract', description: 'Compare supplied source records and identify supported conclusions or contradictions; not live web discovery.' },
  'failure-context-curation': { role: 'curate', caseId: 'curate-failure-handoff', description: 'Assemble a source-linked failure handoff from supplied records, preserving constraints and unresolved questions.' },
} as const;
export type TaskFamily = keyof typeof TASK_FAMILIES;
export type WorkerCapability = 'image' | 'reasoning';
export interface WorkerTaskContract {
  family: TaskFamily | 'uncovered';
  requiredCapabilities: WorkerCapability[];
}
export interface TaskEvidence {
  family: TaskFamily;
  acceptedSamples: number;
  medianAcceptedMs: number;
  baselineMedianAcceptedMs: number;
}
export type WorkerPolicy =
  | { mode: 'automatic' }
  | { mode: 'prefer-other-provider' }
  | { mode: 'allowlist'; routes: string[] };
export function isTaskFamily(value: unknown): value is TaskFamily {
  return typeof value === 'string' && Object.hasOwn(TASK_FAMILIES, value);
}
export function taskContractFromAnswers(answers: Record<string, unknown>, role: string): WorkerTaskContract {
  const family = chosen(answers.taskFamily);
  const confidence = probability(answers.taskFamily, 'confidence');
  if (confidence === undefined || confidence < 0.85 || (family !== 'uncovered' && !isTaskFamily(family))
    || (isTaskFamily(family) && TASK_FAMILIES[family].role !== role)) {
    throw new Error('Jev abstained on task-family suitability; orchestrator must clarify the objective');
  }
  const requiredCapabilities: WorkerCapability[] = [];
  for (const [key, capability] of [['needsVision', 'image'], ['needsReasoning', 'reasoning']] as const) {
    const value = probability(answers[key]);
    if (value === undefined || (value > 0.15 && value < 0.85)) throw new Error('Jev abstained on required capabilities; orchestrator must clarify');
    if (value >= 0.85) requiredCapabilities.push(capability);
  }
  return { family, requiredCapabilities };
}

export function parseWorkerPolicy(value: unknown): WorkerPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid worker policy');
  const p = value as Record<string, unknown>;
  if ((p.mode === 'automatic' || p.mode === 'prefer-other-provider') && Object.keys(p).length === 1) return { mode: p.mode };
  if (p.mode === 'allowlist' && Object.keys(p).length === 2 && Array.isArray(p.routes)
    && p.routes.length > 0 && p.routes.length <= 128 && new Set(p.routes).size === p.routes.length
    && p.routes.every(route => typeof route === 'string' && /^[a-z0-9][a-z0-9_-]{0,79}\/[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(route))) {
    return { mode: 'allowlist', routes: [...p.routes] as string[] };
  }
  throw new Error('Invalid worker policy; an allowlist requires unique exact provider/model routes');
}
