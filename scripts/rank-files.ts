#!/usr/bin/env bun
/** Unique files from rg reviewAdvice; Jev scores which to READ. Gold: src/decisions.ts and index.ts must survive. */
import { spawnSync } from "node:child_process";
import { createService } from "../src/service.js";
import { probability } from "../src/decisions.js";

async function main() {
  const rg = spawnSync("rg", ["-l", "reviewAdvice", "--glob", "!node_modules/**", "--glob", "!.git/**"], {
    cwd: process.cwd(), encoding: "utf8",
  });
  const files = [...new Set((rg.stdout || "").split("\n").filter(Boolean))];
  const service = createService({ timeoutMs: 4000, maxRequests: 20 });
  const questions: Record<string, unknown> = {};
  files.forEach((f, i) => {
    questions[`f${i}`] = {
      type: "noul",
      instructions: "Should an agent READ this file to learn reviewAdvice flag thresholds and its callers? Tests are useful; generated noise is not.",
    };
  });
  const result = await service.evaluate({
    state: { task: "reviewAdvice thresholds and callers", files: files.map((path, i) => ({ id: `f${i}`, path })) },
    questions,
  });
  const scored = files.map((path, i) => ({
    path,
    p: result.ok ? probability(result.answers[`f${i}`]) ?? 1 : 1,
  }));
  const keep = scored.filter(s => s.p >= 0.6);
  const gold = ["src/decisions.ts", "index.ts"];
  const goldKept = gold.filter(g => keep.some(k => k.path === g || k.path.endsWith(g)));
  console.log(JSON.stringify({
    files: scored, keep: keep.map(k => k.path), gold, goldKept, goldLost: gold.filter(g => !goldKept.includes(g)),
    ratio: 1 - keep.length / files.length, usage: service.usage(), ok: result.ok,
  }, null, 2));
}
void main();
