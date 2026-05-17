$ErrorActionPreference = "Stop"

$AppDir = if ($env:CLIPPY_APP_DIR) { $env:CLIPPY_APP_DIR } else { Join-Path $env:LOCALAPPDATA "Clippy" }

if (-not (Test-Path (Join-Path $AppDir ".git"))) {
  throw "Clippy is not installed at $AppDir. Install it with: irm https://clippy-sh.netlify.app/install.ps1 | iex"
}

Set-Location $AppDir
& (Join-Path $AppDir "update.bat")
