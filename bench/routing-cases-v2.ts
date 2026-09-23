import { createHash } from 'node:crypto';
import { CASES, grade, type BenchmarkCase } from './routing-cases.js';

// V1 evidence stays immutable. V2 tightens the prompt and scores required claims,
// allowing S1 only as redundant support rather than requiring it for a pass.
export const CASES_V2: readonly BenchmarkCase[] = CASES.map(item => item.role !== 'research'
  ? { ...item, id: item.id.replace(/-v1$/, '-v2') }
  : {
    ...item,
    id: 'research-conflicting-evidence-v2',
    prompt: `${item.prompt}\nUse bare source IDs only (S1, S2, S3, S4), not their display labels. The sources must support BOTH the billing answer AND the listed unknowns. Include the observed execution-path source when assessing unknowns. Redundant authoritative support is allowed; unsupported community claims are not.`,
    expected: { answer: 'path-dependent', supportingSources: ['S2', 'S4'], unknowns: ['account-entitlement', 'current-price'] },
  });

export function gradeV2(caseId: string, text: string): { pass: boolean; reason: string } {
  if (!CASES_V2.some(item => item.id === caseId)) throw new Error('Unknown v2 case');
  if (caseId !== 'research-conflicting-evidence-v2') return grade(caseId.replace(/-v2$/, '-v1'), text);
  try {
    const answer: unknown = JSON.parse(text);
    if (!answer || typeof answer !== 'object' || Array.isArray(answer)) throw new Error();
    const data = answer as Record<string, unknown>;
    if (Object.keys(data).sort().join(',') !== 'answer,supportingSources,unknowns') throw new Error();
    const sources = data.supportingSources;
    const unknowns = data.unknowns;
    if (data.answer !== 'path-dependent' || !Array.isArray(sources) || !Array.isArray(unknowns)) throw new Error();
    if (sources.some(id => !['S1', 'S2', 'S4'].includes(id)) || new Set(sources).size !== sources.length
      || !sources.includes('S2') || !sources.includes('S4') || JSON.stringify([...sources].sort()) !== JSON.stringify(sources)) throw new Error();
    if (JSON.stringify(unknowns) !== JSON.stringify(['account-entitlement', 'current-price'])) throw new Error();
    return { pass: true, reason: 'Required billing and unknown-fact claims supported by authoritative sources' };
  } catch {
    return { pass: false, reason: 'Required claim, evidence, unknown or explicit JSON contract missing' };
  }
}
export const SUITE_HASH_V2 = createHash('sha256').update(JSON.stringify({ cases: CASES_V2, grading: 'required-S2-S4-optional-S1-exact-unknowns-v2' })).digest('hex');
