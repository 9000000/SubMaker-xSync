# SubMaker xSync

SubMaker xSync is a Chrome/Edge (MV3) companion extension for the SubMaker Stremio addon. It helps your Subtitles workflows by extracting audio from Stremio streams, syncing subtitles with FFmpeg/ALASS/ffsubsync, and exposing quick controls via the popup and options pages.

## Features
- Automatic subtitle sync when SubMaker pages are detected (config, toolbox, sync page)
- MV3-friendly bootstrap + heavy service worker with lazy-loaded WASM (FFmpeg, ALASS, ffsubsync, Whisper/Vosk)
- Popup dashboard with live status, quick links, and factory-reset
- Options page for auto-sync, ALASS preference, concurrency, fallback behaviour, quiet mode, notifications, and link capture
- Offscreen document pipeline for media processing and chunked result transfer

## Install (Load Unpacked)
1. Open `chrome://extensions` (or Edge: `edge://extensions`) and enable **Developer mode**.
2. Click **Load unpacked** and select this folder.
3. Open the popup to verify the version and status; capture your SubMaker Configure/Toolbox links once so xSync remembers them.

## Permissions
- `storage`, `offscreen`;
- Host access: `http://*/*`, `https://*/*` (needed to detect SubMaker pages and exchange data)

## How It Works
- `background.bootstrap.js` preloads the heavy worker early so MV3 startup stays fast while exposing status to the popup.
- `background.full.js` coordinates extraction/alignment, manages offscreen documents, and streams large results in chunks.
- `scripts/content/content.js` bridges SubMaker pages and the background worker, tracks pending extract responses, and normalizes config/toolbox URLs.
- UI surfaces: popup (`pages/popup`), options (`pages/options`), and offscreen (`pages/offscreen`), with shared theme bootstrapping in `scripts/shared/theme-boot.js`.

## Project Layout
- `manifest.json` — MV3 manifest (v1.0.1), default locale `en`.
- `_locales/` — English and Spanish strings for UI/manifest.
- `background.bootstrap.js` / `background.full.js` — service worker entry and heavy logic.
- `scripts/content/` — content script for SubMaker pages.
- `pages/` — popup, options, offscreen pages and assets.
- `assets/lib/` — WASM/libs (FFmpeg, ALASS, ffsubsync, Whisper, Vosk); `assets/models/` includes the Vosk model archive.
- `assets/icons/`, `assets/*.png` — branding and screenshots.

## Notes
- Large binaries are included (e.g., Vosk model ~41MB, FFmpeg/ALASS/ffsubsync WASM). Git LFS is not required; files are under GitHub’s 100MB limit.
- Line endings are normalized via `.gitattributes` (LF for sources, CRLF for Windows scripts). `.gitignore` already excludes env keys, caches, build outputs, and editor files.

## Development
This repo is prebuilt for MV3. If you need to package it, zip the folder (including assets/lib and assets/models) and load as an unpacked extension or upload to the Web Store.
