import { test } from "node:test";
import assert from "node:assert/strict";
import { EvidenceLedger } from "../src/evidence.js";

const text = (value: string) => [{ type: "text", text: value }];
function run(ledger: EvidenceLedger, id: string, command: string, details: unknown = { exitCode: 0 }, isError = false) {
  ledger.recordCall(id, "bash", { command });
  ledger.recordResult(id, "bash", text("all tests passed"), isError, details);
}

test("echo and compound/wrapped commands cannot supply passing checks", () => {
  const ledger = new EvidenceLedger();
  ["echo bun run test", "bun run test && echo ok", "bun run test || true", "bun run test | tee log", "bun run test\necho ok", "bun run test $(echo ok)", "sh -c 'bun run test'", "cd /tmp; bun run test", "bun run test > log", "bun run test `echo ok`", " bun run test"].forEach((command, index) => run(ledger, String(index), command));
  assert.deepEqual(ledger.snapshot().checks, []);
});

test("each direct check uses its own structured exit, never prose", () => {
  const ledger = new EvidenceLedger();
  run(ledger, "lint", "bun run lint");
  run(ledger, "test", "bun run test", { exitCode: 1 });
  run(ledger, "missing", "node --test test/a.ts", {});
  run(ledger, "string", "bun test", { exitCode: "0" });
  run(ledger, "error", "bun run check", {}, true);
  assert.deepEqual(ledger.snapshot().checks.map(check => check.status), ["passed", "failed", "unknown", "unknown", "failed"]);
  assert.deepEqual(ledger.snapshot().checks.map(check => check.kind), ["lint", "test", "test", "test", "check"]);
});

test("mutations invalidate checks at call start, including unsuccessful writes", () => {
  const ledger = new EvidenceLedger();
  run(ledger, "test", "bun run test");
  const generation = ledger.snapshot().checks[0]!.afterMutation;
  ledger.recordCall("read", "read", { path: "src/a.ts" });
  assert.equal(ledger.snapshot().mutations + ledger.snapshot().unknownMutations, generation);
  ledger.recordCall("edit", "edit", { path: "src/a.ts" });
  ledger.recordResult("edit", "edit", [], true, undefined);
  ledger.recordCall("unknown", "custom_tool", {});
  const snap = ledger.snapshot();
  assert.equal(snap.mutations, 1);
  assert.equal(snap.unknownMutations, 2);
  assert.ok(generation < snap.mutations + snap.unknownMutations);
});

test("parallel late results retain the original call generation", () => {
  const ledger = new EvidenceLedger();
  ledger.recordCall("a", "bash", { command: "bun run typecheck" });
  ledger.recordCall("b", "bash", { command: "bun run build" });
  ledger.recordCall("c", "write", { path: "a.ts", content: "hello" });
  ledger.recordResult("b", "bash", [], false, { exitCode: 0 });
  ledger.recordResult("a", "bash", [], false, { exitCode: 0 });
  assert.deepEqual(ledger.snapshot().checks.map(check => check.afterMutation), [1, 2]);
  assert.equal(ledger.snapshot().mutations + ledger.snapshot().unknownMutations, 3);
});

test("duplicates ignored and orphan or mismatched results never pass", () => {
  const ledger = new EvidenceLedger();
  run(ledger, "a", "bun run test");
  const original = ledger.snapshot();
  ledger.recordResult("a", "bash", [], true, { exitCode: 1 });
  ledger.recordCall("a", "write", {});
  assert.deepEqual(ledger.snapshot(), original);
  ledger.recordResult("orphan", "bash", text("secret content"), false, { exitCode: 0 });
  const orphan = ledger.snapshot();
  ledger.recordResult("orphan", "bash", [], false, { exitCode: 0 });
  assert.deepEqual(ledger.snapshot(), orphan);
  assert.equal(orphan.observations[1]!.status, "unknown");
  assert.equal(orphan.observations[1]!.output, "");
  ledger.recordCall("mismatch", "bash", { command: "bun run test" });
  ledger.recordResult("mismatch", "read", [], false, { exitCode: 0 });
  assert.equal(ledger.snapshot().checks[1]!.status, "unknown");
});

test("redaction occurs before clipping even for long private key blocks", () => {
  const ledger = new EvidenceLedger();
  const secret = `-----BEGIN PRIVATE KEY-----\n${"sensitive".repeat(500)}\n-----END PRIVATE KEY-----`;
  ledger.recordCall("a", "bash", { command: `echo ${secret}` });
  ledger.recordResult("a", "bash", text(`prefix ${secret} suffix`), false, {});
  const observation = ledger.snapshot().observations[0]!;
  assert.ok(!JSON.stringify(observation).includes("sensitivesensitive"));
  ledger.recordCall("b", "read", { path: "normal.txt" });
  ledger.recordResult("b", "read", text(`prefix ${secret} suffix`), false, {});
  assert.equal(ledger.snapshot().observations[1]!.output, "prefix [redacted] suffix");
  ledger.recordCall("c", "bash", { command: `echo token=${"A".repeat(2000)}` });
  assert.equal(ledger.snapshot().observations[2]!.call, "echo token=[redacted]");
});

test("sensitive paths and credential-dumping commands suppress all content", () => {
  const ledger = new EvidenceLedger();
  [".env", "/tmp/.env.local", "/home/a/auth.json", "/tmp/credentials", "/home/a/.ssh/id_rsa", "/tmp/key.pem"].forEach((path, i) => {
    for (const tool of ["read", "edit", "write", "grep", "find", "custom_tool"]) {
      const id = `${i}-${tool}`;
      ledger.recordCall(id, tool, { path, content: "unlabelled-secret" });
      ledger.recordResult(id, tool, text("unlabelled-secret"), false, {});
    }
  });
  ["env", "printenv", "cat .env", "cat /tmp/.env.local", "env | sort"].forEach((command, i) => {
    ledger.recordCall(`shell${i}`, "bash", { command });
    ledger.recordResult(`shell${i}`, "bash", text("unlabelled-secret"), false, {});
  });
  for (const observation of ledger.snapshot().observations) {
    assert.equal(observation.call, "[sensitive content omitted]");
    assert.equal(observation.output, "");
  }
});

test("budget covers pending calls; overflow remains mutating and excerpts bounded", () => {
  const ledger = new EvidenceLedger();
  for (let i = 0; i < 125; i++) ledger.recordCall(String(i), "bash", { command: "x".repeat(2000) });
  ledger.recordResult("5", "bash", text("y".repeat(5000)), false, {});
  ledger.recordResult("0", "bash", text("late evicted result"), false, {});
  const snap = ledger.snapshot();
  assert.equal(snap.observations.length, 120);
  assert.equal(snap.dropped, 5);
  assert.equal(snap.unknownMutations, 125);
  assert.equal(snap.observations[0]!.call.length, 300);
  assert.equal(snap.observations[0]!.output.length, 1200);
  assert.equal(snap.observations[0]!.id, "5");
  assert.equal(snap.observations[119]!.sequence, 125);
});

test("snapshot arrays and objects are detached and reset clears state", () => {
  const ledger = new EvidenceLedger();
  run(ledger, "a", "bun run test");
  const snap = ledger.snapshot();
  snap.observations[0]!.output = "changed";
  snap.checks[0]!.status = "failed";
  snap.observations.length = 0;
  assert.equal(ledger.snapshot().observations.length, 1);
  assert.equal(ledger.snapshot().checks[0]!.status, "passed");
  ledger.reset();
  assert.deepEqual(ledger.snapshot(), { observations: [], mutations: 0, unknownMutations: 0, dropped: 0, checks: [] });
});
