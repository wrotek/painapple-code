# Framework choice: Capacitor (+ Electron) vs Tauri v2

Decision record for the `app` branch. We're wrapping `web-client.html` as a native shell for iOS, iPadOS, and macOS. This doc weighs the two realistic paths.

## TL;DR

**Going with Tauri v2.** It handles iOS, iPadOS, macOS (and Android, Windows, Linux) from one codebase, uses WKWebView on all Apple targets (same engine = consistent behaviour), produces ~3–15 MB bundles, and the plugin set we'd actually need (filesystem, HTTP, deep-link, notifications) is covered by official plugins.

The main thing we give up: Capacitor's larger mobile community and battle-testing. Mitigated by the fact that **this app is a thin client** — it just loads a remote URL — so we lean on the framework barely at all.

The thing that pushed it over: **`@capacitor-community/electron` is unmaintained.** Capacitor's only "official-ish" macOS story is community-volunteer, no longer maintained. Going Capacitor means either (a) Capacitor mobile + separate Electron desktop project — two codebases, two plugin systems, two build pipelines — or (b) Capacitor mobile + Mac Catalyst, which works but ties macOS quality to "how well does the iPad build run as a Mac app."

## The two paths in detail

### Path A — Capacitor + Electron (or Capacitor + Mac Catalyst)

```
┌─────────────┐  ┌─────────────┐  ┌─────────────┐
│ iOS/iPadOS  │  │  macOS      │  │ (Android)   │
│  Capacitor  │  │  Electron   │  │  Capacitor  │
│  WKWebView  │  │  Chromium   │  │  WebView    │
└─────────────┘  └─────────────┘  └─────────────┘
```

- **Mobile shell:** Capacitor. Native WebView (WKWebView on iOS, system WebView on Android). Mature, large plugin catalogue, well-trodden App Store path.
- **Desktop shell:** Electron — bundled Chromium + Node. Heavyweight (~80–150 MB installer, ~150–300 MB RAM idle) but rock-solid and ubiquitous.
- **Unified Capacitor-on-Electron?** No. `@capacitor-community/electron` is marked **unmaintained** as of this writing; not a viable foundation.
- **Single-codebase macOS alternative:** **Mac Catalyst** — Apple's "your iPad app, on Mac" path. Same Xcode project as Capacitor iOS, single bundle. Quality varies (custom controls can feel un-Mac), but is the closest Capacitor gets to "one project, three Apple platforms."

### Path B — Tauri v2

```
┌─────────────┐  ┌─────────────┐  ┌─────────────┐
│ iOS/iPadOS  │  │  macOS      │  │  Windows    │
│  Tauri v2   │  │  Tauri v2   │  │  Tauri v2   │
│  WKWebView  │  │  WKWebView  │  │  WebView2   │
└─────────────┘  └─────────────┘  └─────────────┘
       └────── one src-tauri/ project ──────┘
```

- One framework, one config (`tauri.conf.json`), one plugin system, one CLI (`cargo tauri`).
- Rust core compiled per target; JS↔Rust bridge via `invoke()` and events.
- WKWebView on macOS/iOS (same engine), WebKitGTK on Linux, WebView2 on Windows. No bundled Chromium.
- Mobile (iOS/Android) was stabilised in Tauri v2 (released October 2024). Newer than Capacitor mobile.

## Side-by-side

| | Capacitor + Electron | Tauri v2 |
|---|---|---|
| **Apple targets from one codebase** | iOS/iPadOS via Capacitor; macOS via separate Electron *or* Mac Catalyst | iOS/iPadOS/macOS all unified |
| **macOS WebView** | Chromium (Electron) | WKWebView |
| **iOS/iPadOS WebView** | WKWebView | WKWebView |
| **Bundle size (macOS, hello-world)** | ~80–150 MB (Electron) | ~3–15 MB |
| **RAM idle (desktop)** | ~150–300 MB | ~30–80 MB |
| **Toolchain** | Node + Xcode (+ optionally Electron tooling) | Node + Xcode + **Rust** + Cocoapods + Rust iOS targets |
| **Plugin ecosystem** | Largest in mobile WebView space; broad community plugins | Smaller but growing; official set covers FS, HTTP, deep-link, notifications, secure-storage; **no shell plugin on mobile** |
| **JS↔native bridge** | Plugin classes, `@capacitor/core` `Plugins` proxy | `invoke('cmd', args)` over message passing |
| **Hot reload on mobile device** | Yes, via Capacitor live-reload | Yes, via `TAURI_DEV_HOST` |
| **Mobile maturity** | Capacitor 5+ has been stable for years | v2 mobile stable since late 2024 — newer |
| **macOS distribution** | Electron: DMG / Mac App Store; Catalyst: Mac App Store / notarized | DMG / Mac App Store / notarized — all supported |
| **iOS distribution** | App Store / TestFlight / ad-hoc — same Apple constraints | Same |
| **Auto-update** | Electron has `electron-updater`; Capacitor on mobile via App Store only (or Capgo etc.) | Tauri updater plugin (desktop); mobile via App Store |
| **License** | MIT (both) | Apache-2.0 / MIT |
| **Security posture** | Electron requires manual context-isolation discipline; Capacitor permissions per-plugin | Capability-based permission model in config; sandboxed by default |

## What this app actually needs from the framework

Concrete list, based on `web-client.html` and the painapple feature set:

| Need | Capacitor | Tauri v2 |
|---|---|---|
| Load a remote URL (the user's pAInapple server) in a WebView | ✅ via `server.url` config or `WebView` plugin | ✅ via `tauri.conf.json` `windows[].url` |
| WebSocket (xterm + streaming) | ✅ (browser-standard) | ✅ (browser-standard) |
| HTTPS / WSS with self-signed certs (home users) | ATS exceptions in `Info.plist` | ATS exceptions in `Info.plist` |
| Plain HTTP / WS for `localhost` | ATS exception or use 127.0.0.1 | Same |
| Settings: store server URL + auth token | `@capacitor/preferences` | `tauri-plugin-store` or Stronghold |
| Open external links in system browser | `@capacitor/browser` | `tauri-plugin-shell` (desktop) / `tauri-plugin-opener` (mobile) |
| Deep link for bootstrap `?tkn=…` URL | `@capacitor/app` URL open event | `tauri-plugin-deep-link` |
| File picker (file-preview, attachment upload) | `@capacitor/filesystem`, `@capacitor/camera` | `tauri-plugin-fs`, `tauri-plugin-dialog` |
| iOS keyboard handling for terminal (Ctrl, Esc, Tab) | Open problem in both — needs a custom on-screen toolbar regardless |
| Push notifications (turn-finished alerts, optional) | `@capacitor/push-notifications` (FCM/APNs) | `tauri-plugin-notification` (local) — push needs custom work |

**Verdict on needs**: both frameworks cover everything except push notifications (where Capacitor wins if we ever want remote push). For a v1 thin client this isn't the deciding axis.

## Specific risks & mitigations

### If we go Tauri v2

- **Rust toolchain on contributors' machines** — adds friction. Mitigation: contributors who only touch the web frontend don't need Rust; only native-side changes do.
- **Mobile is younger** — fewer Stack Overflow hits, smaller plugin pool, more chance of "you're the first person to hit this." Mitigation: thin client = small native surface = low blast radius.
- **No mobile shell plugin** — can't spawn subprocesses on iOS. Doesn't matter for this app (server runs remotely).
- **WKWebView quirks** — same as Capacitor on iOS. Push notifications, background WebSocket disconnection on backgrounding, etc. are framework-independent.

### If we go Capacitor + Electron

- **Two codebases for the shell** — mobile and desktop diverge over time. Plugin parity gaps (e.g. a Capacitor plugin has no Electron equivalent).
- **Electron bloat** — users notice. A "small terminal/chat-style app" weighing 150 MB and using 300 MB RAM looks bad next to a 5 MB native app.
- **`@capacitor-community/electron` unmaintained** — using it means inheriting an abandoned dep. Avoid.

### If we go Capacitor + Mac Catalyst (single Xcode project)

- **Catalyst feels iPad-y on Mac** — custom controls, hover/right-click, window resizing can be janky. Mitigation: tune for Catalyst specifically, accept some compromise.
- **No Windows/Linux story** — Catalyst is Apple-only. If we ever want desktop Linux/Windows, we'd add Electron later anyway.

## Why painapple-code is a good fit for Tauri specifically

1. **Thin client** — the framework barely matters; we mostly need a WebView + a settings screen. Tauri's "small, native WebView" model fits perfectly.
2. **Power-user audience** — early users are developers running Docker, terminals, Claude Code. They will notice a 5 MB native macOS app vs a 150 MB Electron one and appreciate it.
3. **Future-proofing** — Tauri gives us Windows + Linux + Android for free if we want them later; Capacitor + Electron stays Apple-shaped without more work.
4. **No deep native integration** — we're not building a camera app or a Bluetooth gadget. The "Capacitor has more mobile plugins" advantage doesn't apply.

## When we'd reverse this decision

- If iOS keyboard handling for the PTY widget turns out to require deep WKWebView hacks where Capacitor has a community-tested workaround and Tauri doesn't.
- If we discover Tauri v2 mobile has a showstopper (file uploads, WebSocket lifecycle on backgrounding, etc.) that's already solved in Capacitor.
- If we decide to ship push notifications as a v1 feature — Capacitor has push-notifications baked in; Tauri would need custom native code.

## References

- Tauri v2 — https://v2.tauri.app/
- Tauri v2 prerequisites — https://v2.tauri.app/start/prerequisites/
- Tauri v2 plugins — https://v2.tauri.app/plugin/
- Capacitor — https://capacitorjs.com/
- Capacitor Electron community plugin — https://github.com/capacitor-community/electron (unmaintained — verify before adopting)
- Mac Catalyst — https://developer.apple.com/mac-catalyst/
