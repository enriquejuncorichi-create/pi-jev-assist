import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createTypeSafe } from "pi-typesafe";
import { redact, secretKey } from "./privacy.js";

const MODEL = "jev-1.13.0";
const MAX_BYTES = 48_000;
export type AssistResult = { ok: true; answers: Record<string, unknown>; model: string; elapsedMs: number; usage: { input_tokens: number; output_tokens: number } } | { ok: false; reason: string };
export interface AssistService {
  evaluate(request: { state: unknown; questions: Record<string, unknown> }, signal?: AbortSignal): Promise<AssistResult>;
  usage(): { requests: number; inputTokens: number; outputTokens: number; failures: number };
  beginRun(): void;
}

/** Read literal credentials only; never execute shell syntax or reveal file contents. */
export function loadLegacyKey(path = join(homedir(), ".config/typesafe/env")): string | undefined {
  const environment = process.env.TYPESAFE_API_KEY?.trim();
  if (environment) return environment;
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("credentials_invalid");
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || !process.getuid || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0 || stat.size > 8192) throw new Error();
    const bytes = Buffer.alloc(8193);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > 8192) throw new Error();
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
    let key: string | undefined;
    for (const line of text.split(/\r?\n/)) {
      if (/^\s*(?:#.*)?$/.test(line)) continue;
      const match = /^(?:export[ \t]+)?TYPESAFE_API_KEY[ \t]*=[ \t]*(?:'([^']*)'|"([^"]*)"|([^\s'";]+))[ \t]*$/.exec(line);
      if (!match || key !== undefined) throw new Error();
      key = match[1] ?? match[2] ?? match[3];
      if (!key || /[\s$`\\\x00-\x1f\x7f]/.test(key)) throw new Error();
    }
    if (!key) throw new Error();
    return key;
  } catch {
    throw new Error("credentials_invalid");
  } finally {
    closeSync(fd);
  }
}

// Traverse descriptors rather than invoking user-controlled getters or toJSON methods.
function redactedJson(value: unknown, ancestors = new Set<object>(), depth = 0): unknown {
  if (depth > 64) throw new Error();
  if (typeof value === "string") return redact(value);
  if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return value;
  if (typeof value !== "object" || ancestors.has(value)) throw new Error();
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error();
  if (Object.getOwnPropertySymbols(value).length) throw new Error();
  if (Array.isArray(value)) {
    if (value.length > MAX_BYTES) throw new Error();
    for (let i = 0; i < value.length; i++) if (!Object.hasOwn(value, i)) throw new Error();
  }
  ancestors.add(value);
  const output: Record<string, unknown> | unknown[] = Array.isArray(value) ? [] : Object.create(null);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (Array.isArray(value) && key === "length") continue;
    if (Array.isArray(value) && !/^(0|[1-9]\d*)$/.test(key)) throw new Error();
    if (!descriptor.enumerable || descriptor.get || descriptor.set) throw new Error();
    // SDK primitive builders emit optional object properties with undefined values.
    // Match JSON object serialisation without accepting undefined array entries.
    if (!Array.isArray(value) && descriptor.value === undefined) continue;
    Object.defineProperty(output, key, { value: secretKey.test(key) ? '[redacted]' : redactedJson(descriptor.value, ancestors, depth + 1), enumerable: true, writable: true, configurable: true });
  }
  ancestors.delete(value);
  return output;
}

function safeReason(error: unknown): string {
  const code = error && typeof error === "object" ? Object.getOwnPropertyDescriptor(error, "code")?.value : undefined;
  return typeof code === "string" && ["aborted", "timeout", "configuration", "validation", "budget", "response", "connection", "http"].includes(code) ? code : "upstream";
}

export function createService(options: { factory?: typeof createTypeSafe; keyLoader?: () => string | undefined; now?: () => number; timeoutMs?: number; maxRequests?: number } = {}): AssistService {
  const timeoutMs = options.timeoutMs ?? 2500;
  const maxRequests = options.maxRequests ?? 300;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647 || !Number.isSafeInteger(maxRequests) || maxRequests <= 0 || maxRequests > 300) throw new Error("configuration");
  const now = options.now ?? Date.now;
  let client: ReturnType<typeof createTypeSafe> | undefined;
  let runRequests = 0;
  let consecutiveFailures = 0;
  let openUntil = 0;
  let probing = false;
  const usage = { requests: 0, inputTokens: 0, outputTokens: 0, failures: 0 };
  return {
    usage: () => ({ ...usage }),
    beginRun: () => { runRequests = 0; },
    async evaluate(request, signal) {
      if (signal?.aborted) return { ok: false, reason: "aborted" };
      if (probing || now() < openUntil) return { ok: false, reason: "circuit_open" };
      if (runRequests >= 6) return { ok: false, reason: "run_budget" };
      if (usage.requests >= maxRequests) return { ok: false, reason: "session_budget" };
      let prepared: Parameters<ReturnType<typeof createTypeSafe>["evaluate"]>[0];
      try {
        const clean = redactedJson(request) as { state: unknown; questions: Record<string, unknown> };
        if (!clean || !Object.hasOwn(clean, 'state') || !Object.hasOwn(clean, 'questions')) throw new Error();
        const body = { state: clean.state, questions: clean.questions, model: MODEL };
        if (Buffer.byteLength(JSON.stringify(body), "utf8") > MAX_BYTES) return { ok: false, reason: "oversize" };
        prepared = body as typeof prepared;
      } catch { return { ok: false, reason: "validation" }; }
      try {
        if (!client) {
          const apiKey = (options.keyLoader ?? loadLegacyKey)();
          client = (options.factory ?? createTypeSafe)({ ...(apiKey === undefined ? {} : { apiKey }), model: MODEL, timeoutMs, maxInputBytes: MAX_BYTES, maxRequests });
        }
      } catch { return { ok: false, reason: "configuration" }; }
      if (signal?.aborted) return { ok: false, reason: "aborted" };
      const probe = consecutiveFailures >= 3;
      if (probe) probing = true;
      runRequests++;
      usage.requests++;
      const start = now();
      const controller = new AbortController();
      let cancelled: "aborted" | "timeout" | undefined;
      let rejectCancellation!: (error: unknown) => void;
      const cancellation = new Promise<never>((_, reject) => { rejectCancellation = reject; });
      const cancel = (code: "aborted" | "timeout") => {
        if (cancelled) return;
        cancelled = code;
        rejectCancellation({ code });
        controller.abort();
      };
      const onAbort = () => cancel("aborted");
      signal?.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => cancel("timeout"), timeoutMs);
      try {
        const result = await Promise.race([Promise.resolve().then(() => {
          if (cancelled) throw { code: cancelled };
          return client!.evaluate(prepared, { signal: controller.signal });
        }), cancellation]);
        if (signal?.aborted || cancelled) throw { code: cancelled ?? "aborted" };
        if (now() - start >= timeoutMs) { cancel("timeout"); throw { code: "timeout" }; }
        if (!result || typeof result.model !== "string" || !result.model || !result.answers || typeof result.answers !== "object" || Array.isArray(result.answers) || !result.usage || ![result.usage.input_tokens, result.usage.output_tokens].every(n => Number.isSafeInteger(n) && n >= 0)) throw { code: "response" };
        usage.inputTokens += result.usage.input_tokens;
        usage.outputTokens += result.usage.output_tokens;
        consecutiveFailures = 0;
        openUntil = 0;
        return { ok: true, answers: result.answers, model: result.model, elapsedMs: Math.max(0, now() - start), usage: { ...result.usage } };
      } catch (error) {
        const reason = cancelled ?? safeReason(error);
        if (reason !== "aborted") {
          usage.failures++;
          consecutiveFailures++;
          if (consecutiveFailures >= 3) openUntil = now() + 60_000;
        }
        return { ok: false, reason };
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (probe) probing = false;
      }
    },
  };
}
