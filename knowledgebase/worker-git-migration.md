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

The operator requested keeping the current task running and switching only after
it finishes. Therefore the active worker remains at `D:\StoneWorker\agent` with
its existing configuration and data. No worker was stopped, restarted, canceled
or migrated. The observed active task was
`task-d1cf4e63-296f-4e9d-9b1b-6170fc25977f`; the controller confirmed `CONTINUE`.

After task completion and result delivery, stop the old agent between jobs,
migrate its runtime directories as described in the runbook, then run:

```powershell
Set-Location D:\game
& .\worker\deploy\deploy-worker.ps1 -Update -CheckOnly
& .\worker\deploy\deploy-worker.ps1 -Update
```

The planned runtime root is `D:\game\runtime`. It is ignored by Git, including
credentials, task workspaces, artifacts, logs and migration backups. The current
live runtime has deliberately not been copied while the task is writing to it.

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
