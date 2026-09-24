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

If autostart is installed, create `runtime/config/autostart.paused` before stopping
the worker for maintenance. Keep it until the committed deployment is ready; the
one-minute retry otherwise restarts an idle, stopped worker.

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

## Automatic startup

Install from an elevated PowerShell in the worker account's desktop session:

```powershell
& .\worker\deploy\register-worker-autostart.ps1
Start-ScheduledTask -TaskName 'YahahaGame-Worker-Autostart'
& .\worker\deploy\register-worker-autostart.ps1 -CheckOnly
& .\worker\deploy\monitor-worker.ps1 -Once -Json
```

The task uses startup and worker-account logon triggers, plus an indefinite retry
every minute. It runs hidden in that account's interactive session so Codex, Blender
and Unreal keep their existing desktop, profile and credentials. Windows must first
establish that user's session; this does not configure automatic Windows login or
promise GPU execution before login. A disconnected session can remain logged in.

`autostart-worker.ps1` leaves an existing worker running and invokes the normal Git
deployer only when no agent or execution journal exists. Dirty source, an interrupted
RUNNING journal or pending RESULT journal blocks startup for operator inspection;
no journal or task data is discarded. Startup uses the current committed checkout
without fetching or merging remote changes. Scheduled/manual deployments share a
runtime mutex, and the scheduled task ignores overlapping invocations.

Inspect `runtime/logs/autostart-status.json`, `runtime/deployment.json`, worker logs
and the read-only monitor after every deployment. The task's last result only proves
its invocation succeeded; the controller heartbeat proves the worker is connected.
Network/startup failures retry on the next minute. A still-running but unhealthy
worker is reported by monitoring and is never killed automatically.

For maintenance, create the pause marker before the intentional stop, then remove
it and trigger the task when ready:

```powershell
New-Item -ItemType File -Force runtime/config/autostart.paused
# Wait for idle, stop the worker, commit and verify changes, then deploy.
Remove-Item -LiteralPath runtime/config/autostart.paused
Start-ScheduledTask -TaskName 'YahahaGame-Worker-Autostart'
```

Run `powershell.exe -NoProfile -ExecutionPolicy Bypass -File worker/tests/autostart.tests.ps1`
for startup regressions and repeat `register-worker-autostart.ps1 -CheckOnly` after
future changes. Retire an obsolete task only after inspecting its action and backing
up its XML in runtime diagnostics; do not disable unrelated supervisors.

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

Each task receives a persistent `workspaceId` and a new empty project directory at `workspaces/<workspaceId>/project`, with output under `workspaces/<workspaceId>/runs/<runId>`. The browser sends the objective and optional uploaded reference IDs. The agent downloads and verifies references into `project/references/` before execution, and includes their local paths in the production prompt and `plan/production-context.json`. Each submission can add five files of at most 20 MiB each; continuations retain earlier references. See [reference data flow and verification](../knowledgebase/task-reference-files.md). The production worker invokes the installed `yahahagame-production` skill through Codex CLI in that workspace, writes its stage manifests, and requires a real `.uproject`, `scene-preview` image, packaged playable `.exe`, and `acceptance/acceptance-report.json` before completion. It launches the packaged executable with a bounded playtest before uploading final artifacts; bootstrap images and editor startup logs are diagnostic only. Failed iterations retain their evidence and pass through the iteration monitor before retrying. Cancellation, deadlines, uncertain process shutdown, hard failures, command timeouts and finite monitor budgets stop execution.

Heartbeat/control remains active during commands and streamed uploads. After each packaged executable passes the bounded launch check, the worker archives the complete Windows package directory and uploads it as `playable-package-iteration-NNN.zip`; this exposes playable checkpoints before later acceptance gates finish. Windows cancellation uses process-tree termination; the agent confirms shutdown before acknowledging completion/cancellation. A local lease deadline also stops execution if the controller cannot renew it. Package archives are subject to the controller's 2 GiB artifact limit and the worker's `PACKAGE_ARCHIVE_TIMEOUT_MS` (default 60 minutes).

Codex runs through Node and its npm package entrypoint (or a configured native
executable). `CODEX_CMD` accepts a JS entrypoint, a native executable, or the npm
`codex.cmd` shim, which is resolved without executing a shell. Prompts are sent as
UTF-8 to `codex exec -` and stdin is closed after writing. Each step writes live
stdout/stderr and a result JSON under its run directory. Codex CLI usage errors
(exit code 2) and process launch errors fail immediately instead of retrying.
Run `npm run test:worker` for the stdin, argument, launch and cancellation tests.

### Modeling assessment and routes

Modeling routing is enabled by default. Before the main production call, a restricted intake
agent splits 3D requirements into asset specifications; an independent evaluator assesses each
asset's complexity, precision, quality, tool coverage and reusable sources. The host prefers
registered source edits, then selects direct Blender authoring or Tripo followed by limited
Blender cleanup. The evaluator receives actual reference/preview images. Invalid assessments
fall back to direct Blender after two calls.

`worker/tools/blender-mcp-server.mjs` provides a per-attempt stdio MCP server with health and bpy
tools. Each tool call starts headless Blender and must explicitly reopen saved files to continue.
Successful authoring requires an MCP receipt. Host checks reopen both the source `.blend` and
the exported GLB, check geometry/materials, render four views and request an independent visual
review against every original requirement. Accepted models are registered in
`provenance/modeling-catalog.json` with hashes and previews for later reuse. Existing licensed
`.blend`, `.glb` and `.fbx` entries in that catalog or `provenance/asset-manifest.json` are eligible;
missing previews are rendered before assessment. This first version ranks at most three local
workspace candidates, without a cross-workspace asset search service.

The optional API key defaults to `tripo.txt` at the Git checkout root, independent of the current
working directory. `TRIPO_API_KEY_FILE` can point to protected configuration outside Git. Startup
checks availability without a paid request. Missing, empty or unreadable files skip third-party
assessment and network calls. Launch/deploy scripts add the exact root file to local
`.git/info/exclude` and reject a staged/tracked key. No key is passed to agents or artifacts;
provider credentials and signed download URLs are omitted from persisted reports.

Tripo requests use the China-region v3 API (`https://openapi.tripo3d.com/v3`) with a
China-region API key. This worker does not fail over to the international `.ai` endpoint.
Submission intent and task ID are persisted before proceeding.
Generated bases are imported and reviewed before cleanup, and their previews are compared with
the final result. A full rebuild cannot be accepted as limited cleanup.
Credits, authentication, service, timeout, download, import and generated-model quality failures
switch to direct Blender. A lost submission response never triggers another paid POST; a known
task ID can resume polling. The default budget is one new submission per run. User cancellation,
expired leases, local storage failures and uncertain process shutdown still stop execution.

| Setting | Default | Meaning |
| --- | --- | --- |
| `MODELING_ROUTING_ENABLED` | `1` | Set to `0` for the previous production workflow. |
| `MODELING_HARNESS_V2_ENABLED` | `0` | Opt in new tasks to pinned skills, blockout feedback and DCC/Unreal gates. Explicit v2 specs also opt in. |
| `MODELING_AGENT_MODEL` | inherited | Optional model for evaluation, authoring and visual review. |
| `MODELING_EVALUATION_TIMEOUT_MS` | `120000` | Budget per restricted agent call. |
| `MODELING_BUILD_TIMEOUT_MS` | `1800000` | Budget per direct/reuse authoring attempt. |
| `MODELING_CLEANUP_TIMEOUT_MS` | `300000` | Budget per generated-model cleanup attempt. |
| `TRIPO_MODEL` | `v3.1-20260211` | Pinned generation model. |
| `TRIPO_MAX_GENERATIONS_PER_RUN` | `1` | New submissions across all assets; `0` prevents submission. |
| `TRIPO_MAX_WAIT_MS` | `480000` | Generation, polling and download budget. |
| `TRIPO_REQUEST_TIMEOUT_MS` | `20000` | Timeout for one API request. |
| `TRIPO_POLL_MS` | `3000` | Poll interval. |

Reuse and cleanup allow two attempts each; direct authoring allows three. Cleanup that requires
a full rebuild falls back immediately. Exhausting direct quality checks fails with retained
evidence rather than weakening acceptance. There are at most four explicit model-plan revisions.
The production agent consumes `plan/modeling-results.json`, integrates accepted assets, and
requests revisions using `plan/modeling-request.json`; accepted source/export hashes are checked
again afterward. Existing Unreal import, playtest and packaging gates still apply. Static model
checks do not replace engine validation or a rig/animation deformation test.

Reports are saved under `plan/modeling/` and `stages/asset-production-and-import/models/`, with
host resumable state in the workspace's sibling `modeling-state/` directory and run reports in
`runs/<runId>/`. Preserve these directories when continuing a task.

Run `npm run test:worker` and `powershell.exe -NoProfile -ExecutionPolicy Bypass -File worker/tests/deployment.tests.ps1`.
The isolated real-tool probe is:

```powershell
node worker/tools/modeling-pipeline-probe.mjs --live-evaluation --live-author --live-review --reuse --generated --cancel --balance
```

It creates a temporary workspace with Chinese characters/spaces, tests missing-key authoring and
a simulated credits failure, runs real Blender checks, and optionally performs a read-only real
balance query. `--reuse` verifies registered-source previewing and edits without changing the
original; `--generated` exercises download/import/cleanup using a local provider response fixture.
It never submits a paid generation. The live flags exercise actual Codex agents;
without them the corresponding agent responses/build are fixtures. `--cancel` verifies shutdown
of an actual Blender child. Paid provider generation and complex organic/rigged asset benchmarks
require separate validation on a worker with provider connectivity.

V2 uses four repository-owned skills and a pinned MIT upstream resource lock. Task copies are
hashed before execution and acceptance. The host persists the plan and per-asset toolchain in
`modeling-state/`; toggling the flag does not downgrade an existing task. A changed toolchain
stops that task with evidence, rather than creating a fresh attempt budget. Restore its release
to resume. Do not delete task state or provider ledgers as a migration procedure.

The v2 real-author benchmark (no paid generation unless `--tripo` is supplied) is:

```powershell
node worker/tools/modeling-v2-probe.mjs --case hard-surface --out D:\ModelingAudit\hard-surface
node worker/tools/modeling-v2-probe.mjs --case lowpoly --reference D:\ModelingAudit\axe.png --out D:\ModelingAudit\lowpoly
node worker/tools/modeling-v2-probe.mjs --case hard-surface --reuse-source D:\ModelingAudit\source.blend --out D:\ModelingAudit\reuse
node worker/tools/modeling-v2-probe.mjs --case modular --out D:\ModelingAudit\modular
node worker/tools/modeling-v2-probe.mjs --case organic --out D:\ModelingAudit\organic
node worker/tools/modeling-v2-probe.mjs --case rig --out D:\ModelingAudit\rig
node worker/tools/modeling-unreal-probe.mjs D:\ModelingAudit\unreal
node worker/tools/modeling-unreal-probe.mjs D:\ModelingAudit\unreal-door door
node worker/tools/modeling-unreal-asset-probe.mjs D:\ModelingAudit\modular\modular-1\project D:\ModelingAudit\unreal-authored-door
```

Use a fresh output directory for an independent run; `--repeat 3` measures variability.
`--variant legacy` exercises the former authoring flow; compare exported assets against the
same full technical target before interpreting pass-rate differences. The UE probe creates an
isolated project, imports FBX/UCX/LOD, validates the saved package and map, then invokes the
production host boundary and an independent image reviewer. Startup health is not engine readiness.
Lightmap packing, complex skeletal Unreal handoff and custom pivot mapping fail closed until
their importer validators are calibrated. Keep global v2 intake disabled until the release
benchmark matrix meets the [upgrade plan](../knowledgebase/worker-modeling-harness-upgrade-plan.md).

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

The worker requires the acceptance report and stage manifest to carry the current task/run
identity. Reports must explicitly prove packaged-game, gameplay, and visual PASS states with a
non-empty passing criteria array; an older run's report is rejected even when its files remain in
the persistent workspace.

Create a production task through an invited account, verify its assigned worker, stage reports, `.uproject`, non-placeholder scene preview, packaged `.exe`, acceptance report and playable launch result, then run a long task and cancel it. Confirm ongoing heartbeats, all descendant processes stopped, `CANCELING -> CANCELED`, no next stage, and no state overwrite from late results. Retain workspace data. Repeat deployed GPU-tool tests even though local Node process-tree tests pass.

Stop the agent with Ctrl+C, which requests termination of its active scoped command. A hard process kill/crash may leave recovery work and is not equivalent to a verified cancel. Deploy/rollback controller and worker protocol versions together between jobs.
