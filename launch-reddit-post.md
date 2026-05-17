# Draft Reddit Post

Title options:

- I built Clippy: a tiny cross-platform clipboard history tray app
- Clippy: local-first clipboard history with quick-paste slots and native cloud sync
- I made a clipboard tray app because I kept reusing the same snippets all day

Post:

Hey r/SideProject,

I built Clippy, a small cross-platform clipboard history app that lives in your system tray.

The main thing I wanted was a clipboard tool that felt fast for repeated daily use rather than like a giant notes/database app. It opens at your cursor, lets you search immediately, and supports numpad quick-paste slots for snippets you use constantly.

What it does:

- Text and image clipboard history
- Search + regex search
- Pinning and custom groups
- Numpad quick-paste slots 1-9
- Local-first storage
- Native cloud-folder sync through Google Drive, OneDrive, and iCloud
- macOS and Windows support

Install:

```sh
curl -fsSL https://clippy-sh.netlify.app/install.sh | sh
```

Windows:

```powershell
irm https://clippy-sh.netlify.app/install.ps1 | iex
```

GitHub: https://github.com/tobq/clippy
Site: https://clippy-sh.netlify.app

It is an Electron app, mostly because I wanted a tiny tray UI plus platform-specific shortcut behavior without building two totally separate apps. The Windows implementation uses a low-level keyboard hook so Win+V can open Clippy instead of the default Windows clipboard history.

Would love feedback, especially from people who live in terminals/editors and reuse lots of snippets.
