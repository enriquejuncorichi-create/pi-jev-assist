#!/usr/bin/env bun
/**
 * Measure token-spend levers on REAL Pi session transcripts (ccd-platform, this repo).
 * No edits to those sessions. Live Jev only for one replayed prune.
 *
 *   bun scripts/measure-spend.ts
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createService } from "../src/service.js";
import { collectCalls, pinnedIds, buildState, questionsFor, batchCalls, decide, applyDecisionsToMessages, clipHugeText, type Decision } from "../src/compaction.js";

function loadJsonl(path: string): unknown[] {
  const rows: unknown[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* skip */ }
  }
  return rows;
}

function messagesFromSession(path: string): unknown[] {
  const rows = loadJsonl(path);
  const out: unknown[] = [];
  for (const row of rows) {
    const r = row as { type?: string; message?: unknown };
    if (r.type === "message" && r.message) out.push(r.message);
    else if ((row as { role?: string }).role) out.push(row);
  }
  return out;
}

function chars(messages: unknown[]): number {
  let n = 0;
  for (const m of messages) n += JSON.stringify(m).length;
  return n;
}

function findSessions(root: string, limit = 8): string[] {
  const found: Array<{ path: string; size: number }> = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 4) return;
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      const p = join(dir, name);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p, depth + 1);
      else if (name.endsWith(".jsonl") && st.size > 50_000) found.push({ path: p, size: st.size });
    }
  };
  walk(root, 0);
  return found.sort((a, b) => b.size - a.size).slice(0, limit).map(f => f.path);
}

function mechanicalClip(messages: unknown[]) {
  let before = 0, after = 0, n = 0;
  const clone = structuredClone(messages);
  for (const raw of clone) {
    const m = raw as { role?: string; content?: Array<{ type?: string; text?: string }> };
    if (m.role !== "toolResult" || !Array.isArray(m.content)) continue;
    const t = m.content.find(c => c.type === "text" && typeof c.text === "string");
    if (!t?.text) continue;
    before += t.text.length;
    const c = clipHugeText(t.text);
    if (c.clipped) {
      t.text = c.text;
      n++;
    }
    after += (t.text ?? "").length;
  }
  return { n, before, after, ratio: before ? 1 - after / before : 0, clone };
}

async function jevPrune(messages: unknown[], goal: string) {
  const service = createService({ timeoutMs: 4000, maxRequests: 40 });
  const { transcript, calls } = collectCalls(messages);
  const pinned = pinnedIds(transcript, calls, 6);
  const judged = calls.filter(c => !pinned.has(c.id) && (c.resultChars ?? 0) >= 400);
  const decisions = new Map<string, Decision>();
  const state = buildState(transcript, goal);
  for (const batch of batchCalls(judged.slice(0, 16))) {
    const result = await service.evaluate({ state, questions: questionsFor(batch) });
    if (!result.ok) {
      batch.forEach(c => decisions.set(c.id, "keep"));
      continue;
    }
    batch.forEach((c, i) => decisions.set(c.id, decide(result.answers, i, 0.5)));
  }
  const clone = structuredClone(messages);
  const outcome = applyDecisionsToMessages(clone, decisions, 300);
  return { usage: service.usage(), judged: judged.length, decisions: [...decisions.values()], outcome, charsBefore: chars(messages), charsAfter: chars(clone) };
}

const DAILY = [
  "Fix the failing typecheck in this package and run the tests.",
  "Who calls reviewAdvice and what thresholds does it use?",
  "Triage this PR review comment and say whether it is a real bug.",
  "What is 2+2?",
  "Add a revocation step for poisoned scheduler payloads.",
];

async function skillScores() {
  const service = createService({ timeoutMs: 4000, maxRequests: 40 });
  const skills = [
    { name: "jev-review", description: "Adjudicate claims with jev before acting." },
    { name: "diagnose-crash", description: "Diagnose coredumps and segfaults." },
    { name: "omarchy", description: "Linux desktop Hyprland customization." },
    { name: "vault-plan", description: "Build a Vortex vault plan cluster." },
    { name: "typesafe-ai", description: "Build with TypeSafe System One models." },
    { name: "pi-interactive-shell", description: "Launch interactive coding-agent CLIs." },
  ];
  const rows = [];
  for (const prompt of DAILY) {
    service.beginRun();
    const questions: Record<string, unknown> = {};
    skills.forEach((s, i) => {
      questions[`s${i}`] = { type: "noul", instructions: `Does skill ${s.name} (${s.description}) directly provide specialised guidance for: ${prompt}` };
    });
    const result = await service.evaluate({ state: { prompt, skills }, questions });
    const keep = result.ok
      ? skills.filter((_, i) => ((result.answers[`s${i}`] as { noul?: number } | undefined)?.noul ?? 0) >= 0.9)
      : skills;
    rows.push({ prompt, ok: result.ok, keep: keep.map(s => s.name), dropped: skills.length - keep.length });
  }
  return { usage: service.usage(), rows };
}

async function main() {
  const sessionRoot = join(homedir(), ".pi", "agent", "sessions");
  const paths = findSessions(sessionRoot, 6);
  const mechanical = paths.map(path => {
    const messages = messagesFromSession(path);
    const clip = mechanicalClip(messages);
    const { calls } = collectCalls(messages);
    const toolChars = calls.reduce((n, c) => n + (c.resultChars ?? 0), 0);
    return {
      path: path.slice(-80),
      messages: messages.length,
      sessionChars: chars(messages),
      toolCalls: calls.length,
      toolChars,
      clipN: clip.n,
      clipRatio: Number(clip.ratio.toFixed(3)),
      // Drop-all-but-recent-6 simulation (upper bound if Jev agrees they are finished)
      naiveLive: (() => {
        const pinned = pinnedIds(collectCalls(messages).transcript, collectCalls(messages).calls, 6);
        const clone = structuredClone(messages);
        const decisions = new Map<string, Decision>();
        for (const c of collectCalls(messages).calls) decisions.set(c.id, pinned.has(c.id) ? "keep" : "drop");
        const o = applyDecisionsToMessages(clone, decisions, 300);
        return { ratio: o.charsBefore ? Number((1 - o.charsAfter / o.charsBefore).toFixed(3)) : 0, mutated: o.mutated };
      })(),
    };
  });

  const fattest = paths[0];
  let live: unknown;
  if (fattest) {
    const messages = messagesFromSession(fattest).slice(-40);
    live = await jevPrune(messages, "Continue the engineering work in this session without losing constraints.");
  }
  const skills = await skillScores();
  const report = { mechanical, live, skills, generatedAt: new Date().toISOString() };
  const out = join("/tmp", `jev-spend-${process.pid}.json`);
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ out, sessions: mechanical.length, live: live && { ...(live as object) }, skills: skills.rows }, null, 2));
}

void main();
