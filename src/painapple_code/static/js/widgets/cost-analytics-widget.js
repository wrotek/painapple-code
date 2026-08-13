/**
 * Cost Analytics Widget - Comprehensive cost breakdown and analysis
 *
 * Shows:
 * - Total cost summary with key metrics
 * - Model breakdown (Opus/Sonnet/Haiku)
 * - Tool cost attribution
 * - Session cost ranking
 * - Temporal trends
 * - Efficiency metrics
 */

import S from '../strings.js';
import { escapeHtml } from '../utils.js';
import { CONFIG } from '../config.js';
import { WidgetManager, ICONS } from '../widget-system/index.js';

/**
 * Widget state
 */
class CostAnalyticsState {
    constructor() {
        this.summary = null;
        this.tools = null;
        this.sessions = null;
        this.trends = null;
        this.efficiency = null;
        this.activeTab = 'overview';
        this.loading = false;
        this.error = null;
        this.container = null;
        this.selectedProject = null;
        this.daysFilter = 1; // 0 = all time, else last N days (default: today)
    }
}

const state = new CostAnalyticsState();

/**
 * Format currency
 */
function formatCost(value, decimals = 2) {
    if (value === undefined || value === null) return '$0.00';
    if (value >= 1000) return `$${(value / 1000).toFixed(1)}k`;
    if (value >= 100) return `$${value.toFixed(0)}`;
    if (value >= 1) return `$${value.toFixed(decimals)}`;
    return `$${value.toFixed(4)}`;
}

/**
 * Format large numbers
 */
function formatNumber(value) {
    if (value >= 1000000) return `${(value / 1000000).toFixed(1)}M`;
    if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
    return value.toString();
}

/**
 * Format percentage
 */
function formatPct(value) {
    return `${value.toFixed(1)}%`;
}

/**
 * Create a simple bar for percentages
 */
function createBar(pct, color = 'var(--accent)') {
    const width = Math.min(100, Math.max(0, pct));
    return `<div class="cost-bar" style="--bar-width: ${width}%; --bar-color: ${color}"></div>`;
}

/**
 * Build query string for filters
 */
function buildQueryString(extra = {}) {
    const params = new URLSearchParams();
    if (state.selectedProject) params.set('project', state.selectedProject);
    if (state.daysFilter > 0) {
        const since = new Date();
        since.setDate(since.getDate() - state.daysFilter);
        params.set('since', since.toISOString().split('T')[0]);
    }
    Object.entries(extra).forEach(([k, v]) => params.set(k, v));
    const qs = params.toString();
    return qs ? `?${qs}` : '';
}

/**
 * Load all cost data
 */
async function loadData() {
    state.loading = true;
    state.error = null;
    renderContent();

    try {
        const baseParams = buildQueryString();
        const trendDays = state.daysFilter > 0 ? Math.min(state.daysFilter, 30) : 14;

        // Load all data in parallel
        const [summaryRes, toolsRes, sessionsRes, trendsRes, efficiencyRes] = await Promise.all([
            fetch(`${CONFIG.API_BASE}/api/costs${baseParams}`),
            fetch(`${CONFIG.API_BASE}/api/costs/tools${baseParams}`),
            fetch(`${CONFIG.API_BASE}/api/costs/sessions${buildQueryString({ limit: '10' })}`),
            fetch(`${CONFIG.API_BASE}/api/costs/trends${buildQueryString({ period: 'daily', days: trendDays.toString() })}`),
            fetch(`${CONFIG.API_BASE}/api/costs/efficiency${baseParams}`),
        ]);

        state.summary = await summaryRes.json();
        state.tools = await toolsRes.json();
        state.sessions = await sessionsRes.json();
        state.trends = await trendsRes.json();
        state.efficiency = await efficiencyRes.json();
        state.loading = false;
        renderContent();
    } catch (error) {
        console.error('Failed to load cost data:', error);
        state.loading = false;
        state.error = 'Failed to load cost data';
        renderContent();
    }
}

/**
 * Render filter bar
 */
function renderFilterBar() {
    const periods = [
        { value: 0, label: S.widgets.cost_analytics.time_ranges[0].label },
        { value: 1, label: S.widgets.cost_analytics.time_ranges[1].label },
        { value: 7, label: S.widgets.cost_analytics.time_ranges[2].label },
        { value: 14, label: S.widgets.cost_analytics.time_ranges[3].label },
        { value: 30, label: S.widgets.cost_analytics.time_ranges[4].label },
    ];

    const options = periods.map(p =>
        `<option value="${p.value}" ${state.daysFilter === p.value ? 'selected' : ''}>${p.label}</option>`
    ).join('');

    return `
        <div class="cost-filter-bar">
            <select class="cost-period-select" id="cost-period-select">
                ${options}
            </select>
        </div>
    `;
}

/**
 * Render summary cards
 */
function renderSummaryCards() {
    const s = state.summary;
    const e = state.efficiency;
    if (!s) return '';

    return `
        <div class="cost-cards">
            <div class="cost-card cost-card-primary">
                <div class="cost-card-value">${formatCost(s.total_cost)}</div>
                <div class="cost-card-label">Total Cost</div>
            </div>
            <div class="cost-card">
                <div class="cost-card-value">${s.total_sessions}</div>
                <div class="cost-card-label">Sessions</div>
            </div>
            <div class="cost-card">
                <div class="cost-card-value">${s.total_turns}</div>
                <div class="cost-card-label">Turns</div>
            </div>
            <div class="cost-card">
                <div class="cost-card-value">${formatPct(s.cache?.hit_rate_pct || 0)}</div>
                <div class="cost-card-label">Cache Hit</div>
            </div>
        </div>
    `;
}

/**
 * Render overview tab
 */
function renderOverview() {
    const s = state.summary;
    const e = state.efficiency;
    if (!s) return '<div class="cost-loading">Loading...</div>';

    // Model breakdown - now includes merged Haiku with breakdown detail
    const modelRows = Object.entries(s.by_model || {}).map(([name, m]) => {
        const shortName = name.replace('claude-', '');
        const color = name.includes('opus') ? '#8b5cf6' :
                      name.includes('haiku') ? '#10b981' : '#f59e0b';

        // Show breakdown detail for Haiku if it has both conversation and shadow_git costs
        let breakdownHtml = '';
        if (m.breakdown && (m.breakdown.conversation > 0 || m.breakdown.shadow_git > 0)) {
            const parts = [];
            if (m.breakdown.conversation > 0) {
                parts.push(`Task: ${formatCost(m.breakdown.conversation)}`);
            }
            if (m.breakdown.shadow_git > 0) {
                parts.push(`Shadow: ${formatCost(m.breakdown.shadow_git)}`);
            }
            breakdownHtml = `<div class="model-breakdown-detail">${parts.join(' + ')}</div>`;
        }

        return `
            <tr>
                <td>
                    <span class="model-dot" style="background: ${color}"></span>${shortName}
                    ${breakdownHtml}
                </td>
                <td class="cost-value">${formatCost(m.cost)}</td>
                <td>${formatPct(m.pct)}</td>
                <td>${createBar(m.pct, color)}</td>
            </tr>
        `;
    }).join('');

    // Thread breakdown (main session vs Task subagents vs shadow git overhead)
    const t = s.by_thread || {};
    const threadRows = [
        { label: 'Main thread', data: t.main_thread, color: '#3b82f6', sub: null },
        { label: 'Subagents (Task)', data: t.subagents, color: '#f59e0b',
          sub: t.subagents?.calls ? `${t.subagents.calls} calls` : null },
        { label: 'Shadow git', data: t.shadow_git, color: '#10b981',
          sub: t.shadow_git?.calls ? `${t.shadow_git.calls} calls` : null },
    ].filter(r => r.data && r.data.cost > 0).map(r => `
        <tr>
            <td>
                <span class="model-dot" style="background: ${r.color}"></span>${r.label}
                ${r.sub ? `<div class="model-breakdown-detail">${r.sub}</div>` : ''}
            </td>
            <td class="cost-value">${formatCost(r.data.cost)}</td>
            <td>${formatPct(r.data.pct || 0)}</td>
            <td>${createBar(r.data.pct || 0, r.color)}</td>
        </tr>
    `).join('');

    // Project breakdown (top 3)
    const projectRows = Object.entries(s.by_project || {}).slice(0, 3).map(([hash, p]) => `
        <tr class="project-row" data-hash="${hash}">
            <td class="project-name">${escapeHtml(p.name)}</td>
            <td class="cost-value">${formatCost(p.cost)}</td>
            <td>${p.sessions} sess</td>
        </tr>
    `).join('');

    return `
        <div class="cost-section">
            <h4>Model Breakdown</h4>
            <table class="cost-table">
                <thead><tr><th>Model</th><th>Cost</th><th>%</th><th></th></tr></thead>
                <tbody>${modelRows}</tbody>
            </table>
        </div>

        ${threadRows ? `
        <div class="cost-section">
            <h4>Thread Breakdown</h4>
            <table class="cost-table">
                <thead><tr><th>Thread</th><th>Cost</th><th>%</th><th></th></tr></thead>
                <tbody>${threadRows}</tbody>
            </table>
        </div>
        ` : ''}

        <div class="cost-section">
            <h4>Projects</h4>
            <table class="cost-table">
                <thead><tr><th>Project</th><th>Cost</th><th>Usage</th></tr></thead>
                <tbody>${projectRows}</tbody>
            </table>
        </div>

        <div class="cost-section cost-metrics">
            <h4>Efficiency</h4>
            <div class="cost-metric-grid">
                <div class="cost-metric">
                    <span class="metric-value">${formatCost(e?.cost_per_turn || 0)}</span>
                    <span class="metric-label">per turn</span>
                </div>
                <div class="cost-metric">
                    <span class="metric-value">${formatPct(e?.overhead?.work_efficiency_pct || 100)}</span>
                    <span class="metric-label">work eff.</span>
                </div>
                <div class="cost-metric">
                    <span class="metric-value">${formatPct(e?.cache_efficiency?.savings_pct || 0)}</span>
                    <span class="metric-label">cache save</span>
                </div>
            </div>
        </div>
    `;
}

/**
 * Render models tab
 */
function renderModels() {
    const s = state.summary;
    const e = state.efficiency;
    if (!s) return '';

    const modelDetails = Object.entries(s.by_model || {}).map(([name, m]) => {
        const shortName = name.replace('claude-', '');
        const eff = e?.model_efficiency?.[name] || {};
        const color = name.includes('opus') ? '#8b5cf6' :
                      name.includes('haiku') ? '#10b981' : '#f59e0b';

        // Show breakdown for Haiku (Task subagents vs Shadow git)
        let breakdownHtml = '';
        if (m.breakdown) {
            breakdownHtml = `
                <div class="model-breakdown">
                    <div class="breakdown-row">
                        <span class="breakdown-label">Task subagents:</span>
                        <span class="breakdown-value">${formatCost(m.breakdown.conversation)}</span>
                    </div>
                    <div class="breakdown-row">
                        <span class="breakdown-label">Shadow git:</span>
                        <span class="breakdown-value">${formatCost(m.breakdown.shadow_git)}</span>
                    </div>
                </div>
            `;
        }

        return `
            <div class="model-card" style="--model-color: ${color}">
                <div class="model-header">
                    <span class="model-name">${shortName}</span>
                    <span class="model-cost">${formatCost(m.cost)}</span>
                </div>
                ${breakdownHtml}
                <div class="model-stats">
                    <div class="model-stat">
                        <span class="stat-value">${formatNumber(m.input_tokens)}</span>
                        <span class="stat-label">input</span>
                    </div>
                    <div class="model-stat">
                        <span class="stat-value">${formatNumber(m.output_tokens)}</span>
                        <span class="stat-label">output</span>
                    </div>
                    <div class="model-stat">
                        <span class="stat-value">${m.calls}</span>
                        <span class="stat-label">calls</span>
                    </div>
                </div>
                <div class="model-cache">
                    <span>Cache: ${formatNumber(m.cache_read_tokens)} read / ${formatNumber(m.cache_write_tokens)} write</span>
                </div>
                <div class="model-efficiency">
                    <span>${formatCost(eff.cost_per_1k_input || 0, 4)}/1k in</span>
                    <span>${formatCost(eff.cost_per_1k_output || 0, 4)}/1k out</span>
                </div>
            </div>
        `;
    }).join('');

    return `
        <div class="cost-section">
            <h4>Model Details</h4>
            <div class="model-cards">${modelDetails}</div>
        </div>
    `;
}

/**
 * Render tools tab
 */
function renderTools() {
    const t = state.tools;
    if (!t) return '';

    const toolRows = Object.entries(t.tools || {}).map(([name, tool]) => {
        const pct = tool.pct || 0;
        return `
            <tr>
                <td class="tool-name">${escapeHtml(name)}</td>
                <td class="cost-value">${formatCost(tool.attributed_cost)}</td>
                <td>${tool.invocations}</td>
                <td>${formatCost(tool.avg_per_invocation, 4)}</td>
                <td>${createBar(pct)}</td>
            </tr>
        `;
    }).join('');

    return `
        <div class="cost-section">
            <h4>Tool Cost Attribution</h4>
            <p class="cost-note">Cost attributed proportionally to tools used per turn</p>
            <table class="cost-table cost-table-tools">
                <thead>
                    <tr>
                        <th>Tool</th>
                        <th>Cost</th>
                        <th>Calls</th>
                        <th>Avg</th>
                        <th></th>
                    </tr>
                </thead>
                <tbody>${toolRows}</tbody>
            </table>
        </div>
    `;
}

/**
 * Sort models: Opus > Sonnet > Haiku
 */
function sortModels(entries) {
    const order = { 'opus': 0, 'sonnet': 1, 'haiku': 2 };
    return entries.sort((a, b) => {
        const aKey = a[0].toLowerCase();
        const bKey = b[0].toLowerCase();
        const aOrder = Object.keys(order).find(k => aKey.includes(k));
        const bOrder = Object.keys(order).find(k => bKey.includes(k));
        return (order[aOrder] ?? 99) - (order[bOrder] ?? 99);
    });
}

/**
 * Render sessions tab
 */
function renderSessions() {
    const sessions = state.sessions?.sessions || [];
    if (!sessions.length) return '<div class="cost-empty">No sessions found</div>';

    const sessionRows = sessions.map((s, i) => {
        // Build model breakdown with Haiku detail if available
        let modelBreakdown = '';
        if (s.model_breakdown) {
            const badges = sortModels(Object.entries(s.model_breakdown)).map(([m, d]) => {
                const short = m.replace('claude-', '').replace(/-\d+.*$/, '');
                // Show breakdown for Haiku if it has shadow_git costs
                let detail = '';
                if (d.breakdown && d.breakdown.shadow_git > 0) {
                    const parts = [];
                    if (d.breakdown.conversation > 0) parts.push(`Task: ${formatCost(d.breakdown.conversation)}`);
                    if (d.breakdown.shadow_git > 0) parts.push(`Shadow: ${formatCost(d.breakdown.shadow_git)}`);
                    detail = ` <span class="haiku-detail">(${parts.join(' + ')})</span>`;
                }
                return `<span class="model-badge">${short}: ${formatCost(d.cost)}${detail}</span>`;
            }).join(' ');
            modelBreakdown = badges;
        }

        return `
            <tr class="session-row">
                <td>
                    <div class="session-info">
                        <span class="session-rank">#${i + 1}</span>
                        <span class="session-name">${escapeHtml(s.name || s.project)}</span>
                    </div>
                </td>
                <td class="cost-value">${formatCost(s.cost)}</td>
                <td>${s.messages} msg</td>
            </tr>
            ${modelBreakdown ? `<tr class="session-breakdown"><td colspan="3">${modelBreakdown}</td></tr>` : ''}
        `;
    }).join('');

    return `
        <div class="cost-section">
            <h4>Top Sessions by Cost</h4>
            <table class="cost-table cost-table-sessions">
                <thead><tr><th>Session</th><th>Cost</th><th>Size</th></tr></thead>
                <tbody>${sessionRows}</tbody>
            </table>
        </div>
    `;
}

/**
 * Render trends tab with bar chart
 */
function renderTrends() {
    const t = state.trends;
    if (!t || !t.data?.length) return '<div class="cost-empty">No trend data</div>';

    const data = t.data;
    const maxCost = Math.max(...data.map(d => d.cost));

    // Create bar chart with percentage-based heights
    const bars = data.map(d => {
        const heightPct = maxCost > 0 ? (d.cost / maxCost) * 100 : 0;
        const date = d.date.substring(5); // MM-DD

        return `
            <div class="trend-column" data-tooltip="${d.date}: ${formatCost(d.cost)}">
                <div class="trend-bar-container">
                    <div class="trend-bar-fill" style="height: ${heightPct}%"></div>
                </div>
                <div class="trend-label">${date}</div>
            </div>
        `;
    }).join('');

    return `
        <div class="cost-section">
            <h4>Daily Cost Trend (${t.data.length} days)</h4>
            <div class="trend-chart">
                <div class="trend-y-axis">
                    <span>${formatCost(maxCost)}</span>
                    <span>${formatCost(maxCost / 2)}</span>
                    <span>$0</span>
                </div>
                <div class="trend-bars">${bars}</div>
            </div>
            <div class="trend-summary">
                Total: ${formatCost(t.totals?.cost)} |
                ${t.totals?.sessions} sessions |
                ${t.totals?.turns} turns
            </div>
        </div>
    `;
}

/**
 * Render tab content
 */
function renderTabContent() {
    switch (state.activeTab) {
        case 'overview': return renderOverview();
        case 'models': return renderModels();
        case 'tools': return renderTools();
        case 'sessions': return renderSessions();
        case 'trends': return renderTrends();
        default: return renderOverview();
    }
}

/**
 * Render main content
 */
function renderContent() {
    if (!state.container) return;

    if (state.loading) {
        state.container.innerHTML = `
            <div class="cost-loading">
                <div class="spinner"></div>
                <span>Loading cost analytics...</span>
            </div>
        `;
        return;
    }

    if (state.error) {
        state.container.innerHTML = `
            <div class="cost-error">
                <span>${ICONS.warning}</span>
                <span>${escapeHtml(state.error)}</span>
                <button class="cost-retry-btn" data-act="cost-retry">Retry</button>
            </div>
        `;
        return;
    }

    const tabs = ['overview', 'models', 'tools', 'sessions', 'trends'];
    const tabButtons = tabs.map(tab => `
        <button class="cost-tab ${state.activeTab === tab ? 'active' : ''}" data-tab="${tab}">
            ${tab.charAt(0).toUpperCase() + tab.slice(1)}
        </button>
    `).join('');

    state.container.innerHTML = `
        ${renderFilterBar()}
        ${renderSummaryCards()}
        <div class="cost-tabs">${tabButtons}</div>
        <div class="cost-tab-content">${renderTabContent()}</div>
    `;

    // Attach tab click handlers
    state.container.querySelectorAll('.cost-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            state.activeTab = btn.dataset.tab;
            renderContent();
        });
    });

    // Attach period filter handler
    const periodSelect = state.container.querySelector('#cost-period-select');
    if (periodSelect) {
        periodSelect.addEventListener('change', (e) => {
            state.daysFilter = parseInt(e.target.value, 10);
            loadData();
        });
    }
}

// Global retry function
window.costAnalyticsRetry = loadData;

/**
 * Register the widget
 */
export function registerCostAnalyticsWidget() {
    WidgetManager.register('cost-analytics', {
        title: S.widgets.titles.cost_analytics,
        icon: 'coins',
        type: 'floating',
        scope: 'global',
        defaultSize: { width: 520, height: 600 },
        headerActions: [
            {
                icon: 'refresh',
                title: S.widgets.header_actions.refresh,
                onClick: () => loadData()
            }
        ],
        render(container, ctx) {
            state.container = container;
            container.classList.add('cost-analytics-widget');
            loadData();
        },
        onClose() {
            state.container = null;
        }
    });
}
