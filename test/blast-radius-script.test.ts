import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";

/**
 * `scripts/blast-radius.sh` enumerates callers of every symbol a change touches.
 * Broken or unconsidered callers are the largest class of BLOCKING review
 * finding in this repo — 13 of 108 blockers (12%) across 1,252 harvested inline
 * findings — so the enumeration has to be trustworthy.
 *
 * The first version was not. It passed the pattern as `-- "$sym" --glob ...`,
 * which makes ripgrep read each glob as a FILENAME: every search errored, every
 * symbol returned zero hits, and the script cheerfully printed "no references
 * outside its own file" for `assertDeclaredTemplate`, which has 23 including
 * four live call sites in apps/sp. A silent zero from a broken search is a false
 * all-clear — the precise defect this tool exists to catch in other people's
 * work. The first test below fails against that version.
 */
const SCRIPT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../tools/blast-radius.sh");

const workspaces: string[] = [];
afterEach(() => {
  while (workspaces.length)
    rmSync(workspaces.pop()!, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0)
    throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
}

function write(root: string, path: string, content: string): void {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), content);
}

/** A repo with a base commit, a caller, and a changed exported symbol. */
function repoWithCaller(): string {
  const root = mkdtempSync(join(tmpdir(), "blast-radius-"));
  workspaces.push(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test");
  write(root, "packages/lib/src/guard.ts", "export function oldName() {}\n");
  write(
    root,
    "apps/web/src/caller.ts",
    'import { assertThing } from "@ccd/lib";\nassertThing();\n',
  );
  write(
    root,
    "packages/other/src/second.ts",
    "import { assertThing } from '@ccd/lib';\nassertThing();\n",
  );
  git(root, "add", "-A");
  git(root, "commit", "-qm", "base");

  git(root, "checkout", "-q", "-b", "change");
  write(
    root,
    "packages/lib/src/guard.ts",
    "export function assertThing() {\n  return true;\n}\n",
  );
  git(root, "add", "-A");
  git(root, "commit", "-qm", "change");
  return root;
}

function run(root: string, base = "main") {
  const result = spawnSync("bash", [SCRIPT, base], {
    cwd: root,
    encoding: "utf8",
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe("blast-radius", () => {
  test("finds callers of a changed exported symbol, across workspaces", () => {
    const root = repoWithCaller();
    const { status, output } = run(root);

    assert.strictEqual(status, 0);
    // The regression: the broken version printed "no references" here.
    assert.ok(!String(output).includes("assertThing — no references"));
    // Four, not two: references are LINES, so each file contributes its import
    // line and its call line. That is the right grain for a checklist you walk
    // one line at a time.
    assert.ok(String(output).includes("assertThing — 4 reference(s)"));
    assert.ok(String(output).includes("apps/web/src/caller.ts"));
    assert.ok(String(output).includes("packages/other/src/second.ts"));
    // Grouped by workspace so cross-package reach is visible at a glance.
    assert.match(String(output), /2 in apps\/web/);
    assert.match(String(output), /2 in packages\/other/);
  });

  test("every found reference is printed, never truncated", () => {
    const root = mkdtempSync(join(tmpdir(), "blast-radius-many-"));
    workspaces.push(root);
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.email", "t@e.com");
    git(root, "config", "user.name", "T");
    write(root, "packages/lib/src/g.ts", "export function before() {}\n");
    for (let i = 0; i < 30; i++)
      write(root, `apps/web/src/c${i}.ts`, "widelyUsed();\n");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "base");
    git(root, "checkout", "-q", "-b", "change");
    write(root, "packages/lib/src/g.ts", "export function widelyUsed() {}\n");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "change");

    const { output } = run(root);

    // A conclusion drawn from a truncated enumeration is the named failure mode
    // "never truncate an enumeration you are drawing a conclusion from".
    assert.ok(String(output).includes("widelyUsed — 30 reference(s)"));
    for (let i = 0; i < 30; i++)
      assert.ok(output.includes(`apps/web/src/c${i}.ts`));
  });

  test("a file whose changed symbol cannot be detected says so, rather than clear", () => {
    const root = mkdtempSync(join(tmpdir(), "blast-radius-body-"));
    workspaces.push(root);
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.email", "t@e.com");
    git(root, "config", "user.name", "T");
    write(
      root,
      "packages/lib/src/b.ts",
      "export function stable() {\n  return 1;\n}\n",
    );
    git(root, "add", "-A");
    git(root, "commit", "-qm", "base");
    git(root, "checkout", "-q", "-b", "change");
    // Body-only edit: the signature is unchanged, so no symbol is detected —
    // but callers can still break, and the script must not imply safety.
    write(
      root,
      "packages/lib/src/b.ts",
      "export function stable() {\n  return 2;\n}\n",
    );
    git(root, "add", "-A");
    git(root, "commit", "-qm", "change");

    const { status, output } = run(root);

    assert.strictEqual(status, 0);
    assert.ok(String(output).includes("no changed exported/declared symbol detected"));
    assert.ok(String(output).includes("NOT the same as 'no blast radius'"));
  });

  test("--symbol traces dependants before any change is made", () => {
    // The before-mode is the point: "you did not consider this caller" is a
    // planning failure, and a diff-seeded answer arrives too late to prevent it.
    const root = repoWithCaller();
    const result = spawnSync("bash", [SCRIPT, "--symbol", "assertThing"], {
      cwd: root,
      encoding: "utf8",
    });
    const output = `${result.stdout}${result.stderr}`;

    assert.strictEqual(result.status, 0);
    assert.ok(String(output).includes("BEFORE any change"));
    assert.ok(String(output).includes("assertThing — 4 reference(s)"));
    assert.ok(String(output).includes("apps/web/src/caller.ts"));
    assert.ok(String(output).includes("packages/other/src/second.ts"));
  });

  test("--symbol refuses an unknown symbol instead of reporting zero callers", () => {
    const root = repoWithCaller();
    const result = spawnSync(
      "bash",
      [SCRIPT, "--symbol", "noSuchSymbolAnywhere"],
      {
        cwd: root,
        encoding: "utf8",
      },
    );

    // A zero from a symbol that does not exist is not the same as no callers,
    // and reporting it as a clear blast radius is the false all-clear again.
    assert.strictEqual(result.status, 2);
    assert.ok(`${result.stdout}${result.stderr}`.includes("refusing to report a blast radius"));
  });

  test("--file lists every exported symbol's dependants", () => {
    const root = repoWithCaller();
    const result = spawnSync(
      "bash",
      [SCRIPT, "--file", "packages/lib/src/guard.ts"],
      { cwd: root, encoding: "utf8" },
    );
    const output = `${result.stdout}${result.stderr}`;

    assert.strictEqual(result.status, 0);
    assert.ok(String(output).includes("BEFORE any change"));
    assert.ok(String(output).includes("assertThing"));
  });

  test("a flag with no value errors instead of hanging", () => {
    // `shift 2 || true` swallowed the failed shift when the flag was last, so
    // the parse loop never advanced and the script hung forever. Found by a
    // 300-second timeout, not by reading it.
    const root = repoWithCaller();
    for (const flag of ["--symbol", "--file"]) {
      const result = spawnSync("bash", [SCRIPT, flag], {
        cwd: root,
        encoding: "utf8",
        timeout: 15_000,
      });
      assert.strictEqual(result.status, 2);
      assert.strictEqual(result.signal, null);
    }
    const missing = spawnSync("bash", [SCRIPT, "--file", "no/such/file.ts"], {
      cwd: root,
      encoding: "utf8",
      timeout: 15_000,
    });
    assert.strictEqual(missing.status, 2);
  });

  test("no changed source files is reported, not treated as analysed", () => {
    const root = mkdtempSync(join(tmpdir(), "blast-radius-none-"));
    workspaces.push(root);
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.email", "t@e.com");
    git(root, "config", "user.name", "T");
    write(root, "README.md", "hi\n");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "base");
    git(root, "checkout", "-q", "-b", "change");
    write(root, "README.md", "changed\n");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "change");

    const { status, output } = run(root);

    assert.strictEqual(status, 0);
    assert.ok(String(output).includes("nothing to trace"));
  });
});
