# Native app build (iOS / iPadOS / macOS)

This branch (`app`) is a working area for wrapping the pAInapple Code web client as a native app for **iOS, iPadOS, and macOS** using [Tauri v2](https://v2.tauri.app/).

> Status: exploratory. Nothing here ships yet.
>
> For the reasoning behind picking Tauri over Capacitor + Electron, see **`CAPACITOR-VS-TAURI.md`**.

## Why Tauri v2

- One framework covers iOS, iPadOS, macOS (and Android, Windows, Linux if we ever want them).
- Uses the OS native WebView on every target — WKWebView on macOS *and* iOS, so behaviour is consistent across the Apple line.
- Bundles are small (~3–15 MB vs Electron's ~80–150 MB) and idle RAM is modest — matters because our audience runs Docker, terminals, Claude Code, and notices bloat.
- Plugin set we actually need (filesystem, dialog, deep-link, notifications, store) is covered by official plugins.
- Tauri v2 mobile is stable as of October 2024.

The alternative — Capacitor for mobile + Electron for desktop — was ruled out primarily because `@capacitor-community/electron` is unmaintained, which would force a split codebase (Capacitor mobile + standalone Electron, or Capacitor + Mac Catalyst with its own quirks). Full reasoning in `CAPACITOR-VS-TAURI.md`.

## What the app actually is

The native app is a **thin client**, not a self-contained product:

- The Python server (`python -m painapple_code`) is **not** bundled — iOS sandboxing forbids running arbitrary subprocesses (PTYs, `claude` CLI), and the App Store guidelines around interpreters/remote code execution make a bundled backend a non-starter.
- The user runs pAInapple Code on their own machine (Docker per the main README) and the app connects to it over the network — same model as a browser tab pointed at `http://localhost:8765/`, just packaged as an app icon with native chrome.
- macOS *could* in principle bundle the server (no sandbox if distributed outside the Mac App Store), but to keep one code path we treat macOS as a thin client too for now.

## Targets

| Platform | Tauri command | Notes |
|---|---|---|
| iOS / iPadOS | `cargo tauri ios init` → `cargo tauri ios dev/build` | Primary target. iPad is the main mobile form factor the UI was tested on. |
| macOS | `cargo tauri build` (default desktop) | Native WKWebView, small bundle, DMG or notarized .app. |
| Android | `cargo tauri android init` (out of scope on this branch) | Free with Tauri but not a goal yet. |
| Windows / Linux | `cargo tauri build` (out of scope on this branch) | Likewise free if we want them. |

## Open questions to resolve before this is real

- **Server URL config** — the app needs a settings screen ("which server?") before first load. Currently the web client assumes same-origin. Needs either a launch screen that captures the URL + token, or a deep-link handler for the bootstrap `?tkn=…` URL the server already emits (`tauri-plugin-deep-link` handles this).
- **WebSocket over HTTPS / WSS** — WKWebView is strict about mixed content. If the user's server is plain `http://localhost`, App Transport Security exceptions will be needed (`NSAppTransportSecurity` in `Info.plist`). Easier if we require TLS, but most home users won't have it.
- **PTY widget** — works in a browser today via xterm.js over WebSocket. Should "just work" inside WKWebView, but needs verification (keyboard handling on iOS especially — Ctrl/Esc/Tab need a custom on-screen toolbar).
- **File picker / drag-and-drop** — the file-preview panel may need native bridges via `tauri-plugin-fs` and `tauri-plugin-dialog`.
- **Distribution** — Apple Developer account ($99/yr) required for device installs. TestFlight for beta. App Store approval is uncertain given the "remote shell" nature; sideload + ad-hoc may be the realistic ceiling.

## Bootstrap commands (for when we start)

```bash
# Prereqs: Rust (rustup), Node 20+, Xcode 15+ (full install), Cocoapods, Rust iOS targets
rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios
cargo install tauri-cli --version "^2.0"

# From repo root, on this branch:
npm init -y
npm install --save-dev @tauri-apps/cli @tauri-apps/api
npx tauri init                 # creates src-tauri/, tauri.conf.json
# point tauri.conf.json's frontendDist to a small launcher dir that
# captures server URL + token, then redirects to the remote pAInapple

npx tauri ios init             # creates src-tauri/gen/apple/
npx tauri ios dev              # run on simulator or device
npx tauri ios build            # production .ipa

npx tauri dev                  # macOS dev
npx tauri build                # macOS .dmg / .app
```

Host requirements: macOS with Xcode 15+, Node 20+, Rust (rustup), Cocoapods, Apple Developer account for device builds.

## Files this branch is likely to add

- `tauri.conf.json` — Tauri config (windows, permissions, bundle metadata)
- `src-tauri/` — Rust crate (the native shell)
- `src-tauri/Cargo.toml` — Rust deps
- `src-tauri/gen/apple/` — generated Xcode project for iOS (created by `tauri ios init`)
- `package.json` / `package-lock.json` — npm deps for the Tauri CLI
- A small launcher web root that prompts for the server URL + token before redirecting to the real client
