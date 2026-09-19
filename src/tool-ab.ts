import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { chosen } from "./decisions.js";

export const FILES = ["a.ts", "b.ts", "readme.md"] as const;
export const SUITES = ["add", "mul"] as const;
export const TOOLS = ["list_files", "count_lines", "read_file", "run_test", "none"] as const;
export type Gold = { id: string; prompt: string; tool: (typeof TOOLS)[number]; file?: (typeof FILES)[number]; suite?: (typeof SUITES)[number] };

export const GOLD: Gold[] = [
  { id: "lines", prompt: "How many lines is a.ts?", tool: "count_lines", file: "a.ts" },
  { id: "read", prompt: "Show me the contents of b.ts.", tool: "read_file", file: "b.ts" },
  { id: "list", prompt: "What files are in this directory?", tool: "list_files" },
  { id: "add", prompt: "Run the add tests.", tool: "run_test", suite: "add" },
  { id: "mul", prompt: "Run the mul test suite and tell me whether it passed.", tool: "run_test", suite: "mul" },
  { id: "none", prompt: "What is the weather in Lima today?", tool: "none" },
];

export function seed(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "a.ts"), "export const a = 1;\nexport const b = 2;\n");
  writeFileSync(join(dir, "b.ts"), "export function mul(x: number, y: number) {\n  return x * y;\n}\n");
  writeFileSync(join(dir, "readme.md"), "tiny fixture\n");
  writeFileSync(join(dir, "add.test.js"), `import test from 'node:test'; import assert from 'node:assert/strict';\ntest('add', () => assert.equal(1+1, 2));\n`);
  writeFileSync(join(dir, "mul.test.js"), `import test from 'node:test'; import assert from 'node:assert/strict';\ntest('mul', () => assert.equal(2*3, 6));\n`);
}

export function execute(dir: string, call: { tool: string; file?: string; suite?: string }): { stdout: string; ok: boolean } {
  if (call.tool === "none") return { stdout: "", ok: true };
  if (call.tool === "list_files") return { stdout: FILES.join("\n"), ok: true };
  if (call.tool === "count_lines" && call.file) {
    const n = readFileSync(join(dir, call.file), "utf8").split("\n").length;
    return { stdout: String(n), ok: true };
  }
  if (call.tool === "read_file" && call.file) return { stdout: readFileSync(join(dir, call.file), "utf8"), ok: true };
  if (call.tool === "run_test" && call.suite) {
    const r = spawnSync("node", ["--test", join(dir, `${call.suite}.test.js`)], { encoding: "utf8", timeout: 15_000 });
    // node:test prints duration_ms; two runs never match verbatim. Compare pass/fail only.
    const passed = r.status === 0;
    return { stdout: passed ? "pass" : "fail", ok: passed };
  }
  return { stdout: "invalid", ok: false };
}

export function toolQuestions() {
  return {
    tool: {
      type: "choice",
      instructions: "Which closed tool should run for the user request? Choose none when no tool applies (weather, chit-chat, anything outside this fixture).",
      criteria: {
        list_files: "The user wants the names of files in the fixture directory.",
        count_lines: "The user wants a line count of one named fixture file.",
        read_file: "The user wants the contents of one named fixture file.",
        run_test: "The user wants to run the add or mul test suite.",
        none: "The request is not about this fixture's files or tests.",
      },
    },
    file: {
      type: "choice",
      instructions: "If a file is named or clearly implied, which fixture file? Choose a.ts when none applies; the dispatcher ignores file unless the tool needs it.",
      criteria: { "a.ts": "the file a.ts", "b.ts": "the file b.ts", "readme.md": "the readme" },
    },
    suite: {
      type: "choice",
      instructions: "If a test suite is named, which one? Choose add when none applies; ignored unless the tool is run_test.",
      criteria: { add: "the add tests", mul: "the mul tests" },
    },
  };
}

export function parseJev(answers: Record<string, unknown>): { tool: string; file?: string; suite?: string } {
  const tool = chosen(answers.tool) ?? "none";
  const file = chosen(answers.file) as Gold["file"] | undefined;
  const suite = chosen(answers.suite) as Gold["suite"] | undefined;
  if (tool === "count_lines" || tool === "read_file") return { tool, file };
  if (tool === "run_test") return { tool, suite };
  return { tool };
}

export function matchGold(gold: Gold, got: { tool: string; file?: string; suite?: string }): boolean {
  if (got.tool !== gold.tool) return false;
  if (gold.file && got.file !== gold.file) return false;
  if (gold.suite && got.suite !== gold.suite) return false;
  return true;
}

export function piMatchesGold(gold: Gold, commands: string[], tools: string[] = []): boolean {
  const blob = commands.join("\n").toLowerCase();
  const names = tools.map(t => t.toLowerCase());
  if (gold.tool === "none") return commands.length === 0 && names.every(t => t !== "bash" && t !== "read");
  if (gold.tool === "list_files") return /\bls\b|\bfind\b|readme\.md/.test(blob);
  if (gold.tool === "count_lines") return blob.includes(gold.file!) && /\bwc\b|line/.test(blob);
  if (gold.tool === "read_file") return names.includes("read") || (blob.includes(gold.file!) && /\bcat\b|\bhead\b|read/.test(blob));
  if (gold.tool === "run_test") return blob.includes(gold.suite!) && /\btest\b|\bnode\b/.test(blob);
  return false;
}

export function reliability(rows: { id: string; ok: boolean }[]): Record<string, { n: number; hits: number; rate: number }> {
  const out: Record<string, { n: number; hits: number; rate: number }> = {};
  for (const r of rows) {
    const slot = out[r.id] ?? (out[r.id] = { n: 0, hits: 0, rate: 0 });
    slot.n++;
    if (r.ok) slot.hits++;
    slot.rate = slot.hits / slot.n;
  }
  return out;
}

export type JevRow = { id: string; ok: boolean; reason?: string; tool?: string; file?: string; suite?: string; conf?: number; stdoutMatch?: boolean; elapsedMs?: number; usage?: unknown };
