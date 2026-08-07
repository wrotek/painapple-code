# Windows build plan (x86_64 .exe / .msi)

Forward-looking plan for producing a Windows installer from this Tauri scaffold. Not implemented or tested yet — execute on an actual Windows machine.

Out of scope on this branch per [../APP.md](../APP.md), but the scaffold is mostly cross-platform already and the missing pieces are small.

## What's already in place

- `bundle.targets: "all"` in `src-tauri/tauri.conf.json` — Tauri emits NSIS `.exe` and MSI when the host is Windows.
- `icons/icon.ico` is in the bundle icon list.
- Cargo deps are pure-Rust: `rustls` + `ring` (not OpenSSL/SecureTransport), `tokio`, `hyper`, `reqwest`. No platform-specific TLS bits in `src-tauri/src/proxy.rs`.
- Only `#[cfg(target_os = ...)]` in the source carves out iOS — nothing carved against Windows.

## What needs to change before first build

1. **npm scripts.** Every script in `package.json` prefixes the command with `CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/Library/Caches/painapple-tauri-target}" …`. The bash expansion and macOS cache path won't work under PowerShell or cmd. Add a sibling script:

   ```json
   "build:win": "tauri build"
   ```

   (or run from WSL/Git Bash with `CARGO_TARGET_DIR` set explicitly to something local on the C: drive — Cargo's default `src-tauri/target/` is fine, the macOS redirect was only to dodge the NFS gotcha which doesn't exist on Windows).

2. **Confirm WebView2 install mode.** Default `bundle.windows.webviewInstallMode` is `downloadBootstrapper`, which is fine for the first test. Consider `embedBootstrapper` or `offlineInstaller` later if shipping to machines without internet.

## Host requirements

| | Install |
|---|---|
| Windows 10/11 x64 | — |
| Rust (rustup) + `x86_64-pc-windows-msvc` target | rustup.rs (the MSVC target is the default on Windows) |
| Microsoft C++ Build Tools | "Build Tools for Visual Studio" → "Desktop development with C++" workload |
| Node 20+ | nodejs.org |
| WebView2 Runtime | Preinstalled on Windows 11; otherwise auto-installed by NSIS bundle |
| WiX | Auto-downloaded by Tauri on first MSI build |

`cargo tauri info` on the Windows machine confirms everything is detected.

## Build steps (when on the Windows box)

```powershell
git clone <repo> ; cd painapple-code-app ; git checkout app
cd tauri-app
npm install
npx tauri build          # or: npm run build:win, once the script is added
```

Output lands in `src-tauri/target/release/bundle/`:
- `nsis/pAInapple Code_0.0.1_x64-setup.exe` — NSIS installer (recommended for first test)
- `msi/pAInapple Code_0.0.1_x64_en-US.msi` — MSI installer

## First-run verification checklist

- [ ] NSIS `.exe` installs without prompts beyond SmartScreen
- [ ] App launches; the launcher (`src/index.html`) renders in WebView2
- [ ] URL + token submit redirects to a remote pAInapple server
- [ ] WebSocket connects to the server (PTY widget visible)
- [ ] TLS proxy (`src-tauri/src/proxy.rs`) connects to an `https://` server with a self-signed cert (no fingerprint needed — any cert accepted)
- [ ] Plain-TCP proxy mode works against an `http://` server
- [ ] Ctrl+Shift+N opens a second window (verify the macOS Cmd+Shift+N multi-window remaps cleanly to Ctrl on Windows)
- [ ] Back/forward navigation behaves like the macOS build
- [ ] App icon shows correctly in taskbar and Add/Remove Programs

## Known risks / open questions

- **Cert-pinning proxy on WebView2.** rustls is cross-platform but the proxy hasn't been exercised under WebView2. Loopback HTTP should "just work" since WebView2 treats `127.0.0.1` as a secure context, same as WKWebView.
- **SmartScreen warning.** Unsigned `.exe` will trigger SmartScreen on first launch. Same situation as the unsigned `.app` on macOS. Code signing needs an EV/OV cert (~$200–400/yr) — separate effort.
- **Deep-link handler.** Not implemented on any platform yet (per [../APP.md](../APP.md) open questions). Not blocking first build.
- **Path assumptions in `src/launcher.js`.** Unlikely to matter since it's all URLs, but worth a quick scan.
- **Bundle ID `com.boothw.painapple`.** Fine for Windows — no Apple-style team-ID conflict here.

## Out of scope for this plan

- Code signing / EV certificate
- Auto-updater (Sparkle equivalent: `tauri-plugin-updater` works on Windows too, but separate setup)
- ARM64 Windows builds
- 32-bit Windows
- Distribution channels (Microsoft Store, winget, Chocolatey)

## Cross-compiling from macOS/Linux?

Possible in theory with `cargo-xwin` for the MSVC bits, but NSIS and WiX expect a Windows host and the toolchain is a rabbit hole. Build on Windows — much less friction than getting it working anywhere else.
