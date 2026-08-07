/**
 * Shared state + utilities for the text-selection handler split.
 *
 * Imported by:
 *   - selection-handler.js (orchestrator, public API, container registry)
 *   - action-bar.js        (resizable floating action bar UI)
 *
 * Everyone reads/writes the same `state` object directly (mutable, shared).
 * Late imports (`startThread`, `stashAdd`) are stored on `lateImports` so
 * the live binding is visible across modules — top-level `let` only
 * propagates within its own module.
 */

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

export const CONFIG = {
    // Minimum selection length to trigger
    minSelectionLength: 3,
    // Lines the quote block shows when collapsed (must match the CSS clamp
    // in 45-selection-bar.css — used to decide whether to offer "Show full text")
    quoteClampLines: 2
};

// Check if device is touch-based (for action bar vs floating button decision)
export const IS_TOUCH_DEVICE = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

// Debug mode - set to true to see debug output in Debug Logs widget (Alt+D)
// WARNING: Keep false in production - logging selection changes while selecting
// in Debug Logs creates infinite feedback loop!
const DEBUG = true;

export function debugLog(msg, data = null) {
    if (!DEBUG) return;
    // Use global debug widget API (logs to both console and Debug Logs widget)
    window.debugLog?.('SelectionHandler', msg, data);
}

export function getParentChain(element, maxDepth = 8) {
    const chain = [];
    let el = element;
    while (el && chain.length < maxDepth) {
        chain.push(el.tagName + (el.className ? '.' + el.className.split(' ').join('.') : ''));
        el = el.parentElement;
    }
    return chain.join(' < ');
}

// ═══════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════

export const state = {
    activeContainer: null,      // Currently monitored container
    currentSelection: null,     // { text, range, anchorData } - single selection (for native selection)
    containers: new Map(),      // Registered containers with their config
    // Selection Action Bar elements
    actionBarActive: false,     // Is action bar currently showing
    inputContainer: null,       // #input-container element
    quoteElement: null,         // Quote display element
    quoteWrap: null,            // Quote block wrapper (holds expanded/has-overflow classes)
    quoteToggle: null,          // Expand/collapse chevron on the quote block
    quoteExpanded: false,       // Is the quote block expanded (persisted preference)
    selectionInput: null,       // Textarea for question input
    discussBtn: null,           // Discuss Now button
    stashBtn: null,             // Add to Stash button
    closeBtn: null,             // Close button
    // Multi-select mode (for tap-to-select icons)
    multiSelectMode: false,     // Is multi-select toggled on
    multiSelectBtn: null,       // Toggle button element
    selections: [],             // Array of { text, element, anchorData } for multi-select
    // Editing existing stash: when set, stash submit removes old item before adding new
    editingStashId: null
};

// ═══════════════════════════════════════════════════════════════════════════
// LATE IMPORTS (avoid circular dependency)
// ═══════════════════════════════════════════════════════════════════════════

// Object holds the live references so other modules see updates after
// `ensureImports()` runs. (`let` exports only propagate within the same module.)
export const lateImports = {
    startThread: null,  // DiscussionWidget.startThread
    stashAdd: null      // addToStash from stash-ui.js
};

export async function ensureImports() {
    // Import discussion widget for startThread
    if (!lateImports.startThread) {
        try {
            const module = await import('../widgets/index.js');
            lateImports.startThread = module.DiscussionWidget.startThread;
            debugLog('Discussion widget imported via widgets/index.js');
        } catch (e) {
            debugLog('Failed to import discussion widget', e.message);
        }
    }

    // Import stash for adding references
    if (!lateImports.stashAdd) {
        try {
            const { addToStash } = await import('../stash-ui.js');
            lateImports.stashAdd = addToStash;
            debugLog('Stash UI imported');
        } catch (e) {
            debugLog('Failed to import stash-ui', e.message);
        }
    }
}
