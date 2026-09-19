# pi-jev-assist

A [Pi](https://github.com/earendil-works/pi-mono) extension that checks an agent's work against **observation**, not against its own account of itself.

It runs by itself. No slash command to remember. Speaks when it has something; silent otherwise. Never edits your code, never certifies done, never starts a turn.

```
enumerate mechanically  →  classify with Jev  →  you decide
   git, ripgrep,            small, self-contained     authority never
   a call graph             items; abstention          moves
```

Every tool that asked Jev to **find** a defect failed its known-bad case. Every tool that asked it to **rank or score** pre-enumerated evidence discriminated.

![Session lifecycle: start, each tool, settled, compact](docs/lifecycle.svg)

```mermaid
flowchart LR
  A[session_start<br/>warm graph] --> B[before_agent_start<br/>live skills]
  B --> C[tool_call<br/>blast radius]
  C --> D[tool_result<br/>clip huge dumps]
  D --> E[context<br/>live prune]
  E --> F[agent_settled<br/>ledger + diff]
  F --> G[compact<br/>verbatim]
```

A diff shows what code **says**, never that it **works**. Tests remain the only authority on behaviour.

---

## Pre-write blast radius

`tool_call` is the only hook that runs **before** a change and can block. Unconsidered callers were **12% of blocking** review findings in 1,252 comments. A check after the diff is too late.

Speed bump, not a gate: once per file per session. Re-issue the edit and it proceeds. Fails open if the graph is down.

![What you see: edit blocked with caller list](docs/blast.svg)

What Pi shows on the first `edit` of a `.ts` file:

```
Before editing src/decisions.ts — 3 caller(s) depend on what it exports:
  index.ts — installAssist (depth 1)
  test/extension.test.ts — harness (depth 2)

From the Vortex call graph, mechanically. Check these still work, then
repeat the edit — this fires once per file.
```

Vortex when present (transitive `Calls`, including callers that **never mention** the symbol). Without it, bundled ripgrep covers the same ground **and says so**.

---

## Clip huge dumps

A 48k test log sits in **every later prefill**. Over 20k characters: keep 6k head + 2k tail. No Jev, ~0 ms. Failure at the **end** of the log still shows.

![Before: full dump in context. After: head, omission note, tail](docs/clip.svg)

What the model actually receives:

```
<first 6000 characters of bun test>

… 40102 characters omitted (head+tail kept; re-run the tool if you need the middle)

FAIL  src/guard.test.ts
AssertionError: expected 200, got 403
```

Measured on six real sessions: **0–29%** of tool-result characters (zero when nothing was that large).

---

## Live prune

Same Jev questions as compaction, but **every turn** after ≥8k of finished tool output — you do not wait for `/compact`. Last 6 messages pinned. Fail-open.

Notify:

```
Jev live-pruned 8 tool result(s); 43% smaller context.
```

A dropped result in history becomes:

```
[tool output dropped as finished, 4120 chars; re-run the tool if needed]
```

| Slice | Cut |
| --- | --- |
| Live Jev, last 40 messages | **43%** of judged tool text · **14%** of the slice |
| Drop all but last 6 (upper bound, 5.6MB session) | **~21%** of the session |

---

## Verbatim compaction

Pi’s default compact **summarises**. A summary loses the path, the error string, the constraint. This **selects**: survivors are byte-for-byte.

Real 60-message span: **130,464 → 23,921 characters (81.7% smaller)**. User constraints intact word for word.

```
# Earlier context, pruned rather than summarised

Kept text is VERBATIM. Only finished tool output was removed.

## User
Fix the failing test. Never edit src/generated.

- read({"path":"src/a.ts"}) → ok, 4000 chars, output dropped as finished
```

Falls back to Pi’s summariser if saving &lt;25%, Jev fails, split turn, or there is no tool output to prune.

Live prune **remembers** each tool-call id and writes `prune-cache.json` so `/resume` does not re-pay Jev. Identical Jev payloads are cached 120s and in-flight calls coalesce.

Read/grep output is screened for **instructions aimed at an AI**. A reconstructed whole file is judged before a write/edit (not just the hunk). Claims use the **HEAD snapshot at the user prompt**, so mid-task commits stay in the diff.

## Bash failure class

On a failed `bash` result, Jev picks `transient | environment | code_bug | permission | user_error | no_failure`. The sentence appended is **fixed in source**:

```
EACCES

[jev-assist] Permission failure: do not retry the same command; change the invocation or ask.
```

---

## Indexed search hits (browser-use / jev-ultrafast, for code)

`rg` output becomes a numbered table: path + the matching line, like their DOM `[3] combobox Where to?`. One Jev **choice** picks the first file to READ, a second choice may pick a caller. Independent noul-per-file coin-flipped (~0.50) and was discarded. Low confidence keeps the whole dump.

Live `rg reviewAdvice`: first choice **src/decisions.ts** at confidence **0.99**. Second head 0.38 → not used. Implementation kept; passing mentions dropped. Paths that do not exist on disk are dropped **before** Jev (no fake candidates from test separators).

```
[jev-assist] dropped 15 file(s) as low-relevance (README.md, docs/dup.svg, …).
Re-run the search if you need them.
```

## Vault write (create vs update)

After Vortex `prepare_write`, Jev chooses **ADD / UPDATE / SUPERSEDE / NOOP** from similar notes. The sentence is fixed in code. A `create_note` without `preflight_id` is speed-bumped once: run prepare_write first.

Session handoffs from `pi-vortex-hooks` now use **one draft title per session** and **update in place** when the existing note is still a machine-generated draft. Someone else’s note with the same title is still quarantined.

## Inactive tools, turned on (not “Jev plans bash”)

[TheoOliveira/pi-jev](https://github.com/TheoOliveira/pi-jev) does **not** pick the next shell command. It **lexical-shortlists inactive Pi tools**, then Jev noul “does this tool help?”, then `setActiveTools` **adds** them. We copied that. We still do **not** let Jev choose `rg` vs `read` vs `test` — that A/B was 0/3.

Fail-closed permission auto-mode (jomatsu, MoonTory) is a different product. We stay advisory.

## Duplicate tools, skipped

Agents re-run the same `rg` or `read` constantly. That is pure prefill cost. The **second identical** `bash` / `read` / `grep` this turn is blocked.

![First call runs, second identical call is blocked, edit clears the read fingerprint](docs/dup.svg)

```
Already ran this exact bash this turn. Reuse that output instead of repeating it.
```

A write/edit of that path forgets the read fingerprint, so a re-read after a change still works. New prompt → fingerprints clear.

## Task mode (Jev picks a key; code owns the sentence)

Same Jev call as skills. Jev chooses `investigate | implement | review | git | chat`. The sentence injected is **fixed in source** — Jev never authors instructions. Confidence below 0.70 → inject nothing.

![Jev selects investigate; the hint text is hardcoded](docs/mode.svg)

A hard constraint (noul ≥ 0.85) is echoed **verbatim**:

```
Task mode implement: after edits, consider callers and run the tests that cover the change.
User constraint, verbatim: Never edit src/generated.ts
```

Tried: letting Jev *plan* the next tool. Quality **0/3**. Mode is classification of the prompt, which is the thing Jev can do.

## Skill suggestions

Scores the catalogue Pi is **actually advertising this run**, not `~/.pi/skills`. At most two above **0.90**. Name and path only — never model-authored instructions. Over 128 skills: abstain, do not secretly shortlist.

Stripping unused skills from the system prompt was tried. At 0.90 it dropped **jev-review on a PR-triage prompt**. Suggestion-only stays.

---

## Evidence ledger

Every tool call is paired with its result by id. Redact **before** clip. `.env`, `auth.json`, `.ssh/`, `*.pem`, credential dumps: **withheld entirely**. Bounded: 120 entries, 300-char commands, 1,200-char excerpts.

`isError` is the only status Pi gives. The ledger never pretends `bun test` “passed”.

---

## Settled review

When the run goes idle on a clean `stop`, the final message is checked against the **ledger** and, if files changed, against the **working-tree diff**. Callers of what changed are ranked. Wrap-up prose with no check does not fire. Chrome that prints every turn gets ignored — only flags speak.

What you see when it disagrees:

```
Possible unresolved failure behind a completion claim: re-read the
failing output; an unrelated command that did not error is insufficient.
Advisory Jev signal, not verification. Tests, project rules and
permissions remain authoritative.
Acknowledge each point above before continuing: accept it and act, or
reject it and say on what evidence.
```

Claim checking: structural claims discriminate (5/6 on PR #989). “Revokes already-poisoned payloads” scored **0.84 on a miss** — absence is detection, where this fails. A `⚠ overstated` under a tick is a stop.

---

## What we tried for tokens and speed

| Experiment | Result | |
| --- | --- | --- |
| Clip dumps &gt;20k | 0–29% of tool chars · ~0 ms | **shipped** |
| Live prune | 14% of a 40-msg slice | **shipped** |
| Code-owned plan; Jev only “enough?” | Quality **3/3** · 7.2k vs 39.5k Pi · 1.6s vs 42s | pattern |
| Jev picks the next *bash step* | **0/3** quality · faster and wrong | no |
| Activate unused Pi tools (shortlist + noul) | TheoOliveira `jev_find_tools` — **not** a planner; we now do this | **shipped** |
| Rerank `rg` lines | Dropped `function reviewAdvice` | no |
| Rank files from paths | Every file ~0.58 · kept nothing | no |
| Strip skills below 0.90 | Dropped jev-review | no |

Jev classifies supplied evidence. It must not find, plan, or delete skills.

---

## Install

```sh
git clone <this repo> ~/Projects/pi-jev-assist
cd ~/Projects/pi-jev-assist && bun install
ln -s ~/Projects/pi-jev-assist ~/.pi/agent/extensions/jev-assist
```

`TYPESAFE_API_KEY` or owner-only `~/.config/typesafe/env` (`KEY=value`, parsed, never sourced). Restart Pi. `/jev-assist status`.

| | |
| --- | --- |
| `/jev-assist` | **Menu:** master switch, toggle each feature, pin, cache |
| `/jev-assist settings` | Same menu |
| `/jev-assist set livePrune off` | Persist one flag |
| `/jev-assist pin …` / `unpin` | Judge later work against this sentence |
| `/jev-assist cache 120` | Identical Jev payload cache (seconds) |
| `/jev-assist on` / `off` | Master switch |
| `PI_JEV_ASSIST=off` | Env kill switch wins |

![Settings: every feature can be toggled](docs/settings.svg)

Config: `~/.pi/agent/jev-assist/config.json`. Prune verdicts persist in `prune-cache.json` across `/resume`.

Vortex optional. Bounds (tested): **2.5 s**, **48 kB**/request, **6**/run **300**/session, breaker after 3 failures, redact then clip.

```sh
bun run check
```

[architecture](docs/architecture.md) · [measurements](docs/measurements.md) · [limitations](docs/limitations.md) · [vortex](docs/vortex.md) · [upstream](UPSTREAM.md)

MIT.
