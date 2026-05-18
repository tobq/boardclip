#!/bin/bash
set -e

cd "$(dirname "$0")"

echo "Updating BoardClip..."

before="$(git rev-parse HEAD 2>/dev/null || true)"
dirty="$(git status --porcelain --untracked-files=no 2>/dev/null || true)"
if [ -n "$dirty" ] && [ "${BOARDCLIP_UPDATE_ALLOW_DIRTY:-}" != "1" ]; then
  echo "Refusing to update because tracked app files have local changes." >&2
  echo "Runtime data files are ignored and do not block updates." >&2
  echo "Commit/stash/revert local code changes, or rerun with:" >&2
  echo "  BOARDCLIP_UPDATE_ALLOW_DIRTY=1 ./update.sh" >&2
  exit 1
fi

if [ "${BOARDCLIP_UPDATE_ALLOW_DIRTY:-}" = "1" ]; then
  git pull --rebase --autostash
else
  git pull --ff-only
fi
after="$(git rev-parse HEAD 2>/dev/null || true)"

need_install=0
if [ ! -x "node_modules/electron/dist/electron" ] &&
   [ ! -x "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" ] &&
   [ ! -f "node_modules/electron/dist/electron.exe" ]; then
  need_install=1
fi

if [ -n "$before" ] && [ -n "$after" ] && [ "$before" != "$after" ]; then
  if git diff --name-only "$before" "$after" -- package.json package-lock.json | grep -q .; then
    need_install=1
  fi
fi

if [ "$need_install" = "1" ]; then
  echo "Installing dependencies..."
  npm install
else
  echo "Dependencies unchanged."
fi

if ! sh scripts/create-macos-launcher.sh "$(pwd)"; then
  echo "Warning: could not create macOS Applications launcher." >&2
fi

if [ "${BOARDCLIP_UPDATE_NO_START:-}" = "1" ]; then
  echo "Update applied."
  exit 0
fi

./start.sh
echo "Update complete."
