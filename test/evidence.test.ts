import { test } from "node:test";
import assert from "node:assert/strict";
import { EvidenceLedger } from "../src/evidence.js";

const text = (value: string) => [{ type: "text", text: value }];
// The shape Pi's bash tool actually returns: content only, no exit code.
function run(ledger: EvidenceLedger, id: string, command: string, output = "out", isError = false) {
  ledger.recordCall(id, "bash", { command });
  ledger.recordResult(id, "bash", text(output), isError, undefined);
}

test("status comes from isError alone; no output prose can imply a pass", () => {
  const ledger = new EvidenceLedger();
  run(ledger, "a", "cd /tmp && node --test t.test.js 2>&1 | tail -25", "1 failed\nAssertionError: 1 !== 2");
  run(ledger, "b", "bun run test", "all tests passed", true);
  run(ledger, "c", "echo bun run test", "bun run test");
  const snap = ledger.snapshot();
  assert.deepEqual(snap.observations.map(o => o.status), ["ok", "error", "ok"]);
  // "ok" must never be reachable as "the check passed": the snapshot exposes no
  // pass/fail verdict at all, so a consumer cannot mistake one for the other.
  assert.deepEqual(Object.keys(snap).sort(), ["dropped", "mutations", "observations", "unknownMutations"]);
  assert.ok(snap.observations.every(o => !("check" in o) && !("afterMutation" in o)));
});

test("a compound real-world check command is still recorded as an observation", () => {
  const ledger = new EvidenceLedger();
  run(ledger, "a", "cd /repo && bun run test | tail -5", "2 pass 1 fail");
  const observation = ledger.snapshot().observations[0]!;
  assert.equal(observation.call, "cd /repo && bun run test | tail -5");
  assert.equal(observation.output, "2 pass 1 fail");
});

test("mutation counts still track writes and unknown tools", () => {
  const ledger = new EvidenceLedger();
  ledger.recordCall("read", "read", { path: "src/a.ts" });
  ledger.recordCall("edit", "edit", { path: "src/a.ts" });
  ledger.recordResult("edit", "edit", [], true, undefined);
  ledger.recordCall("unknown", "custom_tool", {});
  run(ledger, "shell", "bun run test");
  const snap = ledger.snapshot();
  assert.equal(snap.mutations, 1);
  // read is a read; edit is a mutation; custom_tool and bash are unknown effects.
  assert.equal(snap.unknownMutations, 2);
});

test("duplicates ignored and orphan or mismatched results never carry content", () => {
  const ledger = new EvidenceLedger();
  run(ledger, "a", "bun run test");
  const original = ledger.snapshot();
  ledger.recordResult("a", "bash", text("late"), true, undefined);
  ledger.recordCall("a", "write", {});
  assert.deepEqual(ledger.snapshot(), original);
  ledger.recordResult("orphan", "bash", text("secret content"), false, undefined);
  const orphan = ledger.snapshot();
  assert.equal(orphan.observations[1]!.status, "unknown");
  assert.equal(orphan.observations[1]!.output, "");
  ledger.recordCall("mismatch", "bash", { command: "bun run test" });
  ledger.recordResult("mismatch", "read", text("wrong tool"), false, undefined);
  assert.equal(ledger.snapshot().observations[2]!.status, "unknown");
  assert.equal(ledger.snapshot().observations[2]!.output, "");
});

test("redaction occurs before clipping even for long private key blocks", () => {
  const ledger = new EvidenceLedger();
  const secret = `-----BEGIN PRIVATE KEY-----\n${"sensitive".repeat(500)}\n-----END PRIVATE KEY-----`;
  ledger.recordCall("a", "bash", { command: `echo ${secret}` });
  ledger.recordResult("a", "bash", text(`prefix ${secret} suffix`), false, undefined);
  assert.ok(!JSON.stringify(ledger.snapshot().observations[0]).includes("sensitivesensitive"));
  ledger.recordCall("b", "read", { path: "normal.txt" });
  ledger.recordResult("b", "read", text(`prefix ${secret} suffix`), false, undefined);
  assert.equal(ledger.snapshot().observations[1]!.output, "prefix [redacted] suffix");
  ledger.recordCall("c", "bash", { command: `echo token=${"A".repeat(2000)}` });
  assert.equal(ledger.snapshot().observations[2]!.call, "echo token=[redacted]");
});

test("sensitive paths, globs and credential-dumping commands suppress all content", () => {
  const ledger = new EvidenceLedger();
  [".env", "/tmp/.env.local", "/home/a/auth.json", "/tmp/credentials", "/home/a/.ssh/id_rsa", "/tmp/key.pem"].forEach((path, i) => {
    for (const tool of ["read", "edit", "write", "grep", "find", "custom_tool"]) {
      const id = `${i}-${tool}`;
      ledger.recordCall(id, tool, { path, content: "unlabelled-secret" });
      ledger.recordResult(id, tool, text("unlabelled-secret"), false, undefined);
    }
  });
  ["env", "printenv", "cat .env", "cat /tmp/.env.local", "env | sort"].forEach((command, i) => {
    ledger.recordCall(`shell${i}`, "bash", { command });
    ledger.recordResult(`shell${i}`, "bash", text("unlabelled-secret"), false, undefined);
  });
  ledger.recordCall("glob", "grep", { path: "/tmp/project", glob: "**/credentials.txt" });
  ledger.recordResult("glob", "grep", text("unlabelled-secret"), false, undefined);
  for (const observation of ledger.snapshot().observations) {
    assert.equal(observation.call, "[sensitive content omitted]");
    assert.equal(observation.output, "");
  }
});

test("grep output in an unrecognised format is withheld, not sent", () => {
  const ledger = new EvidenceLedger();
  ledger.recordCall("a", "grep", { path: "/tmp/project" });
  ledger.recordResult("a", "grep", text("some notice line without a location"), false, undefined);
  assert.equal(ledger.snapshot().observations[0]!.output, "[sensitive search results omitted]");
  ledger.recordCall("b", "grep", { path: "/tmp/project" });
  ledger.recordResult("b", "grep", text("src/a.ts:12: const x = 1"), false, undefined);
  assert.equal(ledger.snapshot().observations[1]!.output, "src/a.ts:12: const x = 1");
});

test("budget covers pending calls; overflow remains mutating and excerpts bounded", () => {
  const ledger = new EvidenceLedger();
  for (let i = 0; i < 125; i++) ledger.recordCall(String(i), "bash", { command: "x".repeat(2000) });
  ledger.recordResult("5", "bash", text("y".repeat(5000)), false, undefined);
  ledger.recordResult("0", "bash", text("late evicted result"), false, undefined);
  const snap = ledger.snapshot();
  assert.equal(snap.observations.length, 120);
  assert.equal(snap.dropped, 5);
  assert.equal(snap.unknownMutations, 125);
  assert.equal(snap.observations[0]!.call.length, 300);
  assert.equal(snap.observations[0]!.id, "5");
  assert.equal(snap.observations[119]!.sequence, 125);
});

test("snapshot is detached and reset clears state", () => {
  const ledger = new EvidenceLedger();
  run(ledger, "a", "bun run test");
  const snap = ledger.snapshot();
  snap.observations[0]!.output = "changed";
  snap.observations.length = 0;
  assert.equal(ledger.snapshot().observations.length, 1);
  ledger.reset();
  assert.deepEqual(ledger.snapshot(), { observations: [], mutations: 0, unknownMutations: 0, dropped: 0 });
});
