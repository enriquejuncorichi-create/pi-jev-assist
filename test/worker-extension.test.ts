import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { syntheticEvidence, syntheticProfile } from './worker-evidence.test.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadQualifications, qualificationKey } from '../src/worker-qualifications.js';
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { installWorkerRouting, checkWorkerBudget, WORKER_BYTE_BUDGET, type WorkerConfiguration } from '../src/worker-extension.js';
import { workerFailure } from '../src/worker-client.js';
import type { AssistService } from '../src/service.js';
import type { WorkerPolicy } from '../src/worker-task-contract.js';

function harness(overrides: Partial<WorkerConfiguration> = {}) {
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const busHandlers = new Map<string, (data: unknown) => void>();
  const calls: Array<{ channel: string; value: Record<string, unknown> }> = [];
  const entries: unknown[] = [];
  let execute: (id: string, args: unknown, signal: AbortSignal | undefined, update: unknown, ctx: ExtensionContext) => Promise<unknown>;
  let enabled = true;
  let thinkingLevel = 'low';
  let branch: unknown[] = [];
  let receiptExtra: Record<string, unknown> = {};
  let afterSpawn: (() => void) | undefined;
  const model = { provider: 'openai-codex', id: 'baseline', name: 'Baseline', api: 'openai-codex-responses', baseUrl: 'https://chatgpt.com/backend-api', contextWindow: 200000 };
  let available = [model];
  const pi = {
    on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(name, handler),
    appendEntry: (_name: string, data: unknown) => entries.push(data),
    getThinkingLevel: () => thinkingLevel,
    setModel: () => { throw new Error('Parent model must never be changed'); },
    setThinkingLevel: () => { throw new Error('Parent thinking must never be changed'); },
    registerTool: (tool: { execute: typeof execute }) => { execute = tool.execute; },
    events: {
      on: (channel: string, handler: (data: unknown) => void) => { busHandlers.set(channel, handler); return () => busHandlers.delete(channel); },
      emit: (channel: string, value: Record<string, unknown>) => {
        calls.push({ channel, value });
        const data = channel.endsWith(':ping') ? { capabilities: ['managed-workers-v1'] }
          : { handle: 'owned', agentId: 'agent', route: { provider: model.provider, model: model.id }, status: 'completed', sessionId: 'same-session', ...receiptExtra };
        busHandlers.get(`${channel}:reply:${value.requestId}`)?.({ success: true, data });
        if (channel.endsWith(':worker-spawn')) afterSpawn?.();
      },
    },
  } as unknown as ExtensionAPI;
  const ctx = { cwd: join(tmpdir(), 'jev-fixture'), model, sessionManager: { getSessionId: () => 'parent', getBranch: () => branch }, modelRegistry: {
    getAvailable: () => available, isUsingOAuth: () => true, getProvider: () => ({ auth: { oauth: { isSubscription: true } } }), getRegisteredProviderConfig: () => undefined, getRegisteredNativeProvider: () => undefined,
  }, hasUI: false } as unknown as ExtensionContext;
  const service: AssistService = { beginRun() {}, usage: () => ({ requests: 0, inputTokens: 0, outputTokens: 0, failures: 0 }), evaluate: async () => ({ ok: true, answers: { risk: { choice: 'routine', confidence: 0.95 }, roleFits: { noul: 0.99 }, freshContext: { noul: 0.1 }, taskFamily: { choice: 'uncovered', confidence: 0.99 }, needsVision: { noul: 0.01 }, needsReasoning: { noul: 0.01 } }, model: 'jev', elapsedMs: 1, usage: { input_tokens: 1, output_tokens: 0 } }) };
  const controls = installWorkerRouting(pi, service, { enabled: () => enabled, setEnabled: next => { enabled = next; }, exclusions: () => [], qualifications: () => [], ...overrides });
  return { calls, entries, controls, ctx, service, model, setThinking: (next: string) => { thinkingLevel = next; }, setBranch: (next: unknown[]) => { branch = next; }, setModels: (next: typeof model[]) => { available = next; }, setReceipt: (value: Record<string, unknown>) => { receiptExtra = value; }, afterSpawn: (callback: () => void) => { afterSpawn = callback; }, setEnabled: (next: boolean) => { enabled = next; }, emit: (name: string) => handlers.get(name)?.({}, ctx), run: (args: unknown) => execute('call', args, undefined, undefined, ctx) };
}

test('worker integration launches exact baseline and resumes related work without touching parent', async () => {
  const h = harness();
  await h.emit('session_start');
  await h.run({ action: 'start', role: 'scout', taskKey: 'caller-investigation', task: 'Find callers of quote()' });
  const spawn = h.calls.find(call => call.channel.endsWith(':worker-spawn'))!;
  assert.deepEqual(spawn.value.route, { provider: 'openai-codex', model: 'baseline' });
  assert.equal(spawn.value.access, 'read-only');
  assert.equal(spawn.value.thinkingLevel, 'low');
  await h.run({ action: 'start', role: 'scout', taskKey: 'caller-investigation', task: 'Now inspect the second caller' });
  assert.equal(h.calls.filter(call => call.channel.endsWith(':worker-spawn')).length, 1);
  assert.equal(h.calls.filter(call => call.channel.endsWith(':worker-resume')).length, 1);
  assert.equal((h.ctx.model as { id: string }).id, 'baseline');
});

test('resume refuses thinking-policy drift and permits a completed cold status without an error', async () => {
  const changed = harness();
  await changed.emit('session_start');
  changed.setThinking('high');
  await changed.run({ action: 'start', role: 'scout', taskKey: 'policy', task: 'Inspect source' });
  changed.setThinking('low');
  await assert.rejects(changed.run({ action: 'resume', handle: 'owned', task: 'Continue' }), /execution policy/);
  assert.equal(changed.calls.filter(call => call.channel.endsWith(':worker-resume')).length, 0);

  const restored = harness();
  await restored.emit('session_start');
  await restored.run({ action: 'start', role: 'scout', taskKey: 'cold', task: 'Inspect source' });
  restored.setBranch(restored.entries.filter(value => value !== null && typeof value === 'object' && 'receipt' in value)
    .map(data => ({ type: 'custom', customType: 'jev-worker-record', data })));
  await restored.emit('session_start');
  restored.setReceipt({ agentId: 'persisted-owned' });
  await restored.run({ action: 'resume', handle: 'owned', task: 'Continue' });
  assert.equal(restored.calls.filter(call => call.channel.endsWith(':worker-resume')).length, 1);
});

test('explicit null policy cannot widen into automatic routing', async () => {
  const h = harness({ policy: () => null as unknown as WorkerPolicy });
  await h.emit('session_start');
  await assert.rejects(h.run({ action: 'start', role: 'scout', taskKey: 'invalid-policy', task: 'Inspect source' }), /Invalid worker policy/);
  assert.equal(h.calls.length, 0);
});

test('foreign handles, disabled routing and navigated sessions never launch', async () => {
  const h = harness();
  await h.emit('session_start');
  await assert.rejects(h.run({ action: 'resume', handle: 'foreign', task: 'Do work' }), /foreign/);
  h.setEnabled(false);
  await assert.rejects(h.run({ action: 'start', task: 'Do work', role: 'scout', taskKey: 'task' }), /off/);
  h.setEnabled(true);
  await h.emit('session_tree');
  await assert.rejects(h.run({ action: 'start', task: 'Do work', role: 'scout', taskKey: 'task' }), /navigation/);
  assert.equal(h.calls.length, 0);
});

test('disable during classification cannot dispatch and disable after receipt stops late worker', async () => {
  const first = harness();
  await first.emit('session_start');
  const evaluate = first.service.evaluate;
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  first.service.evaluate = async (...args) => { await wait; return evaluate(...args); };
  const pending = first.run({ action: 'start', role: 'scout', taskKey: 'race', task: 'Inspect callers' });
  await first.controls.disable();
  release();
  await assert.rejects(pending, /cancelled/);
  assert.equal(first.calls.length, 0);

  const second = harness();
  await second.emit('session_start');
  second.afterSpawn(() => { void second.controls.disable(); });
  await assert.rejects(second.run({ action: 'start', role: 'scout', taskKey: 'race', task: 'Inspect callers' }), /stop requested/);
  assert.equal(second.calls.at(-1)!.channel, 'subagents:rpc:worker-stop');
  assert.equal(second.entries.length, 0);
});

test('context byte bounds never interpret lifetime usage as token occupancy', () => {
  assert.doesNotThrow(() => checkWorkerBudget(100, 200, 'Small follow-up'));
  assert.throws(() => checkWorkerBudget(undefined, 0, 'Legacy restored handle'), /unknown/);
  assert.throws(() => checkWorkerBudget(0, 0, 'é'.repeat(WORKER_BYTE_BUDGET / 2)), /byte budget/);
  assert.throws(() => checkWorkerBudget(1, WORKER_BYTE_BUDGET, 'Follow-up'), /fresh taskKey/);
  assert.throws(() => checkWorkerBudget(NaN, 0, 'Follow-up'));
});
test('failure categories are explicit and never masquerade as completion', () => {
  assert.equal(workerFailure({ status: 'failed', error: '429 quota exceeded' }), 'quota');
  assert.equal(workerFailure({ status: 'failed', error: 'context window exhausted' }), 'context-exhaustion');
  assert.equal(workerFailure({ status: 'cancelled' }), 'cancellation');
  assert.equal(workerFailure({ status: 'failed', error: 'Upstream unavailable' }), 'provider-failure');
  assert.equal(workerFailure({ status: 'completed' }), undefined);
});
test('controls reject non-interactive context, including qualification import', async () => {
  const h = harness();
  await h.emit('session_start');
  for (const args of [['qualification', 'import', 'untrusted.json'], ['on'], ['exclude', 'openai-codex/baseline']]) {
    await assert.rejects(h.controls.command(args, h.ctx as ExtensionCommandContext), /interactive/);
  }
  assert.equal(h.calls.length, 0);
});
test('concurrent classification cannot create overlapping dispatches', async () => {
  const h = harness();
  await h.emit('session_start');
  const evaluate = h.service.evaluate;
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  h.service.evaluate = async (...args) => { await wait; return evaluate(...args); };
  const args = { action: 'start', role: 'scout', taskKey: 'same', task: 'Inspect callers' };
  const pending = h.run(args);
  await assert.rejects(h.run(args), /pending/);
  release();
  await pending;
  assert.equal(h.calls.filter(call => call.channel.endsWith(':worker-spawn')).length, 1);
});

test('resume stops at observed result budget and failure instead of replaying or changing route', async () => {
  for (const receipt of [{ result: 'x'.repeat(WORKER_BYTE_BUDGET) }, { status: 'failed', error: 'quota exhausted' }]) {
    const h = harness();
    await h.emit('session_start');
    await h.run({ action: 'start', role: 'scout', taskKey: 'bound', task: 'Inspect callers' });
    h.setReceipt(receipt);
    await assert.rejects(h.run({ action: 'resume', handle: 'owned', task: 'Continue' }), /byte budget|quota/);
    assert.equal(h.calls.filter(call => call.channel.endsWith(':worker-resume')).length, 0);
    assert.equal(h.calls.filter(call => call.channel.endsWith(':worker-spawn')).length, 1);
  }
});
test('interactive qualification trust requires explicit confirmation, supports revocation and exact exclusions', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jev-control-test-')));
  const source = join(dir, 'profile.json'), store = join(dir, 'store.json');
  const evidence = syntheticEvidence();
  writeFileSync(join(dir, 'evidence.txt'), evidence);
  writeFileSync(source, JSON.stringify(syntheticProfile(evidence)));
  let excluded: string[] = [], accepted = false, confirmations = 0;
  const h = harness({ qualificationStorePath: store, exclusions: () => excluded, setExclusions: value => { excluded = value; } });
  await h.emit('session_start');
  const ctx = { ...h.ctx, hasUI: true, ui: { confirm: async () => { confirmations++; return accepted; }, notify() {} } } as unknown as ExtensionCommandContext;
  await h.controls.command(['qualification', 'import', source], ctx);
  assert.equal(confirmations, 1);
  assert.deepEqual(loadQualifications(store), []);
  accepted = true;
  await h.controls.command(['qualification', 'import', source], ctx);
  assert.equal(confirmations, 2);
  const trusted = loadQualifications(store);
  assert.equal(trusted.length, 1);
  await h.controls.command(['qualification', 'revoke', qualificationKey(trusted[0]!)], ctx);
  assert.deepEqual(loadQualifications(store), []);
  await assert.rejects(h.controls.command(['exclude', 'baseline'], ctx), /exact/);
  await h.controls.command(['exclude', 'openai-codex/baseline'], ctx);
  assert.deepEqual(excluded, ['openai-codex/baseline']);
  await h.controls.command(['include', 'openai-codex/baseline'], ctx);
  assert.deepEqual(excluded, []);
});

test('task-qualified cross-provider choice reaches the exact worker RPC without changing parent', async () => {
  let policy: WorkerPolicy = { mode: 'automatic' };
  const route = { provider: 'xai', model: 'grok-fixture' };
  const h = harness({ policy: () => policy, setPolicy: next => { policy = next; }, qualifications: () => [{
    route, baseline: { provider: 'openai-codex', model: 'baseline' }, roles: ['scout'],
    evidenceRef: 'test-only', suiteHash: 'a'.repeat(64), expiresAt: Date.now() + 60000,
    qualityPassed: true, endToEnd: true, medianAcceptedMs: 500, baselineMedianAcceptedMs: 1000,
    taskEvidence: [{ family: 'source-impact-location', acceptedSamples: 4, medianAcceptedMs: 500, baselineMedianAcceptedMs: 1000 }],
  }] });
  h.setModels([h.model, { ...h.model, provider: route.provider, id: route.model, api: 'openai-responses', baseUrl: 'https://api.x.ai/v1' }]);
  h.setReceipt({ route });
  const evaluate = h.service.evaluate;
  h.service.evaluate = async (...args) => {
    const result = await evaluate(...args);
    return result.ok ? { ...result, answers: { ...result.answers, taskFamily: { choice: 'source-impact-location', confidence: 0.99 } } } : result;
  };
  await h.emit('session_start');
  const ctx = { ...h.ctx, hasUI: true, ui: { notify() {} } } as unknown as ExtensionCommandContext;
  await h.controls.command(['policy', 'prefer-other-provider'], ctx);
  await h.run({ action: 'start', role: 'scout', taskKey: 'impact', task: 'Locate source callers', minimumContext: 64000 });
  const spawn = h.calls.find(call => call.channel.endsWith(':worker-spawn'))!;
  assert.deepEqual(spawn.value.route, route);
  assert.equal(spawn.value.thinkingLevel, 'low');
  assert.equal(spawn.value.maxTurns, 12);
  assert.equal(h.ctx.model?.id, 'baseline');
  await h.controls.command(['policy', 'allowlist', 'xai/unavailable'], ctx);
  const before = h.calls.length;
  await assert.rejects(h.run({ action: 'start', role: 'scout', taskKey: 'refused', task: 'Locate source callers' }), /no fallback|allowlist|eligible/i);
  assert.equal(h.calls.length, before);
  await assert.rejects(h.controls.command(['policy', 'allowlist'], ctx), /allowlist/i);
  assert.deepEqual(policy, { mode: 'allowlist', routes: ['xai/unavailable'] });
});

test('ambiguous capability judgement and oversized context do not reach worker RPC', async () => {
  const h = harness();
  await h.emit('session_start');
  await assert.rejects(h.run({ action: 'start', role: 'scout', taskKey: 'large', task: 'Locate callers', minimumContext: 300000 }), /eligible|fallback/i);
  const evaluate = h.service.evaluate;
  h.service.evaluate = async (...args) => {
    const result = await evaluate(...args);
    return result.ok ? { ...result, answers: { ...result.answers, needsVision: { noul: 0.5 } } } : result;
  };
  await assert.rejects(h.run({ action: 'start', role: 'scout', taskKey: 'unknown', task: 'Inspect source' }), /capabilities/);
  assert.equal(h.calls.length, 0);
});

test('rubric choice reaches exact xai RPC, with unchanged parent thinking and model', async () => {
  const h = harness({ routingMode: () => 'rubric', routeRubrics: () => [{ route: { provider: 'xai', model: 'grok-fixture' }, role: 'scout', use_when: 'Locate source impact', not_for: 'Visual tasks', boundary: 'Read-only' }] });
  const xai = { ...h.model, provider: 'xai', id: 'grok-fixture', api: 'openai-responses', baseUrl: 'https://api.x.ai/v1' };
  h.setModels([h.model, xai]); h.setReceipt({ route: { provider: 'xai', model: 'grok-fixture' } });
  const original = h.service.evaluate;
  let requests = 0;
  h.service.evaluate = async (request, signal) => {
    requests++;
    if (requests === 2) {
      assert.deepEqual(Object.keys(request.questions), ['routeChoice']);
      assert.match(JSON.stringify(request), /Locate source impact/);
      assert.ok(Buffer.byteLength(JSON.stringify(request)) <= 12000);
      return { ok: true, answers: { routeChoice: { choice: 'm1', confidence: 0.98 } }, model: 'jev', elapsedMs: 1, usage: { input_tokens: 1, output_tokens: 1 } };
    }
    return original(request, signal);
  };
  await h.emit('session_start');
  await h.run({ action: 'start', role: 'scout', taskKey: 'rubric', task: 'Locate callers' });
  assert.equal(requests, 2);
  assert.deepEqual(h.calls.find(c => c.channel.endsWith(':worker-spawn'))!.value.route, { provider: 'xai', model: 'grok-fixture' });
  assert.equal(h.calls.find(c => c.channel.endsWith(':worker-spawn'))!.value.thinkingLevel, 'low');
  assert.equal(h.ctx.model?.id, 'baseline');
});

test('rubric route fails closed on high risk, exclusion, strict allowlist, paid provider and changed eligibility', async () => {
  for (const variant of ['high', 'excluded', 'allowlist', 'paid', 'changed']) {
    let excluded: string[] = [];
    const h = harness({ routingMode: () => 'rubric', exclusions: () => excluded,
      routeRubrics: () => [{ route: { provider: 'xai', model: 'grok-fixture' }, role: 'scout', use_when: 'Bounded source location', not_for: 'Research', boundary: 'Read-only' }],
      policy: () => variant === 'allowlist' ? { mode: 'allowlist', routes: ['xai/grok-fixture'] } : { mode: 'automatic' } });
    const xai = { ...h.model, provider: 'xai', id: 'grok-fixture', api: 'openai-responses', baseUrl: 'https://api.x.ai/v1' };
    h.setModels([h.model, variant === 'paid' ? { ...xai, provider: 'anthropic' } : xai]);
    if (variant === 'excluded') excluded = ['xai/grok-fixture'];
    const original = h.service.evaluate;
    let calls = 0;
    h.service.evaluate = async (request, signal) => {
      calls++;
      if (calls === 1) {
        const result = await original(request, signal);
        return variant === 'high' && result.ok ? { ...result, answers: { ...result.answers, risk: { choice: 'high', confidence: 0.99 } } } : result;
      }
      const options = (request.state as { options: Record<string, unknown> }).options;
      if (variant !== 'allowlist') assert.equal(JSON.stringify(options).includes('"model":"grok-fixture"'), variant === 'changed');
      if (variant === 'changed') excluded = ['xai/grok-fixture'];
      return { ok: true, answers: { routeChoice: { choice: 'm1', confidence: 0.99 } }, model: 'jev', elapsedMs: 1, usage: { input_tokens: 1, output_tokens: 1 } };
    };
    await h.emit('session_start');
    const run = h.run({ action: 'start', role: 'scout', taskKey: variant, task: 'Locate callers' });
    if (variant === 'allowlist' || variant === 'changed') await assert.rejects(run, /fallback|cancelled/);
    else await run;
    const spawns = h.calls.filter(c => c.channel.endsWith(':worker-spawn'));
    if (variant === 'allowlist' || variant === 'changed') assert.equal(spawns.length, 0);
    else assert.deepEqual(spawns[0]!.value.route, { provider: 'openai-codex', model: 'baseline' });
  }
});

test('rubric invalid, abstained and unavailable choices use only eligible baseline', async () => {
  for (const answer of [{ choice: 'm99', confidence: 1 }, { choice: 'abstain', confidence: 1 }, { choice: 'm1', confidence: 0.7 }, null]) {
    const h = harness({ routingMode: () => 'rubric' });
    h.setModels([h.model, { ...h.model, provider: 'xai', id: 'grok-fixture', api: 'openai-responses', baseUrl: 'https://api.x.ai/v1' }]);
    const original = h.service.evaluate;
    let n = 0;
    h.service.evaluate = async (request, signal) => ++n === 1 ? original(request, signal) : answer === null
      ? { ok: false, reason: 'timeout' } : { ok: true, answers: { routeChoice: answer }, model: 'jev', elapsedMs: 1, usage: { input_tokens: 0, output_tokens: 0 } };
    await h.emit('session_start');
    await h.run({ action: 'start', role: 'scout', taskKey: 'fallback', task: 'Locate callers' });
    assert.deepEqual(h.calls.find(c => c.channel.endsWith(':worker-spawn'))!.value.route, { provider: 'openai-codex', model: 'baseline' });
  }
});

test('write capability is requested only for implementation and shutdown stops owned worker', async () => {
  const h = harness();
  await h.emit('session_start');
  await h.run({ action: 'start', task: 'Implement a bounded fix', role: 'implement', taskKey: 'fix', cwd: join(tmpdir(), 'jev-external-worktree') });
  assert.equal(h.calls.find(call => call.channel.endsWith(':worker-spawn'))!.value.access, 'write');
  await h.emit('session_shutdown');
  assert.equal(h.calls.at(-1)!.channel, 'subagents:rpc:worker-stop');
});
