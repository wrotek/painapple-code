/**
 * Shortcut Hints Overlay
 *
 * Renders a compact cheat-sheet of shortcuts on top of the empty chat input.
 * Auto-hides once the user starts typing or when input is not in default mode.
 *
 * Config (in localStorage key 'claude-code-user-config'):
 *   shortcutHints: {
 *     enabled: boolean,     // master on/off, default true
 *     ids: string[]         // shortcut IDs to show; undefined = use DEFAULT_HINT_IDS
 *   }
 */

import S from './strings.js';
import { SHORTCUTS, resolveKeys, formatKeyForDisplay } from './shortcuts.js';

const CONFIG_STORAGE_KEY = 'claude-code-user-config';

/**
 * Ordered list of shortcut IDs offered as hint candidates.
 * Keep this curated — order here is the order in the config UI.
 */
export const HINT_CANDIDATE_IDS = [
    'focusInput',
    'togglePromptExplorer',
    'newSession',
    'newScratch',
    'closeTab',
    'quickSwitcher',
    'browseSessions',
    'prevTab',
    'nextTab',
    'help',
    'settings',
    'search',
    'toggleTerminal',
    'toggleFiles',
    'toggleLogs',
    'toggleChanges',
    'toggleGit',
    'toggleHistoryExplorer',
    'toggleCostAnalytics',
    'toggleQuickActions',
    'toggleDiscussion',
    'toggleSkills',
    'toggleCommands',
    'toggleThinkingSettings',
    'connect',
];

/**
 * Default set shown when user hasn't customized.
 * Sized so the cheat-sheet fits inside the compact fixed-height textarea
 * without pushing layout: 3 cols × 3 rows max at desktop widths.
 * Order is row-major — first 3 land in the most-visible top row.
 */
export const DEFAULT_HINT_IDS = [
    'focusInput',
    'quickSwitcher',
    'toggleTerminal',
    'togglePromptExplorer',
    'newSession',
    'closeTab',
    'toggleHistoryExplorer',
    'toggleSkills',
    'toggleThinkingSettings',
];

function loadConfig() {
    try {
        const raw = localStorage.getItem(CONFIG_STORAGE_KEY);
        if (!raw) return {};
        return JSON.parse(raw) || {};
    } catch (e) {
        return {};
    }
}

function saveConfig(config) {
    try {
        localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(config));
    } catch (e) {
        console.error('[shortcut-hints] save failed', e);
    }
}

export function getHintsConfig() {
    const cfg = loadConfig();
    const hints = cfg.shortcutHints || {};
    return {
        enabled: hints.enabled !== false,  // default true
        ids: Array.isArray(hints.ids) ? hints.ids : DEFAULT_HINT_IDS.slice()
    };
}

export function setHintsEnabled(enabled) {
    const cfg = loadConfig();
    cfg.shortcutHints = { ...(cfg.shortcutHints || {}), enabled: !!enabled };
    saveConfig(cfg);
}

export function setHintIds(ids) {
    const cfg = loadConfig();
    cfg.shortcutHints = { ...(cfg.shortcutHints || {}), ids: Array.isArray(ids) ? ids : [] };
    saveConfig(cfg);
}


function getShortcutById(id) {
    return SHORTCUTS.find(s => s.id === id);
}

/**
 * Resolve a shortcut ID to its current primary key (honoring user overrides).
 * Returns { key, label } or null if not found.
 */
function resolveHint(id, userOverrides) {
    const sc = getShortcutById(id);
    if (!sc) return null;
    const hasOverride = !!userOverrides[id];
    const keys = hasOverride ? userOverrides[id] : resolveKeys(sc);
    if (!keys || !keys.length) return null;
    return { key: formatKeyForDisplay(keys[0]), label: sc.label };
}

/**
 * Singleton controller for the overlay element.
 */
class ShortcutHintsController {
    constructor() {
        this.el = null;
        this.visible = false;
        this.suppressed = false;  // forced off by mode (shell/plan)
    }

    init() {
        this.el = document.getElementById('shortcut-hints-overlay');
        if (!this.el) return;
        this.wrapper = this.el.closest('.input-textarea-wrapper');
        this.render();
    }

    /**
     * Rebuild overlay contents from current config.
     * Also toggles .has-hints on the wrapper so textarea min-height bumps up
     * (prevents layout jump when user starts typing).
     */
    render() {
        if (!this.el) return;
        const { enabled, ids } = getHintsConfig();
        const active = enabled && ids.length > 0;

        if (this.wrapper) {
            this.wrapper.classList.toggle('has-hints', active);
        }

        if (!active) {
            this.el.innerHTML = '';
            this.el.classList.add('empty');
            return;
        }

        const cfg = loadConfig();
        const userOverrides = cfg.shortcuts || {};

        const rows = ids
            .map(id => resolveHint(id, userOverrides))
            .filter(Boolean);

        if (!rows.length) {
            this.el.innerHTML = '';
            this.el.classList.add('empty');
            if (this.wrapper) this.wrapper.classList.remove('has-hints');
            return;
        }

        this.el.classList.remove('empty');
        this.el.innerHTML = `
            <div class="shortcut-hints-grid">
                ${rows.map(r => `
                    <div class="shortcut-hints-pair">
                        <kbd class="shortcut-hints-key">${r.key}</kbd>
                        <span class="shortcut-hints-label">${r.label}</span>
                    </div>
                `).join('')}
            </div>
        `;
    }

    /**
     * Called by input-handler whenever input mode changes.
     * Shell/plan modes suppress the overlay regardless of content.
     */
    setMode(mode) {
        this.suppressed = mode === 'shell' || mode === 'plan';
        this._sync();
    }

    /**
     * Called by input-handler whenever input content changes.
     */
    updateVisibility(textareaValue) {
        const isEmpty = !textareaValue || textareaValue.length === 0;
        this.visible = isEmpty;
        this._sync();
    }

    _sync() {
        if (!this.el) return;
        const { enabled, ids } = getHintsConfig();
        const shouldShow = enabled
            && !this.suppressed
            && this.visible
            && ids.length > 0;
        this.el.classList.toggle('visible', shouldShow);
    }

    /**
     * Force re-render after config changes.
     */
    refresh() {
        this.render();
        this._sync();
    }
}

export const ShortcutHints = new ShortcutHintsController();

// Initialize on DOM ready
if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => ShortcutHints.init());
    } else {
        ShortcutHints.init();
    }
    // Expose for debugging and test hooks (consistent with window.app, window.permissionSettings)
    if (typeof window !== 'undefined') {
        window.ShortcutHints = ShortcutHints;
    }
}
