import { randomUUID } from 'node:crypto';
import { parseRoute, type Route } from './worker-routing.js';

export interface WorkerBus {
  on(channel: string, listener: (data: unknown) => void): () => void;
  emit(channel: string, data: unknown): void;
}
export interface WorkerReceipt {
  handle: string; agentId: string; route: Route; status: string;
  sessionId?: string; result?: string; error?: string; usage?: unknown;
}
export type WorkerFailure = 'quota' | 'context-exhaustion' | 'cancellation' | 'provider-failure';
/** Classification is descriptive only; no category triggers a retry or fallback. */
export function workerFailure(receipt: Pick<WorkerReceipt, 'status' | 'error'>): WorkerFailure | undefined {
  const text = `${receipt.status} ${receipt.error ?? ''}`;
  if (/cancel|abort|stopped|killed/i.test(text)) return 'cancellation';
  if (/context.{0,24}(?:length|window|limit|exceed|exhaust)|too many tokens|maximum.{0,16}tokens/i.test(text)) return 'context-exhaustion';
  if (/quota|rate.?limit|usage.?limit|429|capacity/i.test(text)) return 'quota';
  if (receipt.error || /fail|error|timeout/i.test(receipt.status)) return 'provider-failure';
  return undefined;
}
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
export function parseWorkerReceipt(value: unknown): WorkerReceipt {
  const data = object(value);
  const route = parseRoute(data?.route);
  if (!data || typeof data.handle !== 'string' || !data.handle || typeof data.agentId !== 'string' || !data.agentId
    || typeof data.status !== 'string' || !route) throw new Error('Malformed managed worker receipt');
  return {
    handle: data.handle, agentId: data.agentId, status: data.status,
    route: { provider: route.provider, model: route.model },
    ...(typeof data.sessionId === 'string' ? { sessionId: data.sessionId } : {}),
    ...(typeof data.result === 'string' ? { result: data.result } : {}),
    ...(typeof data.error === 'string' ? { error: data.error } : {}),
    ...(data.usage !== undefined ? { usage: data.usage } : {}),
  };
}

/** No global registry imports: the runner must advertise the exact contract. */
export class WorkerClient {
  private readonly pending = new Set<AbortController>();
  private disposed = false;
  constructor(private readonly bus: WorkerBus, private readonly timeoutMs = 15_000) {}

  dispose(): void {
    this.disposed = true;
    for (const controller of this.pending) controller.abort();
    this.pending.clear();
  }

  private request(method: string, fields: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (this.disposed && method !== 'worker-stop') return Promise.reject(new Error('Managed worker client belongs to an ended session'));
    if (signal?.aborted) return Promise.reject(new Error('Managed worker request cancelled'));
    const controller = new AbortController();
    this.pending.add(controller);
    const requestId = randomUUID();
    const channel = `subagents:rpc:${method}`;
    return new Promise((resolve, reject) => {
      let settled = false;
      let unsubscribe: (() => void) | undefined;
      const finish = (error?: Error, data?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe?.();
        signal?.removeEventListener('abort', cancel);
        controller.signal.removeEventListener('abort', cancelled);
        this.pending.delete(controller);
        if (error) reject(error); else resolve(data);
      };
      const cancelled = () => finish(new Error('Managed worker request cancelled'));
      const cancel = () => controller.abort();
      const timer = setTimeout(() => {
        // The signal is forwarded over the in-process bus so a queued spawn is
        // cancelled too, not merely abandoned by the caller awaiting its reply.
        finish(new Error('Managed worker request timed out; no fallback'));
        controller.abort();
      }, this.timeoutMs);
      controller.signal.addEventListener('abort', cancelled, { once: true });
      signal?.addEventListener('abort', cancel, { once: true });
      unsubscribe = this.bus.on(`${channel}:reply:${requestId}`, value => {
        const reply = object(value);
        if (reply?.success === true) finish(undefined, reply.data);
        else finish(new Error(typeof reply?.error === 'string' ? reply.error : 'Malformed managed worker reply'));
      });
      try {
        if (signal?.aborted) cancel();
        else this.bus.emit(channel, { ...fields, requestId, signal: controller.signal });
      } catch { finish(new Error('Managed worker transport failed')); controller.abort(); }
    });
  }

  async available(signal?: AbortSignal): Promise<void> {
    const reply = object(await this.request('ping', {}, signal));
    if (!Array.isArray(reply?.capabilities) || !reply.capabilities.includes('managed-workers-v1')) throw new Error('Runner lacks managed-workers-v1; install the approved fork before routing');
  }

  async spawn(input: { type: string; prompt: string; route: Route; cwd: string; access: 'read-only' | 'write'; thinkingLevel?: string; maxTurns?: number }, signal?: AbortSignal): Promise<WorkerReceipt> {
    await this.available(signal);
    const result = parseWorkerReceipt(await this.request('worker-spawn', input, signal));
    if (result.route.provider !== input.route.provider || result.route.model !== input.route.model) {
      await this.stop(result.handle).catch(() => undefined);
      throw new Error('Runner returned a different route; stop requested, verification required');
    }
    return result;
  }

  async resume(handle: string, prompt: string, expected: Route, signal?: AbortSignal): Promise<WorkerReceipt> {
    await this.available(signal);
    const result = parseWorkerReceipt(await this.request('worker-resume', { handle, prompt }, signal));
    if (result.handle !== handle) throw new Error('Resumed worker handle mismatch; no foreign handle adopted');
    if (result.route.provider !== expected.provider || result.route.model !== expected.model) {
      await this.stop(result.handle).catch(() => undefined);
      throw new Error('Resumed worker route changed; stop requested, verification required');
    }
    return result;
  }

  async status(handle: string, signal?: AbortSignal): Promise<WorkerReceipt> {
    const result = parseWorkerReceipt(await this.request('worker-status', { handle }, signal));
    if (result.handle !== handle) throw new Error('Worker status handle mismatch; no foreign handle adopted');
    return result;
  }

  async stop(handle: string, signal?: AbortSignal): Promise<unknown> {
    return this.request('worker-stop', { handle }, signal);
  }
}
