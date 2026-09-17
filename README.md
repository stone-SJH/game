# Yahaha3

Yahaha3 is the next control-plane implementation for sandbox-owned game production. Yahaha2 remains the read-only reference implementation; this project does not share its runtime state or stop its processes.

The local onebox reference limits its host to three operations:

1. Submit a preflight input containing gameplay, scene, visual and quality contracts.
2. Read the mirrored status for the corresponding remote goal.
3. Optionally observe progress and selected artifacts.

The sandbox controller owns plan compilation, task leases, execution, evidence validation, automatic task review and global completion. It does not infer acceptance from process exit codes or external human review.

The host-to-sandbox correlation is explicit: `controller/tools/trigger-task.mjs` creates an immutable `hostTaskId`; the sandbox assigns a `goalId` and publishes both in `control/public/tasks/<hostTaskId>.json`. The detailed contract is in [onebox-control-plane.md](protocols/onebox-control-plane.md).

## Local protocol smoke test

```powershell
npm --prefix controller ci
node controller/tools/trigger-task.mjs create <path-to-preflight.json>
node controller/core/sandbox-controller.mjs --once
node controller/tools/task-status.mjs <host-task-id>
```

The current controller deliberately holds a task when no sandbox executor is configured. The Windows production worker uses [production-harness.mjs](worker/agent/production-harness.mjs) to invoke the installed `yahahagame-production` skill, validate the complete stage/evidence contract, and launch the packaged game before reporting PASS. A local mock or a successful process exit cannot be mistaken for game acceptance. The file-based remote adapter boundary is [executor-contract.mjs](controller/core/executor-contract.mjs).

## Local preflight package

The current reference analysis and production planning notes are [zhongkui-preflight.md](analysis/zhongkui-preflight.md), [zhongkui-reference-manifest.json](analysis/zhongkui-reference-manifest.json), and [zhongkui-skill-derived-plan.md](analysis/zhongkui-skill-derived-plan.md). A preflight JSON is supplied separately when running the local sandbox smoke test and is intentionally not part of this repository.

## Production architecture baseline

The target ECS controller and Windows GPU worker architecture is recorded in [knowledgebase/controller-worker-architecture.md](knowledgebase/controller-worker-architecture.md). ECS installation and verification commands are in [knowledgebase/ecs-controller-bootstrap.md](knowledgebase/ecs-controller-bootstrap.md). These documents are the baseline for the remote implementation; the onebox protocol remains a local prototype reference.

The active Phase 1 limited-user internal pilot, its initial HTTP smoke baseline and acceptance procedure are in [knowledgebase/phase1-http-pilot-plan.md](knowledgebase/phase1-http-pilot-plan.md). Phase 2 is the later production launch.

The invitation-based account/task center, dedicated worker allocation records and cancellation/continuous-heartbeat fixes are implemented and locally tested. See [knowledgebase/phase1-implementation.md](knowledgebase/phase1-implementation.md) for completed work and remaining Phase 1 pause/checkpoint/conversation work. The full [user/workspace design](knowledgebase/user-workspace-worker-design.md) reserves cross-worker restore, cold start and automatic resource release for Phase 2. ECS currently runs the earlier tar deployment of the account/protocol-2 release. Subsequent updates use the repository-owned `controller/deploy/deploy-controller.sh` from `~/workspace/game`: fetch `origin/main`, fast-forward when possible, and deploy a committed Git snapshot. Commit local deployment changes before running it; local commits are retained and divergence requires an explicit merge. The Windows worker uses the matching Git worktree and `worker/deploy/deploy-worker.ps1`. See the [Git migration record](knowledgebase/git-deployment-migration.md) for the host layout and cleanup.

Run `npm --prefix controller ci`, `npm --prefix controller test`, then `npm --prefix controller run dev` for an isolated loopback task center with its own PostgreSQL database. The dev command prints the URL and local invitation file location. Deployment uses the directory runbooks and `npm --prefix controller run migrate`; do not apply the new migration manually twice.

## Repository layout

- `app/` contains the browser-facing static application and its deployment runbook.
- `controller/` contains Linux ECS API, scheduler/core packages, tools and deployment assets.
- `worker/` contains the Windows GPU Agent, launcher, local probe and deployment runbook.
- Windows worker deployments use the Git checkout at `D:\game`; local deployment fixes are committed on a local branch and runtime data is ignored under `runtime/`. See [worker deployment](worker/DEPLOYMENT.md) for update and migration commands.
- `knowledgebase/` contains architecture, phase plans and the Phase 2 prerequisite checklist.

Phase 1 refactoring is complete. On 2026-09-16, the user reported that the deployed Windows toolchain smoke task reached `COMPLETED` from a user machine at `http://139.224.32.61/`; the result and remaining acceptance checks are recorded in [phase1-http-pilot-plan.md](knowledgebase/phase1-http-pilot-plan.md#deployment-test-record). Phase 2 implementation remains gated by [phase2-prerequisites.md](knowledgebase/phase2-prerequisites.md).
