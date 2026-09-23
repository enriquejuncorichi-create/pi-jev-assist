import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkerClient, type WorkerBus } from '../src/worker-client.js';

function busHarness(respond: (channel: string, payload: Record<string, unknown>, reply: (value: unknown) => void) => void) {
  const listeners = new Map<string, (data: unknown) => void>();
  const calls: Array<{ channel: string; payload: Record<string, unknown> }> = [];
  const bus: WorkerBus = {
    on: (channel, listener) => { listeners.set(channel, listener); return () => { listeners.delete(channel); }; },
    emit: (channel, value) => {
      const payload = value as Record<string, unknown>;
      calls.push({ channel, payload });
      respond(channel, payload, result => listeners.get(`${channel}:reply:${payload.requestId}`)?.(result));
    },
  };
  return { bus, calls, listeners };
}
const route = { provider: 'openai-codex', model: 'test' };
const input = { type: 'general-purpose', prompt: 'Inspect fixtures', route, cwd: '/repo', access: 'read-only' as const };
const data = { handle: 'opaque', agentId: 'worker-1', route, status: 'running', sessionId: 'stable' };

test('client subscribes before dispatch and requires the managed capability', async () => {
  const h = busHarness((channel, _payload, reply) => reply({ success: true, data: channel.endsWith(':ping') ? { capabilities: ['managed-workers-v1'] } : data }));
  const result = await new WorkerClient(h.bus).spawn(input);
  assert.equal(result.sessionId, 'stable');
  assert.deepEqual(h.calls[1]!.payload.route, route);
  assert.equal(h.calls[1]!.payload.cwd, '/repo');
  assert.equal(h.listeners.size, 0);
  const old = busHarness((_channel, _payload, reply) => reply({ success: true, data: { version: 2 } }));
  await assert.rejects(new WorkerClient(old.bus).spawn(input), /lacks managed/);
  assert.equal(old.calls.length, 1);
});

test('mismatched route requests stop and fails rather than silently accepting it', async () => {
  const h = busHarness((channel, _payload, reply) => reply({ success: true, data: channel.endsWith(':ping') ? { capabilities: ['managed-workers-v1'] } : { ...data, route: { provider: 'metered', model: 'test' } } }));
  await assert.rejects(new WorkerClient(h.bus).spawn(input), /different route/);
  assert.equal(h.calls.at(-1)!.channel, 'subagents:rpc:worker-stop');
});

test('timeout aborts forwarded signal and removes listener', async () => {
  const h = busHarness(() => {});
  await assert.rejects(new WorkerClient(h.bus, 10).available(), /timed out/);
  assert.equal((h.calls[0]!.payload.signal as AbortSignal).aborted, true);
  assert.equal(h.listeners.size, 0);
});

test('caller cancellation and disposal abort outstanding requests', async () => {
  const h = busHarness(() => {});
  const client = new WorkerClient(h.bus);
  const controller = new AbortController();
  const waiting = client.available(controller.signal);
  controller.abort();
  await assert.rejects(waiting, /cancelled/);
  const second = client.available();
  client.dispose();
  await assert.rejects(second, /cancelled/);
  const count = h.calls.length;
  await assert.rejects(client.available(), /ended session/);
  assert.equal(h.calls.length, count);
  assert.equal(h.listeners.size, 0);
});

test('malformed receipts and runner errors are not successful workers', async () => {
  const h = busHarness((_channel, _payload, reply) => reply({ success: true, data: { status: 'completed' } }));
  await assert.rejects(new WorkerClient(h.bus).status('opaque'), /Malformed/);
  const failure = busHarness((_channel, _payload, reply) => reply({ success: false, error: 'foreign handle' }));
  await assert.rejects(new WorkerClient(failure.bus).status('opaque'), /foreign handle/);
});
