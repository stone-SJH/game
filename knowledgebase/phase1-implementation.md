# Phase 1 Implementation Record

Updated: 2026-09-16
Scope: limited invited internal users; Phase 2 infrastructure remains deferred.

## Implemented in the repository

- Versioned, checksummed PostgreSQL migrations with an explicit legacy-running-job drain guard. The initial five-table schema is extended by `002_phase1_accounts.sql`; old tasks are retained without automatically assigning their untrusted owner strings to new users.
- Single-use invitation registration with transactionally enforced account cap, password hashing, server-side sessions, logout, CSRF/origin checks, authentication rate limits and registration/login audit records. Browser shared-token fallback is removed.
- Owner-scoped task list/detail/SSE and artifact access, streamed hash-checked uploads, required artifact association checks and immutable terminal states.
- Individually enrolled worker credentials, explicit user-to-worker binding, one active allocation per worker/workspace, task-owned workspace identity, immutable initial input revision and initial run records.
- Queued cancellation prevents dispatch. Running cancellation enters `CANCELING`, reaches the independent worker control loop, kills the process tree, and becomes `CANCELED` only after shutdown acknowledgement. A committed cancellation intent prevents late success from completing the task.
- Heartbeat/control runs independently of long tool execution and streamed file hashing/upload. Matching leases renew continuously; lost leases trigger local shutdown and controller `RECOVERING`. Unconfirmed execution retains its allocation.
- Queued deadline expiry, running deadline stop requests, controller reconciliation after restart, and durable final-result replay. A worker restart with an unfinished execution journal deliberately requires shutdown verification rather than launching duplicate work.
- Login/registration, task list, task creation/cancel, task status/events, image previews and authenticated downloads. Browser refresh restores the session and server-side list. There is no pause button or conversation UI yet.
- Administrative CLI for migrations, invitation issuance, worker enrollment and binding. New protocol-2 workers reject the old shared-credential dispatch model.

The first implementation deliberately uses a short PostgreSQL advisory transaction lock for scheduling/state changes. Tool execution and file transfer occur outside it. This is appropriate for the limited pilot; production parallelism is a Phase 2 scheduling refinement.

## Verification performed

`npm --prefix controller test` runs the existing protocol tests plus native PostgreSQL integration tests. Verified locally on Windows: invitation redemption/cap concurrency, sessions and owner isolation, CSRF, duplicate dispatch prevention, cancellation and stale results, owner-scoped artifacts, completion immutability, long-command and streamed-upload lease renewal, actual descendant process termination, queued/running deadlines, two-worker user binding and recovery capacity reservation.

`node controller/tools/verify-browser.mjs` verifies registration, task creation, reload recovery, cancellation, logout and no horizontal overflow at desktop/mobile widths against the isolated local dev server. Screenshots live under ignored `controller/.local/phase1/`.

These checks are not a fresh ECS/Windows GPU deployment acceptance. The existing reported remote `COMPLETED` run belongs to the previous HTTP smoke release. Blender/Unreal real-project packaging and playable-game quality have not been newly accepted by this work.

## Remaining Phase 1 work

- Stage-by-stage durable attempts, local recoverable checkpoints, pause/resume, retry/new-run APIs and automatic recovery after an agent crash during a tool command. Current journal protection holds uncertain work; it does not implement automatic in-flight resume.
- Production workspace execution now starts from an empty task-owned directory. The browser does not provide `.blend` or `.uproject` paths; a production adapter creates and tracks any number of project files inside the workspace.
- Fine-grained live step/log events, persisted conversation/attachments, requirement revisions and real game production DAG integration. Current events show dispatch, artifact arrival and final state; captured tool logs appear in reports.
- Deployed account release verification, actual GPU tool cancellation/long upload cases, offline worker recovery procedures and a bounded real-game acceptance run.
- More concurrency/fault coverage around upload interruption, controller restart during pending cancel/result, and unexpected process-wrapper exits. Full cloud lifecycle and cross-worker recovery tests remain Phase 2.

Do not equate the new workspace/run schema with completed pause/resume. Do not delete local worker storage automatically: it is still the only project copy unless an operator has made a verified backup.

## Run and deploy

Local development uses an isolated native PostgreSQL cluster and loopback HTTP:

```powershell
npm --prefix controller ci
npm --prefix controller test
npm --prefix controller run dev
```

The dev tool prints an available URL and writes a local activation code to `controller/.local/phase1/access.json`. This directory contains local database/test data and is ignored by source control. No worker is auto-enrolled or bound; unbound users can create queued tasks.

For ECS use [controller/DEPLOYMENT.md](../controller/DEPLOYMENT.md), [app/DEPLOYMENT.md](../app/DEPLOYMENT.md) and [worker/DEPLOYMENT.md](../worker/DEPLOYMENT.md). Deploy controller/app/worker as a coordinated protocol change after draining the old worker. Apply migrations with the Node migration command, not by manually running the new SQL twice. Public account access requires the configured trusted HTTPS origin.

Operational credentials remain outside source. The CLI prints a newly issued invitation/worker credential only to the operator; do not include them in deployment reports. Rollback must preserve account authorization and artifact protections rather than restoring the old public/shared-token routes.
