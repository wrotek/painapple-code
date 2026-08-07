/**
 * Effort Settings - Controls the agent's effort level (token spend / thoroughness)
 *
 * Manages the effort button near the input area that controls how much
 * effort the model puts into responses. The level VOCABULARY is per-engine
 * (each provider self-describes its scale via the registry; codex models
 * even self-describe per-model ranges) — the popup, cycle shortcuts and
 * labels all follow the active engine/model.
 *
 * Effort level is stored PER SESSION, with a global default fallback.
 */

import { CONFIG } from './config.js';
import S from './strings.js';

// Fallback scale (claude's five) — used only before the engine registry
// loads; the live vocabulary comes from _vocab().
const FALLBACK_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

class EffortSettingsManager {
    constructor() {
        this.btn = null;
        this.popup = null;
        this.valueEl = null;
        this.isOpen = false;
        this.currentLevel = 'high'; // Default
        this.currentSessionId = null;
        this.globalDefault = 'high';
        // One-shot override: armed via Ctrl+Shift+', applies to the next
        // send only, then auto-clears. Persisted nowhere — purely transient.
        this.pendingOneShot = null;
    }

    /**
     * Initialize the effort settings UI
     */
    init() {
        this.btn = document.getElementById('effort-btn');
        this.popup = document.getElementById('effort-popup');
        this.valueEl = this.btn?.querySelector('.effort-value');

        if (!this.btn || !this.popup) {
            console.warn('Effort settings UI elements not found');
            return;
        }

        // Build the preset list from the active vocabulary
        this._renderPopup();

        // Toggle popup on button click
        this.btn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggle();
        });

        // Handle preset selection + "Set as default"
        this.popup.addEventListener('click', (e) => {
            const preset = e.target.closest('.effort-preset');
            if (preset) {
                this.selectLevel(preset.dataset.level);
                return;
            }
            const def = e.target.closest('.effort-set-default');
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

        // Load global default
        this.loadGlobalDefault();
    }

    /**
     * The ACTIVE effort vocabulary: the picked model's own range when it
     * declares one (codex models self-describe supported levels), else the
     * engine's registry scale, else the classic five-level fallback.
     */
    _vocab() {
        const sb = window.app?.statusBar;
        const engine = sb?._activeEngine?.();
        const models = engine?.models || [];
        const pickedId = sb?.currentModel || sb?.globalDefaultModel;
        const picked = pickedId && models.find(m => pickedId.startsWith(m.id));
        const list = (picked?.efforts?.length ? picked.efforts : engine?.efforts) || [];
        return list.length ? list : FALLBACK_LEVELS;
    }

    /** strings.yaml metadata for a level (label/short/icon/desc) — a level
     * missing there still renders under its raw name. */
    _levelInfo(level) {
        return (S.effort?.levels || {})[level] || null;
    }

    /** Rebuild the preset list from the active vocabulary. Cheap no-op when
     * the vocabulary hasn't changed since the last render. */
    _renderPopup() {
        const host = this.popup?.querySelector('.effort-presets');
        if (!host) return;
        const vocab = this._vocab();
        const key = vocab.join();
        if (this._renderedVocab === key) return;
        this._renderedVocab = key;
        host.innerHTML = vocab.map(level => {
            const info = this._levelInfo(level) || {};
            return `<button class="effort-preset" data-level="${level}">
                <span class="preset-icon">${info.icon || '◌'}</span>
                <span class="preset-label">${info.label || level}<span class="preset-default-tag">default</span></span>
                <span class="preset-desc">${info.desc || ''}</span>
            </button>`;
        }).join('');
    }

    /**
     * Set current session and load its effort level
     * Called when switching tabs/sessions
     */
    async setSession(sessionId) {
        this.currentSessionId = sessionId;

        // Synchronous seed — paint the session's cached level immediately on
        // tab switch (the fetch below only confirms), so the button/setup
        // panel never linger on the previous session's level.
        const session = window.app?.activeSession;
        this.currentLevel = session?.effortLevel || session?.pendingEffort
            || this.globalDefault;
        this.updateButtonState();

        if (!sessionId) return;

        try {
            const response = await fetch(`${CONFIG.API_BASE}/api/session/${sessionId}/effort`);
            // Bail if a newer setSession() superseded us during the await.
            if (this.currentSessionId !== sessionId) return;
            if (response.ok) {
                const data = await response.json();
                this.currentLevel = data.effort_level;
                this.globalDefault = data.global_default;
                // Cache on the session so the next switch seeds synchronously.
                const sess = window.app?.sessionManager?.sessions
                    ?.find(s => s.storeId === sessionId);
                if (sess) sess.effortLevel = data.effort_level || null;
                this.updateButtonState();
            }
        } catch (err) {
            console.error('Error loading session effort level:', err);
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
        // The vocabulary follows the active engine/model — refresh first.
        this._renderPopup();

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
     * Select a level and save to session
     */
    async selectLevel(level) {
        this.currentLevel = level;
        // Explicit level change disarms any pending one-shot — staying armed
        // would be confusing (e.g. armed=xhigh while user just picked max).
        this.pendingOneShot = null;
        this.updateButtonState();
        this.close();

        if (!this.currentSessionId) {
            // No storeId yet — stash on the active session so the choice
            // survives tab switches. It rides out with the first user_message
            // via getLevel(). Use "Set as default" to promote to global.
            const session = window.app?.activeSession;
            if (session) session.pendingEffort = level;
            return;
        }

        // Cache on the session so the next tab switch seeds synchronously.
        {
            const sess = window.app?.activeSession;
            if (sess?.storeId === this.currentSessionId) sess.effortLevel = level;
        }

        try {
            const response = await fetch(`${CONFIG.API_BASE}/api/session/${this.currentSessionId}/effort`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ effort_level: level })
            });

            if (!response.ok) {
                console.error('Failed to save session effort level:', await response.text());
            }
        } catch (err) {
            console.error('Error saving session effort level:', err);
        }
    }

    /**
     * Save current level as the default (explicit user action from the
     * popup footer). Mirrors token-profile's _saveAsGlobalDefault.
     */
    async _saveAsGlobalDefault() {
        const level = this.currentLevel;
        this.close();
        await this.saveToGlobal(level);
    }

    /**
     * Persist the default effort. Defaults are per-engine — target the
     * active session's engine when known, else the legacy endpoint
     * (which writes the DEFAULT engine's entry).
     */
    async saveToGlobal(level) {
        const s = window.app?.activeSession;
        const engine = s?.provider || s?.pendingProvider || null;
        const url = engine
            ? `${CONFIG.API_BASE}/api/bridge/engine-defaults/${encodeURIComponent(engine)}`
            : `${CONFIG.API_BASE}/api/bridge/default-effort`;
        try {
            const response = await fetch(url, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ default_effort: level })
            });

            if (response.ok) {
                this.globalDefault = level;
            } else {
                console.error('Failed to save default effort level:', await response.text());
            }
        } catch (err) {
            console.error('Error saving default effort level:', err);
        }
    }

    /**
     * Load global default from server
     */
    async loadGlobalDefault() {
        try {
            const response = await fetch(`${CONFIG.API_BASE}/api/bridge/default-effort`);
            if (response.ok) {
                const data = await response.json();
                this.globalDefault = data.default_effort || 'high';
                this.currentLevel = this.globalDefault;
                this.updateButtonState();
            }
        } catch (err) {
            console.error('Error loading global effort level:', err);
            this.currentLevel = 'high';
            this.updateButtonState();
        }
    }

    /**
     * Update button appearance based on current level.
     * If a one-shot override is armed, the button shows that level instead
     * (with a "1" badge) so the user sees the level the next send will use.
     */
    updateButtonState() {
        if (!this.btn) return;

        const displayedLevel = this.pendingOneShot || this.currentLevel;
        this.btn.dataset.level = displayedLevel;

        if (this.pendingOneShot) {
            this.btn.dataset.pending = '1';
        } else {
            delete this.btn.dataset.pending;
        }

        const info = this._levelInfo(displayedLevel);
        const baseTitle = (S.effort?.button_title || 'Effort: {label}')
            .replace('{label}', info?.label || displayedLevel || '');
        const tooltipBase = this.pendingOneShot
            ? (S.effort?.tooltip_pending || '{title}').replace('{title}', baseTitle)
            : (S.effort?.tooltip_base || '{title}').replace('{title}', baseTitle);
        this.btn.dataset.shortcutBase = tooltipBase;
        this.btn.setAttribute('data-tooltip', tooltipBase);
        window.app?.refreshRailShortcutTooltips?.();

        if (this.valueEl) {
            this.valueEl.textContent = info?.short || displayedLevel || 'Hi';
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
        const presets = this.popup.querySelectorAll('.effort-preset');
        presets.forEach(preset => {
            preset.classList.toggle('selected', preset.dataset.level === this.currentLevel);
            preset.classList.toggle('is-default', preset.dataset.level === this.globalDefault);
        });
    }

    /**
     * Get current (persistent) effort level. Ignores any armed one-shot.
     */
    getLevel() {
        return this.currentLevel;
    }

    /**
     * Get the level the next send will actually use — the one-shot override
     * if armed, otherwise the persistent level. Does NOT consume the one-shot.
     */
    peekEffectiveLevel() {
        return this.pendingOneShot || this.currentLevel;
    }

    /**
     * Consume the armed one-shot (if any) and return its level. Returns null
     * when nothing is armed. Called from session.js send paths right before
     * the WebSocket message goes out.
     */
    consumeOneShot() {
        const level = this.pendingOneShot;
        if (level) {
            this.pendingOneShot = null;
            this.updateButtonState();
        }
        return level;
    }

    /**
     * Clear an armed one-shot without sending. Currently unused but kept
     * for symmetry with consumeOneShot — useful from future cancel paths.
     */
    clearOneShot() {
        if (this.pendingOneShot) {
            this.pendingOneShot = null;
            this.updateButtonState();
        }
    }

    /**
     * Cycle to next effort level (for keyboard shortcut) through the active
     * engine/model's own vocabulary, wrapping past the top.
     */
    cycle() {
        const levels = this._vocab();
        const currentIndex = levels.indexOf(this.currentLevel);
        const nextIndex = (currentIndex + 1) % levels.length;
        this.selectLevel(levels[nextIndex]);
    }

    /**
     * Cycle the one-shot override (Ctrl+Shift+'). First press arms at the
     * level immediately above the current persistent level (wrapping to low
     * past max). Subsequent presses advance through every other level —
     * including levels BELOW the persistent one — so the user can pick e.g.
     * a one-time low reply while persistent stays at high. When the cycle
     * would land back on the persistent level, it disarms instead.
     */
    cycleOneShot() {
        const levels = this._vocab();
        const curIdx = levels.indexOf(this.currentLevel);
        const len = levels.length;
        if (this.pendingOneShot === null) {
            this.pendingOneShot = levels[(curIdx + 1) % len];
        } else {
            const armedIdx = levels.indexOf(this.pendingOneShot);
            const nextIdx = (armedIdx + 1) % len;
            this.pendingOneShot = nextIdx === curIdx ? null : levels[nextIdx];
        }
        this.updateButtonState();
    }
}

// Singleton instance
export const effortSettings = new EffortSettingsManager();

// Expose globally for config widget access
window.effortSettings = effortSettings;

// Auto-initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => effortSettings.init());
} else {
    effortSettings.init();
}
