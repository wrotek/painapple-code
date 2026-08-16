/**
 * Session family logic + grouping + compact-row renderers + task mode.
 *
 * "Family" = a session and its forks rooted at a common ancestor. The build
 * step here turns the flat session list into the family map the welcome
 * screen and task mode both consume. The render functions for project
 * groups and the task-mode panel live alongside since they share the
 * grouping helpers.
 */

import S from '../strings.js';
import { escapeHtml, formatRelativeTime } from '../utils.js';
import { projectColorStyle } from '../project-colors.js';
import { state, expandedFamilies, expandedGroups } from './state.js';
import { renderSessionFamily } from './cards.js';

// ═══════════════════════════════════════════════════════════════════════════
// FAMILY BUILDING
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build session families - groups of sessions sharing a common root.
 *
 * A "family" is:
 * - Root: Original session (not forked from anything visible)
 * - Branches: Sessions forked from the root or its descendants
 *
 * @param {Array} sessions - All sessions
 * @returns {Map<string, Object>} Map of rootId -> family object
 */
export function buildSessionFamilies(sessions) {
    // Build lookup map
    const byId = new Map();
    sessions.forEach(s => byId.set(s.session_id, s));

    // Build parent -> children map
    const children = new Map(); // parentId -> [childSessions]

    sessions.forEach(s => {
        if (s.forked_from?.store_id) {
            const parentId = s.forked_from.store_id;
            if (!children.has(parentId)) {
                children.set(parentId, []);
            }
            children.get(parentId).push(s);
        }
    });

    // Find root for each session (traverse up the fork chain)
    const rootCache = new Map(); // sessionId -> rootId

    function findRoot(sessionId, visited = new Set()) {
        if (rootCache.has(sessionId)) return rootCache.get(sessionId);
        if (visited.has(sessionId)) return sessionId; // Cycle protection

        visited.add(sessionId);
        const session = byId.get(sessionId);

        if (!session) return sessionId; // Session not in our list, treat as root

        const parentId = session.forked_from?.store_id;
        if (!parentId || !byId.has(parentId)) {
            // No parent or parent not visible - this is a root
            rootCache.set(sessionId, sessionId);
            return sessionId;
        }

        const rootId = findRoot(parentId, visited);
        rootCache.set(sessionId, rootId);
        return rootId;
    }

    // Group sessions by root
    const familyMap = new Map(); // rootId -> {root, branches, depths}

    sessions.forEach(s => {
        const rootId = findRoot(s.session_id);

        if (!familyMap.has(rootId)) {
            familyMap.set(rootId, {
                rootId,
                root: byId.get(rootId),
                branches: [],
                maxDepth: 0
            });
        }

        const family = familyMap.get(rootId);

        if (s.session_id !== rootId) {
            // Calculate depth
            let depth = 0;
            let current = s;
            while (current?.forked_from?.store_id && current.session_id !== rootId) {
                depth++;
                current = byId.get(current.forked_from.store_id);
            }

            family.branches.push({
                session: s,
                depth,
                parentId: s.forked_from?.store_id
            });
            family.maxDepth = Math.max(family.maxDepth, depth);
        }
    });

    // Sort branches by activity (most recent first) within each family
    familyMap.forEach(family => {
        family.branches.sort((a, b) => {
            const dateA = new Date(a.session.last_activity || a.session.created_at || 0);
            const dateB = new Date(b.session.last_activity || b.session.created_at || 0);
            return dateB - dateA;
        });
    });

    // Promote newest session to be the display root
    // The most recently active session becomes the main tile
    familyMap.forEach(family => {
        if (family.branches.length === 0) return;

        const rootDate = new Date(family.root.last_activity || family.root.created_at || 0);
        const newestBranch = family.branches[0]; // Already sorted, first is newest
        const newestDate = new Date(newestBranch.session.last_activity || newestBranch.session.created_at || 0);

        if (newestDate > rootDate) {
            // Swap: newest branch becomes display root, old root goes to branches
            // Keep family.rootId unchanged for stable expansion tracking
            const oldRoot = family.root;
            family.root = newestBranch.session;

            // Remove the promoted session from branches
            family.branches.shift();

            // Add old root to branches (insert sorted by date)
            family.branches.push({
                session: oldRoot,
                depth: 1,
                parentId: null
            });

            // Re-sort branches after adding old root
            family.branches.sort((a, b) => {
                const dateA = new Date(a.session.last_activity || a.session.created_at || 0);
                const dateB = new Date(b.session.last_activity || b.session.created_at || 0);
                return dateB - dateA;
            });
        }
    });

    return familyMap;
}

/**
 * Check if a session has any branches (is a root with forks).
 */
export function hasBranches(sessionId, familyMap) {
    const family = familyMap.get(sessionId);
    return family && family.branches.length > 0;
}

/**
 * Get total branch count for a family (excluding discussion threads if hidden).
 */
export function getBranchCount(family, hideDiscussions = true) {
    if (!family) return 0;
    if (!hideDiscussions) return family.branches.length;

    return family.branches.filter(b => !b.session.is_comment_thread).length;
}

// ═══════════════════════════════════════════════════════════════════════════
// TIME-PERIOD GROUPING
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get time period label for a date.
 */
export function getTimePeriod(dateStr) {
    if (!dateStr) return 'older';
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now - date;
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0) return 'today';
    if (diffDays === 1) return 'yesterday';
    if (diffDays <= 7) return 'this-week';
    if (diffDays <= 30) return 'this-month';
    return 'older';
}

/**
 * Get display label for time period.
 */
export function getTimePeriodLabel(period) {
    const labels = {
        'today': S.time_periods.today,
        'yesterday': S.time_periods.yesterday,
        'this-week': S.time_periods.this_week,
        'this-month': S.time_periods.this_month,
        'older': S.time_periods.older
    };
    return labels[period] || period;
}

/**
 * Group sessions by project and time period.
 */
export function groupSessions(sessions) {
    const byProject = new Map();

    sessions.forEach(session => {
        const project = session.project || 'Unknown Project';
        if (!byProject.has(project)) {
            byProject.set(project, {
                name: project,
                path: session.project_path || '',
                sessions: [],
                byPeriod: new Map()
            });
        }

        const group = byProject.get(project);
        group.sessions.push(session);

        const period = getTimePeriod(session.last_activity || session.created_at);
        if (!group.byPeriod.has(period)) {
            group.byPeriod.set(period, []);
        }
        group.byPeriod.get(period).push(session);
    });

    // Sort projects by session count (most sessions first)
    return Array.from(byProject.values())
        .sort((a, b) => b.sessions.length - a.sessions.length);
}

/**
 * Group session families by project.
 * Takes the actual families and groups them by project.
 *
 * @param {Array} families - Array of family objects (from remainingFamilies)
 */
export function groupFamiliesByProject(families) {
    const byProject = new Map();

    families.forEach(family => {
        if (!family || !family.root) return;

        const project = family.root.project || 'Unknown Project';
        if (!byProject.has(project)) {
            byProject.set(project, {
                name: project,
                path: family.root.project_path || '',
                families: [],
                totalSessions: 0
            });
        }

        const group = byProject.get(project);
        group.families.push(family);
        group.totalSessions += 1 + family.branches.length;
    });

    // Sort projects by total session count
    return Array.from(byProject.values())
        .sort((a, b) => b.totalSessions - a.totalSessions);
}

// ═══════════════════════════════════════════════════════════════════════════
// COMPACT-ROW + PROJECT-GROUP RENDERERS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Render a compact session row for grouped view.
 */
export function renderCompactSessionRow(session) {
    const name = session.name || session.summary?.slice(0, 40) || 'Session';
    const time = formatRelativeTime(session.last_activity || session.created_at);
    const tags = (session.tags || []).slice(0, 2);

    return `
        <div class="task-session-row"
             data-session-id="${escapeHtml(session.session_id)}"
             data-project-path="${escapeHtml(session.project_path || '')}">
            <div class="task-session-info">
                <span class="task-session-name">${escapeHtml(name)}</span>
                <span class="task-session-time">${time}</span>
            </div>
            ${tags.length > 0 ? `
                <div class="task-session-tags">
                    ${tags.map(t => `<span class="welcome-tag welcome-tag--small">${escapeHtml(t)}</span>`).join('')}
                </div>
            ` : ''}
            <div class="task-session-actions">
                <button class="task-action-btn task-action-continue" data-action="continue-with-task" data-tooltip="Continue in this session">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="9 18 15 12 9 6"/>
                    </svg>
                </button>
                <button class="task-action-btn task-action-fork" data-action="fork-with-task" data-tooltip="Fork this session">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="12" cy="18" r="3"/>
                        <circle cx="6" cy="6" r="3"/>
                        <circle cx="18" cy="6" r="3"/>
                        <path d="M18 9v1a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V9"/>
                        <line x1="12" y1="12" x2="12" y2="15"/>
                    </svg>
                </button>
            </div>
        </div>
    `;
}

/**
 * Render a project group with time-based sections.
 */
export function renderProjectGroup(group, isExpanded, index) {
    const periodOrder = ['today', 'yesterday', 'this-week', 'this-month', 'older'];
    const groupId = `project-${index}`;

    // Get sessions to show (limited if collapsed)
    const maxCollapsed = 3;
    const showAll = isExpanded || group.sessions.length <= maxCollapsed;

    return `
        <div class="task-project-group ${isExpanded ? 'is-expanded' : ''}" data-group-id="${groupId}" data-project-path="${escapeHtml(group.path || '')}"${projectColorStyle(group.path)}>
            <div class="task-project-header" data-action="toggle-group" data-group="${groupId}">
                <svg class="task-project-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="9 18 15 12 9 6"/>
                </svg>
                <span class="project-color-dot"></span>
                <span class="task-project-name">${escapeHtml(group.name)}</span>
                <span class="task-project-count">(${group.sessions.length})</span>
                <button class="task-project-start" data-action="new-session-in-project" data-project-path="${escapeHtml(group.path || '')}" data-tooltip="Start new session in ${escapeHtml(group.name)}">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polygon points="5 3 19 12 5 21 5 3"/>
                    </svg>
                </button>
            </div>
            <div class="task-project-sessions">
                ${showAll ? periodOrder.map(period => {
                    const periodSessions = group.byPeriod.get(period);
                    if (!periodSessions || periodSessions.length === 0) return '';

                    return `
                        <div class="task-period-section">
                            <div class="task-period-label">${getTimePeriodLabel(period)}</div>
                            ${periodSessions.map(s => renderCompactSessionRow(s)).join('')}
                        </div>
                    `;
                }).join('') : `
                    ${group.sessions.slice(0, maxCollapsed).map(s => renderCompactSessionRow(s)).join('')}
                    <div class="task-show-more" data-action="toggle-group" data-group="${groupId}">
                        Show ${group.sessions.length - maxCollapsed} more...
                    </div>
                `}
            </div>
        </div>
    `;
}

/**
 * Render a compact session row for welcome screen (without task actions).
 */
export function renderWelcomeSessionRow(session) {
    const name = session.name || session.summary?.slice(0, 40) || 'Session';
    const time = formatRelativeTime(session.last_activity || session.created_at);
    const tags = (session.tags || []).slice(0, 2);

    return `
        <div class="welcome-session-row"
             data-session-id="${escapeHtml(session.session_id)}"
             data-project-path="${escapeHtml(session.project_path || '')}">
            <div class="welcome-row-info">
                <span class="welcome-row-name">${escapeHtml(name)}</span>
                <span class="welcome-row-time">${time}</span>
            </div>
            ${tags.length > 0 ? `
                <div class="welcome-row-tags">
                    ${tags.map(t => `<span class="welcome-tag welcome-tag--small">${escapeHtml(t)}</span>`).join('')}
                </div>
            ` : ''}
        </div>
    `;
}

/**
 * Render a project group for welcome screen (click to open session).
 */
export function renderWelcomeProjectGroup(group, isExpanded, index) {
    const periodOrder = ['today', 'yesterday', 'this-week', 'this-month', 'older'];
    const groupId = `welcome-project-${index}`;

    // Get sessions to show (limited if collapsed)
    const maxCollapsed = 3;
    const showAll = isExpanded || group.sessions.length <= maxCollapsed;

    return `
        <div class="task-project-group ${isExpanded ? 'is-expanded' : ''}" data-group-id="${groupId}" data-project-path="${escapeHtml(group.path || '')}"${projectColorStyle(group.path)}>
            <div class="task-project-header" data-action="toggle-welcome-group" data-group="${groupId}">
                <svg class="task-project-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="9 18 15 12 9 6"/>
                </svg>
                <span class="project-color-dot"></span>
                <span class="task-project-name">${escapeHtml(group.name)}</span>
                <span class="task-project-count">(${group.sessions.length})</span>
                <button class="task-project-start" data-action="new-session-in-project" data-project-path="${escapeHtml(group.path || '')}" data-tooltip="Start new session in ${escapeHtml(group.name)}">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polygon points="5 3 19 12 5 21 5 3"/>
                    </svg>
                </button>
            </div>
            <div class="task-project-sessions">
                ${showAll ? periodOrder.map(period => {
                    const periodSessions = group.byPeriod.get(period);
                    if (!periodSessions || periodSessions.length === 0) return '';

                    return `
                        <div class="task-period-section">
                            <div class="task-period-label">${getTimePeriodLabel(period)}</div>
                            ${periodSessions.map(s => renderWelcomeSessionRow(s)).join('')}
                        </div>
                    `;
                }).join('') : `
                    ${group.sessions.slice(0, maxCollapsed).map(s => renderWelcomeSessionRow(s)).join('')}
                    <div class="task-show-more" data-action="toggle-welcome-group" data-group="${groupId}">
                        Show ${group.sessions.length - maxCollapsed} more...
                    </div>
                `}
            </div>
        </div>
    `;
}

/**
 * Render a project group showing session families.
 */
export function renderFamilyProjectGroup(group, isExpanded, index) {
    const groupId = `welcome-project-${index}`;
    const families = group.families || [];

    // Limit if collapsed
    const maxCollapsed = 2;
    const showAll = isExpanded || families.length <= maxCollapsed;
    const displayFamilies = showAll ? families : families.slice(0, maxCollapsed);

    return `
        <div class="task-project-group ${isExpanded ? 'is-expanded' : ''}" data-group-id="${groupId}" data-project-path="${escapeHtml(group.path || '')}"${projectColorStyle(group.path)}>
            <div class="task-project-header" data-action="toggle-welcome-group" data-group="${groupId}">
                <svg class="task-project-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="9 18 15 12 9 6"/>
                </svg>
                <span class="project-color-dot"></span>
                <span class="task-project-name">${escapeHtml(group.name)}</span>
                <span class="task-project-count">(${group.totalSessions})</span>
                <button class="task-project-start" data-action="new-session-in-project" data-project-path="${escapeHtml(group.path || '')}" data-tooltip="Start new session in ${escapeHtml(group.name)}">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polygon points="5 3 19 12 5 21 5 3"/>
                    </svg>
                </button>
            </div>
            <div class="task-project-sessions project-families">
                ${displayFamilies.map(f => renderSessionFamily(f, expandedFamilies.has(`family-${f.rootId}`))).join('')}
                ${!showAll && families.length > maxCollapsed ? `
                    <div class="task-show-more" data-action="toggle-welcome-group" data-group="${groupId}">
                        Show ${families.length - maxCollapsed} more...
                    </div>
                ` : ''}
            </div>
        </div>
    `;
}

/**
 * Render a compact family view for project groups.
 * @deprecated - now using renderSessionFamily for all family views
 */
export function renderCompactFamily(family) {
    if (!family || !family.root) return '';

    const root = family.root;
    const forks = family.branches.filter(b => !b.session.is_comment_thread);

    const name = root.name || root.project || 'Session';
    const time = formatRelativeTime(root.last_activity || root.created_at);
    const displayName = name.replace(/^(Fork of )+/i, '');
    const isOpen = state.openSessionIds.has(root.session_id);
    const isRunning = state.runningSessionIds.has(root.session_id);

    // Build status badge
    let statusBadge = '';
    if (isRunning) {
        statusBadge = '<span class="session-status-badge running" data-tooltip="Claude is running">●</span>';
    } else if (isOpen) {
        statusBadge = '<span class="session-status-badge open" data-tooltip="Open in tab">○</span>';
    }

    return `
        <div class="compact-family ${isOpen ? 'is-open' : ''} ${isRunning ? 'is-running' : ''}"
             data-session-id="${escapeHtml(root.session_id)}"
             data-project-path="${escapeHtml(root.project_path || '')}">
            <div class="compact-family-main">
                ${statusBadge}<span class="compact-family-name">${escapeHtml(displayName)}</span>
                <span class="compact-family-time">${time}</span>
                ${forks.length > 0 ? `
                    <span class="compact-family-forks">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="12" height="12">
                            <circle cx="12" cy="18" r="2"/>
                            <circle cx="6" cy="6" r="2"/>
                            <circle cx="18" cy="6" r="2"/>
                            <path d="M18 8v1a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V8"/>
                            <line x1="12" y1="10" x2="12" y2="16"/>
                        </svg>
                        +${forks.length}
                    </span>
                ` : ''}
            </div>
        </div>
    `;
}

// ═══════════════════════════════════════════════════════════════════════════
// TASK MODE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Render task mode - shows related sessions with option to continue or start fresh.
 */
export function renderTaskMode(results, task, totalCount = 0) {
    const hasResults = results && results.length > 0;

    if (!hasResults) {
        return `
            <div class="welcome-task-mode">
                <div class="welcome-task-header">
                    <div class="task-icon">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                        </svg>
                    </div>
                    <div class="task-info">
                        <div class="task-label">Ready to start</div>
                        <div class="task-preview">"${escapeHtml(task.length > 60 ? task.slice(0, 60) + '...' : task)}"</div>
                    </div>
                </div>
                <div class="welcome-task-no-matches">
                    <p>No related sessions found. This will start a new conversation.</p>
                </div>
                <div class="welcome-task-actions">
                    <button class="welcome-btn welcome-btn--primary welcome-btn--start-fresh" data-action="start-fresh">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <line x1="12" y1="5" x2="12" y2="19"/>
                            <line x1="5" y1="12" x2="19" y2="12"/>
                        </svg>
                        Start Fresh
                    </button>
                    <button class="welcome-btn welcome-btn--secondary" data-action="cancel-task">
                        Cancel
                    </button>
                </div>
            </div>
        `;
    }

    // Top matches - best 3 results shown as full cards
    const topMatches = results.slice(0, 3);

    // Remaining sessions grouped by project (excluding top matches)
    const remainingSessions = results.slice(3);
    const groups = groupSessions(remainingSessions);
    const projectCount = new Set(results.map(s => s.project || 'Unknown')).size;
    const displayCount = totalCount || results.length;

    return `
        <div class="welcome-task-mode">
            <div class="welcome-task-header">
                <div class="task-icon">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                    </svg>
                </div>
                <div class="task-info">
                    <div class="task-label">Found ${displayCount} related session${displayCount !== 1 ? 's' : ''}</div>
                    <div class="task-preview">"${escapeHtml(task.length > 60 ? task.slice(0, 60) + '...' : task)}"</div>
                </div>
            </div>

            <div class="task-summary">
                <span class="task-summary-stat">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                    </svg>
                    ${projectCount} project${projectCount !== 1 ? 's' : ''}
                </span>
            </div>

            <!-- Top Matches Section -->
            <div class="task-section">
                <div class="task-section-header">
                    <span class="task-section-title">Best Matches</span>
                </div>
                <div class="welcome-sessions-grid welcome-sessions-grid--compact">
                    ${topMatches.map(s => `
                        <div class="welcome-session-card welcome-session-card--task"
                             data-session-id="${escapeHtml(s.session_id)}"
                             data-project-path="${escapeHtml(s.project_path || '')}">
                            <div class="welcome-session-header">
                                <div class="welcome-session-title-row">
                                    <span class="welcome-session-name">${escapeHtml(s.name || s.project || 'Session')}</span>
                                    <span class="welcome-session-project">${escapeHtml(s.project || '')}</span>
                                </div>
                                <div class="welcome-session-time">${formatRelativeTime(s.last_activity || s.created_at)}</div>
                            </div>
                            ${s.summary ? `<div class="welcome-session-summary">${escapeHtml(s.summary)}</div>` : ''}
                            <div class="welcome-session-tags">
                                ${(s.tags || []).slice(0, 4).map(t => `<span class="welcome-tag">${escapeHtml(t)}</span>`).join('')}
                            </div>
                            ${(s.match_reasons || []).length > 0 ? `
                                <div class="welcome-session-match-reasons">
                                    ${s.match_reasons.slice(0, 2).map(r => `<span class="match-reason">${escapeHtml(r)}</span>`).join('')}
                                </div>
                            ` : ''}
                            <div class="welcome-task-card-actions">
                                <button class="welcome-btn welcome-btn--continue" data-action="continue-with-task">
                                    Continue
                                </button>
                                <button class="welcome-btn welcome-btn--fork" data-action="fork-with-task" data-tooltip="Create a branch from this session">
                                    Fork
                                </button>
                            </div>
                        </div>
                    `).join('')}
                </div>
            </div>

            <!-- Grouped by Project Section (remaining sessions after top matches) -->
            ${remainingSessions.length > 0 ? `
                <div class="task-section">
                    <div class="task-section-header">
                        <span class="task-section-title">More Sessions</span>
                        <span class="task-section-count">${remainingSessions.length} more</span>
                    </div>
                    <div class="task-project-groups">
                        ${groups.map((group, i) => renderProjectGroup(group, expandedGroups.has(`project-${i}`), i)).join('')}
                    </div>
                </div>
            ` : ''}

            <div class="welcome-task-actions">
                <button class="welcome-btn welcome-btn--primary welcome-btn--start-fresh" data-action="start-fresh">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <line x1="12" y1="5" x2="12" y2="19"/>
                        <line x1="5" y1="12" x2="19" y2="12"/>
                    </svg>
                    Start Fresh
                </button>
                <button class="welcome-btn welcome-btn--secondary" data-action="cancel-task">
                    Cancel
                </button>
            </div>
        </div>
    `;
}

// ═══════════════════════════════════════════════════════════════════════════
// PROJECTS QUICK-START
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Render projects quick-start section.
 * Shows project chips for quick access to start new sessions, plus a
 * secondary row of workspace siblings the user hasn't opened yet.
 * @param {Array} projects - List of projects (already filtered/sorted)
 * @param {number} startIndex - Starting index for keyboard navigation
 * @param {Array} workspaceDirs - Sibling dirs to render (already sliced)
 * @param {number} workspaceStartIndex - Keyboard nav index for the first workspace chip
 * @param {number} unvisitedTotal - Total available unvisited dirs (pre-slice)
 * @param {boolean} unvisitedExpanded - Whether the "show all" toggle is on
 * @param {Object} [opts] - Visited-row overflow state
 * @param {number} [opts.projectsTotal] - Total projects available (pre-slice)
 * @param {boolean} [opts.projectsCollapsible] - Whether the total exceeds the cap
 * @param {boolean} [opts.projectsExpanded] - Whether the visited "show all" toggle is on
 * @param {string} [opts.activeProjectPath] - Path of the currently filtered project
 */
export function renderProjectsQuickStart(projects, startIndex = 0, workspaceDirs = [], workspaceStartIndex = 0, unvisitedTotal = 0, unvisitedExpanded = false, opts = {}) {
    const hasProjects = projects && projects.length > 0;
    const hasUnvisited = workspaceDirs && workspaceDirs.length > 0;
    if (!hasProjects && !hasUnvisited) return '';

    const {
        projectsTotal = projects?.length || 0,
        projectsCollapsible = false,
        projectsExpanded = false,
        activeProjectPath = '',
    } = opts;

    const projectChips = hasProjects ? projects.map((p, i) => {
        const idx = startIndex + i;
        const isSelected = state.selectedResultIndex === idx;
        const isActive = !!activeProjectPath && p.path === activeProjectPath;
        return `
            <button class="welcome-project-chip ${isActive ? 'welcome-project-chip--active' : ''} ${isSelected ? 'selected' : ''}"
                    data-action="quick-start-project"
                    data-project-path="${escapeHtml(p.path)}"
                    data-project-name="${escapeHtml(p.name)}"
                    data-selectable-index="${idx}"
                    data-tooltip="${escapeHtml(p.path)}"${projectColorStyle(p.path)}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                </svg>
                <span>${escapeHtml(p.name)}</span>
                ${p.session_count > 0 ? `<span class="project-chip-count">${p.session_count}</span>` : ''}
            </button>
        `;
    }).join('') : '';

    // Overflow toggle for the visited row. Without it the cap is a silent
    // truncation — the chips row has no scroll and no wrap-overflow, so a
    // project past the cap simply isn't reachable. Not keyboard-selectable.
    const projectsHidden = Math.max(0, projectsTotal - (projects?.length || 0));
    let projectsToggle = '';
    if (projectsExpanded && projectsCollapsible) {
        projectsToggle = `
            <button class="welcome-project-chip welcome-project-chip--more-toggle"
                    data-action="toggle-projects">
                <span>${escapeHtml(S.ui.welcome.projects_show_less)}</span>
            </button>
        `;
    } else if (projectsHidden > 0) {
        projectsToggle = `
            <button class="welcome-project-chip welcome-project-chip--more-toggle"
                    data-action="toggle-projects">
                <span>${escapeHtml(S.ui.welcome.projects_show_more.replace('{count}', projectsHidden))}</span>
            </button>
        `;
    }

    const unvisitedChips = hasUnvisited ? workspaceDirs.map((d, i) => {
        const idx = workspaceStartIndex + i;
        const isSelected = state.selectedResultIndex === idx;
        return `
            <button class="welcome-project-chip welcome-project-chip--unvisited ${isSelected ? 'selected' : ''}"
                    data-action="quick-start-project"
                    data-project-path="${escapeHtml(d.path)}"
                    data-project-name="${escapeHtml(d.name)}"
                    data-selectable-index="${idx}"
                    data-tooltip="${escapeHtml(d.path)}">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                </svg>
                <span>${escapeHtml(d.name)}</span>
            </button>
        `;
    }).join('') : '';

    // Toggle chip — appears when more dirs exist than we're rendering, or
    // when expanded (so user can collapse). Not keyboard-selectable.
    const hiddenCount = Math.max(0, unvisitedTotal - workspaceDirs.length);
    let toggleChip = '';
    if (unvisitedExpanded && unvisitedTotal > 8) {
        toggleChip = `
            <button class="welcome-project-chip welcome-project-chip--unvisited-toggle"
                    data-action="toggle-unvisited">
                <span>${escapeHtml(S.ui.welcome.unvisited_show_less)}</span>
            </button>
        `;
    } else if (hiddenCount > 0) {
        toggleChip = `
            <button class="welcome-project-chip welcome-project-chip--unvisited-toggle"
                    data-action="toggle-unvisited">
                <span>${escapeHtml(S.ui.welcome.unvisited_show_more.replace('{count}', hiddenCount))}</span>
            </button>
        `;
    }

    const unvisitedBlock = hasUnvisited ? `
        <div class="welcome-projects-separator" aria-hidden="true">
            <span class="welcome-projects-separator-label">${escapeHtml(S.ui.welcome.unvisited_separator)}</span>
        </div>
        <div class="welcome-projects-chips welcome-projects-chips--unvisited">
            ${unvisitedChips}
            ${toggleChip}
        </div>
    ` : '';

    return `
        <div class="welcome-section welcome-section--projects">
            <div class="welcome-section-header">
                <h3>${escapeHtml(S.ui.welcome.projects_header)}</h3>
                <span class="section-nav-hints">
                    <span class="section-nav-hint"><kbd>&#9664;</kbd> <kbd>&#9654;</kbd> ${escapeHtml(S.ui.welcome.projects_nav_hint)}</span>
                    <span class="section-nav-hint"><kbd>&#x2325;</kbd> <kbd>&#x21B5;</kbd> ${escapeHtml(S.ui.welcome.projects_filter_hint)}</span>
                </span>
            </div>
            ${hasProjects ? `<div class="welcome-projects-chips">${projectChips}${projectsToggle}</div>` : ''}
            ${unvisitedBlock}
        </div>
    `;
}
