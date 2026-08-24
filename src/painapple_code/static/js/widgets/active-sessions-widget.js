/**
 * Active Sessions Widget - Monitor running Claude processes
 *
 * Shows all Claude sessions and subprocesses with three views:
 * - Sessions: Agent sessions with process state
 * - Instances: Background processes (Summary forks) with history
 * - Stats: Aggregated statistics and success rates
 */

import S from '../strings.js';
import { escapeHtml, formatRelativeTime, formatDuration } from '../utils.js';
import { CONFIG } from '../config.js';
import { WidgetManager, WidgetBus, ICONS } from '../widget-system/index.js';

// ═══════════════════════════════════════════════════════════════════════════
// State Management
// ═══════════════════════════════════════════════════════════════════════════

class ActiveSessionsState {
    constructor() {
        // Sessions tab data
        this.sessions = [];
        this.agentInstances = [];  // Running instances (from /api/active-sessions)

        // Instances tab data (from /api/agent-instances)
        this.instancesData = null;

        // UI state
        this.activeTab = 'sessions';  // 'sessions' | 'instances' | 'stats'
        this.loading = false;
        this.error = null;
        this.currentContainer = null;
        this.refreshInterval = null;
        this.autoRefresh = true;
    }

    reset() {
        this.sessions = [];
        this.agentInstances = [];
        this.instancesData = null;
        this.loading = false;
        this.error = null;
    }

    startAutoRefresh() {
        if (this.refreshInterval) return;
        this.refreshInterval = setInterval(() => {
            if (this.autoRefresh) {
                loadData();
            }
        }, 2000);
    }

    stopAutoRefresh() {
        if (this.refreshInterval) {
            clearInterval(this.refreshInterval);
            this.refreshInterval = null;
        }
    }
}

const state = new ActiveSessionsState();

// Global poll interval for process state sync
let globalPollInterval = null;
const GLOBAL_POLL_INTERVAL_MS = 5000;

// ═══════════════════════════════════════════════════════════════════════════
// Data Loading
// ═══════════════════════════════════════════════════════════════════════════

async function loadData() {
    if (!state.loading) {
        state.loading = state.sessions.length === 0 && !state.instancesData;
    }

    try {
        // Load both endpoints in parallel
        const [sessionsRes, instancesRes] = await Promise.all([
            fetch(`${CONFIG.API_BASE}/api/active-sessions`),
            fetch(`${CONFIG.API_BASE}/api/agent-instances`)
        ]);

        if (!sessionsRes.ok || !instancesRes.ok) {
            throw new Error(`HTTP ${sessionsRes.ok ? instancesRes.status : sessionsRes.status}`);
        }
        const sessionsData = await sessionsRes.json();
        const instancesData = await instancesRes.json();

        state.sessions = sessionsData.sessions || [];
        state.agentInstances = sessionsData.agent_instances || [];
        state.instancesData = instancesData;
        state.loading = false;
        state.error = null;

        // Sync process states to local sessions
        syncProcessStatesToSessions(sessionsData);

        // Update header badges
        updateHeaderBadges(sessionsData, instancesData);

        renderContent();
    } catch (error) {
        console.error('Failed to load active sessions:', error);
        state.loading = false;
        state.error = 'Failed to load data';
        renderContent();
    }
}

// Sync process running states to app's session manager
function syncProcessStatesToSessions(data) {
    const app = window.app;
    if (!app?.sessionManager) return;

    // Build lookup: store_id -> is_running
    const serverSessions = new Map();
    for (const s of (data.sessions || [])) {
        if (s.store_id) {
            serverSessions.set(s.store_id, s.is_running);
        }
    }

    // Shadow git instances keyed by parent_session_id
    const shadowGitBySession = new Set();
    for (const inst of (data.agent_instances || [])) {
        if (inst.parent_session_id && inst.type === 'summary_fork') {
            shadowGitBySession.add(inst.parent_session_id);
        }
    }

    let changed = false;

    for (const session of app.sessionManager.sessions) {
        if (!session.storeId) continue;

        // Update hasShadowGitRunning
        const hasShadowGit = shadowGitBySession.has(session.storeId);
        if (session.hasShadowGitRunning !== hasShadowGit) {
            session.hasShadowGitRunning = hasShadowGit;
            changed = true;
        }
    }

    // Re-render tabs if any status changed
    if (changed && app.tabCtrl) {
        app.tabCtrl.renderTabs();
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Session Actions
// ═══════════════════════════════════════════════════════════════════════════

async function stopSession(storeId, btn) {
    btn.disabled = true;
    btn.innerHTML = ICONS.loader;

    try {
        const response = await fetch(`${CONFIG.API_BASE}/api/session/${storeId}`, {
            method: 'DELETE'
        });

        if (response.ok) {
            await loadData();
            WidgetBus.emit('notification', { type: 'success', message: 'Session stopped' });
        }
    } catch (error) {
        console.error('Failed to stop session:', error);
        btn.disabled = false;
        btn.textContent = 'Stop';
        WidgetBus.emit('notification', { type: 'error', message: 'Failed to stop session' });
    }
}

function jumpToSession(storeId) {
    if (!storeId) return;

    WidgetManager.close('active-sessions');

    const app = window.app;
    if (!app) return;

    const existing = app.sessionManager.sessions.find(s => s.storeId === storeId);
    if (existing) {
        app.switchToSession(existing);
        return;
    }

    app.loadSessionFromServer(storeId);
}

// ═══════════════════════════════════════════════════════════════════════════
// Formatting Utilities
// ═══════════════════════════════════════════════════════════════════════════

function formatCost(cost) {
    if (!cost) return '$0.00';
    if (cost < 0.01) return `$${cost.toFixed(4)}`;
    return `$${cost.toFixed(2)}`;
}

function formatTimestamp(ts) {
    const d = new Date(ts * 1000);
    return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

function getStatusInfo(status) {
    const map = {
        thinking: { icon: 'brain', class: 'status-thinking', label: S.widgets.active_sessions.statuses.thinking },
        tasks: { icon: 'branch', class: 'status-tasks', label: S.widgets.active_sessions.statuses.tasks },
        tools: { icon: 'tool', class: 'status-tools', label: S.widgets.active_sessions.statuses.tools },
        streaming: { icon: 'activity', class: 'status-streaming', label: S.widgets.active_sessions.statuses.streaming },
        compacting: { icon: 'archive', class: 'status-compacting', label: S.widgets.active_sessions.statuses.compacting },
        idle: { icon: 'pause', class: 'status-idle', label: S.widgets.active_sessions.statuses.idle },
        disconnected: { icon: 'circle', class: 'status-disconnected', label: S.widgets.active_sessions.statuses.disconnected },
        success: { icon: 'check', class: 'status-success', label: S.widgets.active_sessions.statuses.success },
        timeout: { icon: 'clock', class: 'status-timeout', label: S.widgets.active_sessions.statuses.timeout },
        error: { icon: 'alert', class: 'status-error', label: S.widgets.active_sessions.statuses.error },
        killed: { icon: 'x', class: 'status-killed', label: S.widgets.active_sessions.statuses.killed },
    };
    return map[status] || { icon: 'circle', class: 'status-unknown', label: status };
}

// ═══════════════════════════════════════════════════════════════════════════
// Tab Renderers
// ═══════════════════════════════════════════════════════════════════════════

function renderSessionsTab() {
    const runningCount = state.sessions.filter(s => s.is_running && !s.is_idle).length;
    const instanceCount = state.agentInstances.length;

    // Running instances section
    let instancesHtml = '';
    if (instanceCount > 0) {
        instancesHtml = `
            <div class="as-section-header">
                <span class="as-section-icon">${ICONS.brain}</span>
                <span class="as-section-title">Running Now</span>
                <span class="as-section-count">${instanceCount}</span>
            </div>
            <div class="as-instances">
                ${state.agentInstances.map(inst => renderRunningInstance(inst)).join('')}
            </div>
        `;
    }

    // Sessions list
    let sessionsHtml;
    if (state.sessions.length === 0) {
        sessionsHtml = `
            <div class="as-empty">
                <div class="as-empty-icon">${ICONS.server}</div>
                <div class="as-empty-text">No sessions</div>
            </div>
        `;
    } else {
        sessionsHtml = state.sessions.map(s => renderSessionCard(s)).join('');
    }

    return `
        <div class="as-tab-content">
            ${instancesHtml}
            <div class="as-list">${sessionsHtml}</div>
        </div>
    `;
}

function renderRunningInstance(inst) {
    const parentSession = state.sessions.find(s => s.store_id === inst.parent_session_id);
    const parentName = parentSession?.name ||
                       inst.parent_session_id?.slice(0, 8) || 'Unknown';
    const cwdShort = inst.cwd?.split('/').filter(Boolean).pop() || '';

    return `
        <div class="as-instance running" data-pid="${inst.pid}">
            <div class="as-instance-info">
                <div class="as-instance-type">
                    <span class="as-type-badge ${inst.type}">${escapeHtml(inst.type.replace('_', ' '))}</span>
                    <span class="as-instance-model">${escapeHtml(inst.model)}</span>
                </div>
                <div class="as-instance-purpose">${escapeHtml(inst.purpose)}</div>
                <div class="as-instance-meta">
                    <span>PID ${inst.pid}</span>
                    <span>${inst.running_seconds}s</span>
                    ${cwdShort ? `<span data-tooltip="${escapeHtml(inst.cwd)}">${escapeHtml(cwdShort)}</span>` : ''}
                </div>
                ${inst.parent_session_id ? `<div class="as-instance-parent">→ ${escapeHtml(parentName)}</div>` : ''}
            </div>
            <div class="as-instance-status"><div class="as-pulse"></div></div>
        </div>
    `;
}

function renderSessionCard(session) {
    const statusInfo = getStatusInfo(session.status);
    const cwdShort = session.cwd?.split('/').filter(Boolean).pop() || session.cwd;
    const name = session.name || cwdShort || 'Unnamed';
    const promptPreview = session.current_turn?.prompt_preview;

    let toolsSummary = '';
    if (session.current_turn?.tools_summary) {
        const tools = Object.entries(session.current_turn.tools_summary)
            .map(([n, c]) => `${n}×${c}`).join(', ');
        toolsSummary = tools;
    }

    let tasksSummary = '';
    if (session.active_tasks?.length) {
        tasksSummary = session.active_tasks.join(', ');
    }

    return `
        <div class="as-session ${session.is_running ? 'running' : 'idle'}" data-store-id="${session.store_id}">
            <div class="as-session-header">
                <div class="as-status ${statusInfo.class}" data-tooltip="${statusInfo.label}">
                    ${ICONS[statusInfo.icon] || ICONS.circle}
                </div>
                <div class="as-session-info">
                    <div class="as-name">${escapeHtml(name)}</div>
                    <div class="as-cwd" data-tooltip="${escapeHtml(session.cwd || '')}">${escapeHtml(cwdShort)}</div>
                </div>
                <div class="as-session-stats">
                    <div class="as-cost">${formatCost(session.total_cost)}</div>
                    <div class="as-messages">${session.message_count || 0} msgs</div>
                </div>
            </div>
            <div class="as-session-body">
                ${session.is_running ? `
                    <div class="as-meta-row">
                        <span class="as-meta-label">PID:</span>
                        <span class="as-meta-value">${session.process_pid || '-'}</span>
                        <span class="as-meta-label">Turn:</span>
                        <span class="as-meta-value">${session.turn_number || 0}</span>
                        ${session.has_websocket ? '<span class="as-ws-badge">WS</span>' : ''}
                    </div>
                ` : `
                    <div class="as-meta-row">
                        <span class="as-idle-time">${formatRelativeTime(new Date(Date.now() - (session.idle_seconds || 0) * 1000))}</span>
                        ${session.model ? `<span class="as-model">${escapeHtml(session.model)}</span>` : ''}
                    </div>
                `}
                ${promptPreview ? `<div class="as-prompt-preview">"${escapeHtml(promptPreview)}"</div>` : ''}
                ${toolsSummary ? `<div class="as-tools-summary"><span class="as-tools-icon">${ICONS.tool}</span>${escapeHtml(toolsSummary)}</div>` : ''}
                ${tasksSummary ? `<div class="as-tasks-summary"><span class="as-tasks-icon">${ICONS.branch}</span>${escapeHtml(tasksSummary)}</div>` : ''}
            </div>
            <div class="as-session-actions">
                <button class="as-btn as-btn-jump" data-action="jump" data-tooltip="Jump to session">${ICONS.external}</button>
                ${session.is_running ? `<button class="as-btn as-btn-stop" data-action="stop" data-tooltip="Stop">${ICONS.x}</button>` : ''}
            </div>
        </div>
    `;
}

function renderInstancesTab() {
    if (!state.instancesData) {
        return `<div class="as-loading">${ICONS.loader} Loading...</div>`;
    }

    const { active, history } = state.instancesData;
    const hasHistory = (history.today.length + history.yesterday.length +
                       history.this_week.length + history.older.length) > 0;

    // Running instances
    let runningHtml = '';
    if (active.count > 0) {
        runningHtml = `
            <div class="as-history-group">
                <div class="as-history-group-header">
                    <span class="as-pulse-dot"></span>
                    Running Now (${active.count})
                </div>
                ${active.instances.map(inst => renderRunningInstance(inst)).join('')}
            </div>
        `;
    }

    // History groups
    const renderGroup = (title, items) => {
        if (items.length === 0) return '';
        return `
            <div class="as-history-group">
                <div class="as-history-group-header">${title} (${items.length})</div>
                <div class="as-history-items">
                    ${items.map(i => renderHistoryItem(i)).join('')}
                </div>
            </div>
        `;
    };

    const historyHtml = hasHistory ? `
        ${renderGroup('Today', history.today)}
        ${renderGroup('Yesterday', history.yesterday)}
        ${renderGroup('This Week', history.this_week)}
        ${renderGroup('Older', history.older)}
    ` : `
        <div class="as-empty">
            <div class="as-empty-icon">${ICONS.archive}</div>
            <div class="as-empty-text">No history yet</div>
            <div class="as-empty-hint">Completed processes will appear here</div>
        </div>
    `;

    return `
        <div class="as-tab-content as-instances-tab">
            ${runningHtml}
            ${historyHtml}
        </div>
    `;
}

function renderHistoryItem(item) {
    const statusInfo = getStatusInfo(item.status);
    const time = formatTimestamp(item.completed_at);
    const parentSession = state.sessions.find(s => s.store_id === item.parent_session_id);
    const parentName = parentSession?.name ||
                       item.parent_session_id?.slice(0, 8) || '';

    return `
        <div class="as-history-item ${item.status}">
            <div class="as-history-status ${statusInfo.class}" data-tooltip="${statusInfo.label}">
                ${ICONS[statusInfo.icon] || ICONS.circle}
            </div>
            <div class="as-history-time">${time}</div>
            <div class="as-history-info">
                <span class="as-type-badge ${item.type}">${item.type.replace('_', ' ')}</span>
                <span class="as-history-duration">${formatDuration((item.duration || 0) * 1000)}</span>
                ${item.cost ? `<span class="as-history-cost">${formatCost(item.cost)}</span>` : ''}
            </div>
            ${item.result_preview ? `<div class="as-history-preview">${escapeHtml(item.result_preview)}</div>` : ''}
            ${item.error_message ? `<div class="as-history-error">${escapeHtml(item.error_message)}</div>` : ''}
            ${parentName ? `<div class="as-history-parent">→ ${escapeHtml(parentName)}</div>` : ''}
        </div>
    `;
}

function renderStatsTab() {
    if (!state.instancesData?.stats) {
        return `<div class="as-loading">${ICONS.loader} Loading...</div>`;
    }

    const stats = state.instancesData.stats;
    const hasData = stats.total_count > 0;

    if (!hasData) {
        return `
            <div class="as-tab-content">
                <div class="as-empty">
                    <div class="as-empty-icon">${ICONS.barChart}</div>
                    <div class="as-empty-text">No statistics yet</div>
                    <div class="as-empty-hint">Stats will appear after some processes complete</div>
                </div>
            </div>
        `;
    }

    // Summary cards
    const summaryHtml = `
        <div class="as-stats-summary">
            <div class="as-stat-card">
                <div class="as-stat-value">${stats.total_count}</div>
                <div class="as-stat-label">Total (24h)</div>
            </div>
            <div class="as-stat-card success">
                <div class="as-stat-value">${stats.success_rate}%</div>
                <div class="as-stat-label">Success Rate</div>
            </div>
            <div class="as-stat-card">
                <div class="as-stat-value">${formatDuration((stats.avg_duration || 0) * 1000)}</div>
                <div class="as-stat-label">Avg Duration</div>
            </div>
            <div class="as-stat-card cost">
                <div class="as-stat-value">${formatCost(stats.total_cost)}</div>
                <div class="as-stat-label">Total Cost</div>
            </div>
        </div>
    `;

    // Status breakdown
    const statusHtml = `
        <div class="as-stats-section">
            <div class="as-stats-section-title">Status Breakdown</div>
            <div class="as-status-bars">
                ${renderStatusBar('Success', stats.success_count, stats.total_count, 'success')}
                ${renderStatusBar('Timeout', stats.timeout_count, stats.total_count, 'timeout')}
                ${renderStatusBar('Error', stats.error_count, stats.total_count, 'error')}
                ${renderStatusBar('Killed', stats.killed_count, stats.total_count, 'killed')}
            </div>
        </div>
    `;

    // Type breakdown
    const typeBreakdown = Object.entries(stats.by_type || {}).map(([type, data]) => `
        <div class="as-type-stat">
            <span class="as-type-badge ${type}">${type.replace('_', ' ')}</span>
            <span class="as-type-count">${data.count}×</span>
            <span class="as-type-avg">${formatDuration((data.avg_duration || 0) * 1000)} avg</span>
            <span class="as-type-cost">${formatCost(data.cost)}</span>
        </div>
    `).join('');

    const typeHtml = typeBreakdown ? `
        <div class="as-stats-section">
            <div class="as-stats-section-title">By Type</div>
            <div class="as-type-stats">${typeBreakdown}</div>
        </div>
    ` : '';

    // Tokens
    const tokensHtml = (stats.total_input_tokens || stats.total_output_tokens) ? `
        <div class="as-stats-section">
            <div class="as-stats-section-title">Token Usage</div>
            <div class="as-tokens-stats">
                <div class="as-token-stat">
                    <span class="as-token-value">${(stats.total_input_tokens || 0).toLocaleString()}</span>
                    <span class="as-token-label">↓ Input</span>
                </div>
                <div class="as-token-stat">
                    <span class="as-token-value">${(stats.total_output_tokens || 0).toLocaleString()}</span>
                    <span class="as-token-label">↑ Output</span>
                </div>
            </div>
        </div>
    ` : '';

    return `
        <div class="as-tab-content as-stats-tab">
            ${summaryHtml}
            ${statusHtml}
            ${typeHtml}
            ${tokensHtml}
        </div>
    `;
}

function renderStatusBar(label, count, total, statusClass) {
    const pct = total > 0 ? (count / total * 100).toFixed(1) : 0;
    if (count === 0) return '';
    return `
        <div class="as-status-bar-row">
            <span class="as-status-bar-label">${label}</span>
            <div class="as-status-bar">
                <div class="as-status-bar-fill ${statusClass}" style="width: ${pct}%"></div>
            </div>
            <span class="as-status-bar-value">${count}</span>
        </div>
    `;
}

// ═══════════════════════════════════════════════════════════════════════════
// Main Render
// ═══════════════════════════════════════════════════════════════════════════

function renderContent() {
    const container = state.currentContainer;
    if (!container) return;

    const runningCount = state.sessions.filter(s => s.is_running && !s.is_idle).length;
    const instanceCount = state.agentInstances.length;
    const historyCount = state.instancesData?.history_total || 0;

    // Tab content
    let tabContent;
    if (state.loading && !state.sessions.length && !state.instancesData) {
        tabContent = `<div class="as-loading">${ICONS.loader} Loading...</div>`;
    } else if (state.error) {
        tabContent = `<div class="as-error">${escapeHtml(state.error)}</div>`;
    } else {
        switch (state.activeTab) {
            case 'sessions':
                tabContent = renderSessionsTab();
                break;
            case 'instances':
                tabContent = renderInstancesTab();
                break;
            case 'stats':
                tabContent = renderStatsTab();
                break;
        }
    }

    container.innerHTML = `
        <div class="active-sessions-widget">
            <div class="as-tabs">
                <button class="as-tab ${state.activeTab === 'sessions' ? 'active' : ''}" data-tab="sessions">
                    Sessions
                    ${runningCount > 0 ? `<span class="as-tab-badge running">${runningCount}</span>` : ''}
                </button>
                <button class="as-tab ${state.activeTab === 'instances' ? 'active' : ''}" data-tab="instances">
                    Instances
                    ${instanceCount > 0 ? `<span class="as-tab-badge running">${instanceCount}</span>` : ''}
                    ${historyCount > 0 ? `<span class="as-tab-badge history">${historyCount}</span>` : ''}
                </button>
                <button class="as-tab ${state.activeTab === 'stats' ? 'active' : ''}" data-tab="stats">
                    Stats
                </button>
                <label class="as-auto-refresh-mini">
                    <input type="checkbox" ${state.autoRefresh ? 'checked' : ''} />
                    Auto
                </label>
            </div>
            ${tabContent}
        </div>
    `;

    attachEventListeners(container);
}

function attachEventListeners(container) {
    // Tab switching
    container.querySelectorAll('.as-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            state.activeTab = tab.dataset.tab;
            renderContent();
        });
    });

    // Auto-refresh toggle
    const checkbox = container.querySelector('.as-auto-refresh-mini input');
    if (checkbox) {
        checkbox.addEventListener('change', (e) => {
            state.autoRefresh = e.target.checked;
        });
    }

    // Session actions
    container.querySelectorAll('.as-session').forEach(item => {
        const storeId = item.dataset.storeId;

        item.querySelector('[data-action="jump"]')?.addEventListener('click', () => jumpToSession(storeId));
        item.querySelector('[data-action="stop"]')?.addEventListener('click', (e) => stopSession(storeId, e.target.closest('button')));
        item.addEventListener('click', (e) => {
            if (!e.target.closest('button')) jumpToSession(storeId);
        });
    });
}

// ═══════════════════════════════════════════════════════════════════════════
// Header Badge Management
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Update the Active Sessions header button badges.
 * - Orange badge (top-right): Running main sessions count
 * - Purple badge (bottom-right): Running summary fork count
 */
function updateHeaderBadges(sessionsData, instancesData) {
    const sessionsBadge = document.getElementById('sessions-badge');
    const summaryBadge = document.getElementById('summary-badge');

    if (!sessionsBadge || !summaryBadge) return;

    // Count actively processing sessions (not idle)
    const runningCount = (sessionsData?.sessions || []).filter(s => s.is_running && !s.is_idle).length;

    // Count running Summary forks from instances data
    const summariesRunning = (instancesData?.active?.instances || [])
        .filter(inst => inst.type === 'summary_fork').length;

    // Update badges (empty string hides via CSS :empty selector)
    sessionsBadge.textContent = runningCount > 0 ? runningCount : '';
    summaryBadge.textContent = summariesRunning > 0 ? summariesRunning : '';
}

// ═══════════════════════════════════════════════════════════════════════════
// Global Poll (for background sync when widget closed)
// ═══════════════════════════════════════════════════════════════════════════

async function globalPoll() {
    try {
        // Fetch both endpoints in parallel
        const [sessionsRes, instancesRes] = await Promise.all([
            fetch(`${CONFIG.API_BASE}/api/active-sessions`),
            fetch(`${CONFIG.API_BASE}/api/agent-instances`)
        ]);

        if (!sessionsRes.ok || !instancesRes.ok) return;
        const sessionsData = await sessionsRes.json();
        const instancesData = await instancesRes.json();

        syncProcessStatesToSessions(sessionsData);
        updateHeaderBadges(sessionsData, instancesData);
    } catch (error) {
        // Silent fail for background poll
    }
}

function startGlobalPoll() {
    if (globalPollInterval) return;
    globalPollInterval = setInterval(globalPoll, GLOBAL_POLL_INTERVAL_MS);
    globalPoll();  // Immediate first poll
}

function stopGlobalPoll() {
    if (globalPollInterval) {
        clearInterval(globalPollInterval);
        globalPollInterval = null;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Widget Registration
// ═══════════════════════════════════════════════════════════════════════════

export function registerActiveSessionsWidget() {
    WidgetManager.register('active-sessions', {
        type: 'floating',
        title: S.widgets.titles.active_sessions,
        icon: 'activity',
        scope: 'global',
        shortcut: 'Alt+S',

        deviceTypes: {
            default: 'floating',
            phone: 'bottom-sheet',
        },

        // No explicit position: floating widgets spawn top-right by default,
        // recomputed from the live viewport on every open.
        size: {
            width: 400,
            height: 500
        },
        minSize: { width: 340, height: 300 },

        render(container, ctx) {
            state.currentContainer = container;
            state.activeTab = 'sessions';  // Reset to sessions tab on open
            loadData();
            state.startAutoRefresh();
            stopGlobalPoll();  // Stop global poll when widget is open
        },

        onClose() {
            state.stopAutoRefresh();
            state.currentContainer = null;
            startGlobalPoll();  // Resume global poll when closed
        }
    });

    // Start global poll immediately for background sync
    startGlobalPoll();
}

// Export state and poll function for external access
export { state as activeSessionsState, startGlobalPoll };
