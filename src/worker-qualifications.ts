import { createHash, randomUUID } from 'node:crypto';
import { openSync, readSync, closeSync, fstatSync, realpathSync, lstatSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { parseQualification, routeKey, type Qualification } from './worker-routing.js';

export const QUALIFICATIONS_PATH = join(homedir(), '.pi', 'agent', 'jev-assist', 'worker-qualifications.json');
export { BENCHMARK_VERSION } from '../bench/accepted-result-suite.js';
import { BENCHMARK_VERSION } from '../bench/accepted-result-suite.js';
import { EVIDENCE_BYTE_LIMIT, validateWorkerEvidence, type EvidenceMetrics } from './worker-evidence.js';
export interface TrustedQualification extends Qualification {
  schemaVersion: 1; benchmarkVersion: typeof BENCHMARK_VERSION; evidenceHash: string;
  acceptedSamples: number; reviewIncluded: true; repairIncluded: true; baselineMedianAcceptedMs: number;
}
const fields = ['route', 'baseline', 'roles', 'evidenceRef', 'suiteHash', 'expiresAt', 'qualityPassed', 'endToEnd', 'medianAcceptedMs', 'schemaVersion', 'benchmarkVersion', 'evidenceHash', 'acceptedSamples', 'reviewIncluded', 'repairIncluded', 'baselineMedianAcceptedMs'];
export function assertLocalPath(path: string): void {
  if (!isAbsolute(path) || /^(?:\\\\|\/\/)/.test(path)) throw new Error('A local absolute file path is required');
  if (path.split(/[\\/]/).includes('..')) throw new Error('Parent traversal is not permitted');
  let cursor = resolve(path);
  while (true) {
    if (lstatSync(cursor).isSymbolicLink()) throw new Error('Symlink traversal is not permitted for evidence or imports');
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
}
export function readBoundedBytes(path: string, limit: number): Buffer {
  const fd = openSync(path, 'r');
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) throw new Error('Qualification or evidence file exceeds its local file bound');
    const bytes = Buffer.alloc(limit + 1);
    let used = 0;
    while (used < bytes.length) {
      const count = readSync(fd, bytes, used, bytes.length - used, used);
      if (!count) break;
      used += count;
    }
    if (used > limit) throw new Error('File grew beyond its bound');
    return bytes.subarray(0, used);
  } finally { closeSync(fd); }
}
function readBounded(path: string, limit: number): string { return readBoundedBytes(path, limit).toString('utf8'); }
export function parseTrustedQualification(value: unknown, now = Date.now()): TrustedQualification {
  const core = parseQualification(value);
  if (!core || !value || typeof value !== 'object') throw new Error('Invalid qualification profile');
  const p = value as Record<string, unknown>;
  if (Object.keys(p).length !== fields.length || Object.keys(p).some(key => !fields.includes(key))
    || p.schemaVersion !== 1 || p.benchmarkVersion !== BENCHMARK_VERSION || core.roles.length !== 1
    || typeof p.baselineMedianAcceptedMs !== 'number' || !Number.isFinite(p.baselineMedianAcceptedMs) || p.baselineMedianAcceptedMs <= 0
    || core.expiresAt > 8_640_000_000_000_000 || core.expiresAt <= now || p.reviewIncluded !== true || p.repairIncluded !== true
    || !Number.isSafeInteger(p.acceptedSamples) || Number(p.acceptedSamples) < 1
    || typeof p.evidenceHash !== 'string' || !/^[a-f0-9]{64}$/.test(p.evidenceHash)) throw new Error('Invalid, stale or unsupported qualification evidence');
  return { ...core, schemaVersion: 1, benchmarkVersion: BENCHMARK_VERSION, evidenceHash: p.evidenceHash,
    acceptedSamples: p.acceptedSamples as number, baselineMedianAcceptedMs: p.baselineMedianAcceptedMs as number, reviewIncluded: true, repairIncluded: true };
}
function verifyEvidence(profile: TrustedQualification): EvidenceMetrics {
  if (!isAbsolute(profile.evidenceRef) || /^(?:\\\\|\/\/)/.test(profile.evidenceRef)) throw new Error('Evidence must be a local absolute file');
  assertLocalPath(profile.evidenceRef);
  const evidence = readBoundedBytes(profile.evidenceRef, EVIDENCE_BYTE_LIMIT);
  if (createHash('sha256').update(evidence).digest('hex') !== profile.evidenceHash) throw new Error('Evidence hash mismatch');
  const metrics = validateWorkerEvidence(evidence, routeKey(profile.route), profile.roles[0]!);
  if (metrics.baseline !== routeKey(profile.baseline) || metrics.suiteHash !== profile.suiteHash
    || metrics.medianAcceptedMs !== profile.medianAcceptedMs || metrics.baselineMedianAcceptedMs !== profile.baselineMedianAcceptedMs
    || metrics.acceptedSamples !== profile.acceptedSamples) throw new Error('Profile metrics differ from validated benchmark evidence');
  return metrics;
}
export function importQualification(path: string, now = Date.now()): TrustedQualification {
  if (!isAbsolute(path) || /^(?:\\\\|\/\/)/.test(path)) throw new Error('Import requires a local absolute path');
  assertLocalPath(path);
  const source = realpathSync(path);
  const raw: unknown = JSON.parse(readBounded(source, 32_768));
  const profile = parseTrustedQualification(raw, now);
  // Evidence may not escape the import bundle, including via symlinks.
  if (isAbsolute(profile.evidenceRef) || /^[\\/]/.test(profile.evidenceRef) || profile.evidenceRef.includes(':') || profile.evidenceRef.split(/[\\/]/).includes('..')) throw new Error('Import evidenceRef must be relative to its bundle without traversal');
  const candidate = resolve(dirname(source), profile.evidenceRef);
  assertLocalPath(candidate);
  const evidence = realpathSync(candidate);
  const inside = relative(dirname(source), evidence);
  if (inside.split(/[\\/]/)[0] === '..' || isAbsolute(inside)) throw new Error('Evidence escapes the local import bundle');
  const prepared = { ...profile, evidenceRef: evidence };
  verifyEvidence(prepared);
  return prepared;
}
export function qualificationKey(p: Qualification): string { return `${routeKey(p.route)}:${p.roles.join(',')}:${routeKey(p.baseline)}`; }
/** Inventory retains stale/changed profiles so the user can still revoke them. */
export function qualificationInventory(path = QUALIFICATIONS_PATH): TrustedQualification[] {
  try {
    assertLocalPath(path);
    const raw: unknown = JSON.parse(readBounded(path, 1_048_576));
    if (!Array.isArray(raw) || raw.length > 128) return [];
    return raw.flatMap(value => { try { return [parseTrustedQualification(value, 0)]; } catch { return []; } });
  } catch { return []; }
}
export function loadQualifications(path = QUALIFICATIONS_PATH): TrustedQualification[] {
  return qualificationInventory(path).flatMap(value => {
    try { const p = parseTrustedQualification(value); verifyEvidence(p); return [p]; } catch { return []; }
  });
}
/** Runtime-only refinement; stored assertions never supply task-family evidence. */
export function loadRoutingQualifications(path = QUALIFICATIONS_PATH): Qualification[] {
  return qualificationInventory(path).flatMap(value => {
    try {
      const profile = parseTrustedQualification(value);
      const metrics = verifyEvidence(profile);
      return [{ ...profile, taskEvidence: metrics.taskEvidence }];
    } catch { return []; }
  });
}
export function saveQualifications(profiles: readonly TrustedQualification[], path = QUALIFICATIONS_PATH): void {
  if (profiles.length > 128) throw new Error('Qualification limit reached');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(profiles, null, 2) + '\n', { mode: 0o600 });
  renameSync(temp, path);
}
