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
