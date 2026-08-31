/**
 * Permission Settings - Permission Level Configuration
 *
 * Manages the permission button near the input area that controls
 * the agent's permission mode (bypassPermissions/YOLO or plan).
 *
 * Permission levels are stored PER SESSION, allowing different modes
 * for different conversations.
 *
 * The mode list itself is provider vocabulary: each provider self-describes
 * its modes (value/label/desc/color), delivered alongside the permission
 * endpoints (`GET /api/session/{id}/permission-mode`,
 * `GET /api/app/default-permissions`). The strings.yaml level table is
 * only the pre-fetch fallback, so e.g. the claude-sdk provider's extra
 * "Ask" mode appears without any frontend edit.
 */

import { CONFIG } from './config.js';
import S from './strings.js';
// Provider registry lookup (status-bar owns the /api/providers cache; it does
// not import this module, so no cycle). Used to seed the mode vocabulary
// synchronously on tab switch — the fetches below only confirm.
import { providerInfo } from './status-bar.js';

// Pre-fetch fallback modes from strings.yaml (shape matches the provider's
// permission_modes() dicts). Replaced by server-delivered lists on load.
const FALLBACK_MODES = S.permissions.order.map(key => {
    const lvl = S.permissions.levels[key];
    return { value: key, label: lvl.popup_label, desc: lvl.description, color: lvl.color };
});

class PermissionSettingsManager {
    constructor() {
        this.btn = null;
        this.popup = null;
        this.labelEl = null;
        this.isOpen = false;
        this.currentLevel = 'dontAsk';   // mode value from this.modes
        this.currentSessionId = null;
        this.globalDefault = 'dontAsk';  // Default for normal chat
        this.modes = FALLBACK_MODES;        // active session's provider modes
        this.defaultModes = FALLBACK_MODES; // effective default provider's modes
    }

    /**
     * Initialize the permission settings UI
     */
    init() {
        this.btn = document.getElementById('permission-btn');
        this.popup = document.getElementById('permission-popup');
        this.labelEl = this.btn?.querySelector('.permission-label');

        if (!this.btn || !this.popup) {
            console.warn('Permission settings UI elements not found');
            return;
        }

        // Generate popup HTML from the current mode list
        this._renderPopup();

        // Toggle popup on button click
        this.btn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggle();
        });

        // Handle preset selection + "Set as default"
        this.popup.addEventListener('click', (e) => {
            const preset = e.target.closest('.permission-preset');
            if (preset) {
                this.selectLevel(preset.dataset.level);
                return;
            }
            const def = e.target.closest('.permission-set-default');
            if (def) this._saveAsGlobalDefault();
        });

        // Close on outside click
        document.addEventListener('click', (e) => {
            if (this.isOpen && !this.btn.contains(e.target) && !this.popup.contains(e.target)) {
                this.close();
            }
        });

        // Close on Escape
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.isOpen) {
                this.close();
                e.stopPropagation();
            }
        });

        // Load global defaults
        this.loadGlobalDefaults();
    }

    /**
     * Look up a mode by value in the active list (fallback: strings.yaml set,
     * so a level persisted under another provider still labels the button).
     */
    _modeInfo(value) {
        return this.modes.find(m => m.value === value)
            || FALLBACK_MODES.find(m => m.value === value)
            || null;
    }

    /**
     * Adopt a server-delivered mode list (the session provider's own vocabulary)
     * and re-render the popup if it changed.
     */
    _applyModes(modes) {
        const next = (Array.isArray(modes) && modes.length) ? modes : this.defaultModes;
        const same = next.length === this.modes.length
            && next.every((m, i) => m.value === this.modes[i].value);
        this.modes = next;
        if (!same) {
            this._renderPopup();
            if (this.isOpen) this.updatePresetSelection();
        }
    }

    /**
     * Generate popup HTML from the active mode list
     */
    _renderPopup() {
        const presets = this.modes.map(m => {
            return `<button class="permission-preset" data-level="${m.value}">
                <span class="preset-dot" style="background:${m.color}"></span>
                <div class="preset-info">
                    <span class="preset-label">${m.label}<span class="preset-default-tag">default</span></span>
                    <span class="preset-desc">${m.desc}</span>
                </div>
                <span class="preset-check"></span>
            </button>`;
        }).join('');

        this.popup.innerHTML = `
            <div class="permission-popup-header">${S.permissions.header}</div>
            <div class="permission-presets">${presets}</div>
            <div class="permission-popup-footer">
                <button class="permission-set-default">Set as default</button>
            </div>`;
    }

    /**
     * Synchronous seed on session switch: adopt the session provider's mode
     * vocabulary from the registry and the session's cached/pending level, so
     * the first paint after a tab switch is provider-correct. The server fetch
     * in setSession() then merely confirms (and refreshes the caches).
     */
    _seedFromSession(opts = {}) {
        const session = window.app?.activeSession;
        const engName = session?.provider
            || (opts.pendingProvider !== undefined
                ? opts.pendingProvider
                : session?.pendingProvider)
            || null;
        const eng = engName ? providerInfo(engName) : null;
        if (eng?.permission_modes?.length) {
            this._applyModes(eng.permission_modes);
        } else if (!engName) {
            this._applyModes(this.defaultModes);
        }
        const cached = [session?.permissionLevel, session?.pendingPermission,
            this.globalDefault].find(v => v && this._modeInfo(v));
        this.currentLevel = cached
            || eng?.default_permission_mode
            || this.currentLevel;
        this.updateButtonState();
    }

    /**
     * Set current session and load its permission level
     * Called when switching tabs/sessions
     */
    async setSession(sessionId, opts = {}) {
        this.currentSessionId = sessionId;
        this._seedFromSession(opts);

        if (!sessionId) {
            // Unconnected session — show the modes of the provider it WILL run
            // on: the tab's picked provider (pendingProvider) if any, else the
            // box default. Restore any pending choice stashed on the session
            // object, or fall back to global default.
            const session = window.app?.activeSession;
            const pendingProvider = opts.pendingProvider !== undefined
                ? opts.pendingProvider
                : (session?.pendingProvider || null);
            if (pendingProvider) {
                try {
                    const r = await fetch(`${CONFIG.API_BASE}/api/app/default-permissions?provider=${encodeURIComponent(pendingProvider)}`);
                    // Bail if a newer setSession() superseded us during the await.
                    if (this.currentSessionId !== sessionId) return;
                    if (r.ok) {
                        const data = await r.json();
                        if (Array.isArray(data.modes) && data.modes.length) {
                            this._applyModes(data.modes);
                        }
                        // A stashed choice only survives if this provider speaks it.
                        this.currentLevel = this._modeInfo(session?.pendingPermission)
                            ? session.pendingPermission
                            : (this._modeInfo(data.default_level) ? data.default_level : this.currentLevel);
                        this.updateButtonState();
                        return;
                    }
                } catch (err) { /* fall through to default-provider modes */ }
                if (this.currentSessionId !== sessionId) return;
            }
            this._applyModes(this.defaultModes);
            this.currentLevel = session?.pendingPermission || this.globalDefault;
            this.updateButtonState();
            return;
        }

        try {
            const response = await fetch(`${CONFIG.API_BASE}/api/session/${sessionId}/permission-mode`);
            // Bail if a newer setSession() superseded us during the await.
            if (this.currentSessionId !== sessionId) return;
            if (response.ok) {
                const data = await response.json();
                this._applyModes(data.modes);
                this.globalDefault = this._modeInfo(data.global_default) ? data.global_default : 'dontAsk';
                // A brand-new session has no stored per-session level yet. Fall
                // back to the global default (e.g. YOLO) rather than a hardcoded
                // 'dontAsk', which would silently override it after first send.
                // A global default this provider doesn't speak (cross-provider)
                // falls through to the provider's own default.
                this.currentLevel = this._modeInfo(data.permission_level)
                    ? data.permission_level
                    : (this._modeInfo(this.globalDefault)
                        ? this.globalDefault
                        : (data.provider_default || 'dontAsk'));
                // Cache on the session so the next switch seeds synchronously.
                const sess = window.app?.sessionManager?.sessions
                    ?.find(s => s.storeId === sessionId);
                if (sess) sess.permissionLevel = this.currentLevel;
                this.updateButtonState();
            }
        } catch (err) {
            console.error('Error loading session permission mode:', err);
            this.currentLevel = this.globalDefault;
            this.updateButtonState();
        }
    }

    /**
     * Toggle popup visibility
     */
    toggle() {
        if (this.isOpen) {
            this.close();
        } else {
            this.open();
        }
    }

    /**
     * Open popup
     */
    open() {
        // Position popup above the button (fixed positioning)
        const btnRect = this.btn.getBoundingClientRect();
        this.popup.style.bottom = `${window.innerHeight - btnRect.top + 8}px`;
        this.popup.style.right = `${window.innerWidth - btnRect.right}px`;

        this.popup.classList.add('open');
        this.isOpen = true;
        this.updatePresetSelection();
    }

    /**
     * Close popup
     */
    close() {
        this.popup.classList.remove('open');
        this.isOpen = false;
    }

    /**
     * Select a permission level and apply to session
     */
    async selectLevel(level) {
        if (level === this.currentLevel) {
            this.close();
            return;
        }

        const previousLevel = this.currentLevel;
        this.currentLevel = level;
        this.updateButtonState();
        this.close();

        if (!this.currentSessionId) {
            // No storeId yet — stash on the active session so the choice
            // survives tab switches. Picked up on first connect. Use
            // "Set as default" to promote to global.
            const session = window.app?.activeSession;
            if (session) session.pendingPermission = level;
            return;
        }

        // Cache on the session so the next tab switch seeds synchronously.
        {
            const sess = window.app?.activeSession;
            if (sess?.storeId === this.currentSessionId) sess.permissionLevel = level;
        }

        // Save to session meta
        try {
            await fetch(`${CONFIG.API_BASE}/api/session/${this.currentSessionId}/permission-mode`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ permission_level: level })
            });
        } catch (err) {
            console.error('Error saving session permission mode:', err);
        }

        // If there's a WebSocket connection, send permission mode change.
        // On live-controls providers (claude-sdk) the server applies it to
        // the running provider immediately — even mid-turn; elsewhere it takes
        // effect on the next message via the lazy respawn. The reply's
        // `applied` field says which one happened.
        const session = window.app?.activeSession;
        if (session?.ws && session.ws.readyState === WebSocket.OPEN) {
            session.ws.send(JSON.stringify({
                type: 'set_permission_mode',
                mode: level
            }));
        }
    }

    /**
     * Save current level as the global default (explicit user action from
     * the popup footer). Mirrors token-profile's _saveAsGlobalDefault.
     */
    async _saveAsGlobalDefault() {
        const level = this.currentLevel;
        this.close();
        await this.saveToGlobal(level);

        // Sync Settings panel dropdown if open
        const sel = document.querySelector('#default-permission-level');
        if (sel) sel.value = level;
    }

    /**
     * Save to global config (when no session)
     */
    async saveToGlobal(level) {
        try {
            await fetch(`${CONFIG.API_BASE}/api/app/default-permissions`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ permission_level: level })
            });
            this.globalDefault = level;
        } catch (err) {
            console.error('Error saving global permission level:', err);
        }
    }

    /**
     * Load global defaults from server
     */
    async loadGlobalDefaults() {
        try {
            const response = await fetch(`${CONFIG.API_BASE}/api/app/default-permissions`);
            if (response.ok) {
                const data = await response.json();
                if (Array.isArray(data.modes) && data.modes.length) {
                    this.defaultModes = data.modes;
                }
                this._applyModes(this.defaultModes);
                this.globalDefault = this._modeInfo(data.default_level) ? data.default_level : 'dontAsk';
                this.currentLevel = this.globalDefault;
                this.updateButtonState();
            }
        } catch (err) {
            console.error('Error loading global permission defaults:', err);
            this.currentLevel = 'dontAsk';
            this.updateButtonState();
        }
    }

    /**
     * Update button appearance based on current level
     */
    updateButtonState() {
        if (!this.btn) return;

        const info = this._modeInfo(this.currentLevel)
            || this._modeInfo('bypassPermissions')
            || this.modes[0];
        this.btn.dataset.level = this.currentLevel;
        // Inline color so provider-specific modes need no per-mode CSS rule
        this.btn.style.color = info.color || '';
        // strings.yaml carries hand-written tooltips for the common modes;
        // provider-specific extras fall back to the template.
        const tooltip = S.permissions.levels[this.currentLevel]?.tooltip
            || S.permissions.tooltip_template
                .replace('{label}', info.label)
                .replace('{desc}', info.desc);
        this.btn.setAttribute('data-tooltip', tooltip);

        if (this.labelEl) {
            this.labelEl.textContent = info.label;
        }

        // Set permission color on input container for focus-within border
        const container = document.getElementById('input-container');
        if (container) {
            container.style.setProperty('--permission-color', info.color);
        }

        // Fresh-session setup panel mirrors this state — keep its pills in
        // sync however the level changed (popup, cycle shortcut, session load).
        window.sessionSetupPanel?.refresh();
    }

    /**
     * Update which preset appears selected + which one carries the
     * "default" tag (the global default). Called on every popup open.
     */
    updatePresetSelection() {
        const presets = this.popup.querySelectorAll('.permission-preset');
        presets.forEach(preset => {
            preset.classList.toggle('selected', preset.dataset.level === this.currentLevel);
            preset.classList.toggle('is-default', preset.dataset.level === this.globalDefault);
        });
    }

    /**
     * Get current level key
     */
    getLevel() {
        return this.currentLevel;
    }

    /**
     * Human label for a mode value (deny explainers, status lines)
     */
    getModeLabel(value) {
        return this._modeInfo(value)?.label || value;
    }

    /**
     * Get the value to pass to the agent CLI (null for unknown mode)
     */
    getLevelValue() {
        return this._modeInfo(this.currentLevel)?.value ?? null;
    }

    /**
     * Cycle through permission levels (for keyboard shortcut)
     */
    cycle() {
        const values = this.modes.map(m => m.value);
        const idx = values.indexOf(this.currentLevel);
        this.selectLevel(values[(idx + 1) % values.length]);
    }
}

// Singleton instance
export const permissionSettings = new PermissionSettingsManager();

// Expose globally for config widget and session.js access
window.permissionSettings = permissionSettings;

// Auto-initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => permissionSettings.init());
} else {
    permissionSettings.init();
}
