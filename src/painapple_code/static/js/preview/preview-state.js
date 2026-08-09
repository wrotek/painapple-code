/**
 * Preview state management
 *
 * Manages per-instance preview state with swappable pointer.
 * ES module `export let` provides live bindings so all modules
 * always see the current state pointer.
 */

import { findPlugin } from '../preview-plugins/index.js';
import { detectLanguage } from '../file-tabs.js';
import { WidgetManager } from '../widget-system/index.js';

// Cross-module function registry — populated by the orchestrator to avoid circular imports.
// Modules call fns.renderBody(), fns.setupEventHandlers(), etc.
export const fns = {};

export class PreviewState {
    constructor() {
        this.currentPath = null;
        this.content = null;
        this.language = null;
        this.languageOverride = null;
        this.plugin = null;        // matched plugin object (or null for default code view)
        this.pluginState = {};     // per-file state initialized by plugin.initState()
        this.viewMode = 'code';    // 'code' | 'edit' | plugin-defined modes ('rendered', 'table', etc.)
        this.isLoading = false;
        this.error = null;
        this.mtime = null;
        this.scrollToLine = null;
        this.scrollOptions = null;
        // Per-file scroll memory: `${path}::${viewMode}` → scrollTop.
        // Lives on the state (not a module global) so it inherits the same
        // per-session / per-tab isolation as everything else here.
        this.scrollByPath = new Map();
        this.highlightLines = null;
        this.lineRange = null;
        this.cwd = null;
        this.search = { active: false, query: '', matches: [], currentIndex: -1 };
        // Edit state
        this.editor = null;
        this.editBuffer = null;
        this.modified = false;
        this.saving = false;
        // Scratch state
        this.isScratch = false;
        this.scratchId = null;
        // History view state (shadow-git diff browser)
        // Two cursors: From (older side) and To (newer side).
        // Stepper moves To; From auto-tracks "one before To" unless user sets it.
        this.historyCommits = null;       // null = not loaded; [] = no history; [...] = loaded
        this.historyLoading = false;
        this.historyKey = null;           // `${cwd}:${path}` of last loaded history
        this.historyToKind = 'snapshot';  // 'snapshot' | 'head' | 'working'
        this.historyToIndex = 0;          // index into historyCommits when toKind='snapshot'
        this.historyFromKind = 'auto';    // 'auto' | 'initial' | 'snapshot'
        this.historyFromIndex = -1;       // index into historyCommits when fromKind='snapshot'
        this.historyOldContent = null;
        this.historyNewContent = null;
        this.historyOldLabel = null;
        this.historyNewLabel = null;
        this.historyDiffMode = null;      // 'split' | 'unified' (null = derive from container width)
        this.historyWrapLines = null;     // true | false (null = derive from localStorage, default on)
        // Pending seed: when set, loadHistory() applies it after fetching commits
        // instead of using the default (To=newest snapshot, From=auto).
        // Shape: { fromKind, fromHash, toKind, toHash } — hashes resolved by commit lookup.
        this.historyPendingSeed = null;
        // DOM container reference (avoids findPreviewContainer() ambiguity)
        this.container = null;
    }
    reset() {
        if (this.editor) { try { this.editor.destroy(); } catch (e) { /* ignore */ } }
        this.editor = null;
    }
}

// Per-tab state instances: tabId → PreviewState (widget-tab dimension, independent of session)
export const tabStates = new Map();
// Per-session state instances: sessionId → PreviewState (replaces former singleton floatingState)
export const sessionStates = new Map();
// Orphan state used when no session is current yet (e.g., during module init).
// Once a session activates, real per-session state takes over.
const orphanState = new PreviewState();
// Active state pointer — all existing state.foo reads target this
export let state = orphanState;
// Captured at module load (by the queueMicrotask near PATH_STORAGE_KEY below);
// applied one-shot to the first session-state materialized by getSessionState.
let pendingRestorePath = null;

export function getOrCreateTabState(tabId) {
    if (!tabStates.has(tabId)) tabStates.set(tabId, new PreviewState());
    return tabStates.get(tabId);
}

export function removeTabState(tabId) {
    const s = tabStates.get(tabId);
    if (s) { s.reset(); tabStates.delete(tabId); }
}

export function getSessionState(sessionId) {
    if (!sessionId) return orphanState;
    let s = sessionStates.get(sessionId);
    if (!s) {
        s = new PreviewState();
        sessionStates.set(sessionId, s);
        // First session to materialize after app load inherits the persisted
        // "last preview path" (restore-on-reload). Subsequent sessions start fresh.
        if (pendingRestorePath) {
            const path = pendingRestorePath;
            pendingRestorePath = null;
            try {
                s.currentPath = path;
                s.plugin = findPlugin(path);
                s.pluginState = s.plugin?.initState() || {};
                s.language = detectLanguage(path);
                s.isLoading = s.plugin ? s.plugin.needsFetch : true;
            } catch (e) { /* ignore */ }
        }
    }
    return s;
}

export function removeSessionState(sessionId) {
    const s = sessionStates.get(sessionId);
    if (s) { s.reset(); sessionStates.delete(sessionId); }
}

// Activate either a widget-tab state (when tabId is provided) or the current
// session's state. With no current session and no tabId, falls back to orphanState.
export function activateState(tabId) {
    if (tabId) {
        state = getOrCreateTabState(tabId);
        return;
    }
    const sid = WidgetManager.currentSessionId;
    state = sid ? getSessionState(sid) : orphanState;
}

// Helpers
export function isEditMode() { return state.viewMode === 'edit'; }
export function isHistoryMode() { return state.viewMode === 'history'; }
export function isEditable() { return state.plugin ? state.plugin.editable : true; }

export function resetHistory(s = state) {
    s.historyCommits = null;
    s.historyLoading = false;
    s.historyKey = null;
    s.historyToKind = 'snapshot';
    s.historyToIndex = 0;
    s.historyFromKind = 'auto';
    s.historyFromIndex = -1;
    s.historyOldContent = null;
    s.historyNewContent = null;
    s.historyOldLabel = null;
    s.historyNewLabel = null;
    // Note: historyPendingSeed is NOT reset here — callers set it before
    // triggering preview, and loadHistory() consumes it post-fetch.
}

// ── Per-file scroll memory ───────────────────────────────────────────────────
// Reopening a file (Alt+V, the rail button, re-clicking the same link) should
// land where you left it. preview() hard-resets content on every call, so this
// can't ride on the DOM the way the chat's per-session containers do — it has
// to be explicit state.
//
// Keyed by path AND viewMode: the same file scrolls to different offsets in
// code vs rendered vs table view, so one number per path would jump.
// LRU-capped so a long browsing session doesn't grow the map without bound.
export const SCROLL_MEMORY_LIMIT = 50;

function scrollMemoryKey(path, viewMode) {
    return path ? `${path}::${viewMode || 'code'}` : null;
}

export function rememberScroll(path, viewMode, scrollTop, s = state) {
    const key = scrollMemoryKey(path, viewMode);
    if (!key || !s?.scrollByPath) return;
    s.scrollByPath.delete(key);   // re-insert to move it to the MRU end
    s.scrollByPath.set(key, scrollTop);
    if (s.scrollByPath.size > SCROLL_MEMORY_LIMIT) {
        s.scrollByPath.delete(s.scrollByPath.keys().next().value);
    }
}

export function recallScroll(path, viewMode, s = state) {
    const key = scrollMemoryKey(path, viewMode);
    if (!key || !s?.scrollByPath) return null;
    const top = s.scrollByPath.get(key);
    return typeof top === 'number' ? top : null;
}

// Drop every view-mode entry for a path. Used when an explicit line target
// supersedes the remembered position, so the two don't fight over the same
// render (same precedence rule rerenderContent applies to scrollToLine).
export function forgetScroll(path, s = state) {
    if (!path || !s?.scrollByPath) return;
    const prefix = `${path}::`;
    for (const key of [...s.scrollByPath.keys()]) {
        if (key.startsWith(prefix)) s.scrollByPath.delete(key);
    }
}

// Global preference: line wrapping (shared across all instances)
export let wrapLines = false;
export const WRAP_STORAGE_KEY = 'file-preview-wrap';
try {
    wrapLines = localStorage.getItem(WRAP_STORAGE_KEY) === 'true';
} catch (e) { /* ignore */ }

export function setWrapLines(v) { wrapLines = v; }

// Path persistence for app restart. Read here at module load; getSessionState()
// applies pendingRestorePath to the first session-state it materializes (one-shot).
export const PATH_STORAGE_KEY = 'file-preview-path';
queueMicrotask(() => {
    try {
        pendingRestorePath = localStorage.getItem(PATH_STORAGE_KEY) || null;
    } catch (e) { /* ignore */ }
});

// "Last file previewed", deliberately separate from PATH_STORAGE_KEY: that key
// is cleared on close so a reload doesn't resurrect a widget the user shut, and
// it is per-app-restart. This one is never cleared — it's the memory that lets
// the rail button / Alt+V reopen the file you were just looking at after an
// Escape. Only a fallback: a live session's in-memory state.currentPath wins.
export const LAST_PATH_STORAGE_KEY = 'file-preview-last-path';

export function rememberLastPath(path) {
    if (!path) return;
    try {
        localStorage.setItem(LAST_PATH_STORAGE_KEY, path);
    } catch (e) { /* ignore */ }
}

export function getLastPath() {
    try {
        return localStorage.getItem(LAST_PATH_STORAGE_KEY) || null;
    } catch (e) {
        return null;
    }
}

// Plugin helpers object passed to plugin.renderBody() and plugin.setupEvents()
export const pluginHelpers = {
    rerenderContent: () => fns.rerenderContent(),
};
