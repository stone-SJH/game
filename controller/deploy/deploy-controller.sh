#!/usr/bin/env bash
set -Eeuo pipefail

ROOT='/opt/yahahagame-controller'
REMOTE='origin'
REF='main'
PUBLIC_ORIGIN_EXPECTED='http://139.224.32.61'
DRY_RUN=false
ORIGINAL_ARGS=("$@")

default_repo() {
  local deploy_user="${SUDO_USER:-${USER:-root}}"
  local deploy_home=''
  if command -v getent >/dev/null 2>&1; then
    deploy_home="$(getent passwd "$deploy_user" | cut -d: -f6 || true)"
  fi
  printf '%s/workspace/game' "${deploy_home:-$HOME}"
}

REPO="${GAME_REPO:-$(default_repo)}"

usage() {
  cat <<'EOF'
Usage: deploy-controller.sh [options]

The source is a Git worktree. The script fetches the configured remote,
fast-forwards the checked-out branch, and deploys only Git-tracked files.

Options:
  --repo PATH            Git worktree (default: ~/workspace/game)
  --remote NAME          Git remote to fetch (default: origin)
  --ref BRANCH           Local branch and remote branch to deploy (default: main)
  --root PATH            Controller installation root (default: /opt/yahahagame-controller)
  --public-origin URL    Expected PUBLIC_ORIGIN (default: http://139.224.32.61)
  --dry-run              Fetch and validate Git; leave HEAD, files and service unchanged
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo) REPO="${2:?--repo requires a path}"; shift 2 ;;
    --remote) REMOTE="${2:?--remote requires a name}"; shift 2 ;;
    --ref) REF="${2:?--ref requires a branch}"; shift 2 ;;
    --root) ROOT="${2:?--root requires a path}"; shift 2 ;;
    --public-origin) PUBLIC_ORIGIN_EXPECTED="${2:?--public-origin requires a URL}"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

command -v git >/dev/null

REPO="$(cd "$REPO" 2>/dev/null && pwd -P)" || {
  echo "Git repository not found: $REPO" >&2
  exit 5
}
REPO_TOP="$(git -C "$REPO" rev-parse --show-toplevel 2>/dev/null)" || {
  echo "Not a Git worktree: $REPO" >&2
  exit 5
}
REPO_TOP="$(cd "$REPO_TOP" && pwd -P)"
if [ "$REPO_TOP" != "$REPO" ]; then
  echo "--repo must point to the Git worktree root: $REPO_TOP" >&2
  exit 5
fi

CURRENT_BRANCH="$(git -C "$REPO" symbolic-ref --quiet --short HEAD || true)"
if [ "$CURRENT_BRANCH" != "$REF" ]; then
  echo "Expected checked-out branch '$REF', found '${CURRENT_BRANCH:-detached HEAD}'." >&2
  echo "Check out the deployment branch before running this script." >&2
  exit 6
fi

REMOTE_URL="$(git -C "$REPO" remote get-url "$REMOTE" 2>/dev/null)" || {
  echo "Git remote not found: $REMOTE" >&2
  exit 6
}
LOCAL_STATUS="$(git -C "$REPO" status --porcelain --untracked-files=all)"
if [ -n "$LOCAL_STATUS" ]; then
  echo 'Refusing deployment because the Git worktree has local changes:' >&2
  git -C "$REPO" status --short >&2
  echo 'Commit intentional deployment changes before updating from the remote.' >&2
  exit 7
fi

git check-ref-format "refs/heads/$REF" >/dev/null
echo "Fetching $REMOTE_URL ($REMOTE/$REF)" >&2
git -C "$REPO" fetch --prune "$REMOTE" "refs/heads/$REF:refs/remotes/$REMOTE/$REF"
LOCAL_HEAD="$(git -C "$REPO" rev-parse HEAD)"
REMOTE_HEAD="$(git -C "$REPO" rev-parse "refs/remotes/$REMOTE/$REF")"
SOURCE_COMMIT="$LOCAL_HEAD"
if git -C "$REPO" merge-base --is-ancestor "$LOCAL_HEAD" "$REMOTE_HEAD"; then
  SOURCE_COMMIT="$REMOTE_HEAD"
elif ! git -C "$REPO" merge-base --is-ancestor "$REMOTE_HEAD" "$LOCAL_HEAD"; then
  echo "Local commits and $REMOTE/$REF have diverged. Merge the remote branch, resolve conflicts and commit before deploying." >&2
  exit 8
fi
SOURCE_COMMIT_SHORT="$(git -C "$REPO" rev-parse --short "$SOURCE_COMMIT")"

if [ "$DRY_RUN" = true ]; then
  echo "Would deploy $REF at $SOURCE_COMMIT_SHORT ($SOURCE_COMMIT)." >&2
  echo 'Git validation complete; remote refs fetched, local HEAD/worktree and service unchanged. Runtime and task checks run on deployment.' >&2
  exit 0
fi

if [ "$(id -u)" -ne 0 ]; then echo 'Run this script as root.' >&2; exit 3; fi
command -v psql >/dev/null
command -v pg_dump >/dev/null
command -v nginx >/dev/null
command -v curl >/dev/null
command -v tar >/dev/null

if [ "$LOCAL_HEAD" != "$SOURCE_COMMIT" ]; then
  git -C "$REPO" merge --ff-only "$SOURCE_COMMIT"
  # A remote update may change this script too. Run the updated entry point.
  exec bash "$REPO/controller/deploy/deploy-controller.sh" "${ORIGINAL_ARGS[@]}"
fi
echo "Deploying $REF at $SOURCE_COMMIT_SHORT ($SOURCE_COMMIT)" >&2

# sudo commonly supplies the distro Node/npm pair. Keep node and npm from the
# same installation and require the version supported by the controller.
NODE_BIN=''
for candidate in /usr/local/bin/node /usr/bin/node; do
  if [ -x "$candidate" ] && "$candidate" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' >/dev/null 2>&1; then
    NODE_BIN="$candidate"
    break
  fi
done
if [ -z "$NODE_BIN" ]; then
  echo 'Node.js >= 20 is required (checked /usr/local/bin/node and /usr/bin/node).' >&2
  exit 4
fi
NPM_BIN="$(dirname "$NODE_BIN")/npm"
if [ ! -x "$NPM_BIN" ]; then
  echo "npm matching $NODE_BIN was not found at $NPM_BIN." >&2
  exit 4
fi
NODE_MAJOR="$($NODE_BIN -p 'process.versions.node.split(".")[0]')"
export PATH="$(dirname "$NODE_BIN"):$PATH"
echo "Using $NODE_BIN (Node $NODE_MAJOR) and $NPM_BIN" >&2

if [ "$ROOT" = '/opt/yahahagame-controller' ] && [ -d /opt/stone-controller ] && {
  [ ! -d "$ROOT" ] || [ -z "$(find "$ROOT" -mindepth 1 -print -quit 2>/dev/null)" ];
}; then
  if [ -d "$ROOT" ]; then
    mv "$ROOT" "${ROOT}.empty.$(date +%Y%m%d-%H%M%S)"
  fi
  mkdir -p "$(dirname "$ROOT")"
  mv /opt/stone-controller "$ROOT"
  echo "Migrated existing controller root to $ROOT"
fi

ENV_FILE="$ROOT/config/controller.env"
test -f "$ENV_FILE"
set -a
. "$ENV_FILE"
set +a
test "${PUBLIC_ORIGIN:-}" = "$PUBLIC_ORIGIN_EXPECTED"
test "${ALLOW_INSECURE_HTTP:-false}" = 'true'

ACTIVE=0
if [ "$(psql "$DATABASE_URL" -Atqc "SELECT to_regclass('public.tasks') IS NOT NULL;")" = 't' ]; then
  ACTIVE=$(psql "$DATABASE_URL" -Atqc "SELECT count(*) FROM public.tasks WHERE status IN ('RUNNING','CANCELING','RECOVERING');")
fi
ALLOCATIONS=0
if [ "$(psql "$DATABASE_URL" -Atqc "SELECT to_regclass('public.worker_allocations') IS NOT NULL;")" = 't' ]; then
  ALLOCATIONS=$(psql "$DATABASE_URL" -Atqc "SELECT count(*) FROM public.worker_allocations WHERE released_at IS NULL;")
fi
if [ "$ACTIVE" != '0' ] || [ "$ALLOCATIONS" != '0' ]; then
  echo "Refusing deployment: active tasks=$ACTIVE unreleased_allocations=$ALLOCATIONS" >&2
  exit 20
fi

if ! id -u yahahagame-controller >/dev/null 2>&1; then
  useradd --system --home-dir /nonexistent --shell /usr/sbin/nologin yahahagame-controller
fi
# ARTIFACT_ROOT may live below a legacy stone-controller directory. The
# service user must be able to traverse that parent for mkdir to work.
ARTIFACT_PARENT="$(dirname "$ARTIFACT_ROOT")"
install -d -o root -g yahahagame-controller -m 0750 "$ARTIFACT_PARENT"
install -d -o yahahagame-controller -g yahahagame-controller "$ARTIFACT_ROOT"
chmod 0750 "$ARTIFACT_ROOT"
chown -R yahahagame-controller:yahahagame-controller "$ARTIFACT_ROOT"

STAMP=$(date +%Y%m%d-%H%M%S)
RELEASE="$ROOT/releases/$STAMP"
BACKUP="$ROOT/backups/$STAMP"
mkdir -p "$ROOT/releases" "$ROOT/backups" "$RELEASE" "$BACKUP" /var/backups/yahahagame
pg_dump "$DATABASE_URL" > "/var/backups/yahahagame/controller-$STAMP.sql"
tar -C "$ARTIFACT_ROOT" -czf "/var/backups/yahahagame/artifacts-$STAMP.tgz" .

# Export the immutable commit, including local deployment commits. Later edits
# in the operator's worktree cannot change the release recorded below.
git -C "$REPO" archive --format=tar "$SOURCE_COMMIT" | tar -xf - -C "$RELEASE"
cat > "$RELEASE/deployment-metadata.txt" <<EOF
repository=$REMOTE_URL
remote=$REMOTE
ref=$REF
commit=$SOURCE_COMMIT
deployed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
worktree_status=clean
EOF
git -C "$REPO" status --short --branch > "$BACKUP/repository-status.txt"

cd "$RELEASE/controller"
"$NPM_BIN" ci --omit=dev --ignore-scripts
"$NPM_BIN" run migrate

systemctl stop yahahagame-controller.service 2>/dev/null || true
systemctl stop stone-controller.service 2>/dev/null || true
systemctl disable stone-controller.service 2>/dev/null || true
if [ -d "$ROOT/controller" ]; then mv "$ROOT/controller" "$BACKUP/controller"; fi
if [ -d "$ROOT/app" ]; then mv "$ROOT/app" "$BACKUP/app"; fi
mv "$RELEASE/controller" "$ROOT/controller"
mv "$RELEASE/app" "$ROOT/app"

install -m 0644 "$ROOT/controller/deploy/systemd/yahahagame-controller.service" /etc/systemd/system/yahahagame-controller.service

# The legacy deployment may use the same port-80 default server. Preserve its
# config but remove enabled links before validating the new site.
NGINX_BACKUP="$BACKUP/nginx"
mkdir -p "$NGINX_BACKUP"
for old_site in /etc/nginx/sites-enabled/stone-controller /etc/nginx/sites-enabled/default; do
  if [ -e "$old_site" ] || [ -L "$old_site" ]; then
    mv "$old_site" "$NGINX_BACKUP/$(basename "$old_site")"
  fi
done
install -m 0644 "$ROOT/controller/deploy/nginx/phase1.conf" /etc/nginx/sites-enabled/yahahagame.conf

# Adapt the unit to the validated host-specific Node and artifact paths.
sed -i "s#^ExecStart=.*#ExecStart=$NODE_BIN $ROOT/controller/api/server.mjs#" /etc/systemd/system/yahahagame-controller.service
sed -i "s#^WorkingDirectory=.*#WorkingDirectory=$ROOT/controller#; s#^EnvironmentFile=.*#EnvironmentFile=$ROOT/config/controller.env#" /etc/systemd/system/yahahagame-controller.service
sed -i "s#^ReadWritePaths=.*#ReadWritePaths=$ARTIFACT_ROOT#" /etc/systemd/system/yahahagame-controller.service
sed -i "s#/opt/yahahagame-controller/app#$ROOT/app#g" /etc/nginx/sites-enabled/yahahagame.conf
nginx -t
systemctl daemon-reload
systemctl enable --now yahahagame-controller.service
systemctl reload nginx

for _ in $(seq 1 30); do
  if curl --fail --silent http://127.0.0.1:8080/healthz >/dev/null; then
    echo "Controller deployment completed: $STAMP ($SOURCE_COMMIT_SHORT)"
    exit 0
  fi
  sleep 1
done

echo 'Controller health check failed. Previous code is retained in the backup directory.' >&2
systemctl status yahahagame-controller.service --no-pager || true
exit 21
