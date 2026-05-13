#!/bin/bash
set -e

cd "$(dirname "$0")"

echo "Updating clipboard-tray..."

before="$(git rev-parse HEAD 2>/dev/null || true)"
git pull --rebase --autostash
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

./start.sh
echo "Update complete."
