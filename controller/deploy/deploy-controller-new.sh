#!/usr/bin/env bash
set -Eeuo pipefail

ROOT='/opt/yahahagame-controller'
BUNDLE=''
PUBLIC_ORIGIN_EXPECTED='http://139.224.32.61'

usage() {
  cat <<'EOF'
Usage: deploy-controller.sh --bundle /path/to/yahahagame-release.tgz [options]

Options:
  --bundle PATH          Release bundle containing app/, controller/, worker/, skills/
  --root PATH            Controller installation root (default: /opt/yahahagame-controller)
  --public-origin URL    Expected PUBLIC_ORIGIN (default: http://139.224.32.61)
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --bundle) BUNDLE="${2:?--bundle requires a path}"; shift 2 ;;
    --root) ROOT="${2:?--root requires a path}"; shift 2 ;;
    --public-origin) PUBLIC_ORIGIN_EXPECTED="${2:?--public-origin requires a URL}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [ -z "$BUNDLE" ]; then usage >&2; exit 2; fi
if [ "$(id -u)" -ne 0 ]; then echo 'Run this script as root.' >&2; exit 3; fi
test -f "$BUNDLE"
command -v psql >/dev/null
command -v pg_dump >/dev/null
command -v nginx >/dev/null
command -v curl >/dev/null

# sudo commonly supplies the distro Node/npm pair. On this host that pair is
# Node 12 plus a broken system npm, while the deployed controller requires
# Node 20+. Keep node and npm from the same installation.
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
install -d -o yahahagame-controller -g yahahagame-controller "$ARTIFACT_ROOT"
chown -R yahahagame-controller:yahahagame-controller "$ARTIFACT_ROOT"

STAMP=$(date +%Y%m%d-%H%M%S)
RELEASE="$ROOT/releases/$STAMP"
BACKUP="$ROOT/backups/$STAMP"
mkdir -p "$ROOT/releases" "$ROOT/backups" "$RELEASE" "$BACKUP" /var/backups/yahahagame
pg_dump "$DATABASE_URL" > "/var/backups/yahahagame/controller-$STAMP.sql"
tar -C "$ARTIFACT_ROOT" -czf "/var/backups/yahahagame/artifacts-$STAMP.tgz" .

tar -xzf "$BUNDLE" -C "$RELEASE"
cd "$RELEASE/controller"
"$NPM_BIN" ci --omit=dev --ignore-scripts
"$NPM_BIN" run migrate

systemctl stop yahahagame-controller.service 2>/dev/null || true
systemctl stop stone-controller.service 2>/dev/null || true
if [ -d "$ROOT/controller" ]; then mv "$ROOT/controller" "$BACKUP/controller"; fi
if [ -d "$ROOT/app" ]; then mv "$ROOT/app" "$BACKUP/app"; fi
mv "$RELEASE/controller" "$ROOT/controller"
mv "$RELEASE/app" "$ROOT/app"

install -m 0644 "$ROOT/controller/deploy/systemd/yahahagame-controller.service" /etc/systemd/system/yahahagame-controller.service

# The legacy deployment uses the same port-80 default server. Preserve its
# config but remove the enabled link before validating the new site.
NGINX_BACKUP="$BACKUP/nginx"
mkdir -p "$NGINX_BACKUP"
for old_site in /etc/nginx/sites-enabled/stone-controller /etc/nginx/sites-enabled/default; do
  if [ -e "$old_site" ] || [ -L "$old_site" ]; then
    mv "$old_site" "$NGINX_BACKUP/$(basename "$old_site")"
  fi
done
install -m 0644 "$ROOT/controller/deploy/nginx/phase1.conf" /etc/nginx/sites-enabled/yahahagame.conf
# The release template assumes /usr/bin/node. Use the validated Node binary
# selected above when the host keeps Node under /usr/local/bin.
sed -i "s#^ExecStart=.*#ExecStart=$NODE_BIN $ROOT/controller/api/server.mjs#" /etc/systemd/system/yahahagame-controller.service
sed -i "s#^ReadWritePaths=.*#ReadWritePaths=$ARTIFACT_ROOT#" /etc/systemd/system/yahahagame-controller.service
nginx -t
systemctl daemon-reload
systemctl enable --now yahahagame-controller.service
systemctl reload nginx

for _ in $(seq 1 30); do
  if curl --fail --silent http://127.0.0.1:8080/healthz >/dev/null; then
    rm -f "$BUNDLE"
    echo "Controller deployment completed: $STAMP"
    exit 0
  fi
  sleep 1
done

echo 'Controller health check failed. Previous code is retained in the backup directory.' >&2
systemctl status yahahagame-controller.service --no-pager || true
exit 21
