param(
  [string]$AppDir
)

$ErrorActionPreference = "Stop"

if (-not $IsWindows -and $env:OS -ne "Windows_NT") {
  exit 0
}

if (-not $AppDir) {
  $AppDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
} else {
  $AppDir = (Resolve-Path $AppDir).Path
}
$StartBat = Join-Path $AppDir "start.bat"
if (-not (Test-Path $StartBat)) {
  throw "Cannot create BoardClip shortcut: missing $StartBat"
}

$LauncherPath = Join-Path $AppDir "BoardClip.vbs"
$Launcher = @"
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
appDir = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = appDir
shell.Run """" & appDir & "\start.bat" & """", 0, False
"@
Set-Content -Path $LauncherPath -Value $Launcher -Encoding ASCII

$ProgramsDir = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"
New-Item -ItemType Directory -Force -Path $ProgramsDir | Out-Null

foreach ($Name in @("ClipboardTray.lnk", "clipboard-tray.lnk", "clipboard_numpad.lnk", "Clipboard Tray.lnk")) {
  Remove-Item (Join-Path $ProgramsDir $Name) -Force -ErrorAction SilentlyContinue
}

$ShortcutPath = Join-Path $ProgramsDir "BoardClip.lnk"
$WScript = Join-Path $env:SystemRoot "System32\wscript.exe"
$Shell = New-Object -ComObject WScript.Shell
$Shortcut = $Shell.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = $WScript
$Shortcut.Arguments = "`"$LauncherPath`""
$Shortcut.WorkingDirectory = $AppDir
$Shortcut.Description = "BoardClip clipboard history"

$AppIcon = Join-Path $AppDir "assets\boardclip-icon.ico"
if (Test-Path $AppIcon) {
  $Shortcut.IconLocation = "$AppIcon,0"
}

$Shortcut.Save()
Write-Host "Created Start Menu shortcut: $ShortcutPath"
