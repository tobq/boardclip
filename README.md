# BoardClip

Fast cross-platform clipboard history for desktop. BoardClip runs as a tray app, opens with a global shortcut, and keeps your useful text and image clips searchable, pinnable, and quick to paste.

## Install

Everyday desktop builds are available from the website:

[Download BoardClip](https://boardclip.app)

Terminal install keeps a source checkout on your machine and reuses the same local lifecycle scripts for future updates.

macOS / Linux:

```sh
curl -fsSL https://boardclip.sh/install.sh | sh
```

Windows PowerShell:

```powershell
irm https://boardclip.sh/install.ps1 | iex
```

Prefer to inspect first? Open the script URL in your browser, or download it before running:

```sh
curl -fsSLO https://boardclip.sh/install.sh
sh install.sh
```

## Update

macOS / Linux:

```sh
curl -fsSL https://boardclip.sh/update.sh | sh
```

Windows PowerShell:

```powershell
irm https://boardclip.sh/update.ps1 | iex
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
- Local-first data: no hosted clipboard database or BoardClip account.

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

Build desktop binaries locally:

```sh
npm run dist
```

Platform-specific package scripts are available as `npm run dist:win`, `npm run dist:mac`, and `npm run dist:linux`. Tagged releases matching `v*` are built by GitHub Actions and attached to the GitHub release.

Regenerate the shared app, tray, installer, and site icons:

```sh
npm run sync:icons
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

BoardClip stores data in the app checkout:

- `clipboard-history.json`
- `clipboard-settings.json`
- `clipboard-images/`

Cloud sync writes the same files into detected provider folders under `clipboard-tray/`. That folder name is retained for compatibility with earlier installs.

## Contributing

Issues and pull requests are welcome. Please run `npm test` before opening a PR and keep changes focused; most behavior should go through shared helpers in `lib/clipboard-model.js` instead of duplicating merge logic in UI or IPC code.

## License

MIT
