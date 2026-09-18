# The Vortex code graph

Optional. Without it, blast radius comes from a bundled ripgrep script and says
so. With it, blast radius comes from a real call graph.

## Why it is preferred

One symbol, `uploadToLibrary`, in a 25,843-node indexed repository:

| | Call graph | Text search |
| --- | --- | --- |
| Depth 1 | `attachBlob` | — |
| Depth 2 | 5 callers, 3 packages | — |
| Depth 3 | `repairPendingAttachments`, `recordInbound` | — |
| Noise | none | ~20 hits from one test file, plus docs |
| Same-named function elsewhere | correctly ignored | reported as related |

`recordInbound` is three hops away and **contains the symbol's name nowhere**. No
text search reaches it at any effort.

## Why an empty answer can be trusted — but only from the graph

Vortex **fails loud**:

```
workspace_not_indexed: '/tmp/x' is not an indexed workspace,
so there is no corpus to answer from. Indexed workspaces: [...]
```

It refuses rather than returning an empty list, so a successful call returning no
callers genuinely means no callers. That is the property the text fallback does
not have, which is why **every** failure path here falls back and *says* the graph
was unavailable rather than printing nothing.

One subtlety that cost an hour: a `tool_error` arrives as message **content**,
not as a JSON-RPC error. Treating it as a result would read as "no callers" — the
exact false all-clear the graph exists to avoid.

## Transport

A `vortexd --mcp` child over stdio, one per session, kept warm:

| | |
| --- | --- |
| Handshake | 523 ms |
| `blast_radius` | 610 ms |
| Lifecycle | spawned lazily, `unref`'d, killed on `session_shutdown` |

`unref` matters: an un-unref'd child keeps Node's event loop open, so a host that
has finished its work hangs waiting for a daemon it no longer needs.

## Freshness

`session_start` ensures the workspace has an index and starts a watcher
(`watch_directory`, 2 s debounce, **workspace-relative** path — an absolute one is
refused). Indexing is fire-and-forget: a large repository takes minutes, and
blocking the first write on it would be a worse failure than the missing caller.

`_meta` on every response carries `indexed_commit` and `live_head`.

### Three things that look like staleness and are not

Each of these was mistaken for a bug during development:

1. **A symbol missing from a fresh index.** `indexed_commit == live_head` and the
   symbol still absent usually means **the checkout is on a different branch**
   that genuinely lacks it. The index was right.
2. **A worktree reporting 0 nodes.** `index_stats` reports 0 for workspaces the
   current process has not hydrated. They answer correctly from disk on demand.
3. **An unindexed workspace.** This one is real, and it is an error, not an empty
   result.

### What it still cannot see

A symbol the agent has **just written** is not in the graph until a walk picks it
up. The text fallback covers that window. Re-indexing on edit is registered via
the watcher but has not been proven end to end here.
