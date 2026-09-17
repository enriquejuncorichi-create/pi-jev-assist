import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTypeSafe } from "pi-typesafe";
import { redact, doneQuestions } from "pi-warden";
import { createService, loadLegacyKey } from "../src/service.js";

const request = { state: "hello", questions: { check: { type: "noul" } } };
const result = { answers: { check: { type: "noul", noul: 0.9 } }, model: "jev-1.13.0", elapsedMs: 1, usage: { input_tokens: 4, output_tokens: 2 } };
function fake(evaluate: (request: unknown, options?: { signal?: AbortSignal }) => Promise<unknown> = async () => result) {
  return (() => ({ evaluate })) as unknown as typeof createTypeSafe;
}

test("lazy construction pins bounds, omits absent key and snapshots usage", async () => {
  let constructions = 0;
  const service = createService({ keyLoader: () => undefined, factory: ((options) => {
    constructions++;
    assert.deepEqual(options, { model: "jev-1.13.0", timeoutMs: 2500, maxInputBytes: 48000, maxRequests: 300 });
    return fake()();
  }) as typeof createTypeSafe });
  assert.equal(constructions, 0);
  assert.equal((await service.evaluate(request)).ok, true);
  assert.equal((await service.evaluate(request)).ok, true);
  assert.equal(constructions, 1);
  assert.deepEqual(service.usage(), { requests: 2, inputTokens: 8, outputTokens: 4, failures: 0 });
  service.usage().requests = 999;
  assert.equal(service.usage().requests, 2);
});

test("six per run and 300 per session remain independent", async () => {
  const service = createService({ factory: fake(), keyLoader: () => "synthetic" });
  for (let run = 0; run < 50; run++) {
    service.beginRun();
    for (let i = 0; i < 6; i++) assert.equal((await service.evaluate(request)).ok, true);
    assert.deepEqual(await service.evaluate(request), { ok: false, reason: "run_budget" });
  }
  service.beginRun();
  assert.deepEqual(await service.evaluate(request), { ok: false, reason: "session_budget" });
  assert.equal(service.usage().requests, 300);
});

test("breaker opens after three failures; half-open probe recovers or reopens", async () => {
  let time = 0;
  let fail = true;
  const service = createService({ now: () => time, keyLoader: () => "synthetic", factory: fake(async () => { if (fail) throw new Error("SECRET"); return result; }) });
  for (let i = 0; i < 3; i++) assert.deepEqual(await service.evaluate(request), { ok: false, reason: "upstream" });
  service.beginRun();
  assert.deepEqual(await service.evaluate(request), { ok: false, reason: "circuit_open" });
  time = 60000;
  assert.deepEqual(await service.evaluate(request), { ok: false, reason: "upstream" });
  time = 119999;
  assert.deepEqual(await service.evaluate(request), { ok: false, reason: "circuit_open" });
  time = 120000;
  fail = false;
  assert.equal((await service.evaluate(request)).ok, true);
  assert.deepEqual(service.usage(), { requests: 5, failures: 4, inputTokens: 4, outputTokens: 2 });
});

test("abort and timeout suppress late completion even when transport ignores cancellation", async () => {
  for (const mode of ["abort", "timeout"] as const) {
    let finish!: (value: unknown) => void;
    let upstream: AbortSignal | undefined;
    const service = createService({ timeoutMs: 15, keyLoader: () => "synthetic", factory: fake((_r, options) => { upstream = options?.signal; return new Promise(resolve => { finish = resolve; }); }) });
    const controller = new AbortController();
    const pending = service.evaluate(request, controller.signal);
    await Promise.resolve();
    if (mode === "abort") controller.abort();
    assert.deepEqual(await pending, { ok: false, reason: mode === "abort" ? "aborted" : "timeout" });
    assert.equal(upstream?.aborted, true);
    finish(result);
    await Promise.resolve();
    assert.deepEqual(service.usage(), { requests: 1, failures: mode === "abort" ? 0 : 1, inputTokens: 0, outputTokens: 0 });
  }
});

test("pre-abort does not construct or spend budget; aborts do not open breaker", async () => {
  const aborted = AbortSignal.abort();
  const service = createService({ keyLoader: () => "synthetic", factory: fake(async () => { throw { code: "aborted" }; }) });
  assert.deepEqual(await service.evaluate(request, aborted), { ok: false, reason: "aborted" });
  assert.equal(service.usage().requests, 0);
  for (let i = 0; i < 4; i++) assert.deepEqual(await service.evaluate(request), { ok: false, reason: "aborted" });
  assert.equal(service.usage().failures, 0);
});

test("redacts full strings in nested state and questions without truncation", async () => {
  const secret = "api_key=sk_test_1234567890AbCdEfGhIjKlMnOp";
  assert.notEqual(redact(secret), secret);
  const long = "x".repeat(10000) + "\n" + secret;
  const service = createService({ keyLoader: () => "synthetic", factory: fake(async (sent) => {
    assert.deepEqual(JSON.parse(JSON.stringify(sent)), { state: { nested: [redact(long)] }, questions: { check: { type: "noul", instructions: redact(secret) } }, model: "jev-1.13.0" });
    return result;
  }) });
  assert.equal((await service.evaluate({ state: { nested: [long] }, questions: { check: { type: "noul", instructions: secret } } })).ok, true);
});

test("UTF-8 byte limit includes model, accepts exact limit, rejects over limit before construction", async () => {
  let calls = 0;
  const service = createService({ keyLoader: () => "synthetic", factory: fake(async () => { calls++; return result; }) });
  const overhead = Buffer.byteLength(JSON.stringify({ ...request, state: "", model: "jev-1.13.0" }));
  assert.equal((await service.evaluate({ ...request, state: "x".repeat(48000 - overhead) })).ok, true);
  assert.deepEqual(await service.evaluate({ ...request, state: "x".repeat(48001 - overhead) }), { ok: false, reason: "oversize" });
  assert.deepEqual(await service.evaluate({ ...request, state: "é".repeat(24000) }), { ok: false, reason: "oversize" });
  assert.equal(calls, 1);
});

test("rejects accessors, cycles and non-JSON without invoking them", async () => {
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  const accessor = { get secret() { throw new Error("should not run"); } };
  const service = createService({ factory: (() => { throw new Error("should not construct"); }) as typeof createTypeSafe });
  for (const state of [cycle, accessor, new Date(), undefined, 1n, Array(1), [undefined]]) assert.deepEqual(await service.evaluate({ ...request, state }), { ok: false, reason: "validation" });
  assert.equal(service.usage().requests, 0);
});

test("real upstream validation rejects malformed answers via injected offline transport", async () => {
  const service = createService({ keyLoader: () => "synthetic-key-for-offline-test", factory: (options) => createTypeSafe({ ...options, fetch: async () => new Response(JSON.stringify({ ...result, answers: { check: { type: "noul", noul: 5 } } }), { status: 200, headers: { "Content-Type": "application/json" } }) }) });
  assert.deepEqual(await service.evaluate(request), { ok: false, reason: "response" });
  assert.equal(service.usage().failures, 1);
});

test("upstream primitive optional undefined fields serialise safely", async () => {
  const service = createService({ keyLoader: () => "synthetic", factory: (options) => createTypeSafe({ ...options, fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(Object.hasOwn(body.questions.claims_verified, 'criteria'), false);
    return new Response(JSON.stringify({ ...result, answers: { claims_verified: { type: 'noul', noul: 0.9 } } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } }) });
  assert.equal((await service.evaluate({state:{final_message:'Tests passed'},questions:{claims_verified:doneQuestions.claims_verified}})).ok, true);
});

test("credential loader errors are sanitised and consume no network budget", async () => {
  const service = createService({ keyLoader: () => { throw new Error("sensitive payload"); }, factory: fake() });
  assert.deepEqual(await service.evaluate(request), { ok: false, reason: "configuration" });
  assert.equal(service.usage().requests, 0);
  assert.throws(() => createService({ maxRequests: 301 }), /configuration/);
});

test("strict legacy parser: environment, literals, permissions, symlinks and duplicates", () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-service-"));
  const path = join(dir, "env");
  const previous = process.env.TYPESAFE_API_KEY;
  try {
    process.env.TYPESAFE_API_KEY = "environment-synthetic-key";
    assert.equal(loadLegacyKey(path), "environment-synthetic-key");
    delete process.env.TYPESAFE_API_KEY;
    assert.equal(loadLegacyKey(path), undefined);
    for (const literal of ["abc123XYZ", "'abc123XYZ'", '"abc123XYZ"']) {
      writeFileSync(path, `# comment\nexport TYPESAFE_API_KEY=${literal}\n`, { mode: 0o600 });
      assert.equal(loadLegacyKey(path), "abc123XYZ");
    }
    for (const content of ["TYPESAFE_API_KEY=x\nTYPESAFE_API_KEY=y", "TYPESAFE_API_KEY=$HOME", "TYPESAFE_API_KEY=`cmd`", "TYPESAFE_API_KEY=$(cmd)", "TYPESAFE_API_KEY=x;cmd", "OTHER_KEY=x", "TYPESAFE_API_KEY=", 'TYPESAFE_API_KEY="unterminated', "# only comment", "x".repeat(8193)]) {
      writeFileSync(path, content);
      assert.throws(() => loadLegacyKey(path), { message: "credentials_invalid" });
    }
    writeFileSync(path, "TYPESAFE_API_KEY=synthetic123");
    chmodSync(path, 0o644);
    assert.throws(() => loadLegacyKey(path), { message: "credentials_invalid" });
    chmodSync(path, 0o600);
    const link = join(dir, "link"); symlinkSync(path, link);
    assert.throws(() => loadLegacyKey(link), { message: "credentials_invalid" });
    assert.throws(() => loadLegacyKey(dir), { message: "credentials_invalid" });
  } finally {
    if (previous === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
