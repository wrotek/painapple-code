use std::collections::HashMap;
use std::error::Error as _;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use tauri::plugin::{Builder as PluginBuilder, TauriPlugin};
use tauri::{AppHandle, Listener, Manager, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

mod proxy;
#[cfg(desktop)]
mod local;
#[cfg(target_os = "macos")]
mod dock_menu;
#[cfg(target_os = "ios")]
mod ios_menu;
#[cfg(target_os = "ios")]
mod ios_quick_actions;

// Monotonic token for navigation watchdog timers. Each install_nav_watchdog call
// gets a fresh token; the timer only fires the launcher-bounce if the token in
// AppState still matches when the timeout elapses (so a superseding navigation
// safely cancels the previous watchdog).
static NAV_TOKEN: AtomicU64 = AtomicU64::new(0);

#[cfg(desktop)]
use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};

// Note: older builds persisted an `fp` (cert-pin fingerprint) field on
// recents; serde ignores it on deserialize now that pinning is gone — the
// proxy accepts any upstream cert (MITM accepted by design).
#[derive(Debug, Clone, Serialize, Deserialize)]
struct RecentEntry {
    url: String,
    #[serde(default)]
    name: Option<String>,
}

#[derive(Default)]
struct AppState {
    recents: Mutex<Vec<RecentEntry>>,
    launcher_url: Mutex<Option<tauri::Url>>,
    // Watchdogs are per-window: each window has its own navigation in flight,
    // so a slow load in window A must not cancel window B's pending nav.
    pending_nav: Mutex<HashMap<String, PendingNav>>,
    // Per-target proxy ports, so a second start_proxy call for the same
    // target returns the same port — without this, every navigation cycle
    // would land on a fresh origin and drop the auth cookie set last time.
    // Shared across windows: two windows on the same server reuse the port,
    // so the auth cookie set in one is still valid in the other. Entries are
    // liveness-probed on reuse (ensure_proxy) and on iOS foregrounding
    // (revive_dead_proxies): a hit only proves the port was bound once, and
    // iOS reclaims listener sockets during long suspensions.
    proxies: Mutex<HashMap<String, u16>>,
    // Counter for spawned window labels (main-2, main-3, …). Only increments
    // so labels never collide, even after windows are closed and reopened.
    window_counter: AtomicU64,
    // Set true by the web-client's browser widget when it's about to load an
    // external URL straight into its iframe (proxy OFF). wry 0.55 can't tell
    // an iframe-originated nav from a top-frame click, so without this flag
    // on_navigation would hand the URL off to Safari instead of letting the
    // iframe attempt it (and surface X-Frame-Options errors in place).
    // Bounded to direct-mode iframe loads: cleared when proxy mode is on,
    // when the iframe is empty/local, and when the widget is unmounted.
    browser_widget_direct: AtomicBool,
}

#[derive(Clone)]
struct PendingNav {
    target: String,
    token: u64,
}

// Injected into every loaded page. Carries cross-page keyboard shortcuts:
//   - Cmd+Shift+L → launcher popup
//   - Cmd+Shift+N → launcher popup (alias — matches macOS "New Window"
//                   convention while keeping behaviour identical to Cmd+Shift+L)
//   - Cmd+W       → close active tab (intercepts the OS's close-window default
//                   so the web client's tab system gets a chance to handle it)
//   - Cmd+Q       → close current window (overrides the OS default of
//                   quitting the whole app)
// The iPad menu bar (ios_menu.rs) now carries the same accelerators
// natively; this JS-side mirror stays as the fallback for iPhone (no menu
// bar) and for the window before the injected menu handler is live. The
// chord-spawning variants open the launcher popup so the active session
// stays alive instead of getting trampled by a navigation back to the launcher.
//
// Also injects a floating "← Launcher" button on foreign pages — a reverse
// proxy in front of a stopped server often serves its own "Service not
// running" HTML, leaving the user stranded with no escape affordance. The
// button gives them one without needing to know Cmd+Shift+L or the macOS
// Dock right-click menu.
const PAGE_INIT_SCRIPT: &str = r#"
(() => {
  if (window.__painapple_init__) return;
  window.__painapple_init__ = true;
  document.addEventListener('keydown', (e) => {
    if (!window.__TAURI__ || !window.__TAURI__.core) return;
    // Cmd+W precedence: web-client tab close > launcher window dismiss >
    // OS default. Every launcher page (popup, Cmd+Shift+N new window,
    // first-launch main) exposes window.__painapple_close_window__, so
    // Cmd+W consistently dismisses whichever launcher window is in front.
    // Calling it explicitly (rather than falling through to the OS) is
    // required because the popup's NSWindow has .resizable(false), which
    // on macOS suppresses the system's default Cmd+W close action — a
    // uniform close path sidesteps that quirk.
    if (e.code === 'KeyW' && e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
      if (window.app && typeof window.app.closeActiveTab === 'function') {
        e.preventDefault();
        window.app.closeActiveTab();
      } else if (typeof window.__painapple_close_window__ === 'function') {
        e.preventDefault();
        window.__painapple_close_window__();
      }
      return;
    }
    // Cmd+Q: close current window (never a tab). Overrides the OS's default
    // "quit app" so the user's other windows stay alive. On macOS the native
    // "Close Window" menu item with the same accelerator usually consumes
    // the chord before this listener fires; the JS path is a backup and the
    // primary handler for iPad pages where the swizzle didn't already fire.
    if (e.code === 'KeyQ' && e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      if (typeof window.__painapple_close_window__ === 'function') {
        window.__painapple_close_window__();
      } else {
        window.__TAURI__.core.invoke('close_self').catch(() => {});
      }
      return;
    }
    if (!e.shiftKey || !(e.metaKey || e.ctrlKey)) return;
    if (e.code === 'KeyL') {
      e.preventDefault();
      window.__TAURI__.core.invoke('open_launcher_popup');
    } else if (e.code === 'KeyN') {
      e.preventDefault();
      window.__TAURI__.core.invoke('open_launcher_popup');
    }
  });

  // Floating back-to-launcher + reload escape hatches — only mount on
  // foreign pages. The launcher's origin is tauri://localhost (or
  // tauri.localhost on wry); skip there since the page already IS the
  // selector and the browser refresh handles its own reload.
  const isLauncherOrigin =
    location.hostname === 'tauri.localhost' || location.protocol === 'tauri:';
  if (!isLauncherOrigin) {
    const mountIfForeign = () => {
      if (document.getElementById('__painapple_back__')) return;
      // Our own painapple surfaces. If any are present, the page has its
      // own navigation and the floating buttons would be visual noise.
      //   #app      — web-client chat UI
      //   #connect  — launcher form (if ever reached via a non-tauri origin)
      //   #back     — proxy.rs error page (already has its own back button)
      if (document.getElementById('app')) return;
      if (document.getElementById('connect')) return;
      if (document.getElementById('back')) return;
      if (!document.body) return;
      // Shared bar holds both buttons so a single fixed position handles
      // their layout — avoids hand-tuning two separate left offsets when
      // labels change length.
      const bar = document.createElement('div');
      bar.id = '__painapple_escape_bar__';
      bar.style.cssText = [
        'position:fixed',
        // 84px from left clears the macOS traffic lights cluster; on iOS
        // env() handles the notch / Dynamic Island offset.
        'top:calc(env(safe-area-inset-top,0px) + 12px)',
        'left:calc(env(safe-area-inset-left,0px) + 84px)',
        'display:flex',
        'gap:6px',
        'z-index:2147483647',
      ].join(';');
      const baseBtnCss = [
        'padding:8px 14px',
        'border-radius:10px',
        'border:1px solid rgba(120,120,120,0.3)',
        'color:#1a1612',
        'font:600 13px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif',
        'cursor:pointer',
        'box-shadow:0 2px 8px rgba(0,0,0,0.3)',
      ].join(';');
      const back = document.createElement('button');
      back.id = '__painapple_back__';
      back.type = 'button';
      back.title = 'Back to launcher';
      back.setAttribute('aria-label', 'Back to launcher');
      back.textContent = '← Launcher';
      back.style.cssText = baseBtnCss + ';background:#f0a050';
      back.addEventListener('click', () => {
        if (window.__TAURI__ && window.__TAURI__.core) {
          window.__TAURI__.core.invoke('back_to_launcher');
        }
      });
      const reload = document.createElement('button');
      reload.id = '__painapple_reload__';
      reload.type = 'button';
      reload.title = 'Reload page';
      reload.setAttribute('aria-label', 'Reload page');
      reload.textContent = '↻ Reload';
      // Muted second-button styling so the launcher action stays the
      // visual primary — reload is the "try the same thing again" hedge.
      reload.style.cssText = baseBtnCss + ';background:#e8dfd0;color:#3a3328';
      reload.addEventListener('click', () => {
        location.reload();
      });
      bar.appendChild(back);
      bar.appendChild(reload);
      document.body.appendChild(bar);
    };
    // Wait a moment so SPAs that hydrate after DOMContentLoaded get a chance
    // to mount their own #app before we decide the page is foreign.
    const schedule = () => setTimeout(mountIfForeign, 700);
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', schedule, { once: true });
    } else {
      schedule();
    }
  }
})();
"#;

#[tauri::command]
fn back_to_launcher(app: AppHandle, window: WebviewWindow) {
    navigate_to_launcher(&app, &window);
}

// Called by launcher.js right before it navigates the webview to a server
// (and from Rust's menu-recent path) so each window's title reflects the
// session it's connected to instead of the generic "pAInapple Code". Empty
// `name` resets the title — used when returning to the launcher.
#[tauri::command]
fn set_session_name(window: WebviewWindow, name: String) {
    let _ = window.set_title(&format_window_title(&name));
}

fn format_window_title(name: &str) -> String {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        "pAInapple Code".to_string()
    } else {
        trimmed.to_string()
    }
}

// New full-size top-level window loading the launcher. Now only called by
// the iOS SceneRequested handler — Cmd+Shift+N and the "New Window" menu
// item both go through `open_launcher_popup` instead, since the user
// expects those to behave the same as Cmd+Shift+L (a small dismissable
// launcher) rather than a permanent full-size window. The Tauri command
// wrapper is kept registered for any future external/IPC callers, but is
// no longer invoked from the bundled UI.
//
//   - macOS: a separate top-level NSWindow.
//   - iPadOS w/ multi-scene: tao asks the system for a new UIScene, or attaches
//     to one the system already created (drag-from-dock split view — see the
//     SceneRequested handler in run()).
//   - iPhone (and iPads without scene support): tao falls back to swapping the
//     current scene's window, so visually it replaces the active screen instead
//     of opening a new one. Acceptable: there's no real concept of "two windows
//     side by side" on phone form factors.
#[tauri::command]
fn new_window(app: AppHandle) -> Result<(), String> {
    spawn_window(&app).map(|_| ())
}

fn spawn_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    let n = app
        .state::<AppState>()
        .window_counter
        .fetch_add(1, Ordering::Relaxed)
        + 2;

    // ?manual=1 tells launcher.js to skip auto-reconnect and just show the
    // recents list — without it, a new window would land straight back on
    // whichever server localStorage has at index 0. WebviewUrl::App routes
    // through tauri-runtime's URL joiner (preserves the query); ::External
    // would silently fail at build time because it rejects non-http schemes.
    let initial = WebviewUrl::App("index.html?manual=1".into());

    // title / inner_size are no-ops on iOS but harmless — keep them so the
    // macOS build doesn't have its own divergent builder call.
    #[allow(unused_mut)]
    let mut builder = WebviewWindowBuilder::new(app, format!("main-{n}"), initial)
        .title("pAInapple Code")
        .inner_size(1280.0, 800.0)
        .min_inner_size(480.0, 320.0);

    // Cascade so the new window isn't sitting exactly on top of the active
    // one. iOS controls scene placement itself, so this is desktop-only.
    #[cfg(desktop)]
    if let Some((x, y)) = cascade_position(app) {
        builder = builder.position(x, y);
    }

    builder.build().map_err(|e| e.to_string())
}

// Cmd+Shift+L / "New Connection" — opens the launcher in a small dismissable
// window instead of trampling the current session. The popup lets the user
// pick a new server (which connects in that window, leaving the old session
// alone) or just dismiss with Esc / X to return focus to the prior window.
#[tauri::command]
fn open_launcher_popup(app: AppHandle) -> Result<(), String> {
    let n = app
        .state::<AppState>()
        .window_counter
        .fetch_add(1, Ordering::Relaxed)
        + 2;

    // ?popup=1 tells launcher.js to render the close-X and bind Esc; the
    // launcher form itself works the same as in a full window.
    let initial = WebviewUrl::App("index.html?manual=1&popup=1".into());

    #[allow(unused_mut)]
    let mut builder = WebviewWindowBuilder::new(&app, format!("launcher-popup-{n}"), initial)
        .title("pAInapple Code")
        .inner_size(520.0, 600.0);

    // center is desktop-only on the Tauri builder — iOS controls scene
    // placement itself so it'd be a no-op, and the method isn't even in
    // scope on the iOS build. The popup is resizable: users do drag it
    // larger when the recents list is long, and forcing a fixed size
    // earlier brought a string of macOS quirks with it (Cmd+W swallowed
    // by .resizable(false)'s styleMask). The min_inner_size keeps it
    // useful as a compact launcher without trapping the user.
    #[cfg(desktop)]
    {
        builder = builder.min_inner_size(480.0, 540.0).center();
    }

    builder.build().map(|_| ()).map_err(|e| e.to_string())
}

// Called from launcher.js when the popup is dismissed (X / Esc / Cmd+W).
// Uses destroy() instead of close() because close() emits a CloseRequested
// event that other Tauri layers (or a `.resizable(false)` window's macOS
// styleMask quirks) can swallow — observed as: clicking X did nothing,
// pressing Cmd+W did nothing. destroy() bypasses the event and tears the
// window down unconditionally, which is exactly what we want for a
// user-driven popup dismiss.
#[tauri::command]
fn close_self(window: WebviewWindow) -> Result<(), String> {
    window.destroy().map_err(|e| e.to_string())
}

// ── Small on-disk persistence (app data dir) ────────────────────────────────
//
// WKWebView localStorage is unreliable on iOS: writes are silently dropped
// when the process is killed at the wrong moment, and the webview origin the
// chat client runs on used to change every launch (see ensure_proxy). These
// helpers give the JS side a durable sidecar: plain JSON files in the app's
// data directory, written atomically (temp + rename) with 0600 permissions.
// Note this does NOT survive an app uninstall — nothing in the app container
// does on iOS — but it does survive relaunches, OS-driven process kills, and
// WKWebView storage eviction, which are the common data-loss paths.

const RECENTS_FILE: &str = "recents.json";
const PROXY_PORTS_FILE: &str = "proxy-ports.json";

fn persist_dir(app: &AppHandle) -> Option<std::path::PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

fn read_persisted(app: &AppHandle, name: &str) -> Option<String> {
    std::fs::read_to_string(persist_dir(app)?.join(name)).ok()
}

// Sequence for unique temp-file names. A fixed `<name>.tmp` would let two
// concurrent writers interleave into the same fd path (each writing from
// offset 0) and rename a corrupt file into place — pingAllRecents fires
// ensure_proxy for every saved server in parallel, so concurrent
// save_port_prefs calls are routine, not exotic.
static PERSIST_TMP_SEQ: AtomicU64 = AtomicU64::new(0);

fn write_persisted(app: &AppHandle, name: &str, contents: &str) -> Result<(), String> {
    let dir = persist_dir(app).ok_or("no app data dir")?;
    let seq = PERSIST_TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp = dir.join(format!("{name}.{seq}.tmp"));
    std::fs::write(&tmp, contents).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // recents.json carries plaintext tokens (same trust level as the
        // localStorage copy it mirrors) — keep it owner-only.
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
    }
    std::fs::rename(&tmp, dir.join(name)).map_err(|e| e.to_string())
}

// Disk mirror of the launcher's `painapple.recent` localStorage list, written
// on every saveRecent() and merged back at launcher startup. Stored verbatim
// (full entries incl. token + lastUsed) — the JS side owns the schema.
#[tauri::command]
fn save_recents(app: AppHandle, recents: String) -> Result<(), String> {
    // Sanity-check it's a JSON array before persisting, so a JS-side bug
    // can't clobber the durable copy with garbage.
    match serde_json::from_str::<serde_json::Value>(&recents) {
        Ok(v) if v.is_array() => write_persisted(&app, RECENTS_FILE, &recents),
        Ok(_) => Err("recents must be a JSON array".into()),
        Err(e) => Err(format!("invalid recents JSON: {e}")),
    }
}

#[tauri::command]
fn load_recents(app: AppHandle) -> String {
    read_persisted(&app, RECENTS_FILE).unwrap_or_else(|| "[]".into())
}

// Per-target proxy-port preferences: origin → port bound last time. Lets
// ensure_proxy re-bind the same loopback port across launches so the chat
// client's webview origin (http://127.0.0.1:<port>) — and with it cookies +
// localStorage — is stable per server instead of rotating every cold start.
fn load_port_prefs(app: &AppHandle) -> HashMap<String, u16> {
    read_persisted(app, PROXY_PORTS_FILE)
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn save_port_prefs(app: &AppHandle, prefs: &HashMap<String, u16>) {
    if let Ok(json) = serde_json::to_string_pretty(prefs) {
        // Best-effort: a failed write just means a fresh origin next launch.
        let _ = write_persisted(app, PROXY_PORTS_FILE, &json);
    }
}

// Deterministic default port for an origin, used when no persisted pref
// exists yet: fnv1a (hand-rolled for cross-build stability, same rationale
// as proxy::cookie_prefix) mapped into the IANA dynamic range. This gives
// every server a stable webview origin from its very first launch, and
// keeps origins well-separated so one target's OS-assigned ephemeral port
// can't recycle into another target's persisted port (which would leak
// localStorage between servers via the shared loopback origin). If the
// derived port happens to be taken, proxy::start falls back to ephemeral
// and the pref file records the fallback.
fn default_port_for(origin: &str) -> u16 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in origin.as_bytes() {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    49152 + (h % 16384) as u16
}

#[cfg(desktop)]
fn cascade_position(app: &AppHandle) -> Option<(f64, f64)> {
    let w = focused_window(app)?;
    let pos = w.outer_position().ok()?;
    let scale = w.scale_factor().ok()?;
    Some((pos.x as f64 / scale + 40.0, pos.y as f64 / scale + 40.0))
}

// Reported back to JS so the launcher can show why a server is unreachable
// instead of a generic red dot. Going through Rust (not fetch) bypasses CORS,
// so the probe reflects real reachability rather than the server's CORS policy.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum HealthResult {
    Reachable { status: u16, latency_ms: u64 },
    Unreachable { cause: String, reason: String },
}

#[tauri::command]
async fn check_server_health(app: AppHandle, url: String) -> HealthResult {
    // The probe takes the same route the navigation will (probe_route):
    // proxy-needing targets are probed through the actual loopback proxy —
    // a passing probe then means the navigation will work, and we reuse the
    // exact TLS/forwarding logic instead of duplicating it (reqwest +
    // use_preconfigured_tls had inconsistent behaviour vs the proxy's bare
    // tokio-rustls on at least one user's Mac). Direct targets (loopback,
    // https domains) are probed directly, with cert strictness matched to
    // what WKWebView will enforce at nav time.
    let parsed = match url::Url::parse(&url) {
        Ok(p) => p,
        Err(e) => {
            return HealthResult::Unreachable {
                cause: "other".to_string(),
                reason: format!("invalid URL: {e}"),
            };
        }
    };
    let (probe_base, strict_tls) = match probe_route(&app, &url, &parsed).await {
        Ok(r) => r,
        Err(e) => {
            return HealthResult::Unreachable {
                cause: "other".to_string(),
                reason: e,
            };
        }
    };
    let probe_url = format!("{}/health", probe_base.trim_end_matches('/'));

    // Cert strictness mirrors the navigation (see probe_route): strict for
    // directly-reached https domains — WKWebView will validate those, so the
    // probe must fail the same way (categorized as 'tls' below → the
    // launcher says "certificate problem" instead of green-lighting a nav
    // that dies on the cert). Lax everywhere else: proxied targets (all
    // self-signed https, loopback included, plus plain-http shims) are
    // probed via the loopback proxy over plain http, where the proxy's
    // accept-any upstream policy is the point.
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(6))
        .danger_accept_invalid_certs(!strict_tls)
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return HealthResult::Unreachable {
                cause: "other".to_string(),
                reason: e.to_string(),
            };
        }
    };

    let start = std::time::Instant::now();
    match client.get(&probe_url).send().await {
        Ok(resp) => HealthResult::Reachable {
            status: resp.status().as_u16(),
            latency_ms: start.elapsed().as_millis() as u64,
        },
        Err(e) => HealthResult::Unreachable {
            cause: categorize_error(&e).to_string(),
            reason: e.to_string(),
        },
    }
}

fn is_loopback_host(host: &str) -> bool {
    matches!(host, "127.0.0.1" | "::1" | "[::1]" | "localhost")
}

// Password verification verdict for the launcher. `Unknown` covers everything
// that isn't a clear yes/no — older servers without /api/login, transport
// errors, unexpected statuses — so the launcher can fall back to navigating
// and letting the server's own login flow decide.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum AuthResult {
    Ok,
    Invalid,
    Unknown { reason: String },
}

// Verify a password against a server's POST /api/login (public path; 200 on
// success, 401 on a wrong password) WITHOUT navigating the webview. Probes
// along the same route the navigation will take (probe_route: via the
// loopback proxy for proxy-needing targets, direct otherwise), for the same
// reasons as check_server_health. The Set-Cookie on a 200 lands in reqwest's
// throwaway jar — the webview gets its own cookie later, when the real
// navigation carries ?tkn= and the server's redirect sets it.
#[tauri::command]
async fn check_server_auth(app: AppHandle, url: String, password: String) -> AuthResult {
    let parsed = match url::Url::parse(&url) {
        Ok(p) => p,
        Err(e) => {
            return AuthResult::Unknown { reason: format!("invalid URL: {e}") };
        }
    };
    let (probe_base, strict_tls) = match probe_route(&app, &url, &parsed).await {
        Ok(r) => r,
        Err(e) => return AuthResult::Unknown { reason: e },
    };
    let login_url = format!("{}/api/login", probe_base.trim_end_matches('/'));

    // Same cert policy as check_server_health: strict only for directly-
    // reached https domains, lax for proxied/loopback (see probe_route).
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(6))
        .danger_accept_invalid_certs(!strict_tls)
        .build()
    {
        Ok(c) => c,
        Err(e) => return AuthResult::Unknown { reason: e.to_string() },
    };

    let body = match serde_json::to_string(&serde_json::json!({ "password": password })) {
        Ok(b) => b,
        Err(e) => return AuthResult::Unknown { reason: e.to_string() },
    };
    match client
        .post(&login_url)
        .header("content-type", "application/json")
        .body(body)
        .send()
        .await
    {
        Ok(resp) => match resp.status().as_u16() {
            200 => AuthResult::Ok,
            401 => AuthResult::Invalid,
            s => AuthResult::Unknown { reason: format!("/api/login returned {s}") },
        },
        Err(e) => AuthResult::Unknown { reason: e.to_string() },
    }
}

// Resolve the base origin the webview should navigate to for `target`,
// starting (or reusing) a loopback proxy only when the target needs one —
// see needs_proxy for the policy. Returns either `http://127.0.0.1:<port>`
// (proxied: https+IP/mDNS targets get TLS-any-cert upstream, http targets
// get a plain TCP forward — both keep the webview on a secure-context
// loopback origin) or the target's own origin (direct: loopback, and https
// domains whose certs WKWebView validates natively). Proxied targets get
// the same port back on later calls so the auth cookie keeps working —
// after a liveness probe, since iOS can reclaim the listener socket while
// the app is suspended (dead listeners are rebound in place).
#[tauri::command]
async fn start_proxy(app: AppHandle, target: String) -> Result<String, String> {
    ensure_proxy(&app, &target).await
}

async fn ensure_proxy(app: &AppHandle, target: &str) -> Result<String, String> {
    let parsed = url::Url::parse(target).map_err(|e| format!("invalid target URL: {e}"))?;
    if !needs_proxy(&parsed) {
        // Direct: WKWebView loads this itself. Plain-http loopback is
        // already a secure context; a named https host is expected to carry
        // a valid public cert. No registry entry, no listener, no cookie
        // prefixing — and none of the proxy's failure modes.
        return Ok(parsed.origin().ascii_serialization());
    }
    let key = parsed.origin().ascii_serialization();

    let state = app.state::<AppState>();
    let cached = state.proxies.lock().unwrap().get(&key).copied();
    if let Some(port) = cached {
        // A registry hit only proves we bound this port once — not that the
        // listener still lives. iOS reclaims kernel sockets during long
        // suspensions: the process survives but the listener dies, and since
        // reload, reconnect, the health probe AND fresh windows all funnel
        // back through this map, every one of them hits the dead port until
        // the app is killed. One loopback connect (microseconds: SYN → accept
        // queue, or RST) tells dead from alive; on dead, forget the entry and
        // rebind below on the SAME port so the webview origin — auth cookie,
        // localStorage — survives the respawn.
        if loopback_alive(port).await {
            return Ok(format!("http://127.0.0.1:{port}"));
        }
        eprintln!("proxy for {key} on port {port} is dead (socket reclaimed?) — rebinding");
        state.proxies.lock().unwrap().remove(&key);
    }

    // Prefer, in order: the port this target was proxied on moments ago
    // (dead listener being rebound in place), the port persisted from a
    // previous launch, a hash-derived stable default. A stable port means a
    // stable webview origin (http://127.0.0.1:<port>), so the chat client's
    // cookies and localStorage carry over across cold starts instead of
    // being orphaned on a fresh ephemeral origin every time. If the
    // preferred port is taken, proxy::start falls back to an ephemeral one
    // (and we persist the fallback for next launch).
    let preferred = cached
        .or_else(|| load_port_prefs(app).get(&key).copied())
        .or_else(|| Some(default_port_for(&key)));
    let bound = proxy::start(parsed, preferred)
        .await
        .map_err(|e| format!("proxy bind failed: {e}"))?;

    // Two concurrent calls for the same origin can both miss the map check
    // above (pingAllRecents racing a recent-pick click) — converge on one
    // port so every caller hands the webview the same origin. Whoever bound
    // the preferred (stable) port wins; a loser's listener idles harmlessly
    // (listeners are process-lifetime anyway).
    let port = {
        let mut proxies = state.proxies.lock().unwrap();
        match proxies.get(&key).copied() {
            Some(existing) if Some(bound) != preferred => existing,
            _ => {
                proxies.insert(key.clone(), bound);
                bound
            }
        }
    };

    if preferred != Some(port) {
        // Re-read + overlay every live proxy before writing, so two proxies
        // starting close together can't lose each other's entry to a
        // read-modify-write race (worst case would only be a fresh origin
        // next launch, but it's cheap to avoid).
        let mut prefs = load_port_prefs(app);
        prefs.extend(
            state
                .proxies
                .lock()
                .unwrap()
                .iter()
                .map(|(k, v)| (k.clone(), *v)),
        );
        save_port_prefs(app, &prefs);
    }
    Ok(format!("http://127.0.0.1:{port}"))
}

// The single decision point for proxy-vs-direct. The proxy exists for two
// reasons only — cert bypass and secure context — so proxy exactly the
// targets that need one of them:
//
//   - https + IP literal (v4/v6, loopback INCLUDED): pAInapple's
//     self-signed certs can never validate in WKWebView (no per-origin
//     override exists, and TLS validation has no loopback exemption), so
//     the proxy terminates loopback plaintext and dials upstream TLS
//     accepting any cert.
//   - https + .local / dotless hostname (localhost included): mDNS and
//     single-label LAN names can't obtain publicly-valid certs either —
//     same self-signed story as IPs, same treatment.
//   - http + non-loopback: no cert problem, but a direct load would strip
//     the webview's secure context (clipboard, service worker, PWA
//     install). The proxy keeps the page on a loopback origin while
//     forwarding plaintext upstream (admin opted in via --tls=off).
//
// Everything else goes DIRECT:
//
//   - http + loopback: already a secure context, nothing to fix.
//   - https + real domain: a public DNS name is expected to carry a valid
//     cert (Let's Encrypt et al.). WKWebView validates it natively, the
//     wire is authenticated end-to-end — strictly BETTER than the proxy's
//     accept-any-cert tunnel — and skipping the loopback hop removes the
//     proxy's entire failure surface (dead listeners after iOS socket
//     reclaim, port collisions, cookie prefixing).
fn needs_proxy(target: &url::Url) -> bool {
    match target.scheme() {
        "http" => !is_loopback_host(target.host_str().unwrap_or("")),
        "https" => match target.host() {
            Some(url::Host::Ipv4(_) | url::Host::Ipv6(_)) => true,
            Some(url::Host::Domain(d)) => {
                let d = d.trim_end_matches('.').to_ascii_lowercase();
                !d.contains('.') || d.ends_with(".local")
            }
            None => false,
        },
        _ => false,
    }
}

// Resolve where a launcher probe (health / login check) should go and how it
// should judge certs, mirroring exactly what the webview will experience at
// navigation time. Returns (probe_base, strict_tls):
//   - proxied target → probe via the loopback proxy; strictness moot (the
//     proxy's accept-any upstream policy is the point).
//   - direct target → plain-http loopback (no TLS to judge) or an https
//     domain — the one case WKWebView itself validates the chain, so the
//     probe must too; otherwise a lax probe green-lights a navigation that
//     then fails on the cert.
async fn probe_route(
    app: &AppHandle,
    url: &str,
    parsed: &url::Url,
) -> Result<(String, bool), String> {
    if needs_proxy(parsed) {
        Ok((ensure_proxy(app, url).await?, false))
    } else {
        Ok((
            url.trim_end_matches('/').to_string(),
            parsed.scheme() == "https",
        ))
    }
}

// True iff something is accepting on 127.0.0.1:<port>. Loopback connects
// resolve in microseconds — the SYN lands in the accept queue (even if the
// owner never calls accept()) or gets an immediate RST — so the timeout only
// guards pathological states, not the happy path.
async fn loopback_alive(port: u16) -> bool {
    matches!(
        tokio::time::timeout(
            std::time::Duration::from_millis(400),
            tokio::net::TcpStream::connect(("127.0.0.1", port)),
        )
        .await,
        Ok(Ok(_))
    )
}

// Best-effort error bucketing. reqwest's flags (is_timeout/is_connect) only
// get us so far — for DNS vs TLS vs refused we walk the source chain and
// match on substrings, since the underlying hyper/rustls errors don't have
// a stable typed API across versions.
fn categorize_error(e: &reqwest::Error) -> &'static str {
    if e.is_timeout() {
        return "timeout";
    }
    let mut source: Option<&dyn std::error::Error> = e.source();
    while let Some(err) = source {
        let s = err.to_string().to_lowercase();
        if s.contains("dns")
            || s.contains("resolve")
            || s.contains("name or service not known")
            || s.contains("nodename nor servname")
        {
            return "dns";
        }
        if s.contains("certificate")
            || s.contains("tls")
            || s.contains("ssl")
            || s.contains("self-signed")
        {
            return "tls";
        }
        if s.contains("refused") {
            return "refused";
        }
        source = err.source();
    }
    if e.is_connect() {
        return "refused";
    }
    "other"
}

// Called from JS just before window.location.href changes. We arm a Rust-side
// timer; if on_page_load Finished doesn't fire on the target origin within the
// timeout, the navigation has failed silently (WKWebView is parked on its own
// error page, our keyboard-init script never ran, no way back). The watchdog
// bounces to the launcher with ?failed=<url>, which pre-populates the error UI.
#[tauri::command]
fn watch_navigation(app: AppHandle, window: WebviewWindow, target: String, timeout_ms: u64) {
    install_nav_watchdog(app, window, target, timeout_ms);
}

// Called by browser-widget.js whenever it changes whether its iframe is
// loading an external URL via the server proxy (false) or directly (true).
// The iframe sandbox (`allow-scripts allow-forms`) still confines anything
// the page can do to the iframe — this flag only governs whether
// on_navigation hands the iframe's own external URL to Safari or lets the
// webview attempt to load it.
#[tauri::command]
fn set_browser_direct_mode(app: AppHandle, active: bool) {
    app.state::<AppState>()
        .browser_widget_direct
        .store(active, Ordering::Relaxed);
}

fn install_nav_watchdog(app: AppHandle, window: WebviewWindow, target: String, timeout_ms: u64) {
    let label = window.label().to_string();
    let token = NAV_TOKEN.fetch_add(1, Ordering::Relaxed);
    app.state::<AppState>().pending_nav.lock().unwrap().insert(
        label.clone(),
        PendingNav {
            target: target.clone(),
            token,
        },
    );
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(timeout_ms)).await;
        let should_bounce = {
            let state = app.state::<AppState>();
            let mut guard = state.pending_nav.lock().unwrap();
            let still_pending = matches!(guard.get(&label), Some(p) if p.token == token);
            if still_pending {
                guard.remove(&label);
            }
            still_pending
        };
        if should_bounce {
            navigate_to_launcher_after_failed_nav(&app, &window, &target);
        }
    });
}

// Hand off external <a target="_blank"> / window.open clicks to the system
// browser. wry 0.55's WKUIDelegate.createWebViewWithConfiguration is
// macOS-only, so on iOS those clicks silently no-op (no new webview is
// created and the request is dropped). decidePolicyFor is implemented on
// both platforms and fires for new-window actions too, so on_navigation
// gets a shot at the URL — we cancel external HTTP(S) navs and route
// through opener (UIApplication.open on iOS, NSWorkspace on macOS).
fn external_link_plugin<R: Runtime>() -> TauriPlugin<R> {
    PluginBuilder::new("painapple-external-links")
        .on_navigation(|webview, url| {
            // Custom schemes (tauri://, asset://, mailto:, data:, …) pass
            // through — only HTTP(S) navs to a non-loopback host count as
            // candidates for the external hand-off. Tauri's own asset shim
            // uses http(s)://tauri.localhost on wry, so that host is also
            // internal by definition.
            if url.scheme() != "http" && url.scheme() != "https" {
                return true;
            }
            let host = url.host_str().unwrap_or("");
            if is_loopback_host(host) || host == "tauri.localhost" {
                return true;
            }
            let target_origin = url.origin();

            // Same-origin navs (in-session link clicks while the webview is
            // already on the remote server) are always internal — Safari
            // would just open the same page we're already showing.
            if let Ok(current) = webview.url() {
                if current.origin() == target_origin {
                    return true;
                }
            }

            // Browser widget in direct mode: the JS side just toggled proxy
            // off, so the iframe's src is the raw external URL. wry can't tell
            // iframe navs from top-frame, so without this branch every direct-
            // mode load would escape to Safari. The webview itself remains
            // anchored to the server origin — only the sandboxed iframe gets
            // to attempt the navigation.
            let state = webview.state::<AppState>();
            if state.browser_widget_direct.load(Ordering::Relaxed) {
                return true;
            }

            // The launcher's cleanly-chained-HTTPS fast path navigates the
            // top frame straight to the remote URL via window.location.href
            // (launcher.js navigateToServer). Right before that, JS calls
            // watch_navigation which writes the upcoming target into
            // pending_nav. A match means this is the launcher's own nav,
            // not a target=_blank hand-off.
            let pending_match = state
                .pending_nav
                .lock()
                .unwrap()
                .values()
                .any(|p| {
                    tauri::Url::parse(&p.target)
                        .map(|u| u.origin() == target_origin)
                        .unwrap_or(false)
                });
            if pending_match {
                return true;
            }

            // Backstop for navs to a known recent server that didn't go
            // through the watchdog path (e.g. the macOS native menu's
            // recent items, or any future direct-nav code path).
            let recents_match = state
                .recents
                .lock()
                .unwrap()
                .iter()
                .any(|r| {
                    tauri::Url::parse(&r.url)
                        .map(|u| u.origin() == target_origin)
                        .unwrap_or(false)
                });
            if recents_match {
                return true;
            }

            let _ = webview
                .app_handle()
                .opener()
                .open_url(url.as_str(), None::<&str>);
            false
        })
        .build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // ClientConfig::builder() panics if no global rustls crypto provider is
    // installed. reqwest also installs ring as a side-effect of building its
    // first client; doing it here makes the order deterministic so we don't
    // depend on reqwest happening to run first.
    let _ = rustls::crypto::ring::default_provider().install_default();

    let builder = tauri::Builder::default()
        // Disable opener's built-in <a target="_blank"> click interceptor —
        // we route everything through on_navigation instead so programmatic
        // window.open() and location.href= external navs are caught too,
        // and the JS shim's permission requirement disappears.
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .plugin(external_link_plugin())
        .manage(AppState::default());

    // Local server mode (desktop only): the shell plugin does the sidecar /
    // process spawning, LocalState supervises the server child, and the
    // local_* commands drive it from the launcher. Mobile builds get the
    // base command set — the launcher hides the "This Mac" card when
    // invoke('local_status') rejects (src/local.rs).
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_shell::init())
        // Native folder picker for the local-setup wizard. The launcher calls
        // invoke('plugin:dialog|open') directly (no npm package needed).
        .plugin(tauri_plugin_dialog::init())
        .manage(local::LocalState::default())
        .invoke_handler(tauri::generate_handler![
            back_to_launcher,
            check_server_health,
            check_server_auth,
            watch_navigation,
            start_proxy,
            new_window,
            open_launcher_popup,
            close_self,
            set_session_name,
            set_browser_direct_mode,
            save_recents,
            load_recents,
            local::local_status,
            local::local_provision,
            local::local_start,
            local::local_stop,
            local::local_logs,
            local::local_install_claude,
            local::local_tool,
            local::local_docker_state,
            local::local_docker_remove_profile,
            local::local_seed_claude,
            local::local_probe_dir,
        ]);
    #[cfg(not(desktop))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        back_to_launcher,
        check_server_health,
        watch_navigation,
        start_proxy,
        new_window,
        open_launcher_popup,
        close_self,
        set_session_name,
        set_browser_direct_mode,
        save_recents,
        load_recents,
    ]);

    builder
        .on_page_load(|window, payload| {
            let _ = window.eval(PAGE_INIT_SCRIPT);
            // Successful load on the same origin as the pending nav target ⇒
            // navigation made it past WKWebView's network layer; cancel the
            // watchdog so a slow but successful load doesn't get bounced.
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                let state = window.state::<AppState>();
                let mut guard = state.pending_nav.lock().unwrap();
                let label = window.label();
                let matched = guard
                    .get(label)
                    .and_then(|p| tauri::Url::parse(&p.target).ok())
                    .map(|t| payload.url().origin() == t.origin())
                    .unwrap_or(false);
                if matched {
                    guard.remove(label);
                }
            }
        })
        .setup(|app| {
            // Capture the launcher's initial URL so the "New Connection" menu
            // item can navigate the webview back to it after the user has
            // navigated off to a remote pAInapple server.
            if let Some(window) = app.get_webview_window("main") {
                if let Ok(initial_url) = window.url() {
                    *app.state::<AppState>().launcher_url.lock().unwrap() =
                        Some(initial_url);
                }
            }

            // Seed recents from the Rust-side disk copy (mirrored on every
            // launcher saveRecent) so menus / dock / quick actions are
            // populated before the launcher loads — and stay correct even if
            // WKWebView localStorage was lost. serde ignores the extra
            // token/lastUsed fields the file carries; tokens never enter
            // AppState (matching the recents-changed payload, which strips
            // them too).
            let disk_recents: Vec<RecentEntry> = read_persisted(app.handle(), RECENTS_FILE)
                .and_then(|raw| serde_json::from_str(&raw).ok())
                .unwrap_or_default();
            *app.state::<AppState>().recents.lock().unwrap() = disk_recents.clone();

            #[cfg(desktop)]
            rebuild_menu(app.handle(), &disk_recents)?;
            #[cfg(target_os = "macos")]
            dock_menu::rebuild(app.handle(), &disk_recents);
            #[cfg(target_os = "ios")]
            {
                // Register the click-handler before the first rebuild so a
                // shortcut tapped before the launcher emits recents-changed
                // still routes correctly (the IMP looks the handler up
                // dynamically, but only after it's set).
                let app_handle = app.handle().clone();
                ios_quick_actions::set_handler(Box::new(move |idx| {
                    navigate_focused_to_recent(&app_handle, idx);
                }));
                ios_quick_actions::rebuild(app.handle(), &disk_recents);

                // iPad menu bar — same registration-before-rebuild ordering
                // as the quick actions, same shared action dispatcher as the
                // macOS menu bar.
                let app_handle = app.handle().clone();
                ios_menu::set_handler(Box::new(move |action| {
                    handle_menu_action(&app_handle, action);
                }));
                ios_menu::rebuild(app.handle(), &disk_recents);
            }

            // The launcher emits the recent-server list whenever it loads or
            // changes. We mirror it into Rust state and rebuild the menu so
            // recents stay reachable even after the webview has navigated to
            // a remote page (where launcher localStorage isn't accessible).
            let handle = app.handle().clone();
            app.listen("recents-changed", move |event| {
                if let Ok(recents) = serde_json::from_str::<Vec<RecentEntry>>(event.payload()) {
                    *handle.state::<AppState>().recents.lock().unwrap() = recents.clone();
                    #[cfg(desktop)]
                    {
                        let _ = rebuild_menu(&handle, &recents);
                    }
                    #[cfg(target_os = "macos")]
                    dock_menu::rebuild(&handle, &recents);
                    #[cfg(target_os = "ios")]
                    {
                        ios_quick_actions::rebuild(&handle, &recents);
                        ios_menu::rebuild(&handle, &recents);
                    }
                }
            });

            #[cfg(desktop)]
            app.on_menu_event(|app, event| {
                handle_menu_action(app, event.id().as_ref());
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(handle_run_event);
}

// iOS multi-scene path: when the system creates a new scene without an
// already-queued window (drag-from-dock split view, or external session
// activation), tao raises SceneRequested. We respond by building a
// WebviewWindow — tao's iOS layer finds the uninitialized scene and attaches
// the new UIWindow to it. Without this handler the second scene comes up
// blank and the user thinks the app crashed.
//
// GUARDED: this pairing is a latent feedback amplifier. tao requests the
// scene *before* the window build can fail, and a build that fails (or a
// window whose scene claim misses) leaves an empty scene whose connect
// fires another SceneRequested — one ⇧⌘L press once snowballed into ~100
// windows on iPad. Three defenses:
//   1. auto-spawns are deferred off the scene-connect callback (see below),
//   2. rate-limited + capped by live window count (scene_spawn_guard),
//   3. failures are logged instead of swallowed, so a recurrence is
//      diagnosable from the device console.
#[cfg(target_os = "ios")]
fn handle_run_event(app: &AppHandle, event: tauri::RunEvent) {
    match event {
        tauri::RunEvent::SceneRequested { scene, .. } => {
            // The real invariant is "at most one auto-spawned window per scene,
            // ever" — dedupe by the scene's persistent session ID so a
            // re-delivered or reconnecting scene can never double-spawn. The
            // rate/window caps below remain the breaker for runaway *fresh*
            // scenes (each gets a new ID, so dedupe alone wouldn't stop them).
            let scene_id = scene.session().persistentIdentifier().to_string();
            if !scene_spawn_guard::allow(&scene_id, app.webview_windows().len()) {
                eprintln!(
                    "SceneRequested({scene_id}): auto-spawn suppressed (dedupe/rate/window cap) — breaking a possible scene feedback loop"
                );
                return;
            }
            // Defer out of the scene-connect callback: SceneRequested is
            // emitted from inside scene:willConnectToSession:, and building a
            // window re-entrantly there can run before the connecting scene is
            // listed in connectedScenes — tao then can't claim it and requests
            // yet another scene, seeding the loop. After this hop the empty
            // scene is fully connected and gets adopted directly.
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = spawn_window(&app) {
                    eprintln!("SceneRequested: spawn_window failed: {e}");
                }
            });
        }
        // Foreground transition. After a long suspension iOS has often
        // reclaimed our loopback listener sockets (the process survives, its
        // sockets don't) — every webview then sits stuck on "can't connect
        // to 127.0.0.1" and its own reload/reconnect can never fix it,
        // because nothing serves that port anymore. Probe every registered
        // proxy and rebind the dead ones on their old ports: same port ⇒
        // same origin ⇒ the page's WS retry loop heals on its next tick, no
        // navigation and no re-login.
        //
        // The signal is Focused(true), NOT Resumed: this app runs the scene
        // lifecycle (UIApplicationSceneManifest + the delegate's
        // configurationForConnectingSceneSession), so UIKit never calls the
        // app delegate's applicationWillEnterForeground: — the hook tao's
        // Resumed hangs off. What does fire is sceneDidBecomeActive:, which
        // our tao fork forwards as Focused(true) per window. Resumed stays
        // matched as belt-and-braces in case the lifecycle ever changes.
        // Focus flaps between windows re-trigger this, which is fine: a
        // sweep over live listeners costs one loopback connect each, and
        // revive_dead_proxies dedupes concurrent runs.
        tauri::RunEvent::WindowEvent {
            event: tauri::WindowEvent::Focused(true) | tauri::WindowEvent::Resumed,
            ..
        } => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move { revive_dead_proxies(&app).await });
        }
        _ => {}
    }
}

// Rebind loopback proxies whose listener died while the app was suspended.
// Runs on every foreground transition; probing a live listener is one
// loopback connect, so the healthy case costs microseconds per proxy.
#[cfg(target_os = "ios")]
async fn revive_dead_proxies(app: &AppHandle) {
    use std::sync::atomic::{AtomicBool, Ordering};
    // Resumed arrives once per window — one sweep at a time is plenty.
    static IN_FLIGHT: AtomicBool = AtomicBool::new(false);
    if IN_FLIGHT.swap(true, Ordering::SeqCst) {
        return;
    }

    let snapshot: Vec<(String, u16)> = {
        let state = app.state::<AppState>();
        let proxies = state.proxies.lock().unwrap();
        proxies.iter().map(|(k, v)| (k.clone(), *v)).collect()
    };
    for (key, old_port) in snapshot {
        // The registry key is an origin serialization ("https://host:port"),
        // which parses as a URL — ensure_proxy probes the cached port and
        // rebinds in place when it's dead; on a live one this is a no-op.
        match ensure_proxy(app, &key).await {
            Ok(base) => {
                let new_port = url::Url::parse(&base).ok().and_then(|u| u.port());
                if let Some(new_port) = new_port {
                    if new_port != old_port {
                        renavigate_origin(app, old_port, new_port);
                    }
                }
            }
            Err(e) => eprintln!("resume: proxy revival for {key} failed: {e}"),
        }
    }

    IN_FLIGHT.store(false, Ordering::SeqCst);
}

// Rare fallback for revival landing on a different port (something else
// grabbed the old one while we were suspended): any window still parked on
// the dead origin would retry it forever, so move it to the new port,
// keeping path + query. Costs a login (different origin ⇒ no cookie), but
// beats a window that can only be fixed by killing the app.
#[cfg(target_os = "ios")]
fn renavigate_origin(app: &AppHandle, old_port: u16, new_port: u16) {
    for window in app.webview_windows().values() {
        let Ok(mut current) = window.url() else { continue };
        if current.host_str() != Some("127.0.0.1") || current.port() != Some(old_port) {
            continue;
        }
        if current.set_port(Some(new_port)).is_ok() {
            let _ = window.navigate(current);
        }
    }
}

// Loop breaker for the SceneRequested → spawn_window amplifier. Legitimate
// external scene creation (drag-from-dock, split view, session restore) is
// human-paced or bounded; anything faster/bigger is a feedback loop and
// gets suppressed. Manual window creation (menus / JS invoke) is never
// throttled — this guards only the autonomous path.
#[cfg(target_os = "ios")]
mod scene_spawn_guard {
    use std::sync::Mutex;
    use std::time::{Duration, Instant};

    static RECENT_SPAWNS: Mutex<Vec<Instant>> = Mutex::new(Vec::new());
    // Scene session IDs we've already answered with a spawn — one window
    // per scene, ever. Bounded ring below so it can't grow unbounded over
    // a long-lived process.
    static SPAWNED_SCENES: Mutex<Vec<String>> = Mutex::new(Vec::new());
    // ≤3 auto-spawns per rolling 5s, and never past 12 live windows. A
    // human juggling scenes stays far under both; the observed runaway
    // (~100 windows in under a minute) is far over.
    const WINDOW: Duration = Duration::from_secs(5);
    const MAX_IN_WINDOW: usize = 3;
    const MAX_LIVE_WINDOWS: usize = 12;
    const MAX_REMEMBERED_SCENES: usize = 64;

    pub fn allow(scene_id: &str, live_windows: usize) -> bool {
        if live_windows >= MAX_LIVE_WINDOWS {
            return false;
        }
        let mut seen = SPAWNED_SCENES.lock().unwrap();
        if seen.iter().any(|s| s == scene_id) {
            return false;
        }
        let now = Instant::now();
        let mut spawns = RECENT_SPAWNS.lock().unwrap();
        spawns.retain(|t| now.duration_since(*t) < WINDOW);
        if spawns.len() >= MAX_IN_WINDOW {
            return false;
        }
        spawns.push(now);
        if seen.len() >= MAX_REMEMBERED_SCENES {
            seen.remove(0);
        }
        seen.push(scene_id.to_string());
        true
    }
}

#[cfg(not(target_os = "ios"))]
#[allow(unused_variables)]
fn handle_run_event(app: &AppHandle, event: tauri::RunEvent) {
    // Desktop: reap the supervised local server on quit so it doesn't
    // linger headless after the app window is gone (local.rs shutdown —
    // SIGTERM, short grace, then kill).
    #[cfg(desktop)]
    if let tauri::RunEvent::Exit = event {
        local::shutdown(app);
    }
}

// Single dispatcher for every menu-style surface: the macOS menu bar and
// Dock right-click menu (via on_menu_event / muda's shared event channel)
// and the iPad menu bar (via ios_menu's injected action selector). All of
// them speak the same string IDs.
fn handle_menu_action(app: &AppHandle, id: &str) {
    // Window-creating branches are deferred onto the async runtime instead
    // of running inline. On iPad this handler is called synchronously from
    // inside a UIKit menu-action callback, and building a scene-backed
    // window re-entrantly there proved explosive (one ⇧⌘L press → runaway
    // window creation; see the SceneRequested guard above handle_run_event).
    // The hop reproduces the JS `invoke` path — command handlers run on the
    // async runtime and message the main loop — which has always been safe.
    // macOS never showed the problem, but the deferred path is identical to
    // its proven command path too, so both platforms take it.
    if id == "new-window" {
        // macOS: alias to the launcher popup — Cmd+Shift+N following the
        // macOS "New Window" convention while keeping behaviour identical
        // to Cmd+Shift+L, so neither chord surprises the user.
        // iPad: spawn a real scene, matching the system File > New Window
        // item that ios_menu removed (scene placement is the OS's job, and
        // a popup-flagged launcher would render a pointless close-X there).
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            #[cfg(not(target_os = "ios"))]
            let result = open_launcher_popup(app);
            #[cfg(target_os = "ios")]
            let result = spawn_window(&app).map(|_| ());
            if let Err(e) = result {
                eprintln!("new-window failed: {e}");
            }
        });
        return;
    }
    if id == "back-to-launcher" {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = open_launcher_popup(app) {
                eprintln!("open_launcher_popup failed: {e}");
            }
        });
        return;
    }
    if id == "reload-page" {
        // Same effect as the web client's own Cmd+R binding, but reachable
        // from the menu on pages that can't help themselves (launcher,
        // proxy error page, wedged remote page).
        if let Some(window) = focused_window(app) {
            let _ = window.eval("window.location.reload()");
        }
        return;
    }
    if id == "close-window" {
        if let Some(window) = focused_window(app) {
            let _ = window.destroy();
        }
        return;
    }
    if id == "quit" {
        app.exit(0);
        return;
    }
    if let Some(idx_str) = id.strip_prefix("recent-") {
        if let Ok(idx) = idx_str.parse::<usize>() {
            navigate_focused_to_recent(app, idx);
        }
    }
}

#[cfg(desktop)]
fn rebuild_menu(app: &AppHandle, recents: &[RecentEntry]) -> tauri::Result<()> {
    let app_name = "pAInapple Code";

    // Custom "Close Window" steals Cmd+Q from the standard Quit item — the
    // user found "quit all windows" too easy to trigger accidentally and
    // prefers Cmd+Q to mean "close just this one". Quit stays in the menu
    // without an accelerator so it's still reachable (dock right-click also
    // works); users who really want a keystroke can quit via Cmd+H + dock.
    let close_window = MenuItemBuilder::with_id("close-window", "Close Window")
        .accelerator("CmdOrCtrl+Q")
        .build(app)?;
    let quit_item = MenuItemBuilder::with_id("quit", format!("Quit {app_name}")).build(app)?;

    let app_menu = SubmenuBuilder::new(app, app_name)
        .item(&PredefinedMenuItem::about(app, Some(app_name), None)?)
        .separator()
        .item(&PredefinedMenuItem::hide(app, None)?)
        .item(&PredefinedMenuItem::hide_others(app, None)?)
        .item(&PredefinedMenuItem::show_all(app, None)?)
        .separator()
        .item(&close_window)
        .separator()
        .item(&quit_item)
        .build()?;

    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .item(&PredefinedMenuItem::undo(app, None)?)
        .item(&PredefinedMenuItem::redo(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::cut(app, None)?)
        .item(&PredefinedMenuItem::copy(app, None)?)
        .item(&PredefinedMenuItem::paste(app, None)?)
        .item(&PredefinedMenuItem::select_all(app, None)?)
        .build()?;

    // View: Reload Page mirrors the web client's own Cmd+R binding (both are
    // a plain location.reload()) — the native item shadows the in-page one,
    // but it also works where the page can't help: the launcher, a proxy
    // error page, or a wedged remote page.
    let reload = MenuItemBuilder::with_id("reload-page", "Reload Page")
        .accelerator("CmdOrCtrl+R")
        .build(app)?;
    let view_menu = SubmenuBuilder::new(app, "View")
        .item(&reload)
        .separator()
        .item(&PredefinedMenuItem::fullscreen(app, None)?)
        .build()?;

    let new_win = MenuItemBuilder::with_id("new-window", "New Window")
        .accelerator("CmdOrCtrl+Shift+N")
        .build(app)?;
    // Ellipsis per HIG: the item opens the launcher picker rather than
    // acting immediately.
    let back = MenuItemBuilder::with_id("back-to-launcher", "New Connection…")
        .accelerator("CmdOrCtrl+Shift+L")
        .build(app)?;

    let mut server_sub = SubmenuBuilder::new(app, "Server")
        .item(&new_win)
        .item(&back);
    if !recents.is_empty() {
        let sep = PredefinedMenuItem::separator(app)?;
        server_sub = server_sub.item(&sep);
        for (idx, entry) in recents.iter().enumerate() {
            let label = match entry.name.as_deref().filter(|s| !s.is_empty()) {
                Some(n) => n.to_string(),
                None => entry.url.clone(),
            };
            let mut item_builder =
                MenuItemBuilder::with_id(format!("recent-{idx}"), label);
            // Cmd+Alt+1..9 jumps straight to a saved server. Plain Cmd+1..9
            // is off-limits: the web client binds it to tab switching.
            if idx < 9 {
                item_builder = item_builder.accelerator(format!("Cmd+Alt+{}", idx + 1));
            }
            let item = item_builder.build(app)?;
            server_sub = server_sub.item(&item);
        }
    }
    let server_menu = server_sub.build()?;

    // Window: Minimize/Zoom plus the AppKit-managed open-window list —
    // set_as_windows_menu_for_nsapp hands the submenu to NSApp.windowsMenu,
    // which appends the live window entries below our items.
    let window_menu = SubmenuBuilder::new(app, "Window")
        .item(&PredefinedMenuItem::minimize(app, None)?)
        .item(&PredefinedMenuItem::maximize(app, Some("Zoom"))?)
        .separator()
        .item(&PredefinedMenuItem::bring_all_to_front(app, None)?)
        .build()?;

    let menu = MenuBuilder::new(app)
        .item(&app_menu)
        .item(&edit_menu)
        .item(&view_menu)
        .item(&server_menu)
        .item(&window_menu)
        .build()?;
    app.set_menu(menu)?;
    #[cfg(target_os = "macos")]
    let _ = window_menu.set_as_windows_menu_for_nsapp();
    Ok(())
}

// In-place return to the launcher — used by the proxy's error-page "Back to
// launcher" button and by the failed-nav watchdog bounce. The user-driven
// shortcut Cmd+Shift+L goes through `open_launcher_popup` instead; this path
// is reserved for cases where the current page is already dead.
fn navigate_to_launcher(app: &AppHandle, window: &WebviewWindow) {
    app.state::<AppState>()
        .pending_nav
        .lock()
        .unwrap()
        .remove(window.label());

    // The recent we navigated to may have set a session title; reset it
    // since that name no longer applies once we're back on the launcher.
    let _ = window.set_title(&format_window_title(""));

    navigate_to_launcher_with_query(app, window, &[("manual", "1")]);
}

// Bounce after the watchdog detected a failed navigation. The launcher's JS
// reads ?failed=<url> and pre-populates the Recheck / Try-anyway error UI so
// the user doesn't have to figure out what went wrong from a blank screen.
fn navigate_to_launcher_after_failed_nav(
    app: &AppHandle,
    window: &WebviewWindow,
    failed_target: &str,
) {
    navigate_to_launcher_with_query(app, window, &[("failed", failed_target)]);
}

fn navigate_to_launcher_with_query(
    app: &AppHandle,
    window: &WebviewWindow,
    query_pairs: &[(&str, &str)],
) {
    let url = app.state::<AppState>().launcher_url.lock().unwrap().clone();
    if let Some(mut u) = url {
        u.set_query(None);
        if !query_pairs.is_empty() {
            u.query_pairs_mut().extend_pairs(query_pairs.iter().copied());
        }
        let _ = window.navigate(u);
    }
}

fn navigate_to_url(app: &AppHandle, window: &WebviewWindow, url: &str) {
    if let Ok(parsed) = tauri::Url::parse(url) {
        let _ = window.navigate(parsed);
        // Same 15s watchdog as the JS-driven path so menu-picked recents
        // get the same "bounce to launcher with ?failed=" safety net.
        install_nav_watchdog(app.clone(), window.clone(), url.to_string(), 15_000);
    }
}

// Single navigate-to-recent-by-index entry point used by every menu-style
// surface: macOS menu-bar Server submenu, macOS Dock right-click menu, and
// iOS Quick Actions. Looks up the recent entry, retitles the window, and
// kicks off the same proxy + navigate + watchdog flow the launcher uses.
//
// Caller-agnostic so the iOS Quick Actions IMP can drive it through a
// registered handler without dragging in the menu-event machinery.
fn navigate_focused_to_recent(app: &AppHandle, idx: usize) {
    let Some(window) = focused_window(app) else { return };
    let entry = app
        .state::<AppState>()
        .recents
        .lock()
        .unwrap()
        .get(idx)
        .cloned();
    let Some(e) = entry else { return };

    // Mirror the JS-side title update so menu/Quick-Action-picked recents
    // get the same per-window naming as ones chosen from the launcher form.
    let title_name = e.name.clone().unwrap_or_default();
    let _ = window.set_title(&format_window_title(&title_name));

    // ensure_proxy is the single routing decision (see needs_proxy): it
    // hands back a live loopback-proxy origin for targets that need one
    // (https+IP/mDNS, plain http) and the target's own origin for everything
    // WKWebView can load directly (loopback, https domains with real certs).
    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        let url = match ensure_proxy(&app_clone, &e.url).await {
            Ok(base) => base,
            // Fall back to the original URL — the watchdog's failed-nav
            // UI is a better signal than a silent recent-pick.
            Err(_) => e.url.clone(),
        };
        navigate_to_url(&app_clone, &window, &url);
    });
}

// Resolve "the window the user is currently looking at" so menu/Dock-driven
// navigations land where attention is, not always on "main". On iOS each
// scene is its own webview window; is_focused tracks the foreground scene.
// Used by macOS menu/Dock and iOS Quick Actions, so it lives outside the
// desktop cfg gate.
fn focused_window(app: &AppHandle) -> Option<WebviewWindow> {
    let windows = app.webview_windows();
    for w in windows.values() {
        if w.is_focused().unwrap_or(false) {
            return Some(w.clone());
        }
    }
    windows.get("main").cloned().or_else(|| windows.values().next().cloned())
}
