# Upstream

## NiazMorshed2007/jev-review (MIT) — patterns adopted, no code vendored

Read at commit `24abaad` (all 888 source lines). Nothing is imported; four design
patterns were reimplemented here:

| Pattern | There | Here |
| --- | --- | --- |
| Applicability asked before scoring; `{applicable:false}` | `transform.ts:65-66`, `questions.ts:44-56` | `assessable_<i>` noul gates each finding; abstentions counted, never reported as weak support |
| Weakness as a `choice` over a fixed rubric with `no_material_issue` | `metrics.ts:24`, `questions.ts:64-69` | `GAPS` map with `no_material_gap`; an invented key yields no text |
| Throw when an answer is omitted | `transform.ts:55-63` | `IncompleteAnswersError`, surfaced as "incomplete judgment" rather than a dropped finding |
| Confidence bounded by `min()`, no blended overall score | `transform.ts:69-70` | `min(certainty(assessable), certainty(support), confidence)`; still no overall score |
| `max_tokens_exceeded` distinguished from generic HTTP failure | `client.ts:99-105` | `oversize_upstream` reason in `src/service.ts` |

**Deliberately not adopted:** the 1–10 scoring across 12 quality dimensions
(readability, modularity, abstraction…). That is a model rating code quality from
a diff with no execution evidence — the opposite of this integration's premise.
Also not adopted: agent-supplied diffs with no evidence ledger (cannot catch a
fabricated "tests pass"), env-var-only key handling (weaker than `loadLegacyKey`),
and automatic retries (the circuit breaker is preferred here). provenance

Inspected source snapshots (17 September 2026):

- [pi-warden](https://github.com/DevMortimer/pi-warden), MIT, `3e5404ee847fd861acf789db97c51c4a9a5902b3`, manifest 0.12.0.
- [pi-typesafe](https://github.com/DevMortimer/pi-typesafe), MIT, `0438bb8152dbe5d2418fde3c103b94ff38428a95`, manifest 0.4.0.
- [pi-jev](https://github.com/TheoOliveira/pi-jev), reference only, `cf402ec089cd2bc72836467851524196b0a28cef`.

Runtime imports use the exact published versions in package.json and bun.lock, not mutable Git HEAD. The first two projects' MIT licences are preserved under licenses/. Their standalone Pi extensions are not registered.

Direct reuse: pi-typesafe createTypeSafe and error contract; pi-warden redact, doneQuestions and stuckQuestions. The surrounding hook orchestration, evidence ledger and finding-priority policy are personal adaptation rather than claims of upstream behaviour.

The vendor/ inspection clones are ignored and not needed at runtime. To reproduce upstream source tests, clone the repositories and check out the hashes above, then run the command in README.md using this package's pinned dependencies. Offline test results establish the exercised compatibility only, not blanket security or semantic accuracy.
