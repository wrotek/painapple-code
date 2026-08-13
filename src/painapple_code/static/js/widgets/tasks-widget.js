/**
 * Background Tasks Widget
 *
 * Lists all background tasks, shows live output, provides task management.
 * Integrates with BackgroundTaskTracker for client-side state and
 * /api/tasks for server-side file reading.
 */

import { escapeHtml, escapeAttr, formatSize } from '../utils.js';
import { CONFIG } from '../config.js';
import { WidgetManager, WidgetBus } from '../widget-system/index.js';
import { bgTaskTracker, fetchTaskList, fetchTaskOutput } from '../background-tasks.js';
import S from '../strings.js';

// ── State ──────────────────────────────────────────────────────────────

const state = {
    currentContainer: null,
    view: 'list',          // 'list' | 'detail'
    selectedTaskId: null,
    tasks: [],             // From server API
    refreshInterval: null,
    detailInterval: null,
    detailOffset: 0,
    detailContent: '',
};

// ── Helpers ────────────────────────────────────────────────────────────

function formatElapsed(ms) {
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const rs = s % 60;
    if (m < 60) return `${m}m ${rs}s`;
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
}

function formatAge(mtime) {
    const ago = Date.now() / 1000 - mtime;
    if (ago < 60) return 'just now';
    if (ago < 3600) return `${Math.floor(ago / 60)}m ago`;
    if (ago < 86400) return `${Math.floor(ago / 3600)}h ago`;
    return `${Math.floor(ago / 86400)}d ago`;
}

/** Simple ANSI → HTML converter for widget output */
function ansiToHtml(text) {
    const COLORS = {
        '30': '#6e7681', '31': '#f85149', '32': '#3fb950', '33': '#d29922',
        '34': '#58a6ff', '35': '#bc8cff', '36': '#39c5cf', '37': '#c9d1d9',
        '90': '#6e7681', '91': '#f85149', '92': '#3fb950', '93': '#d29922',
        '94': '#58a6ff', '95': '#bc8cff', '96': '#39c5cf', '97': '#f0f6fc',
    };

    let html = escapeHtml(text);
    // Replace ANSI escapes with spans
    html = html.replace(/\x1b\[([0-9;]+)m/g, (_, codes) => {
        const parts = codes.split(';');
        const spans = [];
        for (const code of parts) {
            if (code === '0') spans.push('</span>');
            else if (code === '1') spans.push('<span style="font-weight:bold">');
            else if (COLORS[code]) spans.push(`<span style="color:${COLORS[code]}">`);
        }
        return spans.join('');
    });
    return html;
}

function copyToClipboard(text) {
    navigator.clipboard.writeText(text).catch(() => {});
}

// ── Rendering ──────────────────────────────────────────────────────────

function render() {
    if (!state.currentContainer) return;

    if (state.view === 'detail' && state.selectedTaskId) {
        renderDetail();
    } else {
        renderList();
    }
}

async function renderList() {
    if (!state.currentContainer) return;

    // Merge server tasks with client-tracked tasks
    const serverTasks = await fetchTaskList();
    state.tasks = serverTasks;

    // Also get client-side tracked tasks for running status
    const tracked = bgTaskTracker.getAll();
    const trackedMap = new Map(tracked.map(t => [t.taskId, t]));

    const running = serverTasks.filter(t => t.is_running);
    const completed = serverTasks.filter(t => !t.is_running);

    const summaryHtml = `
        <div class="bt-summary">
            ${running.length > 0 ? `<span class="bt-summary-badge bt-summary-running">
                <span class="bg-task-pulse"></span> ${running.length} running
            </span>` : ''}
            <span class="bt-summary-badge bt-summary-done">${completed.length} completed</span>
        </div>
    `;

    if (serverTasks.length === 0) {
        state.currentContainer.innerHTML = `
            <div class="bt-container">
                ${summaryHtml}
                <div class="bt-empty">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="40" height="40">
                        <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
                    </svg>
                    <div>No background tasks</div>
                    <div style="font-size: 11px; opacity: 0.6">Tasks appear when Claude runs commands with run_in_background</div>
                </div>
            </div>`;
        return;
    }

    // Sort: running first, then by modified time (newest first)
    const sorted = [...serverTasks].sort((a, b) => {
        if (a.is_running !== b.is_running) return a.is_running ? -1 : 1;
        return b.modified - a.modified;
    });

    const itemsHtml = sorted.map(task => {
        const clientTask = trackedMap.get(task.id);
        const isRunning = task.is_running;
        const elapsed = clientTask ? formatElapsed(clientTask.elapsed) : formatAge(task.modified);
        const preview = task.preview
            ? escapeHtml(task.preview.split('\n').pop().trim().slice(0, 80))
            : '';

        return `
            <div class="bt-item" data-task-id="${escapeAttr(task.id)}" data-act="bt-select-task">
                <div class="bt-item-status">
                    <div class="bt-item-status-dot ${isRunning ? 'running' : 'done'}"></div>
                </div>
                <div class="bt-item-body">
                    <div class="bt-item-cmd">${escapeHtml(task.id)}</div>
                    <div class="bt-item-meta">
                        <span>${formatSize(task.size)}</span>
                        <span>${elapsed}</span>
                    </div>
                    ${preview ? `<div class="bt-item-preview">${preview}</div>` : ''}
                </div>
            </div>
        `;
    }).join('');

    state.currentContainer.innerHTML = `
        <div class="bt-container">
            ${summaryHtml}
            <div class="bt-list">${itemsHtml}</div>
        </div>`;
}

async function renderDetail() {
    if (!state.currentContainer || !state.selectedTaskId) return;

    const taskId = state.selectedTaskId;
    const isTracked = bgTaskTracker.tasks?.has(taskId);

    // Fetch full output
    const data = await fetchTaskOutput(taskId);
    if (!data) {
        state.view = 'list';
        render();
        return;
    }

    state.detailContent = data.content || '';
    const isRunning = data.is_running;

    const badge = isRunning
        ? '<span class="bg-task-badge bg-task-badge-running"><span class="bg-task-pulse"></span> Running</span>'
        : '<span class="bg-task-badge bg-task-badge-done"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="10" height="10"><polyline points="20 6 9 17 4 12"/></svg> Done</span>';

    // Process output with ANSI colors
    const outputHtml = state.detailContent
        ? ansiToHtml(state.detailContent)
        : '<span style="color: var(--text-muted); font-style: italic">No output yet...</span>';

    state.currentContainer.innerHTML = `
        <div class="bt-detail">
            <div class="bt-detail-header">
                <button class="bt-back-btn" data-act="bt-back">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
                        <path d="M19 12H5"/><polyline points="12 19 5 12 12 5"/>
                    </svg>
                    Back
                </button>
                <span class="bt-detail-title">${escapeHtml(taskId)}</span>
                <div class="bt-detail-badge">${badge}</div>
            </div>
            <div class="bt-detail-output" id="bt-detail-output">
                <pre>${outputHtml}</pre>
            </div>
            <div class="bt-detail-footer">
                <span>${formatSize(data.size)}</span>
                <button data-act="bt-copy-output">Copy Output</button>
            </div>
        </div>`;

    // Auto-scroll to bottom
    const outputEl = document.getElementById('bt-detail-output');
    if (outputEl) {
        outputEl.scrollTop = outputEl.scrollHeight;
    }

    // Set up detail polling if running
    if (isRunning && !state.detailInterval) {
        state.detailOffset = data.offset;
        state.detailInterval = setInterval(() => pollDetail(), 500);
    } else if (!isRunning && state.detailInterval) {
        clearInterval(state.detailInterval);
        state.detailInterval = null;
    }
}

async function pollDetail() {
    if (!state.selectedTaskId) return;

    try {
        const res = await fetch(
            `${CONFIG.API_BASE}/api/tasks/${state.selectedTaskId}?offset=${state.detailOffset}`
        );
        if (!res.ok) return;
        const data = await res.json();

        if (data.content) {
            state.detailContent += data.content;
            state.detailOffset = data.offset;

            // Update output area incrementally
            const outputEl = document.getElementById('bt-detail-output');
            if (outputEl) {
                const pre = outputEl.querySelector('pre');
                if (pre) {
                    pre.innerHTML = ansiToHtml(state.detailContent);
                }
                // Auto-scroll if near bottom
                const isNearBottom = outputEl.scrollHeight - outputEl.scrollTop - outputEl.clientHeight < 100;
                if (isNearBottom) {
                    outputEl.scrollTop = outputEl.scrollHeight;
                }
            }
        }

        if (!data.is_running) {
            // Task completed — update badge and stop polling
            if (state.detailInterval) {
                clearInterval(state.detailInterval);
                state.detailInterval = null;
            }
            const badgeEl = state.currentContainer?.querySelector('.bt-detail-badge');
            if (badgeEl) {
                badgeEl.innerHTML = '<span class="bg-task-badge bg-task-badge-done"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="10" height="10"><polyline points="20 6 9 17 4 12"/></svg> Done</span>';
            }
        }
    } catch {
        // Silent fail
    }
}

// ── Widget API (exposed via window for onclick handlers) ───────────────

const widgetApi = {
    selectTask(taskId) {
        state.selectedTaskId = taskId;
        state.view = 'detail';
        state.detailOffset = 0;
        state.detailContent = '';
        renderDetail();
    },

    backToList() {
        if (state.detailInterval) {
            clearInterval(state.detailInterval);
            state.detailInterval = null;
        }
        state.view = 'list';
        state.selectedTaskId = null;
        renderList();
    },

    copyOutput() {
        copyToClipboard(state.detailContent);
    },

    focusTask(taskId) {
        // Called from inline card "View Full Output" button
        state.selectedTaskId = taskId;
        state.view = 'detail';
        state.detailOffset = 0;
        state.detailContent = '';
        if (state.currentContainer) {
            renderDetail();
        }
    }
};

window._btWidget = widgetApi;

// ── Auto-refresh ───────────────────────────────────────────────────────

function startAutoRefresh() {
    stopAutoRefresh();
    state.refreshInterval = setInterval(() => {
        if (state.view === 'list') {
            renderList();
        }
    }, 3000);
}

function stopAutoRefresh() {
    if (state.refreshInterval) {
        clearInterval(state.refreshInterval);
        state.refreshInterval = null;
    }
    if (state.detailInterval) {
        clearInterval(state.detailInterval);
        state.detailInterval = null;
    }
}

// ── Registration ───────────────────────────────────────────────────────

export function registerTasksWidget() {
    WidgetManager.register('background-tasks', {
        type: 'floating',
        title: S.widgets.titles.background_tasks,
        icon: 'terminal',
        scope: 'global',

        deviceTypes: {
            default: 'floating',
            phone: 'bottom-sheet',
        },

        // No explicit position: floating widgets spawn top-right by default,
        // recomputed from the live viewport on every open.
        size: { width: 480, height: 500 },
        minSize: { width: 340, height: 300 },
        resizable: true,

        headerActions: [
            {
                icon: 'refresh',
                title: S.widgets.header_actions.refresh,
                onClick: () => render()
            }
        ],

        render(container, ctx) {
            state.currentContainer = container;
            state.view = 'list';
            state.selectedTaskId = null;
            renderList();
            startAutoRefresh();
        },

        onClose() {
            stopAutoRefresh();
            state.currentContainer = null;
        }
    });

    // Listen for focus events from inline cards
    WidgetBus.on('background-task:focus', ({ taskId }) => {
        widgetApi.focusTask(taskId);
    });
}
