# Subscription-only worker routing

Routing is opt-in and does not change the parent model or thinking level. The current parent provider/model is the explicit baseline. Only native, authenticated subscription transports passing runtime discovery are eligible. No automatic retry, paid fallback or route switch follows a failure. Worker completion always requires main-model review.

## Controls

Use `/jev-assist` → **Worker routing…**, or interactive commands:

- `routing on|off|status|routes|recent`
- `routing exclude <exact provider/model>` / `routing include <exact provider/model>`
- `routing qualification import <absolute local JSON path>` (double quotes supported)
- `routing qualification list`
- `routing qualification revoke <exact key from list>`

Prefix each with `/jev-assist`. Exclusions persist in the global Jev config. Including a route only removes its exclusion; it cannot bypass subscription or quality gates. The recent list holds at most 20 decisions/errors for the current session. Cache residency and remaining quota are explicitly **unknown**. No dashboard or speculative cache/quota estimate is added.

Qualification controls are not model tools or tool arguments. Import requires an interactive **USER confirmation** displaying the exact route, role, baseline, suite, evidence hash and expiry. Declining changes nothing. Confirmation is not a substitute for reviewing the evidence. The importer rechecks the bundle after confirmation; changed inputs invalidate consent.

## Model-choice mode

Fresh configurations default to **rubric** mode; routing itself stays off until you enable it. Existing configurations that had routing enabled without a `workerRoutingMode` retain **qualified** mode. To opt in explicitly, set `"workerRoutingMode": "rubric"` in `~/.pi/agent/jev-assist/config.json` and reload Pi. `qualified` retains the original evidence-gated behaviour. Neither mode changes the main Pi model or its thinking setting.

Rubric mode first filters routes by native subscription authentication, exclusions, policy allowlist, known context capacity, required image/reasoning capability and task risk. High-risk tasks can use only the eligible main-model baseline. Jev then chooses one exact enumerated route or abstains, with a bounded task excerpt and per-model descriptions. Unrecognised alternatives need an operator-authored rubric rather than being guessed into eligibility. Built-in task-fit hints cover Astra, Sol, Luna, Grok and Terra; they are heuristics, **not quality or subscription-savings guarantees**. Recorded research failures are included in the corresponding exclusions. Override a hint with a rubric scoped to the exact route and role:

```json
{
  "workerRouteRubrics": [{
    "route": { "provider": "xai", "model": "your-exact-model-id" },
    "role": "scout",
    "use_when": "Bounded source location in an established project",
    "not_for": "Visual inspection or open-ended research",
    "boundary": "Read-only output, independently checked by the main model"
  }]
}
```

Each string must be nonempty and at most 500 characters; duplicate route/role entries refuse. The task text and descriptions are sent to Jev/Vercel as untrusted data (redacted and bounded, but **not guaranteed secret-free**). Do not place credentials in tasks or descriptions. At most 16 eligible candidates and a 12 KB request are permitted; no silent shortlisting. A malformed answer, abstention or Jev failure retains **only** an eligible baseline; if the baseline is excluded, it refuses. The exact route and policy are rechecked before dispatch. No failure of a worker triggers a paid fallback, automatic retry or model switch. Classification adds Jev usage and latency, not counted as subscription savings. Worker output returns to the unchanged orchestrator for review before user-facing acceptance.

The mode does **not** measure per-model subscription allowance debit. Any expected efficiency gain is an unverified heuristic until provider-attributable allowance evidence exists. Do not use API prices, tokens, speed or account-wide windows as model-specific subscription drain.

## Qualification format

One JSON object, exactly these fields (unknown fields rejected):

| Field | Required value |
| --- | --- |
| `schemaVersion` | `1` |
| `benchmarkVersion` | `accepted-result-v1` |
| `route`, `baseline` | Objects containing exactly non-empty `provider` and `model` keys |
| `roles` | Exactly one of `implement`, `scout`, `research`, `curate` in an array |
| `evidenceRef` | Relative local file inside the import bundle directory |
| `evidenceHash` | Lowercase SHA-256 of the exact evidence file bytes |
| `suiteHash` | Lowercase SHA-256 identifying the exercised benchmark suite |
| `expiresAt` | Future integer Unix milliseconds |
| `qualityPassed`, `endToEnd` | Both `true` |
| `medianAcceptedMs` | Positive finite measured worker accepted-result latency |
| `baselineMedianAcceptedMs` | Positive finite measured baseline accepted-result latency |
| `acceptedSamples` | Positive integer |
| `reviewIncluded`, `repairIncluded` | Both `true`; latency includes review and repair overhead |

The importer parses the supported completed-run evidence after checking its SHA-256. It recomputes schedule coverage, paired samples and medians; verifies call sequence, review results, scope and usage reconciliation; and rejects incomplete, duplicated or inconsistent evidence. The same checks run whenever trusted profiles reload. These checks establish internal consistency, not cryptographic provenance: coding acceptance claims still require human review. Synthetic fixtures are never installed as production qualifications.

Prepare an import bundle offline from a completed run (replace the route and future expiry deliberately):

```sh
bun run bench/prepare-import-bundle.ts --evidence /absolute/completed-run.json --output /absolute/new-bundle --route provider/model --role scout --expires-at YYYY-MM-DDTHH:MM:SSZ
```

The converter refuses existing output directories and evidence over 8 MiB. It derives metrics and hashes the copied evidence; it never approves or installs the profile. Review `profile.json`, `evidence.json` and the recorded measurement limitations before the interactive import command. All scheduled observations must pass the current conservative converter; a partial run cannot qualify even if one subset looks favourable.

Approved profiles persist globally in `~/.pi/agent/jev-assist/worker-qualifications.json`. Evidence remains at its original absolute local location and is hashed again whenever qualifications are loaded. Missing, changed, malformed or expired evidence is ineligible. Different baselines or roles do not inherit qualifications. In **qualified mode**, the current suite measures low thinking and a 12-turn worker limit: alternatives are considered only while the parent uses low thinking and are dispatched with that measured turn limit. Other thinking policies retain the baseline rather than transferring the evidence. Routine-task qualifications never permit high-risk downgrades. Accepted-result latency is compared with the measured baseline; ties favour the baseline. Related eligible workers are retained before latency ranking. Rubric mode does not grant a qualification or assert a measured improvement.

Filesystem operations use Node's host-platform semantics, without case-folding paths. Imports reject network paths, parent traversal and symlink/junction traversal; evidence must remain inside its local bundle. This is not a sandbox against a hostile process with write access to the user's trusted configuration or a concurrently mutating filesystem. Protect that directory as configuration, not untrusted project data.

## Context and lifecycle bounds

Each owned worker persists cumulative UTF-8 prompt bytes and observed result bytes on the active Pi branch. Before a resume, the runner is queried for terminal status and actual result length. At **64,000 observed bytes**, or when a restored record lacks a known budget, resume is refused. The orchestrator must explicitly create a fresh task key with a curated, constraint-preserving task. There is no automatic replay, truncation, parent-context deletion or alternative-route dispatch.

This is an operational byte-volume limit, **not a token occupancy estimate**. Intermediate tools, system prompts and internal worker history are not fully observable; no finite upper bound on total context is claimed. Results observed more than once may conservatively overcount. Runner usage is shown observationally: lifetime input consumption does not measure current context.

Failures distinguish quota/rate limits, context exhaustion, cancellation and other provider failures descriptively, without triggering retries. Unknown runner failures remain provider failures with the original error visible. Concurrent dispatches are refused. Disabling or navigating invalidates in-flight dispatches; late receipts request a stop rather than being adopted. Only owned active-branch records restore. Cold-restart handle restoration remains the runner's responsibility under `managed-workers-v1`; `sessionId` is retained unchanged. Older records without byte accounting require an explicit fresh dispatch.

## Validation boundary

Tests are portable Node/Bun tests using temporary directories and the host filesystem's symlink or junction semantics. Run `bun run typecheck` and the focused worker tests on each target OS. A Windows run is not evidence of Linux execution. No live provider call is necessary for these tests.
