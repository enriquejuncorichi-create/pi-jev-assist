import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EVIDENCE_BYTE_LIMIT, validateWorkerEvidence } from '../src/worker-evidence.js';
import { assertLocalPath, parseTrustedQualification, readBoundedBytes, type TrustedQualification } from '../src/worker-qualifications.js';
import { type WorkerRole } from '../src/worker-routing.js';

/** Offline only: creates a reviewable bundle, never installs or approves a qualification. */
export function prepareImportBundle(options: {
  evidencePath: string; outputDirectory: string; route: string; role: WorkerRole; expiresAt: number;
}, now = Date.now()): { profilePath: string; profile: TrustedQualification } {
  assertLocalPath(options.evidencePath);
  const bytes = readBoundedBytes(options.evidencePath, EVIDENCE_BYTE_LIMIT);
  const metrics = validateWorkerEvidence(bytes, options.route, options.role);
  const splitRoute = (value: string) => ({ provider: value.slice(0, value.indexOf('/')), model: value.slice(value.indexOf('/') + 1) });
  const profile = parseTrustedQualification({
    schemaVersion: 1, benchmarkVersion: metrics.benchmarkVersion,
    route: splitRoute(options.route), baseline: splitRoute(metrics.baseline), roles: [options.role],
    evidenceRef: 'evidence.json', evidenceHash: createHash('sha256').update(bytes).digest('hex'),
    suiteHash: metrics.suiteHash, expiresAt: options.expiresAt, qualityPassed: true, endToEnd: true,
    medianAcceptedMs: metrics.medianAcceptedMs, baselineMedianAcceptedMs: metrics.baselineMedianAcceptedMs,
    acceptedSamples: metrics.acceptedSamples, reviewIncluded: true, repairIncluded: true,
  }, now);
  // Validate everything (including expiry and byte bound) before creating output.
  if (!isAbsolute(options.outputDirectory) || /^(?:\\\\|\/\/)/.test(options.outputDirectory)
    || options.outputDirectory.split(/[\\/]/).includes('..')) throw new Error('A new local absolute output directory is required');
  assertLocalPath(dirname(options.outputDirectory));
  mkdirSync(options.outputDirectory, { mode: 0o700 }); // Existing bundles are never overwritten.
  assertLocalPath(options.outputDirectory);
  writeFileSync(join(options.outputDirectory, profile.evidenceRef), bytes, { flag: 'wx', mode: 0o600 });
  const profilePath = join(options.outputDirectory, 'profile.json');
  writeFileSync(profilePath, JSON.stringify(profile, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { profilePath, profile };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const names = ['--evidence', '--output', '--route', '--role', '--expires-at'];
  if (args.length !== names.length * 2 || args.some((value, index) => index % 2 === 0 && !names.includes(value))
    || new Set(args.filter((_, index) => index % 2 === 0)).size !== names.length) {
    throw new Error('Offline usage: --evidence <local completed run> --output <new bundle directory> --route <exact provider/model> --role <exact role> --expires-at <future ISO timestamp>');
  }
  const required = (name: string): string => args[args.indexOf(name) + 1]!;
  const expiry = required('--expires-at');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(expiry)) throw new Error('Explicit UTC ISO expiry required');
  const result = prepareImportBundle({ evidencePath: resolve(required('--evidence')), outputDirectory: resolve(required('--output')),
    route: required('--route'), role: required('--role') as WorkerRole, expiresAt: Date.parse(expiry) });
  console.log(`Offline bundle: ${result.profilePath}\nNot approved or installed. Review the evidence and its measurement limits before interactive import.`);
}
