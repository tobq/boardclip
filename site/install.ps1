$ErrorActionPreference = "Stop"

$RepoUrl = if ($env:CLIPPY_REPO_URL) { $env:CLIPPY_REPO_URL } else { "https://github.com/tobq/clippy.git" }
$AppDir = if ($env:CLIPPY_APP_DIR) { $env:CLIPPY_APP_DIR } else { Join-Path $env:LOCALAPPDATA "Clippy" }

function Need($Command) {
  if (-not (Get-Command $Command -ErrorAction SilentlyContinue)) {
    throw "Missing required command: $Command. Install it, then run this installer again."
  }
}

Need git
Need npm

if (Test-Path (Join-Path $AppDir ".git")) {
  Write-Host "Updating existing Clippy install in $AppDir"
  Set-Location $AppDir
  git pull --rebase --autostash
} else {
  Write-Host "Installing Clippy to $AppDir"
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $AppDir) | Out-Null
  git clone $RepoUrl $AppDir
  Set-Location $AppDir
}

npm install
& (Join-Path $AppDir "start.bat")

Write-Host ""
Write-Host "Clippy is running."
Write-Host "Update later with:"
Write-Host "  irm https://clippy-sh.netlify.app/update.ps1 | iex"
