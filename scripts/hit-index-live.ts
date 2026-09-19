#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { createService } from "../src/service.js";
import { parseHits, hitRequest, selectHits } from "../src/hits.js";

const GOLD = ["src/decisions.ts", "index.ts"];

async function main() {
  const rg = spawnSync("rg", ["-n", "reviewAdvice", "--glob", "!node_modules/**", "--glob", "!.git/**"], {
    cwd: process.cwd(), encoding: "utf8",
  });
  const hits = parseHits(rg.stdout || "");
  const service = createService({ timeoutMs: 4000, maxRequests: 8 });
  const judged = await service.evaluate(hitRequest("What flags does reviewAdvice emit and who calls it?", hits));
  if (!judged.ok) {
    console.log(JSON.stringify({ ok: false, reason: judged.reason, hits: hits.length }));
    process.exit(1);
  }
  const picked = selectHits(hits, judged.answers);
  console.log(JSON.stringify({
    hits: hits.length,
    keep: picked.keep.map(h => h.path),
    dropped: picked.dropped.map(h => h.path),
    goldKept: GOLD.filter(g => picked.keep.some(h => h.path === g)),
    goldLost: GOLD.filter(g => !picked.keep.some(h => h.path === g)),
    answers: judged.answers,
    usage: service.usage(),
  }, null, 2));
}
void main();
