#!/usr/bin/env sh
set -eu

APP_DIR="${CLIPPY_APP_DIR:-$HOME/.local/share/clippy}"

if [ ! -d "$APP_DIR/.git" ]; then
  echo "Clippy is not installed at $APP_DIR." >&2
  echo "Install it with:" >&2
  echo "  curl -fsSL https://clippy-sh.netlify.app/install.sh | sh" >&2
  exit 1
fi

cd "$APP_DIR"
./update.sh
