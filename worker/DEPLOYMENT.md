# Phase 1 Windows Worker

The Windows machine has its own local deployment script at [`deploy/deploy-worker.ps1`](deploy/deploy-worker.ps1). Copy that script and the release bundle to the worker, then run it in an elevated PowerShell window:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\deploy-worker.ps1 -Bundle C:\Temp\yahahagame-<timestamp>.tgz
```

The script stops the current agent, refuses an unconfirmed running journal, updates the worker
code and any bundled Codex skills, then restarts the agent. If a release bundle contains only the
project master skill, the worker preserves its existing specialized skill installation. It does
not use SSH or contact the ECS machine except through the worker's configured controller URL.

Deploy the controller first. Its idle/allocation check is the authority that confirms no task is
running before this worker script stops the current agent.

Deploy the complete `worker/` directory, including `agent/agent.mjs` and `agent/process-runner.mjs`. The worker connects outbound only and must match controller protocol 2. Run tools in the logged-in Windows user session.

## Enrollment

An operator runs `node tools/admin.mjs enroll <workerId>` on the controller and assigns the printed per-worker credential to this agent. After an invited user registers, the operator runs `node tools/admin.mjs bind <username> <workerId>`. Old shared worker credentials do not authenticate this release.

Store settings outside source using `deploy/worker.env.ps1.example`, with ACLs limited to the operator/worker account. Set `CONTROL_URL`, `WORKER_ID`, `WORKER_TOKEN`, `YAHAHAGAME_WORKER_ROOT`, `CODEX_CMD` and the actual tool executable paths. The account rollout uses the trusted HTTPS controller origin.

```powershell
& .\deploy\start-phase1.ps1 -ControlUrl 'https://controller.example.com' -WorkerId 'yahahagame-sandbox-0' -WorkerToken $env:WORKER_TOKEN -WorkerRoot 'D:\YahahaGameWorker'
```

The launcher preserves environment overrides for Blender/Unreal. Validate Node and tool versions and controller connectivity before start. Never publish credentials in evidence logs.

## Workspace and execution

Each task receives a persistent `workspaceId` and a new empty project directory at `workspaces/<workspaceId>/project`, with output under `workspaces/<workspaceId>/runs/<runId>`. The browser sends only the objective. The production worker invokes the installed `yahahagame-production` skill through Codex CLI in that workspace, writes its stage manifests, and requires a real `.uproject`, `scene-preview` image, packaged playable `.exe`, and `acceptance/acceptance-report.json` before completion. It launches the packaged executable with a bounded playtest before uploading final artifacts; bootstrap images and editor startup logs are diagnostic only. Incomplete or transiently failed iterations are retained and retried after `CODEX_RETRY_DELAY_MS` (default 10 seconds) until the task deadline, cancellation, an explicit hard-failure marker, or a tool timeout.

Heartbeat/control remains active during commands and streamed uploads. Windows cancellation uses process-tree termination; the agent confirms shutdown before acknowledging completion/cancellation. A local lease deadline also stops execution if the controller cannot renew it.

`journal/execution.json` records active work and pending final results. Pending results are replayed after reconnect/restart. An agent restart with a `RUNNING` journal is deliberately blocked until the old process tree and workspace are checked; automatic interrupted-step recovery and pause/resume are not yet implemented. Do not delete the journal or clear the controller allocation merely to bypass that guard.

## Acceptance

Create a production task through an invited account, verify its assigned worker, stage reports, `.uproject`, non-placeholder scene preview, packaged `.exe`, acceptance report and playable launch result, then run a long task and cancel it. Confirm ongoing heartbeats, all descendant processes stopped, `CANCELING -> CANCELED`, no next stage, and no state overwrite from late results. Retain workspace data. Repeat deployed GPU-tool tests even though local Node process-tree tests pass.

Stop the agent with Ctrl+C, which requests termination of its active scoped command. A hard process kill/crash may leave recovery work and is not equivalent to a verified cancel. Deploy/rollback controller and worker protocol versions together between jobs.
