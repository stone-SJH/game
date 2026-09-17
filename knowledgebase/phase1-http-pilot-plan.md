# Phase 1 Internal Pilot

Status: active phase, limited invited internal users. Account/reliability code is locally implemented and tested; deployment and remaining product acceptance are open.

## Deployment test record

On 2026-09-16 the user reported accessing `http://139.224.32.61/` on a user machine, running `Run the verified Windows toolchain smoke test task`, and observing `COMPLETED`. This is evidence for the original deployed HTTP smoke path. It is not a deployment acceptance of the newer account/protocol-2 release. Task ID, final JSON, hashes and logs were not supplied with that report.

## Phase boundary

| Area | Phase 1: current internal testing | Phase 2: future production launch |
| --- | --- | --- |
| Users | Small invitation/account cap, sessions, owner-scoped task center | Production account operations and scale |
| Worker | Manually enrolled dedicated workers, one running task per worker/user | Shared pools, cold start, quotas and automated allocation |
| Workspace | Task identity, persistent local directories and same-worker recovery | Independent durable checkpoints and cross-worker restore |
| Task control | Effective cancellation, continuous heartbeats, deadlines, pause/resume | Extend guarantees through replacement and automatic lifecycle operations |
| Product | Actual progress/artifacts, internal conversation and bounded real-game acceptance | Production operation and capacity |
| Infrastructure | PostgreSQL, polling, authenticated local files, trusted HTTPS for accounts | WSS/mTLS, OSS, provider adapters and automatic resource release |

The current implementation batch addresses cancellation/heartbeat defects, accounts/task center and the workspace/allocation foundation. See [phase1-implementation.md](phase1-implementation.md) for exact completion status. Pause/checkpoint recovery and conversation-driven production remain Phase 1 work; they are not silently deferred to Phase 2.

## Runtime and rollout

```text
Authenticated browser -> ECS API -> PostgreSQL task/workspace/run state
  -> dedicated Windows worker outbound poll + independent heartbeat/control
  -> tool process tree -> streamed artifacts + durable final result
  -> owner-scoped task list/detail/events/downloads
```

The browser may close without stopping work. Registration is invitation-only and subject to `MAX_USERS`. A user without an enrolled/bound worker can create queued tasks but cannot claim another user's worker. Worker credentials are separate from browser sessions. There is no shared browser `PHASE1_TOKEN` fallback in the account release.

Deployment instructions are maintained in [controller/DEPLOYMENT.md](../controller/DEPLOYMENT.md), [app/DEPLOYMENT.md](../app/DEPLOYMENT.md) and [worker/DEPLOYMENT.md](../worker/DEPLOYMENT.md). Earlier single-file agent copy instructions and direct `001_init.sql` deployment commands do not cover this release. Apply migrations with the migration runner and deploy all agent modules.

The bounded 2026-09-16 pilot uses `http://139.224.32.61/` with an explicit `ALLOW_INSECURE_HTTP=true` deployment override; this is temporary internal testing only and uses non-Secure cookies. Normal account deployments require trusted HTTPS and `PUBLIC_ORIGIN`. Phase 1 does not require WSS, cloud provisioning or OSS.

## Acceptance gates

- Two invited users register/login; a code is single-use and concurrent registration cannot exceed the cap.
- A user can create and retrieve their tasks after browser close/reopen or login on another browser. Task/event/artifact access cannot cross owners; logout/expiry removes browser access.
- Individually authenticated workers claim only bound user tasks. Concurrent/duplicate polls cannot start two jobs in the same worker/workspace.
- A long command and an artifact upload continue receiving heartbeat/control service and matching lease renewal. Lost leases stop local work and retain uncertain allocations in recovery.
- Queued cancellation prevents dispatch. Running cancellation remains `CANCELING` until the full process tree is stopped; no later stage starts and delayed `PASS` cannot overwrite canceled state.
- Repeated requests/results and both cancel/completion orderings preserve the committed terminal decision. An unconfirmed stop never frees the allocation.
- Tool errors produce a recorded failure, with logs/artifacts tied to the correct job. Completion requires the expected verified task artifacts; process exit alone is insufficient.
- Queued/running deadlines, controller restart, offline worker, final-result replay and agent-crash recovery are exercised. The current unfinished-execution journal blocks unsafe duplicate work; automatic crash recovery is still open.
- Pause task A, execute B in a separate workspace, then resume A from a verified local checkpoint. This gate remains open until pause/checkpoints are implemented.
- Create a real production task from a natural-language objective, let the worker create its workspace and any `.blend`/`.uproject` files, render/package/run the result, inspect evidence and downloads, then exercise one bounded conversation-driven revision. These are later Phase 1 product gates.

Record release/schema/worker protocol versions, task/run/workspace IDs, heartbeat/control timestamps, process shutdown evidence, task JSON/events and artifact hashes. Distinguish local regression results from deployed GPU results.

## Next phase

Keep logical task/workspace identity stable when moving to production workers/storage. Cross-worker restore must be proven before destructive automatic resource release. All retained workspaces on an instance, including paused tasks, need independent recoverability or explicit deletion. The [Phase 2 checklist](phase2-prerequisites.md) remains future scope.
