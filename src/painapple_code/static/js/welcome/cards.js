/**
 * Card-style renderers for the welcome screen.
 *
 * All functions here return HTML strings. Wiring (click handlers, long press,
 * preview, etc.) happens in welcome.js's attachEventListeners — these
 * renderers just produce markup with `data-action="..."` attributes.
 */

import { CONFIG } from '../config.js';
import { escapeHtml, formatRelativeTime } from '../utils.js';
import { projectColorStyle } from '../project-colors.js';
import { state, fullyExpandedFamilies, favoritesLimit } from './state.js';

/**
 * Render a compact session card for the recent sessions section.
 * Click to open, preview button for quick look, long-press for context menu.
 */
export function renderRecentSessionCard(session) {
    const name = session.name || session.project || 'Session';
    const timeAgo = formatRelativeTime(session.last_activity || session.created_at);
    const summary = session.summary || '';
    const firstPrompt = !summary ? (session.first_prompt || '') : '';
    const tags = session.tags || [];
    const files = session.files_changed || [];
    const cost = session.total_cost > 0 ? `$${session.total_cost.toFixed(2)}` : '';
    const turns = session.turn_count || session.message_count || 0;
    const isFav = state.favoritesSet.has(session.session_id);
    const isOpen = state.openSessionIds.has(session.session_id);
    const isRunning = state.runningSessionIds.has(session.session_id);

    // Build status badges
    const statusBadges = [];
    if (isRunning) {
        statusBadges.push('<span class="session-status-badge running" data-tooltip="Claude is running">●</span>');
    } else if (isOpen) {
        statusBadges.push('<span class="session-status-badge open" data-tooltip="Open in tab">○</span>');
    }

    return `
        <div class="welcome-recent-card ${isFav ? 'is-favorite' : ''} ${isOpen ? 'is-open' : ''} ${isRunning ? 'is-running' : ''}"
             data-session-id="${escapeHtml(session.session_id)}"
             data-project-path="${escapeHtml(session.project_path || '')}"${projectColorStyle(session.project_path)}>
            <div class="recent-card-header">
                ${statusBadges.join('')}
                <span class="recent-card-name">${escapeHtml(name)}</span>
                <button class="favorite-star ${isFav ? 'is-favorite' : ''}" data-action="toggle-favorite" data-tooltip="${isFav ? 'Remove from favorites' : 'Add to favorites'}">
                    <svg viewBox="0 0 24 24" fill="${isFav ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2">
                        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
                    </svg>
                </button>
                <button class="recent-card-preview" data-action="preview-recent" data-tooltip="Quick preview">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                        <circle cx="12" cy="12" r="3"/>
                    </svg>
                </button>
                <span class="recent-card-time">${timeAgo}</span>
            </div>
            <div class="recent-card-project">${escapeHtml(session.project || '')}</div>
            ${summary ? `<div class="recent-card-summary">${escapeHtml(summary)}</div>` : ''}
            ${firstPrompt ? `<div class="recent-card-summary first-prompt">${escapeHtml(firstPrompt)}</div>` : ''}
            <div class="recent-card-footer">
                <div class="recent-card-tags">
                    ${tags.slice(0, 4).map(t => `<span class="welcome-tag">${escapeHtml(t)}</span>`).join('')}
                </div>
                <div class="recent-card-meta">
                    ${files.length > 0 ? `<span class="meta-item">📄 ${files.length}</span>` : ''}
                    ${turns > 0 ? `<span class="meta-item">⏱ ${turns}</span>` : ''}
                    ${cost ? `<span class="meta-item meta-cost">${cost}</span>` : ''}
                </div>
            </div>
        </div>
    `;
}

/**
 * Render a session family (root + forks).
 * Shows root session prominently with collapsible fork list.
 */
export function renderSessionFamily(family, isExpanded = false, selectableIndex = -1) {
    if (!family || !family.root) return '';

    const root = family.root;
    const forks = family.branches.filter(b => !b.session.is_comment_thread);
    const discussionCount = family.branches.filter(b => b.session.is_comment_thread).length;

    const name = root.name || root.project || 'Session';
    const timeAgo = formatRelativeTime(root.last_activity || root.created_at);
    const summary = root.summary || '';
    const firstPrompt = !summary ? (root.first_prompt || '') : '';
    const tags = root.tags || [];
    const cost = root.total_cost > 0 ? `$${root.total_cost.toFixed(2)}` : '';
    const isFav = state.favoritesSet.has(root.session_id);
    const isOpen = state.openSessionIds.has(root.session_id);
    const isRunning = state.runningSessionIds.has(root.session_id);

    // Check if any session in family is open/running
    const familyHasOpen = isOpen || forks.some(b => state.openSessionIds.has(b.session.session_id));
    const familyHasRunning = isRunning || forks.some(b => state.runningSessionIds.has(b.session.session_id));

    // Build status badges for root
    const statusBadges = [];
    if (isRunning) {
        statusBadges.push('<span class="session-status-badge running" data-tooltip="Claude is running">●</span>');
    } else if (isOpen) {
        statusBadges.push('<span class="session-status-badge open" data-tooltip="Open in tab">○</span>');
    }

    // Calculate total family cost
    const familyCost = [root, ...forks.map(b => b.session)]
        .reduce((sum, s) => sum + (s.total_cost || 0), 0);

    const turns = root.turn_count || 0;
    const messages = root.message_count || 0;

    const hasForks = forks.length > 0;
    // Use family.rootId (original root) for stable tracking, not root.session_id
    // This ensures expansion state persists even when newest session becomes display root
    const familyId = `family-${family.rootId}`;
    const isSelected = selectableIndex >= 0 && state.selectedResultIndex === selectableIndex;

    return `
        <div class="session-family ${isExpanded ? 'is-expanded' : ''} ${hasForks ? 'has-forks' : ''} ${isSelected ? 'selected' : ''} ${familyHasOpen ? 'has-open' : ''} ${familyHasRunning ? 'has-running' : ''}"
             data-family-id="${familyId}"
             data-root-id="${escapeHtml(root.session_id)}"
             data-selectable-index="${selectableIndex}"${projectColorStyle(root.project_path)}>

            <!-- Root Session Card -->
            <div class="session-family-root ${isOpen ? 'is-open' : ''} ${isRunning ? 'is-running' : ''}"
                 data-session-id="${escapeHtml(root.session_id)}"
                 data-project-path="${escapeHtml(root.project_path || '')}">

                <div class="family-root-main">
                    <div class="family-root-header">
                        ${hasForks ? `
                            <button class="family-expand-toggle" data-action="toggle-family" data-family="${familyId}" data-tooltip="${isExpanded ? 'Collapse' : 'Expand'} forks">
                                <svg class="family-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <polyline points="9 18 15 12 9 6"/>
                                </svg>
                            </button>
                        ` : ''}
                        ${statusBadges.join('')}
                        <span class="family-root-name">${escapeHtml(name)}</span>
                        <button class="favorite-star ${isFav ? 'is-favorite' : ''}" data-action="toggle-favorite" data-tooltip="${isFav ? 'Remove from favorites' : 'Add to favorites'}">
                            <svg viewBox="0 0 24 24" fill="${isFav ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2">
                                <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
                            </svg>
                        </button>
                        <button class="family-preview-btn" data-action="preview-family-root" data-tooltip="Quick preview">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                                <circle cx="12" cy="12" r="3"/>
                            </svg>
                        </button>
                        <button class="family-new-session-btn" data-action="new-session-on-project" data-project-path="${escapeHtml(root.project_path || '')}" data-tooltip="Start new session on this project">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M12 5v14M5 12h14"/>
                            </svg>
                        </button>
                        ${familyCost > 0.01 ? `<span class="family-root-cost">$${familyCost.toFixed(2)}</span>` : ''}
                        <span class="family-root-time">${timeAgo}</span>
                    </div>

                    <div class="family-root-project" data-action="filter-project" data-project-path="${escapeHtml(root.project_path || '')}" data-project-name="${escapeHtml(root.project || '')}" data-tooltip="Click to filter • Right-click for more">${escapeHtml(root.project || '')}</div>
                    ${summary ? `<div class="family-root-summary">${escapeHtml(summary)}</div>` : ''}
                    ${firstPrompt ? `<div class="family-root-summary first-prompt">${escapeHtml(firstPrompt)}</div>` : ''}

                    ${tags.length > 0 || hasForks || discussionCount > 0 || turns > 0 ? `
                    <div class="family-root-footer">
                        <div class="family-root-tags">
                            ${tags.slice(0, 3).map(t => `<span class="welcome-tag">${escapeHtml(t)}</span>`).join('')}
                        </div>
                        <div class="family-root-meta">
                            ${turns > 0 ? `<span class="meta-item meta-turns" data-tooltip="${messages} messages">${turns} turn${turns !== 1 ? 's' : ''}${messages > 0 ? ` · ${messages} msg${messages !== 1 ? 's' : ''}` : ''}</span>` : ''}
                            ${hasForks ? `
                                <span class="meta-item meta-forks" data-action="toggle-family" data-family="${familyId}">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="14" height="14">
                                        <circle cx="12" cy="18" r="3"/>
                                        <circle cx="6" cy="6" r="3"/>
                                        <circle cx="18" cy="6" r="3"/>
                                        <path d="M18 9v1a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V9"/>
                                        <line x1="12" y1="12" x2="12" y2="15"/>
                                    </svg>
                                    ${forks.length} fork${forks.length !== 1 ? 's' : ''}
                                </span>
                            ` : ''}
                            ${discussionCount > 0 ? `<span class="meta-item">💬 ${discussionCount}</span>` : ''}
                        </div>
                    </div>
                    ` : ''}
                </div>
            </div>

            <!-- Forks (collapsed by default) -->
            ${hasForks ? `
                <div class="session-family-forks">
                    ${(() => {
                        const showAll = fullyExpandedFamilies.has(familyId);
                        const visibleForks = showAll ? forks : forks.slice(0, 5);
                        const hasMore = !showAll && forks.length > 5;

                        return visibleForks.map((fork, idx) =>
                            renderForkRow(fork, idx === visibleForks.length - 1 && !hasMore)
                        ).join('') + (hasMore ? `
                            <div class="family-forks-more" data-action="show-all-forks" data-family="${familyId}">
                                <span class="forks-more-text">+ ${forks.length - 5} more forks</span>
                            </div>
                        ` : '');
                    })()}
                </div>
            ` : ''}
        </div>
    `;
}

/**
 * Render a fork row within a session family.
 * Shows depth visually with nested lines (like │ └─ tree structure).
 */
export function renderForkRow(branch, isLast = false) {
    const session = branch.session;
    const depth = branch.depth || 1;

    const name = session.name || 'Fork';
    const timeAgo = formatRelativeTime(session.last_activity || session.created_at);
    const cost = session.total_cost > 0 ? `$${session.total_cost.toFixed(2)}` : '';
    const isDiscussion = session.is_comment_thread;
    const isOpen = state.openSessionIds.has(session.session_id);
    const isRunning = state.runningSessionIds.has(session.session_id);

    // Clean up "Fork of Fork of..." names
    const displayName = name.replace(/^(Fork of )+/i, '');

    // Add discussion indicator
    const prefix = isDiscussion ? '💬 ' : '';

    // Build status badge
    let statusBadge = '';
    if (isRunning) {
        statusBadge = '<span class="session-status-badge running" data-tooltip="Claude is running">●</span>';
    } else if (isOpen) {
        statusBadge = '<span class="session-status-badge open" data-tooltip="Open in tab">○</span>';
    }

    // Generate depth indicator lines: │ for each level, └─ at the end
    // depth 1: └─
    // depth 2: │ └─
    // depth 3: │ │ └─
    const depthLines = [];
    for (let i = 1; i < depth; i++) {
        depthLines.push('<span class="fork-depth-line">│</span>');
    }
    depthLines.push('<span class="fork-depth-corner">└</span>');
    const depthIndicator = depthLines.join('');

    return `
        <div class="family-fork-row ${isLast ? 'is-last' : ''} ${isDiscussion ? 'is-discussion' : ''} ${isOpen ? 'is-open' : ''} ${isRunning ? 'is-running' : ''}"
             data-session-id="${escapeHtml(session.session_id)}"
             data-project-path="${escapeHtml(session.project_path || '')}"
             data-depth="${depth}">
            <div class="fork-depth-indicator">${depthIndicator}</div>
            <div class="fork-content">
                ${statusBadge}<span class="fork-name">${prefix}${escapeHtml(displayName)}</span>
                <span class="fork-time">${timeAgo}</span>
                ${cost ? `<span class="fork-cost">${cost}</span>` : ''}
            </div>
            <div class="fork-actions">
                <button class="fork-action-btn" data-action="preview-fork" data-tooltip="Quick preview">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                        <circle cx="12" cy="12" r="3"/>
                    </svg>
                </button>
            </div>
        </div>
    `;
}

/**
 * Render a favorite row (compact list item).
 */
export function renderFavoriteRow(favorite, selectableIndex = -1) {
    const session = favorite.session;
    if (!session) {
        // Session was deleted
        return `
            <div class="favorites-row is-deleted" data-session-id="${escapeHtml(favorite.session_id)}">
                <span class="favorites-row-star" data-action="toggle-favorite" data-tooltip="Remove">★</span>
                <span class="favorites-row-name">Deleted Session</span>
                <span class="favorites-row-meta">Session no longer exists</span>
            </div>
        `;
    }

    const name = session.name || session.project || 'Session';
    const timeAgo = formatRelativeTime(session.last_activity || favorite.added_at);
    const project = session.project || '';
    const summary = session.summary || '';
    const note = favorite.note ? `"${favorite.note}"` : '';

    // Build description: summary takes priority, then note
    const desc = summary || note;
    const isSelected = selectableIndex >= 0 && state.selectedResultIndex === selectableIndex;

    return `
        <div class="favorites-row ${isSelected ? 'selected' : ''}"
             data-session-id="${escapeHtml(favorite.session_id)}"
             data-project-path="${escapeHtml(session.project_path || '')}"
             data-selectable-index="${selectableIndex}"${projectColorStyle(session.project_path)}>
            <span class="favorites-row-star" data-action="toggle-favorite" data-tooltip="Remove from favorites">★</span>
            <div class="favorites-row-content">
                <span class="favorites-row-name">${escapeHtml(name)}</span>
                ${desc ? `<span class="favorites-row-desc">${escapeHtml(desc)}</span>` : ''}
            </div>
            <span class="favorites-row-project">${escapeHtml(project)}</span>
            <span class="favorites-row-time">${timeAgo}</span>
        </div>
    `;
}

/**
 * Render the prominent search bar at top of welcome screen.
 * Type to filter sessions client-side.
 */
export function renderSearchBar(sessionCount, filteredCount, hasFilter) {
    const searchValue = state.quickSearchFilter || '';
    const showingFiltered = hasFilter && filteredCount !== sessionCount;
    const projectFilter = state.projectFilter;

    return `
        <div class="welcome-search-bar">
            <div class="welcome-search-input-wrapper">
                <svg class="welcome-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="11" cy="11" r="8"/>
                    <path d="M21 21l-4.35-4.35"/>
                </svg>
                ${projectFilter ? filterChipHtml(projectFilter) : ''}
                <input type="text"
                       class="welcome-search-input ${projectFilter ? 'has-filter' : ''}"
                       placeholder="${projectFilter ? 'Search in project...' : 'Search sessions...'}"
                       value="${escapeHtml(searchValue)}"
                       data-action="welcome-search-input"
                       autocomplete="off"
                       autocorrect="off"
                       autocapitalize="off"
                       spellcheck="false">
                ${searchValue || projectFilter ? clearButtonHtml() : ''}
                <button class="welcome-search-new" data-action="new-session-picker" data-tooltip="New session">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20">
                        <line x1="12" y1="5" x2="12" y2="19"/>
                        <line x1="5" y1="12" x2="19" y2="12"/>
                    </svg>
                </button>
            </div>
            ${showingFiltered ? `
                <div class="welcome-search-status">${filteredCount} of ${sessionCount}</div>
            ` : ''}
            <div class="welcome-limit-selector" data-action="toggle-limit-selector">
                showing ${sessionCount} <span class="welcome-limit-value">(limit: ${CONFIG.SESSION_LIST_LIMIT})</span>
            </div>
        </div>
    `;
}

function filterChipHtml(projectFilter) {
    return `
        <span class="search-filter-chip" data-action="remove-project-filter" data-tooltip="Remove filter">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12">
                <path d="M3 3h7l4 4v10a2 2 0 01-2 2H5a2 2 0 01-2-2V3z"/>
                <path d="M14 3v4h4"/>
            </svg>
            ${escapeHtml(projectFilter.name)}
            <svg class="chip-remove" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="12" height="12">
                <line x1="18" y1="6" x2="6" y2="18"/>
                <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
        </span>
    `;
}

function clearButtonHtml() {
    return `
        <button class="welcome-search-clear" data-action="clear-welcome-search" data-tooltip="Clear all (Esc)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="16" height="16">
                <line x1="18" y1="6" x2="6" y2="18"/>
                <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
        </button>
    `;
}

/**
 * Update a LIVE search bar in place, without ever replacing the <input> node.
 *
 * Re-creating the input (via innerHTML) blurs it, which on iOS/iPadOS
 * dismisses and re-opens the on-screen keyboard on every keystroke — the
 * layout jump that makes taps land on the wrong card. Patching keeps the
 * focused input alive so the keyboard never moves.
 *
 * @returns {boolean} true if the bar was patched, false if it needs a full render
 */
export function patchSearchBar(bar, sessionCount, filteredCount, hasFilter) {
    const wrapper = bar?.querySelector('.welcome-search-input-wrapper');
    const input = wrapper?.querySelector('.welcome-search-input');
    if (!wrapper || !input) return false;

    const searchValue = state.quickSearchFilter || '';
    const projectFilter = state.projectFilter;
    const showingFiltered = hasFilter && filteredCount !== sessionCount;

    // Input: never replaced. Only sync value when state changed it externally
    // (clear button, Escape, typeIntoQuickSearch) — never while the user types,
    // where the DOM value is already the source of truth.
    if (input.value !== searchValue) input.value = searchValue;
    input.classList.toggle('has-filter', !!projectFilter);
    const placeholder = projectFilter ? 'Search in project...' : 'Search sessions...';
    if (input.placeholder !== placeholder) input.placeholder = placeholder;

    // Project filter chip (sits immediately before the input)
    const chip = wrapper.querySelector('.search-filter-chip');
    if (projectFilter) {
        if (chip) {
            chip.outerHTML = filterChipHtml(projectFilter);
        } else {
            input.insertAdjacentHTML('beforebegin', filterChipHtml(projectFilter));
        }
    } else if (chip) {
        chip.remove();
    }

    // Clear button (sits immediately after the input)
    const clearBtn = wrapper.querySelector('.welcome-search-clear');
    if (searchValue || projectFilter) {
        if (!clearBtn) input.insertAdjacentHTML('afterend', clearButtonHtml());
    } else if (clearBtn) {
        clearBtn.remove();
    }

    // "N of M" status line
    const status = bar.querySelector('.welcome-search-status');
    if (showingFiltered) {
        const text = `${filteredCount} of ${sessionCount}`;
        if (status) {
            if (status.textContent !== text) status.textContent = text;
        } else {
            wrapper.insertAdjacentHTML('afterend', `<div class="welcome-search-status">${text}</div>`);
        }
    } else if (status) {
        status.remove();
    }

    // Limit selector count
    const limit = bar.querySelector('.welcome-limit-selector');
    if (limit) {
        limit.innerHTML = `showing ${sessionCount} <span class="welcome-limit-value">(limit: ${CONFIG.SESSION_LIST_LIMIT})</span>`;
    }

    return true;
}

/**
 * Render the favorites section as compact list.
 * Filters based on quickSearchFilter.
 */
export function renderFavoritesSection(startIndex = 0) {
    let favorites = state.favorites.filter(f => f.session !== null); // Hide deleted

    // Apply project filter to favorites
    if (state.projectFilter) {
        favorites = favorites.filter(f => {
            const s = f.session || {};
            return s.project_path === state.projectFilter.path;
        });
    }

    // Apply quick search filter to favorites
    if (state.quickSearchFilter) {
        const q = state.quickSearchFilter.toLowerCase();
        favorites = favorites.filter(f => {
            const s = f.session || {};
            const name = (s.name || '').toLowerCase();
            const summary = (s.summary || '').toLowerCase();
            const project = (s.project || '').toLowerCase();
            const note = (f.note || '').toLowerCase();
            return name.includes(q) || summary.includes(q) || project.includes(q) || note.includes(q);
        });
    }

    if (favorites.length === 0) return '';

    return `
        <div class="welcome-section welcome-section--favorites">
            <div class="welcome-section-header">
                <h3>Favorites</h3>
                <span class="section-nav-hint"><kbd>&#9664;</kbd> <kbd>&#9654;</kbd> to browse</span>
            </div>
            <div class="favorites-list">
                ${favorites.slice(0, favoritesLimit.value).map((f, i) => renderFavoriteRow(f, startIndex + i)).join('')}
            </div>
            ${favorites.length > favoritesLimit.value ? `
                <button class="welcome-btn welcome-btn--text" data-action="show-all-favorites">
                    Show all ${favorites.length} favorites
                </button>
            ` : ''}
        </div>
    `;
}

/**
 * Render a rich session card with shadow git data.
 */
export function renderSessionCard(session, options = {}) {
    const {
        compact = false,
        showMatchReasons = false,
    } = options;

    const name = session.name || session.project || 'Session';
    const timeAgo = formatRelativeTime(session.last_activity || session.created_at);
    const summary = session.summary || '';
    const firstPrompt = !summary ? (session.first_prompt || '') : '';
    const tags = session.tags || [];
    const files = session.files_changed || [];
    const cost = session.total_cost > 0 ? `$${session.total_cost.toFixed(2)}` : '';
    const turns = session.turn_count || session.message_count || 0;
    const reasons = session.match_reasons || [];

    // Compact mode for search results
    if (compact) {
        return `
            <div class="welcome-session-card welcome-session-card--compact"
                 data-session-id="${escapeHtml(session.session_id)}"
                 data-project-path="${escapeHtml(session.project_path || '')}"${projectColorStyle(session.project_path)}>
                <div class="welcome-session-header">
                    <div class="welcome-session-project">${escapeHtml(session.project || '')}</div>
                    <div class="welcome-session-time">${timeAgo}</div>
                </div>
                <div class="welcome-session-name">${escapeHtml(name)}</div>
                ${summary ? `<div class="welcome-session-summary">${escapeHtml(summary)}</div>` : ''}
                ${firstPrompt ? `<div class="welcome-session-summary first-prompt">${escapeHtml(firstPrompt)}</div>` : ''}
                <div class="welcome-session-tags">
                    ${tags.slice(0, 5).map(t => `<span class="welcome-tag">${escapeHtml(t)}</span>`).join('')}
                </div>
                ${showMatchReasons && reasons.length > 0 ? `
                    <div class="welcome-session-match-reasons">
                        ${reasons.map(r => `<span class="match-reason">${escapeHtml(r)}</span>`).join('')}
                    </div>
                ` : ''}
            </div>
        `;
    }

    // Full card with meta info (used in task mode for best matches)
    return `
        <div class="welcome-session-card"
             data-session-id="${escapeHtml(session.session_id)}"
             data-project-path="${escapeHtml(session.project_path || '')}"${projectColorStyle(session.project_path)}>
            <div class="welcome-session-header">
                <div class="welcome-session-title-row">
                    <span class="welcome-session-name">${escapeHtml(name)}</span>
                    <span class="welcome-session-project">${escapeHtml(session.project || '')}</span>
                </div>
                <div class="welcome-session-time">${timeAgo}</div>
            </div>

            ${summary ? `
                <div class="welcome-session-summary">${escapeHtml(summary)}</div>
            ` : ''}
            ${firstPrompt ? `
                <div class="welcome-session-summary first-prompt">${escapeHtml(firstPrompt)}</div>
            ` : ''}

            ${tags.length > 0 ? `
                <div class="welcome-session-tags">
                    ${tags.slice(0, 5).map(t => `<span class="welcome-tag">${escapeHtml(t)}</span>`).join('')}
                </div>
            ` : ''}

            <div class="welcome-session-meta">
                ${files.length > 0 ? `<span class="meta-item">📄 ${files.length} files</span>` : ''}
                ${turns > 0 ? `<span class="meta-item">⏱ ${turns} turns</span>` : ''}
                ${cost ? `<span class="meta-item meta-cost">${cost}</span>` : ''}
            </div>
        </div>
    `;
}

/**
 * Render the project quick-start picker.
 */
export function renderProjectPicker(projects, isOpen = false) {
    if (!projects || projects.length === 0) {
        return '';
    }

    return `
        <div class="welcome-project-picker ${isOpen ? 'is-open' : ''}">
            <button class="welcome-project-picker-toggle" data-action="toggle-projects">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                </svg>
                <span>Start new on project...</span>
                <svg class="chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="6 9 12 15 18 9"/>
                </svg>
            </button>
            <div class="welcome-project-list">
                ${projects.map(p => `
                    <div class="welcome-project-item" data-path="${escapeHtml(p.path)}"${projectColorStyle(p.path)}>
                        <span class="project-color-dot"></span>
                        <span class="project-name">${escapeHtml(p.name)}</span>
                        ${p.session_count > 0 ? `<span class="project-sessions">${p.session_count} sessions</span>` : ''}
                    </div>
                `).join('')}
                <div class="welcome-project-item welcome-project-browse" data-action="browse-project">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="11" cy="11" r="8"/>
                        <line x1="21" y1="21" x2="16.65" y2="16.65"/>
                    </svg>
                    <span>Browse other...</span>
                </div>
            </div>
        </div>
    `;
}

