/**
 * Sub-Agents Widget — runtime monitor.
 *
 * Shows running and completed sub-agents (Task tool invocations) with detailed
 * tool activity logs. Collects child tool calls from session.messages via
 * parentTaskId linkage. Auto-refreshes while open.
 *
 * Distinct from the Agents widget (`agents-widget.js`), which manages agent
 * *definition* files (`~/.claude/agents/*.md`).
 */

import { escapeHtml, formatDuration } from '../utils.js';
import { WidgetManager } from '../widget-system/index.js';
import S from '../strings.js';

// ── State ──────────────────────────────────────────────────────────────

const state = {
    currentContainer: null,
    refreshInterval: null,
    expandedAgents: new Set(),  // toolUseIds of expanded agent cards
};

// ── Helpers ────────────────────────────────────────────────────────────

function formatTokens(n) {
    if (n < 1000) return `${n}`;
    if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
    return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Extract a short label from tool input (file path, command, pattern, etc.) */
function toolLabel(toolName, toolInput) {
    if (!toolInput) return '';
    const fp = toolInput.file_path || toolInput.path || '';
    if (fp) {
        // Show just filename or last 2 path segments
        const parts = fp.split('/').filter(Boolean);
        return parts.length > 2 ? parts.slice(-2).join('/') : fp;
    }
    if (toolInput.command) {
        const cmd = toolInput.command.trim();
        return cmd.length > 60 ? cmd.slice(0, 57) + '...' : cmd;
    }
    if (toolInput.pattern) return toolInput.pattern;
    if (toolInput.query) {
        const q = toolInput.query;
        return q.length > 50 ? q.slice(0, 47) + '...' : q;
    }
    if (toolInput.url) {
        try { return new URL(toolInput.url).hostname + '...'; } catch { return toolInput.url.slice(0, 50); }
    }
    if (toolInput.content && typeof toolInput.content === 'string') return 'writing...';
    if (toolInput.description) {
        const d = toolInput.description;
        return d.length > 50 ? d.slice(0, 47) + '...' : d;
    }
    return '';
}

const TOOL_ICONS = {
    Read: '📄', Edit: '✏️', Write: '📝', Bash: '⚡', Grep: '🔍', Glob: '📁',
    WebFetch: '🌐', WebSearch: '🔎', Agent: '🤖', Task: '🤖',
    NotebookEdit: '📓', AskUserQuestion: '❓',
};

function toolIcon(name) {
    return TOOL_ICONS[name] || '🔧';
}

// ── Data collection ───────────────────────────────────────────────────

/**
 * Build indexes for agent data in a single O(n) pass over session.messages.
 * Returns { childTools: Map<parentId, tool[]>, agentMsgs: Map<toolId, msg> }
 */
function buildAgentIndex(session) {
    const childTools = new Map();  // parentTaskId → child tool messages
    const agentMsgs = new Map();   // toolId → Task tool_use message

    for (const msg of session.messages) {
        if (msg.role === 'tool') {
            if (msg.parentTaskId) {
                let arr = childTools.get(msg.parentTaskId);
                if (!arr) { arr = []; childTools.set(msg.parentTaskId, arr); }
                arr.push(msg);
            }
            if (msg.toolName === 'Task') {
                agentMsgs.set(msg.toolId, msg);
            }
        }
        if (msg.role === 'thinking' && msg.tools) {
            for (const t of msg.tools) {
                if (t.parentTaskId) {
                    let arr = childTools.get(t.parentTaskId);
                    if (!arr) { arr = []; childTools.set(t.parentTaskId, arr); }
                    arr.push(t);
                }
                if (t.toolName === 'Task') {
                    agentMsgs.set(t.toolId, t);
                }
            }
        }
    }
    return { childTools, agentMsgs };
}

// ── Rendering ──────────────────────────────────────────────────────────

function renderToolRow(tool) {
    const name = tool.toolName || 'Unknown';
    const label = toolLabel(name, tool.toolInput);
    const done = tool.toolCompleted;
    const hasError = tool.toolError;
    const statusCls = hasError ? 'error' : done ? 'done' : 'pending';
    const icon = toolIcon(name);

    return `<div class="agent-tool-row ${statusCls}">
        <span class="agent-tool-icon">${icon}</span>
        <span class="agent-tool-name">${escapeHtml(name)}</span>
        ${label ? `<span class="agent-tool-label">${escapeHtml(label)}</span>` : ''}
        <span class="agent-tool-status ${statusCls}">${hasError ? '✗' : done ? '✓' : '⋯'}</span>
    </div>`;
}

function renderAgentCard(agent, isRunning, index) {
    const P = S.agent_progress.widget;
    const agentId = agent.id || agent.toolUseId;
    const expanded = state.expandedAgents.has(agentId);
    const tools = index.childTools.get(agentId) || [];
    const agentMsg = index.agentMsgs.get(agentId) || null;

    // Duration
    let elapsed;
    if (isRunning) {
        elapsed = formatDuration(Date.now() - (agent.lastUpdate - agent.durationMs));
    } else {
        elapsed = formatDuration(agent.durationMs);
    }

    // Status classes
    const statusCls = isRunning ? (agent.stalled ? 'stalled' : 'running') : 'completed';
    const dotCls = isRunning ? 'running' : 'done';

    // Stats line
    const toolCount = isRunning ? agent.toolCount : (agent.toolCount || tools.length);
    const tokens = isRunning ? agent.totalTokens : (agent.totalTokens || 0);

    // Agent result (for completed agents with output)
    let resultPreview = '';
    if (!isRunning && agentMsg?.toolOutput) {
        const raw = typeof agentMsg.toolOutput === 'string'
            ? agentMsg.toolOutput
            : JSON.stringify(agentMsg.toolOutput);
        // Strip usage tags and take first ~200 chars
        const cleaned = raw.replace(/<usage>[\s\S]*?<\/usage>/g, '').trim();
        if (cleaned) {
            const preview = cleaned.slice(0, 200);
            resultPreview = `<div class="agent-result-preview">${escapeHtml(preview)}${cleaned.length > 200 ? '...' : ''}</div>`;
        }
    }

    // Tool activity log (when expanded)
    let toolsHtml = '';
    if (expanded && tools.length > 0) {
        toolsHtml = `<div class="agent-tools-log">${tools.map(renderToolRow).join('')}</div>`;
    } else if (expanded && tools.length === 0) {
        toolsHtml = `<div class="agent-tools-log"><div class="agent-tools-empty">${P.no_tools_yet}</div></div>`;
    }

    // Currently active tool (for running agents, show inline even when collapsed)
    let activeToolHtml = '';
    if (isRunning && agent.lastToolName && !expanded) {
        activeToolHtml = `<div class="agent-active-tool">${toolIcon(agent.lastToolName)} ${escapeHtml(agent.lastToolName)}</div>`;
    }

    const expandIcon = expanded ? '▾' : '▸';
    const hasContent = tools.length > 0 || resultPreview;

    return `<div class="sub-agents-item ${statusCls}" data-agent-id="${agentId}">
        <div class="agents-item-header" data-agent-toggle="${agentId}">
            <div class="agents-item-dot ${dotCls}"></div>
            <div class="agents-item-body">
                <div class="agents-item-title">
                    <span class="agents-item-desc">${escapeHtml(agent.description || 'Agent')}</span>
                    <span class="agents-item-stats">
                        <span>${toolCount} ${P.tools_label}</span>
                        <span>${elapsed}</span>
                        ${tokens ? `<span>${formatTokens(tokens)} tok</span>` : ''}
                    </span>
                </div>
                ${activeToolHtml}
            </div>
            ${hasContent ? `<span class="agents-expand">${expandIcon}</span>` : ''}
        </div>
        ${expanded ? resultPreview : ''}
        ${toolsHtml}
    </div>`;
}

function render() {
    if (!state.currentContainer) return;

    const session = window.app?.activeSession;
    if (!session) {
        state.currentContainer.innerHTML = `<div class="agents-empty">No active session</div>`;
        return;
    }

    const running = [];
    for (const [id, p] of session._agentProgress) {
        running.push({ id, ...p });
    }
    const completed = session._completedAgents || [];

    if (running.length === 0 && completed.length === 0) {
        const P = S.agent_progress.widget;
        state.currentContainer.innerHTML = `
            <div class="agents-container">
                <div class="agents-empty">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="36" height="36">
                        <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
                        <rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>
                    </svg>
                    <div>${P.no_agents}</div>
                    <div class="agents-empty-hint">${P.no_agents_hint}</div>
                </div>
            </div>`;
        return;
    }

    const P = S.agent_progress.widget;

    // Summary badges
    let summaryHtml = '<div class="agents-summary">';
    if (running.length > 0) {
        summaryHtml += `<span class="agents-summary-badge agents-summary-badge-running"><span class="agents-pulse"></span> ${running.length} ${P.running}</span>`;
    }
    if (completed.length > 0) {
        summaryHtml += `<span class="agents-summary-badge agents-summary-badge-done">${completed.length} ${P.completed}</span>`;
    }
    summaryHtml += '</div>';

    // Build index once — O(n) scan, then O(1) lookups per agent
    const index = buildAgentIndex(session);

    // Running agents first, then completed (newest first)
    let cardsHtml = '';
    for (const a of running) {
        cardsHtml += renderAgentCard(a, true, index);
    }
    const sortedCompleted = [...completed].reverse();
    for (const a of sortedCompleted) {
        cardsHtml += renderAgentCard(a, false, index);
    }

    state.currentContainer.innerHTML = `
        <div class="agents-container">
            ${summaryHtml}
            <div class="agents-list">${cardsHtml}</div>
        </div>`;
}

function handleClick(e) {
    const toggle = e.target.closest('[data-agent-toggle]');
    if (!toggle) return;
    const agentId = toggle.dataset.agentToggle;
    if (state.expandedAgents.has(agentId)) {
        state.expandedAgents.delete(agentId);
    } else {
        state.expandedAgents.add(agentId);
    }
    render();
}

// ── Auto-refresh ───────────────────────────────────────────────────────

function startAutoRefresh() {
    stopAutoRefresh();
    state.refreshInterval = setInterval(render, 2000);
}

function stopAutoRefresh() {
    if (state.refreshInterval) {
        clearInterval(state.refreshInterval);
        state.refreshInterval = null;
    }
}

// ── Registration ───────────────────────────────────────────────────────

export function registerSubAgentsWidget() {
    WidgetManager.register('sub-agents', {
        type: 'floating',
        title: S.widgets.titles.sub_agents,
        icon: 'grid',
        scope: 'session',

        deviceTypes: {
            default: 'floating',
            phone: 'bottom-sheet',
        },

        // No explicit position: floating widgets spawn top-right by default,
        // recomputed from the live viewport on every open.
        size: { width: 400, height: 450 },
        minSize: { width: 320, height: 280 },
        resizable: true,

        headerActions: [
            {
                icon: 'refresh',
                title: S.widgets.header_actions.refresh,
                onClick: () => render()
            }
        ],

        render(container) {
            state.currentContainer = container;
            container.addEventListener('click', handleClick);
            render();
            startAutoRefresh();
        },

        onClose() {
            stopAutoRefresh();
            if (state.currentContainer) {
                state.currentContainer.removeEventListener('click', handleClick);
            }
            state.currentContainer = null;
        }
    });
}
