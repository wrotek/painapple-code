/**
 * Session Setup Panel — friendly selectors in the empty chat area.
 *
 * A fresh session (project picked, nothing sent yet) has a blank chat
 * window; this panel uses that space to surface the choices that matter
 * before the first message: engine, model, permissions, effort, account.
 * Every row is a set of one-tap pills that delegate to the existing
 * managers (status-bar engine/model picker, permission-settings,
 * effort-settings, token-profile), so behavior is identical to the
 * status-bar chips — this is just a bigger, friendlier surface for them.
 *
 * Visibility: active session with a cwd, zero non-system messages, engine
 * not locked. Hides itself the moment the first message lands (the engine
 * locks then; everything else stays adjustable from the status bar).
 *
 * Rows self-populate from the engine registry (`GET /api/providers`) and
 * the managers' server-loaded state — nothing here is hardcoded per
 * engine, and rows whose vocabulary is empty for the current engine
 * (model catalog, efforts, accounts) disappear.
 */

import S from './strings.js';
import { escapeHtml } from './utils.js';
import {
    PROVIDERS_INFO,
    engineInfo,
    enabledEngines,
    ensureProvidersLoaded,
    ensureModelsLoaded,
} from './status-bar.js';

class SessionSetupPanel {
    constructor() {
        this.el = null;
        this._visible = false;
    }

    init() {
        const host = document.getElementById('messages-container');
        if (!host || this.el) return;

        this.el = document.createElement('div');
        this.el.id = 'session-setup-panel';
        this.el.hidden = true;
        host.appendChild(this.el);

        // One delegated handler for every pill
        this.el.addEventListener('click', (e) => {
            const pill = e.target.closest('.setup-pill');
            if (!pill) return;
            e.stopPropagation();
            this._onPick(pill.dataset.kind, pill.dataset.value);
        });

        // Warm the registries this panel renders from, then paint.
        Promise.all([ensureProvidersLoaded(), ensureModelsLoaded()])
            .then(() => this.refresh());
    }

    // ─── Visibility ────────────────────────────────────────────────

    /** The panel belongs on a fresh session only: project picked, nothing
     * sent, engine still switchable. */
    _shouldShow() {
        const s = window.app?.activeSession;
        if (!s || !s.cwd) return false;
        if (s.providerLocked || s.providerSessionId) return false;
        const real = (s.messages || []).filter(m => m.role !== 'system');
        return real.length === 0;
    }

    /**
     * Re-evaluate visibility and repaint. Called from StatusBar.updateStatus
     * (the funnel every relevant state change flows through) and from the
     * managers' own updates, so it must stay cheap: bail immediately when
     * hidden both before and after.
     */
    refresh() {
        if (!this.el) return;
        const show = this._shouldShow();
        if (!show) {
            if (this._visible) {
                this.el.hidden = true;
                this._visible = false;
            }
            return;
        }
        this._visible = true;
        this.el.hidden = false;
        this._render();
    }

    // ─── Rendering ─────────────────────────────────────────────────

    _render() {
        const s = window.app?.activeSession;
        if (!s) return;

        // provider is authoritative once known (bound sessions); a bound tab
        // whose provider hasn't been echoed yet still paints the user's pick
        // (pendingProvider) rather than flashing the box default.
        const engineName = s.provider || s.pendingProvider
            || PROVIDERS_INFO?.default || null;
        const engine = engineInfo(engineName);

        const rows = [
            this._engineRow(engineName),
            this._modelRow(engine),
            this._permissionsRow(),
            this._effortRow(engine),
            this._accountRow(engine),
        ].filter(Boolean).join('');

        this.el.innerHTML = `<div class="setup-panel-card">
            <div class="setup-panel-title">${S.provider.setup.title}</div>
            <div class="setup-panel-subtitle">${S.provider.setup.subtitle}</div>
            <div class="setup-panel-rows">${rows}</div>
            <div class="setup-panel-hint">${S.provider.setup.lock_hint}</div>
        </div>`;
    }

    _row(label, pills) {
        if (!pills) return '';
        return `<div class="setup-row">
            <span class="setup-row-label">${label}</span>
            <div class="setup-row-options">${pills}</div>
        </div>`;
    }

    _pill({ kind, value, label, selected, dotColor, tooltip, unavailable }) {
        const cls = ['setup-pill'];
        if (selected) cls.push('selected');
        if (unavailable) cls.push('unavailable');
        const dot = dotColor ? `<span class="pv-dot" style="background:${dotColor}"></span>` : '';
        const tip = tooltip ? ` data-tooltip="${escapeHtml(tooltip)}"` : '';
        return `<button class="${cls.join(' ')}" data-kind="${kind}" data-value="${escapeHtml(value)}"${tip}>${dot}${escapeHtml(label)}</button>`;
    }

    /** Engine pills: Settings-enabled engines (plus the session's own engine
     * if since disabled). Hidden entirely when there's only one choice. */
    _engineRow(currentName) {
        const offered = enabledEngines();
        const current = engineInfo(currentName);
        if (current && !offered.some(p => p.name === current.name)) offered.push(current);
        if (offered.length < 2) return '';
        const pills = offered.map(p => this._pill({
            kind: 'engine',
            value: p.name,
            label: p.display_name,
            selected: p.name === currentName,
            tooltip: p.available ? (p.description || '') : (p.unavailable_reason || ''),
            unavailable: !p.available,
        })).join('');
        return this._row(S.provider.setup.provider_label, pills);
    }

    /** Model pills — the engine's OWN catalog (Claude: models.yaml; Codex:
     * the CLI's models cache). The engine's default always resolves to a
     * concrete catalog model (the server falls back to the top model, and
     * catalog[0] covers the pre-fetch transient), so a real model is always
     * selected — no "Default" pill. */
    _modelRow(engine) {
        const sb = window.app?.statusBar;
        const catalog = engine?.models || [];
        if (!catalog.length || !sb) return '';
        const inCat = id => !!id && catalog.some(m => id.startsWith(m.id));
        const pick = inCat(sb.currentModel) ? sb.currentModel : null;
        const current = pick
            || (inCat(sb.globalDefaultModel) ? sb.globalDefaultModel : null)
            || catalog[0]?.id || null;
        const pills = catalog.map(m => this._pill({
            kind: 'model',
            value: m.id,
            label: m.label || m.id,
            selected: current === m.id,
            tooltip: m.desc || '',
        }));
        return this._row(S.provider.setup.model_label, pills.join(''));
    }

    /** Permission pills — the active engine's own vocabulary (the manager
     * already tracks it per-engine via setSession). */
    _permissionsRow() {
        const pm = window.permissionSettings;
        const modes = pm?.modes || [];
        if (modes.length < 2) return '';
        const pills = modes.map(m => this._pill({
            kind: 'permission',
            value: m.value,
            label: m.label,
            selected: pm.currentLevel === m.value,
            dotColor: m.color || '',
            tooltip: m.desc || '',
        })).join('');
        return this._row(S.provider.setup.permissions_label, pills);
    }

    /** Effort pills — the engine's self-described scale, narrowed to the
     * picked model's own range when the model declares one (codex models
     * self-describe supported levels). Empty → row hidden. */
    _effortRow(engine) {
        const sb = window.app?.statusBar;
        const models = engine?.models || [];
        const pickedId = sb?.currentModel || sb?.globalDefaultModel;
        const picked = pickedId && models.find(m => pickedId.startsWith(m.id));
        const efforts = (picked?.efforts?.length ? picked.efforts : engine?.efforts) || [];
        if (efforts.length < 2) return '';
        const current = window.effortSettings?.currentLevel || null;
        const labels = S.provider.setup.effort_labels || {};
        const pills = efforts.map(v => this._pill({
            kind: 'effort',
            value: v,
            label: labels[v] || v,
            selected: current === v,
        })).join('');
        return this._row(S.provider.setup.effort_label, pills);
    }

    /** Account pills — token profiles, only when the engine has selectable
     * accounts beyond its ambient login and profiles actually exist. */
    _accountRow(engine) {
        if ((engine?.accounts || []).length < 2) return '';
        const tp = window.tokenProfile;
        if (!tp || (tp.profiles || []).length === 0) return '';
        const current = tp.currentProfile || '';
        const pills = [this._pill({
            kind: 'account',
            value: '',
            label: S.provider.setup.no_token,
            selected: !current,
        })].concat(tp.profiles.map(p => this._pill({
            kind: 'account',
            value: p.name,
            label: p.name,
            selected: current === p.name,
        }))).join('');
        return this._row(S.provider.setup.account_label, pills);
    }

    // ─── Actions — all delegate to the existing managers ───────────

    async _onPick(kind, value) {
        const sb = window.app?.statusBar;
        switch (kind) {
            case 'engine':
                await sb?._selectEngine?.(value);
                break;
            case 'model':
                await sb?._selectModel?.(value);
                break;
            case 'permission':
                await window.permissionSettings?.selectLevel?.(value);
                break;
            case 'effort':
                await window.effortSettings?.selectLevel?.(value);
                break;
            case 'account':
                await window.tokenProfile?.selectProfile?.(value || null);
                break;
        }
        this.refresh();
        // Land the cursor in the message box — pick, then type, no extra tap.
        window.app?.focusInput?.();
    }
}

export const sessionSetupPanel = new SessionSetupPanel();
window.sessionSetupPanel = sessionSetupPanel;

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => sessionSetupPanel.init());
} else {
    sessionSetupPanel.init();
}
