import { execFile, spawn } from 'node:child_process';
import { deadlineRemaining, parseEnvelope, reservationLedger } from './benchmark-budget.js';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUDGET, SUITE_HASH_ACCEPTED, digest, redactError, schedule } from './accepted-result-suite.js';
import { RUN_CONTRACT, profiles, type HostRequest, type Observation } from './accepted-result-protocol.js';

const args = process.argv.slice(2);
function argument(name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}
function required(name: string): string {
  const value = argument(name);
  if (!value || value.startsWith('--')) throw new Error(`Explicit ${name} required`);
  return value;
}
function save(path: string, value: unknown): void {
  writeFileSync(`${path}.tmp`, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

if (!args.includes('--live')) {
  console.log('No calls made. Usage: bun run bench/accepted-result-live.ts --live --routes provider/model,provider/model --baseline provider/model --seed trial-01 --repeats 2 --output bench/results/new-run.json --max-requests N --max-output-tokens N --max-tokens-per-request N --deadline-ms N --acknowledge-envelope');
} else {
  const envelope = parseEnvelope(args);
  const ledger = reservationLedger(envelope);
  const routes = required('--routes').split(',');
  const baseline = required('--baseline');
  const seed = required('--seed');
  const repeats = Number(argument('--repeats') ?? '2');
  if (routes.length > 4 || routes.some(route => !/^(openai-codex|xai)\/.+$/.test(route))) throw new Error('Use at most four exact native subscription routes; no tiers or aliases');
  const planned = schedule(routes, baseline, repeats, seed);
  console.log(JSON.stringify({ plannedObservations: planned.length, maxWorkerCalls: planned.length * (2 + BUDGET.repairs * 2), maxNativeRequestsFromTurnCaps: planned.length * (1 + BUDGET.repairs) * (BUDGET.maxTurns + BUDGET.reviewMaxTurns), hardEnvelope: envelope, accounting: 'Every native request reserves its entire maxTokens allocation; no refunds. Input tokens are not bounded by this output envelope.' }));
  const here = dirname(fileURLToPath(import.meta.url));
  const host = resolve(argument('--host') ?? join(here, '../../pi-subagents/integration/live-benchmark-host.ts'));
  const bun = argument('--bun-path') ?? ('bun' in process.versions ? process.execPath : undefined);
  if (!bun || !isAbsolute(bun) || !/^bun(?:\.exe)?$/i.test(basename(bun))) throw new Error('Run using Bun or supply an absolute --bun-path');
  const output = resolve(required('--output'));
  const checkpoints = `${output}.observations`;
  if (existsSync(output) || existsSync(checkpoints)) throw new Error('Refusing to overwrite existing evidence; choose a new output path');
  mkdirSync(dirname(output), { recursive: true });
  mkdirSync(checkpoints);
  // Pin host, fixture construction, oracle and aggregation code before the first call.
  const sourcePaths = [host, join(dirname(host), 'live-benchmark-fixtures.ts'), fileURLToPath(import.meta.url), join(here, 'benchmark-budget.ts'), join(here, 'accepted-result-suite.ts'), join(here, 'accepted-result-protocol.ts'), ...['managed-workers.ts', 'managed-worker-runtime.ts', 'managed-allowance.ts', 'agent-manager.ts', 'agent-runner.ts', 'agent-types.ts'].map(file => join(dirname(host), '../src', file))];
  const fingerprint = () => Object.fromEntries(sourcePaths.map(path => [path, digest(readFileSync(path, 'utf8'))]));
  const sourceFingerprints = fingerprint();
  const implementationHash = digest(JSON.stringify(sourceFingerprints));
  const rows: Observation[] = [];
  const startedAt = new Date().toISOString();
  const started = performance.now();
  let status: 'running' | 'completed' | 'incomplete' = 'running';
  let error: ReturnType<typeof redactError> | null = null;
  let interrupted = false;
  let cancelChild: (() => void) | undefined;
  const interrupt = () => { interrupted = true; cancelChild?.(); };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  const checkpoint = () => save(output, {
    ...RUN_CONTRACT, implementationHash, sourceFingerprints, startedAt, elapsedMs: performance.now() - started,
    platform: process.platform, arch: process.arch, runtime: process.version, bun: process.versions['bun'] ?? 'external',
    baseline, routes, seed, repeats, planned, rows, status, error, envelope, reservations: { ...ledger.used },
    profiles: profiles(rows, planned, baseline, status === 'completed'),
    expiryPolicy: 'expiresAt remains null until a human selects an expiry; candidates are not dispatch settings',
  });
  checkpoint();
  let deadlineExpired = false;
  const watchdog = setTimeout(() => {
    deadlineExpired = true; interrupted = true; status = 'incomplete';
    error = redactError('Whole-run deadline'); process.exitCode = 1;
    cancelChild?.(); checkpoint();
  }, envelope.deadlineMs);
  const runHost = (hostArgs: string[], timeoutMs: number) => new Promise<{ code: number | null; timedOut: boolean }>((resolveExit, reject) => {
    if (interrupted || deadlineRemaining(started, envelope.deadlineMs, performance.now()) === 0) { reject(new Error('Whole-run deadline or interruption')); return; }
    const child = spawn(bun, [host, ...hostArgs], { cwd: dirname(host), stdio: 'ignore', windowsHide: true, detached: process.platform !== 'win32' });
    let timedOut = false;
    const kill = () => {
      if (!child.pid) return;
      if (process.platform === 'win32') {
        execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10_000 }, () => { child.kill('SIGKILL'); });
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }
    };
    cancelChild = kill;
    const timer = setTimeout(() => { timedOut = true; kill(); }, Math.min(timeoutMs, deadlineRemaining(started, envelope.deadlineMs, performance.now())));
    child.once('error', failure => { clearTimeout(timer); cancelChild = undefined; reject(failure); });
    child.once('exit', code => { clearTimeout(timer); cancelChild = undefined; resolveExit({ code, timedOut }); });
  });
  try {
    // All requested routes, including the independent reviewer, must pass before
    // fixture construction or inference. This process has its own outer bound.
    const preflight = await runHost(['--preflight', '--routes', [...new Set([...routes, baseline])].join(',')], 60_000);
    if (preflight.code !== 0 || preflight.timedOut || interrupted) throw new Error('All-route preflight failed or timed out');
    for (const [index, key] of planned.entries()) {
      if (interrupted) throw new Error('Benchmark interrupted');
      if (digest(JSON.stringify(fingerprint())) !== implementationHash) throw new Error('Frozen harness source changed during run');
      const resultPath = join(checkpoints, `${String(index).padStart(4, '0')}.json`);
      const requestPath = join(checkpoints, `${String(index).padStart(4, '0')}.request.json`);
      const budget = ledger.remaining();
      if (budget.maxRequests < 1 || budget.maxOutputTokens < budget.maxTokensPerRequest) throw new Error('Benchmark reservation envelope exhausted');
      const request: HostRequest = { live: true, key, baseline, suiteHash: SUITE_HASH_ACCEPTED, output: resultPath, bun, budget };
      writeFileSync(requestPath, JSON.stringify(request), { flag: 'wx', mode: 0o600 });
      // Separate child keeps the runner's TypeScript graph out of the Jev typecheck.
      // The outer deadline also covers a hung native abort/disposal path.
      const observationStarted = performance.now();
      const exit = await runHost(['--live', '--request', requestPath], BUDGET.callTimeoutMs * 4 + 90_000);
      let row: Observation | undefined;
      if (existsSync(resultPath)) {
        row = JSON.parse(readFileSync(resultPath, 'utf8')) as Observation;
        ledger.deduct((row as Observation & { reservations?: unknown }).reservations);
        if (row.suiteHash !== SUITE_HASH_ACCEPTED || JSON.stringify(row.key) !== JSON.stringify(key) || row.baseline !== baseline) throw new Error('Host observation identity mismatch');
        if (exit.code !== 0 || exit.timedOut || interrupted || row.status !== 'completed') {
          row.status = 'incomplete'; row.qualityPassed = false; row.acceptedMs = null;
          row.error ??= redactError(exit.timedOut ? 'Host deadline' : 'Host interrupted or failed');
        }
        // Include Bun child startup/IPC, fixture construction, review, repair and oracle time.
        row.elapsedMs = performance.now() - observationStarted;
        if (row.qualityPassed) row.acceptedMs = row.elapsedMs;
        rows.push(row);
        checkpoint();
      }
      if (!row || row.status !== 'completed' || exit.code !== 0 || interrupted) throw new Error(row?.error?.category ?? 'Incomplete child evidence');
      console.log(JSON.stringify({ index, ...key, workerOnlyPassed: row.workerOnlyPassed, qualityPassed: row.qualityPassed, acceptedMs: row.acceptedMs }));
    }
    if (deadlineExpired || deadlineRemaining(started, envelope.deadlineMs, performance.now()) === 0) throw new Error('Whole-run deadline');
    status = 'completed';
  } catch (failure) {
    status = 'incomplete'; error = redactError(failure); process.exitCode = 1;
  } finally {
    clearTimeout(watchdog);
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
    checkpoint();
  }
  console.log(`Evidence: ${output}; ${status}; qualified=false`);
}
