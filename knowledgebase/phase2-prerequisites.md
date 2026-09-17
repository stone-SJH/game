# Phase 2 Production Launch Prerequisites

Status: future production scope; the current delivery target remains Phase 1 internal testing with a limited invited audience.

Phase 1 includes the account/task center, dedicated manually prepared workers, retained local workspaces, effective cancellation, continuous heartbeats, same-worker recovery and bounded conversation/game acceptance. Those capabilities must be implemented and accepted in Phase 1; listing their production checks here does not defer their implementation.

## Phase 1 handoff

The detailed [user/workspace design](user-workspace-worker-design.md) maps packages A/B/C to Phase 1 and package D to Phase 2. Invitation registration, server-side sessions, task/artifact ownership checks and trusted HTTPS ingress for account credentials are Phase 1 work. Cancellation must stop the process tree and reject stale success; heartbeat/control must continue throughout long execution and uploads.

Phase 2 inherits persistent task/workspace identity, revisions/runs, per-worker identity, allocation history, local checkpoints and the passing Phase 1 recovery/authorization tests. Phase 1 does not require shared pools, automatic provisioning/deletion, OSS, WSS/mTLS or automatic migration to another worker.

## New production capabilities

- Implement independent durable checkpoints and cross-worker restore before enabling automatic destructive worker release. Account for every retained workspace on an instance, including paused tasks.
- Implement the Wuying lifecycle adapter or managed worker pool: cold start, capability/session readiness, admission quotas, fair allocation, draining, idle shutdown and cleanup. Worker slot release, VM stop and instance deletion are separate operations.
- Move artifacts and source/checkpoint bundles from retained pilot disks to OSS. Verify SHA-256 and issue short-lived signed downloads; production ECS local disk is temporary cache only.
- Replace worker polling with `wss://<domain>/v1/worker/connect`, per-instance device identity and mTLS. Preserve message deduplication, sequence rules, lease fencing and reconnect/resume.
- Install automated Windows bootstrap that repairs and starts the Agent in the logged-in user session and supports verified image/session readiness after cold start.

## Production launch checks

- Verify the Phase 1 user-authentication, task authorization, session expiry, CSRF and audit controls under production admission/load; ensure shared-token browser access cannot bypass ownership.
- Harden trusted domain/TLS operation, certificate renewal and ingress policy; expose only required HTTPS endpoints and restrict SSH to administrator IPs.
- Issue short-lived, revocable worker credentials. Store provider/OSS credentials in an ECS RAM role or secrets manager, never in source or task payloads.
- Exercise database/schema migration, backup and restore at production volume, preserving immutable revisions, runs, allocation history and event cursors.
- Extend passing Phase 1 cancellation/heartbeat/expiry/recovery tests to worker replacement, network partitions, partial remote uploads, stale boots, controller restart during provisioning/release and duplicate cloud calls.
- Verify cross-tenant worker reset/isolation, quota enforcement, retention-aware deletion, and restore after instance loss. Never assume external tool execution is exactly once.
- Revalidate real Blender rendering, Unreal packaging and packaged-game behavior with versioned evidence after worker/image/storage migration.
- Add production structured logs, metrics, alerts, external monitoring and controller/database/worker/OSS failure runbooks.
- Complete network rules, private PostgreSQL/Redis, least-privilege accounts, dependency/image scanning and credential rotation/revocation procedures.

## Compatibility rule

Keep the Phase 1 `/v1/tasks`, task view, event and artifact metadata shapes stable while adding the Phase 2 transport and storage adapters. Update [controller-worker-architecture.md](controller-worker-architecture.md) and this checklist together whenever a boundary changes.
