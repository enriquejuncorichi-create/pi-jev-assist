import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { deadlineRemaining, parseEnvelope, parsePreflightRoutes, reservationLedger } from '../bench/benchmark-budget.js';

const args = ['--max-requests', '3', '--max-output-tokens', '24', '--max-tokens-per-request', '8', '--deadline-ms', '1000', '--acknowledge-envelope'];
describe('benchmark hard envelope', () => {
  it('requires every explicit limit and acknowledgement', () => {
    assert.deepEqual(parseEnvelope(args), { maxRequests: 3, maxOutputTokens: 24, maxTokensPerRequest: 8, deadlineMs: 1000 });
    for (const flag of ['--max-requests', '--max-output-tokens', '--max-tokens-per-request', '--deadline-ms', '--acknowledge-envelope']) {
      const copy = [...args];
      copy.splice(copy.indexOf(flag), flag === '--acknowledge-envelope' ? 1 : 2);
      assert.throws(() => parseEnvelope(copy));
    }
  });
  it('rejects unsafe, zero, negative, fractional, duplicate and overflowing limits', () => {
    for (const value of ['0', '-1', '1.5', 'NaN', 'Infinity', '9007199254740992', '--live']) {
      assert.throws(() => parseEnvelope(['--max-requests', value, ...args.slice(2)]));
    }
    assert.throws(() => parseEnvelope([...args, '--max-requests', '3']));
    assert.throws(() => parseEnvelope(args.map(value => value === '1000' ? '2147483648' : value)));
    assert.throws(() => parseEnvelope(args.map(value => value === '24' ? '7' : value)));
  });
  it('reserves the full allocation without refunds across calls and observations', () => {
    const parent = reservationLedger(parseEnvelope(args));
    const first = reservationLedger(parent.remaining());
    assert.equal(first.reserve(), 8);
    assert.equal(first.reserve(), 8);
    parent.deduct(first.used);
    const second = reservationLedger(parent.remaining());
    assert.equal(second.reserve(), 8);
    assert.throws(() => second.reserve());
    parent.deduct(second.used);
    assert.deepEqual(parent.used, { requests: 3, outputTokens: 24 });
    assert.throws(() => parent.reserve());
  });
  it('output and request limits independently stop the next provider request', () => {
    const output = reservationLedger({ maxRequests: 10, maxOutputTokens: 15, maxTokensPerRequest: 8 });
    output.reserve();
    assert.throws(() => output.reserve());
    assert.deepEqual(output.used, { requests: 1, outputTokens: 8 });
    const requests = reservationLedger({ maxRequests: 1, maxOutputTokens: 80, maxTokensPerRequest: 8 });
    requests.reserve();
    assert.throws(() => requests.reserve());
  });
  it('missing or malformed host counters fail closed without modifying the ledger', () => {
    const ledger = reservationLedger(parseEnvelope(args));
    for (const value of [undefined, null, {}, { requests: '1', outputTokens: 8 }, { requests: 1, outputTokens: 1 }, { requests: -1, outputTokens: -8 }, { requests: 4, outputTokens: 32 }, { requests: 0.5, outputTokens: 4 }, { requests: Infinity, outputTokens: Infinity }]) {
      assert.throws(() => ledger.deduct(value));
      assert.deepEqual(ledger.used, { requests: 0, outputTokens: 0 });
    }
    ledger.deduct({ requests: 2, outputTokens: 16 });
    assert.throws(() => ledger.deduct({ requests: 2, outputTokens: 16 }));
  });
});
describe('bounded preflight and whole-run deadline', () => {
  it('uses one monotonic deadline across setup, observations and teardown', () => {
    assert.equal(deadlineRemaining(100, 1000, 100), 1000);
    assert.equal(deadlineRemaining(100, 1000, 900), 200);
    assert.equal(deadlineRemaining(100, 1000, 1100), 0);
    assert.equal(deadlineRemaining(100, 1000, 1500), 0);
  });
  it('preflight includes exact native routes only and deduplicates', () => {
    assert.deepEqual(parsePreflightRoutes(['--preflight', '--routes', 'xai/model,openai-codex/model,xai/model']), ['xai/model', 'openai-codex/model']);
    for (const value of ['', 'xai/', 'tier', 'openai/model', 'xai/model,', 'xai/a b']) {
      assert.throws(() => parsePreflightRoutes(['--preflight', '--routes', value]));
    }
    assert.throws(() => parsePreflightRoutes(['--preflight']));
    assert.throws(() => parsePreflightRoutes(['--routes', 'xai/a', '--routes', 'xai/b']));
  });
});
