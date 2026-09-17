# ECS Git deployment migration

Inspected on 2026-09-17. The source worktree is `/root/workspace/game`, with remote
`git@github.com:stone-SJH/game.git` and branch `main`. Remote fetch succeeded at
`40ae84d54056cd2f8390e59901cbf3a13b5f49c5` before the local deployment changes.

## Previous deployment

The standalone `/root/workspace/deploy-controller.sh` accepted `--bundle`, unpacked a
release tar into `/opt/yahahagame-controller/releases/<timestamp>`, installed dependencies,
applied migrations and moved controller/app into the installation root. It backed up the
previous code under `backups/` and PostgreSQL/artifacts under `/var/backups/yahahagame/`.
The last tar release inspected was `20260917-102900`; it has no Git commit metadata.
The deployed API and app entry files matched the initial repository commit.

## Current workflow

Use `controller/deploy/deploy-controller.sh` from the worktree. Commit all intentional
source and deployment changes there. Fetch/fast-forward retains local commits; divergent
local/remote history stops deployment until explicitly merged. Secrets stay outside Git.
See [controller deployment](../controller/DEPLOYMENT.md) for commands and prerequisites.

The script exports the selected commit, installs dependencies, backs up data, migrates,
activates controller/app and verifies health. Git's streamed archive is only an internal
snapshot export; there is no release bundle to upload or manage. Each new release records
the exact commit and remote in `deployment-metadata.txt`. Artifact backups still use tar.

Layout retained on this host:

| Purpose | Path |
| --- | --- |
| Git source | `/root/workspace/game` |
| Installed controller and app | `/opt/yahahagame-controller/{controller,app}` |
| Protected configuration | `/opt/yahahagame-controller/config/controller.env` |
| Retained artifacts | `/var/lib/stone-controller/artifacts` |
| Prior code/releases | `/opt/yahahagame-controller/{backups,releases}` |
| PostgreSQL and artifact backups | `/var/backups/yahahagame` |

The script retains the host's Node selection (`/usr/local/bin/node`) and legacy artifact
parent traversal permissions. The service unit's writable path follows `ARTIFACT_ROOT`.
Do not move retained artifacts without accounting for absolute database storage paths.
The old `APP_INDEX` configuration key is unused by protocol 2; the app is served from
the sibling `app/` directory by default.

## Cleanup

Removed obsolete copies from `/root/workspace`:

- `app/` and `controller/`, including the old installed `node_modules/`.
- Standalone `deploy-controller.sh` and `ecs-controller-bootstrap.md`.
- `yahahagame-0916.tgz` and `yahahagame-0917-1.tgz`.
- Duplicate tar entry point `game/controller/deploy/deploy-controller-new.sh`.

Retained `task-d1cf4e63-investigation/` because its worker diagnosis is unresolved.
No database records, credentials, artifacts or deployment backups were removed.

## Activation status

The controller is active and `/healthz` returns protocol 2. At inspection, task
`task-d1cf4e63-296f-4e9d-9b1b-6170fc25977f` was `RUNNING` with one unreleased allocation.
The migration work therefore does not restart the service or change the installed release.
Git validation can run with `--dry-run`; the first actual Git deployment must wait for
verified task completion/cancellation and released allocations.
