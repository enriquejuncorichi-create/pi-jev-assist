# Architecture

## The shape

```
                    ┌──────────────────────────────────────┐
  session_start ───►│ ensure index · start watcher         │  no Jev call
                    └──────────────────────────────────────┘
                    ┌──────────────────────────────────────┐
  before_agent_start│ score the LIVE skill catalogue        │  1 Jev call
                    └──────────────────────────────────────┘
                    ┌──────────────────────────────────────┐
  tool_call ───────►│ pre-write: who calls this file?      │  graph only
   (write|edit)     │ speed bump, once per file, fails open │
                    └──────────────────────────────────────┘
                    ┌──────────────────────────────────────┐
  tool_execution_*  │ evidence ledger (redacted, bounded)  │  no Jev call
                    └──────────────────────────────────────┘
                    ┌──────────────────────────────────────┐
  agent_settled ───►│ review vs evidence                   │  1 Jev call
                    │ claims vs diff                       │  1 Jev call
                    │ callers of what changed              │  graph, or 1 call
                    └──────────────────────────────────────┘
                    ┌──────────────────────────────────────┐
  session_before_   │ prune tool output VERBATIM           │  1–2 Jev calls
  compact           │ else fall back to Pi's summariser    │
                    └──────────────────────────────────────┘
```

## Why each hook is where it is

### `session_start` — warm the graph, never index on the critical path

Fires for **every** entry point: `startup`, `reload`, `new`, `resume`, `fork`. A
resumed session gets the same warm graph as a fresh one.

Indexing a large repository takes minutes. Doing it at the first write would
either stall that edit or silently degrade the very first blast-radius check to
text search — which is precisely when the real answer matters most. So the index
is ensured here, fire-and-forget, and the walk usually lands before the first
write.

Two things reset here, both learned from getting them wrong:

- **Per-file speed bumps clear.** They are per session; a resumed or switched
  session must not inherit "already warned" from another.
- **The bootstrap re-runs if the cwd changed.** A resume or fork can land in a
  different directory, and the previous workspace's index says nothing about it.

### `before_agent_start` — skills, from the catalogue actually in use

Reads `event.systemPromptOptions.skills`. An earlier approach scanned
`~/.pi/skills`, which is not the directory Pi uses (`~/.pi/agent/skills`), so it
scored a catalogue nobody had. Only skills the model could already invoke are
suggested; `disableModelInvocation` is honoured; only name and path are injected.

Abstention is explicit: a catalogue over 128 skills is **not** silently
shortlisted, because quietly scoring a subset and reporting "none fit" is a lie
about coverage.

### `tool_call` — the only hook that runs BEFORE a change

`tool_call` can block; `tool_execution_start` cannot. That difference is the
whole reason the pre-write check lives here.

Design constraints, each of which is a test:

- **Once per file per session.** The second attempt proceeds.
- **Fails open.** Any error — no index, no daemon, a timeout — returns nothing.
- **Code files only** (`.ts .tsx .js .jsx .svelte`), and only `write`/`edit`.
- **Silent when there are no callers.** Nothing to say, so nothing is said.

### `tool_execution_start` / `_end` — the evidence ledger

Pairs calls with results by id. Everything about it is conservative:

- **`isError` is the only status signal Pi provides.** There is no exit code:
  `dist/core/tools/bash.js` populates `details` only for truncation. So `ok`
  means "the tool did not report an error", never "the checks passed", and the
  snapshot exposes no pass/fail verdict at all.
- **Sensitive paths and credential-dumping commands are withheld entirely** —
  not truncated, withheld.
- **Redaction happens before clipping**, so a secret cannot survive by being cut
  into a shorter string.
- **Bounded**: 120 entries, 300-character commands, 1,200-character excerpts, and
  what was dropped is counted and reported.

An earlier version classified recognised commands as passed/failed and tracked
"freshness" against mutations. It was deleted: measured against a real session it
never fired once, because Pi emits no exit code and real commands are compound
(`cd x && bun test | tail`). Its unit tests passed only because they supplied
`{exitCode: 0}` themselves — an input the runtime never produces.

### `agent_settled` — three checks, only when they can say something

Runs once per generation, only when idle, only on a clean `stop`, and only with a
final message. The claims and caller checks additionally require that the run
**changed files**.

### `session_before_compact` — select, do not rewrite

Pi's hook takes a summary **string**, not a pruned message list, so the summary
is a rendered transcript of the survivors: unrewritten, in order, with dropped
output reduced to a note. See [measurements](measurements.md#compaction).

## Modules

| File | Responsibility |
| --- | --- |
| `index.ts` | Hook registration, lifecycle, advisory delivery, controls |
| `src/service.ts` | The one bounded Jev client: deadlines, budgets, breaker, credential loading |
| `src/privacy.ts` | Redaction, extending Warden's with JSON-shaped credentials |
| `src/evidence.ts` | The tool-call ledger |
| `src/decisions.ts` | Skill and review request construction, answer interpretation |
| `src/autonomous.ts` | Claim extraction, caller enumeration, diff reading |
| `src/compaction.ts` | Call pairing, pruning decisions, verbatim rendering |
| `src/codegraph.ts` | The `vortexd --mcp` transport |
| `tools/blast-radius.sh` | The text-search fallback — ships here, runs anywhere |

## Lifecycle safety

A generation counter plus an `AbortController` guard every asynchronous result.
A response that arrives after a new prompt, a branch switch, a shutdown or a
disable is **discarded**, never injected. `sendMessage` is always
`{triggerTurn: false}` — the extension cannot cause a turn, and so cannot loop.
