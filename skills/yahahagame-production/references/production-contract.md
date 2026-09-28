# Production Contract

## State model

Task state is controller-owned:

```text
QUEUED -> PLANNING -> EXECUTING -> COMPLETED
                         |             ^
                         v             |
                    PAUSING -> PAUSED -> RESUMING
                         |
                         v
                     CANCELING -> CANCELED
```

An execution can also enter `FAILED`, `RECOVERING`, or `EXPIRED`. A stage has independent
`PENDING`, `RUNNING`, `WAITING_USER`, `RETRYING`, `PAUSED`, `ACCEPTED`, and `FAILED` states.
Terminal decisions are immutable. A late success cannot overwrite cancellation, expiry, or a
committed failure.

## Controller events

The worker sends idempotent events keyed by `(taskId, runId, stageId, attempt, sequence)`:

- `PLAN_CREATED`, `STAGE_STARTED`, `STAGE_PROGRESS`, `ARTIFACT_CREATED`
- `CHECKPOINT_CREATED`, `STAGE_ACCEPTED`, `STAGE_FAILED`, `WAITING_USER`
- `PAUSE_REQUESTED`, `STOP_CONFIRMED`, `REVISION_CREATED`, `RUN_COMPLETED`

Every event includes the revision, workspace, run, stage, attempt, timestamp, and optional file
references. The controller persists the event before publishing it to the browser. Replayed events
must be safe to apply twice.

## Checkpoint manifest

```json
{
  "protocol": 1,
  "taskId": "task-...",
  "workspaceId": "workspace-...",
  "revisionId": "revision-...",
  "runId": "run-...",
  "stageId": "project-bootstrap",
  "attempt": 1,
  "durability": "LOCAL_ONLY",
  "createdAt": "2026-09-16T00:00:00.000Z",
  "tools": { "unreal": "5.8.x", "blender": "5.x" },
  "files": [{ "path": "project/Game.uproject", "size": 123, "sha256": "..." }],
  "acceptedEvidence": ["stages/project-bootstrap/evidence.json"]
}
```

A checkpoint is usable only after the manifest is complete, all files exist, hashes verify, and
the current writer has stopped. Local-only checkpoints block destructive worker release.

## Acceptance

The final report must link to:

- the exact `.uproject` and default map;
- source/Blueprint/asset manifests and provenance;
- build and package logs;
- a launched packaged-game result, not just a successful cook;
- gameplay evidence for every requested acceptance criterion;
- hashes for the package and all referenced evidence.

The machine-readable `acceptance/acceptance-report.json` must use protocol `1`, carry the
current `taskId`, `workspaceId`, and `runId`, and report `status` as `ACCEPTED` or `PASS` with
an explicit true `pass`, `accepted`, or `passed` flag. Its `packagedGameStatus`,
`gameplayStatus`, and `visualStatus` fields must be `PASS`, and `criteria` must be a non-empty
array whose entries all have `status: "PASS"`. The stage manifest must carry the same task and
run identity and list every planned stage as `ACCEPTED`; a report from an earlier run cannot be
used as current evidence.

No report, screenshot, process exit code, or model statement alone is sufficient.

## Provisional iteration delivery

The acceptance rules above describe a fully accepted result. They do not prohibit delivering
an imperfect iteration. When a stage has usable output but retains visual or evidence gaps,
write `PROVISIONAL` in its stage report/manifest and `GAP` for the unpassed checks. Continue
the other stages, package and launch the game, and report the actual criteria without claiming
acceptance. A provisional acceptance report uses `status:"PROVISIONAL"`, `passed:false`, and
honest `PASS`/`GAP` component statuses and criteria.

The host preserves each launchable package with its dependencies, preview, reports, score and
repair instructions. Its overall score is the lowest of criterion coverage, applicable quality
dimension coverage, mean asset score, and mean observed stage score (all on 0–100). A score is
observed coverage, not a claim that missing evidence passed. Default target: 85. Unresolved
technical/report issues still require another round even if the score reaches that target.
Default maximum: ten additional complete iterations. At the limit, deliver the best retained
playable round with `qualityAccepted:false` and its actual gaps instead of failing the task.

Modeling retains its local retry limits per whole production round. A new round repairs the
previous best source and reconsiders available generation strategies; passing assets are
reused. Review/service errors are recorded as unverified quality, not fabricated visual GAP
measurements. Budgets and completed rounds survive resume. Cancellation, process-stop
uncertainty and modified frozen evidence still fence execution.

### Internal stage failures and publication

Internal schema/service failures, missing technical reports, capability discovery outages,
invalid optional evidence, and a production agent's hard-failure marker are stage gaps.
Retain the diagnostics, consume only the stage's original local retries, and finish every
independent stage in the round. Never label an unverified model technically usable. Reuse a
verified previous model when possible; otherwise use an explicit temporary engine-native
representation. The complete round is scored before another round repairs these gaps.

Write a model revision request without stopping integration. The host preserves the request,
repairs it internally at the next complete iteration, and keeps the approved base contract
until the replacement validates. Failed repair cannot delete either original requirements or
requested additions. Same-round resume never refreshes the durable budget.

When no package can be launched, the host retains the project and diagnostic snapshot as
`RETAINED_INCOMPLETE`, `playable:false`, score 0. This is not a playable delivery. The live
worker continues essential-delivery rounds beyond the quality-iteration cap until a publishable
result exists, subject to the existing task deadline, cancellation and integrity fences.

Publication has its own durable `artifact-publication.json` and immutable local outbox.
Upload outages leave items `PENDING`; they cannot change a production result to `FAIL`.
The live worker renews its lease while retrying required uploads before announcing completion.
Optional evidence outages are recorded separately and do not block required delivery. An HTTP
422 completion response is retained for internal publication recovery, never converted to a
content failure. No task budgets, toolchain locks or active journals are migrated implicitly.

## Controller/API additions

The current task API needs these authenticated routes:

```text
POST /v1/tasks/:taskId/instructions
POST /v1/tasks/:taskId/pause
POST /v1/tasks/:taskId/resume
POST /v1/tasks/:taskId/retry
GET  /v1/tasks/:taskId/checkpoints
GET  /v1/tasks/:taskId/stages
```

Worker routes need stage progress, checkpoint registration, and explicit stop confirmation. Each
mutation uses an idempotency key and records the user-visible result.
