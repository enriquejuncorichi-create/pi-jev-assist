# Limitations

The things this cannot do, and the ways it is known to be wrong. Read this before
trusting any output.

## It is advisory, always

It does not grant permissions, certify completion, reactivate disabled tools, run
repairs, or start follow-up turns. Every message it sends is
`{triggerTurn: false}`. Tests, project rules and permissions remain authoritative.

## A diff shows what code SAYS, never that it WORKS

The claim check compares your summary against the working-tree diff. A high score
means "your description matches your change" — never "your change is correct".
Nothing here replaces running the tests.

## Known false positives

### Claims about things that were RUN

The claim check only sees the **diff**. A claim about something *executed* — a
probe, a measurement, a tool call — cannot be settled by a diff, and the
`assessable` gate should abstain but does not reliably. Observed: a factual
summary of live measurements scored 0.29 with the reason *"nothing was run that
would exercise the claimed behaviour"*. Things had been run; running is not
visible in a diff.

**If a flagged claim is about an observation rather than a code change, this is
the reason.**

### Semantic claims about absent behaviour

Structural claims are reliable (a file, an export, a migration). A claim that
something *is not* there is not: deciding absence requires reasoning about what
code does not do. Measured miss: "revokes already-poisoned payloads" scored 0.84
against a diff that does not do it, because the diff touches the neighbouring
state and revocation *looks* present.

A `✗` here is worth acting on. A `✓` is not proof. A `⚠ overstated` under a tick
is a stop.

## Known blind spots

### The graph cannot see a symbol that does not exist yet

A function the agent has just written is not in the index until a walk picks it
up. The text-search fallback covers that window, and says it is doing so.

### Text search cannot see non-textual reach

Dynamic dispatch, string keys, barrel re-exports, route conventions
(`POST`/`GET` in a framework directory), queue names, database columns, BC field
names. The script names these limits in its own output rather than implying
coverage it does not have.

### Behaviour changes behind an unchanged signature

Callers are textually unchanged and still break. Neither tool catches this. The
pre-write check reports it explicitly when it cannot detect a changed symbol:
*"NOT the same as 'no blast radius'"*.

## Evidence ledger: no pass/fail

Pi's bash tool emits **no exit code** — `details` carries truncation only. So an
observation's status is `error` when Pi sets `isError`, otherwise `ok`, and `ok`
means only "the tool did not report an error". The snapshot deliberately exposes
no pass/fail verdict, so nothing downstream can mistake one for a verified check.

## Compaction drops aggressively

On a real session, 17 of 26 judged tool outputs were dropped and 9 truncated. The
safeguards are that recent messages are pinned, dropped results leave a note
naming what went, kept text is byte-identical, and any tool can be re-run. It has
not been observed through a live `/compact`; it was measured by replaying a real
session's messages through the same code path.

## Budgets can silence it

6 calls per run, 300 per session, 2.5-second deadline, and a breaker that opens
for 60 seconds after three failures. A long session can exhaust the budget, and
when it does the extension goes quiet rather than degrading. **Silence is not a
clean bill of health** — check `/jev-assist status` for the usage counters.

## The Jev gate this grew out of

`jev-gate`'s `guard_fails_open` check is **unvalidated**: across three candidate
artifact pairs it scored the known-bad side 0.16–0.24 and the fixed side
0.23–0.38 — inverted every time. It is not used by this extension. Two of its
other checks did catch real things (`missing_revocation` at 0.76 on a commit that
genuinely lacked one; `hardcoded_secret` at 0.46 on an accidentally committed
`.env.bak`), so it is not worthless — but a score from it is not evidence.

## Privacy

Titles, commands, paths and short excerpts are sent to a hosted API. Sensitive
paths are withheld entirely and redaction runs before clipping, but **the content
of your work is being sent somewhere**. That is a deliberate choice, not an
accident — decide it knowingly. `PI_JEV_ASSIST=off` stops all of it.
