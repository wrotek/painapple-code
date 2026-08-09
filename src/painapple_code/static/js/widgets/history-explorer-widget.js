/**
 * History Explorer Widget - Development Archaeology Tool
 *
 * Browse, search, and understand shadow git history:
 * - Timeline: Commits grouped by session
 * - Decisions: All architectural decisions made
 * - Problems: Bugs fixed and their solutions
 * - Learnings: Gotchas and discoveries
 * - Files: Per-file history and diffs
 *
 * Phase 1: Read-only exploration (no undo/revert)
 */

import S from '../strings.js';
import { escapeHtml, formatRelativeTime } from '../utils.js';
import { CONFIG } from '../config.js';
import { WidgetManager, ICONS } from '../widget-system/index.js';
import { FilePreviewWidget } from './file-preview-widget.js';
import { ContextMenu } from '../context-menu.js';
import { basename, isAbsolutePath, joinPath } from '../path-utils.js';

// ═══════════════════════════════════════════════════════════════════════════
// State
// ═══════════════════════════════════════════════════════════════════════════

const state = {
    cwd: null,
    sessionId: null,
    activeTab: 'timeline',
    loading: false,
    error: null,

    // Search
    searchQuery: '',
    searchTags: [],
    searchFiles: [],
    currentSessionOnly: localStorage.getItem('he-current-session-only') === 'true',

    // Data
    timeline: { sessions: [], totalCommits: 0 },
    decisions: [],
    problems: [],
    learnings: [],
    tags: { tags: [], recentTags: [], total: 0 },
    tagCommits: [],  // commits for selected tag
    selectedTag: null,
    facets: { tags: [], files: [] },
    allFiles: [],  // All files from shadow git

    // Expanded items
    expandedSessions: new Set(),
    expandedCommits: new Set(),
    loadedDiffs: {},  // commitHash -> diff data

    // Files view
    selectedFile: null,
    fileHistory: [],
    fileCompare: { from: null, to: 'HEAD' },
    filesSearchQuery: '',
    filesViewMode: localStorage.getItem('he-files-view-mode') || 'tree',  // default to tree
    expandedDirs: new Set(),  // For tree view


    // Container ref
    container: null,
};

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get current session ID for filtering.
 * Uses storeId (bridge session ID like "K_6Mc0diEz8") which matches shadow git.
 * Returns null if no active session or filter is disabled.
 */
function getCurrentSessionId() {
    if (!state.currentSessionOnly) return null;
    // Use storeId (bridge session ID), NOT providerSessionId (Claude's UUID)
    // Shadow git stores bridge session IDs in commits
    return window.app?.activeSession?.storeId || null;
}

/**
 * Check if a session ID matches the current session.
 * Handles backwards compatibility with old truncated 8-char IDs.
 *
 * @param {string} sessionId - The session ID from shadow git (may be 8 or 11 chars)
 * @param {string} currentId - The current session ID (always 11 chars)
 */
function sessionIdsMatch(sessionId, currentId) {
    if (!sessionId || !currentId) return false;
    // Exact match (both full IDs)
    if (sessionId === currentId) return true;
    // Old truncated ID is prefix of current full ID
    if (currentId.startsWith(sessionId)) return true;
    // Current ID is prefix of timeline ID (shouldn't happen, but safe)
    if (sessionId.startsWith(currentId)) return true;
    return false;
}

// File-type → icon mapping. Mirrors file-explorer-widget so tree styling stays
// consistent across both widgets.
const FILE_TYPES = {
    code: {
        extensions: ['.js', '.ts', '.jsx', '.tsx', '.py', '.rb', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.hpp', '.cs', '.php', '.swift', '.kt', '.scala', '.vue', '.svelte', '.css', '.scss', '.sass', '.less', '.html', '.xml', '.json', '.yaml', '.yml', '.toml', '.sh', '.bash', '.zsh', '.fish', '.sql', '.graphql', '.proto'],
        icon: 'code',
        color: 'var(--accent-blue)',
    },
    images: {
        extensions: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.bmp', '.tiff', '.heic', '.avif'],
        icon: 'image',
        color: 'var(--accent-purple)',
    },
    docs: {
        extensions: ['.md', '.markdown', '.mdx', '.txt', '.doc', '.docx', '.pdf', '.rtf', '.tex', '.org', '.rst'],
        icon: 'file-text',
        color: 'var(--accent-green)',
    },
    data: {
        extensions: ['.csv', '.tsv', '.xls', '.xlsx', '.db', '.sqlite', '.parquet', '.arrow'],
        icon: 'table',
        color: 'var(--accent-orange)',
    },
    config: {
        extensions: ['.env', '.gitignore', '.dockerignore', '.editorconfig', '.eslintrc', '.prettierrc', '.babelrc', 'Makefile', 'Dockerfile', '.npmrc', '.nvmrc'],
        icon: 'settings',
        color: 'var(--text-tertiary)',
    },
    archive: {
        extensions: ['.zip', '.tar', '.gz', '.bz2', '.xz', '.7z', '.rar'],
        icon: 'archive',
        color: 'var(--accent-yellow)',
    },
};

function getFileType(filename) {
    const lower = filename.toLowerCase();
    for (const config of Object.values(FILE_TYPES)) {
        if (config.extensions.some(ext => lower.endsWith(ext) || lower === ext.slice(1))) {
            return config;
        }
    }
    return { icon: 'file', color: 'var(--text-secondary)' };
}

function fileIconHtml(filename) {
    const t = getFileType(filename);
    return `<span class="he-file-icon" style="color: ${t.color}">${ICONS[t.icon] || ICONS.file}</span>`;
}

function treeFileIconHtml(filename) {
    const t = getFileType(filename);
    return `<span class="he-tree-icon" style="color: ${t.color}">${ICONS[t.icon] || ICONS.file}</span>`;
}

const TREE_CHEVRON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 6 15 12 9 18"/></svg>';

// ═══════════════════════════════════════════════════════════════════════════
// API Calls
// ═══════════════════════════════════════════════════════════════════════════

async function fetchTimeline() {
    if (!state.cwd) return;

    try {
        const url = `${CONFIG.API_BASE}/api/shadow/timeline?cwd=${encodeURIComponent(state.cwd)}&limit=100`;
        const res = await fetch(url);
        const data = await res.json();

        state.timeline = {
            sessions: data.sessions || [],
            totalCommits: data.totalCommits || 0,
        };
    } catch (err) {
        console.error('Timeline fetch error:', err);
        state.error = err.message;
    }
}

async function fetchDecisions() {
    if (!state.cwd) return;

    try {
        const url = `${CONFIG.API_BASE}/api/shadow/decisions?cwd=${encodeURIComponent(state.cwd)}&limit=100`;
        const res = await fetch(url);
        const data = await res.json();
        state.decisions = data.decisions || [];
    } catch (err) {
        console.error('Decisions fetch error:', err);
    }
}

async function fetchProblems() {
    if (!state.cwd) return;

    try {
        const url = `${CONFIG.API_BASE}/api/shadow/problems?cwd=${encodeURIComponent(state.cwd)}&limit=100`;
        const res = await fetch(url);
        const data = await res.json();
        state.problems = data.problems || [];
    } catch (err) {
        console.error('Problems fetch error:', err);
    }
}

async function fetchLearnings() {
    if (!state.cwd) return;

    try {
        const url = `${CONFIG.API_BASE}/api/shadow/learnings?cwd=${encodeURIComponent(state.cwd)}&limit=100`;
        const res = await fetch(url);
        const data = await res.json();
        state.learnings = data.learnings || [];
    } catch (err) {
        console.error('Learnings fetch error:', err);
    }
}

async function fetchAllFiles() {
    if (!state.cwd) return;

    try {
        const url = `${CONFIG.API_BASE}/api/shadow/files?cwd=${encodeURIComponent(state.cwd)}`;
        const res = await fetch(url);
        const data = await res.json();
        state.allFiles = data.files || [];
    } catch (err) {
        console.error('Files fetch error:', err);
    }
}

async function fetchCommitDiff(hash) {
    if (!state.cwd || state.loadedDiffs[hash]) return state.loadedDiffs[hash];

    try {
        const url = `${CONFIG.API_BASE}/api/shadow/commits/${hash}/diff?cwd=${encodeURIComponent(state.cwd)}`;
        const res = await fetch(url);
        const data = await res.json();
        state.loadedDiffs[hash] = data;
        return data;
    } catch (err) {
        console.error('Diff fetch error:', err);
        return null;
    }
}

async function openInDiffTool(commitHash, filePath) {
    if (!commitHash || !filePath || !state.cwd) return;
    const fullPath = isAbsolutePath(filePath) ? filePath : joinPath(state.cwd, filePath);
    await window.app?.previewFileWithHistory(fullPath, {
        cwd: state.cwd,
        seed: { toKind: 'snapshot', toHash: commitHash, fromKind: 'auto' }
    });
}

async function previewFileAtHead(relPath) {
    if (!state.cwd || !relPath) return;
    const fullPath = isAbsolutePath(relPath) ? relPath : joinPath(state.cwd, relPath);
    FilePreviewWidget.setCwd(state.cwd);
    await FilePreviewWidget.preview(fullPath);
}

async function fetchTags() {
    if (!state.cwd) return;

    try {
        const url = `${CONFIG.API_BASE}/api/shadow/tags?cwd=${encodeURIComponent(state.cwd)}&limit=100`;
        const res = await fetch(url);
        const data = await res.json();
        state.tags = {
            tags: data.tags || [],
            recentTags: data.recentTags || [],
            total: data.total || 0
        };
    } catch (err) {
        console.error('Tags fetch error:', err);
        state.error = err.message;
    }
}

async function fetchTagCommits(tag) {
    if (!state.cwd) return;

    try {
        const url = `${CONFIG.API_BASE}/api/shadow/tags/${encodeURIComponent(tag)}/commits?cwd=${encodeURIComponent(state.cwd)}&limit=50`;
        const res = await fetch(url);
        const data = await res.json();
        state.tagCommits = data.commits || [];
        state.selectedTag = tag;
    } catch (err) {
        console.error('Tag commits fetch error:', err);
        state.tagCommits = [];
    }
}

async function fetchFileHistory(filePath) {
    if (!state.cwd) return;

    try {
        const url = `${CONFIG.API_BASE}/api/shadow/files/${encodeURIComponent(filePath)}/history?cwd=${encodeURIComponent(state.cwd)}`;
        const res = await fetch(url);
        const data = await res.json();
        state.fileHistory = data.commits || [];
    } catch (err) {
        console.error('File history error:', err);
        state.fileHistory = [];
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Rendering
// ═══════════════════════════════════════════════════════════════════════════

function render() {
    if (!state.container) return;

    // Preserve scroll position
    const content = state.container.querySelector('.he-content');
    const scrollTop = content?.scrollTop || 0;

    const html = `
        <div class="he-container">
            ${renderSearchBar()}
            ${renderTabs()}
            <div class="he-content">
                ${state.loading ? renderLoading() : renderActiveTab()}
            </div>
        </div>
    `;

    state.container.innerHTML = html;
    attachEventListeners();

    // Restore scroll position
    const newContent = state.container.querySelector('.he-content');
    if (newContent && scrollTop > 0) {
        newContent.scrollTop = scrollTop;
    }
}

function renderSearchBar() {
    // Get bridge session ID (storeId) for filtering - this matches shadow git
    const currentStoreId = window.app?.activeSession?.storeId;
    // Show filter on all content tabs
    const canFilterBySession = currentStoreId && state.activeTab !== 'search';

    return `
        <div class="he-search-bar">
            <input type="text"
                   class="he-search-input"
                   placeholder="Search history... (tags: #feature, #bugfix)"
                   value="${escapeHtml(state.searchQuery)}"
                   data-action="search">
            ${canFilterBySession ? `
                <label class="he-session-filter">
                    <input type="checkbox"
                           class="he-session-checkbox"
                           data-action="toggle-session-filter"
                           ${state.currentSessionOnly ? 'checked' : ''}>
                    <span>Current session only</span>
                </label>
            ` : ''}
            ${state.searchTags.length ? `
                <div class="he-filter-pills">
                    ${state.searchTags.map(tag => `
                        <span class="he-pill" data-action="remove-tag" data-tag="${escapeHtml(tag)}">
                            ${escapeHtml(tag)} ×
                        </span>
                    `).join('')}
                    <span class="he-pill he-pill-clear" data-action="clear-filters">Clear</span>
                </div>
            ` : ''}
        </div>
    `;
}

function renderTabs() {
    const _ht = S.widgets.history_explorer.tabs;
    const tabs = [
        { id: 'timeline', label: _ht.timeline, icon: 'history' },
        { id: 'files', label: _ht.files, icon: 'file' },
        { id: 'tags', label: _ht.tags, icon: 'tag' },
        { id: 'decisions', label: _ht.decisions, icon: 'lightbulb' },
        { id: 'problems', label: _ht.problems, icon: 'bug' },
        { id: 'learnings', label: _ht.learnings, icon: 'book' },
    ];

    return `
        <div class="he-tabs">
            ${tabs.map(tab => `
                <button class="he-tab ${state.activeTab === tab.id ? 'active' : ''}"
                        data-action="switch-tab"
                        data-tab="${tab.id}">
                    ${tab.label}
                </button>
            `).join('')}
        </div>
    `;
}

function renderLoading() {
    return `
        <div class="he-loading">
            <div class="he-spinner"></div>
            <span>Loading...</span>
        </div>
    `;
}

function renderActiveTab() {
    switch (state.activeTab) {
        case 'timeline': return renderTimeline();
        case 'tags': return renderTags();
        case 'decisions': return renderDecisions();
        case 'problems': return renderProblems();
        case 'learnings': return renderLearnings();
        case 'files': return renderFiles();
        default: return renderTimeline();
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Timeline View
// ─────────────────────────────────────────────────────────────────────────────

function renderTimeline() {
    if (state.timeline.sessions.length === 0) {
        return renderEmpty('No commits yet', 'Shadow git will track your changes as you work.');
    }

    // Filter by current session if enabled
    let sessions = state.timeline.sessions;
    let totalCommits = state.timeline.totalCommits;
    const filterSession = getCurrentSessionId();

    if (filterSession) {
        sessions = sessions.filter(s => sessionIdsMatch(s.sessionId, filterSession));
        totalCommits = sessions.reduce((sum, s) => sum + (s.commits?.length || s.turnCount || 0), 0);

        if (sessions.length === 0) {
            return renderEmpty('No history for this session', 'This session has no shadow git commits yet.');
        }
    }

    // Group sessions by date
    const sessionsByDate = groupSessionsByDate(sessions);

    const filterNote = filterSession
        ? ` <span class="he-filter-active">(current session)</span>`
        : '';

    return `
        <div class="he-timeline">
            <div class="he-stats">
                ${totalCommits} commits across ${sessions.length} session${sessions.length !== 1 ? 's' : ''}${filterNote}
            </div>
            ${Object.entries(sessionsByDate).map(([date, dateSessions]) => `
                <div class="he-date-group">
                    <div class="he-date-header">${escapeHtml(date)}</div>
                    ${dateSessions.map(renderSessionGroup).join('')}
                </div>
            `).join('')}
        </div>
    `;
}

function groupSessionsByDate(sessions) {
    const groups = {};
    const today = new Date().toDateString();
    const yesterday = new Date(Date.now() - 86400000).toDateString();

    for (const session of sessions) {
        // Use lastTimestamp or firstTimestamp
        const timestamp = session.lastTimestamp || session.firstTimestamp;
        if (!timestamp) {
            // No timestamp, group under "Unknown"
            if (!groups['Unknown']) groups['Unknown'] = [];
            groups['Unknown'].push(session);
            continue;
        }

        const date = new Date(timestamp);
        const dateStr = date.toDateString();
        let label;

        if (dateStr === today) {
            label = 'Today';
        } else if (dateStr === yesterday) {
            label = 'Yesterday';
        } else {
            label = date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
        }

        if (!groups[label]) groups[label] = [];
        groups[label].push(session);
    }

    return groups;
}

function renderSessionGroup(session) {
    const isExpanded = state.expandedSessions.has(session.sessionId);
    const title = session.title || `Session ${session.sessionId}`;
    const cost = session.totalCost?.toFixed(3) || '0.000';

    // Format time from timestamp
    const timestamp = session.lastTimestamp || session.firstTimestamp;
    const timeStr = timestamp ? formatSessionTime(timestamp) : '';

    return `
        <div class="he-session ${isExpanded ? 'expanded' : ''}">
            <div class="he-session-header" data-action="toggle-session" data-session="${escapeHtml(session.sessionId)}">
                <span class="he-session-toggle">${isExpanded ? '▼' : '▶'}</span>
                <div class="he-session-info">
                    <div class="he-session-title-row">
                        <span class="he-session-title">${escapeHtml(title.split('\n')[0])}</span>
                        ${timeStr ? `<span class="he-session-time">${timeStr}</span>` : ''}
                    </div>
                    <div class="he-session-meta">
                        ${session.turnCount} turns
                        ${session.files?.length ? ` • ${session.files.length} ${session.files.length === 1 ? 'file' : 'files'}` : ''}
                        • $${cost}
                        ${session.tags?.slice(0, 3).map(t => `<span class="he-tag">${escapeHtml(t)}</span>`).join('') || ''}
                    </div>
                </div>
            </div>
            ${isExpanded ? `
                <div class="he-session-commits">
                    ${session.commits.map(renderCommitCard).join('')}
                </div>
            ` : ''}
        </div>
    `;
}

function formatSessionTime(timestamp) {
    const date = new Date(timestamp);
    return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

function formatCommitTime(timestamp) {
    if (!timestamp) return '';
    const date = new Date(timestamp);
    return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

function renderCommitCard(commit) {
    const isExpanded = state.expandedCommits.has(commit.hashShort);
    const diff = state.loadedDiffs[commit.hashShort];
    const timeStr = formatCommitTime(commit.timestamp);

    return `
        <div class="he-commit ${isExpanded ? 'expanded' : ''}">
            <div class="he-commit-header" data-action="toggle-commit" data-hash="${escapeHtml(commit.hashShort)}">
                <div class="he-commit-turn">T${commit.turn || '?'}</div>
                <div class="he-commit-info">
                    <div class="he-commit-summary">${escapeHtml(commit.sections?.Summary || commit.summary || commit.subject || 'No summary')}</div>
                    <div class="he-commit-meta">
                        ${commit.tags?.slice(0, 3).map(t => `<span class="he-tag">${escapeHtml(t)}</span>`).join('') || ''}
                        ${commit.files?.length ? `<span class="he-file-count">${commit.files.length} files</span>` : ''}
                        ${commit.cost ? `<span class="he-cost">$${commit.cost.toFixed(4)}</span>` : ''}
                    </div>
                </div>
                ${timeStr ? `<span class="he-commit-time">${timeStr}</span>` : ''}
                <span class="he-expand-icon">${isExpanded ? '▲' : '▼'}</span>
            </div>
            ${isExpanded ? renderCommitDetails(commit, diff) : ''}
        </div>
    `;
}

function renderCommitDetails(commit, diff) {
    return `
        <div class="he-commit-details">
            ${diff?.files?.length ? `
                <div class="he-files-changed">
                    <div class="he-section-title">Files Changed</div>
                    ${diff.files.map(file => renderFileDiff(file, commit.hashShort)).join('')}
                </div>
            ` : (commit.files?.length ? `
                <div class="he-files-list">
                    <div class="he-section-title">Files Changed</div>
                    ${commit.files.map(f => `<div class="he-file-item">${escapeHtml(f)}</div>`).join('')}
                </div>
            ` : '')}

            <div class="he-commit-footer">
                <span class="he-hash" data-action="copy-hash" data-hash="${escapeHtml(commit.hash || commit.hashShort)}">${escapeHtml(commit.hashShort)}</span>
                ${commit.tokensIn ? `<span class="he-tokens">↓${(commit.tokensIn/1000).toFixed(1)}k ↑${(commit.tokensOut/1000).toFixed(1)}k</span>` : ''}
            </div>
        </div>
    `;
}

function renderFileDiff(file, commitHash) {
    return `
        <div class="he-file-diff he-file-diff-clickable"
             data-action="open-diff-tool"
             data-hash="${escapeHtml(commitHash)}"
             data-path="${escapeHtml(file.path)}"
             data-tooltip="${escapeHtml(S.history_explorer?.open_in_diff_tool || 'Open in diff tool')}">
            ${fileIconHtml(basename(file.path))}
            <span class="he-file-path">${escapeHtml(file.path)}</span>
            <span class="he-file-stats">
                <span class="he-additions">+${file.additions}</span>
                <span class="he-deletions">-${file.deletions}</span>
            </span>
            <span class="he-diff-tool-icon">${ICONS.changes}</span>
        </div>
    `;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tags View
// ─────────────────────────────────────────────────────────────────────────────

function renderTags() {
    // If a tag is selected, show its commits
    if (state.selectedTag) {
        return renderTagCommits();
    }

    const filterSession = getCurrentSessionId();
    let tags = state.tags.tags;
    let recentTags = state.tags.recentTags;

    // Filter to tags from current session
    if (filterSession) {
        const sessionData = state.timeline.sessions.find(s => sessionIdsMatch(s.sessionId, filterSession));
        if (sessionData?.tags) {
            const sessionTags = new Set(sessionData.tags);
            tags = tags.filter(t => sessionTags.has(t.name));
            recentTags = recentTags.filter(t => sessionTags.has(t));
        } else {
            tags = [];
            recentTags = [];
        }
    }

    if (tags.length === 0 && !filterSession) {
        return renderEmpty('No tags found', 'Tags are extracted from commits. Rich commits include auto-generated tags like #feature, #bugfix, etc.');
    }

    if (tags.length === 0 && filterSession) {
        return renderEmpty('No tags in this session', 'This session has no tagged commits yet.');
    }

    const filterNote = filterSession ? ' <span class="he-filter-active">(current session)</span>' : '';

    return `
        <div class="he-tags-view">
            ${recentTags.length > 0 ? `
                <div class="he-tags-section">
                    <div class="he-section-header">
                        <span class="he-section-icon">🔥</span>
                        <span>Recent Activity</span>
                    </div>
                    <div class="he-tag-cloud">
                        ${recentTags.map(tagName => {
                            const tag = tags.find(t => t.name === tagName);
                            return tag ? renderTagPill(tag, true) : '';
                        }).join('')}
                    </div>
                </div>
            ` : ''}

            <div class="he-tags-section">
                <div class="he-section-header">
                    <span class="he-section-icon">🏷️</span>
                    <span>All Tags (${tags.length})${filterNote}</span>
                </div>
                <div class="he-tag-list">
                    ${tags.map(tag => renderTagRow(tag)).join('')}
                </div>
            </div>
        </div>
    `;
}

function renderTagPill(tag, highlight = false) {
    return `
        <button class="he-tag-pill ${highlight ? 'recent' : ''}"
                data-action="select-tag"
                data-tag="${escapeHtml(tag.name)}"
                data-tooltip="${tag.count} commits">
            <span class="he-tag-name">${escapeHtml(tag.name)}</span>
            <span class="he-tag-count">${tag.count}</span>
        </button>
    `;
}

function renderTagRow(tag) {
    const lastSeen = tag.lastSeen ? formatRelativeTime(new Date(tag.lastSeen * 1000)) : 'unknown';
    const firstSeen = tag.firstSeen ? formatRelativeTime(new Date(tag.firstSeen * 1000)) : 'unknown';

    // Visual bar showing relative usage
    const maxCount = state.tags.tags[0]?.count || 1;
    const barWidth = Math.max(5, Math.round((tag.count / maxCount) * 100));

    return `
        <div class="he-tag-row" data-action="select-tag" data-tag="${escapeHtml(tag.name)}">
            <div class="he-tag-row-main">
                <span class="he-tag-name-lg">${escapeHtml(tag.name)}</span>
                <span class="he-tag-count-lg">${tag.count}</span>
            </div>
            <div class="he-tag-bar-container">
                <div class="he-tag-bar" style="width: ${barWidth}%"></div>
            </div>
            <div class="he-tag-meta">
                ${tag.recentCount > 0 ? `<span class="he-tag-recent">🔥 ${tag.recentCount} recent</span>` : ''}
                <span class="he-tag-timespan">Last: ${lastSeen}</span>
            </div>
        </div>
    `;
}

function renderTagCommits() {
    const tag = state.selectedTag;

    return `
        <div class="he-tag-commits">
            <div class="he-tag-commits-header">
                <button class="he-back-btn" data-action="clear-tag">
                    ← Back to tags
                </button>
                <div class="he-tag-title">
                    <span class="he-tag-pill selected">${escapeHtml(tag)}</span>
                    <span class="he-tag-commit-count">${state.tagCommits.length} commits</span>
                </div>
            </div>
            <div class="he-tag-commits-list">
                ${state.tagCommits.length === 0
                    ? '<div class="he-empty-small">No commits found with this tag</div>'
                    : state.tagCommits.map(commit => renderTagCommitCard(commit)).join('')
                }
            </div>
        </div>
    `;
}

function renderTagCommitCard(commit) {
    const isExpanded = state.expandedCommits.has(commit.hash);
    const summary = commit.summary || commit.subject || 'No summary';
    const timestamp = commit.timestamp ? formatRelativeTime(new Date(commit.timestamp)) : '';

    return `
        <div class="he-commit-card ${isExpanded ? 'expanded' : ''}">
            <div class="he-commit-header" data-action="toggle-commit" data-hash="${commit.hash}">
                <span class="he-commit-toggle">${isExpanded ? '▼' : '▶'}</span>
                <div class="he-commit-info">
                    <div class="he-commit-summary">${escapeHtml(summary.slice(0, 100))}</div>
                    <div class="he-commit-meta">
                        <span class="he-commit-hash">${commit.hashShort}</span>
                        <span class="he-commit-time">${timestamp}</span>
                        ${commit.cost ? `<span class="he-commit-cost">$${commit.cost.toFixed(3)}</span>` : ''}
                    </div>
                </div>
            </div>
            ${isExpanded ? `
                <div class="he-commit-body">
                    <div class="he-commit-tags">
                        ${(commit.tags || []).map(t => `
                            <span class="he-tag ${t === state.selectedTag ? 'current' : ''}"
                                  data-action="select-tag"
                                  data-tag="${escapeHtml(t)}">${escapeHtml(t)}</span>
                        `).join('')}
                    </div>
                    ${commit.sections?.Summary ? `
                        <div class="he-commit-section">
                            <div class="he-section-title">Summary</div>
                            <div class="he-section-content">${escapeHtml(commit.sections.Summary)}</div>
                        </div>
                    ` : ''}
                    ${commit.files?.length ? `
                        <div class="he-commit-section">
                            <div class="he-section-title">Files Changed</div>
                            <div class="he-file-list">
                                ${commit.files.map(f => `
                                    <span class="he-file he-file-clickable"
                                          data-action="open-diff-tool"
                                          data-hash="${escapeHtml(commit.hash)}"
                                          data-path="${escapeHtml(f)}"
                                          data-tooltip="${escapeHtml(S.history_explorer?.open_in_diff_tool || 'Open in diff tool')}">
                                        ${escapeHtml(f)}
                                        <span class="he-file-chip-icon">${ICONS.changes}</span>
                                    </span>
                                `).join('')}
                            </div>
                        </div>
                    ` : ''}
                </div>
            ` : ''}
        </div>
    `;
}

// ─────────────────────────────────────────────────────────────────────────────
// Decisions View
// ─────────────────────────────────────────────────────────────────────────────

function renderDecisions() {
    const filterSession = getCurrentSessionId();
    let decisions = state.decisions;

    if (filterSession) {
        decisions = decisions.filter(d => sessionIdsMatch(d.sessionId, filterSession));
    }

    if (decisions.length === 0 && !filterSession) {
        return renderEmpty('No decisions recorded', 'Decisions are extracted from "## Decisions" sections in rich commits.');
    }

    if (decisions.length === 0 && filterSession) {
        return renderEmpty('No decisions in this session', 'This session has no recorded decisions.');
    }

    const filterNote = filterSession ? ' <span class="he-filter-active">(current session)</span>' : '';

    return `
        <div class="he-decisions">
            <div class="he-stats">${decisions.length} decisions recorded${filterNote}</div>
            ${decisions.map(renderDecisionCard).join('')}
        </div>
    `;
}

function renderDecisionCard(decision) {
    return `
        <div class="he-decision-card">
            <div class="he-decision-header">
                <span class="he-decision-icon">🔷</span>
                <span class="he-decision-summary">${escapeHtml(decision.summary || 'Decision')}</span>
                <span class="he-decision-turn">T${decision.turn}</span>
            </div>
            <div class="he-decision-content">${formatMarkdown(decision.content)}</div>
            <div class="he-decision-meta">
                ${decision.tags?.map(t => `<span class="he-tag">${escapeHtml(t)}</span>`).join('') || ''}
                <span class="he-hash" data-action="copy-hash" data-hash="${escapeHtml(decision.commitHash)}">${escapeHtml(decision.commitHash)}</span>
            </div>
        </div>
    `;
}

// ─────────────────────────────────────────────────────────────────────────────
// Problems View
// ─────────────────────────────────────────────────────────────────────────────

function renderProblems() {
    const filterSession = getCurrentSessionId();
    let problems = state.problems;

    if (filterSession) {
        problems = problems.filter(p => sessionIdsMatch(p.sessionId, filterSession));
    }

    if (problems.length === 0 && !filterSession) {
        return renderEmpty('No problems recorded', 'Problems are extracted from "## Problems Solved" sections in rich commits.');
    }

    if (problems.length === 0 && filterSession) {
        return renderEmpty('No problems in this session', 'This session has no recorded problems.');
    }

    const filterNote = filterSession ? ' <span class="he-filter-active">(current session)</span>' : '';

    return `
        <div class="he-problems">
            <div class="he-stats">${problems.length} problems solved${filterNote}</div>
            ${problems.map(renderProblemCard).join('')}
        </div>
    `;
}

function renderProblemCard(problem) {
    return `
        <div class="he-problem-card">
            <div class="he-problem-header">
                <span class="he-problem-icon">🐛</span>
                <span class="he-problem-summary">${escapeHtml(problem.summary || 'Bug fix')}</span>
                <span class="he-problem-turn">T${problem.turn}</span>
            </div>
            <div class="he-problem-content">${formatMarkdown(problem.content)}</div>
            <div class="he-problem-meta">
                ${problem.files?.slice(0, 3).map(f => `<span class="he-file-chip">${escapeHtml(f)}</span>`).join('') || ''}
                ${problem.tags?.map(t => `<span class="he-tag">${escapeHtml(t)}</span>`).join('') || ''}
            </div>
        </div>
    `;
}

// ─────────────────────────────────────────────────────────────────────────────
// Learnings View
// ─────────────────────────────────────────────────────────────────────────────

function renderLearnings() {
    const filterSession = getCurrentSessionId();
    let learnings = state.learnings;

    if (filterSession) {
        learnings = learnings.filter(l => sessionIdsMatch(l.sessionId, filterSession));
    }

    if (learnings.length === 0 && !filterSession) {
        return renderEmpty('No learnings recorded', 'Learnings are extracted from "## Learnings" sections in rich commits.');
    }

    if (learnings.length === 0 && filterSession) {
        return renderEmpty('No learnings in this session', 'This session has no recorded learnings.');
    }

    const filterNote = filterSession ? ' <span class="he-filter-active">(current session)</span>' : '';

    return `
        <div class="he-learnings">
            <div class="he-stats">${learnings.length} learnings captured${filterNote}</div>
            ${learnings.map(renderLearningCard).join('')}
        </div>
    `;
}

function renderLearningCard(learning) {
    return `
        <div class="he-learning-card">
            <div class="he-learning-header">
                <span class="he-learning-icon">💡</span>
                <span class="he-learning-summary">${escapeHtml(learning.summary || 'Learning')}</span>
            </div>
            <div class="he-learning-content">${formatMarkdown(learning.content)}</div>
            <div class="he-learning-meta">
                ${learning.tags?.map(t => `<span class="he-tag">${escapeHtml(t)}</span>`).join('') || ''}
            </div>
        </div>
    `;
}

// ─────────────────────────────────────────────────────────────────────────────
// Files View
// ─────────────────────────────────────────────────────────────────────────────

function renderFiles() {
    // Use pre-fetched file list from /api/shadow/files
    let allFiles = state.allFiles;
    const filterSession = getCurrentSessionId();

    // Filter to files touched by current session
    if (filterSession) {
        const sessionData = state.timeline.sessions.find(s => sessionIdsMatch(s.sessionId, filterSession));
        if (sessionData?.files) {
            // files is an array of files touched by this session
            const sessionFiles = new Set(sessionData.files);
            allFiles = allFiles.filter(f => sessionFiles.has(f));
        } else {
            allFiles = [];
        }
    }

    if (allFiles.length === 0 && !filterSession) {
        return renderEmpty('No files tracked', 'Files will appear here as they are modified.');
    }

    if (allFiles.length === 0 && filterSession) {
        return renderEmpty('No files in this session', 'This session has not modified any files yet.');
    }

    if (state.selectedFile) {
        return renderFileHistory();
    }

    // Filter files by search query
    let filteredFiles = allFiles;
    if (state.filesSearchQuery) {
        const query = state.filesSearchQuery.toLowerCase();
        filteredFiles = allFiles.filter(f => f.toLowerCase().includes(query));
    }

    return `
        <div class="he-files">
            <div class="he-files-toolbar">
                <div class="he-files-search">
                    <input type="text"
                           class="he-files-search-input"
                           placeholder="Search files..."
                           value="${escapeHtml(state.filesSearchQuery)}"
                           data-action="files-search">
                    ${state.filesSearchQuery ? `
                        <button class="he-files-search-clear" data-action="clear-files-search">×</button>
                    ` : ''}
                </div>
                <div class="he-files-view-toggle">
                    <button class="he-view-btn ${state.filesViewMode === 'list' ? 'active' : ''}"
                            data-action="set-files-view" data-view="list" data-tooltip="List view">
                        ☰
                    </button>
                    <button class="he-view-btn ${state.filesViewMode === 'tree' ? 'active' : ''}"
                            data-action="set-files-view" data-view="tree" data-tooltip="Tree view">
                        🌲
                    </button>
                </div>
            </div>
            <div class="he-stats">
                ${filteredFiles.length}${state.filesSearchQuery ? ` of ${allFiles.length}` : ''} files${filterSession ? ' <span class="he-filter-active">(current session)</span>' : ''}
            </div>
            ${state.filesViewMode === 'tree'
                ? renderFileTree(filteredFiles)
                : renderFileList(filteredFiles)
            }
        </div>
    `;
}

function renderFileList(files) {
    const previewLabel = S.history_explorer?.preview_file || 'Preview file';
    return `
        <div class="he-file-list">
            ${files.map(f => `
                <div class="he-file-row" data-action="select-file" data-path="${escapeHtml(f)}">
                    ${fileIconHtml(basename(f))}
                    <span class="he-file-name">${escapeHtml(f)}</span>
                    <span class="he-file-preview-icon"
                          data-action="preview-file"
                          data-path="${escapeHtml(f)}"
                          data-tooltip="${escapeHtml(previewLabel)}">
                        ${ICONS.eye}
                    </span>
                </div>
            `).join('')}
        </div>
    `;
}

function renderFileTree(files) {
    // Build tree structure from file paths
    const tree = {};
    files.forEach(filePath => {
        const parts = filePath.split('/');
        let node = tree;
        parts.forEach((part, i) => {
            if (i === parts.length - 1) {
                // File
                node[part] = { __isFile: true, __path: filePath };
            } else {
                // Directory
                if (!node[part]) {
                    node[part] = { __isDir: true };
                }
                node = node[part];
            }
        });
    });

    return `<div class="he-file-tree">${renderTreeNode(tree, '')}</div>`;
}

function renderTreeNode(node, path) {
    const entries = Object.entries(node)
        .filter(([k]) => !k.startsWith('__'))
        .sort((a, b) => {
            // Directories first, then files
            const aIsDir = a[1].__isDir;
            const bIsDir = b[1].__isDir;
            if (aIsDir && !bIsDir) return -1;
            if (!aIsDir && bIsDir) return 1;
            return a[0].localeCompare(b[0]);
        });

    const previewLabel = S.history_explorer?.preview_file || 'Preview file';
    return entries.map(([name, child]) => {
        if (child.__isFile) {
            return `
                <div class="he-tree-file" data-action="select-file" data-path="${escapeHtml(child.__path)}">
                    <span class="he-tree-spacer"></span>
                    ${treeFileIconHtml(name)}
                    <span class="he-tree-name">${escapeHtml(name)}</span>
                    <span class="he-file-preview-icon"
                          data-action="preview-file"
                          data-path="${escapeHtml(child.__path)}"
                          data-tooltip="${escapeHtml(previewLabel)}">
                        ${ICONS.eye}
                    </span>
                </div>
            `;
        } else {
            const dirPath = path ? joinPath(path, name) : name;
            const isExpanded = state.expandedDirs.has(dirPath);
            return `
                <div class="he-tree-dir ${isExpanded ? 'expanded' : ''}">
                    <div class="he-tree-dir-header" data-action="toggle-dir" data-path="${escapeHtml(dirPath)}">
                        <span class="he-tree-chevron ${isExpanded ? 'expanded' : ''}">${TREE_CHEVRON_SVG}</span>
                        <span class="he-tree-icon" style="color: var(--accent-yellow)">${ICONS.folder}</span>
                        <span class="he-tree-name">${escapeHtml(name)}</span>
                    </div>
                    ${isExpanded ? `
                        <div class="he-tree-children">
                            ${renderTreeNode(child, dirPath)}
                        </div>
                    ` : ''}
                </div>
            `;
        }
    }).join('');
}

function renderFileHistory() {
    const history = state.fileHistory;
    const totalAdditions = history.reduce((sum, c) => sum + (c.additions || 0), 0);
    const totalDeletions = history.reduce((sum, c) => sum + (c.deletions || 0), 0);

    const commitsByDate = groupCommitsByDate(history);

    return `
        <div class="he-file-history">
            ${renderFileHistoryHeader(totalAdditions, totalDeletions)}
            <div class="he-file-commits">
                ${history.length === 0 ? '<div class="he-empty-text">No history found for this file</div>' :
                    Object.entries(commitsByDate).map(([date, commits]) => `
                        <div class="he-date-group">
                            <div class="he-date-header">${escapeHtml(date)}</div>
                            ${commits.map(renderFileCommitCard).join('')}
                        </div>
                    `).join('')
                }
            </div>
        </div>
    `;
}

function renderFileHistoryHeader(totalAdditions, totalDeletions) {
    const fileName = basename(state.selectedFile);
    const dirPath = state.selectedFile.includes('/')
        ? state.selectedFile.slice(0, state.selectedFile.lastIndexOf('/'))
        : '';
    const previewLabel = S.history_explorer?.preview_file || 'Preview file';

    return `
        <div class="he-file-history-header">
            <button class="he-back-btn" data-action="clear-file" data-tooltip="Back to files">←</button>
            <div class="he-file-path-info">
                ${dirPath ? `<span class="he-file-dir">${escapeHtml(dirPath)}/</span>` : ''}
                <span class="he-file-name-main">${escapeHtml(fileName)}</span>
            </div>
            <span class="he-stat-item">${state.fileHistory.length} commits</span>
            <span class="he-stat-sep">·</span>
            <span class="he-stat-additions">+${totalAdditions}</span>
            <span class="he-stat-deletions">−${totalDeletions}</span>
            <button class="he-icon-btn"
                    data-action="preview-file"
                    data-path="${escapeHtml(state.selectedFile)}"
                    data-tooltip="${escapeHtml(previewLabel)}">
                ${ICONS.eye}
            </button>
        </div>
    `;
}

function renderFileCommitCard(commit) {
    const parsed = parseCommitSubject(commit.subject);
    // API returns sessionId/turn parsed server-side; frontmatter parse is the fallback
    const sessionId = commit.sessionId || parsed.session || null;
    const relTime = formatRelativeTime(new Date(commit.timestamp * 1000));
    const absTime = new Date(commit.timestamp * 1000).toLocaleString();
    const TA = S.widgets.history_explorer.turn_actions;

    const maxChanges = Math.max(...state.fileHistory.map(c => (c.additions || 0) + (c.deletions || 0)), 1);
    const thisChanges = (commit.additions || 0) + (commit.deletions || 0);
    const changePercent = Math.round((thisChanges / maxChanges) * 100);
    const addPercent = thisChanges > 0 ? Math.round((commit.additions / thisChanges) * changePercent) : 0;
    const delPercent = changePercent - addPercent;

    const tooltip = S.history_explorer?.open_in_diff_tool || 'Open in diff tool';

    return `
        <div class="he-file-commit-card" data-hash="${commit.hash}"${sessionId ? ` data-session="${escapeHtml(sessionId)}"` : ''}>
            <div class="he-file-commit-main"
                 data-action="show-file-commit-diff"
                 data-hash="${commit.hash}"
                 data-tooltip="${escapeHtml(tooltip)}">
                <div class="he-file-commit-content">
                    <div class="he-file-commit-header">
                        <span class="he-commit-time" data-tooltip="${absTime}">${relTime}</span>
                        <span class="he-commit-hash">${commit.hash}</span>
                        ${sessionId ? `
                            <span class="he-commit-session"
                                  data-action="fh-go-session"
                                  data-session="${escapeHtml(sessionId)}"
                                  data-tooltip="${escapeHtml(TA.go_to_session)}">
                                ${escapeHtml(sessionId.slice(0, 8))}
                            </span>
                        ` : ''}
                    </div>
                    <div class="he-file-commit-summary">
                        ${escapeHtml(parsed.summary || 'No summary')}
                    </div>
                    ${parsed.tags.length > 0 ? `
                        <div class="he-file-commit-tags">
                            ${parsed.tags.slice(0, 4).map(tag => `
                                <span class="he-mini-tag">${escapeHtml(tag)}</span>
                            `).join('')}
                            ${parsed.tags.length > 4 ? `<span class="he-mini-tag">+${parsed.tags.length - 4}</span>` : ''}
                        </div>
                    ` : ''}
                </div>
                <div class="he-file-commit-stats">
                    <div class="he-change-bar" data-tooltip="+${commit.additions} -${commit.deletions}">
                        <div class="he-change-bar-add" style="width: ${addPercent}%"></div>
                        <div class="he-change-bar-del" style="width: ${delPercent}%"></div>
                    </div>
                    <div class="he-change-numbers">
                        <span class="he-additions">+${commit.additions || 0}</span>
                        <span class="he-deletions">-${commit.deletions || 0}</span>
                    </div>
                </div>
                <span class="he-diff-tool-icon">${ICONS.changes}</span>
            </div>
            <div class="he-file-commit-actions">
                ${sessionId ? `
                    <button class="he-icon-btn"
                            data-action="fh-go-session"
                            data-session="${escapeHtml(sessionId)}"
                            data-tooltip="${escapeHtml(TA.go_to_session)}">${ICONS.openInTab}</button>
                    <button class="he-icon-btn"
                            data-action="fh-go-session-bg"
                            data-session="${escapeHtml(sessionId)}"
                            data-tooltip="${escapeHtml(TA.open_session_new_tab)}">${ICONS.external}</button>
                ` : ''}
                <button class="he-icon-btn"
                        data-action="fh-turn-menu"
                        data-tooltip="${escapeHtml(TA.more_actions)}">${ICONS.ellipsis}</button>
            </div>
        </div>
    `;
}

function groupCommitsByDate(commits) {
    const groups = {};
    const today = new Date().toDateString();
    const yesterday = new Date(Date.now() - 86400000).toDateString();

    for (const commit of commits) {
        const date = new Date(commit.timestamp * 1000);
        const dateStr = date.toDateString();
        let label;

        if (dateStr === today) {
            label = 'Today';
        } else if (dateStr === yesterday) {
            label = 'Yesterday';
        } else {
            label = date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
        }

        if (!groups[label]) groups[label] = [];
        groups[label].push(commit);
    }

    return groups;
}

function parseCommitSubject(subject) {
    // Parse YAML frontmatter from commit message
    const result = { tags: [], session: null, summary: '', turn: null };

    if (!subject) return result;

    // Extract tags
    const tagsMatch = subject.match(/tags:\s*\[([^\]]+)\]/);
    if (tagsMatch) {
        result.tags = tagsMatch[1].split(',').map(t => t.trim().replace(/^#/, ''));
    }

    // Extract session
    const sessionMatch = subject.match(/session:\s*(\S+)/);
    if (sessionMatch) {
        result.session = sessionMatch[1];
    }

    // Extract turn
    const turnMatch = subject.match(/turn:\s*(\d+)/);
    if (turnMatch) {
        result.turn = parseInt(turnMatch[1]);
    }

    // Extract summary - look for summary: field or last line after ---
    const summaryMatch = subject.match(/summary:\s*"([^"]+)"/);
    if (summaryMatch) {
        result.summary = summaryMatch[1];
    } else {
        // Fallback: use the part after the last ---
        const parts = subject.split('---');
        if (parts.length > 1) {
            const lastPart = parts[parts.length - 1].trim();
            // Remove [sessionId] Turn X: prefix
            result.summary = lastPart.replace(/^\[[^\]]+\]\s*Turn\s*\d+:\s*/, '').slice(0, 150);
        }
    }

    return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function renderEmpty(title, message) {
    return `
        <div class="he-empty">
            <div class="he-empty-title">${escapeHtml(title)}</div>
            <div class="he-empty-message">${escapeHtml(message)}</div>
        </div>
    `;
}

function formatMarkdown(text) {
    if (!text) return '';
    // Simple markdown: bullets, bold
    return escapeHtml(text)
        .replace(/^- /gm, '• ')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\n/g, '<br>');
}

// ═══════════════════════════════════════════════════════════════════════════
// Event Handlers
// ═══════════════════════════════════════════════════════════════════════════

function attachEventListeners() {
    if (!state.container) return;

    // Prevent duplicate listeners by checking if already attached
    if (state.container._heListenersAttached) return;
    state.container._heListenersAttached = true;

    state.container.addEventListener('click', handleClick);
    state.container.addEventListener('input', handleInput);
    state.container.addEventListener('change', handleChange);
    state.container.addEventListener('keydown', handleKeydown);
    state.container.addEventListener('contextmenu', handleContextMenu);
}

function handleContextMenu(e) {
    const card = e.target.closest('.he-file-commit-card');
    if (!card) return;
    e.preventDefault();
    showTurnMenu(card, e.clientX, e.clientY);
}

function handleChange(e) {
    // Handle checkbox changes
    if (e.target.classList.contains('he-session-checkbox')) {
        state.currentSessionOnly = e.target.checked;
        localStorage.setItem('he-current-session-only', state.currentSessionOnly);
        render();
    }
}

function handleClick(e) {
    const target = e.target.closest('[data-action]');
    if (!target) return;

    const action = target.dataset.action;

    switch (action) {
        case 'switch-tab':
            switchTab(target.dataset.tab);
            break;
        case 'toggle-session':
            toggleSession(target.dataset.session);
            break;
        case 'toggle-commit':
            toggleCommit(target.dataset.hash);
            break;
        case 'open-diff-tool':
            openInDiffTool(target.dataset.hash, target.dataset.path);
            break;
        case 'preview-file':
            previewFileAtHead(target.dataset.path);
            break;
        case 'copy-hash':
            copyToClipboard(target.dataset.hash);
            break;
        case 'remove-tag':
            removeTag(target.dataset.tag);
            break;
        case 'clear-filters':
            clearFilters();
            break;
        case 'select-file':
            selectFile(target.dataset.path);
            break;
        case 'clear-file':
            state.selectedFile = null;
            state.fileHistory = [];
            render();
            break;
        case 'select-tag':
            selectTag(target.dataset.tag);
            break;
        case 'clear-tag':
            state.selectedTag = null;
            state.tagCommits = [];
            render();
            break;
        case 'clear-files-search':
            state.filesSearchQuery = '';
            render();
            break;
        case 'set-files-view':
            state.filesViewMode = target.dataset.view;
            localStorage.setItem('he-files-view-mode', target.dataset.view);
            // Auto-expand first level dirs in tree view
            if (target.dataset.view === 'tree' && state.expandedDirs.size === 0) {
                expandFirstLevelDirs();
            }
            render();
            break;
        case 'toggle-dir':
            toggleDir(target.dataset.path);
            break;

        // File history actions
        case 'show-file-commit-diff':
            if (state.selectedFile) openInDiffTool(target.dataset.hash, state.selectedFile);
            break;
        case 'fh-go-session':
            goToSession(target.dataset.session);
            break;
        case 'fh-go-session-bg':
            goToSession(target.dataset.session, { background: true });
            break;
        case 'fh-turn-menu': {
            const card = target.closest('.he-file-commit-card');
            if (!card) break;
            const rect = target.getBoundingClientRect();
            showTurnMenu(card, rect.left, rect.bottom + 4);
            break;
        }
    }
}

function handleInput(e) {
    if (e.target.dataset.action === 'search') {
        state.searchQuery = e.target.value;
        // Debounce search
        clearTimeout(state.searchTimeout);
        state.searchTimeout = setTimeout(() => {
            loadTabData();
        }, 300);
    }
    if (e.target.dataset.action === 'files-search') {
        state.filesSearchQuery = e.target.value;
        render();
    }
}

function handleKeydown(e) {
    if (e.key === '/' && !e.target.matches('input, textarea')) {
        e.preventDefault();
        const input = state.container?.querySelector('.he-search-input');
        input?.focus();
    }
}

async function switchTab(tab) {
    state.activeTab = tab;
    state.loading = true;
    render();

    await loadTabData();

    state.loading = false;
    render();
}

async function loadTabData() {
    switch (state.activeTab) {
        case 'timeline':
            await fetchTimeline();
            break;
        case 'decisions':
            await fetchDecisions();
            break;
        case 'problems':
            await fetchProblems();
            break;
        case 'learnings':
            await fetchLearnings();
            break;
        case 'tags':
            await fetchTags();
            break;
        case 'files':
            await fetchAllFiles();
            break;
    }
}

function toggleSession(sessionId) {
    if (state.expandedSessions.has(sessionId)) {
        state.expandedSessions.delete(sessionId);
    } else {
        state.expandedSessions.add(sessionId);
    }
    render();
}

async function toggleCommit(hash) {
    if (state.expandedCommits.has(hash)) {
        state.expandedCommits.delete(hash);
    } else {
        state.expandedCommits.add(hash);
        // Load diff if not already loaded
        if (!state.loadedDiffs[hash]) {
            await fetchCommitDiff(hash);
        }
    }
    render();
}

async function selectFile(path) {
    state.selectedFile = path;
    state.loading = true;
    render();

    await fetchFileHistory(path);

    state.loading = false;
    render();
}

// ─────────────────────────────────────────────────────────────────────────────
// File History Helpers
// ─────────────────────────────────────────────────────────────────────────────


async function selectTag(tag) {
    state.loading = true;
    render();

    await fetchTagCommits(tag);

    state.loading = false;
    render();
}

function toggleDir(dirPath) {
    if (state.expandedDirs.has(dirPath)) {
        state.expandedDirs.delete(dirPath);
    } else {
        state.expandedDirs.add(dirPath);
    }
    render();
}

function expandFirstLevelDirs() {
    // Find first-level directories from allFiles
    const firstLevelDirs = new Set();
    state.allFiles.forEach(f => {
        const firstPart = f.split('/')[0];
        if (f.includes('/')) {
            firstLevelDirs.add(firstPart);
        }
    });

    // Expand first level dirs
    firstLevelDirs.forEach(d => state.expandedDirs.add(d));
}

function removeTag(tag) {
    state.searchTags = state.searchTags.filter(t => t !== tag);
    loadTabData().then(() => render());
}

function clearFilters() {
    state.searchQuery = '';
    state.searchTags = [];
    state.searchFiles = [];
    loadTabData().then(() => render());
}

function copyToClipboard(text) {
    navigator.clipboard.writeText(text).then(() => {
        showToast(`Copied: ${text}`);
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Turn actions (file history cards): context menu + session navigation
// ─────────────────────────────────────────────────────────────────────────────

function showTurnMenu(card, x, y) {
    const TA = S.widgets.history_explorer.turn_actions;
    const sessionId = card.dataset.session || null;
    const hash = card.dataset.hash;

    const items = [];
    if (sessionId) {
        items.push(
            { label: TA.go_to_session, action: () => goToSession(sessionId) },
            { label: TA.open_session_new_tab, action: () => goToSession(sessionId, { background: true }) },
            { label: TA.view_session_log, action: () => openSessionLog(sessionId) },
        );
    } else {
        items.push({ label: TA.no_session, disabled: true });
    }
    items.push({ type: 'separator' });
    if (state.selectedFile) {
        items.push({
            label: S.widgets.history_explorer.open_in_diff_tool,
            action: () => openInDiffTool(hash, state.selectedFile),
        });
    }
    items.push({ label: TA.copy_commit_hash, action: () => copyToClipboard(hash) });
    if (sessionId) {
        items.push({ label: TA.copy_session_id, action: () => copyToClipboard(sessionId) });
    }

    const menu = window.app?.contextMenu || (window._heCtxMenu ||= new ContextMenu());
    menu.show(x, y, items);
}

async function goToSession(sessionId, { background = false } = {}) {
    const app = window.app;
    if (!app || !sessionId) return;

    // Prefix-tolerant match: old shadow commits carry truncated 8-char IDs
    const existing = app.sessionManager?.sessions.find(s => sessionIdsMatch(sessionId, s.storeId));
    if (existing) {
        if (!background) app.switchToSession(existing);
        return;
    }

    const loaded = await app.loadSessionFromServer(sessionId, 50, false, { background });
    if (!loaded) {
        const TA = S.widgets.history_explorer.turn_actions;
        showToast(TA.session_not_found.replace('{id}', sessionId));
    }
}

function openSessionLog(sessionId) {
    if (!sessionId) return;
    WidgetManager.open('log-explorer', { sessionId });
}

function showToast(message) {
    const toast = document.createElement('div');
    toast.className = 'he-toast';
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 2000);
}

// ═══════════════════════════════════════════════════════════════════════════
// Widget Registration
// ═══════════════════════════════════════════════════════════════════════════

export function registerHistoryExplorerWidget() {
    WidgetManager.register('history-explorer', {
        type: 'bottom-sheet',
        title: S.widgets.titles.history_explorer,
        icon: 'history',
        scope: 'global',
        shortcut: 'Alt+H',

        deviceTypes: {
            default: 'bottom-sheet',
            phone: 'bottom-sheet',
            tablet: 'bottom-sheet',
            desktop: 'sidebar-right'
        },

        heights: {
            half: '50vh',
            full: '85vh'
        },

        width: '500px',
        minWidth: '350px',
        maxWidth: '700px',

        allowedTypes: ['bottom-sheet', 'sidebar-right', 'floating', 'tab'],

        headerActions: [
            {
                icon: 'tool',
                title: S.widgets.header_actions.open_auto_journal,
                onClick: () => {
                    WidgetManager.open('helpers-install');
                }
            },
            {
                icon: 'refresh',
                title: S.widgets.header_actions.refresh,
                onClick: async () => {
                    state.loading = true;
                    render();
                    await loadTabData();
                    state.loading = false;
                    render();
                }
            }
        ],

        render: (container, ctx) => {
            state.container = container;

            // Get CWD
            const cwd = ctx.cwd || WidgetManager.currentCwd || window.app?.activeSession?.cwd;
            if (cwd && cwd !== state.cwd) {
                state.cwd = cwd;
                // Reset data
                state.timeline = { sessions: [], totalCommits: 0 };
                state.decisions = [];
                state.problems = [];
                state.learnings = [];
                state.expandedSessions.clear();
                state.expandedCommits.clear();
                state.loadedDiffs = {};
            }

            // Initial render
            render();

            // Load data if needed
            if (state.timeline.sessions.length === 0 && state.cwd) {
                state.loading = true;
                render();
                loadTabData().then(() => {
                    state.loading = false;
                    render();
                });
            }
        },

        onOpen: () => {
            if (!state.cwd) {
                state.cwd = WidgetManager.currentCwd || window.app?.activeSession?.cwd;
            }
            if (state.cwd && state.timeline.sessions.length === 0) {
                state.loading = true;
                render();
                loadTabData().then(() => {
                    state.loading = false;
                    render();
                });
            }
        },

        onCwdChange: (cwd) => {
            if (cwd !== state.cwd) {
                state.cwd = cwd;
                state.timeline = { sessions: [], totalCommits: 0 };
                state.expandedSessions.clear();
                state.expandedCommits.clear();
                state.loadedDiffs = {};

                const widget = WidgetManager.widgets.get('history-explorer');
                if (widget?.isVisible) {
                    state.loading = true;
                    render();
                    loadTabData().then(() => {
                        state.loading = false;
                        render();
                    });
                }
            }
        }
    });
}

// Export for widget registration
export const HistoryExplorerWidget = {
    register: registerHistoryExplorerWidget,
    refresh: async () => {
        state.loading = true;
        render();
        await loadTabData();
        state.loading = false;
        render();
    },
    /**
     * Open History Explorer to show history for a specific file
     * @param {string} filePath - The file path to show history for
     * @param {string} cwd - The working directory (project)
     */
    openToFile: async (filePath, cwd) => {
        // Update state
        state.cwd = cwd;
        state.activeTab = 'files';
        state.selectedFile = filePath;
        state.loading = true;

        // Open the widget
        WidgetManager.open('history-explorer');

        // Fetch file list and file history in parallel
        await Promise.all([
            fetchAllFiles(),
            fetchFileHistory(filePath)
        ]);

        state.loading = false;
        render();
    }
};
