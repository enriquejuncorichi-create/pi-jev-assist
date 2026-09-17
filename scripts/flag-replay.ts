// Replay REAL recorded Pi tool evidence, substituting only the final assistant
// message with a fabricated claim. The evidence is observation; the claim is the
// variable under test. Live Jev calls.
import { readFileSync } from 'node:fs';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { installAssist } from '../index.js';

const [journal, ...claimParts] = process.argv.slice(2);
const claim = claimParts.join(' ');
const events = readFileSync(journal!, 'utf8').split('\n').flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });
const prompt = events.find(e => e.type === 'session')?.prompt
  ?? events.find(e => e.type === 'agent_start')?.messages?.[0]?.content?.[0]?.text ?? 'recorded task';

const handlers = new Map<string, (event: never, ctx: ExtensionContext) => unknown>();
const entries: any[] = []; const posted: string[] = [];
const pi = { on: (n: string, f: any) => handlers.set(n, f), appendEntry: (_t: string, d: any) => entries.push(d),
  sendMessage: (m: any) => posted.push(m.content), registerCommand: () => {} } as unknown as ExtensionAPI;
const ctx = { hasUI: false, isIdle: () => true } as ExtensionContext;
installAssist(pi, { readEnabled: () => true, saveEnabled: () => {} });
const emit = (n: string, e: unknown) => Promise.resolve(handlers.get(n)?.(e as never, ctx));

await emit('session_start', {});
await emit('before_agent_start', { prompt, systemPromptOptions: { skills: [] } });
for (const e of events) {
  if (e.type === 'tool_execution_start') await emit('tool_execution_start', e);
  if (e.type === 'tool_execution_end') await emit('tool_execution_end', e);
}
await emit('message_end', { message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: claim }] } });
await emit('agent_settled', {});
const review = entries.find(e => e.stage === 'review');
console.log(JSON.stringify({ claim, reviewStatus: review?.status, flags: review?.flags ?? null,
  ranking: review?.ranking ?? null, posted: posted.length }, null, 1));
