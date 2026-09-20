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
