# pi-jev-assist

A [Pi](https://github.com/earendil-works/pi-mono) extension that checks an agent's
work against **observation**, not against its own account of itself.

It runs by itself. No slash command to remember, no prompt to write. It watches
the session, speaks when it has something worth saying, and stays silent otherwise.

```
enumerate mechanically  →  classify with Jev  →  you decide
   git, ripgrep,            small, self-contained     authority never
   a call graph             items; abstention          moves
                            is a first-class answer
```

That split is measured, not aesthetic. Tools that asked Jev to **find** a defect
failed their own known-bad cases. Tools that asked it to **rank or score**
pre-enumerated evidence discriminated. See [docs/measurements.md](docs/measurements.md).

Open [docs/overview.html](docs/overview.html) in a browser for the same material
as one page.

---

## What it does

| When | What happens | Cost |
| --- | --- | --- |
| Session starts | Warm a Vortex code index; start a file watcher | Off the critical path |
| Before a run | Score Pi's **live** skill catalogue; suggest ≤2 above 0.90 | 1 Jev call |
| Before a write | Name callers that depend on the file you are about to change | Graph, sub-second |
| Every tool call | Redacted, bounded evidence ledger | None |
| Huge tool result (>20k chars) | Keep head+tail so later prefills stay smaller | None |
| Each turn with ≥8k finished tool output | Live-prune stale results in `context` (same questions as compaction) | 1–2 Jev calls |
| Run settles | Review the final message vs the ledger and vs the diff; rank callers of what changed | ≤3 Jev calls |
| Compaction | Prune finished tool output **verbatim** instead of summarising | 1–2 Jev calls |

Advisory only. It never grants a permission, never certifies completion, never
starts a follow-up turn, and never edits your code.

**A diff shows what the code SAYS, never that it WORKS.** Tests remain the only
authority on behaviour.

---

## Install

```sh
git clone <this repo> ~/Projects/pi-jev-assist
cd ~/Projects/pi-jev-assist && bun install
ln -s ~/Projects/pi-jev-assist ~/.pi/agent/extensions/jev-assist
```

Set `TYPESAFE_API_KEY`, or leave a key at `~/.config/typesafe/env` (owner-only,
`KEY=value`, no shell expansion — parsed, never sourced).

Restart Pi. `/jev-assist status` confirms it is live. The symlink is the working
tree, so **an edit here is live in the next session with no build step**.

| | |
| --- | --- |
| `/jev-assist status` | Model, usage, on/off |
| `/jev-assist off` | Persisted to `~/.pi/agent/jev-assist/config.json` |
| `PI_JEV_ASSIST=off` | Environment kill switch; wins over the config file |
| `rm ~/.pi/agent/extensions/jev-assist` | Gone |

Vortex is optional. With it, blast radius is a real call graph. Without it, a
bundled ripgrep script covers the same ground and **says so**. See
[docs/vortex.md](docs/vortex.md).

---

## Bounds

Every hosted request is bounded, and the bounds are tested:

- **2.5 s** deadline, no retries
- **48,000 bytes** per request
- **6 calls per run**, **300 per session**
- circuit breaker: three consecutive failures open it for 60 s
- redaction **before** clipping
- sensitive paths (`.env`, `auth.json`, `.ssh/`, `*.pem`, credentials) are never sent
- disk writes are decision metadata only: hashes, scores, counts

---

## Docs

| | |
| --- | --- |
| [docs/overview.html](docs/overview.html) | Embedded one-pager (this README + architecture + measurements) |
| [docs/architecture.md](docs/architecture.md) | Every hook, cost, and why it sits where it does |
| [docs/measurements.md](docs/measurements.md) | What was measured, including everything that failed |
| [docs/vortex.md](docs/vortex.md) | Code-graph integration and its failure modes |
| [docs/limitations.md](docs/limitations.md) | What this cannot do, and known false positives |
| [UPSTREAM.md](UPSTREAM.md) | Provenance |

---

## Development

```sh
bun run check      # typecheck + tests
bun run typecheck
bun run test
```

Tests are `node:test`, no network. Live API checks live under `scripts/` and say
so.

**If you change a check, prove the test catches it.** Delete or invert the thing
it guards and confirm the suite goes red. Three of this project's own bugs passed
a green suite and were obvious on first real contact.

## Licence

MIT. Vendored dependencies keep their own licences in `licenses/`.
