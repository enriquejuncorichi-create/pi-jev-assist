import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { BENCHMARK_VERSION, CASES_ACCEPTED, SUITE_HASH_ACCEPTED, digest, gradeArtifact, hiddenProbe, parseApproval, redactError, referencePrefix, schedule } from '../bench/accepted-result-suite.js';
import { emptyUsage, profiles, totalUsage, type CallEvidence, type Observation } from '../bench/accepted-result-protocol.js';

const baseline = 'openai-codex/exact-baseline';
const candidate = 'xai/exact-candidate';
const plan = schedule([baseline, candidate], baseline, 2, 'fixed-seed');

function observation(key = plan[0]!): Observation {
  const review: CallEvidence = {
    kind: 'review', route: baseline, access: 'read-only', startedAt: '2026-01-01T00:00:00Z', elapsedMs: 5, maxTurns: 8, timeoutMs: 120_000,
    status: 'completed', sessionId: 'fresh-review', promptFingerprint: digest('review'), output: '{"approved":true,"reason":"independent inspection"}', approval: true, usage: emptyUsage(), messages: [], error: null,
  };
  return {
    key, baseline, suiteHash: SUITE_HASH_ACCEPTED, benchmarkVersion: BENCHMARK_VERSION, status: 'completed', startedAt: '2026-01-01T00:00:00Z', elapsedMs: 20,
    workerOnlyPassed: true, qualityPassed: true, independentApproved: true, acceptedMs: 20, calls: [review],
    checks: [{ publicPassed: true, hiddenPassed: true, scopePassed: true, evidence: 'unit fixture' }],
    scope: { paths: [], hashes: {}, diff: '', parentUnchanged: true, passed: true }, contextFingerprint: digest('fixture'), prefixFingerprint: digest('prefix'), fixtureRoot: '/synthetic', error: null, total: emptyUsage(),
  };
}

test('paired schedule is deterministic, complete and route-order randomised', () => {
  assert.deepEqual(plan, schedule([baseline, candidate], baseline, 2, 'fixed-seed'));
  assert.notDeepEqual(plan, schedule([baseline, candidate], baseline, 2, 'different-seed'));
  assert.equal(plan.length, CASES_ACCEPTED.length * 2 * 2 * 2);
  const firstRoutes = new Set<string>();
  for (let i = 0; i < plan.length; i += 2) {
    assert.equal(plan[i]!.pairId, plan[i + 1]!.pairId);
    assert.deepEqual(new Set([plan[i]!.route, plan[i + 1]!.route]), new Set([baseline, candidate]));
    firstRoutes.add(plan[i]!.route);
  }
  assert.equal(firstRoutes.size, 2);
  assert.throws(() => schedule([candidate], baseline, 2, 'seed'));
  assert.throws(() => schedule([baseline, baseline], baseline, 2, 'seed'));
  assert.throws(() => schedule([baseline], baseline, 1, 'seed'));
});

test('all four roles and three real coding fixtures have public acceptance', () => {
  assert.deepEqual(new Set(CASES_ACCEPTED.map(item => item.role)), new Set(['implement', 'scout', 'research', 'curate']));
  const coding = CASES_ACCEPTED.filter(item => item.role === 'implement');
  assert.equal(coding.length, 3);
  for (const item of coding) { assert.ok(item.publicTest); assert.deepEqual(item.allowed, ['solution.mjs']); assert.ok(item.files['solution.mjs']); }
  assert.match(SUITE_HASH_ACCEPTED, /^[a-f0-9]{64}$/);
});

test('cache controls contain useful source, same byte length and different fingerprints', () => {
  const stable = referencePrefix('stable', 'ignored');
  const changed = referencePrefix('mutated', 'fixed');
  assert.equal(Buffer.byteLength(stable), Buffer.byteLength(changed));
  assert.ok(stable.length > 8_000);
  assert.notEqual(digest(stable), digest(changed));
  assert.equal(stable, referencePrefix('stable', 'another-local-key'));
  assert.equal(changed, referencePrefix('mutated', 'fixed'));
  for (const item of CASES_ACCEPTED) assert.ok(stable.includes(item.spec));
});

test('structured role oracles reject unsupported evidence, stale failure and extra keys', () => {
  assert.equal(gradeArtifact('scout-coding-impact', '{"transitive":["controller.mjs","preview.mjs","session.mjs"],"direct":["preview.mjs","session.mjs"]}'), true);
  assert.equal(gradeArtifact('research-route-contract', '{"answer":"path-dependent","sources":["S2","S4"],"unknowns":["account-entitlement","current-price"]}'), true);
  assert.equal(gradeArtifact('research-route-contract', '{"answer":"path-dependent","sources":["S2","S3"],"unknowns":[]}'), false);
  assert.equal(gradeArtifact('curate-failure-handoff', '{"keep":["R1","R3","R4","R6"],"unresolved":["R3"]}'), true);
  assert.equal(gradeArtifact('curate-failure-handoff', '{"keep":["R1","R2","R4","R6"],"unresolved":[]}'), false);
  assert.equal(gradeArtifact('scout-coding-impact', '```json\n{}\n```'), false);
  assert.equal(gradeArtifact('unknown', '{}'), false);
});

test('review is fail-closed and diagnostics never reproduce sensitive provider detail', () => {
  assert.equal(parseApproval('{"approved":true,"reason":"inspected source"}'), true);
  for (const value of ['approved', '{"approved":"true","reason":"yes"}', '{"approved":true}', '{"approved":false,"reason":"bug"}']) assert.equal(parseApproval(value), false);
  const error = redactError('HTTP 429 quota exhausted bearer super-secret user@example.com /home/private/auth.json');
  assert.equal(error.category, 'quota');
  assert.ok(error.message.includes('429'));
  assert.equal(JSON.stringify(error).includes('super-secret'), false);
  assert.equal(JSON.stringify(error).includes('user@example.com'), false);
  assert.equal(redactError('401 invalid credential').category, 'auth');
});

test('incomplete pairs, duplicate rows, failed baseline and absent independent approval cannot qualify', () => {
  const rows = plan.map(key => observation(key));
  const complete = profiles(rows, plan, baseline, true);
  assert.ok(complete.every(profile => profile.qualityPassed && profile.qualificationEligible));
  assert.ok(complete.every(profile => profile.qualified === false && profile.expiresAt === null));
  assert.ok(profiles(rows, plan, baseline, false).every(profile => !profile.qualityPassed));
  assert.ok(profiles(rows.filter(row => row.key.route !== baseline), plan, baseline, true).every(profile => !profile.qualityPassed));
  const bad = rows.map(row => ({ ...row, independentApproved: false }));
  assert.ok(profiles(bad, plan, baseline, true).every(profile => !profile.qualificationEligible));
  const spoofedReview = rows.map(row => ({ ...row, calls: row.calls.map(call => ({ ...call, route: candidate })) }));
  assert.ok(profiles(spoofedReview, plan, baseline, true).every(profile => !profile.qualityPassed));
  const hiddenFailed = rows.map(row => ({ ...row, checks: row.checks.map(check => ({ ...check, hiddenPassed: false })) }));
  assert.ok(profiles(hiddenFailed, plan, baseline, true).every(profile => !profile.qualityPassed));
  const changed = rows.map(row => ({ ...row, suiteHash: 'stale' }));
  assert.ok(profiles(changed, plan, baseline, true).every(profile => !profile.qualityPassed));
  const duplicated = profiles([...rows, rows[0]!], plan, baseline, true).find(profile => profile.route === rows[0]!.key.route && profile.role === rows[0]!.key.role)!;
  assert.equal(duplicated.qualityPassed, false);
});

test('accepted-result accounting includes each initial/review/repair invocation exactly once', () => {
  const row = observation();
  const calls: CallEvidence[] = ['initial', 'review', 'repair', 'review'].map((kind, index) => ({ ...row.calls[0]!, kind: kind as CallEvidence['kind'], usage: { input: index + 1, output: 2, cacheRead: 3, cacheWrite: 4, catalogueListPriceEquivalentUsd: 0.01, actualChargeUsd: null } }));
  assert.deepEqual(totalUsage(calls), { input: 10, output: 8, cacheRead: 12, cacheWrite: 16, catalogueListPriceEquivalentUsd: 0.04, actualChargeUsd: null });
});

test('driver and runner host default to no calls', () => {
  const driver = fileURLToPath(new URL('../bench/accepted-result-live.ts', import.meta.url));
  if (!('bun' in process.versions)) return;
  const host = fileURLToPath(new URL('../../pi-subagents/integration/live-benchmark-host.ts', import.meta.url));
  for (const path of [driver, host]) assert.match(execFileSync(process.execPath, [path], { encoding: 'utf8', timeout: 20_000, windowsHide: true }), /No calls made/);
});

const fixes: Record<string, string> = {
  'cache-session-identity': 'export function resume(session,route){return {...session,route:{...route}};}\n',
  'exact-route-filtering': 'export function select(routes,requested){return routes.find(r=>r.provider===requested.provider&&r.id===requested.model&&r.oauth===true&&r.subscription===true)??null;}\n',
  'failure-preservation': 'export function settle(previous,event){if(event.status==="error"||event.status==="aborted")return {...previous,status:event.status,error:event.error??"Unspecified failure"};if(event.status!=="completed")throw new Error("Invalid status");const {error,...rest}=previous;return {...rest,status:"completed",result:event.result};}\n',
};

test('portable held-out oracle executes genuine code: seeded bugs fail and correct fixes pass', () => {
  const root = mkdtempSync(join(tmpdir(), 'jev-oracle-unit-'));
  try {
    for (const item of CASES_ACCEPTED.filter(item => item.role === 'implement')) {
      const module = join(root, `${item.id}.mjs`);
      const probe = join(root, `${item.id}.probe.mjs`);
      writeFileSync(probe, hiddenProbe(item.id, pathToFileURL(module).href, 'deterministic-unseen-value'));
      writeFileSync(module, item.files['solution.mjs']!);
      assert.throws(() => execFileSync(process.execPath, [probe], { timeout: 10_000, stdio: 'pipe', windowsHide: true }));
      writeFileSync(module, fixes[item.id]!);
      execFileSync(process.execPath, [probe], { timeout: 10_000, stdio: 'pipe', windowsHide: true });
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Bun child validates real linked Git fixtures, scope and stdin-only probes without models', { skip: !('bun' in process.versions) }, () => {
  const root = mkdtempSync(join(tmpdir(), 'jev-fixture-unit-'));
  const script = join(root, 'fixture-check.ts');
  const fixtureUrl = new URL('../../pi-subagents/integration/live-benchmark-fixtures.ts', import.meta.url).href;
  const suiteUrl = new URL('../bench/accepted-result-suite.ts', import.meta.url).href;
  const source = `import assert from 'node:assert/strict';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createFixture, checkFixture } from ${JSON.stringify(fixtureUrl)};
import { CASES_ACCEPTED } from ${JSON.stringify(suiteUrl)};
const fixes: Record<string,string> = ${JSON.stringify(fixes)};
for (const item of CASES_ACCEPTED.filter(item=>item.role==='implement')) {
 const fixture=createFixture(item);
 try {
  assert.equal(fixture.snapshot().passed,true);
  const initial=await checkFixture(item,fixture,'',process.execPath,'unit-probe');
  assert.equal(initial.hiddenPassed,false);
  writeFileSync(join(fixture.linked,'solution.mjs'),fixes[item.id]);
  const corrected=await checkFixture(item,fixture,'',process.execPath,'unit-probe');
  assert.equal(corrected.publicPassed,true);
  assert.equal(corrected.hiddenPassed,true);
  assert.equal(corrected.scopePassed,true);
  assert.equal(fixture.snapshot().parentUnchanged,true);
  writeFileSync(join(fixture.linked,'outside-scope.txt'),'unexpected');
  assert.equal(fixture.snapshot().passed,false);
  writeFileSync(join(fixture.linked,'solution.mjs'),'process.exit(0);');
  assert.equal((await checkFixture(item,fixture,'',process.execPath,'unit-probe')).hiddenPassed,false);
 } finally {rmSync(fixture.root,{recursive:true,force:true});}
}
console.log('fixture checks passed');
`;
  try {
    writeFileSync(script, source);
    assert.match(execFileSync(process.execPath, [script], { encoding: 'utf8', timeout: 30_000, windowsHide: true }), /fixture checks passed/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
