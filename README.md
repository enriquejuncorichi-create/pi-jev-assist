# pi-jev-assist

A [Pi](https://github.com/earendil-works/pi-mono) extension that checks an agent's
work against **observation** rather than against its own account of itself.

It runs by itself. There is nothing to invoke, no slash command to remember, and
no prompt to write. It watches a session, and when it has something worth saying
it says it — and when it does not, it stays silent.

```
enumerate mechanically  →  classify with Jev  →  you decide
   git, ripgrep,            small, self-contained     authority never
   a call graph             items; abstention          moves
                            is a first-class answer
```

That shape is not an aesthetic preference. It is the conclusion of a day of
measurement, recorded in [docs/measurements.md](docs/measurements.md): **every
tool built here that asked Jev to FIND something failed its own known-bad case,
and every tool that asked it to RANK or SCORE pre-enumerated evidence
discriminated cleanly.** Four failures, three successes, split exactly on that
line.

---

## What it does

| When | What happens | Cost |
| --- | --- | --- |
| Session starts | Ensures the workspace has a Vortex code index; starts a file watcher | Off the critical path |
| Before a run | Scores Pi's **live** skill catalogue against your prompt, suggests ≤2 above 0.90 | 1 Jev call |
| Before a write | Names the callers that depend on the file you are about to change | 1 graph call, sub-second |
| Every tool call | Records a redacted, bounded evidence ledger | None |
| Run settles | Reviews the final message against that evidence; checks its claims against the diff; ranks callers of what changed | ≤3 Jev calls |
| Compaction | Prunes finished tool output **verbatim** instead of summarising | 1–2 Jev calls |

Everything is advisory. It never grants a permission, never certifies
completion, never starts a follow-up turn, and never edits your code.

### Skill suggestions

Scores the skills Pi is actually advertising this run (`event.systemPromptOptions.skills`)
rather than scanning a directory that may not be the one in use. Only skills the
model could already invoke are ever suggested, and only their name and path are
injected — never model-authored instructions.

### Pre-write blast radius

`tool_call` fires before a tool runs and can block, so this is the only point
where the caller list arrives **before** the change rather than after it.

Broken or unconsidered callers are the largest class of *blocking* review finding
measured over 1,252 real review comments: **13 of 108 blockers, 12%**. That is a
planning failure, and a diff-seeded answer arrives too late to prevent it.

It is a **speed bump, not a gate** — once per file per session, and only when the
graph actually names callers. Re-issue the edit and it proceeds. It **fails open**
on every error: a missing index, a slow daemon or an unindexed workspace must
never stop an edit. A check that blocks work when its own infrastructure is down
gets uninstalled, and deserves to be.

### Evidence review and claim checking

At `agent_settled` the final message is checked two ways:

- against the **evidence ledger** — what was actually run, with what output
- against the **working-tree diff** — does the code do what the message says?

The second is deliberately better evidence than a hand-written claim: your own
summary of your own work scores well and proves nothing. A diff is an
observation.

**The hard limit, stated where it cannot be missed: a diff shows what the code
SAYS, never that it WORKS.** Tests remain the only authority on behaviour.

### Verbatim compaction

Pi's default compaction asks a model to summarise the messages it discards, and a
summary loses exactly the thing that matters later: an exact path, an error
string, a constraint. This selects instead of rewriting — survivors are
reproduced byte-for-byte, and dropped tool output becomes a one-line note naming
what went.

Measured on a real 60-message session: **130,464 → 23,921 characters, 81.7%
smaller**, with the user's constraints intact word for word.

It falls back to Pi's own summariser whenever the saving is under 25%, Jev fails,
the span is a split turn, or there is no tool output to prune. **A text-heavy span
has nothing to prune, so the fallback is the normal case, not an edge case.**

---

## Install

```sh
git clone <this repo> ~/Projects/pi-jev-assist
cd ~/Projects/pi-jev-assist && bun install
ln -s ~/Projects/pi-jev-assist ~/.pi/agent/extensions/jev-assist
```

Set a TypeSafe API key as `TYPESAFE_API_KEY`, or leave one at
`~/.config/typesafe/env` (owner-only, `KEY=value`, no shell expansion — it is
parsed, never sourced).

Restart Pi. `/jev-assist status` confirms it is live.

The symlink points at the working tree, so **an edit here is live in the next
session with no build step**.

### Controls

| | |
| --- | --- |
| `/jev-assist status` | Model, usage, on/off |
| `/jev-assist off` | Persisted to `~/.pi/agent/jev-assist/config.json` |
| `PI_JEV_ASSIST=off` | Environment kill switch; wins over the config file |
| `rm ~/.pi/agent/extensions/jev-assist` | Gone |

### Optional: the Vortex code graph

If [Vortex](https://github.com/enriquejuncorichi-create/vortex-rust-native) is
installed, blast radius comes from a real call graph — transitive `Calls` edges,
reaching callers that never mention the symbol. Without it, a bundled ripgrep
script covers the same ground textually, and says so.

Nothing breaks without Vortex. See [docs/vortex.md](docs/vortex.md).

---

## Bounds

Every hosted request is bounded, and the bounds are tested:

- **2.5 s** deadline, no retries
- **48,000 bytes** per request, checked on the serialised body
- **6 calls per run**, **300 per session**
- **circuit breaker** — three consecutive failures open it for 60 s
- **redaction before clipping**, so a secret cannot survive by being truncated
  into a shorter string
- sensitive paths (`.env`, `auth.json`, `.ssh/`, `*.pem`, credentials) are
  **never** sent — not their contents, not their command lines
- nothing is written to disk except decision metadata: hashes, scores, counts

---

## Documentation

| Document | Contents |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | Every hook, what it does, what it costs, and why it is where it is |
| [docs/measurements.md](docs/measurements.md) | What was measured, including everything that failed |
| [docs/vortex.md](docs/vortex.md) | The code-graph integration and its failure modes |
| [docs/limitations.md](docs/limitations.md) | What this cannot do, and the known false positives |
| [UPSTREAM.md](UPSTREAM.md) | Provenance for the ideas taken from other projects |

---

## Development

```sh
bun run check      # typecheck + 90 tests
bun run typecheck
bun run test
```

Tests are `node:test`, no network. The live checks are separate scripts under
`scripts/`, each of which talks to the real API and says so.

**If you change a check, prove the test catches it.** Delete or invert the thing
it guards and confirm the suite goes red. Three of this project's own bugs passed
a green suite: a ripgrep invocation that read stdin instead of the filesystem, a
negation that inverted a claim check, and a request that exceeded a question
ceiling. All three were invisible to tests and obvious on first real contact.

## Licence

MIT. Vendored dependencies keep their own licences in `licenses/`.
