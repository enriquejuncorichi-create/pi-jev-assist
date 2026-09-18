/**
 * Live check of the pruning path against a REAL Pi session, without needing to
 * trigger Pi's own compaction. Reads a session JSONL, takes the oldest span of
 * messages, and runs exactly what the extension runs.
 *
 * Prints what would be kept, truncated and dropped, and whether the saving
 * clears the fallback threshold.
 */
import { readFileSync } from 'node:fs';
import { createService } from '../src/service.js';
import { collectCalls, pinnedIds, buildState, questionsFor, batchCalls, decide, render, reductionRatio, type Decision } from '../src/compaction.js';

const path = process.argv[2];
const span = Number(process.argv[3] ?? 60);
if (!path) { console.error('usage: compaction-smoke.ts <session.jsonl> [messages]'); process.exit(2); }

const messages: unknown[] = [];
for (const line of readFileSync(path, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  let entry: { type?: string; message?: unknown };
  try { entry = JSON.parse(line); } catch { continue; }
  // Session entries wrap the message; only real conversation messages count.
  const message = entry.message as { role?: string } | undefined;
  if (entry.type === 'message' && message?.role) messages.push(message);
  if (messages.length >= span) break;
}
if (!messages.length) { console.error('no messages found in that session file'); process.exit(2); }

const { transcript, calls } = collectCalls(messages);
const pinned = pinnedIds(transcript, calls, 6);
const judged = calls.filter(c => !pinned.has(c.id));
const before = messages.reduce<number>((n, m) => n + JSON.stringify(m).length, 0);
console.log(`${messages.length} messages, ${calls.length} tool calls (${judged.length} judged, ${pinned.size} pinned), ${before} chars`);
if (!judged.length) { console.log('nothing prunable — would fall back to Pi\'s summary'); process.exit(0); }

const service = createService({ timeoutMs: 20000 });
service.beginRun();
const state = buildState(transcript, 'continue the session');
const decisions = new Map<string, Decision>();
let failures = 0;
for (const batch of batchCalls(judged)) {
  const request = { state, questions: questionsFor(batch) };
  console.log(`batch of ${batch.length}: ${Buffer.byteLength(JSON.stringify(request))} bytes, ${Object.keys(request.questions).length} questions`);
  const result = await service.evaluate(request);
  if (!result.ok) { console.log(`  unavailable (${result.reason}) — these calls are kept`); failures++; batch.forEach(c => decisions.set(c.id, 'keep')); continue; }
  batch.forEach((c, i) => decisions.set(c.id, decide(result.answers, i, 0.5)));
}
if (failures && ![...decisions.values()].some(d => d !== 'keep')) { console.log("every batch failed — would fall back to Pi's summary"); process.exit(0); }
const summary = render(transcript, decisions, 300);
const outcome = { summary, charsBefore: before, charsAfter: summary.length,
  kept: [...decisions.values()].filter(d => d === 'keep').length,
  truncated: [...decisions.values()].filter(d => d === 'truncate').length,
  dropped: [...decisions.values()].filter(d => d === 'drop').length, pinned: pinned.size };
const ratio = reductionRatio(outcome);
console.log(`kept ${outcome.kept}, truncated ${outcome.truncated}, dropped ${outcome.dropped}`);
console.log(`${before} → ${summary.length} chars (${(ratio * 100).toFixed(1)}% smaller) — ${ratio < 0.25 ? 'BELOW threshold, falls back to Pi' : 'used, no summary written'}`);
console.log(`usage ${JSON.stringify(service.usage())}`);
console.log('\n--- first 900 chars of the pruned, verbatim context ---');
console.log(summary.slice(0, 900));
