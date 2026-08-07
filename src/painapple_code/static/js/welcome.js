/**
 * Welcome Screen - Session Discovery (orchestrator).
 *
 * Public API surface for app.js, controllers, and other consumers. The
 * heavy lifting (rendering, family building, preview, context menus, data
 * loading) lives under `welcome/`:
 *
 *   welcome/state.js        Shared state object + module-level mutables
 *   welcome/cards.js        Session/family/fork/favorite card renderers
 *   welcome/families.js     Family build + grouping + compact renderers + task mode
 *   welcome/preview.js      Session preview bottom sheet
 *   welcome/context-menu.js Long-press + session/project context menus
 *   welcome/api.js          Data loaders + favorite/rename mutations + project filter
 *
 * This file glues them together: main render (renderWelcomeScreen),
 * keyboard navigation, event-listener wiring, "back to sessions" state
 * persistence, and the 20 public exports.
 */

import { CONFIG, debug } from './config.js';
import { escapeHtml, extractApiError } from './utils.js';
import { loadUserConfig, saveUserConfig } from './widgets/config-widget.js';

import {
    state,
    expandedGroups,
    expandedFamilies,
    fullyExpandedFamilies,
    RECENT_INCREMENT,
    recentLimit,
    favoritesLimit,
    longPress,
    savedWelcomeState,
    saveWelcomeState,
} from './welcome/state.js';
import {
    renderSessionFamily,
    renderSearchBar,
    patchSearchBar,
    renderFavoritesSection,
} from './welcome/cards.js';
import {
    buildSessionFamilies,
    groupFamiliesByProject,
    renderTaskMode,
    renderFamilyProjectGroup,
    renderProjectsQuickStart,
} from './welcome/families.js';
import {
    showPreview,
    closeSessionPreview,
} from './welcome/preview.js';
import {
    setupLongPress,
    wasLongPressRecent,
    showProjectContextMenu,
    closeWelcomeContextMenu,
} from './welcome/context-menu.js';
import {
    loadRecentSessions,
    loadProjects,
    loadFavorites,
    loadActiveSessions,
    updateOpenSessionIds,
    mergeLocalSessions,
    toggleFavorite,
    setProjectFilter,
    clearProjectFilter,
    filterSelectedProject,
} from './welcome/api.js';

// Re-export close helpers used by app.js for global Escape handling.
export { closeSessionPreview, closeWelcomeContextMenu };

// ═══════════════════════════════════════════════════════════════════════════
// MAIN WELCOME SCREEN
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Render the full welcome screen.
 */
export function renderWelcomeScreen(container) {
    const { sessions: allSessions, projects, isSearching, taskMode, pendingTask, quickSearchFilter } = state;

    // Apply project filter first (if set)
    let sessions = allSessions;
    const projectFilter = state.projectFilter;
    if (projectFilter) {
        sessions = sessions.filter(s => s.project_path === projectFilter.path);
    }

    // Then apply quick search filter
    if (quickSearchFilter) {
        const q = quickSearchFilter.toLowerCase();
        sessions = sessions.filter(s => {
            const name = (s.name || '').toLowerCase();
            const summary = (s.summary || '').toLowerCase();
            const project = (s.project || '').toLowerCase();
            const projectPath = (s.project_path || '').toLowerCase();
            return name.includes(q) || summary.includes(q) || project.includes(q) || projectPath.includes(q);
        });
    }

    // Filter projects based on quick search too
    let filteredProjects = projects || [];
    if (quickSearchFilter) {
        const q = quickSearchFilter.toLowerCase();
        filteredProjects = filteredProjects.filter(p =>
            p.name.toLowerCase().includes(q) ||
            p.path.toLowerCase().includes(q)
        );
    }

    // Task mode - showing related sessions for a task
    if (taskMode && pendingTask) {
        container.innerHTML = `
            <div id="welcome" class="welcome-screen welcome-screen--task">
                ${renderTaskMode(state.searchResults?.results || [], pendingTask)}
            </div>
        `;
        attachEventListeners(container);
        return;
    }

    // Default welcome screen - build session families for grouping
    // Build family map from all sessions
    const familyMap = buildSessionFamilies(sessions);
    state.familyMap = familyMap;

    // Get root sessions (families) sorted by last activity of root or newest branch
    const getFamilyActivity = (family) => {
        const rootDate = new Date(family.root?.last_activity || family.root?.created_at || 0);
        const branchDates = family.branches.map(b =>
            new Date(b.session.last_activity || b.session.created_at || 0)
        );
        return Math.max(rootDate, ...branchDates);
    };

    const sortedFamilies = Array.from(familyMap.values())
        .filter(f => f.root) // Only families with a visible root
        .sort((a, b) => getFamilyActivity(b) - getFamilyActivity(a));

    // Split into recent (using recentLimit) and rest
    // When quick search is active, show more results (10 instead of default 3)
    const effectiveLimit = quickSearchFilter ? 10 : recentLimit.value;
    const recentFamilies = sortedFamilies.slice(0, effectiveLimit);
    const remainingFamilies = sortedFamilies.slice(effectiveLimit);
    const hasMoreRecent = sortedFamilies.length > effectiveLimit;

    // Group remaining families by project
    const projectGroups = groupFamiliesByProject(remainingFamilies);

    // Determine if we're filtering
    const hasFilter = !!quickSearchFilter || !!projectFilter;

    // Build selectable items list for keyboard navigation:
    // Projects first, then unvisited workspace siblings, then favorites, then recent sessions
    const topFilteredProjects = filteredProjects
        .slice()
        .sort((a, b) => (b.session_count || 0) - (a.session_count || 0))
        .slice(0, 8);

    // Filter workspace dirs by quick search too (name + path match like projects)
    let filteredWorkspaceDirs = state.workspaceDirs || [];
    if (quickSearchFilter) {
        const q = quickSearchFilter.toLowerCase();
        filteredWorkspaceDirs = filteredWorkspaceDirs.filter(d =>
            d.name.toLowerCase().includes(q) ||
            d.path.toLowerCase().includes(q)
        );
    }
    // Default cap is 8, but bump to 20 on a sparse welcome (≤2 session
    // families) so the empty space below gets used. User-toggled expand
    // still wins and shows everything.
    const unvisitedTotal = filteredWorkspaceDirs.length;
    const defaultUnvisitedCap = sortedFamilies.length <= 2 ? 20 : 8;
    const topWorkspaceDirs = state.unvisitedExpanded
        ? filteredWorkspaceDirs
        : filteredWorkspaceDirs.slice(0, defaultUnvisitedCap);

    // Compute filtered favorites (same logic as renderFavoritesSection)
    let navFavorites = state.favorites.filter(f => f.session !== null);
    if (projectFilter) {
        navFavorites = navFavorites.filter(f => {
            const s = f.session || {};
            return s.project_path === projectFilter.path;
        });
    }
    if (quickSearchFilter) {
        const q = quickSearchFilter.toLowerCase();
        navFavorites = navFavorites.filter(f => {
            const s = f.session || {};
            const name = (s.name || '').toLowerCase();
            const summary = (s.summary || '').toLowerCase();
            const project = (s.project || '').toLowerCase();
            const note = (f.note || '').toLowerCase();
            return name.includes(q) || summary.includes(q) || project.includes(q) || note.includes(q);
        });
    }
    // Must match what renderFavorites() actually shows, so arrow-key nav never
    // targets a collapsed-away row.
    const visibleFavorites = navFavorites.slice(0, favoritesLimit.value);

    state.selectableItems = [
        ...topFilteredProjects.map(p => ({ type: 'project', path: p.path, name: p.name })),
        ...topWorkspaceDirs.map(d => ({ type: 'project', path: d.path, name: d.name })),
        ...visibleFavorites.map(f => ({ type: 'favorite', session: f.session, session_id: f.session_id })),
        ...recentFamilies.map(f => ({ type: 'session', session: f.root }))
    ];

    // Track section boundaries for keyboard navigation. Unvisited workspace
    // dirs share the "project row" with real projects — same chip class, same
    // start-session action — so they live in the projects span for nav math.
    const projectsRowCount = topFilteredProjects.length + topWorkspaceDirs.length;
    state.projectCount = projectsRowCount;
    state.favoritesStartIndex = projectsRowCount;
    state.sessionStartIndex = projectsRowCount + visibleFavorites.length;

    // Section start indices for rendering
    const favoritesStartIndex = state.favoritesStartIndex;
    const sessionStartIndex = state.sessionStartIndex;

    const loadingHtml = isSearching ? `
        <div class="welcome-loading">
            <div class="loading-spinner"></div>
            <span>Searching...</span>
        </div>
    ` : '';

    const bodyHtml = `
            ${renderProjectsQuickStart(topFilteredProjects, 0, topWorkspaceDirs, topFilteredProjects.length, unvisitedTotal, state.unvisitedExpanded)}

            ${renderFavoritesSection(favoritesStartIndex)}

            ${allSessions.length > 0 ? `
                <!-- Recent Session Families -->
                <div class="welcome-section welcome-section--recent">
                    <div class="welcome-section-header">
                        <h3>${projectFilter ? projectFilter.name : (quickSearchFilter ? 'Sessions' : 'Recent')}</h3>
                    </div>
                    ${recentFamilies.length > 0 ? `
                        <div class="welcome-families-grid">
                            ${recentFamilies.map((f, i) => renderSessionFamily(f, expandedFamilies.has(`family-${f.rootId}`), sessionStartIndex + i)).join('')}
                        </div>
                        ${hasMoreRecent ? `
                            <button class="welcome-load-more" data-action="load-more-recent">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <polyline points="6 9 12 15 18 9"/>
                                </svg>
                                <span>Show ${Math.min(RECENT_INCREMENT, sortedFamilies.length - effectiveLimit)} more</span>
                                <span class="welcome-load-more-hint">${sortedFamilies.length - effectiveLimit} remaining</span>
                            </button>
                        ` : ''}
                    ` : `
                        <div class="welcome-no-results">
                            <p>No sessions match "<strong>${escapeHtml(state.quickSearchFilter || '')}</strong>"</p>
                        </div>
                    `}
                </div>

                <!-- All Sessions Grouped by Project -->
                ${remainingFamilies.length > 0 && !hasMoreRecent ? `
                    <div class="welcome-section welcome-section--all">
                        <div class="welcome-section-header">
                            <h3>By Project</h3>
                        </div>
                        <div class="task-project-groups">
                            ${projectGroups.map((group, i) => renderFamilyProjectGroup(group, expandedGroups.has(`welcome-project-${i}`), i)).join('')}
                        </div>
                    </div>
                ` : ''}
            ` : `
                <div class="welcome-empty">
                    <p>No sessions yet. Type a message to start!</p>
                </div>
            `}
    `;

    // Incremental path: if a live search bar is already on screen, update the
    // body and patch the bar in place instead of rebuilding the whole tree.
    // Rebuilding would destroy the focused <input>, and on iOS/iPadOS a blur
    // dismisses the on-screen keyboard — which then instantly reopens from the
    // refocus. That open/close flicker shifts the layout under the user's
    // finger, so a tap lands on whatever card slid into that spot.
    const liveBar = container.querySelector('.welcome-screen > .welcome-search-bar');
    const liveBody = container.querySelector('.welcome-screen > .welcome-body');
    const liveLoading = container.querySelector('.welcome-screen > .welcome-loading-host');

    if (liveBar && liveBody && liveLoading &&
        patchSearchBar(liveBar, allSessions.length, sessions.length, hasFilter)) {
        liveLoading.innerHTML = loadingHtml;
        liveBody.innerHTML = bodyHtml;
        attachEventListeners(container);
        return;
    }

    container.innerHTML = `
        <div id="welcome" class="welcome-screen">
            <div class="welcome-loading-host">${loadingHtml}</div>
            ${renderSearchBar(allSessions.length, sessions.length, hasFilter)}
            <div class="welcome-body">${bodyHtml}</div>
        </div>
    `;

    attachEventListeners(container);
}

// ═══════════════════════════════════════════════════════════════════════════
// KEYBOARD NAVIGATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Scroll the selected item into view for keyboard navigation.
 */
function scrollSelectedIntoView(container) {
    requestAnimationFrame(() => {
        const selected = container.querySelector('.welcome-project-chip.selected, .favorites-row.selected, .session-family.selected');
        if (selected) {
            selected.scrollIntoView({ block: 'nearest', behavior: 'auto' });
        }
    });
}

/**
 * Handle arrow key navigation on the welcome screen.
 * Returns true if the key was handled (caller should preventDefault).
 */
function handleWelcomeArrowNav(key) {
    const itemCount = state.selectableItems?.length || 0;
    if (itemCount === 0 && key !== 'ArrowUp') return false;

    const favStart = state.favoritesStartIndex || 0;
    const sessionStart = state.sessionStartIndex || 0;
    const currentIdx = state.selectedResultIndex;

    if (key === 'ArrowDown') {
        if (currentIdx < 0) {
            state.selectedResultIndex = itemCount > 0 ? 0 : -1;
        } else if (currentIdx < favStart) {
            state.selectedResultIndex = favStart < sessionStart ? favStart : (sessionStart < itemCount ? sessionStart : currentIdx);
        } else if (currentIdx < sessionStart) {
            state.selectedResultIndex = sessionStart < itemCount ? sessionStart : currentIdx;
        } else {
            state.selectedResultIndex = Math.min(currentIdx + 1, itemCount - 1);
        }
        return true;
    } else if (key === 'ArrowUp') {
        if (currentIdx < 0) {
            return false;
        } else if (currentIdx >= sessionStart) {
            if (currentIdx === sessionStart) {
                if (favStart < sessionStart) {
                    state.selectedResultIndex = favStart;
                } else if (favStart > 0) {
                    state.selectedResultIndex = 0;
                } else {
                    state.selectedResultIndex = -1;
                }
            } else {
                state.selectedResultIndex = currentIdx - 1;
            }
        } else if (currentIdx >= favStart) {
            state.selectedResultIndex = favStart > 0 ? 0 : -1;
        } else {
            state.selectedResultIndex = -1;
        }
        return true;
    } else if (key === 'ArrowLeft' || key === 'ArrowRight') {
        const delta = key === 'ArrowRight' ? 1 : -1;
        if (currentIdx < 0) {
            if (itemCount > 0) {
                state.selectedResultIndex = 0;
            }
        } else if (currentIdx < favStart) {
            const newIdx = currentIdx + delta;
            if (newIdx >= 0 && newIdx < favStart) {
                state.selectedResultIndex = newIdx;
            }
        } else if (currentIdx < sessionStart) {
            const newIdx = currentIdx + delta;
            if (newIdx >= favStart && newIdx < sessionStart) {
                state.selectedResultIndex = newIdx;
            }
        } else {
            const newIdx = currentIdx + delta;
            if (newIdx >= sessionStart && newIdx < itemCount) {
                state.selectedResultIndex = newIdx;
            }
        }
        return true;
    } else if (key === 'Enter') {
        if (currentIdx >= 0 && state.selectableItems?.[currentIdx]) {
            const item = state.selectableItems[currentIdx];
            if (item.type === 'project') {
                window.dispatchEvent(new CustomEvent('welcome:new-session-on-project', {
                    detail: { projectPath: item.path }
                }));
            } else if ((item.type === 'session' || item.type === 'favorite') && item.session) {
                const sessionId = item.session_id || item.session.session_id;
                window.dispatchEvent(new CustomEvent('welcome:open-session', {
                    detail: { sessionId, projectPath: item.session.project_path, fromWelcome: true }
                }));
            }
            return true;
        }
        return false;
    }
    return false;
}

/** One-time document-level arrow key handler for welcome screen navigation. */
let _welcomeArrowHandlerInstalled = false;
function installWelcomeArrowHandler() {
    if (_welcomeArrowHandlerInstalled) return;
    _welcomeArrowHandlerInstalled = true;

    document.addEventListener('keydown', (e) => {
        // Only handle arrow keys and Enter
        if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Enter'].includes(e.key)) return;

        // Skip if already handled (e.g. by the searchInput keydown handler)
        if (e.defaultPrevented) return;

        // Only when welcome screen is visible
        const container = document.getElementById('welcome-container');
        if (!container) return;

        // Skip if search input is focused (it has its own handler)
        if (document.activeElement?.classList.contains('welcome-search-input')) return;

        // Skip if focused on any input/textarea/editable
        if (document.activeElement?.matches('input, textarea, [contenteditable="true"]')) return;

        // Skip if overlay/modal is open
        if (document.querySelector('#modal-overlay.visible, .quick-actions-overlay.visible')) return;

        // Alt+Enter: filter by selected item's project
        if (e.key === 'Enter' && e.altKey) {
            e.preventDefault();
            filterSelectedProject(container);
            return;
        }

        if (handleWelcomeArrowNav(e.key)) {
            e.preventDefault();
            renderWelcomeScreen(container);
            scrollSelectedIntoView(container);
        }
    });
}

// ═══════════════════════════════════════════════════════════════════════════
// EVENT HANDLERS
// ═══════════════════════════════════════════════════════════════════════════

// The live "load more" IntersectionObserver — one at a time, replaced on each
// render (see attachEventListeners).
let welcomeLoadMoreObserver = null;

/**
 * Open the session-list limit popup anchored to the limit selector.
 */
function openLimitSelector(e, container) {
    e.stopPropagation();
    const btn = e.target.closest('[data-action="toggle-limit-selector"]');
    if (!btn) return;

    // Close if already open
    const existing = container.querySelector('.limit-popup');
    if (existing) { existing.remove(); return; }

    const presets = [50, 100, 200, 500];
    const current = CONFIG.SESSION_LIST_LIMIT;
    const popup = document.createElement('div');
    popup.className = 'limit-popup';
    popup.innerHTML = presets.map(n =>
        `<button class="limit-option ${n === current ? 'active' : ''}" data-limit="${n}">${n}</button>`
    ).join('');
    btn.appendChild(popup);

    popup.addEventListener('click', async (ev) => {
        const opt = ev.target.closest('[data-limit]');
        if (!opt) return;
        ev.stopPropagation();
        const newLimit = parseInt(opt.dataset.limit, 10);
        const cfg = loadUserConfig();
        cfg.sessionListLimit = newLimit;
        saveUserConfig(cfg);
        popup.remove();
        // Reload sessions with new limit
        await loadRecentSessions();
        renderWelcomeScreen(container);
    });

    // Close on outside click
    const closePopup = (ev) => {
        if (!popup.contains(ev.target)) {
            popup.remove();
            document.removeEventListener('click', closePopup, true);
        }
    };
    setTimeout(() => document.addEventListener('click', closePopup, true), 0);
}

function attachEventListeners(container) {
    // Note: Click-to-blur for type-anywhere is handled in app.js messagesContainer handler
    // (more reliable since it's attached to stable element, not recreated welcome DOM)

    // Helper to find session data by ID (including branches inside families)
    const findSession = (sessionId) => {
        // Check direct sessions first
        const allSessions = [
            ...state.sessions,
            ...(state.searchResults?.results || [])
        ];
        const direct = allSessions.find(s => s.session_id === sessionId);
        if (direct) return direct;

        // Check inside family branches
        if (state.familyMap) {
            for (const family of state.familyMap.values()) {
                // Check root
                if (family.root?.session_id === sessionId) {
                    return family.root;
                }
                // Check branches
                const branch = family.branches?.find(b => b.session?.session_id === sessionId);
                if (branch) {
                    return branch.session;
                }
            }
        }

        return null;
    };

    // Session card clicks - show preview (not open directly)
    container.querySelectorAll('.welcome-session-card').forEach(card => {
        const sessionId = card.dataset.sessionId;
        const session = findSession(sessionId);

        // Setup long press / right-click context menu
        if (session) {
            setupLongPress(card, session, container);
        }

        card.addEventListener('click', (e) => {
            // Don't trigger if clicking a button
            if (e.target.closest('button')) return;
            // Don't trigger if context menu is open (belt-and-suspenders)
            if (state.contextMenuSession) return;
            // Use wasLongPressRecent() for more robust detection across event cycles
            if (longPress.triggered || wasLongPressRecent()) {
                e.stopPropagation();
                // Delay reset to catch any other stray click events
                setTimeout(() => { longPress.triggered = false; }, 100);
                return;
            }

            // Show preview instead of opening directly
            if (session) {
                showPreview(session, container);
            }
        });

        // Button actions within card
        card.querySelectorAll('button[data-action]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const action = btn.dataset.action;
                const projectPath = card.dataset.projectPath;

                if (action === 'continue') {
                    // Open directly
                    window.dispatchEvent(new CustomEvent('welcome:open-session', {
                        detail: { sessionId, projectPath }
                    }));
                } else if (action === 'details') {
                    // Show preview
                    if (session) {
                        showPreview(session, container);
                    }
                }
            });
        });
    });

    // Recent session card clicks - open directly (compact view)
    container.querySelectorAll('.welcome-recent-card').forEach(card => {
        const sessionId = card.dataset.sessionId;
        const session = findSession(sessionId);

        // Setup long press / right-click context menu
        if (session) {
            setupLongPress(card, session, container);
        }

        // Preview button click
        const previewBtn = card.querySelector('[data-action="preview-recent"]');
        if (previewBtn && session) {
            previewBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                showPreview(session, container);
            });
        }

        // Favorite star toggle
        const starBtn = card.querySelector('[data-action="toggle-favorite"]');
        if (starBtn && session) {
            starBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                toggleFavorite(sessionId, container);
            });
        }

        card.addEventListener('click', (e) => {
            // Don't trigger if clicking preview button or star
            if (e.target.closest('[data-action="preview-recent"]')) return;
            if (e.target.closest('[data-action="toggle-favorite"]')) return;
            // Don't trigger if context menu is open
            if (state.contextMenuSession) return;
            // Don't trigger if long press was triggered
            if (longPress.triggered || wasLongPressRecent()) {
                e.stopPropagation();
                setTimeout(() => { longPress.triggered = false; }, 100);
                return;
            }

            const projectPath = card.dataset.projectPath;

            // Cmd+click (Mac) or Ctrl+click (Win/Linux) opens in background tab
            if (e.metaKey || e.ctrlKey) {
                window.dispatchEvent(new CustomEvent('welcome:open-session-new-tab', {
                    detail: { sessionId, projectPath, background: true }
                }));
                return;
            }

            // Save welcome state before opening (for "back to sessions" feature)
            saveWelcomeState(container);

            // Open session directly (compact cards are for quick access)
            window.dispatchEvent(new CustomEvent('welcome:open-session', {
                detail: { sessionId, projectPath, fromWelcome: true }
            }));
        });
    });

    // Welcome session row clicks - show preview
    container.querySelectorAll('.welcome-session-row').forEach(row => {
        const sessionId = row.dataset.sessionId;
        const session = findSession(sessionId);

        // Setup long press / right-click context menu
        if (session) {
            setupLongPress(row, session, container);
        }

        row.addEventListener('click', (e) => {
            // Don't trigger if context menu is open
            if (state.contextMenuSession) return;
            // Don't trigger if long press was triggered
            if (longPress.triggered || wasLongPressRecent()) {
                e.stopPropagation();
                setTimeout(() => { longPress.triggered = false; }, 100);
                return;
            }

            // Show preview
            if (session) {
                showPreview(session, container);
            }
        });
    });

    // Session family toggle (expand/collapse branches)
    container.querySelectorAll('[data-action="toggle-family"]').forEach(el => {
        el.addEventListener('click', (e) => {
            e.stopPropagation();
            const familyId = el.dataset.family;
            if (familyId) {
                if (expandedFamilies.has(familyId)) {
                    expandedFamilies.delete(familyId);
                    // Also reset full expansion when collapsing
                    fullyExpandedFamilies.delete(familyId);
                } else {
                    expandedFamilies.add(familyId);
                }
                renderWelcomeScreen(container);
            }
        });
    });

    // Show all forks in a family
    container.querySelectorAll('[data-action="show-all-forks"]').forEach(el => {
        el.addEventListener('click', (e) => {
            e.stopPropagation();
            const familyId = el.dataset.family;
            if (familyId) {
                fullyExpandedFamilies.add(familyId);
                renderWelcomeScreen(container);
            }
        });
    });

    // Session family root clicks - open session
    container.querySelectorAll('.session-family-root').forEach(card => {
        const sessionId = card.dataset.sessionId;
        const session = findSession(sessionId);

        // Setup long press / right-click context menu
        if (session) {
            setupLongPress(card, session, container);
        }

        // Preview button
        const previewBtn = card.querySelector('[data-action="preview-family-root"]');
        if (previewBtn && session) {
            previewBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                showPreview(session, container);
            });
        }

        // Favorite star toggle
        const starBtn = card.querySelector('[data-action="toggle-favorite"]');
        if (starBtn && session) {
            starBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                toggleFavorite(sessionId, container);
            });
        }

        // New session on project button
        const newSessionBtn = card.querySelector('[data-action="new-session-on-project"]');
        if (newSessionBtn && session) {
            newSessionBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                const projectPath = newSessionBtn.dataset.projectPath;
                window.dispatchEvent(new CustomEvent('welcome:new-session-on-project', {
                    detail: { projectPath }
                }));
            });
        }

        // Filter by project click
        const filterProjectEl = card.querySelector('[data-action="filter-project"]');
        if (filterProjectEl) {
            // Click to filter
            filterProjectEl.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                // Don't filter if we just showed context menu via long press
                if (wasLongPressRecent()) return;
                const projectPath = filterProjectEl.dataset.projectPath;
                const projectName = filterProjectEl.dataset.projectName;
                setProjectFilter(projectPath, projectName, container);
            });

            // Right-click for context menu (desktop)
            filterProjectEl.addEventListener('contextmenu', (e) => {
                e.stopPropagation();
                e.preventDefault();
                const projectPath = filterProjectEl.dataset.projectPath;
                const projectName = filterProjectEl.dataset.projectName;
                showProjectContextMenu(projectPath, projectName, e.clientX, e.clientY, container);
            });

            // Long-press for context menu (touch devices)
            let projectLongPressTimer = null;
            filterProjectEl.addEventListener('touchstart', (e) => {
                const projectPath = filterProjectEl.dataset.projectPath;
                const projectName = filterProjectEl.dataset.projectName;
                const touch = e.touches[0];
                projectLongPressTimer = setTimeout(() => {
                    e.preventDefault();
                    longPress.triggered = true;
                    longPress.timestamp = Date.now();
                    showProjectContextMenu(projectPath, projectName, touch.clientX, touch.clientY, container);
                }, 400);
            }, { passive: false });

            filterProjectEl.addEventListener('touchend', () => {
                if (projectLongPressTimer) {
                    clearTimeout(projectLongPressTimer);
                    projectLongPressTimer = null;
                }
            });

            filterProjectEl.addEventListener('touchmove', () => {
                if (projectLongPressTimer) {
                    clearTimeout(projectLongPressTimer);
                    projectLongPressTimer = null;
                }
            });
        }

        card.addEventListener('click', (e) => {
            // Don't trigger on buttons
            if (e.target.closest('button')) return;
            if (e.target.closest('[data-action]')) return;
            if (state.contextMenuSession) return;
            if (longPress.triggered || wasLongPressRecent()) {
                e.stopPropagation();
                setTimeout(() => { longPress.triggered = false; }, 100);
                return;
            }

            const projectPath = card.dataset.projectPath;

            // Alt+click: filter by this session's project
            if (e.altKey && projectPath) {
                const s = findSession(sessionId);
                setProjectFilter(projectPath, s?.project || projectPath.split('/').pop(), container);
                return;
            }

            // Cmd+click (Mac) or Ctrl+click (Win/Linux) opens in background tab
            if (e.metaKey || e.ctrlKey) {
                window.dispatchEvent(new CustomEvent('welcome:open-session-new-tab', {
                    detail: { sessionId, projectPath, background: true }
                }));
                return;
            }

            // Save state and open session
            saveWelcomeState(container);
            window.dispatchEvent(new CustomEvent('welcome:open-session', {
                detail: { sessionId, projectPath, fromWelcome: true }
            }));
        });
    });

    // Fork row clicks - open the fork session
    container.querySelectorAll('.family-fork-row').forEach(row => {
        const sessionId = row.dataset.sessionId;
        const session = findSession(sessionId);

        // Setup long press for forks too
        if (session) {
            setupLongPress(row, session, container);
        }

        // Preview button on fork
        const previewBtn = row.querySelector('[data-action="preview-fork"]');
        if (previewBtn && session) {
            previewBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                showPreview(session, container);
            });
        }

        row.addEventListener('click', (e) => {
            if (e.target.closest('button')) return;
            if (state.contextMenuSession) return;
            if (longPress.triggered || wasLongPressRecent()) {
                e.stopPropagation();
                setTimeout(() => { longPress.triggered = false; }, 100);
                return;
            }

            const projectPath = row.dataset.projectPath;

            // Alt+click: filter by this session's project
            if (e.altKey && projectPath) {
                const s = findSession(sessionId);
                setProjectFilter(projectPath, s?.project || projectPath.split('/').pop(), container);
                return;
            }

            // Cmd+click (Mac) or Ctrl+click (Win/Linux) opens in background tab
            if (e.metaKey || e.ctrlKey) {
                window.dispatchEvent(new CustomEvent('welcome:open-session-new-tab', {
                    detail: { sessionId, projectPath, background: true }
                }));
                return;
            }

            // Save state and open branch session
            saveWelcomeState(container);
            window.dispatchEvent(new CustomEvent('welcome:open-session', {
                detail: { sessionId, projectPath, fromWelcome: true }
            }));
        });
    });

    // Compact family clicks (in project groups) - open root session
    container.querySelectorAll('.compact-family').forEach(card => {
        const sessionId = card.dataset.sessionId;
        const session = findSession(sessionId);

        if (session) {
            setupLongPress(card, session, container);
        }

        card.addEventListener('click', (e) => {
            if (state.contextMenuSession) return;
            if (longPress.triggered || wasLongPressRecent()) {
                e.stopPropagation();
                setTimeout(() => { longPress.triggered = false; }, 100);
                return;
            }

            const projectPath = card.dataset.projectPath;

            // Alt+click: filter by this session's project
            if (e.altKey && projectPath) {
                const s = findSession(sessionId);
                setProjectFilter(projectPath, s?.project || projectPath.split('/').pop(), container);
                return;
            }

            // Cmd+click (Mac) or Ctrl+click (Win/Linux) opens in background tab
            if (e.metaKey || e.ctrlKey) {
                window.dispatchEvent(new CustomEvent('welcome:open-session-new-tab', {
                    detail: { sessionId, projectPath, background: true }
                }));
                return;
            }

            // Save state and open session
            saveWelcomeState(container);
            window.dispatchEvent(new CustomEvent('welcome:open-session', {
                detail: { sessionId, projectPath, fromWelcome: true }
            }));
        });
    });

    // Favorite row clicks
    container.querySelectorAll('.favorites-row').forEach(card => {
        const sessionId = card.dataset.sessionId;
        const projectPath = card.dataset.projectPath;

        // Find session in favorites
        const favorite = state.favorites.find(f => f.session_id === sessionId);
        const session = favorite?.session;

        // Setup long press for context menu (if session exists)
        if (session) {
            setupLongPress(card, { ...session, session_id: sessionId, project_path: projectPath }, container);
        }

        // Star toggle (unfavorite)
        const starBtn = card.querySelector('[data-action="toggle-favorite"]');
        if (starBtn) {
            starBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                toggleFavorite(sessionId, container);
            });
        }

        // Click to open (if session still exists)
        card.addEventListener('click', (e) => {
            if (e.target.closest('[data-action="toggle-favorite"]')) return;
            if (state.contextMenuSession) return;
            if (longPress.triggered || wasLongPressRecent()) {
                e.stopPropagation();
                setTimeout(() => { longPress.triggered = false; }, 100);
                return;
            }

            // If session is deleted, can't open
            if (!session) return;

            // Alt+click: filter by this session's project
            if (e.altKey && projectPath) {
                setProjectFilter(projectPath, session.project || projectPath.split('/').pop(), container);
                return;
            }

            // Cmd+click (Mac) or Ctrl+click (Win/Linux) opens in background tab
            if (e.metaKey || e.ctrlKey) {
                window.dispatchEvent(new CustomEvent('welcome:open-session-new-tab', {
                    detail: { sessionId, projectPath, background: true }
                }));
                return;
            }

            // Save state and open
            saveWelcomeState(container);
            window.dispatchEvent(new CustomEvent('welcome:open-session', {
                detail: { sessionId, projectPath, fromWelcome: true }
            }));
        });
    });

    // "Show all favorites" button — expand the limit to show every favorite,
    // mirroring the "Load more recent" pattern.
    container.querySelector('[data-action="show-all-favorites"]')?.addEventListener('click', () => {
        debug.log('[Welcome] Show all favorites requested');
        favoritesLimit.value = Infinity;
        renderWelcomeScreen(container);
    });

    // "Load more recent" button - click handler
    const loadMoreBtn = container.querySelector('[data-action="load-more-recent"]');
    loadMoreBtn?.addEventListener('click', () => {
        recentLimit.value += RECENT_INCREMENT;
        renderWelcomeScreen(container);
    });

    // Auto-load more when scrolling to bottom (IntersectionObserver)
    if (loadMoreBtn) {
        // Drop the previous render's observer first — its target node is gone,
        // so it can never fire and disconnect itself. Without this, typing in
        // the search box leaks one live observer per keystroke.
        welcomeLoadMoreObserver?.disconnect();

        // Use #welcome-container itself as the scroll root (per-tab scroll architecture)
        const scrollContainer = container.closest('#welcome-container') || container;
        const observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    observer.disconnect(); // Prevent multiple triggers
                    // Save scroll position before re-render
                    const scrollTop = scrollContainer.scrollTop;
                    recentLimit.value += RECENT_INCREMENT;
                    renderWelcomeScreen(container);
                    // Restore scroll position after re-render
                    requestAnimationFrame(() => {
                        scrollContainer.scrollTop = scrollTop;
                    });
                }
            });
        }, {
            root: scrollContainer,
            rootMargin: '100px' // Trigger 100px before button is visible
        });
        observer.observe(loadMoreBtn);
        welcomeLoadMoreObserver = observer;
    }

    // Unified search bar - filter as you type.
    // The bar (and its <input>) survives re-renders, so bind exactly once —
    // re-binding on every render would stack duplicate handlers on the same node.
    const searchBar = container.querySelector('.welcome-search-bar');
    const searchInput = container.querySelector('[data-action="welcome-search-input"]');
    if (searchInput && searchBar && !searchBar.dataset.ppBound) {
        searchBar.dataset.ppBound = '1';

        searchInput.addEventListener('input', (e) => {
            state.quickSearchFilter = e.target.value;
            state.quickSearchActive = !!e.target.value; // Mark as active if has value
            state.selectedResultIndex = -1; // Reset selection when typing
            // No refocus/caret-restore needed: renderWelcomeScreen patches the bar
            // in place and never touches this input, so focus, caret and the
            // on-screen keyboard all stay exactly where they are.
            renderWelcomeScreen(container);
        });

        // Handle Escape, Arrow keys for navigation, Enter to open
        searchInput.addEventListener('keydown', async (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                if (state.selectedResultIndex >= 0) {
                    state.selectedResultIndex = -1;
                    renderWelcomeScreen(container);
                } else {
                    state.quickSearchActive = false;
                    state.quickSearchFilter = '';
                    renderWelcomeScreen(container);
                }
            } else if (e.key === 'Backspace' && state.projectFilter && !searchInput.value) {
                e.preventDefault();
                clearProjectFilter(container);
            } else if (['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
                if (handleWelcomeArrowNav(e.key)) {
                    e.preventDefault();
                    renderWelcomeScreen(container);
                    scrollSelectedIntoView(container);
                }
            } else if (e.key === 'Enter' && e.altKey) {
                e.preventDefault();
                filterSelectedProject(container);
            } else if (e.key === 'Enter') {
                e.preventDefault();
                handleWelcomeArrowNav('Enter');
            }
        });

        // Buttons inside the bar are delegated: patchSearchBar adds/removes the
        // clear button and the project-filter chip, so they have no stable node
        // to bind to.
        searchBar.addEventListener('click', (e) => {
            const action = e.target.closest('[data-action]')?.dataset.action;

            // Clear search button (clears both text and project filter)
            if (action === 'clear-welcome-search') {
                e.stopPropagation();
                state.quickSearchActive = false;
                state.quickSearchFilter = '';
                state.projectFilter = null;
                renderWelcomeScreen(container);
                container.querySelector('.welcome-search-input')?.focus();

            // Remove project filter chip (keeps text search)
            } else if (action === 'remove-project-filter') {
                e.stopPropagation();
                state.projectFilter = null;
                renderWelcomeScreen(container);
                container.querySelector('.welcome-search-input')?.focus();

            // New session button in search bar
            } else if (action === 'new-session-picker') {
                e.stopPropagation();
                state.showProjectPicker = true;
                renderWelcomeScreen(container);

            // Session list limit quick-selector
            } else if (action === 'toggle-limit-selector') {
                openLimitSelector(e, container);
            }
        });
    }

    // Quick-start project chips - start new session on project
    container.querySelector('[data-action="toggle-unvisited"]')?.addEventListener('click', (e) => {
        e.stopPropagation();
        state.unvisitedExpanded = !state.unvisitedExpanded;
        renderWelcomeScreen(container);
    });

    container.querySelectorAll('[data-action="quick-start-project"]').forEach(chip => {
        chip.addEventListener('click', (e) => {
            e.stopPropagation();
            // Don't start session if we just showed context menu via long press
            if (wasLongPressRecent()) return;
            const projectPath = chip.dataset.projectPath;
            const projectName = chip.dataset.projectName;

            // Alt+click: filter by this project
            if (e.altKey && projectPath) {
                setProjectFilter(projectPath, projectName || projectPath.split('/').pop(), container);
                return;
            }

            if (projectPath) {
                window.dispatchEvent(new CustomEvent('welcome:new-session-on-project', {
                    detail: { projectPath }
                }));
            }
        });

        // Right-click for context menu (desktop)
        chip.addEventListener('contextmenu', (e) => {
            e.stopPropagation();
            e.preventDefault();
            const projectPath = chip.dataset.projectPath;
            const projectName = chip.dataset.projectName;
            showProjectContextMenu(projectPath, projectName, e.clientX, e.clientY, container);
        });

        // Long-press for context menu (touch devices)
        let chipLongPressTimer = null;
        chip.addEventListener('touchstart', (e) => {
            const projectPath = chip.dataset.projectPath;
            const projectName = chip.dataset.projectName;
            const touch = e.touches[0];
            chipLongPressTimer = setTimeout(() => {
                e.preventDefault();
                longPress.triggered = true;
                longPress.timestamp = Date.now();
                showProjectContextMenu(projectPath, projectName, touch.clientX, touch.clientY, container);
            }, 400);
        }, { passive: false });

        chip.addEventListener('touchend', () => {
            if (chipLongPressTimer) {
                clearTimeout(chipLongPressTimer);
                chipLongPressTimer = null;
            }
        });

        chip.addEventListener('touchmove', () => {
            if (chipLongPressTimer) {
                clearTimeout(chipLongPressTimer);
                chipLongPressTimer = null;
            }
        });
    });

    // Toggle welcome project groups
    container.querySelectorAll('[data-action="toggle-welcome-group"]').forEach(el => {
        el.addEventListener('click', (e) => {
            e.stopPropagation();
            const groupId = el.dataset.group;
            if (groupId) {
                if (expandedGroups.has(groupId)) {
                    expandedGroups.delete(groupId);
                } else {
                    expandedGroups.add(groupId);
                }
                renderWelcomeScreen(container);
            }
        });
    });

    // New session in project button (in project group headers)
    container.querySelectorAll('[data-action="new-session-in-project"]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            const projectPath = btn.dataset.projectPath;
            if (projectPath) {
                window.dispatchEvent(new CustomEvent('welcome:start-project', {
                    detail: { path: projectPath }
                }));
            } else {
                // No path - just create a new session
                window.dispatchEvent(new CustomEvent('welcome:new-session'));
            }
        });
    });

    // Project picker - stop propagation and check for recent long press
    const projectToggle = container.querySelector('[data-action="toggle-projects"]');
    if (projectToggle) {
        projectToggle.addEventListener('click', (e) => {
            e.stopPropagation();
            // Ignore if long press was recently triggered (prevents accidental toggle)
            if (wasLongPressRecent()) return;
            state.showProjectPicker = !state.showProjectPicker;
            renderWelcomeScreen(container);
        });
    }

    container.querySelectorAll('.welcome-project-item[data-path]').forEach(item => {
        item.addEventListener('click', (e) => {
            e.stopPropagation();
            if (wasLongPressRecent()) return;
            const path = item.dataset.path;

            // Alt+click: filter by this project
            if (e.altKey && path) {
                const name = item.querySelector('.project-name')?.textContent || path.split('/').pop();
                setProjectFilter(path, name, container);
                return;
            }

            window.dispatchEvent(new CustomEvent('welcome:start-project', {
                detail: { path }
            }));
        });
    });

    container.querySelector('[data-action="browse-project"]')?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (wasLongPressRecent()) return;
        window.dispatchEvent(new CustomEvent('welcome:browse-project'));
    });

    // Start new session (from search results or no-results view)
    container.querySelectorAll('[data-action="start-new-session"]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            window.dispatchEvent(new CustomEvent('welcome:new-session'));
        });
    });


    // Start task from search
    container.querySelector('[data-action="start-task"]')?.addEventListener('click', () => {
        // Use first result's project or selected project
        const firstResult = state.searchResults?.results?.[0];
        if (firstResult?.project_path) {
            window.dispatchEvent(new CustomEvent('welcome:start-project', {
                detail: { path: firstResult.project_path, query: state.searchQuery }
            }));
        }
    });

    // ═══════════════════════════════════════════════════════════════════
    // TASK MODE HANDLERS
    // ═══════════════════════════════════════════════════════════════════

    // Helper to get session data from either card or row
    const getSessionElement = (btn) => {
        return btn.closest('.welcome-session-card') || btn.closest('.task-session-row');
    };

    // "Continue here" button in task mode - resume existing session with pending task
    container.querySelectorAll('[data-action="continue-with-task"]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const el = getSessionElement(btn);
            const sessionId = el?.dataset.sessionId;
            const projectPath = el?.dataset.projectPath;
            const task = state.pendingTask;

            if (sessionId && task) {
                window.dispatchEvent(new CustomEvent('welcome:continue-with-task', {
                    detail: { sessionId, projectPath, task }
                }));
                // Reset state
                state.taskMode = false;
                state.pendingTask = null;
                state.searchResults = null;
                expandedGroups.clear();
            }
        });
    });

    // "Fork" button in task mode - create a fork of session and send task there
    container.querySelectorAll('[data-action="fork-with-task"]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const el = getSessionElement(btn);
            const sessionId = el?.dataset.sessionId;
            const projectPath = el?.dataset.projectPath;
            const task = state.pendingTask;

            if (sessionId && task) {
                window.dispatchEvent(new CustomEvent('welcome:fork-with-task', {
                    detail: { sessionId, projectPath, task }
                }));
                // Reset state
                state.taskMode = false;
                state.pendingTask = null;
                state.searchResults = null;
                expandedGroups.clear();
            }
        });
    });

    // Toggle project group expand/collapse
    container.querySelectorAll('[data-action="toggle-group"]').forEach(el => {
        el.addEventListener('click', (e) => {
            e.stopPropagation();
            const groupId = el.dataset.group;
            if (groupId) {
                if (expandedGroups.has(groupId)) {
                    expandedGroups.delete(groupId);
                } else {
                    expandedGroups.add(groupId);
                }
                renderWelcomeScreen(container);
            }
        });
    });

    // "Start Fresh" button - create new session with pending task
    container.querySelector('[data-action="start-fresh"]')?.addEventListener('click', () => {
        const task = state.pendingTask;
        if (task) {
            window.dispatchEvent(new CustomEvent('welcome:start-fresh-task', {
                detail: { task }
            }));
            // Reset state
            state.taskMode = false;
            state.pendingTask = null;
            state.searchResults = null;
            expandedGroups.clear();
        }
    });

    // "Cancel" button - go back to welcome screen
    container.querySelector('[data-action="cancel-task"]')?.addEventListener('click', () => {
        state.taskMode = false;
        state.pendingTask = null;
        state.searchResults = null;
        expandedGroups.clear();
        renderWelcomeScreen(container);
        window.dispatchEvent(new CustomEvent('welcome:clear-input'));
    });
}

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC API — INIT + SEARCH + REFRESH
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Initialize the welcome screen.
 *
 * @param {HTMLElement} container - Container element to render into
 * @param {string} sessionId - Session/tab identifier (used to track state per-session)
 */
export async function initWelcomeScreen(container, sessionId = null) {
    // Install document-level arrow key handler (once)
    installWelcomeArrowHandler();

    // Check if this is a different session/tab than before
    // If so, we must reset state to avoid leaking search results between tabs
    const isSameSession = sessionId && state.forSessionId === sessionId;
    const hasSearchState = state.taskMode;

    // Only preserve state if:
    // 1. It's the SAME session (switching back to a tab with search results)
    // 2. AND we actually have search state to preserve
    const preserveSearchState = isSameSession && hasSearchState;

    if (preserveSearchState) {
        // Only reset transient state (preview, context menu)
        state.previewSession = null;
        state.previewMessages = null;
        state.previewLoading = false;
        state.contextMenuSession = null;
        state.contextMenuPos = null;
        state.contextMenuContainer = null;
        debug.log('[Welcome] Preserving search state for session:', sessionId);
    } else {
        // Full reset for new sessions or tabs
        debug.log('[Welcome] Reset state for session:', sessionId, '(was:', state.forSessionId, ')');
        state.forSessionId = sessionId;
        state.searchResults = null;
        state.searchQuery = '';
        state.isSearching = false;
        state.showProjectPicker = false;
        state.taskMode = false;
        state.pendingTask = null;
        state.quickSearchFilter = '';    // Clear search text
        state.quickSearchActive = false; // Reset search active state
        state.previewSession = null;
        state.previewMessages = null;
        state.previewLoading = false;
        state.contextMenuSession = null;
        state.contextMenuPos = null;
        state.contextMenuContainer = null;
        expandedGroups.clear();
        recentLimit.value = 10; // Reset to default
    }

    // Render immediately with current state (may be empty on first load)
    // This prevents a blank flash if the container becomes visible before API calls complete
    renderWelcomeScreen(container);

    // Load data in parallel
    await Promise.all([
        loadRecentSessions(),
        loadProjects(),
        loadFavorites(),
        loadActiveSessions(),
    ]);

    // Enrich with local session status
    updateOpenSessionIds();
    mergeLocalSessions();

    // Re-render with real data
    renderWelcomeScreen(container);

    // Auto-focus search input on desktop (devices with physical keyboard)
    // This ensures typing immediately goes to search bar
    if (!/iPhone/.test(navigator.userAgent)) {
        requestAnimationFrame(() => {
            const searchInput = container.querySelector('.welcome-search-input');
            if (!searchInput) return;
            // Only claim focus when nothing else owns it — this async load can
            // land after the user opened a widget (e.g. Search in Files) or
            // started typing elsewhere; yanking focus from them is hostile.
            const ae = document.activeElement;
            if (!ae || ae === document.body || container.contains(ae)) {
                searchInput.focus();
                debug.log('[Welcome] Auto-focused search input');
            }
        });
    }
}

/**
 * Handle task message - search for related sessions and show options.
 *
 * Instead of immediately creating a new session, this:
 * 1. Searches for related existing sessions
 * 2. Shows them with "Continue here" or "Start Fresh" options
 * 3. User chooses to resume an existing session or start new
 *
 * @param {string} task - The task/message user wants to send
 * @param {HTMLElement} container - Container to re-render
 */
export async function handleWelcomeTask(task, container) {
    state.isSearching = true;
    state.pendingTask = task;
    renderWelcomeScreen(container);

    try {
        // Search for related sessions based on the task
        // Fetch more to allow grouping by project
        const response = await fetch(`${CONFIG.API_BASE}/api/welcome/search`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: task, limit: 30 }),
        });

        if (!response.ok) throw new Error('Search failed');

        const data = await response.json();
        state.searchResults = data;
    } catch (e) {
        console.error('Task search failed:', e);
        state.searchResults = { results: [] };
    } finally {
        state.isSearching = false;
        state.taskMode = true;
        renderWelcomeScreen(container);
    }
}

/**
 * Check if we're in task mode (showing related sessions for a task).
 */
export function isTaskMode() {
    return state.taskMode;
}

/**
 * Get the pending task.
 */
export function getPendingTask() {
    return state.pendingTask;
}

/**
 * Reset the welcome screen to default state.
 */
export function resetWelcomeScreen(container) {
    state.taskMode = false;
    state.searchResults = null;
    state.searchQuery = '';
    state.pendingTask = null;
    state.showProjectPicker = false;
    state.previewSession = null;
    state.previewMessages = null;
    state.previewLoading = false;
    state.contextMenuSession = null;
    state.contextMenuPos = null;
    state.contextMenuContainer = null;
    state.quickSearchFilter = '';
    state.quickSearchActive = false;
    state.selectedResultIndex = -1;
    expandedGroups.clear();
    renderWelcomeScreen(container);
}


/**
 * Open/focus the search input on welcome screen.
 * @param {string} [initialValue] - Optional initial text to put in search
 * @returns {boolean} - True if opened, false if not on welcome screen
 */
export function openQuickSearch(initialValue = '') {
    const container = document.getElementById('welcome-container');
    if (!container) return false;

    state.quickSearchActive = !!initialValue;
    state.quickSearchFilter = initialValue;
    renderWelcomeScreen(container);

    // Focus the input after re-render
    requestAnimationFrame(() => {
        const input = container.querySelector('.welcome-search-input');
        if (input) {
            input.focus();
            // Put cursor at end
            input.selectionStart = input.selectionEnd = input.value.length;
        }
    });

    return true;
}

/**
 * Check if quick search is active.
 */
export function isQuickSearchActive() {
    return state.quickSearchActive;
}

/**
 * Check if welcome search has content that can be cleared.
 */
export function hasWelcomeSearchContent() {
    return !!(state.quickSearchFilter || state.projectFilter);
}

/**
 * Clear/reset the welcome search.
 * @returns {boolean} True if something was cleared
 */
export function clearWelcomeSearch() {
    if (!hasWelcomeSearchContent()) return false;

    const container = document.getElementById('welcome-container');
    if (!container) return false;

    state.quickSearchActive = false;
    state.quickSearchFilter = '';
    state.projectFilter = null;

    renderWelcomeScreen(container);

    // Re-focus empty input
    requestAnimationFrame(() => {
        container.querySelector('.welcome-search-input')?.focus();
    });

    return true;
}

/**
 * Type a character into the search input.
 * Opens quick search if not already active.
 * @param {string} char - Character to append
 */
export function typeIntoQuickSearch(char) {
    const container = document.getElementById('welcome-container');
    if (!container) {
        console.debug('[TypeIntoQuickSearch] No welcome-container found');
        return;
    }

    console.debug('[TypeIntoQuickSearch] Adding char:', char, 'to filter:', state.quickSearchFilter);

    // Append character to filter
    state.quickSearchActive = true;
    state.quickSearchFilter = (state.quickSearchFilter || '') + char;

    renderWelcomeScreen(container);

    // Focus and set cursor
    requestAnimationFrame(() => {
        const input = container.querySelector('.welcome-search-input');
        if (input) {
            input.focus();
            input.selectionStart = input.selectionEnd = input.value.length;
            console.debug('[TypeIntoQuickSearch] Focused input, value:', input.value);
        } else {
            console.debug('[TypeIntoQuickSearch] No .welcome-search-input found in container');
        }
    });
}

/**
 * Refresh sessions data including status indicators.
 */
export async function refreshSessions(container) {
    await Promise.all([
        loadRecentSessions(),
        loadActiveSessions(),
    ]);
    updateOpenSessionIds();
    mergeLocalSessions();

    renderWelcomeScreen(container);
}

// ═══════════════════════════════════════════════════════════════════════════
// WELCOME STATE PERSISTENCE (for "Back to sessions" feature)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get the saved welcome state (for restoring after "back to sessions").
 */
export function getSavedWelcomeState() {
    return savedWelcomeState.value;
}

/**
 * Clear the saved welcome state.
 */
export function clearSavedWelcomeState() {
    savedWelcomeState.value = null;
}

/**
 * Restore the saved welcome state after returning from a session.
 */
export function restoreWelcomeState(container) {
    if (!savedWelcomeState.value) return false;

    debug.log('[Welcome] Restoring state:', savedWelcomeState.value);

    // Restore state variables
    state.taskMode = savedWelcomeState.value.taskMode || false;
    state.pendingTask = savedWelcomeState.value.pendingTask || null;
    state.searchResults = savedWelcomeState.value.searchResults || null;

    // Restore expanded groups
    expandedGroups.clear();
    if (savedWelcomeState.value.expandedGroups) {
        savedWelcomeState.value.expandedGroups.forEach(g => expandedGroups.add(g));
    }

    // Render
    renderWelcomeScreen(container);

    // Capture values before clearing - rAF callback runs after savedWelcomeState is nulled
    const scrollTop = savedWelcomeState.value.scrollTop;
    const inputValue = savedWelcomeState.value.inputValue;

    // Clear saved state now (before async callbacks)
    savedWelcomeState.value = null;

    // Restore scroll position after render
    requestAnimationFrame(() => {
        const welcomeEl = container.querySelector('.welcome-screen');
        if (welcomeEl && scrollTop) {
            welcomeEl.scrollTop = scrollTop;
        }
    });

    // Restore input value
    const searchInput = document.querySelector('.input-area textarea');
    if (searchInput && inputValue) {
        searchInput.value = inputValue;
    }

    return true;
}

// ═══════════════════════════════════════════════════════════════════════════
// FAVORITES API (exported for use from other modules)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Check if a session is favorited.
 * @param {string} sessionId
 * @returns {boolean}
 */
export function isFavoriteSession(sessionId) {
    return state.favoritesSet.has(sessionId);
}

/**
 * Get all favorited session IDs.
 * @returns {Set<string>}
 */
export function getFavoriteIds() {
    return new Set(state.favoritesSet);
}

/**
 * Toggle favorite status for a session.
 * Can be called from outside welcome.js (e.g., tab context menu).
 * Dispatches 'welcome:favorites-changed' event for UI sync.
 *
 * @param {string} sessionId
 * @param {string} [note] - Optional note (only used when adding)
 * @returns {Promise<boolean>} New favorite status
 */
export async function toggleFavoriteSession(sessionId, note = null) {
    // Validate sessionId
    if (!sessionId) {
        console.error('toggleFavoriteSession: No session ID provided');
        return null;
    }

    const isFav = state.favoritesSet.has(sessionId);
    debug.log(`toggleFavoriteSession: ${sessionId}, currently ${isFav ? 'favorited' : 'not favorited'}`);

    try {
        if (isFav) {
            // Remove from favorites
            const response = await fetch(`${CONFIG.API_BASE}/api/favorites/${sessionId}`, {
                method: 'DELETE',
            });
            if (!response.ok) {
                const err = await response.json().catch(() => ({}));
                throw new Error(extractApiError(err, `Failed to remove favorite (${response.status})`));
            }

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
            if (!response.ok) {
                const err = await response.json().catch(() => ({}));
                throw new Error(extractApiError(err, `Failed to add favorite (${response.status})`));
            }

            state.favoritesSet.add(sessionId);
            // Note: full session data will be fetched on next welcome screen load
        }

        // Dispatch event so welcome screen can refresh if visible
        window.dispatchEvent(new CustomEvent('welcome:favorites-changed', {
            detail: { sessionId, isFavorite: !isFav }
        }));

        return !isFav;
    } catch (e) {
        console.error('Failed to toggle favorite:', e);
        // Return null to indicate error - caller should handle this
        return null;
    }
}

/**
 * Load favorites from server (for initial load or refresh).
 * Updates internal state and returns the favorites list.
 */
export async function loadFavoritesFromServer() {
    try {
        const response = await fetch(`${CONFIG.API_BASE}/api/favorites`);
        if (!response.ok) throw new Error('Failed to load favorites');

        const data = await response.json();
        state.favorites = data.favorites || [];
        state.favoritesSet = new Set(state.favorites.map(f => f.session_id));
        return state.favorites;
    } catch (e) {
        console.error('Failed to load favorites:', e);
        return [];
    }
}

