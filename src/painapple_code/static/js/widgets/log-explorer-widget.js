/**
 * Log Explorer Widget - Session log viewer using the widget system
 *
 * Provides a bottom-sheet/sidebar panel for viewing session logs.
 * Migrated from log-explorer.js to use the modular widget system.
 *
 * Features:
 * - Four tabs: Messages, Raw, Tools, System
 * - Pagination with "Load More"
 * - Filtering (role, errors only)
 * - Sort order toggle
 * - JSON tree rendering with expand/collapse
 * - Transform to sidebar for desktop use
 */

import S from '../strings.js';
import { CONFIG } from '../config.js';
import { escapeHtml, formatSize, highlightThinkingKeywords, formatTimePrecise } from '../utils.js';
import { WidgetManager, WidgetBus, ICONS } from '../widget-system/index.js';
import { isThinkingKeywordsHighlightingEnabled } from './config-widget.js';
import { renderJsonTree } from '../preview/json-tree.js';
import { copyToClipboard, showToast } from '../context-menu.js';
import { providerAuthorLabel } from '../status-bar.js';

// ─────────────────────────────────────────────────────────────────────
// Icons (specific to log explorer)
// ─────────────────────────────────────────────────────────────────────

const LOG_ICONS = {
    logs: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>',
    user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
    assistant: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>',
    tool: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>',
    result: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>',
    thinking: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v.01"/><path d="M12 8a2 2 0 0 1 2 2c0 .74-.4 1.38-1 1.73V13a1 1 0 0 1-2 0v-1.27c-.6-.35-1-.99-1-1.73a2 2 0 0 1 2-2z"/></svg>',
    error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
    event: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>',
    input: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>',
    output: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>',
    chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>',
    external: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3"/></svg>',
    refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>',
    sortDesc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 4h13M3 8h9M3 12h5M17 8v12M17 20l-4-4M17 20l4-4"/></svg>',
    sortAsc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12h13M3 16h9M3 20h5M17 4v12M17 4l-4 4M17 4l4 4"/></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>',
};

// Role colors and icons
const ROLE_CONFIG = {
    user: { icon: LOG_ICONS.user, color: '#3b82f6', label: S.widgets.log_explorer.message_types.user },
    assistant: { icon: LOG_ICONS.assistant, color: '#22c55e', label: S.widgets.log_explorer.message_types.assistant },
    tool: { icon: LOG_ICONS.tool, color: '#f59e0b', label: S.widgets.log_explorer.message_types.tool },
    thinking: { icon: LOG_ICONS.thinking, color: '#a855f7', label: S.widgets.log_explorer.message_types.thinking },
    result: { icon: LOG_ICONS.result, color: '#64748b', label: S.widgets.log_explorer.message_types.result },
};

// Raw direction config
const DIR_CONFIG = {
    in: { icon: LOG_ICONS.input, color: '#3b82f6', label: 'Input' },
    out: { icon: LOG_ICONS.output, color: '#22c55e', label: 'Output' },
    event: { icon: LOG_ICONS.event, color: '#64748b', label: 'Event' },
    error: { icon: LOG_ICONS.error, color: '#ef4444', label: 'Error' },
};

// ─────────────────────────────────────────────────────────────────────
// State Management
// ─────────────────────────────────────────────────────────────────────

class LogExplorerState {
    constructor() {
        this.currentTab = 'messages'; // 'messages', 'raw', 'tools', 'system'
        this.sessionId = null;
        this.sessionMeta = null;

        // Pagination
        this.messagesOffset = 0;
        this.rawOffset = 0;
        this.hasMoreMessages = false;
        this.hasMoreRaw = false;

        // Filters
        this.roleFilter = null;
        this.dirFilter = null;
        this.errorsOnly = false;

        // Sort order: 'desc' (newest first) or 'asc' (oldest first)
        this.sortOrder = 'desc';

        // DOM references (updated on render)
        this.container = null;
        this.tabsEl = null;
        this.contentEl = null;
        this.loadingEl = null;
        this.emptyEl = null;
        this.errorEl = null;
        this.loadMoreBtn = null;
        this.sessionInfoEl = null;
        this.sortBtn = null;
    }

    reset() {
        this.currentTab = 'messages';
        this.sessionMeta = null;
        this.messagesOffset = 0;
        this.rawOffset = 0;
        this.hasMoreMessages = false;
        this.hasMoreRaw = false;
        this.roleFilter = null;
        this.dirFilter = null;
        this.errorsOnly = false;
        this.sortOrder = 'desc';
    }
}

// Per-session state map
const states = new Map();

function getState(sessionId) {
    if (!sessionId) sessionId = WidgetManager.currentSessionId;
    if (!states.has(sessionId)) states.set(sessionId, new LogExplorerState());
    return states.get(sessionId);
}

function destroyState(sessionId) {
    states.delete(sessionId);
}

// Resolve a session identifier to its server-side storeId. ctx.sessionId may
// be the client `sess_xxx` ID (assigned at Session construction) for a fresh
// session that hasn't yet received a server-assigned storeId — but the logs
// API endpoints key on storeId. Returns null if the session has no storeId
// yet (fresh, no message sent), meaning there are no server-side logs.
function resolveStoreId(maybeId) {
    if (!maybeId) return null;
    const sessions = window.app?.sessionManager?.sessions || [];
    const session = sessions.find(s => s.id === maybeId || s.storeId === maybeId);
    if (session) return session.storeId || null;
    // Unknown to the session manager — could be a historical session ID
    // opened directly. Client IDs are sess_-prefixed; anything else is treated
    // as already a storeId.
    if (maybeId.startsWith('sess_')) return null;
    return maybeId;
}

// ─────────────────────────────────────────────────────────────────────
// Widget Registration
// ─────────────────────────────────────────────────────────────────────

export function registerLogExplorerWidget() {
    WidgetManager.register('log-explorer', {
        id: 'log-explorer',
        type: 'bottom-sheet',
        title: S.widgets.titles.logs,
        icon: LOG_ICONS.logs,
        shortcut: 'Alt+L',

        heights: { half: '45vh', full: '85vh' },
        sessionAware: true,

        render: renderLogExplorer,
        onOpen: handleOpen,
        onClose: handleClose,

        headerActions: [
            {
                id: 'sort',
                icon: LOG_ICONS.sortDesc,
                title: S.widgets.header_actions.sort_order,
                onClick: toggleSortOrder
            },
            {
                id: 'refresh',
                icon: LOG_ICONS.refresh,
                title: S.widgets.header_actions.refresh,
                onClick: refresh
            },
            {
                id: 'external',
                icon: LOG_ICONS.external,
                title: S.widgets.header_actions.open_viewer,
                onClick: openExternal
            }
        ],

        onDestroy: (sessionId) => {
            destroyState(sessionId);
        }
    });
}

// ─────────────────────────────────────────────────────────────────────
// Lifecycle Handlers
// ─────────────────────────────────────────────────────────────────────

function handleOpen() {
    const state = getState();
    // Always re-resolve: storeId may have been assigned since last open
    // (fresh session that has now sent its first message).
    const sessionKey = state.sessionId || WidgetManager.currentSessionId;
    state.sessionId = resolveStoreId(sessionKey);
    if (state.sessionId) {
        loadOverview();
    } else {
        showEmpty(S.widgets.log_explorer.no_logs_yet);
    }
}

function handleClose() {
    // Nothing special needed on close
}

// ─────────────────────────────────────────────────────────────────────
// Main Render Function
// ─────────────────────────────────────────────────────────────────────

function renderLogExplorer(container, ctx) {
    const state = getState(ctx.sessionId);
    state.container = container;
    if (ctx.sessionId) state.sessionId = resolveStoreId(ctx.sessionId);

    container.innerHTML = `
        <div class="log-explorer-inner">
            <div class="logs-header">
                <div class="logs-session-info">
                    <span class="logs-session-name">Loading...</span>
                </div>
            </div>
            <div class="logs-tabs">
                <button class="logs-tab active" data-tab="messages">Messages</button>
                <button class="logs-tab" data-tab="raw">Raw</button>
                <button class="logs-tab" data-tab="tools">Tools</button>
                <button class="logs-tab" data-tab="system">System</button>
            </div>
            <div class="logs-body">
                <div class="logs-loading" hidden>Loading...</div>
                <div class="logs-empty" hidden>No data</div>
                <div class="logs-error" hidden></div>
                <div class="logs-content"></div>
                <button class="logs-load-more" hidden>Load more</button>
            </div>
        </div>
    `;

    // Cache DOM references
    state.sessionInfoEl = container.querySelector('.logs-session-info');
    state.tabsEl = container.querySelector('.logs-tabs');
    state.contentEl = container.querySelector('.logs-content');
    state.loadingEl = container.querySelector('.logs-loading');
    state.emptyEl = container.querySelector('.logs-empty');
    state.errorEl = container.querySelector('.logs-error');
    state.loadMoreBtn = container.querySelector('.logs-load-more');

    // Event listeners
    setupEventListeners();

    // Load data if we have a session
    if (state.sessionId) {
        loadOverview();
    } else if (ctx.sessionId) {
        // Session exists but has no storeId yet (fresh, no message sent)
        showEmpty(S.widgets.log_explorer.no_logs_yet);
    }
}

function setupEventListeners() {
    const state = getState();
    // Tab switching
    state.tabsEl?.addEventListener('click', (e) => {
        const tab = e.target.closest('[data-tab]');
        if (tab) {
            switchTab(tab.dataset.tab);
        }
    });

    // Load more
    state.loadMoreBtn?.addEventListener('click', loadMore);

    // Delegated click handlers for content
    state.contentEl?.addEventListener('click', handleContentClick);
}

function handleContentClick(e) {
    const state = getState();

    // Copy a raw entry to the clipboard (sits inside the header, so intercept
    // before the expand/collapse handler swallows the click).
    const copyBtn = e.target.closest('.log-raw-copy');
    if (copyBtn) {
        e.stopPropagation();
        e.preventDefault();
        let text = '';
        try {
            text = decodeURIComponent(escape(atob(copyBtn.dataset.copy || '')));
        } catch { text = ''; }
        copyToClipboard(text).then(ok => {
            if (ok) {
                copyBtn.classList.add('copied');
                copyBtn.innerHTML = LOG_ICONS.check;
                showToast(S.toast.copied);
                setTimeout(() => {
                    copyBtn.classList.remove('copied');
                    copyBtn.innerHTML = LOG_ICONS.copy;
                }, 1200);
            }
        });
        return;
    }

    // Log item expand/collapse
    const expandable = e.target.closest('.log-item-expandable');
    if (expandable && !e.target.closest('.json-toggle') && !e.target.closest('.json-parse-btn')) {
        if (e.target.closest('.log-item-header')) {
            expandable.classList.toggle('expanded');
        }
    }

    // JSON tree node toggle
    const jsonToggle = e.target.closest('.json-toggle');
    if (jsonToggle) {
        e.stopPropagation();
        const collapsible = jsonToggle.closest('.json-collapsible');
        if (collapsible) {
            collapsible.classList.toggle('expanded');
        }
    }

    // Nested JSON parse button
    const parseBtn = e.target.closest('.json-parse-btn');
    if (parseBtn) {
        e.stopPropagation();
        const container = parseBtn.closest('.json-nested-container');
        if (container) {
            const nestedContent = container.querySelector('.json-nested-content');
            const preview = container.querySelector('.json-string-preview');
            if (nestedContent) {
                const isHidden = nestedContent.hidden;
                nestedContent.hidden = !isHidden;
                parseBtn.classList.toggle('active', isHidden);
                if (preview) preview.hidden = isHidden;
            }
        }
    }

    // Tool file link
    const toolLink = e.target.closest('[data-tool-file]');
    if (toolLink) {
        e.preventDefault();
        showToolOutput(toolLink.dataset.toolFile);
    }

    // Filter button
    const filterBtn = e.target.closest('[data-filter]');
    if (filterBtn) {
        const filter = filterBtn.dataset.filter;
        if (filter === 'errors') {
            state.errorsOnly = !state.errorsOnly;
            loadRaw(false);
        }
    }
}

// ─────────────────────────────────────────────────────────────────────
// Data Loading
// ─────────────────────────────────────────────────────────────────────

async function loadOverview() {
    const state = getState();
    if (!state.sessionId) return;

    showLoading();

    try {
        const response = await fetch(`${CONFIG.API_BASE}/api/sessions/${state.sessionId}/logs`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const data = await response.json();
        state.sessionMeta = data.meta;
        updateSessionInfo(data);
        updateTabCounts(data.files);

        await loadCurrentTab();
    } catch (err) {
        showError(`Failed to load logs: ${err.message}`);
    }
}

async function loadCurrentTab() {
    const state = getState();
    switch (state.currentTab) {
        case 'messages':
            await loadMessages(false);
            break;
        case 'raw':
            await loadRaw(false);
            break;
        case 'tools':
            await loadTools();
            break;
        case 'system':
            renderSystemLogs();
            break;
    }
}

async function loadMessages(append = false) {
    const state = getState();
    if (!state.sessionId) return;
    if (!append) {
        state.messagesOffset = 0;
        showLoading();
    }

    try {
        let url = `${CONFIG.API_BASE}/api/sessions/${state.sessionId}/logs/messages?offset=${state.messagesOffset}&limit=50`;
        url += `&sort=${state.sortOrder}`;
        if (state.roleFilter) {
            url += `&role=${state.roleFilter}`;
        }

        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const data = await response.json();
        state.hasMoreMessages = data.has_more;
        state.messagesOffset = data.offset + data.messages.length;

        if (append) {
            appendMessages(data.messages);
        } else {
            renderMessages(data.messages, data.total);
        }

        updateLoadMore(state.hasMoreMessages);
    } catch (err) {
        showError(`Failed to load messages: ${err.message}`);
    }
}

async function loadRaw(append = false) {
    const state = getState();
    if (!state.sessionId) return;
    if (!append) {
        state.rawOffset = 0;
        showLoading();
    }

    try {
        let url = `${CONFIG.API_BASE}/api/sessions/${state.sessionId}/logs/raw?offset=${state.rawOffset}&limit=100`;
        url += `&sort=${state.sortOrder}`;
        if (state.dirFilter) {
            url += `&direction=${state.dirFilter}`;
        }
        if (state.errorsOnly) {
            url += `&errors_only=true`;
        }

        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const data = await response.json();
        state.hasMoreRaw = data.has_more;
        state.rawOffset = data.offset + data.entries.length;

        if (append) {
            appendRawEntries(data.entries);
        } else {
            renderRaw(data.entries, data.total);
        }

        updateLoadMore(state.hasMoreRaw);
    } catch (err) {
        showError(`Failed to load raw log: ${err.message}`);
    }
}

async function loadTools() {
    const state = getState();
    if (!state.sessionId) return;
    showLoading();

    try {
        const response = await fetch(`${CONFIG.API_BASE}/api/sessions/${state.sessionId}/logs/tools`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const data = await response.json();
        renderTools(data.files);
        updateLoadMore(false);
    } catch (err) {
        showError(`Failed to load tools: ${err.message}`);
    }
}

async function showToolOutput(filename) {
    const state = getState();
    if (!state.sessionId) return;

    try {
        const response = await fetch(`${CONFIG.API_BASE}/api/sessions/${state.sessionId}/logs/tools/${encodeURIComponent(filename)}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const data = await response.json();
        const content = escapeHtml(data.content);

        state.contentEl.innerHTML = `
            <div class="log-tool-preview">
                <div class="log-tool-preview-header">
                    <button class="log-tool-preview-back" data-tooltip="Back to list">
                        ${LOG_ICONS.input}
                    </button>
                    <span class="log-tool-preview-name">${escapeHtml(filename)}</span>
                    <span class="log-tool-preview-size">${formatSize(data.size)}</span>
                </div>
                <pre class="log-tool-preview-content"><code>${content}</code></pre>
            </div>
        `;

        state.contentEl.querySelector('.log-tool-preview-back')?.addEventListener('click', () => {
            loadTools();
        });
    } catch (err) {
        showError(`Failed to load tool output: ${err.message}`);
    }
}

/**
 * Render system logs from the active session (client-side only)
 * System logs are stored in-memory per session (connection events, errors, etc.)
 */
function renderSystemLogs() {
    const state = getState();
    // Get system logs from the session matching our state.sessionId
    const session = window.app?.sessionManager?.sessions?.find(s => s.storeId === state.sessionId);
    const logs = session?.systemLogs || [];

    if (logs.length === 0) {
        showEmpty('No system events');
        updateLoadMore(false);
        return;
    }

    // Sort according to current sort order
    const sortedLogs = [...logs].sort((a, b) => {
        const aTime = new Date(a.timestamp).getTime();
        const bTime = new Date(b.timestamp).getTime();
        return state.sortOrder === 'desc' ? bTime - aTime : aTime - bTime;
    });

    const html = sortedLogs.map(entry => {
        const time = formatTimePrecise(entry.timestamp);
        const typeClass = entry.type || 'info';
        const typeIcon = typeClass === 'error' ? LOG_ICONS.error :
                        typeClass === 'warning' ? LOG_ICONS.event :
                        LOG_ICONS.event;

        return `
            <div class="log-item log-system-item ${typeClass}">
                <div class="log-item-header">
                    <span class="log-badge ${typeClass}">
                        ${typeIcon}
                        <span class="log-badge-label">${typeClass}</span>
                    </span>
                    <span class="log-time">${time}</span>
                </div>
                <div class="log-system-text">${escapeHtml(entry.text)}</div>
            </div>
        `;
    }).join('');

    state.contentEl.innerHTML = html;
    state.loadingEl.hidden = true;
    state.emptyEl.hidden = true;
    updateLoadMore(false);
}

function loadMore() {
    const state = getState();
    if (state.currentTab === 'messages' && state.hasMoreMessages) {
        loadMessages(true);
    } else if (state.currentTab === 'raw' && state.hasMoreRaw) {
        loadRaw(true);
    }
}

function refresh() {
    const state = getState();
    // Re-resolve in case storeId was assigned since the widget opened
    // (fresh session that has now sent its first message).
    const sessionKey = state.sessionId || WidgetManager.currentSessionId;
    state.sessionId = resolveStoreId(sessionKey);
    if (state.sessionId) {
        loadOverview();
    } else {
        showEmpty(S.widgets.log_explorer.no_logs_yet);
    }
}

// ─────────────────────────────────────────────────────────────────────
// UI Updates
// ─────────────────────────────────────────────────────────────────────

function updateSessionInfo(data) {
    const state = getState();
    if (!state.sessionInfoEl) return;

    const meta = data.meta || {};
    const cost = meta.total_cost ? `$${meta.total_cost.toFixed(4)}` : '';
    const name = meta.name || 'Session';

    state.sessionInfoEl.innerHTML = `
        <span class="logs-session-name">${escapeHtml(name)}</span>
        ${cost ? `<span class="logs-session-cost">${cost}</span>` : ''}
    `;
}

function updateTabCounts(files) {
    const state = getState();
    if (!state.tabsEl) return;

    const messagesTab = state.tabsEl.querySelector('[data-tab="messages"]');
    const rawTab = state.tabsEl.querySelector('[data-tab="raw"]');
    const toolsTab = state.tabsEl.querySelector('[data-tab="tools"]');
    const systemTab = state.tabsEl.querySelector('[data-tab="system"]');

    if (messagesTab) {
        const count = files.messages?.lines || 0;
        messagesTab.innerHTML = `Messages <span class="tab-count">${count}</span>`;
    }
    if (rawTab) {
        const count = files.raw?.lines || 0;
        rawTab.innerHTML = `Raw <span class="tab-count">${count}</span>`;
    }
    if (toolsTab) {
        const count = files.tools?.count || 0;
        toolsTab.innerHTML = `Tools <span class="tab-count">${count}</span>`;
    }
    if (systemTab) {
        // System logs are client-side, get count from session
        const session = window.app?.sessionManager?.sessions?.find(s => s.storeId === state.sessionId);
        const count = session?.systemLogs?.length || 0;
        systemTab.innerHTML = `System <span class="tab-count">${count}</span>`;
    }
}

function switchTab(tab) {
    const state = getState();
    state.currentTab = tab;

    // Update tab UI
    state.tabsEl?.querySelectorAll('[data-tab]').forEach(t => {
        t.classList.toggle('active', t.dataset.tab === tab);
    });

    loadCurrentTab();
}

function showLoading() {
    const state = getState();
    if (state.loadingEl) state.loadingEl.hidden = false;
    if (state.contentEl) state.contentEl.innerHTML = '';
    if (state.emptyEl) state.emptyEl.hidden = true;
    if (state.errorEl) state.errorEl.hidden = true;
    if (state.loadMoreBtn) state.loadMoreBtn.hidden = true;
}

function showError(message) {
    const state = getState();
    if (state.loadingEl) state.loadingEl.hidden = true;
    if (state.emptyEl) state.emptyEl.hidden = true;
    if (state.errorEl) {
        state.errorEl.hidden = false;
        state.errorEl.textContent = message;
    }
}

function showEmpty(message) {
    const state = getState();
    if (state.loadingEl) state.loadingEl.hidden = true;
    if (state.errorEl) state.errorEl.hidden = true;
    if (state.contentEl) state.contentEl.innerHTML = '';
    if (state.emptyEl) {
        state.emptyEl.hidden = false;
        state.emptyEl.textContent = message || 'No data';
    }
    if (state.loadMoreBtn) state.loadMoreBtn.hidden = true;
}

function updateLoadMore(hasMore) {
    const state = getState();
    if (state.loadMoreBtn) state.loadMoreBtn.hidden = !hasMore;
}

function toggleSortOrder() {
    const state = getState();
    state.sortOrder = state.sortOrder === 'desc' ? 'asc' : 'desc';
    updateSortButton();
    loadCurrentTab();
}

function updateSortButton() {
    const state = getState();
    const widget = WidgetManager.get('log-explorer');
    if (!widget) return;

    const sortAction = widget.headerActions?.find(a => a.id === 'sort');
    if (sortAction) {
        const icon = state.sortOrder === 'desc' ? LOG_ICONS.sortDesc : LOG_ICONS.sortAsc;
        const title = state.sortOrder === 'desc' ? 'Newest first (click to reverse)' : 'Oldest first (click to reverse)';
        // Update button in widget header
        const btn = widget.container?.querySelector('[data-action="sort"]');
        if (btn) {
            btn.innerHTML = icon;
            btn.setAttribute('data-tooltip', title);
        }
    }
}

function openExternal() {
    const state = getState();
    if (state.sessionId) {
        const path = `sessions/${state.sessionId}/raw.jsonl`;
        window.open(`/view?path=${encodeURIComponent(path)}`, '_blank');
    }
}

// ─────────────────────────────────────────────────────────────────────
// Rendering: Messages Tab
// ─────────────────────────────────────────────────────────────────────

function renderMessages(messages, total) {
    const state = getState();
    if (state.loadingEl) state.loadingEl.hidden = true;
    if (state.errorEl) state.errorEl.hidden = true;

    if (messages.length === 0) {
        if (state.emptyEl) state.emptyEl.hidden = false;
        if (state.contentEl) state.contentEl.innerHTML = '';
        return;
    }

    if (state.emptyEl) state.emptyEl.hidden = true;

    const orderLabel = state.sortOrder === 'desc' ? 'newest first' : 'oldest first';

    let html = `<div class="logs-summary">Showing ${messages.length} of ${total} messages (${orderLabel})</div>`;
    html += '<div class="logs-messages-list">';

    for (const msg of messages) {
        html += renderMessage(msg);
    }

    html += '</div>';
    if (state.contentEl) state.contentEl.innerHTML = html;
}

function appendMessages(messages) {
    const state = getState();
    const list = state.contentEl?.querySelector('.logs-messages-list');
    if (!list) return;

    for (const msg of messages) {
        list.insertAdjacentHTML('beforeend', renderMessage(msg));
    }
}

// Label for assistant rows: the session's own PROVIDER ("Codex"), title-cased
// to match the other role labels. A session the manager doesn't know (a
// historical ID opened directly) has no provider to read, so it keeps the
// static strings.yaml label rather than guessing the box default.
function assistantLabel() {
    const id = getState().sessionId || WidgetManager.currentSessionId;
    const session = (window.app?.sessionManager?.sessions || [])
        .find(s => s.id === id || s.storeId === id);
    if (!session) return ROLE_CONFIG.assistant.label;
    const label = providerAuthorLabel(session);
    return escapeHtml(label.charAt(0).toUpperCase() + label.slice(1));
}

function renderMessage(msg) {
    const role = msg.role || 'unknown';
    const base = ROLE_CONFIG[role] || { icon: LOG_ICONS.logs, color: '#888', label: role };
    // Copy, never mutate — ROLE_CONFIG is module-level and shared by every
    // session's log view.
    const config = role === 'assistant' ? { ...base, label: assistantLabel() } : base;
    const timestamp = formatTimePrecise(msg.timestamp);

    let content = '';
    let extra = '';

    switch (role) {
        case 'user':
            const userContent = escapeHtml(msg.content || '').slice(0, 200);
            content = isThinkingKeywordsHighlightingEnabled() ? highlightThinkingKeywords(userContent) : userContent;
            if (msg.has_images) {
                extra = `<span class="log-badge">${msg.image_count} image${msg.image_count > 1 ? 's' : ''}</span>`;
            }
            break;

        case 'assistant':
            content = escapeHtml(msg.content || '').slice(0, 200);
            break;

        case 'tool':
            content = `<span class="log-tool-name">${escapeHtml(msg.tool_name || 'Tool')}</span>`;
            if (msg.tool_output_file) {
                extra = `<a href="#" data-tool-file="${escapeHtml(msg.tool_output_file)}" class="log-tool-link">View output</a>`;
            }
            break;

        case 'thinking':
            const toolCount = (msg.tools || []).length;
            content = `Thinking (${toolCount} tool${toolCount !== 1 ? 's' : ''})`;
            break;

        case 'result':
            const cost = msg.cost_usd ? `$${msg.cost_usd.toFixed(4)}` : '';
            const duration = msg.duration_ms ? `${(msg.duration_ms / 1000).toFixed(1)}s` : '';
            const turns = msg.num_turns || 1;
            content = `${turns} turn${turns !== 1 ? 's' : ''} | ${duration} | ${cost}`;
            if (msg.is_error) {
                extra = '<span class="log-badge error">Error</span>';
            }
            break;

        default:
            content = JSON.stringify(msg).slice(0, 100);
    }

    const isExpandable = role === 'tool' || role === 'thinking';

    return `
        <div class="log-item ${isExpandable ? 'log-item-expandable' : ''}" data-role="${role}">
            <div class="log-item-header">
                <span class="log-item-icon" style="color: ${config.color}">${config.icon}</span>
                <span class="log-item-role">${config.label}</span>
                <span class="log-item-time">${timestamp}</span>
                ${extra}
                ${isExpandable ? `<span class="log-item-chevron">${LOG_ICONS.chevron}</span>` : ''}
            </div>
            <div class="log-item-content">${content}</div>
            ${isExpandable ? renderExpandedContent(msg) : ''}
        </div>
    `;
}

function renderExpandedContent(msg) {
    if (msg.role === 'tool') {
        const input = msg.tool_input ? JSON.stringify(msg.tool_input, null, 2) : '';
        const output = msg.tool_output || '';
        const error = msg.tool_error || '';

        return `
            <div class="log-item-expanded">
                ${input ? `<div class="log-expanded-section"><div class="log-expanded-label">Input</div><pre>${escapeHtml(input)}</pre></div>` : ''}
                ${output ? `<div class="log-expanded-section"><div class="log-expanded-label">Output</div><pre>${escapeHtml(output.slice(0, 1000))}${output.length > 1000 ? '...' : ''}</pre></div>` : ''}
                ${error ? `<div class="log-expanded-section error"><div class="log-expanded-label">Error</div><pre>${escapeHtml(error)}</pre></div>` : ''}
            </div>
        `;
    }

    if (msg.role === 'thinking') {
        const tools = msg.tools || [];
        let toolsHtml = tools.map(t => `
            <div class="log-thinking-tool">
                <span class="log-tool-name">${escapeHtml(t.toolName || 'Tool')}</span>
                ${t.toolOutput ? '<span class="log-badge">completed</span>' : '<span class="log-badge pending">pending</span>'}
            </div>
        `).join('');

        return `
            <div class="log-item-expanded">
                <div class="log-expanded-section"><div class="log-expanded-label">Thinking</div><pre>${escapeHtml((msg.content || '').slice(0, 500))}${(msg.content || '').length > 500 ? '...' : ''}</pre></div>
                ${toolsHtml ? `<div class="log-expanded-section"><div class="log-expanded-label">Tools</div>${toolsHtml}</div>` : ''}
            </div>
        `;
    }

    return '';
}

// ─────────────────────────────────────────────────────────────────────
// Rendering: Raw Tab
// ─────────────────────────────────────────────────────────────────────

function renderRaw(entries, total) {
    const state = getState();
    if (state.loadingEl) state.loadingEl.hidden = true;
    if (state.errorEl) state.errorEl.hidden = true;

    if (entries.length === 0) {
        if (state.emptyEl) state.emptyEl.hidden = false;
        if (state.contentEl) state.contentEl.innerHTML = '';
        return;
    }

    if (state.emptyEl) state.emptyEl.hidden = true;

    const orderLabel = state.sortOrder === 'desc' ? 'newest first' : 'oldest first';

    let html = `
        <div class="logs-summary">
            Showing ${entries.length} of ${total} entries (${orderLabel})
            <div class="logs-filters">
                <button class="log-filter ${state.errorsOnly ? 'active' : ''}" data-filter="errors">Errors only</button>
            </div>
        </div>
    `;
    html += '<div class="logs-raw-list">';

    for (const entry of entries) {
        html += renderRawEntry(entry);
    }

    html += '</div>';
    if (state.contentEl) state.contentEl.innerHTML = html;
}

function appendRawEntries(entries) {
    const state = getState();
    const list = state.contentEl?.querySelector('.logs-raw-list');
    if (!list) return;

    for (const entry of entries) {
        list.insertAdjacentHTML('beforeend', renderRawEntry(entry));
    }
}

function renderRawEntry(entry) {
    const dir = entry.dir || 'unknown';
    const config = DIR_CONFIG[dir] || { icon: LOG_ICONS.logs, color: '#888', label: dir };
    const timestamp = formatTimePrecise(entry.ts);

    let content = '';
    if (dir === 'event') {
        content = escapeHtml(entry.event || '');
    } else if (dir === 'error') {
        content = `<span class="log-error-text">${escapeHtml(entry.error || '')}</span>`;
        if (entry.context) {
            content += `<pre class="log-error-context">${escapeHtml(entry.context.slice(0, 500))}</pre>`;
        }
    } else if (dir === 'in') {
        content = `Input: ${entry.size || 0} bytes`;
    } else if (dir === 'out') {
        const type = entry.type || '';
        const subtype = entry.subtype ? ` (${entry.subtype})` : '';
        content = `<span class="log-raw-type">${type}${subtype}</span>`;
        if (entry.truncated) {
            content += ' <span class="log-badge">truncated</span>';
        }
    }

    const isExpandable = dir === 'out' && entry.data;
    let expandedContent = '';
    if (isExpandable) {
        expandedContent = renderJsonData(entry.data);
    }

    // Copy payload: the raw `out` JSON string verbatim when present (so what you
    // paste matches the on-disk raw.jsonl entry), otherwise the whole entry
    // pretty-printed. Base64 to survive quotes/newlines in a data attribute
    // (unicode-safe, same idiom as tool-renderer-blocks.js).
    const copyText = (dir === 'out' && entry.data)
        ? entry.data
        : JSON.stringify(entry, null, 2);
    const copyEncoded = btoa(unescape(encodeURIComponent(copyText)));

    return `
        <div class="log-raw-item ${isExpandable ? 'log-item-expandable' : ''}" data-dir="${dir}">
            <div class="log-item-header">
                <span class="log-item-icon" style="color: ${config.color}">${config.icon}</span>
                <span class="log-item-role">${config.label}</span>
                <span class="log-item-time">${timestamp}</span>
                <button class="log-raw-copy" data-copy="${copyEncoded}" data-tooltip="${S.widgets.log_explorer.copy_entry}" aria-label="${S.widgets.log_explorer.copy_entry}">${LOG_ICONS.copy}</button>
                ${isExpandable ? `<span class="log-item-chevron">${LOG_ICONS.chevron}</span>` : ''}
            </div>
            <div class="log-item-content">${content}</div>
            ${isExpandable ? `<div class="log-item-expanded">${expandedContent}</div>` : ''}
        </div>
    `;
}

// ─────────────────────────────────────────────────────────────────────
// Rendering: Tools Tab
// ─────────────────────────────────────────────────────────────────────

function renderTools(files) {
    const state = getState();
    if (state.loadingEl) state.loadingEl.hidden = true;
    if (state.errorEl) state.errorEl.hidden = true;

    if (files.length === 0) {
        if (state.emptyEl) {
            state.emptyEl.hidden = false;
            state.emptyEl.textContent = 'No tool output files';
        }
        if (state.contentEl) state.contentEl.innerHTML = '';
        return;
    }

    if (state.emptyEl) state.emptyEl.hidden = true;

    let html = '<div class="logs-tools-list">';

    for (const file of files) {
        html += `
            <div class="log-tool-item" data-tool-file="${escapeHtml(file.name)}">
                <div class="log-tool-item-icon">${LOG_ICONS.tool}</div>
                <div class="log-tool-item-info">
                    <div class="log-tool-item-name">${escapeHtml(file.tool_name || file.name)}</div>
                    <div class="log-tool-item-meta">
                        <span>${formatSize(file.size)}</span>
                        <span>${formatTimePrecise(file.modified)}</span>
                    </div>
                </div>
                <div class="log-tool-item-chevron">${LOG_ICONS.chevron}</div>
            </div>
        `;
    }

    html += '</div>';
    if (state.contentEl) state.contentEl.innerHTML = html;
}

// ─────────────────────────────────────────────────────────────────────
// JSON Tree Rendering (shared module)
// ─────────────────────────────────────────────────────────────────────

function renderJsonData(dataStr) {
    if (!dataStr) return '';
    try {
        return renderJsonTree(JSON.parse(dataStr));
    } catch (e) {
        const truncated = dataStr.length > 2000;
        const display = truncated ? dataStr.slice(0, 2000) + '...' : dataStr;
        return `<pre class="json-raw">${escapeHtml(display)}</pre>`;
    }
}

// ─────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────

export function openLogExplorer(sessionId = null) {
    if (sessionId) {
        const state = getState(sessionId);
        state.sessionId = sessionId;
    }
    const widget = WidgetManager.get('log-explorer');
    widget?.open();
}

export function closeLogExplorer() {
    const widget = WidgetManager.get('log-explorer');
    widget?.close();
}

export { destroyState as destroyLogExplorerState };
