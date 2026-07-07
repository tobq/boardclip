@echo off
setlocal

set "ELECTRON_EXE=%~dp0node_modules\electron\dist\electron.exe"

:: Kill only the Electron processes that belong to this checkout, then wait
:: until Windows has actually removed them from the process table. EXCLUDE the
:: MCP helper (same electron.exe, distinguished by the boardclip-mcp.js entry on
:: its command line): it is spawned + owned by an AI client (Forge/Claude/Codex),
:: not by us, and killing it here would leave that client with a dead MCP handle
:: that only recovers on its next reconnect. Uses Get-CimInstance because
:: Get-Process cannot see the command line.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$target = [IO.Path]::GetFullPath($env:ELECTRON_EXE); $deadline = (Get-Date).AddSeconds(10); while ($true) { $running = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq 'electron.exe' -and $_.ExecutablePath -and ($_.CommandLine -notlike '*boardclip-mcp.js*') -and $(try { [IO.Path]::GetFullPath($_.ExecutablePath) -ieq $target } catch { $false }) }); if ($running.Count -eq 0) { exit 0 }; $running | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; if ((Get-Date) -ge $deadline) { exit 1 }; Start-Sleep -Milliseconds 500 }" 2>nul
if errorlevel 1 (
  echo ERROR: Failed to stop BoardClip.
  exit /b 1
)

echo BoardClip stopped.
