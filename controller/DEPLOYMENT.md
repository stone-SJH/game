# Phase 1 Controller Deployment

This account/protocol-2 release changes browser authentication and worker identity. It has local integration verification; it has not been deployed by the implementation task. Phase 1 is limited internal testing. Cloud pooling, OSS and automatic resource release remain Phase 2.

The ECS machine has its own deployment script at [`deploy/deploy-controller.sh`](deploy/deploy-controller.sh). Copy that script and a release bundle to the ECS machine, then run:

```bash
sudo bash /tmp/deploy-controller.sh --bundle /tmp/yahahagame-<timestamp>.tgz
```

The script refuses active allocations, backs up PostgreSQL/artifacts, applies migrations, swaps the
controller/app release, and checks `/healthz`. It does not use SSH or copy files to another host.

The release bundle must contain the updated `app/`, `controller/`, `worker/`, and project `skills/`
directories. It can be assembled on the release machine with `tar`; do not include `node_modules`,
`.local`, credentials, or worker data.

## Prerequisites and layout

Use Node.js 20+, private PostgreSQL, Nginx with trusted HTTPS ingress, and a service account with write access only to artifact storage. Install `controller/` and `app/` as siblings under `/opt/yahahagame-controller`. Keep environment/credentials in protected `/opt/yahahagame-controller/config/`, outside source. Do not copy `key/`, `.local/`, `node_modules/` or worker data.

Configure the values from `deploy/controller.env.example`: `DATABASE_URL`, `PUBLIC_ORIGIN` (exact HTTPS origin, no trailing slash), `APP_ROOT`, `ARTIFACT_ROOT`, `MAX_USERS`, `BIND` and `PORT`. Neither `PHASE1_TOKEN` nor a shared controller `WORKER_TOKEN` is used. Each worker is enrolled separately.

For loopback development only, `ALLOW_INSECURE_LOCALHOST=true` permits an HTTP origin with loopback bind. For this explicitly bounded internal pilot, `ALLOW_INSECURE_HTTP=true` may be set with `PUBLIC_ORIGIN=http://139.224.32.61`; this disables Secure cookies and must not be treated as a public deployment configuration. The original `deploy/nginx/phase1.conf` port-80 site can proxy this pilot. Serve `/`, `/app.js` and `/app.css` from `app/` or proxy them to the API.

## Upgrade sequence

1. Back up source/config, PostgreSQL and artifacts. Stop new submissions and drain existing tool processes before stopping the old agent/API. Migration refuses legacy `RUNNING` jobs; reconcile actual execution instead of blindly changing their state.
2. Stage the complete controller/app directories and deploy the matching worker modules. Keep the existing systemd source/config/artifact permissions and do not overwrite the configured environment with the template.
3. In the controller directory, install runtime dependencies and run unit verification:

```bash
npm ci --omit=dev --ignore-scripts
npm run test:unit
```

4. With `DATABASE_URL` loaded from the protected environment, apply all versioned migrations:

```bash
npm run migrate
```

The runner records checksums in `schema_migrations`. Do not manually run `002_phase1_accounts.sql` or edit an applied migration. Historical pilot tasks remain unassigned to real users; the API excludes them. An explicit audited adoption tool is still pending.

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

6. Configure the trusted HTTPS virtual host and exact `PUBLIC_ORIGIN`, validate Nginx, restart `yahahagame-controller`, then start the protocol-2 worker. The existing systemd unit uses the controller entry point. Port 8080 and PostgreSQL remain private.

## Verification

Run full local integration tests with dev dependencies before packaging the release: `npm ci` then `npm test`. The suite starts an isolated native PostgreSQL instance; the deployment unit test command does not require those dev dependencies.

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
