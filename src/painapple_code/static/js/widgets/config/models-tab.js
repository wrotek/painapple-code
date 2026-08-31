/**
 * Providers tab — everything provider-centric in Settings.
 *
 * Renders from the registry (`GET /api/providers`) and per-key server
 * config endpoints; nothing is hardcoded per provider, so a drop-in
 * provider gets its own row + sub-tab automatically. Layout:
 *
 *   1. Providers list — enable/disable toggles + "Make default"
 *      (`providers-enabled` / `default-provider` config keys).
 *   2. Provider Settings — one SUB-TAB per enabled provider selecting a
 *      single unified panel: CLI path override (generic
 *      `/api/app/provider-path/{name}` with a live version probe), a
 *      CLI login-status row (`/api/app/provider-auth/{name}` with a
 *      terminal-tab Log in handoff), the provider's model catalog — every
 *      row the same shape: a show/hide toggle
 *      (`/api/app/provider-models/{name}`, persisted per shared
 *      `models_key` so driver variants agree) and id/label/desc fields,
 *      editable when the app owns the catalog (`models_editable`,
 *      models.yaml via `/api/app/models`), readonly when the provider's
 *      own CLI manages the definitions (e.g. Codex's models_cache.json) —
 *      then the provider's NEW SESSION DEFAULTS (model / effort / account,
 *      `/api/app/provider-defaults/{name}` → per-provider config maps
 *      keyed by `models_key`, legacy flat keys migrate on first write)
 *      and its AUTO-JOURNAL model (same endpoint; Claude stores it in
 *      models.yaml, Codex in `codex_summary_model`, empty = inherit the
 *      session's model).
 *
 * The module-level `_tab` cache is just a working copy while the tab is
 * open; every mutation writes through the API and re-primes the
 * status-bar registry cache so the chip/popup/setup panel stay in sync
 * without a page reload.
 */

import { escapeHtml } from '../../utils.js';
import S from '../../strings.js';
import { showToast } from '../../context-menu.js';
import { WidgetManager } from '../../widget-system/index.js';

let _tab = {
    providers: [],        // /api/providers rows (describe() + enabled flag)
    defaultProvider: null,  // effective default provider name
    pinned: false,        // --default-provider flag pins the default
    selectable: [],       // models.yaml catalog (editable providers share it)
    summary_model: '',    // models.yaml summary_model (rides the models PUT)
    activeProvider: null,   // which provider sub-tab is selected
    providerModels: {},     // models_key → full catalog defs [{id,label,desc}]
    disabledByKey: {},    // models_key → Set(hidden ids, incl. stale extras)
    providerDefaults: {},   // provider name → /api/app/provider-defaults payload
};

export function setupModelsTab(container) {
    if (!container.querySelector('#provider-panel')) return;
    wireProvidersList(container);
    wireProviderSubtabs(container);
    wireProviderPanel(container);
    wireAutoJournalLink(container);
    loadAll(container);
}

// ─────────────────────────────────────────────────────────────────────
// Data loading / top-level render
// ─────────────────────────────────────────────────────────────────────

async function loadAll(container) {
    try {
        const [prov, models] = await Promise.all([
            fetch('/api/providers').then(r => r.json()),
            fetch('/api/app/models').then(r => r.json()),
        ]);
        _adoptProviders(prov);
        _tab.selectable = models.selectable || [];
        _tab.summary_model = models.summary_model || '';
        await loadProviderModelsState();
        renderAll(container);
    } catch (e) {
        console.error('Failed to load providers tab:', e);
    }
}

function _adoptProviders(prov) {
    _tab.providers = prov.providers || [];
    _tab.defaultProvider = prov.default;
    _tab.pinned = !!prov.default_pinned_by_flag;
}

function enabledProviders() {
    return _tab.providers.filter(p => p.enabled !== false);
}

function providerByName(name) {
    return _tab.providers.find(p => p.name === name) || null;
}

function activeProvider() {
    return providerByName(_tab.activeProvider);
}

/** Full catalog + hidden set for every enabled provider, keyed by the
 *  shared `models_key` (driver variants surface one catalog). Cheap
 *  GETs — no subprocess probe — so we just refetch on every reload. */
async function loadProviderModelsState() {
    const byKey = new Map();  // models_key → a provider name that serves it
    for (const p of enabledProviders()) {
        if (!byKey.has(p.models_key)) byKey.set(p.models_key, p.name);
    }
    await Promise.all([...byKey.entries()].map(async ([key, name]) => {
        try {
            const resp = await fetch(`/api/app/provider-models/${encodeURIComponent(name)}`);
            if (!resp.ok) return;
            const data = await resp.json();
            _adoptProviderModels(key, data);
        } catch (e) {
            console.error('Failed to load provider models:', e);
        }
    }));
}

function _adoptProviderModels(key, data) {
    // Store pure definitions; visibility lives in disabledByKey (one truth).
    _tab.providerModels[key] = (data.models || []).map(
        ({ id, label, desc }) => ({ id, label, desc }));
    _tab.disabledByKey[key] = new Set(data.disabled || []);
}

/** Refetch the registry (after toggle / default change / path change) and
 *  re-render everything that hangs off it. */
async function reloadProviders(container) {
    try {
        const prov = await fetch('/api/providers').then(r => r.json());
        _adoptProviders(prov);
        await loadProviderModelsState();
        renderAll(container);
    } catch (e) {
        console.error('Failed to reload providers:', e);
    }
}

function renderAll(container) {
    _tab.activeProvider = resolveActiveProvider();
    renderProvidersList(container.querySelector('#providers-list'));
    renderProviderSubtabs(container.querySelector('#provider-subtabs'));
    renderProviderPanel(container);
    const hint = container.querySelector('#providers-hint');
    if (hint) {
        hint.textContent = S.settings.hints.providers_hint
            + (_tab.pinned ? ' ' + S.settings.hints.providers_default_pinned : '');
    }
}

/** Keep the selected sub-tab across re-renders; fall back to the default
 *  provider (always enabled) when the selection was toggled off. */
function resolveActiveProvider() {
    const enabled = enabledProviders();
    if (enabled.some(p => p.name === _tab.activeProvider)) return _tab.activeProvider;
    if (enabled.some(p => p.name === _tab.defaultProvider)) return _tab.defaultProvider;
    return enabled[0]?.name || null;
}

/** Re-prime the status-bar registry cache so chip/popup/setup panel
 *  reflect Settings changes without a reload. */
async function refreshPickerRegistry() {
    try {
        const mod = await import('../../status-bar.js');
        mod.invalidateProvidersCache?.();
        await mod.ensureProvidersLoaded?.();
        window.app?.statusBar?.updateStatus();
    } catch { /* silent */ }
}

// ─────────────────────────────────────────────────────────────────────
// Providers list — picker toggles + default-provider selection
// ─────────────────────────────────────────────────────────────────────

function renderProvidersList(listEl) {
    if (!listEl) return;
    listEl.innerHTML = _tab.providers.map(p => {
        const isDefault = p.name === _tab.defaultProvider;
        const enabled = p.enabled !== false;
        const tag = isDefault ? `<span class="provider-row-tag">${S.provider.default_badge}</span>` : '';
        const desc = p.available
            ? (p.description || '')
            : (p.unavailable_reason || '');
        // "Make default" on the other rows — hidden while a server flag
        // pins the default, and on providers that aren't usable anyway.
        const makeDefault = (!isDefault && !_tab.pinned && p.available)
            ? `<button type="button" class="provider-row-make-default" data-provider="${p.name}">${S.settings.hints.providers_make_default}</button>`
            : '';
        // Providers self-declare traits worth knowing BEFORE the toggle. Driven
        // off the capability, never off a provider name, so a drop-in provider
        // with the same shape gets the same warning for free.
        const note = p.capabilities?.prompt_in_argv
            ? `<span class="provider-row-note">${escapeHtml(S.settings.hints.providers_prompt_in_argv)}</span>`
            : '';
        return `<div class="provider-row${p.available ? '' : ' unavailable'}">
            <label class="provider-row-label">
                <span class="provider-row-name">${escapeHtml(p.display_name)}${tag}</span>
                <span class="provider-row-desc">${escapeHtml(desc)}</span>
                ${note}
            </label>
            ${makeDefault}
            <input type="checkbox" class="provider-row-toggle" data-provider="${p.name}"
                   ${enabled ? 'checked' : ''} ${isDefault ? 'disabled' : ''}
                   ${isDefault ? `data-tooltip="${S.settings.hints.providers_default_locked}"` : ''}>
        </div>`;
    }).join('');
}

function wireProvidersList(container) {
    const listEl = container.querySelector('#providers-list');
    if (!listEl) return;

    // Picker visibility toggles (enabled set drives which sub-tabs render)
    listEl.addEventListener('change', async (e) => {
        const toggle = e.target.closest('.provider-row-toggle');
        if (!toggle || toggle.disabled) return;
        const name = toggle.dataset.provider;
        const enabled = toggle.checked;
        try {
            const resp = await fetch('/api/app/providers-enabled', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ provider: name, enabled }),
            });
            if (!resp.ok) {
                toggle.checked = !enabled;  // revert
                const err = await resp.json().catch(() => ({}));
                showToast(`Save failed: ${err.detail || resp.status}`);
                return;
            }
            await reloadProviders(container);
            await refreshPickerRegistry();
        } catch (err) {
            toggle.checked = !enabled;
            console.error('Failed to toggle provider:', err);
        }
    });

    // "Make default" — the default provider new sessions land on
    listEl.addEventListener('click', async (e) => {
        const btn = e.target.closest('.provider-row-make-default');
        if (!btn) return;
        btn.disabled = true;
        try {
            const resp = await fetch('/api/app/default-provider', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ default_provider: btn.dataset.provider }),
            });
            if (!resp.ok) {
                const err = await resp.json().catch(() => ({}));
                showToast(`Save failed: ${err.detail || resp.status}`);
                return;
            }
            // Default flips: badge moves, old default's toggle unlocks, the
            // default-model select switches to the new provider's catalog.
            await reloadProviders(container);
            await refreshPickerRegistry();
        } catch (err) {
            console.error('Failed to set default provider:', err);
        }
    });
}

// ─────────────────────────────────────────────────────────────────────
// Default model — the DEFAULT provider's own catalog
// ─────────────────────────────────────────────────────────────────────

/** What a provider currently OFFERS: its catalog minus hidden models.
 *  Editable providers read the local models.yaml working copy so mid-edit
 *  rows appear without a refetch; others read the provider-models cache
 *  (`p.models` from /api/providers is the pre-toggle snapshot fallback). */
function effectiveCatalog(p) {
    if (!p) return [];
    const dis = _tab.disabledByKey[p.models_key] || new Set();
    const base = p.models_editable
        ? _tab.selectable
        : (_tab.providerModels[p.models_key] || p.models || []);
    return base.filter(m => !dis.has(m.id));
}

// ─────────────────────────────────────────────────────────────────────
// Per-provider new-session defaults + auto-journal model (provider panel)
// ─────────────────────────────────────────────────────────────────────

/** Rebuild the active panel's default-model options from the (possibly just
 *  edited) catalog, keeping the stored selection via prefix-match. */
function renderPanelDefaultModelOptions(container, p) {
    const select = container.querySelector('#provider-panel .provider-default-model');
    if (!select || !p) return;
    const catalog = effectiveCatalog(p);
    // The app always defines a concrete default when the provider has a catalog
    // (the server falls back to the top model), so no "Provider default"
    // placeholder. Only a provider with NO catalog (e.g. Codex with no models
    // cache) keeps it — the sole option, meaning "the CLI's own config".
    select.innerHTML = catalog.length ? '' :
        `<option value="">${escapeHtml(S.settings.hints.model_default_option)}</option>`;
    for (const m of catalog) {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = m.label || m.id;
        select.appendChild(opt);
    }
    // Stored value may be a dated variant of a listed id — prefix-match like
    // the chip. The server resolves a concrete in-catalog default, so this
    // always hits; fall back to the top model rather than an empty select.
    const stored = _tab.providerDefaults[p.name]?.default_model || '';
    const hit = catalog.find(m => m.id === stored)
        || catalog.find(m => stored && stored.startsWith(m.id));
    select.value = hit ? hit.id : (catalog[0]?.id || '');
}

async function loadProviderDefaults(root, container, name) {
    try {
        const resp = await fetch(`/api/app/provider-defaults/${encodeURIComponent(name)}`);
        if (!resp.ok) return;
        if (root.dataset.provider !== name) return;   // stale — panel switched
        _tab.providerDefaults[name] = await resp.json();
        applyProviderDefaults(root, container, providerByName(name));
    } catch (e) {
        console.error('Failed to load provider defaults:', e);
    }
}

function applyProviderDefaults(root, container, p) {
    const data = p && _tab.providerDefaults[p.name];
    if (!data) return;
    renderPanelDefaultModelOptions(container, p);
    const effortSel = root.querySelector('.provider-default-effort');
    if (effortSel) effortSel.value = data.default_effort || '';
    const profileSel = root.querySelector('.provider-default-profile');
    if (profileSel) profileSel.value = data.token_profile || '';
    const journal = root.querySelector('[data-role="journal"]');
    if (journal) {
        if (!data.summary_supported) {
            journal.remove();
        } else {
            const input = journal.querySelector('.provider-journal-input');
            if (input && document.activeElement !== input) {
                input.value = data.summary_model || '';
                input.placeholder = data.summary_placeholder || '';
            }
            // Keep the models.yaml PUT body in sync — the app-owned provider's
            // journal model rides that payload too.
            if (p.models_editable && data.summary_model) {
                _tab.summary_model = data.summary_model;
            }
        }
    }
}

/** PUT a subset of the active provider's defaults and adopt the response. */
async function saveProviderDefaults(container, p, patch) {
    const root = container.querySelector('#provider-panel');
    try {
        const resp = await fetch(`/api/app/provider-defaults/${encodeURIComponent(p.name)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(patch),
        });
        if (!resp.ok) throw new Error((await resp.json().catch(() => ({}))).detail || resp.status);
        _tab.providerDefaults[p.name] = await resp.json();
        if (root?.dataset.provider === p.name) applyProviderDefaults(root, container, p);
        // The chip's "default" state may have changed for open sessions.
        const sb = window.app?.statusBar;
        if (sb?.currentSessionId) sb.setSession(sb.currentSessionId);
    } catch (err) {
        showToast(`Save failed: ${err.message || err}`);
        if (root?.dataset.provider === p.name) applyProviderDefaults(root, container, p);
    }
}

// ─────────────────────────────────────────────────────────────────────
// Provider sub-tabs — pick which provider the unified panel edits
// ─────────────────────────────────────────────────────────────────────

function renderProviderSubtabs(tabsEl) {
    if (!tabsEl) return;
    tabsEl.innerHTML = enabledProviders().map(p => {
        const tag = p.name === _tab.defaultProvider
            ? `<span class="provider-row-tag">${S.provider.default_badge}</span>` : '';
        const active = p.name === _tab.activeProvider ? ' active' : '';
        return `<button type="button" class="provider-subtab${active}" data-provider="${p.name}">
            ${escapeHtml(p.display_name)}${tag}
        </button>`;
    }).join('');
}

function wireProviderSubtabs(container) {
    const tabsEl = container.querySelector('#provider-subtabs');
    if (!tabsEl) return;
    tabsEl.addEventListener('click', (e) => {
        const btn = e.target.closest('.provider-subtab');
        if (!btn || btn.dataset.provider === _tab.activeProvider) return;
        _tab.activeProvider = btn.dataset.provider;
        renderProviderSubtabs(tabsEl);
        renderProviderPanel(container);
    });
}

// ─────────────────────────────────────────────────────────────────────
// Provider panel — CLI path + model catalog (ONE layout for every provider)
// ─────────────────────────────────────────────────────────────────────

function renderProviderPanel(container) {
    const root = container.querySelector('#provider-panel');
    if (!root) return;
    const p = activeProvider();
    if (!p) {
        root.dataset.provider = '';
        root.innerHTML = '';
        return;
    }
    root.dataset.provider = p.name;
    const unavailable = !p.available
        ? `<p class="provider-card-status unavailable">${escapeHtml(p.unavailable_reason || '')}</p>` : '';
    const pathBlock = p.path_configurable ? `
        <p class="provider-card-status" data-role="version"></p>
        <div class="provider-path-row">
            <input type="text" class="system-text-input provider-path-input"
                   placeholder="${escapeHtml(p.default_binary || '')}"
                   spellcheck="false" autocomplete="off">
            <button type="button" class="system-save-btn provider-path-save">${S.settings.hints.provider_path_save}</button>
            <button type="button" class="system-reset-btn provider-path-reset" disabled>${S.settings.hints.provider_path_reset}</button>
        </div>
        <p class="config-hint">${S.settings.hints.provider_path_hint.replace('{binary}', escapeHtml(p.default_binary || ''))}</p>` : '';
    const authBlock = `
        <div class="provider-auth" data-role="auth">
            <span class="provider-auth-dot checking"></span>
            <span class="provider-auth-text">${S.settings.hints.provider_auth_checking}</span>
            <button type="button" class="system-save-btn provider-login-btn" hidden>${S.settings.hints.provider_auth_login_button}</button>
        </div>`;
    const modelsFooter = p.models_editable ? `
        <div class="models-add-row">
            <span class="models-toggle-spacer"></span>
            <input type="text" class="system-text-input models-add-id"
                   placeholder="${S.settings.hints.models_add_placeholder_id}">
            <input type="text" class="system-text-input models-add-label"
                   placeholder="${S.settings.hints.models_add_placeholder_label}">
            <input type="text" class="system-text-input models-add-desc"
                   placeholder="${S.settings.hints.models_add_placeholder_desc}">
            <button type="button" class="system-save-btn models-add-btn">${S.settings.hints.models_add_button}</button>
        </div>
        <p class="config-hint">${S.settings.hints.models_list_hint}</p>
        <button type="button" class="system-reset-btn models-reset-btn">${S.settings.hints.models_reset_button}</button>` : `
        <p class="config-hint">${S.settings.hints.provider_models_readonly}</p>`;
    // New-session defaults — vocab comes from the registry (efforts,
    // accounts); stored values arrive via loadProviderDefaults.
    const effortOptions = (p.efforts || []).map(lvl =>
        `<option value="${escapeHtml(lvl)}">${escapeHtml(S.provider.setup.effort_labels?.[lvl] || lvl)}</option>`).join('');
    const accountOptions = (p.accounts || []).map(a =>
        `<option value="${escapeHtml(a.id)}">${escapeHtml(a.label || a.id)}</option>`).join('');
    const defaultsBlock = `
        <h4 class="provider-card-subtitle">${S.settings.sections.provider_defaults}</h4>
        <div class="provider-defaults" data-role="defaults">
            <div class="provider-defaults-row">
                <span class="provider-defaults-label">${S.settings.hints.provider_default_model_label}</span>
                <select class="system-select provider-default-model"></select>
            </div>
            ${(p.efforts || []).length ? `
            <div class="provider-defaults-row">
                <span class="provider-defaults-label">${S.settings.hints.provider_default_effort_label}</span>
                <select class="system-select provider-default-effort">
                    <option value="">${S.settings.hints.model_default_option}</option>
                    ${effortOptions}
                </select>
            </div>` : ''}
            ${(p.accounts || []).length > 1 ? `
            <div class="provider-defaults-row">
                <span class="provider-defaults-label">${S.settings.hints.provider_default_profile_label}</span>
                <select class="system-select provider-default-profile">
                    ${accountOptions}
                </select>
            </div>` : ''}
        </div>
        <p class="config-hint">${S.settings.hints.provider_defaults_hint}</p>`;
    const journalBlock = `
        <div class="provider-journal" data-role="journal">
            <h4 class="provider-card-subtitle">${S.settings.sections.models_background}</h4>
            <input type="text" class="system-text-input provider-journal-input"
                   spellcheck="false" autocomplete="off">
            <p class="config-hint">${S.settings.hints.provider_journal_hint}</p>
        </div>`;
    root.innerHTML = `
        ${unavailable}
        ${pathBlock}
        ${authBlock}
        <h4 class="provider-card-subtitle">${S.settings.sections.provider_models}</h4>
        <div class="models-list" data-role="models"></div>
        ${modelsFooter}
        ${defaultsBlock}
        ${journalBlock}`;
    renderPanelModels(container, p);
    renderPanelDefaultModelOptions(container, p);
    if (p.path_configurable) loadProviderPath(root, p.name);
    loadProviderAuth(root, p.name);
    loadProviderDefaults(root, container, p.name);
}

// --- CLI path (generic /api/app/provider-path/{name}) -----------------

async function loadProviderPath(root, name) {
    try {
        const resp = await fetch(`/api/app/provider-path/${encodeURIComponent(name)}`);
        if (!resp.ok) return;
        // The probe takes up to 5s — drop the reply if the user has
        // switched the panel to another provider meanwhile.
        if (root.dataset.provider !== name) return;
        applyProviderPathInfo(root, await resp.json());
    } catch (e) {
        console.error('Failed to load provider path:', e);
    }
}

function applyProviderPathInfo(root, data) {
    if (!data || data.configurable === false) return;
    const input = root.querySelector('.provider-path-input');
    const versionEl = root.querySelector('[data-role="version"]');
    const resetBtn = root.querySelector('.provider-path-reset');
    if (input && document.activeElement !== input) input.value = data.path || '';
    if (versionEl) {
        const ver = data.version || S.settings.hints.provider_path_missing;
        versionEl.textContent = data.resolved ? `${ver} · ${data.resolved}` : ver;
        versionEl.classList.toggle('unavailable', !data.version);
    }
    if (resetBtn) resetBtn.disabled = !data.path;
}

async function saveProviderPath(container, root, path) {
    const name = root.dataset.provider;
    const saveBtn = root.querySelector('.provider-path-save');
    const versionEl = root.querySelector('[data-role="version"]');
    try {
        if (saveBtn) saveBtn.disabled = true;
        const resp = await fetch(`/api/app/provider-path/${encodeURIComponent(name)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: path || null }),
        });
        if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            if (versionEl) {
                versionEl.textContent = `Error: ${err.detail || resp.status}`;
                versionEl.classList.add('unavailable');
            }
            return;
        }
        if (root.dataset.provider === name) {
            applyProviderPathInfo(root, await resp.json());
        }
        // A path change can flip availability — refresh rows/panel + picker.
        await reloadProviders(container);
        await refreshPickerRegistry();
    } catch (e) {
        console.error('Failed to save provider path:', e);
    } finally {
        if (saveBtn) saveBtn.disabled = false;
    }
}

// --- CLI login status (generic /api/app/provider-auth/{name}) ----------

async function loadProviderAuth(root, name) {
    try {
        const resp = await fetch(`/api/app/provider-auth/${encodeURIComponent(name)}`);
        if (!resp.ok) return;
        // The probe shells out to the CLI — drop the reply if the user has
        // switched the panel to another provider meanwhile.
        if (root.dataset.provider !== name) return;
        applyProviderAuthInfo(root, await resp.json());
    } catch (e) {
        console.error('Failed to load provider auth:', e);
    }
}

function applyProviderAuthInfo(root, data) {
    const row = root.querySelector('[data-role="auth"]');
    if (!row) return;
    // Provider describes no auth probe (drop-in providers) → no login row.
    if (!data || data.supported === false) { row.remove(); return; }
    const dot = row.querySelector('.provider-auth-dot');
    const text = row.querySelector('.provider-auth-text');
    const btn = row.querySelector('.provider-login-btn');
    const H = S.settings.hints;
    dot?.classList.remove('checking', 'ok', 'err');
    if (data.logged_in === true) {
        dot?.classList.add('ok');
        text.textContent = data.detail
            ? `${H.provider_auth_logged_in} — ${data.detail}` : H.provider_auth_logged_in;
    } else if (data.logged_in === false) {
        dot?.classList.add('err');
        text.textContent = data.detail
            ? `${H.provider_auth_not_logged_in} — ${data.detail}` : H.provider_auth_not_logged_in;
    } else {
        text.textContent = H.provider_auth_unknown;
    }
    // Offer the CLI's own login flow whenever one exists and we aren't
    // verifiably logged in (unknown state may still be fixable by a login).
    if (btn) {
        btn.hidden = !(data.login_command && data.logged_in !== true);
        btn.dataset.command = data.login_command || '';
    }
}

// After a login handoff, watch for the CLI flow completing so the row (and
// the picker registry — availability can flip) go green without a reopen.
let authPollTimer = null;
function startAuthPoll(root, name) {
    if (!name) return;
    if (authPollTimer) clearInterval(authPollTimer);
    let ticks = 0;
    authPollTimer = setInterval(async () => {
        // Give up after ~5 min, or when the user switched this STILL-OPEN
        // panel to a different provider. A detached panel (Settings closed for
        // the login handoff) keeps polling — the login completing still needs
        // to refresh the picker registry; we just skip the dead DOM update.
        const switchedAway = root.isConnected && root.dataset.provider !== name;
        if (switchedAway || ++ticks > 60) {
            clearInterval(authPollTimer);
            authPollTimer = null;
            return;
        }
        try {
            const resp = await fetch(`/api/app/provider-auth/${encodeURIComponent(name)}`);
            if (!resp.ok) return;
            const data = await resp.json();
            if (root.isConnected && root.dataset.provider === name) {
                applyProviderAuthInfo(root, data);
            }
            if (data.logged_in === true) {
                clearInterval(authPollTimer);
                authPollTimer = null;
                await refreshPickerRegistry();
            }
        } catch { /* transient — keep polling */ }
    }, 5000);
}

// --- model catalog rows (unified: toggle + id/label/desc [+ delete]) ----

/** The active panel's rows: FULL catalog (hidden models render with the
 *  toggle off, they aren't filtered out here). */
function panelCatalog(p) {
    const dis = _tab.disabledByKey[p.models_key] || new Set();
    const base = p.models_editable
        ? _tab.selectable
        : (_tab.providerModels[p.models_key] || []);
    return base.map(m => ({ ...m, enabled: !dis.has(m.id) }));
}

function renderPanelModels(container, p) {
    const listEl = container.querySelector('#provider-panel [data-role="models"]');
    if (!listEl) return;
    const catalog = panelCatalog(p);
    if (!catalog.length) {
        listEl.innerHTML = `<div class="models-empty">${S.settings.hints.provider_models_empty}</div>`;
        return;
    }
    const ro = p.models_editable ? '' : ' readonly';
    listEl.innerHTML = catalog.map(m => `
        <div class="models-row${m.enabled ? '' : ' model-off'}">
            <input type="checkbox" class="models-row-toggle"
                   data-id="${escapeHtml(m.id)}" ${m.enabled ? 'checked' : ''}
                   title="${escapeHtml(S.settings.hints.provider_model_toggle_title)}">
            <input type="text" class="system-text-input models-row-input"
                   data-id="${escapeHtml(m.id)}" data-field="id"${ro}
                   value="${escapeHtml(m.id)}" title="${escapeHtml(S.settings.hints.models_id_title)}">
            <input type="text" class="system-text-input models-row-input"
                   data-id="${escapeHtml(m.id)}" data-field="label"${ro}
                   value="${escapeHtml(m.label || '')}" placeholder="Label">
            <input type="text" class="system-text-input models-row-input"
                   data-id="${escapeHtml(m.id)}" data-field="desc"${ro}
                   value="${escapeHtml(m.desc || '')}" placeholder="Description">
            ${p.models_editable
                ? `<button class="models-row-delete" data-id="${escapeHtml(m.id)}" title="${escapeHtml(S.settings.hints.models_delete_title)}">×</button>`
                : ''}
        </div>`).join('');
}

/** Repaint the model rows + the panel's default-model dropdown after a
 *  catalog edit (its options mirror the catalog being edited). */
function rerenderEditableModels(container) {
    const p = activeProvider();
    if (p?.models_editable) renderPanelModels(container, p);
    renderPanelDefaultModelOptions(container, p);
}

/** Persist the hidden set for the active provider's `models_key`. */
async function saveModelVisibility(container, p, toggleEl) {
    const key = p.models_key;
    const set = _tab.disabledByKey[key] || (_tab.disabledByKey[key] = new Set());
    const id = toggleEl.dataset.id;
    const wasHidden = set.has(id);
    if (toggleEl.checked) set.delete(id); else set.add(id);
    toggleEl.closest('.models-row')?.classList.toggle('model-off', !toggleEl.checked);
    renderPanelDefaultModelOptions(container, p);
    try {
        const resp = await fetch(`/api/app/provider-models/${encodeURIComponent(p.name)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ disabled: [...set] }),
        });
        if (!resp.ok) throw new Error((await resp.json().catch(() => ({}))).detail || resp.status);
        _adoptProviderModels(key, await resp.json());
        await refreshPickerRegistry();
    } catch (err) {
        // Revert the optimistic flip
        if (wasHidden) set.add(id); else set.delete(id);
        toggleEl.checked = !toggleEl.checked;
        toggleEl.closest('.models-row')?.classList.toggle('model-off', !toggleEl.checked);
        renderPanelDefaultModelOptions(container, p);
        showToast(`Save failed: ${err.message || err}`);
    }
}

function wireProviderPanel(container) {
    const root = container.querySelector('#provider-panel');
    if (!root) return;

    // Two-click arm/commit instead of confirm(): window.confirm() silently
    // no-ops (and can hang the webview) in the iPad standalone PWA. First
    // click arms the button (.armed); a second within 4s commits.
    let armedDeleteId = null;
    let deleteArmTimer = null;
    const disarmDelete = () => {
        armedDeleteId = null;
        if (deleteArmTimer) { clearTimeout(deleteArmTimer); deleteArmTimer = null; }
        root.querySelectorAll('.models-row-delete.armed').forEach(b => {
            b.classList.remove('armed');
            b.title = S.settings.hints.models_delete_title;
        });
    };

    // Model visibility toggles + per-provider session-default selects
    root.addEventListener('change', async (e) => {
        const p = activeProvider();
        if (!p) return;
        const toggle = e.target.closest('.models-row-toggle');
        if (toggle) { await saveModelVisibility(container, p, toggle); return; }
        if (e.target.matches?.('.provider-default-model')) {
            await saveProviderDefaults(container, p, { default_model: e.target.value || null });
        } else if (e.target.matches?.('.provider-default-effort')) {
            await saveProviderDefaults(container, p, { default_effort: e.target.value || null });
        } else if (e.target.matches?.('.provider-default-profile')) {
            await saveProviderDefaults(container, p, { token_profile: e.target.value || null });
        }
    });

    root.addEventListener('click', async (e) => {
        // CLI path save/reset
        if (e.target.closest('.provider-path-save')) {
            const input = root.querySelector('.provider-path-input');
            await saveProviderPath(container, root, input?.value.trim());
            return;
        }
        if (e.target.closest('.provider-path-reset')) {
            const input = root.querySelector('.provider-path-input');
            if (input) input.value = '';
            await saveProviderPath(container, root, null);
            return;
        }

        // Log in — hand off to the CLI's own interactive flow in a PTY
        // terminal tab (device-code / OAuth prompts work as designed there),
        // then poll status so the row flips green when the flow completes.
        const loginBtn = e.target.closest('.provider-login-btn');
        if (loginBtn) {
            if (!loginBtn.dataset.command) return;
            const provider = root.dataset.provider;
            // Close this (modal) Settings pane first — otherwise the login PTY
            // tab opens *behind* the overlay and the user can't reach the
            // device-code / OAuth prompt. The status poll (below) survives the
            // panel detaching, so it still refreshes the pickers once login
            // lands; reopening Settings re-probes and shows the green row.
            WidgetManager.close('config');
            window.app?.openTerminalWidgetTab({
                title: S.settings.hints.provider_auth_login_tab,
                icon: 'terminal',
                initialCommand: loginBtn.dataset.command + '\n',
            });
            startAuthPoll(root, provider);
            return;
        }

        // Add model (editable catalogs only)
        if (e.target.closest('.models-add-btn')) {
            const idInput = root.querySelector('.models-add-id');
            const id = idInput?.value.trim();
            if (!id) { idInput?.focus(); return; }
            if (_tab.selectable.some(m => m.id === id)) {
                showToast(S.settings.hints.models_id_dupe.replace('{id}', id));
                return;
            }
            const label = root.querySelector('.models-add-label')?.value.trim() || id;
            const desc = root.querySelector('.models-add-desc')?.value.trim() || '';
            _tab.selectable.push({ id, label, desc });
            root.querySelectorAll('.models-add-id, .models-add-label, .models-add-desc')
                .forEach(el => { el.value = ''; });
            rerenderEditableModels(container);
            await saveModelsConfig();
            return;
        }

        // Delete model — arm on first click, commit on second
        const delBtn = e.target.closest('.models-row-delete');
        if (delBtn) {
            const id = delBtn.dataset.id;
            if (armedDeleteId !== id) {
                disarmDelete();                 // disarm any other row first
                armedDeleteId = id;
                delBtn.classList.add('armed');
                delBtn.title = S.settings.hints.models_delete_arm.replace('{id}', id);
                deleteArmTimer = setTimeout(disarmDelete, 4000);
                return;
            }
            disarmDelete();
            _tab.selectable = _tab.selectable.filter(m => m.id !== id);
            rerenderEditableModels(container);
            await saveModelsConfig();
            return;
        }

        // Restore models.yaml defaults — same arm/commit pattern
        const resetBtn = e.target.closest('.models-reset-btn');
        if (resetBtn) {
            if (resetBtn.dataset.armed !== '1') {
                resetBtn.dataset.armed = '1';
                resetBtn.classList.add('armed');
                resetBtn.textContent = S.settings.hints.models_reset_arm;
                setTimeout(() => {
                    resetBtn.dataset.armed = '';
                    resetBtn.classList.remove('armed');
                    resetBtn.textContent = S.settings.hints.models_reset_button;
                }, 4000);
                return;
            }
            resetBtn.dataset.armed = '';
            resetBtn.classList.remove('armed');
            resetBtn.textContent = S.settings.hints.models_reset_button;
            try {
                const response = await fetch('/api/app/models/reset', { method: 'POST' });
                if (!response.ok) {
                    const err = await response.json().catch(() => ({}));
                    showToast(`Reset failed: ${err.detail || 'unknown error'}`);
                    return;
                }
                const data = await response.json();
                _tab.selectable = data.selectable || [];
                _tab.summary_model = data.summary_model || '';
                // models.yaml reset also resets the journal model — reflect
                // it in the active panel (the editable provider's journal
                // input mirrors models.yaml summary_model).
                const p = activeProvider();
                if (p?.models_editable) {
                    const cached = _tab.providerDefaults[p.name];
                    if (cached) cached.summary_model = _tab.summary_model;
                    const journalInput = root.querySelector('.provider-journal-input');
                    if (journalInput) journalInput.value = _tab.summary_model;
                }
                rerenderEditableModels(container);
                await refreshModelsCaches();
                showToast(S.settings.hints.models_reset_done);
            } catch (err) {
                console.error('Failed to reset models:', err);
                showToast(`Reset failed: ${err.message}`);
            }
        }
    });

    // Auto-journal model — save on blur when changed
    root.addEventListener('blur', async (e) => {
        if (!e.target.matches?.('.provider-journal-input')) return;
        const p = activeProvider();
        if (!p) return;
        const stored = _tab.providerDefaults[p.name]?.summary_model || '';
        const value = e.target.value.trim();
        if (value === stored) return;
        await saveProviderDefaults(container, p, { summary_model: value || null });
    }, true);

    // Inline edits on editable model rows (id rename needs fixups)
    root.addEventListener('blur', async (e) => {
        const input = e.target;
        if (!input.matches?.('.models-row-input') || input.readOnly) return;
        const oldId = input.dataset.id;
        const field = input.dataset.field;
        const model = _tab.selectable.find(m => m.id === oldId);
        if (!model) return;
        const newValue = input.value.trim();
        if (model[field] === newValue) return;

        // Renaming the ID (identity key) needs validation + reference fixups:
        // it's referenced by every row's data-id and possibly by the provider's
        // configured default model.
        if (field === 'id') {
            if (!newValue) {                         // don't allow empty — revert
                input.value = oldId;
                return;
            }
            if (_tab.selectable.some(m => m !== model && m.id === newValue)) {
                showToast(S.settings.hints.models_id_dupe.replace('{id}', newValue));
                input.value = oldId;                 // revert to keep IDs unique
                return;
            }
            const p = activeProvider();
            const wasDefault = p && _tab.providerDefaults[p.name]?.default_model === oldId;
            model.id = newValue;
            rerenderEditableModels(container);       // refresh data-id everywhere
            await saveModelsConfig();
            if (wasDefault) {
                await saveProviderDefaults(container, p, { default_model: newValue });
            }
            return;
        }

        model[field] = newValue;
        if (field === 'label') {
            renderPanelDefaultModelOptions(container, activeProvider());
        }
        await saveModelsConfig();
    }, true);  // useCapture=true to catch blur on child inputs

    // Enter in the CLI path input = Save; Enter in the journal input = blur
    // (the blur handler above persists it).
    root.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        if (e.target.matches?.('.provider-path-input')) {
            e.preventDefault();
            saveProviderPath(container, root, e.target.value.trim());
        } else if (e.target.matches?.('.provider-journal-input')) {
            e.preventDefault();
            e.target.blur();
        }
    });
}

// ─────────────────────────────────────────────────────────────────────
// Auto-journal panel cross-link (the journal MODEL is per-provider now —
// see the provider panel's journal block)
// ─────────────────────────────────────────────────────────────────────

function wireAutoJournalLink(container) {
    const ajLink = container.querySelector('#open-auto-journal-from-models');
    if (ajLink) {
        ajLink.addEventListener('click', () => {
            WidgetManager.close('config');
            WidgetManager.open('helpers-install');
        });
    }
}

// ─────────────────────────────────────────────────────────────────────
// models.yaml persistence + cache re-priming
// ─────────────────────────────────────────────────────────────────────

async function saveModelsConfig() {
    try {
        const response = await fetch('/api/app/models', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                selectable: _tab.selectable,
                summary_model: _tab.summary_model,
            }),
        });
        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            console.error('Failed to save models:', err);
            showToast(`Save failed: ${err.detail || 'unknown error'}`);
            return;
        }
        await refreshModelsCaches();
    } catch (e) {
        console.error('Failed to save models:', e);
        showToast(`Save failed: ${e.message}`);
    }
}

/** Invalidate + re-prime the status-bar models cache AND the providers
 *  registry (which mirrors the catalog for the setup panel / model popup)
 *  so `{model}` labels and pickers reflect edits without a page reload. */
async function refreshModelsCaches() {
    try {
        const mod = await import('../../status-bar.js');
        mod.invalidateModelsCache?.();
        mod.invalidateProvidersCache?.();
        await Promise.all([mod.ensureModelsLoaded?.(), mod.ensureProvidersLoaded?.()]);
    } catch { /* silent */ }
}
