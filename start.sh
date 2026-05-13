#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

ELECTRON_PATTERN="$SCRIPT_DIR/node_modules/electron"
ELECTRON_APP="$SCRIPT_DIR/node_modules/electron/dist/Electron.app"
ELECTRON_BIN="$SCRIPT_DIR/node_modules/electron/dist/electron"

# Kill any existing instance and verify
./kill.sh

# Double check nothing left
if pgrep -f "$ELECTRON_PATTERN" >/dev/null 2>&1; then
  echo "ERROR: Failed to kill existing instance. Aborting."
  exit 1
fi

# Start in background
if [ "$(uname)" = "Darwin" ] && [ -d "$ELECTRON_APP" ]; then
  open -na "$ELECTRON_APP" --args "$SCRIPT_DIR"
  echo "Clipboard tray started."
elif [ -x "$ELECTRON_BIN" ]; then
  nohup "$ELECTRON_BIN" "$SCRIPT_DIR" > /dev/null 2>&1 &
  echo "Clipboard tray started (PID $!)."
else
  echo "Electron is not installed. Run install.sh first."
  exit 1
fi

sleep 0.5
if ! pgrep -f "$ELECTRON_PATTERN" >/dev/null 2>&1; then
  echo "ERROR: Failed to start clipboard tray."
  exit 1
fi
