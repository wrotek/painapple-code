// Saved-servers store. Durable: entries are never evicted — they stay until
// the user explicitly forgets them. Identity rules on save (upsertServer):
//   - same URL      → replaces the existing entry (dedup by normalized origin)
//   - same name     → replaces the entry that held that name (names are unique;
//                     re-saving "Home" with a corrected URL updates Home instead
//                     of leaving a typo'd sibling behind)
// New entries are only written after the server was reached AND the password
// verified (or via an explicit "Try anyway") — a mistyped URL or password
// never enters the list, so every saved entry is known-good.
//
// Entries carry the verified password (`token`, plaintext in localStorage —
// same trust level as the auth cookie next to it). Picking a saved server
// re-authenticates with it, so login survives cookie loss/expiry.
const STORAGE_KEY = 'painapple.recent';
const LEGACY_KEY = 'painapple.serverUrl';

const form = document.getElementById('connect');
const nameInput = document.getElementById('name');
const urlInput = document.getElementById('url');
const tokenInput = document.getElementById('token');
const rememberInput = document.getElementById('remember');
const errEl = document.getElementById('err');
const recentEl = document.getElementById('recent');

function loadRecent() {
  let recent = [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) recent = JSON.parse(raw);
  } catch { /* corrupted JSON — start fresh */ }
  if (!Array.isArray(recent)) recent = [];
  // Migrate old single-URL key, once.
  const legacy = localStorage.getItem(LEGACY_KEY);
  if (legacy) {
    if (!recent.some(r => r.url === legacy)) {
      recent.unshift({ url: legacy, lastUsed: Date.now() });
    }
    localStorage.removeItem(LEGACY_KEY);
    saveRecent(recent);
  }
  return recent;
}

function saveRecent(recent) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(recent));
  // Mirror to a Rust-side disk file (fire-and-forget). WKWebView localStorage
  // writes can be silently dropped when iOS kills the process — the native
  // copy is merged back in at startup (see the init IIFE at the bottom), so
  // a lost localStorage write can no longer lose a server entry or its
  // recency order. Same trust level as localStorage: the file carries the
  // plaintext token, inside the app sandbox.
  if (window.__TAURI__ && window.__TAURI__.core) {
    window.__TAURI__.core
      .invoke('save_recents', { recents: JSON.stringify(recent) })
      .catch(() => {});
  }
}

// Load the Rust-side disk copy of the recents. Returns [] outside Tauri or
// when the file is missing/corrupt — callers can always spread the result.
async function loadNativeRecents() {
  if (!window.__TAURI__ || !window.__TAURI__.core) return [];
  try {
    const raw = await window.__TAURI__.core.invoke('load_recents');
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

// Union of the localStorage list and the native disk copy. Dedup by URL
// (keep whichever side was used more recently, but never drop a stored
// token only one side has), then by name (names are unique — see the
// identity rules at the top of the file), newest-first so index 0 stays
// "last used".
function mergeRecents(local, native) {
  const byUrl = new Map();
  for (const e of [...native, ...local]) {
    if (!e || !e.url) continue;
    const prev = byUrl.get(e.url);
    if (!prev) {
      byUrl.set(e.url, e);
    } else if ((e.lastUsed || 0) >= (prev.lastUsed || 0)) {
      byUrl.set(e.url, (!e.token && prev.token) ? { ...e, token: prev.token } : e);
    } else if (e.token && !prev.token) {
      byUrl.set(e.url, { ...prev, token: e.token });
    }
  }
  const sorted = [...byUrl.values()].sort(
    (a, b) => (b.lastUsed || 0) - (a.lastUsed || 0)
  );
  const seenNames = new Set();
  return sorted.filter(e => {
    if (!e.name) return true;
    if (seenNames.has(e.name)) return false;
    seenNames.add(e.name);
    return true;
  });
}

// Insert-or-replace a server entry (see identity rules at the top of file).
// `replaceUrl` additionally removes the entry the user was editing, so an
// edit that changes both name and URL doesn't orphan the original.
// `token === undefined` keeps the replaced entry's stored password (lastUsed
// bumps must not drop it); pass `''` to explicitly clear it.
function upsertServer(url, name, token, replaceUrl) {
  const prior = loadRecent();
  let recent = prior.filter(r =>
    r.url !== url && (!replaceUrl || r.url !== replaceUrl)
  );
  if (name) recent = recent.filter(r => r.name !== name);
  const entry = { url, lastUsed: Date.now() };
  if (name) entry.name = name;
  const kept = token !== undefined
    ? token
    : (prior.find(r => r.url === (replaceUrl || url)) || {}).token;
  if (kept) entry.token = kept;
  recent.unshift(entry);
  saveRecent(recent);
  emitRecents();
}

function connectTarget(origin, token) {
  return token ? `${origin}/?tkn=${encodeURIComponent(token)}` : `${origin}/`;
}

function removeFromRecent(url) {
  saveRecent(loadRecent().filter(r => r.url !== url));
  renderRecent();
  emitRecents();
}

// --- Edit mode -------------------------------------------------------------
// ✎ on a saved entry pre-fills the form and remembers which entry is being
// edited. Submitting then *replaces* that entry (even if both name and URL
// changed) instead of creating a sibling. Cleared by Cancel or by picking
// another saved server.
let editingUrl = null;
const editNote = document.createElement('div');
editNote.className = 'edit-note';
editNote.hidden = true;
form.parentNode.insertBefore(editNote, form);

function enterEditMode(url, name, opts) {
  editingUrl = url;
  nameInput.value = name;
  urlInput.value = url;
  const saved = loadRecent().find(r => r.url === url);
  tokenInput.value = (saved && saved.token) || '';
  rememberInput.checked = true;
  const message = (opts && opts.message) || 'Connect saves your changes.';
  editNote.innerHTML = `
    Editing <strong>${escapeHtml(name || url)}</strong> — ${escapeHtml(message)}
    <button type="button" class="edit-cancel">Cancel</button>
  `;
  editNote.hidden = false;
  editNote.querySelector('.edit-cancel').addEventListener('click', exitEditMode);
  if (opts && opts.focusToken) {
    tokenInput.value = '';
    tokenInput.focus();
  } else {
    nameInput.focus();
  }
}

function exitEditMode() {
  editingUrl = null;
  editNote.hidden = true;
  editNote.innerHTML = '';
}

// Mirror the recents list into the Tauri native menu (desktop only — on iOS
// the menu API is a no-op and the emit is harmless). Outside Tauri (regular
// browser preview), window.__TAURI__ is undefined and this returns silently.
function emitRecents() {
  if (window.__TAURI__ && window.__TAURI__.event) {
    // Strip stored passwords — the native menu only needs url/name, and
    // credentials shouldn't sprawl into Rust-side state for no benefit.
    window.__TAURI__.event.emit(
      'recents-changed',
      loadRecent().map(({ token, ...rest }) => rest)
    );
  }
}

// Verify a password against the server's public POST /api/login (200 = ok,
// 401 = wrong password) WITHOUT navigating. Inside Tauri this goes through
// Rust — same route (proxy or direct) the navigation will use. In plain-browser
// preview a CORS-blocked or failed fetch yields 'unknown', as does an older
// server without /api/login — callers then just navigate and let the
// server's own login flow decide.
async function verifyPassword(url, password) {
  if (window.__TAURI__ && window.__TAURI__.core) {
    try {
      return await window.__TAURI__.core.invoke('check_server_auth', { url, password });
    } catch (e) {
      return { kind: 'unknown', reason: String(e) };
    }
  }
  try {
    const resp = await fetch(`${url.replace(/\/+$/, '')}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
      credentials: 'omit',
    });
    if (resp.status === 200) return { kind: 'ok' };
    if (resp.status === 401) return { kind: 'invalid' };
    return { kind: 'unknown', reason: `status ${resp.status}` };
  } catch (e) {
    return { kind: 'unknown', reason: String(e) };
  }
}

// Probe a pAInapple server's /health endpoint to decide whether navigating
// there is going to succeed. Inside Tauri we go through Rust (no CORS, real
// network errors, real timeouts, same route — proxy or direct — as the nav);
// in plain-browser dev preview we fall back to fetch — that's CORS-restricted
// but good enough for localhost testing.
async function pingServer(url) {
  if (window.__TAURI__ && window.__TAURI__.core) {
    try {
      return await window.__TAURI__.core.invoke('check_server_health', { url });
    } catch (e) {
      return { kind: 'unreachable', cause: 'other', reason: String(e) };
    }
  }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const start = performance.now();
    const resp = await fetch(`${url.replace(/\/+$/, '')}/health`, {
      signal: ctrl.signal,
      credentials: 'omit',
    });
    clearTimeout(timer);
    return {
      kind: 'reachable',
      status: resp.status,
      latencyMs: Math.round(performance.now() - start),
    };
  } catch (e) {
    return {
      kind: 'unreachable',
      cause: e.name === 'AbortError' ? 'timeout' : 'other',
      reason: String(e),
    };
  }
}

function humanizeCause(cause) {
  return ({
    timeout: 'timed out',
    dns: 'could not resolve',
    refused: 'connection refused',
    tls: 'certificate problem',
    other: 'network error',
  })[cause] || 'unreachable';
}

// Replace the inline error area with a fail card carrying Recheck + Try
// anyway buttons. Shared between form submit and recent-click failures so
// the recovery affordances stay consistent. `entry` is {url, name?}.
function showUnreachableError(result, entry, target, onWillNavigate) {
  errEl.innerHTML = `
    <span class="err-msg">
      Couldn't reach <strong>${escapeHtml(entry.url)}</strong>
      (${humanizeCause(result.cause)}).
    </span>
    <span class="err-actions">
      <button type="button" class="err-recheck">Recheck</button>
      <button type="button" class="err-anyway">Try anyway</button>
    </span>
  `;
  errEl.querySelector('.err-anyway').addEventListener('click', () => {
    if (onWillNavigate) onWillNavigate();
    navigateToServer(entry, target);
  });
  errEl.querySelector('.err-recheck').addEventListener('click', async () => {
    errEl.textContent = 'Rechecking…';
    const r = await pingServer(entry.url);
    if (r.kind === 'reachable') {
      if (onWillNavigate) onWillNavigate();
      navigateToServer(entry, target);
    } else {
      showUnreachableError(r, entry, target, onWillNavigate);
    }
  });
  errEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function navigateToServer(entry, target) {
  // Rust owns the proxy-vs-direct decision (needs_proxy in lib.rs) —
  // start_proxy returns the base origin to navigate to either way:
  //   - https + IP / localhost / .local / dotless host → http://127.0.0.1:
  //     <port>, the loopback proxy dialing upstream TLS with ANY cert
  //     accepted (self-signed — WKWebView refuses those directly, loopback
  //     included; MITM risk accepted by design)
  //   - http + non-loopback → same loopback proxy, plain TCP forward
  //     (admin opted into --tls=off; loopback origin keeps the webview's
  //     secure context: clipboard, service worker, PWA install)
  //   - https + named domain → the target's own origin, loaded DIRECTLY;
  //     WKWebView validates the cert natively (valid public cert expected)
  //     and no loopback listener is involved at all
  //   - http + loopback → the target's own origin (already a secure context)
  let navUrl = target;
  if (window.__TAURI__ && window.__TAURI__.core) {
    try {
      const base = await window.__TAURI__.core.invoke('start_proxy', {
        target: entry.url,
      });
      // Preserve the path + query (esp. ?tkn=…) when swapping in the base origin.
      const t = new URL(target);
      navUrl = `${base}${t.pathname}${t.search}`;
    } catch (e) {
      errEl.textContent = `Couldn't prepare the connection: ${e}`;
      return;
    }
  }
  // Push the chosen session's display name up to Rust so the OS window
  // title reflects it instead of the generic "pAInapple Code". The menu-
  // recent path on macOS sets the title from Rust directly; this is the
  // form/launcher equivalent.
  if (window.__TAURI__ && window.__TAURI__.core) {
    window.__TAURI__.core
      .invoke('set_session_name', { name: entry.name || '' })
      .catch(() => { /* command may not exist in older builds */ });
  }
  // Show "Connecting…" first so the user sees something happen immediately.
  // Then await arming the Rust-side watchdog — without the await, a very fast
  // page load (cached / localhost) could fire Finished before pending_nav is
  // set, and the watchdog timer would then bounce a successful navigation.
  // If the page never reaches Finished within the timeout, Rust bounces us back
  // to the launcher with ?failed=<target>, so iPhones without a keyboard never
  // get stranded on WKWebView's untouchable "can't connect" page.
  showConnecting(entry.name || entry.url);
  await installNavWatchdog(navUrl);
  window.location.href = navUrl;
}

function installNavWatchdog(target) {
  if (window.__TAURI__ && window.__TAURI__.core) {
    return window.__TAURI__.core
      .invoke('watch_navigation', { target, timeoutMs: 15000 })
      .catch(() => { /* outside Tauri, or command not registered — fine */ });
  }
  return Promise.resolve();
}

function showReconnectOverlay(entry) {
  const overlay = document.createElement('div');
  overlay.id = 'reconnect-overlay';
  overlay.innerHTML = `
    <h1>pAInapple Code</h1>
    <p class="tag">Reconnecting to ${escapeHtml(entry.name || entry.url)}…</p>
    <button type="button" class="reconnect-cancel">Cancel</button>
  `;
  document.body.appendChild(overlay);
  return overlay;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function renderRecent() {
  const recent = loadRecent();
  if (recent.length === 0) {
    recentEl.hidden = true;
    recentEl.innerHTML = '';
    return;
  }
  recentEl.hidden = false;
  recentEl.innerHTML = `
    <div class="recent-head">
      <h2>Saved servers</h2>
      <button type="button" class="recent-recheck" title="Recheck all">↻ Recheck</button>
    </div>
    <ul>
      ${recent.map(r => `
        <li>
          <button type="button" class="recent-pick" data-url="${escapeHtml(r.url)}" data-name="${escapeHtml(r.name || '')}">
            <span class="status-dot" data-status="checking" title="Checking…"></span>
            <span class="recent-info">
              ${r.name
                ? `<span class="name">${escapeHtml(r.name)}</span><span class="url">${escapeHtml(r.url)}</span>`
                : `<span class="name">${escapeHtml(r.url)}</span>`}
            </span>
          </button>
          <button type="button" class="recent-edit" data-url="${escapeHtml(r.url)}" data-name="${escapeHtml(r.name || '')}" aria-label="Edit ${escapeHtml(r.name || r.url)}" title="Edit">✎</button>
          <button type="button" class="recent-forget" data-url="${escapeHtml(r.url)}" aria-label="Forget ${escapeHtml(r.name || r.url)}" title="Forget">×</button>
        </li>
      `).join('')}
    </ul>
  `;
  recentEl.querySelectorAll('.recent-pick').forEach(btn => {
    btn.addEventListener('click', async () => {
      const url = btn.dataset.url;
      const name = btn.dataset.name || '';
      const entry = { url, name };
      exitEditMode();  // picking a server abandons any in-progress edit
      const saved = loadRecent().find(r => r.url === url) || {};
      const token = saved.token || '';
      // Legacy entry saved before passwords were stored: collect it once,
      // right here, instead of bouncing into the server's login page.
      if (!token) {
        enterEditMode(url, name, {
          message: 'Enter the password to connect (it will be saved).',
          focusToken: true,
        });
        return;
      }
      upsertServer(url, name);  // bump lastUsed → moves entry to the top (keeps token)
      // Pre-flight ping. Same flow as form submit: navigate on success, show
      // inline retry UI on failure — keeps user inside the launcher instead
      // of bouncing into WKWebView's generic "can't reach server" page.
      btn.disabled = true;
      const result = await pingServer(url);
      if (result.kind !== 'reachable') {
        btn.disabled = false;
        updateDotForUrl(url, result);
        showUnreachableError(result, entry, connectTarget(url, token));
        return;
      }
      // Reachable → check the stored password still works. If the server's
      // password changed, keep the user on the launcher with the entry ready
      // to fix instead of dumping them on the server's login page.
      const auth = await verifyPassword(url, token);
      btn.disabled = false;
      updateDotForUrl(url, result);
      if (auth.kind === 'invalid') {
        enterEditMode(url, name, {
          message: 'The saved password no longer works — enter the new one.',
          focusToken: true,
        });
        return;
      }
      // ok — or unknown (older server): connect with ?tkn= so a fresh auth
      // cookie is set even if the old one was lost.
      navigateToServer(entry, connectTarget(url, token));
    });
  });
  recentEl.querySelectorAll('.recent-edit').forEach(btn => {
    btn.addEventListener('click', () => enterEditMode(btn.dataset.url, btn.dataset.name || ''));
  });
  // Two-tap forget: first tap arms the button ("Forget?"), second tap within
  // a short window deletes. Saved entries are durable now, so a fat-finger on
  // a touch screen shouldn't be able to silently destroy one.
  recentEl.querySelectorAll('.recent-forget').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.confirm) {
        removeFromRecent(btn.dataset.url);
        return;
      }
      btn.dataset.confirm = '1';
      btn.textContent = 'Forget?';
      setTimeout(() => {
        if (btn.isConnected) {
          delete btn.dataset.confirm;
          btn.textContent = '×';
        }
      }, 2500);
    });
  });
  recentEl.querySelector('.recent-recheck').addEventListener('click', pingAllRecents);
  pingAllRecents();
}

// Probe every saved server in parallel and update the dots as results arrive.
// Independent promises so a slow / stuck host doesn't block the others.
let lastPingAllAt = 0;
let pingAllInFlight = false;
async function pingAllRecents() {
  if (pingAllInFlight) return;
  pingAllInFlight = true;
  lastPingAllAt = Date.now();
  const recent = loadRecent();
  recentEl.querySelectorAll('.status-dot').forEach(dot => {
    dot.dataset.status = 'checking';
    dot.title = 'Checking…';
  });
  const recheckBtn = recentEl.querySelector('.recent-recheck');
  if (recheckBtn) recheckBtn.disabled = true;
  try {
    await Promise.all(recent.map(async (entry) => {
      const result = await pingServer(entry.url);
      updateDotForUrl(entry.url, result);
    }));
  } finally {
    if (recheckBtn) recheckBtn.disabled = false;
    pingAllInFlight = false;
  }
}

function updateDotForUrl(url, result) {
  recentEl.querySelectorAll('.recent-pick').forEach(btn => {
    if (btn.dataset.url !== url) return;
    const dot = btn.querySelector('.status-dot');
    if (!dot) return;
    if (result.kind === 'reachable') {
      if (result.status === 200) {
        dot.dataset.status = 'reachable';
        dot.title = `Online · ${result.latencyMs}ms`;
      } else {
        // Server answered but /health returned something other than 200 —
        // probably an older painapple build or a fork without the endpoint.
        // Navigation will likely still work, hence amber not red.
        dot.dataset.status = 'reachable-odd';
        dot.title = `Reachable — /health returned ${result.status}`;
      }
    } else {
      dot.dataset.status = 'unreachable';
      dot.title = `Offline — ${humanizeCause(result.cause)}`;
    }
  });
}

function normalizeUrl(raw) {
  let u = raw.trim();
  if (!u) return null;
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  try {
    return new URL(u).origin;
  } catch {
    return null;
  }
}

// If the URL field contains a bootstrap-style query (?tkn=… and/or &fp=…),
// hoist tkn into the token field and reduce the URL field to its bare
// origin. `fp` is a legacy cert-pin fingerprint older servers still emit —
// pinning is gone (the proxy accepts any upstream cert), so it's stripped
// and ignored. Fires on any user input/paste — JS-driven .value assignments
// (recent pick, pre-fill) don't trigger 'input', so they're safe.
function maybeSplitBootstrapParams() {
  const raw = urlInput.value.trim();
  if (!raw) return;
  if (!/[?&](tkn|fp)=/i.test(raw)) return;
  let parsed;
  try {
    parsed = new URL(/^https?:\/\//i.test(raw) ? raw : 'https://' + raw);
  } catch {
    return;
  }
  const tkn = parsed.searchParams.get('tkn');
  if (tkn && !tokenInput.value) tokenInput.value = tkn;
  urlInput.value = parsed.origin;
}

urlInput.addEventListener('input', () => {
  // Strip surrounding whitespace — pasting from terminal output often drags
  // along a trailing newline, and URLs never contain spaces. Doing this on
  // every input also catches the rare "typed a space at the end" case.
  const trimmed = urlInput.value.replace(/^\s+|\s+$/g, '');
  if (trimmed !== urlInput.value) urlInput.value = trimmed;
  maybeSplitBootstrapParams();
});

// Intent flags set by Rust when navigating us here. `manual` means "user
// explicitly returned to the launcher, don't auto-reconnect them right back."
// `failed` is set by the navigation watchdog after a server load timed out —
// we use it to pre-populate the error UI for the URL that failed. `popup`
// means we're inside the small Cmd+Shift+L launcher window — render the
// close-X and bind Esc to dismiss without touching the session window.
const launchParams = new URLSearchParams(location.search);
const isManualReturn = launchParams.has('manual');
const failedUrl = launchParams.get('failed');
const isPopup = launchParams.has('popup');
if (location.search) history.replaceState(null, '', location.pathname);

// Close the current window/scene. Exposed on every launcher page (not just
// popup mode) so Cmd+W can dismiss any user-spawned launcher window —
// Cmd+Shift+L popup, Cmd+Shift+N new window, even the first-launch main
// window. The KeyCommandShim's Cmd+W handler and the PAGE_INIT_SCRIPT
// macOS handler both look for window.__painapple_close_window__.
//
// On iPadOS we go through the native painappleCloseScene message handler
// (UIApplication.requestSceneSessionDestruction is the only API that
// actually tears down a UIWindowScene; Tauri's close()/destroy() no-op).
// On macOS we use Tauri's close_self → destroy() which works for any
// NSWindow.
const closeThisWindow = () => {
  const iosHandler =
    window.webkit && window.webkit.messageHandlers
      ? window.webkit.messageHandlers.painappleCloseScene
      : null;
  if (iosHandler) {
    iosHandler.postMessage('');
    return;
  }
  if (window.__TAURI__ && window.__TAURI__.core) {
    window.__TAURI__.core.invoke('close_self').catch(() => window.close());
  } else {
    window.close();
  }
};
window.__painapple_close_window__ = closeThisWindow;

if (isPopup) {
  // Popup-only UI: X button + Esc binding. Bare launcher (Cmd+Shift+N or
  // first-launch) keeps a normal launcher form with no extra chrome — its
  // only dismiss gesture is Cmd+W (or app switcher).
  const x = document.createElement('button');
  x.type = 'button';
  x.className = 'resume-x';
  x.setAttribute('aria-label', 'Close');
  x.title = 'Close (Esc)';
  x.textContent = '×';
  x.addEventListener('click', closeThisWindow);
  document.body.appendChild(x);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeThisWindow();
    }
  });
}

// Initial render: list + pre-fill name/URL with the most recent entry.
// Async because the Rust-side disk copy of the recents is merged in first:
// WKWebView localStorage may be stale (an iOS write-loss dropped the last
// "connected to B" write) or empty, while the native file always reflects
// the last successful saveRecent(). Merging before the first render also
// means the auto-reconnect below targets the true last-used server.
(async () => {
  // Bound the IPC wait — a wedged invoke must not leave the launcher blank
  // (no list, no error card, no auto-reconnect).
  const native = await Promise.race([
    loadNativeRecents(),
    new Promise(resolve => setTimeout(() => resolve([]), 1500)),
  ]);
  const merged = mergeRecents(loadRecent(), native);
  // Write back even when the disk copy was empty or missing: this seeds
  // recents.json on the first launch after the feature ships — the pure
  // auto-reconnect path never calls saveRecent, so without this the mirror
  // would stay empty for exactly the users it's meant to protect.
  if (merged.length) saveRecent(merged);

  const initialRecent = loadRecent();
  renderRecent();
  emitRecents();
  if (initialRecent.length) {
    if (!urlInput.value) urlInput.value = initialRecent[0].url;
    if (!nameInput.value && initialRecent[0].name) nameInput.value = initialRecent[0].name;
  }

  // Failed-nav return takes priority over auto-reconnect: surface the error so
  // the user understands why they're back here instead of looking at the chat.
  if (failedUrl) {
    // failedUrl may be a proxy loopback (http://127.0.0.1:NNNN) rather than the
    // user's server origin — match by checking whether either is a prefix of
    // the other (heuristic, but good enough to find the originating entry).
    const recentEntry = initialRecent.find(r =>
      failedUrl.startsWith(r.url) || failedUrl.includes(new URL(r.url).host)
    );
    let displayUrl = failedUrl;
    try { displayUrl = recentEntry ? recentEntry.url : new URL(failedUrl).origin; } catch { /* keep failedUrl */ }
    const entry = recentEntry
      ? { url: recentEntry.url, name: recentEntry.name || '' }
      : { url: displayUrl, name: '' };
    showUnreachableError(
      { kind: 'unreachable', cause: 'timeout', reason: 'page never finished loading' },
      entry, failedUrl
    );
  } else if (!isManualReturn && initialRecent.length > 0) {
    // Auto-reconnect to the most recent server, but only if /health says it's up.
    // Cancel button gives the user a way out if the ping is slow or they want a
    // different recent. On failure we silently drop the overlay; the dots in the
    // visible launcher already reflect the real state.
    const last = initialRecent[0];
    const overlay = showReconnectOverlay(last);
    let cancelled = false;
    overlay.querySelector('.reconnect-cancel').addEventListener('click', () => {
      cancelled = true;
      overlay.remove();
    });
    const result = await pingServer(last.url);
    if (cancelled) return;
    if (result.kind !== 'reachable') {
      overlay.remove();
      updateDotForUrl(last.url, result);
      return;
    }
    // Verify the stored password before reconnecting — if it changed
    // server-side, land the user in the launcher's fix-it flow instead of
    // on the server's login page. Entries without a stored password
    // (pre-password saves) reconnect on the cookie as before.
    if (last.token) {
      const auth = await verifyPassword(last.url, last.token);
      if (cancelled) return;
      if (auth.kind === 'invalid') {
        overlay.remove();
        enterEditMode(last.url, last.name || '', {
          message: 'The saved password no longer works — enter the new one.',
          focusToken: true,
        });
        return;
      }
    }
    navigateToServer(
      { url: last.url, name: last.name || '' },
      connectTarget(last.url, last.token)
    );
  }
})();

function showConnecting(label) {
  // Replace the form UI immediately so iOS's keychain prompt (and any
  // cross-origin paint delay in WKWebView) doesn't sit on top of the
  // still-visible launcher form. By the time the new page paints, this
  // is gone anyway — but for the ~hundreds of ms in between, the user
  // sees a clean "Connecting…" state instead of a stale form with a
  // suggester floating over it.
  const main = document.querySelector('main');
  main.innerHTML = `
    <h1>pAInapple Code</h1>
    <p class="tag">Connecting to ${escapeHtml(label)}…</p>
  `;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errEl.textContent = '';
  const origin = normalizeUrl(urlInput.value);
  if (!origin) {
    errEl.textContent = 'That does not look like a valid URL.';
    return;
  }
  const token = tokenInput.value.trim();
  const name = nameInput.value.trim();
  const wasEditing = editingUrl;
  const target = connectTarget(origin, token);
  const entry = { url: origin, name };

  const submitBtn = form.querySelector('button.connect');
  const origText = submitBtn.textContent;
  submitBtn.disabled = true;
  submitBtn.textContent = 'Checking…';

  const result = await pingServer(origin);

  // Nothing is saved until the server was reached AND the password verified —
  // so a typo'd URL or a wrong password is fixable right here, and every
  // entry that lands in the list is known-good. "Try anyway" (and a later
  // successful "Recheck") is the explicit override that saves unverified —
  // it's how a temporarily-down server still gets recorded.
  const saveEntry = () => {
    if (rememberInput.checked || wasEditing) {
      upsertServer(origin, name, token, wasEditing || undefined);
    }
    exitEditMode();
  };

  if (result.kind !== 'reachable') {
    submitBtn.disabled = false;
    submitBtn.textContent = origText;
    showUnreachableError(result, entry, target, saveEntry);
    return;
  }

  submitBtn.textContent = 'Verifying…';
  const auth = await verifyPassword(origin, token);
  submitBtn.disabled = false;
  submitBtn.textContent = origText;

  if (auth.kind === 'invalid') {
    errEl.textContent = token
      ? 'Incorrect password for this server.'
      : 'This server requires a password.';
    tokenInput.focus();
    return;  // nothing saved; edit mode (if any) stays open for fixing
  }

  // ok — or unknown (older server without /api/login, CORS-blind preview):
  // save and navigate; the server's own login flow is the final arbiter.
  saveEntry();
  navigateToServer(entry, target);
});

// Re-ping when the launcher regains focus — covers the "phone slept, woke
// back up" and "switched apps and came back" cases. Debounced so flicking
// focus rapidly doesn't fire a probe storm. Uses both events because iOS
// WKWebView fires visibilitychange more reliably than window focus.
const FOCUS_REPING_MS = 5000;
function maybeReping() {
  if (Date.now() - lastPingAllAt < FOCUS_REPING_MS) return;
  if (!recentEl || recentEl.hidden) return;
  pingAllRecents();
}
window.addEventListener('focus', maybeReping);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') maybeReping();
});

// ---------------------------------------------------------------------------
// Local server card + setup wizard live in local-setup.js (desktop builds
// only — it drives the Rust local_* commands and removes the card when they
// don't exist). This file stays saved-servers-only; local-setup.js reuses
// the top-level function declarations here (navigateToServer, pingServer,
// escapeHtml) via shared script global scope.
