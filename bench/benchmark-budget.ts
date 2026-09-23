export interface RequestBudget { maxRequests: number; maxOutputTokens: number; maxTokensPerRequest: number }
export interface Reservations { requests: number; outputTokens: number }

function integer(value: unknown, minimum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) throw new Error('Invalid benchmark budget counter');
  return value;
}
export function validateBudget(value: RequestBudget): RequestBudget {
  integer(value.maxRequests, 1); integer(value.maxOutputTokens, 1); integer(value.maxTokensPerRequest, 1);
  if (value.maxTokensPerRequest > value.maxOutputTokens) throw new Error('Per-request allocation exceeds output envelope');
  return value;
}
export function parseEnvelope(args: string[]): RequestBudget & { deadlineMs: number } {
  const read = (name: string) => {
    const index = args.indexOf(name);
    if (index < 0 || args.lastIndexOf(name) !== index || !/^\d+$/.test(args[index + 1] ?? '')) throw new Error(`Explicit integer ${name} required`);
    return integer(Number(args[index + 1]), 1);
  };
  if (!args.includes('--acknowledge-envelope')) throw new Error('Explicit --acknowledge-envelope required');
  const budget = validateBudget({ maxRequests: read('--max-requests'), maxOutputTokens: read('--max-output-tokens'), maxTokensPerRequest: read('--max-tokens-per-request') });
  const deadlineMs = read('--deadline-ms');
  if (deadlineMs > 2_147_483_647) throw new Error('Deadline exceeds timer range');
  return { ...budget, deadlineMs };
}
export function parsePreflightRoutes(args: string[]): string[] {
  const index = args.indexOf('--routes');
  if (index < 0 || args.lastIndexOf('--routes') !== index) throw new Error('Explicit --routes required');
  const routes = (args[index + 1] ?? '').split(',');
  if (!routes.length || routes.some(value => !/^(openai-codex|xai)\/[^\s,]+$/.test(value))) throw new Error('Exact native routes required');
  return [...new Set(routes)];
}
export function reservationLedger(budget: RequestBudget) {
  validateBudget(budget);
  const used: Reservations = { requests: 0, outputTokens: 0 };
  return {
    used,
    reserve(): number {
      if (used.requests >= budget.maxRequests || budget.maxOutputTokens - used.outputTokens < budget.maxTokensPerRequest) throw new Error('Benchmark reservation envelope exhausted');
      used.requests++; used.outputTokens += budget.maxTokensPerRequest;
      return budget.maxTokensPerRequest;
    },
    deduct(value: unknown): void {
      if (!value || typeof value !== 'object') throw new Error('Missing host reservations');
      const counters = value as Partial<Reservations>;
      const requests = integer(counters.requests, 0), tokens = integer(counters.outputTokens, 0);
      if (tokens !== requests * budget.maxTokensPerRequest || requests > budget.maxRequests - used.requests || tokens > budget.maxOutputTokens - used.outputTokens) throw new Error('Malformed host reservations');
      used.requests += requests; used.outputTokens += tokens;
    },
    remaining(): RequestBudget {
      return { maxRequests: budget.maxRequests - used.requests, maxOutputTokens: budget.maxOutputTokens - used.outputTokens, maxTokensPerRequest: budget.maxTokensPerRequest };
    },
  };
}
/** Monotonic deadline; injectable clock keeps boundary tests independent of models. */
export function deadlineRemaining(start: number, duration: number, now: number): number {
  return Math.max(0, duration - (now - start));
}
