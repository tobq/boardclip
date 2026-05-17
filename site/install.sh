#!/usr/bin/env sh
set -eu

REPO_URL="${CLIPPY_REPO_URL:-https://github.com/tobq/clippy.git}"
APP_DIR="${CLIPPY_APP_DIR:-$HOME/.local/share/clippy}"

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    echo "Install $1, then run this installer again." >&2
    exit 1
  fi
}

need git
need npm

if [ -d "$APP_DIR/.git" ]; then
  echo "Updating existing Clippy install in $APP_DIR"
  cd "$APP_DIR"
  git pull --rebase --autostash
else
  echo "Installing Clippy to $APP_DIR"
  mkdir -p "$(dirname "$APP_DIR")"
  git clone "$REPO_URL" "$APP_DIR"
  cd "$APP_DIR"
fi

npm install
chmod +x install.sh update.sh start.sh kill.sh 2>/dev/null || true
./start.sh

echo ""
echo "Clippy is running."
echo "Update later with:"
echo "  curl -fsSL https://clippy-sh.netlify.app/update.sh | sh"
