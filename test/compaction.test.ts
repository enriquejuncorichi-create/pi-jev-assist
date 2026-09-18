import test from 'node:test';
import assert from 'node:assert/strict';
import { collectCalls, pinnedIds, buildState, questionsFor, decide, render, reductionRatio, type Decision } from '../src/compaction.js';

const assistant = (text: string, calls: Array<{id: string; name: string; args: unknown}> = []) => ({
  role: 'assistant',
  content: [
    ...(text ? [{ type: 'text', text }] : []),
    ...calls.map(c => ({ type: 'toolCall', id: c.id, name: c.name, arguments: c.args })),
  ],
});
const result = (id: string, name: string, text: string, isError = false) => ({
  role: 'toolResult', toolCallId: id, toolName: name, isError, content: [{ type: 'text', text }],
});
const user = (text: string) => ({ role: 'user', content: [{ type: 'text', text }] });

const SPAN = [
  user('Fix the failing test. Never edit src/generated.'),
  assistant('Reading it.', [{ id: 't1', name: 'read', args: { path: 'src/a.ts' } }]),
  result('t1', 'read', 'export const a = 1;\n'.repeat(50)),
  assistant('Running tests.', [{ id: 't2', name: 'bash', args: { command: 'bun test' } }]),
  result('t2', 'bash', 'AssertionError: 1 !== 2', true),
  assistant('The assertion is the bug.'),
];

test('calls pair with their results by id, mechanically', () => {
  const { transcript, calls } = collectCalls(SPAN);
  assert.equal(transcript.length, 6);
  assert.deepEqual(calls.map(c => c.id), ['t1', 't2']);
  assert.equal(calls[1]!.isError, true);
  assert.equal(calls[1]!.resultText, 'AssertionError: 1 !== 2');
  assert.equal(calls[0]!.resultChars, 1000);
});

test('an orphan result and a result-less call are handled without guessing', () => {
  const { calls, transcript } = collectCalls([
    result('missing', 'read', 'content of an unknown call'),
    assistant('', [{ id: 'lonely', name: 'bash', args: { command: 'sleep 1' } }]),
  ]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.resultText, undefined);
  assert.equal(calls[0]!.resultChars, undefined);
  // The orphan stays in the transcript; it is not attached to an invented call.
  assert.equal(transcript[0]!.resultFor, 'missing');
});

test('recent calls are pinned and never judged', () => {
  const { transcript, calls } = collectCalls(SPAN);
  const pinned = pinnedIds(transcript, calls, 3);
  assert.ok(pinned.has('t2'));
  assert.ok(!pinned.has('t1'));
});

test('the state hides tool OUTPUT but keeps inputs, text and a size note', () => {
  const { transcript } = collectCalls(SPAN);
  const state = buildState(transcript, 'fix the test') as {history: Array<{calls: Array<{result: string; input: string}>}>};
  const serialised = JSON.stringify(state);
  assert.ok(!serialised.includes('export const a = 1'), 'raw output must not be sent');
  assert.ok(serialised.includes('1000 chars (omitted here)'));
  assert.ok(serialised.includes('src/a.ts'), 'inputs are kept: they are small and identify the call');
  assert.ok(serialised.includes('error, 23 chars'));
});

test('a missing answer keeps everything', () => {
  // Deleting history because the judge went quiet is worse than not compacting.
  assert.equal(decide({}, 0, 0.5), 'keep');
  assert.equal(decide({ call_0: { noul: 0.9 } }, 0, 0.5), 'keep');
  assert.equal(decide({ result_0: { noul: 0.9 } }, 0, 0.5), 'keep');
});

test('decisions follow keepResult then keepCall', () => {
  const a = (call: number, res: number) => ({ call_0: { noul: call }, result_0: { noul: res } });
  assert.equal(decide(a(0.1, 0.9), 0, 0.5), 'keep');
  assert.equal(decide(a(0.9, 0.1), 0, 0.5), 'truncate');
  assert.equal(decide(a(0.1, 0.1), 0, 0.5), 'drop');
});

test('kept text is reproduced verbatim, never paraphrased', () => {
  const { transcript } = collectCalls(SPAN);
  const decisions = new Map<string, Decision>([['t1', 'drop'], ['t2', 'keep']]);
  const out = render(transcript, decisions, 300);
  assert.ok(out.includes('Fix the failing test. Never edit src/generated.'));
  assert.ok(out.includes('AssertionError: 1 !== 2'), 'a kept result stays exact');
  assert.ok(!out.includes('export const a = 1'), 'a dropped result is gone');
  assert.ok(out.includes('output dropped as finished'), 'and its absence is visible');
  assert.ok(out.includes('read({"path":"src/a.ts"})'), 'the call itself survives a dropped result');
});

test('a truncated result keeps its head and says how much went', () => {
  const { transcript } = collectCalls(SPAN);
  const out = render(transcript, new Map<string, Decision>([['t1', 'truncate']]), 20);
  assert.ok(out.includes('[tool result, truncated] export const a = 1;'));
  assert.match(out, /further characters dropped/);
});

test('reduction is measured so a poor saving can be rejected', () => {
  // A text-heavy span has no tool output to prune; the caller must fall back to
  // a real summary rather than emit a transcript that saves nothing.
  assert.equal(reductionRatio({ summary: '', charsBefore: 1000, charsAfter: 250, kept: 0, truncated: 0, dropped: 0, pinned: 0 }), 0.75);
  assert.equal(reductionRatio({ summary: '', charsBefore: 0, charsAfter: 0, kept: 0, truncated: 0, dropped: 0, pinned: 0 }), 0);
});

test('every call gets both questions', () => {
  const { calls } = collectCalls(SPAN);
  const q = questionsFor(calls);
  assert.deepEqual(Object.keys(q).sort(), ['call_0', 'call_1', 'result_0', 'result_1']);
});
