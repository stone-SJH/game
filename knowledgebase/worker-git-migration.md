# Windows Worker Git migration

Recorded on 2026-09-17. Source checkout: `D:\game`; remote:
`git@github.com:stone-SJH/game.git`; local deployment branch: `deploy/stone-worker`,
tracking `origin/main`. Local deployment commits are not pushed automatically.

## Deployment audit

The previous worker deployer extracted `.tgz` bundles into
`D:\StoneWorker\releases\<timestamp>`, copied `agent/` and `deploy/` to the install
root, copied skills into the user profile, then launched Node. One local variant
patched `process-runner.mjs` after every deployment and restored the local
configuration-loading launcher if an old bundle replaced it. Those deployment
fixes were outside Git and could drift from the release source.

The checkout retains the Windows `.cmd/.bat` runner support, with the literal-dot
extension check restored from the installed version. Configuration loading is in
the tracked launcher. The new deployer merges committed local changes with the
branch upstream, checks preconditions and runs source directly from the checkout.
The production skill is selected from that same checkout. See
[the runbook](../worker/DEPLOYMENT.md) for commands and conflict handling.

Remote commit `64a7c39` introduced the separate ECS Git deployment workflow while
this migration was being prepared. It has been merged locally, retaining all ECS
changes and the worker checks for ignored source files and recorded Git origin.
The Windows conflict was resolved using the `D:\game` layout and direct launcher
described here. This migration does not deploy or change the ECS service.

## Current handoff

The initial migration preserved the running task. Later on 2026-09-17 the operator
canceled `task-d1cf4e63-296f-4e9d-9b1b-6170fc25977f` and authorized the worker fix
and deployment. At 16:18 +08:00 the controller returned `STOP / CANCELED`; the old
execution journal was absent and the old worker had no task descendants. Its idle
agent (PID 20084) and launcher (PID 10252) were then stopped and shutdown verified.

Runtime data was copied to `D:\game\runtime`, with 33 files verified by SHA-256.
The old data remains in `D:\StoneWorker` as a backup. The copy inventory is
`runtime/migration/runtime-copy.json`; the destination environment subsequently
changed to the new root and the explicit Codex JS entrypoint. Credentials remain
outside Git in the protected runtime configuration directory.

Codex now uses Node/native execution and UTF-8 stdin with EOF, eliminating shell
prompt splitting and the open-input wait. Each run persists live stdout/stderr
and step diagnostics. CLI usage errors fail immediately. Worker regressions and
Windows deployment tests passed, and a real Codex invocation in a Chinese path
with spaces completed with the expected response. Controller integration tests
could not start their PostgreSQL fixture in this administrative Windows session;
the native server reported that administrative execution is not permitted.

Deploy the validated committed checkout without fetching unrelated updates:

```powershell
Set-Location D:\game
& .\worker\deploy\deploy-worker.ps1 -CheckOnly
& .\worker\deploy\deploy-worker.ps1
```

The runtime root is `D:\game\runtime`. It is ignored by Git, including credentials,
task workspaces, artifacts, logs and migration backups. `runtime/deployment.json`
records the successfully registered deployment commit, launcher and log paths.

## Cleanup record

Obsolete `0916/`, `cache/`, `releases/`, the early `worker/` payload and
`deploy.legacy-20260916-212533` were moved into
`D:\game\runtime\migration\legacy-source-backup`. All 333 archived files were
verified by SHA-256 against the pre-move inventory. The machine-local manifest is
`D:\game\runtime\migration\stoneworker-cleanup.json`.

This is a reversible cleanup: automatic approval rejected recursive deletion,
so the old source copies were archived. Windows holds the empty
`D:\StoneWorker\worker` directory open; its contents have been archived.

Retained in StoneWorker: active `agent/` and `deploy/`, `config/`, `journal/`,
`workspaces/`, `workspace/`, `artifacts/`, `checkpoints/`, `logs/` and the hardware
diagnostic `dxdiag.txt`. Remove the active source copies only after the Git-based
worker has registered successfully. Keep task data and historical evidence.

## Verification

`powershell.exe -NoProfile -ExecutionPolicy Bypass -File worker/tests/deployment.tests.ps1`
uses temporary Git repositories and a mocked process launcher. It verifies
dirty-tree rejection, RUNNING and RESULT journal protection, active-worker
protection, preflight without starting or merging, merging remote updates while
retaining local commits, conflict preservation, quoted Windows paths, credential
handling and the deployed commit record. It does not connect a test worker to the
production controller or interrupt the running task.
