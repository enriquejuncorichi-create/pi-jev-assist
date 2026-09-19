# Measurements

Everything here was measured against real data. **The failures are kept, in
detail, because they are the reason the working parts are shaped as they are.**

## The finding that shaped everything

Seven tools were built and measured. They split cleanly:

| Asked Jev to… | Tool | Result |
| --- | --- | --- |
| **Find** a defect | `mutation-check` | **0 of 10** known-bad commits caught |
| **Find** a defect | `unpinned-hunks` | No operating point discriminates |
| **Find** a defect | `guard_fails_open` check | **Inverted** — scored the fix higher than the bug |
| **Find** a defect | `test_asserts_fixture` check | 0.36 vs 0.33 — noise |
| **Rank** supplied evidence | caller ranking | Clean separation, 1.57–2.08 vs 0.99–1.01 |
| **Score** supplied evidence | claim checking | 5 of 6, the miss demoted to a warning |
| **Score** supplied evidence | vault dedupe | 0.39–0.90 vs 0.03–0.06 |

**Jev is a classifier over supplied state, not a detector.** Asking "is there a
bug in this 62 KB diff?" fails because the answer is not in the state — it needs
tracing callers and execution the model was never given. Asking "does this one
line change behaviour, given this described change?" works, because it does.

## Blast radius: call graph vs text search

One symbol, `uploadToLibrary`, in a 25,843-node indexed repository.

| | Vortex call graph | ripgrep |
| --- | --- | --- |
| Depth 1 | `attachBlob` | — |
| Depth 2 | 5 callers across 3 packages | — |
| Depth 3 | `repairPendingAttachments`, `recordInbound` | — |
| Noise | none | ~20 hits from one test file, plus docs |
| Same-named twin in another package | correctly ignored | reported as related |
| Unindexed workspace | **hard error**, names what is indexed | silently empty |

`recordInbound` is three hops away and **contains the symbol's name nowhere**. No
text search reaches it at any effort. That is the case for preferring the graph.

The refusal matters as much as the reach: an empty result is only meaningful when
the call succeeded, which is why every failure path falls back to text search and
**says so** rather than printing nothing.

## Compaction

Real 60-message session span:

| | |
| --- | --- |
| Before | 130,464 characters |
| After | 23,921 characters (**81.7% smaller**) |
| Decisions | 17 dropped, 9 truncated, 3 pinned |
| Preserved | the user's constraints, word for word |

The live run also found what the unit tests could not: 26 calls ask 52 questions,
over Jev's 32-question ceiling, and the **entire request was rejected**. Now
batched at 16 calls, and a failed batch keeps its calls rather than dropping them.

## Vault deduplication

The vault enumerates 5,094 near-duplicate pairs mechanically. Labels come from its
own duplicate-title scan. Run **titles withheld**, because the obvious test is
rigged — positives share a title, so string matching scores 100% without reading:

| | Score |
| --- | --- |
| Same-subject pairs | 0.39–0.90 |
| Unrelated pairs | 0.03–0.06 |

**The most useful result was the apparent miss.** A "known-same" pair scored 0.06.
Inspection showed the *label* was wrong: a sync-conflict file sharing a title
while containing entirely different content. The title scan says "merge these";
Jev said "different subject" and was right. Merging on the title alone would have
destroyed work.

## Claim checking

Six claims of known truth against PR #989's real diff:

| Claim | Truth | Scored |
| --- | --- | --- |
| Adds the guard | true | 0.91 ✓ |
| Adds the allowlist | true | 0.88 ✓ |
| Wires it into the page actions | true | 0.94 ✓ |
| Adds a database migration | **false** | 0.13 ✗ |
| **Revokes already-poisoned payloads** | **false** | **0.84 — wrong** |
| Tests pass, no regression | not settleable | abstained ✓ |

Five of six. The miss is the consequential one and is kept in the docs: the diff
really does touch `schedule_overrides`, so revocation *looks* present, and
deciding it is absent requires reasoning about what code does **not** do — which
is detection, where this fails. An `overstated` flag now demotes a tick to
"verify by hand"; it fired at 0.70 on exactly that miss.

## Review corpus

1,252 inline review findings across 131 pull requests, harvested from a real
repository:

| Class | All findings | Of 108 blockers |
| --- | --- | --- |
| Blast radius / broken caller | 126 (10.1%) | **12.0%** |
| Test would still pass | 125 (10.0%) | 2.8% |
| Unverified claim / overstated | 116 (9.3%) | 6.5% |
| Guard fails open | 81 (6.5%) | **10.2%** |
| Stale state needs revocation | 39 (3.1%) | 7.4% |

This is what the tooling is aimed at, and why the pre-write hook exists.

## Token spend and speed (2026-09-19)

Tried several Jev shapes on **real** day-to-day work (ccd-platform sessions, this repo's `reviewAdvice` investigation, a 6-task closed fixture). Failures kept because they are the operating rule.

### What discriminated

| Experiment | Quality | Tokens | Speed | Ship? |
| --- | --- | --- | --- | --- |
| **Mechanical clip** of tool results >20k chars (head+tail, no Jev) | Gold errors at the tail survive by construction | 0–29% of *tool-result* chars on 6 real sessions (0 on two that never dumped 20k) | ~0 ms | **Yes** — `tool_result` |
| **Live prune** (same Jev questions as compaction, every turn after 8k prunable chars) | Last-40 of a real session: 8/8 judged `drop`/`truncate`; user text untouched | Tool text 41 125 → 23 471 (**43%**); whole slice 130 479 → 112 161 (**14%**). Naive drop-all-but-recent-6 on full sessions: **71–95%** of tool text, **~21%** of a 5.6 MB ccd-platform session | Jev ~1 call / 8k volume, not on the first turns | **Yes** — `context` hook, fail-open, last 6 messages pinned |
| **Code-owned plan, Jev only scores “enough evidence?”** on `reviewAdvice` | **3/3** (flags, callers, tests green) | 7 201 Jev tokens vs Pi **39 471** last-total (**82% less**) | **1.6 s vs 42.2 s** (**96% faster**) | Pattern for *mechanical* investigations, not a general agent |
| Closed-set Jev **tool dispatch** (tiny fixture) | **18/18** gold, 3 repeats | 11.7k in / 2.2k out for 18 calls | **228–326 ms** / task | Fixture only |

### What failed its own gold — do not ship

| Experiment | What happened |
| --- | --- |
| Jev as **planner** over 7 closed actions (`heavy-task-ab`) | 3.1 s, 12 steps, **quality 0/3**. Looped `rg`/`read`, never ran tests. Pi: 42 s, 7 tools, **3/3**. Faster *and wrong*. |
| **Line rerank** of a real `rg reviewAdvice` dump | Dropped **`src/decisions.ts` function reviewAdvice`** — the implementation. 5.7% smaller, gold lost. |
| **File rank** from paths only | Every file ~0.56–0.59 (coin-flip). Threshold 0.6 kept **nothing**, including `src/decisions.ts` and `index.ts`. |
| **Skill-thinning** at 0.90 on five daily prompts | Dropped **all six** skills, including `jev-review` on a PR-triage prompt. Would have stripped mandatory guidance. Suggestion-only stays. |
| Jev “enough evidence?” stop-early at 0.70 | Never fired; the scripted pipeline still ran all four steps. Scoring “enough” is conservative, which is the right failure. |

### Against the 30% / 20% targets

- **Long Pi sessions (the expensive days):** live prune + huge-clip is the general lever. Measured **14%** on a live Jev slice and **~21%** of a 5.6 MB session if old tool dumps are dropped. That is **not** 30% by itself. Combined with existing verbatim compaction (already **81.7%** when `/compact` fires) it is how later turns get cheaper *before* the compact threshold.
- **Mechanical investigate/test loops:** replacing the LLM with **code-owned steps + Jev as a stop judge** beat Pi by **~80% tokens and ~20× wall-clock** with matching gold. That *is* the 30%/20% target, but only for that shape of work — Jev must not choose the next tool.
- **Short chat / one-shot edits:** no lever here hits 30% without deleting skills or planning with Jev, both of which failed gold.

Rule, same as the rest of this file: **classify supplied evidence, do not find, do not plan.**

## Bugs found by running, not by testing

Three of this project's own defects passed a green suite:

1. **ripgrep read stdin.** With no path argument and a non-TTY stdin, `rg`
   searches stdin, not the directory. By hand it found dozens of references; from
   a test or the extension it found **none** — a whole-repository scan reported
   "no references" for 192 symbols, and the first explanation offered was route
   conventions. It was this. Fixed: **0 → 13,143 references**.
2. **A negation inverted the claim check.** Asked to assert things it had not
   done, an assistant instead wrote *"I did not add input validation"* — true,
   absent from the diff, and accused at 0.35.
3. **52 questions exceeded a 32-question ceiling**, so the whole compaction
   request was rejected. Unit tests used spans too small to trip it.

**Interactive verification is not verification.**
