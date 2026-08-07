/**
 * Shared state + mutable cross-module refs for the welcome-screen split.
 *
 * Imported by:
 *   - welcome.js          (orchestrator, public API, main render, event handlers)
 *   - cards.js            (session/family/fork/favorite card renderers)
 *   - families.js         (family build/grouping + compact render + task mode)
 *   - preview.js          (session preview bottom sheet)
 *   - context-menu.js     (long press + session/project context menus)
 *   - api.js              (data loaders, mutations, project filter)
 *
 * Everyone reads/writes the same `state` object directly. The Sets
 * (`expandedGroups` etc.) are mutated in place so const re-export works.
 * Mutable scalars live as `.value`/property holders on small objects so
 * cross-module mutations are visible — top-level `let` only propagates
 * within its own module.
 */

// ═══════════════════════════════════════════════════════════════════════════
// CORE STATE OBJECT
// ═══════════════════════════════════════════════════════════════════════════

export const state = {
    forSessionId: null,       // Which session/tab this state belongs to
    sessions: [],
    familyMap: new Map(),     // rootId -> family object (built from sessions)
    favorites: [],            // Favorited sessions (loaded separately)
    favoritesSet: new Set(),  // Set of favorited session IDs for quick lookup
    searchResults: null,      // Used by task mode
    searchQuery: '',          // Used by task mode
    projects: [],
    isSearching: false,
    showProjectPicker: false,
    selectedProject: null,
    quickSearchFilter: '',    // Quick inline search filter text
    quickSearchActive: false, // Whether inline search input is showing
    selectedResultIndex: -1,  // Keyboard navigation selection (-1 = none)
    selectableItems: [],      // Combined list of projects + sessions for keyboard nav
    taskMode: false,          // True when showing task-related sessions
    pendingTask: null,        // The task message waiting to be sent
    // Preview state
    previewSession: null,     // Session being previewed
    previewMessages: null,    // Messages loaded for preview
    previewLoading: false,    // Loading state for preview
    // Context menu state
    contextMenuSession: null, // Session for context menu
    contextMenuPos: null,     // {x, y} position
    contextMenuContainer: null, // Container reference for callbacks
    // Project filter state
    projectFilter: null,      // {path, name} - active project filter
    projectContextMenu: null, // {path, name, x, y} - project context menu state
    // Session status tracking
    openSessionIds: new Set(),     // store_ids of sessions open in tabs
    runningSessionIds: new Set(),  // store_ids of sessions where Claude is running
    // Workspace dirs (sibling project candidates)
    workspaceDirs: [],
    workspaceRoot: null,
    unvisitedExpanded: false, // Toggled by the "+N more" / "Show less" chip
};

// ═══════════════════════════════════════════════════════════════════════════
// MODULE-LEVEL UI STATE
// ═══════════════════════════════════════════════════════════════════════════

// Project group expansion (task mode + welcome screen).
export const expandedGroups = new Set();

// Family expansion (show forks for a session family).
export const expandedFamilies = new Set();

// "Show all forks" — fully expand a family beyond the first 5.
export const fullyExpandedFamilies = new Set();

// Recent sessions limit (mutable; "Load more" button bumps it).
export const RECENT_INCREMENT = 5;
export const recentLimit = { value: 10 };

// Favorites list limit (mutable; "Show all favorites" button bumps it to all).
export const FAVORITES_DEFAULT_LIMIT = 3;
export const favoritesLimit = { value: FAVORITES_DEFAULT_LIMIT };

// Long-press detection refs. Set by context-menu.js, read by event handlers
// in welcome.js. Wrapped in an object so cross-module mutation is visible.
export const longPress = {
    timer: null,
    triggered: false,
    timestamp: 0,
    suppressNextClick: false,
};

// Context-menu open timestamp (for iOS click-suppression).
export const contextMenuOpenTime = { value: 0 };

// Saved welcome state (for "back to sessions" feature).
// Mutated in welcome.js (clearSavedWelcomeState/restoreWelcomeState) and
// in saveWelcomeState below.
export const savedWelcomeState = { value: null };

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Check if a session is favorited (used by card renderers + context menu).
 */
export function isFavorite(sessionId) {
    return state.favoritesSet.has(sessionId);
}

/**
 * Save the current welcome screen state before opening a session.
 * Lives here (not welcome.js) so preview.js / context-menu.js can call it
 * without a circular import back to the orchestrator.
 */
export function saveWelcomeState(container) {
    const welcomeEl = container.querySelector('.welcome-screen');
    const searchInput = document.querySelector('.input-area textarea');

    savedWelcomeState.value = {
        taskMode: state.taskMode,
        pendingTask: state.pendingTask,
        searchResults: state.searchResults,
        scrollTop: welcomeEl?.scrollTop || 0,
        inputValue: searchInput?.value || '',
        timestamp: Date.now(),
        expandedGroups: Array.from(expandedGroups),
    };
}
