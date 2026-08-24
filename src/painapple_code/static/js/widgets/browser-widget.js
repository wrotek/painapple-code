/**
 * Browser Widget
 *
 * Floating browser-like panel that loads external URLs or renders local
 * HTML files. External URLs are fetched through /api/browser/proxy which
 * strips frame-blocking headers and rewrites every sub-resource URL to
 * route back through the proxy. Local HTML goes through /api/browser/render.
 *
 * Per-session state: each chat session keeps its own URL, back/forward
 * history, and iframe — same model as the terminal widget. The user can
 * still override the widget's visibility scope (session/project/all-sessions
 * /global) from the header dropdown; that's a separate concern handled by
 * the widget framework.
 *
 * Iframes are always sandboxed (`sandbox="allow-scripts allow-forms"`):
 *   - Scripts run, but in a null origin → no access to app cookies,
 *     localStorage, or auth-protected APIs.
 *   - allow-forms keeps basic form submission usable.
 *   - Without `allow-popups`, the page cannot call window.open() or
 *     navigate via target="_blank" — which previously let proxied pages
 *     pop new tabs in the host browser (iPad Safari "escape" bug).
 *   - Without `allow-top-navigation`, the page cannot redirect the host
 *     window via window.location or meta-refresh.
 *
 * Link clicks within proxied pages still navigate because the server
 * rewrites every <a href> to /api/browser/proxy?url=... — the iframe
 * navigates *itself* to that URL, which is in-bounds for sandboxed nav.
 */

import S from '../strings.js';
import { escapeHtml } from '../utils.js';
import { CONFIG, debug } from '../config.js';
import { WidgetManager, ICONS } from '../widget-system/index.js';
import { isAbsolutePath } from '../path-utils.js';

const STORAGE_KEY = 'claude-code-browser-last-url';
const PROXY_PREF_KEY = 'claude-code-browser-proxy-enabled';

// Last URL is per-session (key suffixed with the session id) so navigating
// in one session doesn't become another session's mount default.
function lastUrlKey(sessionId) {
    return `${STORAGE_KEY}:${sessionId || '__null__'}`;
}

// Per-user, not per-session: the pref lives in localStorage and applies
// to every browser-widget instance. Default ON — proxy embeds X-Frame-
// Options-protected sites; switching it off is a deliberate user choice
// to trade compat for fidelity.
let proxyEnabled = (() => {
    try { return localStorage.getItem(PROXY_PREF_KEY) !== 'false'; }
    catch (e) { return true; }
})();

// On Tauri (iPad/macOS native app), `external_link_plugin.on_navigation`
// can't tell an iframe load from a top-frame nav (wry 0.55 doesn't expose
// WKNavigationAction.targetFrame), so it routes every external URL to
// Safari — including the iframe's own src in direct mode. Telling Rust
// "the widget is in direct mode" lets it skip the escape so the iframe
// can actually try to load the URL (and show X-Frame-Options errors in
// place, as the user expects).
async function setTauriDirectMode(active) {
    if (!window.__TAURI__?.core) return;
    try { await window.__TAURI__.core.invoke('set_browser_direct_mode', { active }); }
    catch (e) { /* command not present in older app builds — silently ignore */ }
}

// ── Per-session state ────────────────────────────────────────────
// Mirrors the terminal widget's pattern: each session gets its own
// state object, fetched on demand by sessionId.

function makeState(sessionId) {
    return {
        sessionId,            // owning session — keys the persisted last URL
        container: null,
        iframe: null,
        urlInput: null,
        current: '',          // raw URL as the user entered it
        resolved: '',         // URL actually loaded into the iframe
        isLocal: false,       // serving via /api/browser/render
        isExternal: false,    // serving via /api/browser/proxy
        history: [],
        historyIdx: -1,
    };
}

const sessionStates = new Map();

function getState(sessionId) {
    if (!sessionId) sessionId = WidgetManager.currentSessionId || '__null__';
    if (!sessionStates.has(sessionId)) sessionStates.set(sessionId, makeState(sessionId));
    return sessionStates.get(sessionId);
}

// ══════════════════════════════════════════════════════════════════
// URL normalization
// ══════════════════════════════════════════════════════════════════

function classify(raw) {
    const t = (raw || '').trim();
    if (!t) return { kind: 'empty' };
    if (/^https?:\/\//i.test(t)) return { kind: 'external', url: t };
    if (t.startsWith('file://') || isAbsolutePath(t) || t.startsWith('~') || t.startsWith('./')) {
        return { kind: 'local', path: t };
    }
    // Heuristic: bare domain → external https
    if (/^[\w-]+\.[\w.-]+/i.test(t) && !t.includes(' ')) {
        return { kind: 'external', url: 'https://' + t };
    }
    return { kind: 'local', path: t };
}

function buildIframeSrc(raw) {
    const c = classify(raw);
    if (c.kind === 'empty') return { src: '', isLocal: false, isExternal: false, normalized: '' };
    if (c.kind === 'external') {
        // Direct mode skips the server — gives the page its real origin and
        // cookies, at the cost of breaking on any site with X-Frame-Options
        // DENY/SAMEORIGIN or a frame-ancestors CSP.
        const src = proxyEnabled
            ? `${CONFIG.API_BASE}/api/browser/proxy?url=${encodeURIComponent(c.url)}`
            : c.url;
        return {
            src,
            isLocal: false,
            isExternal: true,
            normalized: c.url,
        };
    }
    const encoded = encodeURIComponent(c.path);
    return {
        src: `${CONFIG.API_BASE}/api/browser/render?path=${encoded}`,
        isLocal: true,
        isExternal: false,
        normalized: c.path,
    };
}

// ══════════════════════════════════════════════════════════════════
// Navigation (state-aware)
// ══════════════════════════════════════════════════════════════════

function navigate(state, raw, opts = {}) {
    const { src, isLocal, isExternal, normalized } = buildIframeSrc(raw);
    if (!src) return;

    state.current = normalized;
    state.resolved = src;
    state.isLocal = isLocal;
    state.isExternal = isExternal;

    if (!opts.fromHistory) {
        state.history = state.history.slice(0, state.historyIdx + 1);
        state.history.push(normalized);
        state.historyIdx = state.history.length - 1;
    }

    try { localStorage.setItem(lastUrlKey(state.sessionId), normalized); } catch (e) { /* */ }

    setTauriDirectMode(isExternal && !proxyEnabled);

    render(state);
}

function goBack(state) {
    if (state.historyIdx <= 0) return;
    state.historyIdx -= 1;
    navigate(state, state.history[state.historyIdx], { fromHistory: true });
}

function goForward(state) {
    if (state.historyIdx >= state.history.length - 1) return;
    state.historyIdx += 1;
    navigate(state, state.history[state.historyIdx], { fromHistory: true });
}

function reload(state) {
    if (state.iframe && state.resolved) {
        state.iframe.src = 'about:blank';
        requestAnimationFrame(() => {
            if (state.iframe) state.iframe.src = state.resolved;
        });
    }
}

function goHome(state) {
    state.current = '';
    state.resolved = '';
    state.isLocal = false;
    state.isExternal = false;
    state.history = [];
    state.historyIdx = -1;
    try { localStorage.removeItem(lastUrlKey(state.sessionId)); } catch (e) { /* */ }
    setTauriDirectMode(false);
    render(state);
}

function openInNewTab(state) {
    if (!state.current) return;
    const c = classify(state.current);
    const url = c.kind === 'external' ? c.url : state.resolved;
    window.open(url, '_blank', 'noopener,noreferrer');
}

function toggleProxy(state) {
    proxyEnabled = !proxyEnabled;
    try { localStorage.setItem(PROXY_PREF_KEY, String(proxyEnabled)); } catch (e) { /* */ }
    // Reload through the new mode. fromHistory so we don't push a duplicate
    // history entry — the URL didn't change, only the delivery path did.
    // Other sessions' iframes stay on their old src until they re-mount;
    // the mount-time stale-check in registerBrowserWidget catches that.
    if (state.current) {
        navigate(state, state.current, { fromHistory: true });
    } else {
        setTauriDirectMode(false);
        render(state);
    }
}

// ══════════════════════════════════════════════════════════════════
// RENDER
// ══════════════════════════════════════════════════════════════════

function render(state) {
    if (!state.container) return;

    // Idempotence: if the iframe already shows this exact URL, don't rebuild
    // the innerHTML — that would destroy and recreate the iframe element,
    // forcing a re-fetch and re-running page JS.
    const existing = state.container.querySelector('.br-frame');
    if (existing && existing.getAttribute('src') === state.resolved && state.resolved) {
        return;
    }

    const canBack = state.historyIdx > 0;
    const canFwd = state.historyIdx < state.history.length - 1;
    const sandboxAttr = 'sandbox="allow-scripts allow-forms"';

    state.container.innerHTML = `
        <div class="br-toolbar">
            <button class="br-nav-btn" data-action="back" ${canBack ? '' : 'disabled'} title="Back">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>
            </button>
            <button class="br-nav-btn" data-action="forward" ${canFwd ? '' : 'disabled'} title="Forward">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
            </button>
            <button class="br-nav-btn" data-action="reload" title="Reload">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
            </button>
            <button class="br-nav-btn" data-action="home" title="Home">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12l9-9 9 9"/><path d="M5 10v10h14V10"/></svg>
            </button>
            <div class="br-url-wrap">
                ${state.current ? `<span class="br-scheme-badge ${state.isLocal ? 'local' : 'external'}">${state.isLocal ? 'file' : 'web'}</span>` : ''}
                ${(state.isExternal || !state.current) ? `
                <button class="br-proxy-toggle ${proxyEnabled ? 'on' : 'off'}" type="button"
                    data-action="toggle-proxy"
                    data-tooltip="${escapeHtml(proxyEnabled ? S.widgets.browser.proxy_on_notice : S.widgets.browser.proxy_off_notice)}"
                    aria-label="${escapeHtml(proxyEnabled ? S.widgets.browser.proxy_on_notice : S.widgets.browser.proxy_off_notice)}"
                    aria-pressed="${proxyEnabled ? 'true' : 'false'}">
                    ${proxyEnabled
                        ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="19" r="3"/><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15"/><circle cx="18" cy="5" r="3"/></svg>`
                        : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="19" r="3"/><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15"/><circle cx="18" cy="5" r="3"/><line x1="3" y1="3" x2="21" y2="21"/></svg>`}
                </button>` : ''}
                <input type="text" class="br-url" value="${escapeHtml(state.current)}"
                    placeholder="${escapeHtml(S.widgets.browser.url_placeholder)}"
                    autocomplete="off" spellcheck="false" />
                <div class="br-url-ac"></div>
                ${(state.current && state.isLocal) ? `
                <button class="br-open-preview" type="button" data-action="open-preview"
                    data-tooltip="${escapeHtml(S.widgets.browser.open_in_preview)}"
                    aria-label="${escapeHtml(S.widgets.browser.open_in_preview)}">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                </button>` : ''}
                ${state.current ? `
                <button class="br-open-system" type="button" data-action="open-system"
                    data-tooltip="${escapeHtml(S.widgets.browser.open_in_safari)}"
                    aria-label="${escapeHtml(S.widgets.browser.open_in_safari)}">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/></svg>
                </button>` : ''}
            </div>
        </div>
        <div class="br-frame-wrap">
            ${state.resolved
                ? `<iframe class="br-frame" ${sandboxAttr} src="${escapeHtml(state.resolved)}"
                       referrerpolicy="no-referrer"
                       scrolling="yes"
                       allow="fullscreen"></iframe>`
                : `<div class="br-empty">
                    <svg class="br-empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
                    <div class="br-empty-title">${escapeHtml(S.widgets.browser.empty_title)}</div>
                    <div class="br-empty-hint">${escapeHtml(S.widgets.browser.empty_hint)}</div>
                    <div class="br-empty-warning">
                        <div class="br-warning-title">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                            ${escapeHtml(S.widgets.browser.empty_warning_title)}
                        </div>
                        <div class="br-warning-lead">${escapeHtml(S.widgets.browser.empty_warning_lead)}</div>
                        <ul class="br-warning-points">
                            ${S.widgets.browser.empty_warning_points.map(p => `<li>${escapeHtml(p)}</li>`).join('')}
                        </ul>
                    </div>
                </div>`}
        </div>
    `;

    state.iframe = state.container.querySelector('.br-frame');
    state.urlInput = state.container.querySelector('.br-url');

    attachHandlers(state);
}

function attachHandlers(state) {
    const root = state.container;
    if (!root) return;

    root.querySelectorAll('.br-nav-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const action = btn.dataset.action;
            if (action === 'back') goBack(state);
            else if (action === 'forward') goForward(state);
            else if (action === 'reload') reload(state);
            else if (action === 'home') goHome(state);
        });
    });

    const proxyBtn = root.querySelector('.br-proxy-toggle');
    if (proxyBtn) {
        proxyBtn.addEventListener('click', () => toggleProxy(state));
    }

    const openSystemBtn = root.querySelector('.br-open-system');
    if (openSystemBtn) {
        openSystemBtn.addEventListener('click', () => openInNewTab(state));
    }

    const openPreviewBtn = root.querySelector('.br-open-preview');
    if (openPreviewBtn) {
        openPreviewBtn.addEventListener('click', () => window.app?.previewFile(state.current));
    }

    if (state.urlInput) {
        attachUrlAutocomplete(state, root.querySelector('.br-url-ac'));
        state.urlInput.addEventListener('focus', () => state.urlInput.select());
    }
}

// ══════════════════════════════════════════════════════════════════
// Local-path autocomplete for the URL input
// ══════════════════════════════════════════════════════════════════

const AC_LIMIT = 12;

// "/a/b/par" → { dir: "/a/b/", partial: "par" }. Null when there's no
// directory part to list yet (e.g. bare "~").
function splitPathInput(value) {
    const idx = value.lastIndexOf('/');
    if (idx === -1) return null;
    return { dir: value.slice(0, idx + 1), partial: value.slice(idx + 1) };
}

// Dropdown state lives in this closure: it's bound to one DOM instance
// and dies with it on the next render() innerHTML rebuild.
function attachUrlAutocomplete(state, box) {
    const input = state.urlInput;
    let items = [];          // current suggestions: {name, path, is_dir}
    let selected = -1;
    let seq = 0;             // guards against out-of-order fetch responses
    let cache = { dir: null, files: null };
    let debounceTimer = null;

    const close = () => {
        items = [];
        selected = -1;
        if (box) { box.innerHTML = ''; box.classList.remove('open'); }
    };

    const renderList = () => {
        if (!box) return;
        if (!items.length) { close(); return; }
        box.innerHTML = items.map((f, i) => `
            <div class="br-ac-item ${i === selected ? 'selected' : ''}" data-idx="${i}">
                <span class="br-ac-icon">${f.is_dir ? ICONS.folder : ICONS.file}</span>
                <span class="br-ac-name">${escapeHtml(f.name)}${f.is_dir ? '/' : ''}</span>
            </div>`).join('');
        box.classList.add('open');
        box.querySelectorAll('.br-ac-item').forEach(el => {
            // pointerdown fires before the input's blur, so the click lands
            el.addEventListener('pointerdown', e => {
                e.preventDefault();
                complete(items[+el.dataset.idx]);
            });
        });
    };

    const complete = (item) => {
        if (!item) return;
        const split = splitPathInput(input.value.trim());
        const next = (split ? split.dir : '') + item.name + (item.is_dir ? '/' : '');
        input.value = next;
        input.focus();
        // Invalidate synchronously — update() refills async, and until then
        // an Enter must navigate, not re-complete a stale selection
        items = [];
        selected = -1;
        if (item.is_dir) {
            update();        // drill into the completed directory
        } else {
            close();
            navigate(state, next);
        }
    };

    const update = async () => {
        const value = input.value.trim();
        if (classify(value).kind !== 'local') { close(); return; }
        const split = splitPathInput(value);
        if (!split) { close(); return; }

        const mySeq = ++seq;
        let files = cache.dir === split.dir ? cache.files : null;
        if (!files) {
            try {
                const resp = await fetch(`${CONFIG.API_BASE}/api/files?path=${encodeURIComponent(split.dir)}`);
                if (!resp.ok) { if (mySeq === seq) close(); return; }
                files = (await resp.json()).files || [];
                cache = { dir: split.dir, files };
            } catch (e) {
                if (mySeq === seq) close();
                return;
            }
        }
        if (mySeq !== seq) return;   // a newer keystroke superseded this fetch

        const q = split.partial.toLowerCase();
        // Hide dotfiles unless the user is explicitly typing a dot-prefix
        const matches = files.filter(f =>
            f.name.toLowerCase().startsWith(q) && (q.startsWith('.') || !f.name.startsWith('.')));
        items = [...matches.filter(f => f.is_dir), ...matches.filter(f => !f.is_dir)].slice(0, AC_LIMIT);
        selected = -1;
        renderList();
    };

    input.addEventListener('input', () => {
        // The shown list no longer matches the text — a selection made on
        // the old list must not be Enter-completable against the new one
        selected = -1;
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(update, 120);
    });

    input.addEventListener('keydown', e => {
        const open = items.length > 0;
        if (open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault();
            const d = e.key === 'ArrowDown' ? 1 : -1;
            selected = (selected + d + items.length) % items.length;
            renderList();
        } else if (open && e.key === 'Tab') {
            e.preventDefault();
            complete(items[selected === -1 ? 0 : selected]);
        } else if (open && e.key === 'Escape') {
            // Just close the dropdown — don't let the widget's own
            // Escape handling close the whole browser
            e.preventDefault();
            e.stopPropagation();
            close();
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (open && selected !== -1) {
                complete(items[selected]);
            } else {
                close();
                navigate(state, input.value);
            }
        }
    });

    // Delay lets a pointerdown on a suggestion complete before teardown
    input.addEventListener('blur', () => setTimeout(close, 150));
}

// ══════════════════════════════════════════════════════════════════
// REGISTER
// ══════════════════════════════════════════════════════════════════

export function registerBrowserWidget() {
    WidgetManager.register('browser', {
        title: S.widgets.titles.browser || 'Browser',
        icon: 'globe',
        type: 'floating',
        // Default scope is 'session' (per chat session) — same as terminal.
        // The user can override visibility via the widget's scope dropdown.
        defaultWidth: 900,
        defaultHeight: 680,

        // Header actions resolve the active session's state at click time,
        // so they always operate on whichever browser instance is visible.
        headerActions: [
            {
                icon: 'refresh',
                title: 'Reload',
                onClick: () => reload(getState()),
            },
        ],

        render(container, ctx) {
            const state = getState(ctx?.sessionId);
            state.container = container;
            container.classList.add('browser-widget');

            if (!state.current) {
                let saved = '';
                try { saved = localStorage.getItem(lastUrlKey(state.sessionId)) || ''; } catch (e) { /* */ }
                if (saved) {
                    navigate(state, saved);
                } else {
                    setTauriDirectMode(false);
                    render(state);
                }
            } else {
                // If proxyEnabled flipped while this session's widget was
                // unmounted, buildIframeSrc would now produce a different
                // src than the cached state.resolved — re-navigate so the
                // iframe reflects the current mode instead of the stale one.
                const { src } = buildIframeSrc(state.current);
                if (src && src !== state.resolved) {
                    navigate(state, state.current, { fromHistory: true });
                } else {
                    setTauriDirectMode(state.isExternal && !proxyEnabled);
                    render(state);
                }
            }
        },

        onOpen() {
            requestAnimationFrame(() => {
                const state = getState();
                state.urlInput?.focus();
                state.urlInput?.select();
                // Re-arm the Tauri direct-mode flag if the open session is
                // currently in direct mode + external — needed because the
                // flag is global state on the Rust side and may have been
                // cleared by another session's widget on close.
                setTauriDirectMode(state.isExternal && !proxyEnabled);
            });
        },

        onClose() {
            // Clear the global Tauri direct-mode allowance so a closed
            // widget's permission doesn't outlive its lifetime — otherwise
            // any later external nav (e.g. a stale link in another part of
            // the web client) would silently slip past on_navigation.
            setTauriDirectMode(false);
        },

        // Session closed — drop its state and persisted last URL so
        // per-session keys don't accumulate in localStorage forever.
        onDestroy(sessionId) {
            sessionStates.delete(sessionId);
            try { localStorage.removeItem(lastUrlKey(sessionId)); } catch (e) { /* */ }
        },
    });

    // One-time cleanup: the pre-per-session global last-url key is no
    // longer read by anything.
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* */ }

    debug.log('[BrowserWidget] registered');
}

export const BrowserWidget = {
    open: () => WidgetManager.open('browser'),
    close: () => WidgetManager.close('browser'),
    toggle: () => WidgetManager.toggle('browser'),
    navigate: (url) => {
        WidgetManager.open('browser');
        navigate(getState(), url);
    },
};
