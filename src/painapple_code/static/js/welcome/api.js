/**
 * Data loaders + state mutations triggered by user actions.
 *
 * Every mutation that needs the welcome screen redrawn calls
 * `renderWelcomeScreen` from the orchestrator. This is a circular import
 * (api.js ← welcome.js orchestrator → api.js), but ES modules resolve it
 * via live bindings — `renderWelcomeScreen` is a hoisted function
 * declaration in welcome.js, so it's available by the time these handlers
 * fire.
 */

import { CONFIG } from '../config.js';
import { state } from './state.js';
import { renderWelcomeScreen } from '../welcome.js';
import { setProjectColorOverride } from '../project-colors.js';

// ═══════════════════════════════════════════════════════════════════════════
// DATA LOADERS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Load recent sessions with enriched data.
 */
export async function loadRecentSessions() {
    try {
        // Fetch more sessions for grouped view
        const response = await fetch(`${CONFIG.API_BASE}/api/welcome/sessions?limit=${CONFIG.SESSION_LIST_LIMIT}`);
        if (!response.ok) throw new Error('Failed to load sessions');

        const data = await response.json();
        state.sessions = data.sessions || [];
    } catch (e) {
        console.error('Failed to load recent sessions:', e);
        state.sessions = [];
    }
}

/**
 * Load projects for picker.
 */
export async function loadProjects() {
    try {
        const response = await fetch(`${CONFIG.API_BASE}/api/welcome/projects`);
        if (!response.ok) throw new Error('Failed to load projects');

        const data = await response.json();
        state.projects = data.projects || [];
        state.workspaceDirs = data.workspace_dirs || [];
        state.workspaceRoot = data.workspace_root || null;
        // Refresh custom-color overrides from the per-project `color` field so
        // welcome cards paint the assigned accent without a second request.
        for (const p of state.projects) {
            if (p.color) setProjectColorOverride(p.path, p.color);
        }
    } catch (e) {
        console.error('Failed to load projects:', e);
        state.projects = [];
        state.workspaceDirs = [];
        state.workspaceRoot = null;
    }
}

/**
 * Load favorites.
 */
export async function loadFavorites() {
    try {
        const response = await fetch(`${CONFIG.API_BASE}/api/favorites`);
        if (!response.ok) throw new Error('Failed to load favorites');

        const data = await response.json();
        state.favorites = data.favorites || [];

        // Build lookup set for quick isFavorite checks
        state.favoritesSet = new Set(state.favorites.map(f => f.session_id));
    } catch (e) {
        console.error('Failed to load favorites:', e);
        state.favorites = [];
        state.favoritesSet = new Set();
    }
}

/**
 * Load active sessions (where Claude is running) and update state.
 */
export async function loadActiveSessions() {
    try {
        const response = await fetch(`${CONFIG.API_BASE}/api/active-sessions`);
        if (!response.ok) throw new Error('Failed to load active sessions');

        const data = await response.json();
        state.runningSessionIds = new Set(
            (data.sessions || [])
                .filter(s => s.is_running)
                .map(s => s.store_id)
        );
    } catch (e) {
        console.error('Failed to load active sessions:', e);
        state.runningSessionIds = new Set();
    }
}

/**
 * Update which sessions are currently open in tabs.
 * Called from initWelcomeScreen and can be refreshed.
 */
export function updateOpenSessionIds() {
    const app = window.app;
    if (!app?.sessionManager?.sessions) {
        state.openSessionIds = new Set();
        return;
    }

    state.openSessionIds = new Set(
        app.sessionManager.sessions
            .filter(s => s.storeId)
            .map(s => s.storeId)
    );
}

/**
 * Merge local sessions (open in tabs but not in API response) into state.sessions.
 * This ensures new sessions without server-side data still appear.
 */
export function mergeLocalSessions() {
    const app = window.app;
    if (!app?.sessionManager?.sessions) return;

    const existingIds = new Set(state.sessions.map(s => s.session_id));

    for (const localSession of app.sessionManager.sessions) {
        // Skip if no storeId (not yet saved to server) or already in list
        if (!localSession.storeId || existingIds.has(localSession.storeId)) continue;

        // Create a session object that matches the API format
        const apiSession = {
            session_id: localSession.storeId,
            name: localSession.name || null,
            project: localSession.cwd ? localSession.cwd.split('/').pop() : 'New Session',
            project_path: localSession.cwd || '',
            created_at: localSession.createdAt,
            last_activity: localSession.lastActivity || localSession.createdAt,
            summary: null,
            tags: [],
            files_changed: [],
            total_cost: localSession.totalCost || 0,
            turn_count: localSession.messages?.length || 0,
            message_count: localSession.messages?.length || 0,
            forked_from: null,
            is_comment_thread: false,
            // Mark as local-only for special rendering
            _isLocalOnly: true,
        };

        // Add at the beginning (most recent)
        state.sessions.unshift(apiSession);
        existingIds.add(localSession.storeId);
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// MUTATIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Toggle favorite status for a session.
 * @param {string} sessionId - Session to toggle
 * @param {HTMLElement} container - Container for re-rendering
 * @param {string} note - Optional note (only used when adding)
 * @returns {Promise<boolean>} New favorite status
 */
export async function toggleFavorite(sessionId, container, note = null) {
    const isFav = state.favoritesSet.has(sessionId);

    try {
        if (isFav) {
            // Remove from favorites
            const response = await fetch(`${CONFIG.API_BASE}/api/favorites/${sessionId}`, {
                method: 'DELETE',
            });
            if (!response.ok) throw new Error('Failed to remove favorite');

            state.favoritesSet.delete(sessionId);
            state.favorites = state.favorites.filter(f => f.session_id !== sessionId);
        } else {
            // Add to favorites (only include note if it's not null/undefined)
            const body = note ? { note } : {};
            const response = await fetch(`${CONFIG.API_BASE}/api/favorites/${sessionId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (!response.ok) throw new Error('Failed to add favorite');

            await response.json();
            state.favoritesSet.add(sessionId);

            // Find session data to add to favorites list
            const session = state.sessions.find(s => s.session_id === sessionId);
            if (session) {
                state.favorites.unshift({
                    session_id: sessionId,
                    note: note,
                    added_at: new Date().toISOString(),
                    session: {
                        name: session.name || session.project || 'Session',
                        project: session.project,
                        project_path: session.project_path,
                        last_activity: session.last_activity,
                        summary: session.summary,
                        tags: session.tags || [],
                        total_cost: session.total_cost,
                    }
                });
            }
        }

        // Re-render to update star icons
        renderWelcomeScreen(container);
        return !isFav;
    } catch (e) {
        console.error('Failed to toggle favorite:', e);
        return isFav; // Return original state on error
    }
}

/**
 * Rename a session (sets manual_name flag to prevent summary-fork overwrite).
 * @param {string} sessionId
 * @param {string} currentName - Current name to show in prompt
 * @param {HTMLElement} container
 */
export async function renameSession(sessionId, currentName, container) {
    const newName = prompt('Rename session:', currentName);
    if (!newName || newName === currentName) return;

    try {
        const response = await fetch(`${CONFIG.API_BASE}/api/sessions/${sessionId}/rename`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: newName }),
        });

        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.detail || 'Failed to rename session');
        }

        // Update local state
        const session = state.sessions.find(s => s.session_id === sessionId);
        if (session) {
            session.name = newName;
        }

        // Update favorites if this session is favorited
        const fav = state.favorites.find(f => f.session_id === sessionId);
        if (fav && fav.session) {
            fav.session.name = newName;
        }

        // Re-render
        renderWelcomeScreen(container);
    } catch (e) {
        console.error('Failed to rename session:', e);
        alert('Failed to rename session: ' + e.message);
    }
}

/**
 * Rename a project (set human-friendly display name).
 * @param {string} projectPath - Full project path
 * @param {string} currentName - Current display name
 * @param {HTMLElement} container
 */
export async function renameProject(projectPath, currentName, container) {
    const newName = prompt('Project display name:', currentName);
    if (newName === null || newName === currentName) return;

    try {
        const response = await fetch(`${CONFIG.API_BASE}/api/project/rename?cwd=${encodeURIComponent(projectPath)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: newName }),
        });

        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.detail || 'Failed to rename project');
        }

        const result = await response.json();

        // Update local state - update all sessions with this project path
        for (const session of state.sessions) {
            if (session.project_path === projectPath) {
                session.project = result.display_name;
            }
        }

        // Re-render
        renderWelcomeScreen(container);
    } catch (e) {
        console.error('Failed to rename project:', e);
        alert('Failed to rename project: ' + e.message);
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// PROJECT FILTER
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Filter by the currently keyboard-selected item's project (Alt+Enter).
 * Works for project chips, sessions, and favorites.
 */
export function filterSelectedProject(container) {
    const idx = state.selectedResultIndex;
    if (idx < 0 || !state.selectableItems?.[idx]) return;

    const item = state.selectableItems[idx];
    let projectPath, projectName;

    if (item.type === 'project') {
        projectPath = item.path;
        projectName = item.name;
    } else if ((item.type === 'session' || item.type === 'favorite') && item.session) {
        projectPath = item.session.project_path;
        projectName = item.session.project;
    }

    if (projectPath) {
        state.selectedResultIndex = -1;
        setProjectFilter(projectPath, projectName, container);
    }
}

/**
 * Set project filter to show only sessions from this project.
 * @param {string} projectPath - Full project path
 * @param {string} projectName - Display name
 * @param {HTMLElement} container
 */
export function setProjectFilter(projectPath, projectName, container) {
    state.projectFilter = { path: projectPath, name: projectName };
    state.quickSearchFilter = ''; // Clear text search when setting project filter
    renderWelcomeScreen(container);

    // Focus search input for additional filtering
    requestAnimationFrame(() => {
        container.querySelector('.welcome-search-input')?.focus();
    });
}

/**
 * Clear project filter.
 * @param {HTMLElement} container
 */
export function clearProjectFilter(container) {
    state.projectFilter = null;
    renderWelcomeScreen(container);
}

