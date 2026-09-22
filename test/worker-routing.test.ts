import test from 'node:test';
import assert from 'node:assert/strict';
import { TASK_FAMILIES, type WorkerTaskContract } from '../src/worker-task-contract.js';
import { discoverWorkerRoutes, parseQualification, parseRouteRubrics, rubricCandidates, selectRubricRoute, selectWorker, workerRouteChoiceRequest, workerJudgementRequest, type RoutingModel, type RoutingRegistry, type Qualification } from '../src/worker-routing.js';

const main = { provider: 'openai-codex', model: 'main' };
const fast = { provider: 'openai-codex', model: 'fast' };
const models: RoutingModel[] = [main, fast].map(route => ({ provider: route.provider, id: route.model, name: route.model, api: 'openai-codex-responses', baseUrl: 'https://chatgpt.com/backend-api', contextWindow: 200_000 }));
function registry(overrides: Partial<RoutingRegistry> = {}): RoutingRegistry {
  return { getAvailable: () => models, isUsingOAuth: () => true, getProvider: () => ({ auth: { oauth: { isSubscription: true } } }), getRegisteredProviderConfig: () => undefined, getRegisteredNativeProvider: () => undefined, ...overrides };
}
const answers = { risk: { choice: 'routine', confidence: 0.95 }, roleFits: { noul: 0.99 }, freshContext: { noul: 0.1 } };
const scoped = (medianAcceptedMs = 500, baselineMedianAcceptedMs = 1000) => [{ family: 'source-impact-location' as const, acceptedSamples: 3, medianAcceptedMs, baselineMedianAcceptedMs }];
const proof: Qualification = { route: fast, baseline: main, roles: ['scout'], evidenceRef: 'test-fixture-only', suiteHash: 'a'.repeat(64), expiresAt: 2000, qualityPassed: true, endToEnd: true, medianAcceptedMs: 500, baselineMedianAcceptedMs: 1000, taskEvidence: scoped() };
function options() {
  return { task: { family: 'source-impact-location', requiredCapabilities: [] } as WorkerTaskContract, role: 'scout' as const, answers, baseline: main, available: discoverWorkerRoutes(registry()), qualifications: [] as Qualification[], workspace: '/repo', minimumContext: 8000, now: 1000 };
}

test('rubric schema, deterministic IDs and option limit refuse invalid or oversized requests', () => {
  assert.deepEqual(parseRouteRubrics([{ route: fast, role: 'scout', use_when: 'Locate callers', not_for: 'Visual work', boundary: 'Read only' }]).length, 1);
  for (const value of [[{ route: fast, role: 'scout', use_when: '', not_for: 'x', boundary: 'x' }],
    [{ route: fast, role: 'scout', use_when: 'x', not_for: 'x', boundary: 'x', extra: true }],
    Array(2).fill({ route: fast, role: 'scout', use_when: 'x', not_for: 'x', boundary: 'x' })]) assert.throws(() => parseRouteRubrics(value));
  const candidates = rubricCandidates({ ...options(), task: options().task, policy: { mode: 'automatic' }, rubrics: [] }).candidates;
  const unconfigured = workerRouteChoiceRequest('Locate callers', 'scout', main, candidates, []);
  assert.deepEqual([...unconfigured.routes.values()], [main]); // Unknown alternatives are not guessed into a rubric.
  for (const route of [{ provider: 'xai', model: 'not-grok-4.7' }, { provider: 'xai', model: 'gpt-6-astra' }, { provider: 'openai-codex', model: 'gpt-6-astra-next' }]) {
    const attempt = workerRouteChoiceRequest('Locate callers', 'scout', main, [...candidates, { ...candidates[0]!, route }], []);
    assert.ok(![...attempt.routes.values()].some(value => value.provider === route.provider && value.model === route.model));
  }
  const choice = workerRouteChoiceRequest('Locate callers', 'scout', main, candidates, [{ route: fast, role: 'scout', use_when: 'Locate callers', not_for: 'Visual work', boundary: 'Read only' }]);
  assert.deepEqual([...choice.routes.keys()], ['m0', 'm1']);
  assert.deepEqual(selectRubricRoute({ choice: 'm0', confidence: 0.9 }, choice.routes, main), fast);
  assert.deepEqual(selectRubricRoute({ choice: 'm0', confidence: 0.79 }, choice.routes, main), main);
  assert.throws(() => workerRouteChoiceRequest('x', 'scout', main, Array(17).fill(candidates[0]), []), /16/);
  assert.throws(() => workerRouteChoiceRequest('x'.repeat(6000), 'scout', main, Array(16).fill({ ...candidates[0], name: 'x'.repeat(1000) }), []), /12k/);
});

test('catalogue discovery rejects API-key, third-party, non-native and excluded routes', () => {
  assert.ok(discoverWorkerRoutes(registry()).every(item => item.eligible));
  assert.ok(discoverWorkerRoutes(registry({ isUsingOAuth: () => false })).every(item => !item.eligible));
  assert.ok(discoverWorkerRoutes(registry({ getRegisteredProviderConfig: () => ({}) })).every(item => !item.eligible));
  assert.ok(discoverWorkerRoutes(registry({ getAvailable: () => [{ ...models[0]!, baseUrl: 'https://evil.invalid' }] })).every(item => !item.eligible));
  assert.equal(discoverWorkerRoutes(registry(), ['openai-codex/fast'])[1]!.eligible, false);
  assert.equal(discoverWorkerRoutes(registry({ getAvailable: () => [{ ...models[0]!, provider: 'anthropic' }] }))[0]!.eligible, false);
});

test('no benchmark evidence means the explicitly reported main-model baseline, not guessed tiers', () => {
  const result = selectWorker(options());
  assert.deepEqual(result.route, main);
  assert.match(result.reason, /baseline/);
  assert.equal(selectWorker({ ...options(), qualifications: [{ ...proof, endToEnd: false }] }).route.model, 'main');
  assert.equal(selectWorker({ ...options(), qualifications: [{ ...proof, expiresAt: 1000 }] }).route.model, 'main');
});

test('qualified alternative and task-affine resume preserve exact route', () => {
  assert.deepEqual(selectWorker({ ...options(), qualifications: [proof] }).route, fast);
  const affinity = { handle: 'owned-handle', route: main, role: 'scout' as const, workspace: '/repo' };
  const result = selectWorker({ ...options(), qualifications: [proof], affinity });
  assert.deepEqual(result.route, main);
  assert.equal(result.resumeHandle, 'owned-handle');
  assert.equal(selectWorker({ ...options(), affinity: { ...affinity, workspace: '/different' } }).resumeHandle, undefined);
  assert.equal(selectWorker({ ...options(), affinity, answers: { ...answers, freshContext: { noul: 0.9 } } }).resumeHandle, undefined);
});

test('high-risk and unassessable work never silently downgrade', () => {
  assert.deepEqual(selectWorker({ ...options(), qualifications: [proof], answers: { ...answers, risk: { choice: 'high', confidence: 0.9 } } }).route, main);
  assert.throws(() => selectWorker({ ...options(), answers: {} }), /abstained/);
  assert.throws(() => selectWorker({ ...options(), answers: { ...answers, risk: { choice: 'routine' } } }), /abstained/);
  assert.throws(() => selectWorker({ ...options(), explicitRoute: fast }), /no fallback/);
  assert.throws(() => selectWorker({ ...options(), available: [] }), /no fallback/);
  assert.throws(() => selectWorker({ ...options(), minimumContext: 300_000 }), /no fallback/);
});

test('runtime qualification parsing rejects malformed, non-finite, stale, foreign baseline and role mismatches', () => {
  for (const value of [null, [], {}, { ...proof, roles: 'scout' }, { ...proof, roles: ['research'] }, { ...proof, qualityPassed: 'true' }, { ...proof, route: null }, { ...proof, baseline: fast }, { ...proof, expiresAt: Infinity }, { ...proof, medianAcceptedMs: NaN }, { ...proof, medianAcceptedMs: -1 }, { ...proof, expiresAt: 900 }, { ...proof, suiteHash: 'invalid' }]) {
    assert.deepEqual(selectWorker({ ...options(), qualifications: [value] as Qualification[] }).route, main);
  }
  assert.deepEqual(selectWorker({ ...options(), qualifications: [{ ...proof, taskEvidence: scoped(600, 400) }] }).route, main);
  assert.throws(() => selectWorker({ ...options(), qualifications: [proof], explicitRoute: fast, answers: { ...answers, risk: { choice: 'high', confidence: 0.99 } } }), /no fallback/);
});

test('each candidate uses its own paired baseline, independent of unavailable or unrelated proofs', () => {
  const unrelated = { ...proof, route: { provider: 'xai', model: 'unrelated' }, medianAcceptedMs: 900, baselineMedianAcceptedMs: 100, taskEvidence: scoped(900, 100) };
  const base = { ...options(), qualifications: [proof] };
  assert.deepEqual(selectWorker(base).route, fast);
  assert.deepEqual(selectWorker({ ...base, qualifications: [proof, unrelated] }).route, fast);
  const withUnrelated = [...base.available, { route: unrelated.route, name: 'unrelated', contextWindow: 200_000, eligible: true, reason: 'synthetic' }];
  assert.deepEqual(selectWorker({ ...base, available: withUnrelated, qualifications: [proof, unrelated] }).route, fast);
  assert.deepEqual(selectWorker({ ...base, qualifications: [{ ...proof, taskEvidence: undefined }] }).route, main);
  assert.deepEqual(selectWorker({ ...base, qualifications: [{ ...proof, taskEvidence: scoped(500, 500) }] }).route, main);
  assert.deepEqual(selectWorker({ ...base, qualifications: [{ ...proof, taskEvidence: scoped(500, 400) }] }).route, main);
});

test('bounded classification does not include provider credentials or invent routing instructions', () => {
  const request = workerJudgementRequest('Find callers of price()', 'scout');
  assert.deepEqual(Object.keys(request.questions), ['risk', 'roleFits', 'freshContext', 'taskFamily', 'needsVision', 'needsReasoning']);
  for (const scope of Object.values(TASK_FAMILIES)) assert.ok(JSON.stringify(request.questions.taskFamily).includes(scope.description));
  assert.throws(() => workerJudgementRequest('', 'scout'));
  assert.throws(() => workerJudgementRequest('x'.repeat(12001), 'scout'));
});

test('same role selects different routes for different families, never pooled medians', () => {
  const other = { provider: 'xai', model: 'other' };
  const families = ['exact-match-filtering', 'failure-state-handling'] as const;
  const evidence = (times: number[]) => families.map((family, i) => ({ family, acceptedSamples: 2, medianAcceptedMs: times[i]!, baselineMedianAcceptedMs: 1000 }));
  const base = { ...options(), role: 'implement' as const, available: [...options().available, { route: other, name: 'other', contextWindow: 9000, eligible: true, reason: 'fixture' }], qualifications: [
    { ...proof, roles: ['implement'] as Qualification['roles'], taskEvidence: evidence([100, 800]), medianAcceptedMs: 9999 },
    { ...proof, route: other, roles: ['implement'] as Qualification['roles'], taskEvidence: evidence([800, 100]), medianAcceptedMs: 1 },
  ] };
  assert.deepEqual(selectWorker({ ...base, task: { family: families[0], requiredCapabilities: [] } }).route, fast);
  assert.deepEqual(selectWorker({ ...base, task: { family: families[1], requiredCapabilities: [] } }).route, other);
  assert.deepEqual(selectWorker({ ...base, task: { family: 'session-state-preservation', requiredCapabilities: [] } }).route, main);
});

test('missing or uncovered task and missing scoped proof cannot qualify alternatives', () => {
  for (const task of [undefined, { family: 'uncovered' as const, requiredCapabilities: [] }]) {
    assert.deepEqual(selectWorker({ ...options(), task, qualifications: [proof] }).route, main);
    assert.throws(() => selectWorker({ ...options(), task, qualifications: [proof], explicitRoute: fast }), /no fallback/);
  }
  for (const taskEvidence of [undefined, []]) assert.deepEqual(selectWorker({ ...options(), qualifications: [{ ...proof, taskEvidence }] }).route, main);
  assert.deepEqual(selectWorker({ ...options(), qualifications: [{ ...proof, baselineMedianAcceptedMs: undefined }] }).route, fast);
});

test('malformed scoped evidence rejects the whole proof', () => {
  assert.deepEqual(parseQualification(proof)?.taskEvidence, scoped());
  for (const taskEvidence of [null, {}, [null], [scoped()[0], scoped()[0]],
    [{ ...scoped()[0], family: 'uncovered' }], [{ ...scoped()[0], family: 'exact-match-filtering' }],
    ...[0, -1, 1.5, NaN, Infinity, '2'].map(acceptedSamples => [{ ...scoped()[0], acceptedSamples }]),
    ...[0, -1, NaN, Infinity, '2'].flatMap(value => [
      [{ ...scoped()[0], medianAcceptedMs: value }], [{ ...scoped()[0], baselineMedianAcceptedMs: value }],
    ]),
  ]) assert.equal(parseQualification({ ...proof, taskEvidence }), undefined);
});

test('task and explicit-route boundaries fail closed', () => {
  for (const task of [{}, [], { family: 'unknown', requiredCapabilities: [] }, { family: 'exact-match-filtering', requiredCapabilities: [] },
    { family: 'source-impact-location', requiredCapabilities: ['image', 'image'] },
    { family: 'source-impact-location', requiredCapabilities: ['tools'] }, { family: 'source-impact-location', requiredCapabilities: null }]) {
    assert.throws(() => selectWorker({ ...options(), task: task as WorkerTaskContract }), /task contract/);
  }
  assert.throws(() => selectWorker({ ...options(), explicitRoute: { ...main, extra: true } as typeof main }), /Invalid explicit route/);
  assert.throws(() => selectWorker({ ...options(), policy: { mode: 'allowlist', routes: [] } }), /policy/);
});

test('context and required capabilities are hard filters, including unknown metadata', () => {
  const available = discoverWorkerRoutes(registry({ getAvailable: () => models.map(model => ({ ...model, input: ['text', 'image'], reasoning: true })) }));
  assert.deepEqual(available[0]!.input, ['text', 'image']);
  assert.equal(available[0]!.reasoning, true);
  const visual: WorkerTaskContract = { family: 'source-impact-location', requiredCapabilities: ['image', 'reasoning'] };
  assert.deepEqual(selectWorker({ ...options(), task: visual, available, qualifications: [proof] }).route, main, 'text evidence cannot qualify visual work');
  assert.throws(() => selectWorker({ ...options(), task: visual, available, qualifications: [proof], explicitRoute: fast }), /no fallback/);
  for (const input of [undefined, ['text']]) {
    assert.throws(() => selectWorker({ ...options(), task: visual, available: available.map(item => ({ ...item, input })), qualifications: [proof] }), /no fallback/);
  }
  const task: WorkerTaskContract = { family: 'source-impact-location', requiredCapabilities: ['reasoning'] };
  assert.deepEqual(selectWorker({ ...options(), task, available, qualifications: [proof] }).route, fast);
  assert.throws(() => selectWorker({ ...options(), task, qualifications: [proof] }), /no fallback/);
  for (const metadata of [{ reasoning: undefined }, { reasoning: false }, { contextWindow: undefined }, { contextWindow: 7999 }]) {
    const filtered = available.map(item => item.route.model === 'fast' ? { ...item, ...metadata } : item) as typeof available;
    assert.deepEqual(selectWorker({ ...options(), task, available: filtered, qualifications: [proof] }).route, main);
    assert.throws(() => selectWorker({ ...options(), task, available: filtered, qualifications: [proof], explicitRoute: fast }), /no fallback/);
  }
});

test('soft other-provider preference precedes affinity and retains affinity within its pool', () => {
  const other = { provider: 'xai', model: 'other' };
  const otherFast = { provider: 'xai', model: 'other-fast' };
  const base = { ...options(), policy: { mode: 'prefer-other-provider' as const }, available: [...options().available, ...[other, otherFast].map(route => ({ route, name: route.model, contextWindow: 9000, eligible: true, reason: 'fixture' }))], qualifications: [proof, { ...proof, route: other, taskEvidence: scoped(800) }, { ...proof, route: otherFast, taskEvidence: scoped(700) }] };
  const affinity = { handle: 'owned', route: fast, role: 'scout' as const, workspace: '/repo' };
  assert.deepEqual(selectWorker({ ...base, affinity }).route, otherFast);
  const retained = selectWorker({ ...base, affinity: { ...affinity, route: other } });
  assert.deepEqual(retained.route, other);
  assert.equal(retained.resumeHandle, 'owned');
  assert.deepEqual(selectWorker({ ...base, affinity: { ...affinity, route: other }, answers: { ...answers, freshContext: { noul: 0.9 } } }).route, otherFast);
  assert.deepEqual(selectWorker({ ...base, explicitRoute: fast }).route, fast);
  const fallback = selectWorker({ ...base, qualifications: [proof, { ...proof, route: other, taskEvidence: scoped(1000) }] });
  assert.deepEqual(fallback.route, fast);
  assert.match(fallback.reason, /no eligible other-provider improvement/);
  assert.deepEqual(selectWorker({ ...base, qualifications: base.qualifications.map(p => ({ ...p, expiresAt: 999 })) }).route, main);
});

test('strict allowlists never escape exclusions, unavailable routes, uncovered tasks or high risk', () => {
  const policy = { mode: 'allowlist' as const, routes: ['openai-codex/fast'] };
  const base = { ...options(), policy, qualifications: [proof] };
  assert.deepEqual(selectWorker(base).route, fast);
  assert.throws(() => selectWorker({ ...base, explicitRoute: main }), /no fallback/);
  for (const changes of [
    { qualifications: [] }, { available: [] }, { task: undefined },
    { available: discoverWorkerRoutes(registry(), ['openai-codex/fast']) },
    { answers: { ...answers, risk: { choice: 'high', confidence: 0.99 } } },
    { policy: { mode: 'allowlist' as const, routes: ['xai/unavailable'] } },
  ]) assert.throws(() => selectWorker({ ...base, ...changes }), /no fallback/);
  assert.deepEqual(selectWorker({ ...base, policy: { mode: 'allowlist', routes: ['openai-codex/main'] } }).route, main);
});
