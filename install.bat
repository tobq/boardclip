@echo off
echo Installing BoardClip (Electron)...
cd /d "%~dp0"
call npm install
if errorlevel 1 exit /b 1
echo.
echo Creating Start Menu shortcut...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\create-windows-shortcut.ps1" -AppDir "%~dp0"
if errorlevel 1 (
  echo Warning: could not create Start Menu shortcut.
  cmd /c exit /b 0
)
echo.
echo Setting up auto-start...
:: Remove old Python startup shortcut if it exists
del "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\ClipboardTray.lnk" >nul 2>&1
del "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\clipboard-tray.lnk" >nul 2>&1
del "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\clipboard_numpad.lnk" >nul 2>&1
echo.
echo Done! Run start.bat to launch, or update.bat to pull latest and relaunch.
echo Auto-start can be toggled in Settings within the app.
exit /b 0
