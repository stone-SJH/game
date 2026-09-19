# Phase 1 Windows Worker

The Windows worker runs directly from the Git checkout at `D:\game`, with remote
`git@github.com:stone-SJH/game.git`. Runtime files live in the Git-ignored
`D:\game\runtime` directory. There is no worker tar extraction, release copy or
deployment-time source patching. Edit the tracked files under `worker/` and commit
machine deployment fixes to a local branch; never commit credentials or task data.

## Initial setup

Use the logged-in worker account. If the checkout does not exist:

```powershell
git clone git@github.com:stone-SJH/game.git D:\game
Set-Location D:\game
git switch -c deploy/stone-worker --track origin/main
New-Item -ItemType Directory -Force runtime\config
Copy-Item worker\deploy\worker.env.ps1.example runtime\config\worker.env.ps1
```

Configure the protected environment file before starting. Do not repeat the copy
over an existing configuration. The launcher uses the production skill directly
from this checkout; separately installed specialized skills remain in place.

## Update and deployment

Wait for the current task and pending result delivery to finish, and stop the old
agent with Ctrl+C before updating code. The deployment script refuses any existing
execution journal or running worker process. Do not kill active work or clear a
journal to bypass this check. Coordinate protocol changes with the controller.

```powershell
Set-Location D:\game
git status --short
git diff
# Commit the specific files changed for this machine before updating.
# git add worker/<changed-file>
# git commit -m "Describe the local deployment fix"
& .\worker\deploy\deploy-worker.ps1 -Update -CheckOnly
& .\worker\deploy\deploy-worker.ps1 -Update
```

`-Update` fetches `origin` and merges the current branch's upstream, preserving
local commits. It never resets, auto-stashes or pushes. Conflicts stop deployment;
resolve and commit them, or use `git merge --abort`, before trying again. A dirty
working tree or ignored file under `worker/` or `skills/` is rejected before
fetch/start. Omit `-Update` to deploy the current
committed revision without accessing GitHub. `-CheckOnly` performs preflight only.

After an update the script re-runs the updated deployment entry point, checks Node
20+, module syntax, configuration and the production skill, and starts the worker
in a hidden user-session window. Registration must be confirmed in its new log.
`runtime/deployment.json` records the commit, remote, branch, launcher PID and log paths.
The credential is loaded from disk and never passed on the process command line.
For a foreground session use `worker/deploy/start-phase1.ps1` instead.

For rollback, stop between jobs, inspect `git log`, revert the faulty commit on the
local deployment branch, and deploy again without `-Update`. Keep runtime data.
Controller deployment is a separate ECS operation documented in
[`../controller/DEPLOYMENT.md`](../controller/DEPLOYMENT.md).

## Migration from StoneWorker

First finish or explicitly cancel the current task and verify result delivery and
process shutdown. Preserve `config`, `journal`, `workspaces`, `workspace`,
`artifacts`, `checkpoints` and `logs`; move them to `D:\game\runtime` only when idle.
Update the protected configuration's `YAHAHAGAME_WORKER_ROOT` to that path and
remove `STONE_WORKER_ROOT`. Compare file hashes before removing old data copies.
Historical reports may contain old absolute paths; retain them as evidence.

Once no process references the old install, tar bundles (`0916/`), extraction
caches (`cache/`), release snapshots (`releases/`), duplicate `worker/`, `agent/`
and `deploy/` source trees and the legacy environment template can be removed.
Reconcile any locally changed source into Git before deleting its old copy.

## Enrollment

An operator runs `node tools/admin.mjs enroll <workerId>` on the controller and assigns the printed per-worker credential to this agent. After an invited user registers, the operator runs `node tools/admin.mjs bind <username> <workerId>`. Old shared worker credentials do not authenticate this release.

Store settings in `runtime/config/worker.env.ps1` using `deploy/worker.env.ps1.example`, with ACLs limited to the operator/worker account. Set `CONTROL_URL`, `WORKER_ID`, `WORKER_TOKEN`, `YAHAHAGAME_WORKER_ROOT`, `CODEX_CMD` and the actual tool executable paths. The account rollout uses the trusted HTTPS controller origin.

```powershell
& D:\game\worker\deploy\start-phase1.ps1 -WorkerRoot 'D:\game\runtime'
```

The launcher preserves environment overrides for Blender/Unreal. Validate Node and tool versions and controller connectivity before start. Never publish credentials in evidence logs.

## Foreground monitoring

Open a separate PowerShell or Command Prompt and run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File D:\game\worker\deploy\monitor-worker.ps1
```

From the checkout, `npm run worker:monitor` runs the same monitor. It refreshes
every two seconds; Ctrl+C closes the monitor. The monitor does not start, stop,
claim or cancel worker tasks, renew leases, or write runtime files.
It loads credentials from `runtime/config/worker.env.ps1` without putting them
on the command line. The default runtime belongs to the script's checkout,
even if the shell still has an old `YAHAHAGAME_WORKER_ROOT` environment value.

```powershell
# Change the refresh interval or explicitly select another runtime.
& D:\game\worker\deploy\monitor-worker.ps1 -WorkerRoot 'D:\game\runtime' -IntervalSeconds 5
# Print a single snapshot, optionally as JSON.
& D:\game\worker\deploy\monitor-worker.ps1 -Once
& D:\game\worker\deploy\monitor-worker.ps1 -Once -Json
```

The display includes the local journal phase, task/workspace/run IDs, latest
Codex/Unreal/playtest step, descendant process PIDs, cumulative CPU time, memory,
recent file activity and bounded log tails. Worker and lease credentials are
redacted. Directory scanning is bounded and skips generated caches; file activity
and CPU time are diagnostic signals, not proof of successful task progress.
`INTERRUPTED` means a journal remains with no worker process; `RESULT` means final
result delivery is pending. A journal read or process query failure is `UNKNOWN`.

When the controller includes `GET /v1/worker/status`, the monitor also shows its
authoritative task/job state, lease expiry, cancellation reason, queue count and
heartbeat age. This endpoint accepts only the enrolled worker's credentials,
performs SELECT queries only, and does not expose lease tokens. Heartbeats older
than 15 seconds are marked stale. Older controllers return `UNSUPPORTED`; network
failures remain visible while local monitoring continues and remote reads retry.
In those cases the controller's task state is explicitly `UNKNOWN`.
Deploy the controller endpoint through its normal deployment workflow between
tasks; the local monitor can be used immediately without restarting the worker.

## Workspace and execution

Each task receives a persistent `workspaceId` and a new empty project directory at `workspaces/<workspaceId>/project`, with output under `workspaces/<workspaceId>/runs/<runId>`. The browser sends only the objective. The production worker invokes the installed `yahahagame-production` skill through Codex CLI in that workspace, writes its stage manifests, and requires a real `.uproject`, `scene-preview` image, packaged playable `.exe`, and `acceptance/acceptance-report.json` before completion. It launches the packaged executable with a bounded playtest before uploading final artifacts; bootstrap images and editor startup logs are diagnostic only. Failed iterations retain their evidence and pass through the iteration monitor before retrying. Cancellation, deadlines, uncertain process shutdown, hard failures, command timeouts and finite monitor budgets stop execution.

Heartbeat/control remains active during commands and streamed uploads. After each packaged executable passes the bounded launch check, the worker archives the complete Windows package directory and uploads it as `playable-package-iteration-NNN.zip`; this exposes playable checkpoints before later acceptance gates finish. Windows cancellation uses process-tree termination; the agent confirms shutdown before acknowledging completion/cancellation. A local lease deadline also stops execution if the controller cannot renew it. Package archives are subject to the controller's 2 GiB artifact limit and the worker's `PACKAGE_ARCHIVE_TIMEOUT_MS` (default 60 minutes).

Codex runs through Node and its npm package entrypoint (or a configured native
executable). `CODEX_CMD` accepts a JS entrypoint, a native executable, or the npm
`codex.cmd` shim, which is resolved without executing a shell. Prompts are sent as
UTF-8 to `codex exec -` and stdin is closed after writing. Each step writes live
stdout/stderr and a result JSON under its run directory. Codex CLI usage errors
(exit code 2) and process launch errors fail immediately instead of retrying.
Run `npm run test:worker` for the stdin, argument, launch and cancellation tests.

### Iteration monitor

Every completed iteration receives a small rule-based review. Known service failures use bounded
backoff (10 seconds, then 20 seconds by default), not another diagnostic AI call. A missing
`HelpCommandlet` can only trigger the fixed `LoadPackage` probe on the same deliverables. If
`LoadPackage` itself is unavailable, the run stops with a validator configuration failure. The
monitor cannot remove validation gates or treat a skipped check as PASS.

Only a second occurrence of an otherwise unknown failure can invoke the independent Codex
diagnostic process. It receives bounded diagnostic text, uses a read-only sandbox, and disables
shell execution, MCP servers, apps, browser/computer tools, plugins/hooks and child agents. It
does not load project instructions or production skills. Its validated JSON response may only
recommend a project repair, a bounded retry, or a stop. Infrastructure repair recommendations
stop the run. The production agent performs project repairs on the next iteration; it receives
the last diagnosis in its prompt. Neither the monitor nor its advice changes the core skill,
worker source/configuration, retry budgets or acceptance criteria.

Settings belong in the protected `runtime/config/worker.env.ps1` and apply after a worker restart:

| Setting | Default | Meaning |
| --- | --- | --- |
| `ITERATION_SAME_FAILURE_LIMIT` | `3` | Stop on the third occurrence of the same failure signature in a run. |
| `ITERATION_FAILURE_LIMIT` | `8` | Stop after eight failures even when signatures change. |
| `ITERATION_MONITOR_MAX_CALLS` | `2` | At most two diagnostic AI calls per run; `0` disables AI while retaining rules. Maximum 2. |
| `ITERATION_MONITOR_TIMEOUT_MS` | `60000` | Per-call wall-clock budget, including process startup. Maximum 60000. |

`CODEX_MAX_ATTEMPTS` remains an additional production limit; `0` does not disable these monitor
limits. Diagnostic AI therefore adds at most two minutes per run, apart from process teardown
and report transfer. Failed/unavailable diagnostics fall back to the same bounded rule policy;
the monitor never recursively diagnoses itself. Task cancellation and lease expiry also apply
during diagnosis and retry delays.

Decisions are saved as `runs/<runId>/iteration-monitor-N.json` (with `-validator` for a probe
replacement), copied to `project/plan/iteration-feedback.json`, and uploaded as artifacts with a
10-second upload timeout. Failed uploads preserve local evidence and report the error. Existing
browser progress fields show the reason/action, and `production-report.json` includes the review
index. Stopping is reported as task failure, not a synthetic user cancellation or completion;
the retained workspace can be continued after the underlying issue is addressed.

`journal/execution.json` records active work and pending final results. Pending results are replayed after reconnect/restart. An agent restart with a `RUNNING` journal is deliberately blocked until the old process tree and workspace are checked; automatic interrupted-step recovery and pause/resume are not yet implemented. Do not delete the journal or clear the controller allocation merely to bypass that guard.

## Acceptance

Create a production task through an invited account, verify its assigned worker, stage reports, `.uproject`, non-placeholder scene preview, packaged `.exe`, acceptance report and playable launch result, then run a long task and cancel it. Confirm ongoing heartbeats, all descendant processes stopped, `CANCELING -> CANCELED`, no next stage, and no state overwrite from late results. Retain workspace data. Repeat deployed GPU-tool tests even though local Node process-tree tests pass.

Stop the agent with Ctrl+C, which requests termination of its active scoped command. A hard process kill/crash may leave recovery work and is not equivalent to a verified cancel. Deploy/rollback controller and worker protocol versions together between jobs.
