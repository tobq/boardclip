#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Select Electron PIDs from THIS checkout, EXCLUDING the MCP helper (same electron
# binary, distinguished by the boardclip-mcp.js entry on its command line): it is
# spawned + owned by an AI client (Forge/Claude/Codex), not by us, and killing it
# here would leave that client with a dead MCP handle until its next reconnect.
app_electron_pids() {
  ps -Ao pid=,command= 2>/dev/null \
    | grep -F "$SCRIPT_DIR/node_modules/electron" \
    | grep -v 'boardclip-mcp.js' \
    | awk '{print $1}'
}

if command -v ps &>/dev/null; then
  pids="$(app_electron_pids)"
  [ -n "$pids" ] && kill -9 $pids 2>/dev/null
  # Also kill any node process launched from our dir (build watchers etc.), same exclusion.
  npids="$(ps -Ao pid=,command= 2>/dev/null | grep -E "node.*$SCRIPT_DIR" | grep -v 'boardclip-mcp.js' | awk '{print $1}')"
  [ -n "$npids" ] && kill -9 $npids 2>/dev/null
else
  taskkill //F //IM "electron.exe" 2>/dev/null
fi

# Wait and verify
sleep 0.5
if [ -n "$(app_electron_pids)" ]; then
  echo "Warning: some processes still running, force killing..."
  kill -9 $(app_electron_pids) 2>/dev/null
  sleep 0.5
fi

echo "BoardClip stopped."
