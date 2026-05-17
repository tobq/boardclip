# Clippy

Fast cross-platform clipboard history for desktop. Clippy runs as a tray app, opens with a global shortcut, and keeps your useful text and image clips searchable, pinnable, and quick to paste.

## Install

macOS / Linux:

```sh
curl -fsSL https://clippy-sh.netlify.app/install.sh | sh
```

Windows PowerShell:

```powershell
irm https://clippy-sh.netlify.app/install.ps1 | iex
```

Prefer to inspect first? Open the script URL in your browser, or download it before running:

```sh
curl -fsSLO https://clippy-sh.netlify.app/install.sh
sh install.sh
```

## Update

macOS / Linux:

```sh
curl -fsSL https://clippy-sh.netlify.app/update.sh | sh
```

Windows PowerShell:

```powershell
irm https://clippy-sh.netlify.app/update.ps1 | iex
```

Local checkout update scripts are also available:

```sh
./update.sh
```

```bat
update.bat
```

## Features

- Hotkey popup: Cmd+Shift+V on macOS, Win+V on Windows.
- Text and image history with automatic deduplication.
- Numpad quick-paste slots 1-9 for snippets you reuse constantly.
- Pins and groups for keeping durable clips organized.
- Native cloud sync through Google Drive, OneDrive, and iCloud folders.
- Regex search, external editor support, and image export.
- Local-first data: no hosted clipboard database or Clippy account.

## Keyboard Shortcuts

| Shortcut | Action |
| --- | --- |
| Cmd+Shift+V / Win+V | Toggle popup |
| Cmd+Numpad 1-9 / Win+Numpad 1-9 | Quick-paste slot |
| 1-9 in empty search | Quick-paste slot |
| Arrow keys | Navigate items |
| Enter | Paste selected item |
| Escape | Close popup |

## Development

Requirements:

- Git
- Node.js and npm

Run from a checkout:

```sh
npm install
npm test
npm start
```

Useful local scripts:

```sh
./start.sh
./update.sh
./kill.sh
```

```bat
start.bat
update.bat
kill.bat
```

## Project Structure

- `main.js`: Electron main process, tray, shortcuts, clipboard polling, sync, IPC.
- `index.html`: single-file renderer UI.
- `preload.js`: safe renderer API bridge.
- `lib/clipboard-model.js`: shared pure history/pin/group merge logic.
- `lib/cloud-accounts.js`: Google Drive, OneDrive, and iCloud folder discovery.
- `lib/windows-hook*`: Windows low-level keyboard hook for Win+V / Win+Numpad.
- `site/`: static landing page and remote install/update scripts.

## Data

Clippy stores data in the app checkout:

- `clipboard-history.json`
- `clipboard-settings.json`
- `clipboard-images/`

Cloud sync writes the same files into detected provider folders under `clipboard-tray/`. That folder name is retained for compatibility with earlier installs.

## Contributing

Issues and pull requests are welcome. Please run `npm test` before opening a PR and keep changes focused; most behavior should go through shared helpers in `lib/clipboard-model.js` instead of duplicating merge logic in UI or IPC code.

## License

MIT
