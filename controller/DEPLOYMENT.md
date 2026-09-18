# Phase 1 Controller Deployment

This account/protocol-2 release changes browser authentication and worker identity. The ECS is running this release from the earlier tar deployment. Git is now the source for subsequent deployments. Phase 1 is limited internal testing. Cloud pooling, OSS and automatic resource release remain Phase 2.

The ECS machine uses the Git repository as its source of truth. Clone it once into the operator's
home directory and keep the worktree at `~/workspace/game`:

```bash
git clone git@github.com:stone-SJH/game.git "$HOME/workspace/game"
```

Every deployment runs `git fetch --prune`, requires a clean checked-out branch, fast-forwards it to
the selected remote branch when possible, and exports the selected Git commit into a timestamped release. Local
deployment changes must be committed before deployment, so they remain visible in Git history and
cannot be silently overwritten by a remote update. The release records the remote, branch and
commit in `deployment-metadata.txt`.

Local commits ahead of the remote are retained and deployed; pushing them is optional. When remote
and local commits diverge, deployment stops. Merge upstream explicitly and resolve any conflicts:

```bash
cd "$HOME/workspace/game"
git status --short --branch
# Stage only intentional source/script changes, then commit them.
git fetch --prune origin
git merge origin/main
# Resolve conflicts, review/test, and commit the merge before deployment.
```

Do not edit `/opt/yahahagame-controller/controller` or `app` directly. Make source and deployment
script changes in this worktree and commit them; keep secrets in the protected configuration.

Run the repository-owned deployment entry point as root. When `sudo` changes `$HOME`, pass the
absolute repository path explicitly:

```bash
sudo bash "$HOME/workspace/game/controller/deploy/deploy-controller.sh" \
  --repo "$HOME/workspace/game" --remote origin --ref main \
  --public-origin http://139.224.32.61
```

Use `--dry-run` to fetch and validate Git without changing local HEAD, worktree files or the service.
It does not test runtime prerequisites or task activity. A real deployment
refuses active allocations, backs up PostgreSQL/artifacts, applies migrations, swaps the
controller/app release, and checks `/healthz`. It does not copy a source tar bundle to the ECS.

## Prerequisites and layout

Use Node.js 20+, private PostgreSQL, Nginx with trusted HTTPS ingress, and a service account with write access only to artifact storage. Install `controller/` and `app/` as siblings under `/opt/yahahagame-controller`. Keep environment/credentials in protected `/opt/yahahagame-controller/config/`, outside source. Do not copy `key/`, `.local/`, `node_modules/` or worker data. Existing pilot installations may keep `ARTIFACT_ROOT` under the legacy `/var/lib/stone-controller/artifacts`; preserve that path until the database storage paths and retained artifacts have been migrated deliberately.

Configure the values from `deploy/controller.env.example`: `DATABASE_URL`, `PUBLIC_ORIGIN` (exact HTTPS origin, no trailing slash), `APP_ROOT`, `ARTIFACT_ROOT`, `MAX_USERS`, `BIND` and `PORT`. Neither `PHASE1_TOKEN` nor a shared controller `WORKER_TOKEN` is used. Each worker is enrolled separately.

For loopback development only, `ALLOW_INSECURE_LOCALHOST=true` permits an HTTP origin with loopback bind. For this explicitly bounded internal pilot, `ALLOW_INSECURE_HTTP=true` may be set with `PUBLIC_ORIGIN=http://139.224.32.61`; this disables Secure cookies and must not be treated as a public deployment configuration. The original `deploy/nginx/phase1.conf` port-80 site can proxy this pilot. Serve `/`, `/app.js` and `/app.css` from `app/` or proxy them to the API.

## Upgrade sequence

1. Commit intentional source or deployment changes from the Git worktree. Stop new submissions and drain existing tool processes before stopping the old agent/API. Migration refuses legacy `RUNNING` jobs; reconcile actual execution instead of blindly changing their state.
2. Run the repository-owned deployment script. It stages the complete controller/app directories and matching worker modules from the selected Git commit; only the controller and app are activated on ECS. Worker deployment runs separately on Windows. Keep the existing systemd source/config/artifact permissions and do not overwrite the configured environment with the template.
3. In the controller directory, install runtime dependencies and run unit verification:

```bash
npm ci --omit=dev --ignore-scripts
npm run test:unit
```

4. The deployment script applies versioned migrations automatically. For a manual installation only, load `DATABASE_URL` from the protected environment and run:

```bash
npm run migrate
```

The runner records checksums in `schema_migrations`. Do not manually run an individual migration or edit an applied migration. The current release applies the worker telemetry and task follow-up migrations after the account migration. Historical pilot tasks remain unassigned to real users; the API excludes them. An explicit audited adoption tool is still pending.

Worker telemetry requires the matching worker update. The controller accepts older protocol-2
workers during the upgrade, but their tasks have no detailed progress until the agent is updated.
Terminal tasks can create another run with a modification prompt, a renewed 24-hour deadline and
the same task/workspace/worker assignment. Previous runs and artifacts remain available. Replayed
results acknowledge the original run without changing a later run. Continuation retains workspace
files and prompt history; it does not resume an in-memory Codex session.

The telemetry implementation is a controller-role path exception: actual worker process state,
prompts and local file timestamps must be collected in `worker/agent/`. Its worker tests and the
controller heartbeat/continuation integration tests verify that interface. Run Windows-specific
tests on the worker before activating its update. On Linux, run the embedded PostgreSQL integration
suite as a non-root user from an accessible checkout; a file-level test result without the individual
database cases is not evidence that the integration tests ran.

5. Issue limited invitation codes and enroll workers through the administrative CLI:

```bash
node tools/admin.mjs invite 3
node tools/admin.mjs enroll yahahagame-sandbox-0
```

The invitation/worker secrets are printed once for operator delivery. Set the enrolled worker's credential in its protected configuration. After a user registers, bind the worker:

```bash
node tools/admin.mjs bind tester yahahagame-sandbox-0
```

Bindings are exclusive. The initial CLI deliberately does not silently rotate/reassign a busy worker. An unbound user's tasks remain queued.

6. Configure the trusted HTTPS virtual host and exact `PUBLIC_ORIGIN`, validate Nginx, restart `yahahagame-controller`, then run the matching Git commit through the worker deployment script. The existing systemd unit uses the controller entry point. Port 8080 and PostgreSQL remain private.

## Verification

Run full local integration tests with dev dependencies before deploying the release: `npm ci` then `npm test`. The suite starts an isolated native PostgreSQL instance; the deployment unit test command does not require those dev dependencies.

On the deployed stack verify login, invitation cap, task listing after reopen, cross-user denial including artifact downloads, worker binding, long-running heartbeat/lease renewal and actual process-tree cancellation. Retain report/image hashes and final task state. `/healthz` is process liveness only.

The release does not implement pause/checkpoint restoration, automatic recovery of interrupted tool processes, conversation or natural-language project creation. An unfinished worker journal requires shutdown verification; a `RECOVERING` allocation must not be cleared while its old tools might still run.

## Compose

Use a protected `compose.env` based on the example. Explicit migrations replace PostgreSQL init-directory SQL:

```bash
docker compose --env-file /protected/compose.env -f deploy/docker-compose.phase1.yml up -d postgres
docker compose --env-file /protected/compose.env -f deploy/docker-compose.phase1.yml build controller
docker compose --env-file /protected/compose.env -f deploy/docker-compose.phase1.yml run --rm --no-deps controller node tools/admin.mjs migrate
docker compose --env-file /protected/compose.env -f deploy/docker-compose.phase1.yml up -d controller
```

Run admin commands with the same Compose `run --rm --no-deps controller` prefix. Redis is optional and is not used for Phase 1 authority. Do not run systemd and Compose controllers against the same port or delete database volumes.

## Rollback

Keep database/workspaces/artifacts intact. Roll back to an ownership-aware release or maintenance mode. The old shared-token API and unauthenticated download route are not acceptable rollback targets once account-owned tasks exist.
After a follow-up run is created, retain support for multiple runs per task when rolling back;
the earlier single-run scheduler is not compatible with that history.
