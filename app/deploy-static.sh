#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${FRONTEND_ROOT:-/opt/yahahagame-controller}"
REPO="${GAME_REPO:-$(git rev-parse --show-toplevel 2>/dev/null || true)}"

if [ -z "$REPO" ] || [ ! -d "$REPO/.git" ]; then
  echo "A Git worktree is required. Set GAME_REPO." >&2
  exit 5
fi
REPO="$(cd "$REPO" && pwd -P)"
if [ "$(git -C "$REPO" status --porcelain --untracked-files=all)" ]; then
  echo 'Refusing static deployment because the Git worktree has local changes.' >&2
  git -C "$REPO" status --short >&2
  exit 7
fi
if [ "$(git -C "$REPO" symbolic-ref --quiet --short HEAD || true)" != 'main' ]; then
  echo 'Static deployment requires the main branch.' >&2
  exit 6
fi
if [ "$(id -u)" -ne 0 ]; then
  echo 'Run this script as root.' >&2
  exit 3
fi

SOURCE_COMMIT="$(git -C "$REPO" rev-parse HEAD)"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="$ROOT/backups/frontend-$STAMP"
TEMP="$ROOT/.frontend-release-$STAMP"
mkdir -p "$ROOT/backups" "$BACKUP"
trap 'rm -rf "$TEMP"' EXIT

mkdir "$TEMP"
git -C "$REPO" archive --format=tar "$SOURCE_COMMIT" app | tar -xf - -C "$TEMP"
test -f "$TEMP/app/index.html"
test -f "$TEMP/app/app.js"
test -f "$TEMP/app/app.css"
mv "$ROOT/app" "$BACKUP/app.previous"
if ! mv "$TEMP/app" "$ROOT/app"; then
  mv "$BACKUP/app.previous" "$ROOT/app"
  echo 'Failed to activate the new frontend; previous frontend restored.' >&2
  exit 21
fi
chown -R root:root "$ROOT/app"
find "$ROOT/app" -type f -exec chmod 0644 {} +
find "$ROOT/app" -type d -exec chmod 0755 {} +
printf 'Frontend deployment completed: %s (%s)\n' "$STAMP" "$SOURCE_COMMIT"
printf 'Controller service was not restarted. Previous frontend: %s\n' "$BACKUP/app.previous"
