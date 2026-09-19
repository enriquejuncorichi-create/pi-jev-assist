import { digest, type Request } from './decisions.js';
import type { AssistResult, AssistService } from './service.js';

/** Identical payload cache + in-flight coalesce (y0usaf/pi-jev). Failures are never cached. */
export function withCache(inner: AssistService, ttlMs: () => number): AssistService {
  const hits = new Map<string, { at: number; result: AssistResult }>();
  const inflight = new Map<string, Promise<AssistResult>>();
  return {
    usage: () => inner.usage(),
    beginRun: () => inner.beginRun(),
    async evaluate(request: Request, signal?: AbortSignal) {
      const ttl = ttlMs();
      if (ttl <= 0) return inner.evaluate(request, signal);
      const key = digest(request);
      const now = Date.now();
      const hit = hits.get(key);
      if (hit && now - hit.at < ttl) return hit.result;
      const pending = inflight.get(key);
      if (pending) return pending;
      const work = inner.evaluate(request, signal).then(result => {
        if (result.ok) hits.set(key, { at: Date.now(), result });
        return result;
      }).finally(() => inflight.delete(key));
      inflight.set(key, work);
      return work;
    },
  };
}
