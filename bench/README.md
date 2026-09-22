# Worker-routing experiments

These artefacts test the routing architecture. They are **not a claim that model routing preserves quality on arbitrary work**. Production alternatives remain unqualified until end-to-end evidence is reviewed.

## Frozen pilot 01

- Cases and exact-match scorer: `routing-cases.ts` (v1; do not retrospectively change its oracle).
- Original request outputs, timings, SDK usage and suite hash: `results/pilot-01.json`.
- Driver: `routing-live.ts`.
- Four bounded tasks: transitive caller scouting, source-based research, context curation, exact-route debugging.
- Three routes, four fresh-session observations and four resumed-session observations each: 24 real requests.
- Native subscription-authenticated Codex/xAI routes only. Anthropic and custom transports are excluded pending billing-path verification.
- No tools, repository content, credentials, Jev classification, orchestration or parent review were included.

| Route | Exact oracle | Median response | Aggregate latency | Output tokens, including reported reasoning | Catalogue list-price equivalent |
| --- | ---: | ---: | ---: | ---: | ---: |
| openai-codex/gpt-6-astra | 7/8 | 3.960 s | 30.793 s | 251 | $0.083230 |
| openai-codex/gpt-5.6-sol | 7/8 | 3.562 s | 30.348 s | 473 | $0.050870 |
| xai/grok-4.7 | 6/8 | 5.790 s | 63.589 s | 4,418 | $0.056908 |

These price equivalents are **not invoices, marginal subscription charges or measured savings**. Actual charges and remaining subscription quotas were not exposed and remain unknown. Sample sizes do not justify ranking models or statistical non-inferiority.

### Rubric findings

All four failures concern the research case:

- Astra, fresh: answered correctly and supplied S2/S4, omitting redundant S1. V1 requires the exact S1/S2/S4 array. This is an oracle-design problem; the stored v1 score remains a failure.
- Sol, fresh: answered correctly but returned expanded source labels rather than bare IDs. The next rubric should explicitly specify and normalise source identifiers.
- Grok, fresh and resumed: omitted the unresolved account-entitlement/current-price facts in S4. This is a substantive omission.

Any revised rubric must get a new version/hash and be frozen **before** a rerun. Do not retroactively turn these observations into qualification passes.

### Cache findings

The SDK reported zero cache reads for both Codex routes. Grok reported 8,064 cache-read tokens: 4,608 in fresh-local-session cases and 3,456 in resumed cases.

A new local session key does not prove a cold provider cache. A resumed transcript does not prove a warm one. The Codex prefix was short (roughly 850 input tokens per request); this pilot is not a cache-efficiency test. SDK-normalised zeros can also mask absent raw telemetry. No cache-hit-rate or cache-savings conclusion is warranted.

## Running the pilot

Explicit opt-in is required:

```sh
bun test test/routing-benchmark.test.ts
bun run bench/routing-live.ts --live --output bench/results/pilot-new.json
```

`--routes` takes 1–4 exact comma-separated provider/model IDs; `--repeats` accepts 1–3. Every response is bounded to 1,536 output tokens and a 90-second deadline. The driver fails rather than changing routes when authentication, endpoint provenance or output route does not match. It saves partial observations after each response.

## Accepted-result benchmark

`accepted-result-live.ts` uses actual managed workers, three coding fixtures plus scout/research/curate cases, a fresh baseline reviewer and at most one repair. Stable and changed-prefix conditions are paired in seeded order. Both entry points make no calls unless explicitly launched in live mode.

A live run requires all of `--routes`, `--baseline`, `--seed`, `--output`, `--max-requests`, `--max-output-tokens`, `--max-tokens-per-request`, `--deadline-ms` and `--acknowledge-envelope`. `--repeats` defaults to two. The driver prints the planned observations and call ceiling, then locally preflights every exact subscription route before inference. It does not replace missing routes.

Each native request reserves its entire output-token allocation; unused allocation is deliberately not refunded. This bounds requests and allocated output, **not input tokens, quota consumption or monetary charges**. A whole-run deadline terminates the active host process tree. Exhaustion, interruption and provider/authentication failure leave incomplete evidence that cannot qualify. Codex uses SSE with retries disabled, avoiding automatic WebSocket recovery.

Write workers and controller-run fixture code execute with the launching account's privileges. Linked worktrees are not an OS sandbox. Use a disposable restricted environment for adversarial inputs; never interpret hidden fixture placement as filesystem secrecy. Synthetic fixture results are not a universal quality guarantee.

Prepare a completed run for manual import with `bench/prepare-import-bundle.ts`; see [qualification controls and evidence validation](../docs/worker-routing.md). Conversion is offline and never installs trust. Jev classification and an existing parent conversation's review overhead remain outside this synthetic benchmark.

## Qualification gates

Microbenchmarks never qualify implementation workers. End-to-end trials must include fixed fixtures and hidden checks, identical tool/turn budgets, repeated paired order, independent review, failures and repair attempts. Record both worker-only correctness and time/tokens to an accepted result, including Jev, dispatch, review and repair overhead. Protect the held-out cases from tuning.

Cache experiments must use useful realistic prefixes at several sizes, append-only continuation and equal-length changed-prefix controls. Record source/context fingerprints and actual provider observations where available; report unknowns explicitly. Do not promote a faster route that fails any critical acceptance requirement. Benchmark evidence must name the baseline route, task class, suite revision and expiry; changing the baseline invalidates automatic transfer of that qualification.
