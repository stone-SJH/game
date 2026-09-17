# Controller/Worker Production Architecture

Status: Phase 1 account/reliability implementation started and locally tested; Phase 2 production architecture remains a target
Version: 1.1
Last updated: 2026-09-16

This document is the implementation baseline for the production workflow. Future code must preserve these boundaries unless this document is explicitly revised.

The account, workspace and allocation model is detailed in [user-workspace-worker-design.md](user-workspace-worker-design.md). The implemented subset and outstanding work are tracked in [phase1-implementation.md](phase1-implementation.md). A dedicated worker per user is the initial scheduling policy; pooled/cold-started workers reuse the same model. Local implementation is not a claim of deployment or full workspace recovery.

## Phase boundary

The active goal is Phase 1: a limited invited internal audience, simple account/task management, manually prepared dedicated workers, local retained workspaces, continuous heartbeat/control, effective cancellation and same-worker recovery. The current round explicitly includes the known cancellation and long-task heartbeat fixes. An internal conversation/progress/artifact workbench and bounded real-game acceptance remain Phase 1 features.

Phase 2 is the later production launch with shared pools, cold start, cross-worker restore, independent durable storage, automated compute release and production operations. The WSS/mTLS, OSS and Wuying topology below is the Phase 2 target; those adapters are not required to finish Phase 1. HTTPS for real user credentials is part of the Phase 1 account release. Packages A/B/C in the detailed design belong to Phase 1; D belongs to Phase 2.

## Topology

```text
Browser --HTTPS/SSE--> Public Ubuntu ECS (control plane)
                           |-- Control API
                           |-- Task Orchestrator
                           |-- Worker Gateway (WSS/mTLS)
                           |-- PostgreSQL
                           |-- Redis
                           |-- OSS artifact adapter
                           `-- Wuying OpenAPI adapter

Windows NVIDIA Wuying cloud computer
  Windows Service bootstrap --> user-session Worker Agent
  Worker Agent --outbound WSS/mTLS--> Worker Gateway
  Worker Agent --> Codex / Blender / Unreal / Build tools
```

Wuying cloud computers are execution nodes and do not provide the public ingress required by the product. The browser never connects to a cloud computer. The Worker always initiates the connection to the ECS.

## Responsibilities

### ECS control plane

- Authenticate users and authorize task access.
- Validate and freeze each task revision.
- Compile the production DAG and own all task state, leases, retries and completion decisions.
- Allocate Windows execution capacity to a task run and its workspace through a temporary allocation. Begin with a dedicated worker per user and one active run per worker; later use a managed pool or Wuying lifecycle adapter.
- Maintain worker registration, heartbeats, reconnect state and lease expiry.
- Send structured commands and receive progress, logs, evidence and artifact metadata.
- Persist authoritative data in PostgreSQL; use Redis only for queues, locks and ephemeral heartbeats.
- Store large files in OSS and issue short-lived signed download URLs.
- Enforce the 24-hour task deadline independently of browser connectivity.

### Windows GPU worker

- Connect outbound with a device identity and mTLS.
- Advertise instance, image, tool, GPU and session capabilities.
- Execute only leased steps in an isolated per-task workspace.
- Run GUI-dependent tools in the logged-in user session, not only Session 0.
- Produce machine-readable `output/evidence.json`, logs, screenshots and build artifacts.
- Upload artifacts with SHA-256 metadata and durably deduplicate commands/results under at-least-once delivery. External tool execution is not assumed to be exactly once.
- Send heartbeats and recover an unfinished lease after reconnect.
- Kill the complete child process tree when a step is canceled or expires.

## Task lifecycle

```text
CREATED -> QUEUED -> PROVISIONING -> WAITING_WORKER -> RUNNING
RUNNING -> VALIDATING -> COMPLETED
RUNNING -> RETRYING -> RUNNING
RUNNING -> NEEDS_INPUT | FAILED | EXPIRED
RUNNING -> CANCELING -> CANCELED
RUNNING -> PAUSING -> PAUSED -> QUEUED
RUNNING -> RECOVERING -> RUNNING | NEEDS_INPUT | FAILED
```

The browser is not part of this state machine. Closing the browser must not pause or stop a task. User changes create a new immutable task revision and a new run; an active revision is never edited in place.

Task status is a projection of its current run. Pause preserves a nonterminal run and workspace; resuming acquires a fresh allocation when necessary. A retry after a terminal run creates a new run. Record requested pause/cancel separately from confirmed tool shutdown. The detailed design defines safe checkpoint boundaries, write fencing and the conditions for releasing an execution slot versus destroying compute.

## Transport contract

Endpoint: `wss://<controller-domain>/v1/worker/connect`

Every message contains `messageId`, `workerId`, `bootId`, `sequence` and `createdAt`. Task commands/results additionally carry `taskId`, `revisionId`, `runId`, `stepId`/`attemptId`, `workspaceId`, `allocationId` and `writeEpoch` as applicable. These fields fence stale execution and correlate evidence with the correct workspace generation.

Worker to ECS messages:

```text
worker.register
worker.heartbeat
worker.ready
step.started
step.progress
step.log
artifact.created
step.completed
step.failed
```

ECS to Worker messages:

```text
step.lease
step.cancel
worker.shutdown
```

The gateway must deduplicate `messageId`, enforce monotonic sequence numbers, expire leases, and support reconnect/resume. Commands are structured (`program`, `args`, `cwd`, `timeout`, `expectedOutputs`); arbitrary shell input is disabled by default and only enabled through an explicit allowlist.

## Storage and security

- PostgreSQL is the source of truth for users, invitations, sessions, tasks, revisions, runs, steps, workspaces, allocations, events, workers and artifacts.
- Redis is non-authoritative and may be rebuilt.
- OSS stores source bundles, screenshots, logs, evidence and final builds.
- ECS local disk is temporary only; no task result may exist only on ECS local storage.
- Public ingress is HTTPS 443. SSH is restricted to fixed administrator IPs. PostgreSQL and Redis bind privately.
- Worker credentials are per-instance, rotated and revocable. Use an ECS RAM role or a secrets manager for Wuying/OSS credentials; do not put long-lived keys in source code or task payloads.
- All artifact paths are relative, normalized and hash-verified before acceptance.
- Password/session deployment requires trusted HTTPS ingress. Authenticate task lists, detail, events and artifact downloads by task ownership; browser-supplied owner IDs are not authority.
- Worker-local retained workspaces are an explicit pilot limitation. Destructive compute release requires verified independent workspace checkpoints and final artifacts for every retained placement on that instance.

## Windows worker layout

```text
D:\YahahaGameWorker\
  agent\
  workspaces\<workspaceId>\generations\<writeEpoch>\project\
  workspaces\<workspaceId>\runs\<runId>\attempts\<attemptId>\
  cache\
  artifacts\
  checkpoints\
  logs\
```

The bootstrap service starts or repairs the user-session Worker Agent. The Agent launches Codex CLI, Blender and Unreal Engine with explicit timeouts and captures stdout/stderr/exit status. Codex is an execution capability, not a control-plane authority; it must run non-interactively with task-scoped credentials and workspace permissions.

This is the full target layout. The new agent currently uses `workspaces/<workspaceId>/project` and `workspaces/<workspaceId>/runs/<runId>`; generation materialization/checkpoints remain open work. The earlier deployed pilot used `workspace/<taskId>`. Import and verify existing paths during migration; a directory name alone is not a workspace recovery guarantee.

## Repository mapping

- `controller/core/common/plan.mjs` is the shared plan/DAG package.
- `controller/core/common/acceptance.mjs` is the evidence and acceptance package.
- `controller/api/server.mjs` serves the account/task API, authenticated artifacts and protocol-2 Worker polling endpoints. It reads static files from the sibling `app/` directory or configured `APP_ROOT`; sessions and task transitions live in `accounts.mjs` and `tasks.mjs`.
- `controller/core/sandbox-controller.mjs` is the local controller/protocol reference.
- `controller/core/executor-contract.mjs` is the Worker RPC adapter boundary.
- `controller/core/transport/channel-lib.mjs` is the versioned transport package.
- `controller/tools/trigger-task.mjs` and `controller/tools/task-status.mjs` are local control utilities.
- `control-store.mjs` file persistence is replaced by PostgreSQL repositories; it remains useful for local protocol tests.

Recommended target layout:

```text
app/index.html
controller/api          controller/core       controller/tools
controller/deploy       worker/agent          worker/deploy
worker/tools
```

Each runtime directory is deployable with its own runbook: `app/DEPLOYMENT.md`, `controller/DEPLOYMENT.md` and `worker/DEPLOYMENT.md`. The controller has its own `package.json` and lockfile; the root package only forwards local development commands.

## Product API

```text
POST /v1/auth/register
POST /v1/auth/login
POST /v1/auth/logout
GET  /v1/auth/me
GET  /v1/tasks
POST /v1/tasks
GET  /v1/tasks/:taskId
GET  /v1/tasks/:taskId/events
POST /v1/tasks/:taskId/instructions
POST /v1/tasks/:taskId/pause
POST /v1/tasks/:taskId/resume
POST /v1/tasks/:taskId/runs
POST /v1/tasks/:taskId/cancel
GET  /v1/tasks/:taskId/artifacts
GET  /v1/artifacts/:artifactId/download
```

Use SSE for progress. Large files are read from OSS through signed URLs.

The account pilot preserves `/artifacts/:artifactId` as an authenticated streaming route until the storage adapter migrates. The account/workspace design specifies deployment increments A-D and the legacy-data ownership migration; it does not require completing every Phase 2 infrastructure adapter before the task dashboard.

## Verified and unverified capabilities

Verified on the current Windows worker: user-session scheduled execution, Node.js, Codex help, Blender 5.2.1 background rendering, UnrealEditor-Cmd 5.8.2 startup, RTX 5880 GPU, and the `D:\YahahaGameWorker` workspace.

The Unreal probe was launch-only and used no real `.uproject`; it does not prove cooking or packaging. Still to verify: ECS-to-worker WSS/mTLS, Wuying lifecycle API, OSS transfer, real Blender/Unreal projects, Codex non-interactive authentication, reconnect/resume, cancellation, process-tree cleanup and the 24-hour deadline.

## Delivery phases

1. Phase 1 deployed milestone: ECS/Windows HTTP toolchain smoke; user-reported `COMPLETED` on 2026-09-16.
2. Phase 1 current round: repair cancellation and long-task heartbeats; add invited accounts, owner-scoped task views, dedicated worker allocation and retained workspace/recovery foundations.
3. Phase 1 acceptance: exercise pause/cancel/expiry/restart, task/artifact isolation and browser recovery; deliver internal conversation/progress views and one bounded real Blender/Unreal game workflow.
4. Phase 2 future implementation: add OSS checkpoints, cross-worker restore, shared/cold-start capacity, automatic lifecycle management and production transport/operations.
5. Phase 2 launch acceptance: verify production load, isolation, provider/storage failure recovery, backup/restore and resource/retention controls.
