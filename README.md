# Automatic Jev advice for Enrique's Pi

Personal integration built on **pi-typesafe 0.4.0** and selected **pi-warden 0.12.0** library components. It does not load their standalone extensions, replace existing Jev CLI/gates, change tool permissions or modify CCD Platform.

## What runs automatically

1. **Skill suggestions** before each run, from `systemPromptOptions.skills` (the real Pi catalogue). Command-only skills are excluded. Up to two candidates above 0.90 are suggested; the agent still reads the skill and applies existing instructions. No-match is valid. More than 128 skills means an explicit skip, not a hidden shortlist. Large requests are refused by the client budget.
2. **Evidence-grounded finding triage** after the run settles. Up to six finding-like paragraphs in the final response are treated as *claims*, compared with bounded tool observations, and ranked by evidence support before impact. This is heuristic paragraph selection, not a comprehensive review or bug finder. It cannot inspect background reports that never entered tool output.
3. **Post-run trace advice** after `agent_settled`: possible unsupported verification/completion claims and repeated failed strategies. Warden's completion-language and stuck-strategy questions are reused with their expected state fields; the surrounding evidence policy is deliberately different. No command output is automatically treated as proof of correctness.

A visible custom advisory message and widget appear when there is advice or a finding ranking. Successful evaluations with no flags do **not** emit a "verified" verdict. Custom messages use `triggerTurn: false`: no automatic repair loop or extra generative-model turn. Advice remains available to the next ordinary turn. Service failures mean *unavailable*, never *clear*.

## Controls

- `/jev-assist status` — mode and session usage.
- `/jev-assist off` — immediately cancel pending judgments and persist off globally.
- `/jev-assist on` — persist on globally.
- `PI_JEV_ASSIST=off` — process-level kill switch, cannot be overridden by the command.
- State file: `~/.pi/agent/jev-assist/config.json` (only an enabled boolean).
- The global loader lives in `~/.pi/agent/extensions/jev-assist/index.ts`; remove that loader to uninstall. Source/dependencies can remain for inspection.

Automation is enabled by default when installed, as explicitly requested by the user. Changing configuration does not grant permission to execute an action. No project configuration is read.

## Reused versus retained

| Component | Decision |
| --- | --- |
| pi-typesafe client | Reuse validated responses, typed primitives, pinned official API destination, no SDK retries and usage accounting. |
| pi-warden redaction | Reuse, but apply to complete strings **before** clipping. It is best-effort, not a secret-proof boundary. |
| pi-warden completion/stuck questions | Reuse as semantic signals, not execution facts or completion authority. |
| pi-warden done outcome classifier | Do not use: command-text matching and any-passing-check policy do not meet this integration's conservative evidence requirements. This integration draws no pass/fail conclusion at all. |
| pi-warden action guards/output compression | Not enabled. Existing permissions and original tool output remain unchanged. |
| Existing `jev`, `jev-gate`, `jev-claims` | Retain unchanged. This extension does not satisfy required project verification gates. |
| pi-jev | Reviewed as a discovery design reference; not loaded. No second client, overlapping hooks or fallback confidence of 1.0. |

Warden declares pi-typesafe ^0.3.0. This package deliberately overrides it to 0.4.0 to avoid duplicate clients/type identities. Run the upstream offline compatibility tests before accepting an upgrade. The Bun lockfile pins the installed dependency graph. No upstream lifecycle scripts are needed to install the published packages.

## Evidence and privacy

Automatically sends to TypeSafe's hosted API:

- Redacted task excerpt (up to 4,000 characters).
- Advertised skill names/descriptions, not full skill files or the system prompt.
- Final assistant text excerpt (up to 5,000 characters), labelled as a claim.
- Bounded recent tool call summaries and output excerpts, plus counts of file writes and unknown-effect tool calls.
- Fixed judgment questions, including attributed Warden rubrics.

Does **not** read the repository or previous session files, forward reasoning blocks/images/full telemetry, fetch arbitrary files, or send full AGENTS.md. Sensitive-path operations and credential-dumping commands are withheld by the ledger. Redaction is best-effort: arbitrary secrets, private business data and personal information may still occur in otherwise ordinary code/output. Use the kill switch before sensitive work. "Not used for training" does not imply zero retention; confirm account terms separately.

The ledger stores bounded redacted observations in memory. Durable decision entries store hashes, numeric judgments, static flags, model, latency, usage and omission counts—not raw request payloads. Displayed finding excerpts/custom advice are redacted, but still become part of Pi's ordinary session history.

**There is no check/pass layer, deliberately.** An earlier version classified recognised commands as passed/failed using `details.exitCode` and tracked freshness against mutations. Measured against a real recorded session, that machinery never fired: Pi's bash tool emits no exit code (`dist/core/tools/bash.js` populates `details` only for truncation), and real agent commands are compound (`cd x && node --test | tail -25`), which the recogniser correctly refused. Its unit tests passed only because they supplied `{exitCode: 0}` themselves — an input the runtime never produces. It was removed rather than kept as dead code with green tests.

What remains: an observation's `status` is `error` when Pi sets `isError`, otherwise `ok`, and `ok` means only "the tool did not report an error" — never "the checks passed". The snapshot exposes no pass/fail verdict, so no consumer can mistake one for the other. Any judgment about whether a command demonstrates working code is made by the judge from the command text and its output, both treated as untrusted. These observations are not attestation or comprehensive caller coverage.

Limits: 120 ledger entries, last 12 observations in a review, six candidate paragraphs. Omitted coverage is reported. Missing evidence weakens advice; it is not proof of a defect. Thresholds are uncalibrated for this user's tasks.

## Credentials and reliability

Use the existing TypeSafe key; do not duplicate it into Pi settings. The service supports the environment/upstream key store and the existing owner-only `~/.config/typesafe/env` via strict literal parsing—not shell execution. No credentials are displayed, stored in decision entries or passed in argv.

Model: `jev-1.13.0`. Requests: 2.5-second deadline, no retries, 48,000-byte request cap, six attempts/run, 300/session. Three service failures open a 60-second circuit breaker. The process/session budget is not reset by each prompt. Abort and generation checks prevent late responses from affecting a new prompt, branch, disabled extension or shut-down session. Reload creates a new extension instance/budget.

Usage is shown separately by `/jev-assist status` and stored with decisions. It is not automatically added to the generative model's Pi token totals. At the researched $0.042/M input-token rate, inputTokens * 0.042 / 1,000,000 estimates Jev cost; account pricing is authoritative.

## Validation

```sh
bun install --ignore-scripts
bun run check
# When the pinned upstream source snapshots are available under vendor/:
(cd vendor/pi-typesafe && node --import tsx --test tests/*.test.ts)
(cd vendor/pi-warden && node --import tsx --test tests/*.test.ts)
```

Offline tests exercise the real Pi resource loader, mocked event lifecycles, missing/late responses, budgets, evidence limitations and synthetic secrets. A separate synthetic live smoke may verify credentials and the API without sending repository content. Neither proves that advice improves task success. Keep user overrides and real false-positive examples for later evaluation.

## Tool discovery (option 4)

Do not turn every inactive tool back on: users or other extensions may have disabled it deliberately. Prefer a loader that searches only an explicitly approved discovery catalogue and additively activates selected registered tools during the loader call. Pi documents availability on the following model request, with native deferred-loading support where available.

For MCP multiplexers, a Pi tool name such as `mcp` is not a catalogue of underlying operations. Use the gateway's search/describe facility to discover those operations instead of claiming `setActiveTools` can select them. Keep basic tools and search available; distinguish missing capability from no semantic match; allow abstention. No discovery activation is implemented in this first release. A future loader must revalidate provenance, session identity and current eligibility immediately before activation; a fresh union alone does not solve concurrent permission revocation. It must never install or authenticate an MCP server, execute the discovered action, or treat Jev relevance as permission.
