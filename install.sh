#!/bin/bash
set -e

echo "Installing BoardClip (Electron)..."
cd "$(dirname "$0")"
npm install
echo ""
if ! sh scripts/create-macos-launcher.sh "$(pwd)"; then
  echo "Warning: could not create macOS Applications launcher." >&2
fi
echo ""
echo "Done! Run ./start.sh to launch, or ./update.sh to pull latest and relaunch."
echo "Auto-start can be toggled in Settings within the app."
