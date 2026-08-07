/**
 * Git Widget - Repository status and history viewer using the widget system
 *
 * Shows uncommitted changes, commit history, and file diffs.
 * Migrated from git-panel.js to use the modular widget system.
 *
 * Views: status → diff → history → commit detail
 */

import S from '../strings.js';
import { escapeHtml, formatRelativeTime } from '../utils.js';
import { CONFIG } from '../config.js';
import { WidgetManager, WidgetBus, ICONS } from '../widget-system/index.js';

// File status icons with colors
const STATUS_ICONS = {
    modified: { icon: 'M', color: 'var(--accent-orange)', label: S.widgets.git.statuses.modified },
    added: { icon: 'A', color: 'var(--accent-green)', label: S.widgets.git.statuses.added },
    deleted: { icon: 'D', color: 'var(--accent-red)', label: S.widgets.git.statuses.deleted },
    renamed: { icon: 'R', color: 'var(--accent-blue)', label: S.widgets.git.statuses.renamed },
    copied: { icon: 'C', color: 'var(--accent-purple)', label: S.widgets.git.statuses.copied },
    untracked: { icon: '?', color: 'var(--text-muted)', label: S.widgets.git.statuses.untracked },
};

/**
 * Git Widget State
 * Kept separate from widget so it persists across transforms
 */
class GitState {
    constructor() {
        this.cwd = null;
        this.gitStatus = null;
        this.commits = [];
        this.hasMoreCommits = false;
        this.view = 'status'; // 'status', 'diff', 'history', 'commit'
        this.selectedFile = null;
        this.selectedFileStaged = false;
        this.selectedCommit = null;
        this.loading = false;
        this.error = null;
        this.currentContainer = null; // For tab mode rendering
    }

    reset() {
        this.gitStatus = null;
        this.commits = [];
        this.hasMoreCommits = false;
        this.view = 'status';
        this.selectedFile = null;
        this.selectedFileStaged = false;
        this.selectedCommit = null;
        this.loading = false;
        this.error = null;
    }
}

// Per-session state map
const states = new Map();

function getState(sessionId) {
    if (!sessionId) sessionId = WidgetManager.currentSessionId;
    if (!states.has(sessionId)) states.set(sessionId, new GitState());
    return states.get(sessionId);
}

function destroyState(sessionId) {
    states.delete(sessionId);
}

// ─────────────────────────────────────────────────────────────────────
// Data Loading
// ─────────────────────────────────────────────────────────────────────

async function loadStatus() {
    const state = getState();
    if (!state.cwd) return;

    state.loading = true;
    state.error = null;
    renderContent();

    try {
        const url = `${CONFIG.API_BASE}/api/git/status?cwd=${encodeURIComponent(state.cwd)}`;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const data = await response.json();

        if (data.error === 'not_a_repo') {
            state.loading = false;
            state.error = 'Not a git repository';
            renderContent();
            return;
        }

        state.gitStatus = data;
        state.loading = false;
        state.view = 'status';
        updateSummary();
        renderContent();

        // Update status bar branch (git panel has fresher data than session switch)
        if (data.branch && window.app?.statusBar) {
            window.app.statusBar.updateBranch(data.branch);
        }

    } catch (err) {
        state.loading = false;
        state.error = `Failed to load git status: ${err.message}`;
        renderContent();
    }
}

async function loadDiff(file = null, staged = false) {
    const state = getState();
    if (!state.cwd) return null;

    try {
        let url = `${CONFIG.API_BASE}/api/git/diff?cwd=${encodeURIComponent(state.cwd)}`;
        if (file) url += `&file=${encodeURIComponent(file)}`;
        if (staged) url += '&staged=true';

        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        return await response.json();
    } catch (err) {
        console.error('Failed to load diff:', err);
        return null;
    }
}

async function loadHistory(skip = 0) {
    const state = getState();
    if (!state.cwd) return;

    if (skip === 0) {
        state.loading = true;
        state.commits = [];
        renderContent();
    }

    try {
        const url = `${CONFIG.API_BASE}/api/git/log?cwd=${encodeURIComponent(state.cwd)}&limit=20&skip=${skip}`;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const data = await response.json();
        state.commits = [...state.commits, ...data.commits];
        state.hasMoreCommits = data.hasMore;
        state.loading = false;
        renderContent();

    } catch (err) {
        state.loading = false;
        state.error = `Failed to load history: ${err.message}`;
        renderContent();
    }
}

async function loadCommit(hash) {
    const state = getState();
    if (!state.cwd) return null;

    try {
        const url = `${CONFIG.API_BASE}/api/git/show/${hash}?cwd=${encodeURIComponent(state.cwd)}`;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        return await response.json();
    } catch (err) {
        console.error('Failed to load commit:', err);
        return null;
    }
}

function refresh() {
    const state = getState();
    if (state.view === 'history') {
        loadHistory(0);
    } else if (state.view === 'commit' && state.selectedCommit) {
        showCommitDetail(state.selectedCommit);
    } else {
        loadStatus();
    }
}

// ─────────────────────────────────────────────────────────────────────
// Summary Update
// ─────────────────────────────────────────────────────────────────────

function updateSummary() {
    const state = getState();
    const widget = WidgetManager.get('git');
    if (!widget || !state.gitStatus) return;

    const { branch, ahead, behind, summary } = state.gitStatus;

    // Build HTML summary with branch pill and colored count badges
    let html = `<span class="git-summary-branch">${escapeHtml(branch || '?')}</span>`;

    // Ahead/behind indicators
    if (ahead > 0) html += `<span class="git-summary-sync ahead">↑${ahead}</span>`;
    if (behind > 0) html += `<span class="git-summary-sync behind">↓${behind}</span>`;

    const total = summary.stagedCount + summary.modifiedCount + summary.untrackedCount;
    if (total === 0) {
        html += `<span class="git-summary-badge clean" data-tooltip="Working tree clean">✓</span>`;
    } else {
        // Compact colored badges
        if (summary.stagedCount > 0) {
            html += `<span class="git-summary-badge staged" data-tooltip="${summary.stagedCount} staged">${summary.stagedCount}</span>`;
        }
        if (summary.modifiedCount > 0) {
            html += `<span class="git-summary-badge modified" data-tooltip="${summary.modifiedCount} modified">${summary.modifiedCount}</span>`;
        }
        if (summary.untrackedCount > 0) {
            html += `<span class="git-summary-badge untracked" data-tooltip="${summary.untrackedCount} untracked">${summary.untrackedCount}</span>`;
        }
    }

    widget.setSummaryHTML(html);
}

// ─────────────────────────────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────────────────────────────

function renderContent() {
    const state = getState();
    // Get container: either from visible widget or from state (tab mode)
    const widget = WidgetManager.get('git');
    const container = (widget?.isVisible ? widget.contentContainer : null) || state.currentContainer;
    if (!container) return;

    // Loading state
    if (state.loading) {
        container.innerHTML = '<div class="git-loading">Loading...</div>';
        return;
    }

    // Error state
    if (state.error) {
        container.innerHTML = `<div class="git-error">${escapeHtml(state.error)}</div>`;
        return;
    }

    // Route to appropriate view
    switch (state.view) {
        case 'diff':
            // Already rendered by showFileDiff
            break;
        case 'history':
            renderHistoryView(container);
            break;
        case 'commit':
            // Already rendered by showCommitDetail
            break;
        default:
            renderStatusView(container);
    }
}

// ─────────────────────────────────────────────────────────────────────
// Status View
// ─────────────────────────────────────────────────────────────────────

function renderStatusView(container) {
    const state = getState();
    if (!state.gitStatus) {
        container.innerHTML = '<div class="git-empty">No git repository</div>';
        return;
    }

    const { staged, modified, untracked } = state.gitStatus;
    const total = staged.length + modified.length + untracked.length;

    if (total === 0) {
        container.innerHTML = '<div class="git-empty">Working tree clean</div>';
        return;
    }

    let html = '<div class="git-content">';

    if (staged.length > 0) {
        html += renderFileSection('Staged Changes', staged, true, 'staged');
    }

    if (modified.length > 0) {
        html += renderFileSection('Changes', modified, false, 'modified');
    }

    if (untracked.length > 0) {
        html += renderFileSection('Untracked Files', untracked, false, 'untracked');
    }

    html += '</div>';
    container.innerHTML = html;

    // Attach click handlers
    attachStatusEventHandlers(container);
}

function renderFileSection(title, files, isStaged, type) {
    return `
        <div class="git-section git-section-${type}">
            <div class="git-section-header">
                <span>${title}</span>
                <span class="git-section-count">${files.length}</span>
            </div>
            <div class="git-file-list">
                ${files.map(f => renderFileItem(f, isStaged, type)).join('')}
            </div>
        </div>
    `;
}

function renderFileItem(file, isStaged, type) {
    const state = getState();
    const status = file.status || (type === 'untracked' ? 'untracked' : 'modified');
    const statusInfo = STATUS_ICONS[status] || STATUS_ICONS.modified;
    const isClickable = type !== 'untracked';

    // Show diff stats if available (not for untracked files)
    const hasStats = type !== 'untracked' && (file.additions > 0 || file.deletions > 0);
    const statsHtml = hasStats ? `
        <span class="git-file-stats">
            ${file.additions > 0 ? `<span class="added">+${file.additions}</span>` : ''}
            ${file.deletions > 0 ? `<span class="removed">-${file.deletions}</span>` : ''}
        </span>
    ` : '';

    // data-cwd is read by the document-level context-menu handler in app.js
    // (showGitFileMenu) so it can resolve relative paths to absolute ones.
    return `
        <div class="git-file-item ${isClickable ? 'clickable' : ''}"
             data-path="${escapeHtml(file.path)}"
             data-cwd="${escapeHtml(state.cwd || '')}"
             data-staged="${isStaged}"
             ${!isClickable ? 'data-no-diff="true"' : ''}>
            <span class="git-file-status" style="color: ${statusInfo.color}" data-tooltip="${statusInfo.label}">
                ${statusInfo.icon}
            </span>
            <span class="git-file-path">${escapeHtml(file.path)}</span>
            ${statsHtml}
            ${isClickable ? `<span class="git-file-chevron">${ICONS.chevronRight}</span>` : ''}
        </div>
    `;
}

function attachStatusEventHandlers(container) {
    container.querySelectorAll('.git-file-item.clickable').forEach(item => {
        item.addEventListener('click', () => {
            const filePath = item.dataset.path;
            const staged = item.dataset.staged === 'true';
            showFileDiff(filePath, staged);
        });
    });
}

// ─────────────────────────────────────────────────────────────────────
// Diff View
// ─────────────────────────────────────────────────────────────────────

async function showFileDiff(filePath, staged = false) {
    const state = getState();
    state.selectedFile = filePath;
    state.selectedFileStaged = staged;
    state.view = 'diff';

    const widget = WidgetManager.get('git');
    const container = (widget?.isVisible ? widget.contentContainer : null) || state.currentContainer;
    if (!container) return;

    container.innerHTML = '<div class="git-loading">Loading diff...</div>';

    const diff = await loadDiff(filePath, staged);
    const file = diff?.files?.[0] || null;

    renderDiffView(container, filePath, file, staged);
}

function renderDiffView(container, filePath, file, staged) {
    const state = getState();
    const filename = filePath.split('/').pop();
    const statsHtml = file ? `
        <span class="git-diff-stats">
            <span class="added">+${file.additions}</span>
            <span class="removed">-${file.deletions}</span>
        </span>
    ` : '';

    let diffHtml;
    if (!file || file.hunks.length === 0) {
        diffHtml = '<div class="git-no-diff">No diff available (file may be binary or new)</div>';
    } else {
        diffHtml = renderDiffHunks(file.hunks);
    }

    container.innerHTML = `
        <div class="git-diff-view">
            <div class="git-diff-header">
                <button class="git-back-btn" data-tooltip="Back">${ICONS.back}</button>
                <span class="git-diff-title">${escapeHtml(filename)}</span>
                ${staged ? '<span class="git-diff-staged">Staged</span>' : ''}
                ${statsHtml}
                <button class="git-sbs-btn" data-tooltip="${S.widgets.diff_viewer.side_by_side}">${ICONS.columns}</button>
            </div>
            <div class="git-diff-container">
                ${diffHtml}
            </div>
        </div>
    `;

    // Back button handler
    container.querySelector('.git-back-btn')?.addEventListener('click', () => {
        state.view = 'status';
        state.selectedFile = null;
        renderContent();
    });

    // Side-by-side button handler
    container.querySelector('.git-sbs-btn')?.addEventListener('click', async () => {
        try {
            const cwd = state.cwd || WidgetManager.currentCwd;
            const resp = await fetch(`${CONFIG.API_BASE}/api/git/file-content?file=${encodeURIComponent(filePath)}&cwd=${encodeURIComponent(cwd)}&staged=${staged || false}`);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            window.DiffViewerWidget?.openWithContent(filePath, data.old, data.new, {
                source: 'git',
                oldLabel: data.oldLabel || 'HEAD',
                newLabel: data.newLabel || (staged ? 'Staged' : 'Working Tree')
            });
        } catch (err) {
            console.error('[GitWidget] Failed to load file content for side-by-side:', err);
        }
    });
}

function renderDiffHunks(hunks) {
    return hunks.map(hunk => `
        <div class="git-hunk">
            <div class="git-hunk-header">${escapeHtml(hunk.header)}</div>
            <div class="git-hunk-lines">
                ${hunk.lines.map(line => renderDiffLine(line)).join('')}
            </div>
        </div>
    `).join('');
}

function renderDiffLine(line) {
    let type = 'context';
    if (line.startsWith('+')) type = 'added';
    else if (line.startsWith('-')) type = 'removed';

    return `<div class="git-diff-line ${type}">${escapeHtml(line) || ' '}</div>`;
}

// ─────────────────────────────────────────────────────────────────────
// History View
// ─────────────────────────────────────────────────────────────────────

function showHistory() {
    const state = getState();
    state.view = 'history';
    state.selectedCommit = null;
    loadHistory(0);
}

function renderHistoryView(container) {
    const state = getState();
    if (state.commits.length === 0) {
        container.innerHTML = '<div class="git-empty">No commits yet</div>';
        return;
    }

    container.innerHTML = `
        <div class="git-history-view">
            <div class="git-history-header">
                <button class="git-back-btn" data-tooltip="Back to Status">${ICONS.back}</button>
                <span class="git-history-title">Commit History</span>
            </div>
            <div class="git-commit-list">
                ${state.commits.map(c => renderCommitItem(c)).join('')}
            </div>
            ${state.hasMoreCommits ? '<button class="git-load-more">Load More</button>' : ''}
        </div>
    `;

    // Event handlers
    container.querySelector('.git-back-btn')?.addEventListener('click', () => {
        state.view = 'status';
        renderContent();
    });

    container.querySelectorAll('.git-commit-item').forEach(item => {
        item.addEventListener('click', () => {
            const hash = item.dataset.hash;
            showCommitDetail(hash);
        });
    });

    container.querySelector('.git-load-more')?.addEventListener('click', () => {
        loadHistory(state.commits.length);
    });
}

function renderCommitItem(commit) {
    const relTime = formatRelativeTime(commit.date);
    const subjectShort = commit.subject.length > 60
        ? commit.subject.slice(0, 60) + '...'
        : commit.subject;

    return `
        <div class="git-commit-item" data-hash="${commit.hash}">
            <div class="git-commit-hash">${escapeHtml(commit.hashShort)}</div>
            <div class="git-commit-info">
                <div class="git-commit-subject">${escapeHtml(subjectShort)}</div>
                <div class="git-commit-meta">
                    <span class="git-commit-author">${escapeHtml(commit.author)}</span>
                    <span class="git-commit-time">${relTime}</span>
                </div>
            </div>
            <span class="git-commit-chevron">${ICONS.chevronRight}</span>
        </div>
    `;
}

// ─────────────────────────────────────────────────────────────────────
// Commit Detail View
// ─────────────────────────────────────────────────────────────────────

async function showCommitDetail(hash) {
    const state = getState();
    state.selectedCommit = hash;
    state.view = 'commit';

    const widget = WidgetManager.get('git');
    const container = (widget?.isVisible ? widget.contentContainer : null) || state.currentContainer;
    if (!container) return;

    container.innerHTML = '<div class="git-loading">Loading commit...</div>';

    const data = await loadCommit(hash);
    if (!data) {
        container.innerHTML = '<div class="git-error">Failed to load commit</div>';
        return;
    }

    renderCommitDetailView(container, data);
}

function renderCommitDetailView(container, data) {
    const state = getState();
    const { commit, files } = data;
    const relTime = formatRelativeTime(commit.timestamp ? new Date(commit.timestamp * 1000).toISOString() : null);

    // Calculate totals
    const totalAdditions = files.reduce((sum, f) => sum + f.additions, 0);
    const totalDeletions = files.reduce((sum, f) => sum + f.deletions, 0);

    // Check if body is long enough to need truncation
    const bodyLines = commit.body ? commit.body.split('\n') : [];
    const needsTruncation = bodyLines.length > 4;

    container.innerHTML = `
        <div class="git-commit-detail">
            <div class="git-commit-detail-header">
                <button class="git-back-btn" data-tooltip="Back to History">${ICONS.back}</button>
                <span class="git-commit-detail-hash">${escapeHtml(commit.hashShort)}</span>
            </div>

            <div class="git-commit-detail-info">
                <div class="git-commit-detail-subject">${escapeHtml(commit.subject)}</div>
                ${commit.body ? `<div class="git-commit-detail-body${needsTruncation ? ' is-truncated' : ''}">${escapeHtml(commit.body)}</div>` : ''}
                ${needsTruncation ? '<button class="git-body-expand-btn">Show more</button>' : ''}
                <div class="git-commit-detail-meta">
                    <span>${escapeHtml(commit.author)}</span>
                    <span>${relTime}</span>
                </div>
            </div>

            <div class="git-commit-files-header">
                <span>${files.length} file${files.length !== 1 ? 's' : ''} changed</span>
                <span class="git-commit-stats">
                    <span class="added">+${totalAdditions}</span>
                    <span class="removed">-${totalDeletions}</span>
                </span>
            </div>

            <div class="git-commit-files">
                ${files.map(f => `
                    <div class="git-commit-file" data-path="${escapeHtml(f.path)}" data-cwd="${escapeHtml(state.cwd || '')}">
                        <span class="git-commit-file-path">${escapeHtml(f.path)}</span>
                        <span class="git-commit-file-right">
                            <span class="git-commit-file-stats">
                                <span class="added">+${f.additions}</span>
                                <span class="removed">-${f.deletions}</span>
                            </span>
                            <button class="git-commit-file-diff-btn" data-path="${escapeHtml(f.path)}" data-tooltip="View diff">${ICONS.code}</button>
                        </span>
                    </div>
                `).join('')}
            </div>
        </div>
    `;

    // Event handlers
    container.querySelector('.git-back-btn')?.addEventListener('click', () => {
        showHistory();
    });

    // Expand/collapse commit body
    container.querySelector('.git-body-expand-btn')?.addEventListener('click', (e) => {
        const body = container.querySelector('.git-commit-detail-body');
        if (body) {
            body.classList.toggle('is-truncated');
            e.target.textContent = body.classList.contains('is-truncated') ? 'Show more' : 'Show less';
        }
    });

    // Per-file diff buttons → open in DiffViewerWidget
    container.querySelectorAll('.git-commit-file-diff-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            openCommitFileDiff(commit.hash, btn.dataset.path);
        });
    });

    // Click file row also opens diff
    container.querySelectorAll('.git-commit-file').forEach(item => {
        item.addEventListener('click', () => {
            openCommitFileDiff(commit.hash, item.dataset.path);
        });
    });
}

async function openCommitFileDiff(commitHash, filePath) {
    const state = getState();
    const cwd = state.cwd || WidgetManager.currentCwd;
    try {
        const resp = await fetch(`${CONFIG.API_BASE}/api/git/file-content?file=${encodeURIComponent(filePath)}&cwd=${encodeURIComponent(cwd)}&commit=${encodeURIComponent(commitHash)}`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        window.DiffViewerWidget?.openWithContent(filePath, data.old, data.new, {
            source: 'git',
            oldLabel: data.oldLabel,
            newLabel: data.newLabel
        });
    } catch (err) {
        console.error('[GitWidget] Failed to open commit file diff:', err);
    }
}


// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────
// Widget Registration
// ─────────────────────────────────────────────────────────────────────

/**
 * Register the Git Widget
 */
export function registerGitWidget() {
    WidgetManager.register('git', {
        type: 'bottom-sheet',
        title: S.widgets.titles.git,
        icon: 'git',
        shortcut: 'Alt+G',

        // Device-specific types
        deviceTypes: {
            default: 'bottom-sheet',
            phone: 'bottom-sheet',
            tablet: 'bottom-sheet',
            desktop: 'sidebar-right' // Sidebar on desktop
        },

        // Heights for bottom-sheet
        heights: {
            half: '45vh',
            full: '85vh'
        },

        // Sidebar width (wider than default for better readability)
        width: '380px',
        minWidth: '280px',
        maxWidth: '600px',

        // Allow transform to these types
        allowedTypes: ['bottom-sheet', 'sidebar-right', 'floating', 'tab'],

        // Custom header actions
        headerActions: [
            {
                icon: 'history',
                title: S.widgets.header_actions.commit_history,
                onClick: () => showHistory()
            },
            {
                icon: 'refresh',
                title: S.widgets.header_actions.refresh,
                onClick: () => refresh()
            }
        ],

        // Render function
        render: (container, ctx) => {
            const state = getState(ctx.sessionId);
            // Store container for tab mode
            state.currentContainer = container;

            // Update state from context, with fallback to active session
            const newCwd = ctx.cwd || window.app?.activeSession?.cwd;
            if (newCwd !== state.cwd) {
                state.cwd = newCwd;
                state.reset();
            }

            // Load status if we have cwd and this is tab mode
            if (ctx.isTab && state.cwd && !state.gitStatus) {
                loadStatus();
            }

            renderContent();
        },

        // Open handler - always refresh on open
        onOpen: () => {
            const state = getState();
            // Fallback to get cwd from active session if not set
            if (!state.cwd && window.app?.activeSession?.cwd) {
                state.cwd = window.app.activeSession.cwd;
            }

            if (state.cwd && !state.loading) {
                refresh();
            }
        },

        // Transform handler
        onTransform: (fromType, toType) => {
            renderContent();
        },

        // Cleanup when session is closed
        onDestroy: (sessionId) => {
            destroyState(sessionId);
        }
    });
}

// ─────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────

/**
 * Public API for external access
 */
export const GitWidget = {
    /**
     * Refresh the current view
     */
    refresh,

    /**
     * Show commit history
     */
    showHistory,

    /**
     * Show diff for a specific file
     */
    showFileDiff,

    /**
     * Show details for a specific commit
     */
    showCommitDetail,

    /**
     * Get current state (for debugging)
     */
    getState: () => ({ ...getState() }),

    /**
     * Destroy state for a session
     */
    destroyState
};
