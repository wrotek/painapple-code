/**
 * Config-widget state — the singleton ConfigState instance everything in
 * config/* reads and mutates, plus the storage helpers and constants that
 * every other section needs (load/save user config, layout/opacity/auto-
 * correct application, tool-collapse defaults, the {model} string
 * substitution that drives rich-commit toggles).
 *
 * Sub-modules (shortcut-editor, quick-actions-tab, commit-sections,
 * dir-autocomplete, system-controls, models-tab, gestures) and the
 * config-widget.js orchestrator all `import { state } from './state.js'`
 * to share the same singleton — same pattern as selection/state.js (C.4)
 * and welcome/state.js (C.5).
 */

import S from '../../strings.js';
import { CONFIG } from '../../config.js';
import { CONFIG_STORAGE_KEY, pushServerShortcuts } from '../../shortcuts.js';
import { getSummaryModelLabel } from '../../status-bar.js';

/** Substitute {model} with the configured auto-journal model label. */
export function subModel(s) {
    return String(s ?? '').replace(/\{model\}/g, getSummaryModelLabel());
}

// ═══════════════════════════════════════════════════════════════════════════
// Storage and Config Utilities
// ═══════════════════════════════════════════════════════════════════════════

export const LAYOUT_MODES = Object.fromEntries(
    Object.entries(S.settings.layout_modes).map(([k, v]) => [k, v.label])
);

export const DEFAULT_COLLAPSE_MODES = {
    normal:   { read: 'compact',   write: 'compact', execute: 'compact' },
    thinking: { read: 'collapsed', write: 'compact', execute: 'compact' },
    agent:    { read: 'collapsed', write: 'compact', execute: 'collapsed' }
};

/**
 * Load user configuration from localStorage
 */
export function loadUserConfig() {
    try {
        const saved = localStorage.getItem(CONFIG_STORAGE_KEY);
        if (saved) {
            return JSON.parse(saved);
        }
    } catch (e) {
        console.error('Failed to load user config:', e);
    }
    return { shortcuts: {}, layout: 'normal', railExpanded: false, sessionListLimit: CONFIG.DEFAULT_SESSION_LIST_LIMIT, disableAutocorrect: false, highlightThinkingKeywords: false, annotateOnPaste: false, terminalClipboardWrite: false, floatingButtonsOpacity: 0.7, selectionInPreview: false, downloadMode: 'auto', toolCollapseMode: 'compact', thinkingToolCollapseMode: 'collapsed', toolCollapseModes: structuredClone(DEFAULT_COLLAPSE_MODES) };
}

/**
 * Save user configuration to localStorage
 */
export function saveUserConfig(config) {
    try {
        localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(config));
    } catch (e) {
        console.error('Failed to save user config:', e);
    }
}

/**
 * Apply layout mode to document
 */
export function applyLayout(mode) {
    if (!LAYOUT_MODES[mode]) mode = 'normal';
    document.documentElement.dataset.layout = mode;
}

/**
 * Apply floating buttons opacity (FAB, chat navigator) when inactive
 * @param {number} opacity - Opacity value between 0 and 1
 */
export function applyFloatingButtonsOpacity(opacity) {
    // Clamp between 0.1 and 1.0
    const clamped = Math.max(0.1, Math.min(1.0, opacity));
    document.documentElement.style.setProperty('--floating-opacity-inactive', clamped);
}

/**
 * Check if thinking keywords highlighting is enabled
 * @returns {boolean} true if enabled (default: false)
 */
export function isThinkingKeywordsHighlightingEnabled() {
    const config = loadUserConfig();
    return config.highlightThinkingKeywords === true;
}

/**
 * Check if selection mode is enabled for file preview widgets
 * @returns {boolean} true if enabled (default: false)
 */
export function isSelectionInPreviewEnabled() {
    const config = loadUserConfig();
    return config.selectionInPreview === true;
}

/**
 * Check if pasting an image should auto-open the annotation editor.
 * When off (default), Cmd/Ctrl+Shift+V opens the editor instead.
 * @returns {boolean} true if enabled (default: false)
 */
export function isAnnotateOnPasteEnabled() {
    const config = loadUserConfig();
    return config.annotateOnPaste === true;
}

/**
 * Get the tool category (read/write/execute) for a given tool name.
 * Categories are defined in strings.yaml under settings.tool_categories.
 */
export function getToolCategory(toolName) {
    const cats = S.settings.tool_categories || {};
    for (const [category, tools] of Object.entries(cats)) {
        if (tools?.includes?.(toolName)) return category;
    }
    return 'execute';
}

/**
 * Get the user's preferred collapse mode for a given (context, toolType) pair.
 * Falls back to the hardcoded DEFAULT_COLLAPSE_MODES grid.
 */
export function getToolCollapseMode(context = 'normal', toolType = 'execute') {
    const config = loadUserConfig();
    const modes = config.toolCollapseModes || DEFAULT_COLLAPSE_MODES;
    return modes[context]?.[toolType] || DEFAULT_COLLAPSE_MODES[context]?.[toolType] || 'compact';
}

// ═══════════════════════════════════════════════════════════════════════════
// Config State (Singleton)
// ═══════════════════════════════════════════════════════════════════════════

class ConfigState {
    constructor() {
        this.config = loadUserConfig();
        this.activeTab = 'shortcuts';
        this.shortcutEditor = null;
        this.container = null;
        // Project-specific config
        this.projectConfig = null;
        this.projectInfo = null;
        this.projectLoading = false;
        // Global shadow git defaults
        this.shadowGitDefaults = null;
        // Global extra dirs (for all projects)
        this.globalExtraDirs = [];
        // Commit sections config
        this.commitSections = null;
        this.commitSectionsExpanded = true;  // Expanded by default
    }

    save() {
        saveUserConfig(this.config);
    }

    /**
     * Check if we have an active project (session with cwd)
     */
    hasActiveProject() {
        return !!window.app?.activeSession?.cwd;
    }

    /**
     * Get current project cwd
     */
    getProjectCwd() {
        return window.app?.activeSession?.cwd || null;
    }

    /**
     * Load project config from API
     */
    async loadProjectConfig() {
        const cwd = this.getProjectCwd();
        if (!cwd) {
            this.projectConfig = null;
            this.projectInfo = null;
            return;
        }

        this.projectLoading = true;
        try {
            const response = await fetch(`${CONFIG.API_BASE}/api/project/config?cwd=${encodeURIComponent(cwd)}`);
            if (response.ok) {
                const data = await response.json();
                this.projectConfig = data.config || {};
                this.projectInfo = data.project || {};
            }
        } catch (e) {
            console.error('Failed to load project config:', e);
        }
        this.projectLoading = false;
    }

    /**
     * Save project config via API (patch/merge)
     */
    async saveProjectConfig(updates) {
        const cwd = this.getProjectCwd();
        if (!cwd) return;

        try {
            const response = await fetch(`${CONFIG.API_BASE}/api/project/config?cwd=${encodeURIComponent(cwd)}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(updates)
            });
            if (response.ok) {
                const data = await response.json();
                this.projectConfig = data.config || {};
                this.projectInfo = data.project || {};
            }
        } catch (e) {
            console.error('Failed to save project config:', e);
        }
    }

    /**
     * Load global shadow git defaults from API
     */
    async loadShadowGitDefaults() {
        try {
            const response = await fetch(`${CONFIG.API_BASE}/api/user/shadow-git-defaults`);
            if (response.ok) {
                this.shadowGitDefaults = await response.json();
            }
        } catch (e) {
            console.error('Failed to load shadow git defaults:', e);
            // Use hardcoded defaults
            this.shadowGitDefaults = { enabled: true, rich_commits: true };
        }
    }

    /**
     * Save global shadow git defaults via API
     */
    async saveShadowGitDefaults(updates) {
        try {
            const response = await fetch(`${CONFIG.API_BASE}/api/user/shadow-git-defaults`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(updates)
            });
            if (response.ok) {
                this.shadowGitDefaults = await response.json();
            }
        } catch (e) {
            console.error('Failed to save shadow git defaults:', e);
        }
    }

    /**
     * Load commit sections config for current project
     */
    async loadCommitSections() {
        const hash = this.projectInfo?.hash;
        if (!hash) {
            this.commitSections = null;
            return;
        }

        try {
            const response = await fetch(`${CONFIG.API_BASE}/api/bridge/projects/${hash}/commit-sections`);
            if (response.ok) {
                this.commitSections = await response.json();
            }
        } catch (e) {
            console.error('Failed to load commit sections:', e);
            this.commitSections = null;
        }
    }

    /**
     * Save commit sections config for current project
     */
    async saveCommitSections(sectionsUpdate) {
        const hash = this.projectInfo?.hash;
        if (!hash) return;

        try {
            const response = await fetch(`${CONFIG.API_BASE}/api/bridge/projects/${hash}/commit-sections`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sections: sectionsUpdate })
            });
            if (response.ok) {
                this.commitSections = await response.json();
                return true;
            }
        } catch (e) {
            console.error('Failed to save commit sections:', e);
        }
        return false;
    }

    /**
     * Reset commit sections to defaults
     */
    async resetCommitSections() {
        const hash = this.projectInfo?.hash;
        if (!hash) return;

        try {
            const response = await fetch(`${CONFIG.API_BASE}/api/bridge/projects/${hash}/commit-sections/reset`, {
                method: 'POST'
            });
            if (response.ok) {
                this.commitSections = await response.json();
                return true;
            }
        } catch (e) {
            console.error('Failed to reset commit sections:', e);
        }
        return false;
    }

    async loadGlobalExtraDirs() {
        try {
            const response = await fetch(`${CONFIG.API_BASE}/api/bridge/config`);
            if (response.ok) {
                const config = await response.json();
                this.globalExtraDirs = config.extra_dirs || [];
            }
        } catch (e) {
            console.error('Failed to load global extra dirs:', e);
        }
    }

    async saveGlobalExtraDirs(dirs) {
        try {
            const response = await fetch(`${CONFIG.API_BASE}/api/bridge/config`);
            const config = response.ok ? await response.json() : {};
            config.extra_dirs = dirs;
            const saveResponse = await fetch(`${CONFIG.API_BASE}/api/bridge/config`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(config)
            });
            if (saveResponse.ok) {
                this.globalExtraDirs = dirs;
            }
        } catch (e) {
            console.error('Failed to save global extra dirs:', e);
        }
    }

    getShortcutOverrides() {
        return this.config.shortcuts || {};
    }

    saveShortcutOverride(shortcutId, keys) {
        if (!this.config.shortcuts) {
            this.config.shortcuts = {};
        }
        this.config.shortcuts[shortcutId] = keys;
        this.save();
        pushServerShortcuts(this.config.shortcuts);

        // Update the shortcut manager with new bindings
        if (window.app?.shortcutManager) {
            window.app.shortcutManager.reloadShortcuts();
            window.app.refreshRailShortcutTooltips?.();
        }
    }

    removeShortcutOverride(shortcutId) {
        if (this.config.shortcuts) {
            delete this.config.shortcuts[shortcutId];
            this.save();
            pushServerShortcuts(this.config.shortcuts);

            if (window.app?.shortcutManager) {
                window.app.shortcutManager.reloadShortcuts();
                window.app.refreshRailShortcutTooltips?.();
            }
        }
    }

    resetAllShortcuts() {
        this.config.shortcuts = {};
        this.save();
        pushServerShortcuts(this.config.shortcuts);

        if (window.app?.shortcutManager) {
            window.app.shortcutManager.reloadShortcuts();
            window.app.refreshRailShortcutTooltips?.();
        }
    }

    setLayout(mode) {
        if (!LAYOUT_MODES[mode]) mode = 'normal';
        this.config.layout = mode;
        this.save();
        applyLayout(mode);
        // Keep every layout UI (status-bar switcher, config radios) in sync
        window.dispatchEvent(new CustomEvent('layout-changed', { detail: mode }));
    }

    setRailExpanded(expanded) {
        this.config.railExpanded = !!expanded;
        this.save();
    }

    setSessionListLimit(value) {
        const num = parseInt(value, 10);
        if (num >= 10 && num <= 500) {
            this.config.sessionListLimit = num;
            this.save();
        }
    }

    setDisableAutocorrect(disabled) {
        this.config.disableAutocorrect = disabled;
        this.save();
        applyAutocorrectSetting(disabled);
    }

    setHighlightThinkingKeywords(enabled) {
        this.config.highlightThinkingKeywords = enabled;
        this.save();
    }

    setAnnotateOnPaste(enabled) {
        this.config.annotateOnPaste = enabled;
        this.save();
    }

    // OSC 52: whether programs in the terminal may write to the clipboard.
    // Off by default (WP-13, was inverted-default on until 2026-08-15):
    // absent === off, only an explicit opt-in stores true. The default
    // here MUST match the fail-closed read in widgets/terminal/osc52.js —
    // it reads this field straight from localStorage rather than
    // importing this module, and a `true` baked into the defaults object
    // would be persisted by any unrelated save() and silently re-enable
    // the feature for users who never opted in.
    setTerminalClipboardWrite(enabled) {
        this.config.terminalClipboardWrite = enabled;
        this.save();
    }

    setSelectionInPreview(enabled) {
        this.config.selectionInPreview = enabled;
        this.save();
    }

    setDownloadMode(mode) {
        this.config.downloadMode = mode;
        this.save();
    }

    setToolCollapseMode(mode) {
        this.config.toolCollapseMode = mode;
        this.save();
    }

    setThinkingToolCollapseMode(mode) {
        this.config.thinkingToolCollapseMode = mode;
        this.save();
    }

    setCollapseMode(context, toolType, mode) {
        if (!this.config.toolCollapseModes) {
            this.config.toolCollapseModes = structuredClone(DEFAULT_COLLAPSE_MODES);
        }
        if (!this.config.toolCollapseModes[context]) {
            this.config.toolCollapseModes[context] = { ...DEFAULT_COLLAPSE_MODES[context] || DEFAULT_COLLAPSE_MODES.normal };
        }
        this.config.toolCollapseModes[context][toolType] = mode;
        this.save();
    }

}

export const state = new ConfigState();

/**
 * Apply autocorrect setting to main chat input
 */
export function applyAutocorrectSetting(disabled) {
    const input = document.getElementById('message-input');
    if (!input) return;

    if (disabled) {
        input.setAttribute('autocorrect', 'off');
        input.setAttribute('autocapitalize', 'off');
        input.setAttribute('spellcheck', 'false');
    } else {
        input.removeAttribute('autocorrect');
        input.removeAttribute('autocapitalize');
        input.removeAttribute('spellcheck');
    }
}

// Apply saved settings on load
applyLayout(state.config.layout || 'normal');
applyFloatingButtonsOpacity(state.config.floatingButtonsOpacity ?? 0.7);

// Apply autocorrect setting on load (deferred until DOM ready)
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        applyAutocorrectSetting(state.config.disableAutocorrect);
    });
} else {
    // DOM already loaded (module loaded late)
    applyAutocorrectSetting(state.config.disableAutocorrect);
}
