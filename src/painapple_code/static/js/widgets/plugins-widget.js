/**
 * Plugins Manager Widget
 *
 * Browse the Claude Code plugin marketplace and manage installed plugins.
 * Backed by /api/plugins which shells out to `claude plugins list --available --json`
 * and friends. Plugins ship a mix of agents/commands/skills/hooks — this widget
 * is the install-unit view; the skills/agents widgets keep their per-component
 * focus and pick up new entries automatically once a plugin is installed.
 */

import S from '../strings.js';
import { escapeHtml } from '../utils.js';
import { showToast } from '../context-menu.js';
import { CONFIG, debug } from '../config.js';
import { WidgetManager } from '../widget-system/index.js';

const state = {
    container: null,
    plugins: [],
    counts: { installed: 0, enabled: 0, available: 0 },
    loading: false,
    error: null,
    search: '',
    filter: 'all',           // all | installed | available | enabled | disabled
    expandedId: null,
    actionInFlight: null,    // pluginId currently being installed/uninstalled/etc.
};

// ══════════════════════════════════════════════════════════════════
// DATA
// ══════════════════════════════════════════════════════════════════

async function loadPlugins(opts = {}) {
    state.loading = true;
    state.error = null;
    render();
    try {
        const url = `${CONFIG.API_BASE}/api/plugins?available=${opts.skipAvailable ? 'false' : 'true'}`;
        const r = await fetch(url);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        state.plugins = data.plugins || [];
        state.counts = data.counts || { installed: 0, enabled: 0, available: 0 };
    } catch (e) {
        state.error = String(e.message || e);
    } finally {
        state.loading = false;
        render();
    }
}

async function runAction(verb, pluginId) {
    state.actionInFlight = pluginId;
    render();
    try {
        const r = await fetch(`${CONFIG.API_BASE}/api/plugins/${verb}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ plugin_id: pluginId }),
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) {
            const detail = data?.detail || data;
            const msg = typeof detail === 'string'
                ? detail
                : (detail?.stderr || detail?.stdout || `HTTP ${r.status}`);
            throw new Error(msg);
        }
        showToast(`${verb}: ${pluginId.split('@')[0]}`, 'success');
        await loadPlugins({ skipAvailable: true });  // installed-set changed; refresh
    } catch (e) {
        showToast(`${verb} failed: ${e.message || e}`, 'error');
    } finally {
        state.actionInFlight = null;
        render();
    }
}

// ══════════════════════════════════════════════════════════════════
// FILTER
// ══════════════════════════════════════════════════════════════════

function filteredPlugins() {
    const q = state.search.trim().toLowerCase();
    const f = state.filter;
    return state.plugins.filter(p => {
        if (f === 'installed' && !p.installed) return false;
        if (f === 'available' && p.installed) return false;
        if (f === 'enabled' && !(p.installed && p.enabled)) return false;
        if (f === 'disabled' && !(p.installed && p.enabled === false)) return false;
        if (!q) return true;
        if (p.name.toLowerCase().includes(q)) return true;
        if ((p.description || '').toLowerCase().includes(q)) return true;
        if ((p.marketplace || '').toLowerCase().includes(q)) return true;
        return false;
    });
}

// ══════════════════════════════════════════════════════════════════
// RENDER
// ══════════════════════════════════════════════════════════════════

function formatInstallCount(n) {
    if (n == null) return '';
    if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
    return String(n);
}

function renderComponents(c) {
    const parts = [];
    if (c.skills)      parts.push(`<span class="pl-comp">${c.skills} skill${c.skills === 1 ? '' : 's'}</span>`);
    if (c.agents)      parts.push(`<span class="pl-comp">${c.agents} agent${c.agents === 1 ? '' : 's'}</span>`);
    if (c.commands)    parts.push(`<span class="pl-comp">${c.commands} command${c.commands === 1 ? '' : 's'}</span>`);
    if (c.hooks)       parts.push(`<span class="pl-comp">${c.hooks} hook${c.hooks === 1 ? '' : 's'}</span>`);
    if (c.mcp_servers) parts.push(`<span class="pl-comp">${c.mcp_servers} MCP</span>`);
    return parts.join('');
}

function renderActions(p) {
    const busy = state.actionInFlight === p.id;
    const disabled = busy ? 'disabled' : '';
    if (!p.installed) {
        return `<button class="pl-btn pl-btn-primary" data-action="install" data-id="${escapeHtml(p.id)}" ${disabled}>
            ${busy ? 'Installing…' : 'Install'}
        </button>`;
    }
    const toggleVerb = p.enabled ? 'disable' : 'enable';
    const toggleLabel = p.enabled ? 'Disable' : 'Enable';
    return `
        <button class="pl-btn" data-action="${toggleVerb}" data-id="${escapeHtml(p.id)}" ${disabled}>
            ${busy && state.actionInFlight === p.id ? '…' : toggleLabel}
        </button>
        <button class="pl-btn pl-btn-danger" data-action="uninstall" data-id="${escapeHtml(p.id)}" ${disabled}>
            ${busy ? 'Removing…' : 'Uninstall'}
        </button>
    `;
}

function renderCard(p) {
    const expanded = state.expandedId === p.id;
    const statusBadge = !p.installed
        ? '<span class="pl-badge pl-badge-available">available</span>'
        : p.enabled === false
            ? '<span class="pl-badge pl-badge-disabled">disabled</span>'
            : '<span class="pl-badge pl-badge-installed">installed</span>';

    const installCount = p.install_count != null
        ? `<span class="pl-meta-stat" title="Installs">${formatInstallCount(p.install_count)} installs</span>`
        : '';
    const components = renderComponents(p.components || {});
    const author = p.author?.name
        ? `<span class="pl-meta-stat">by ${escapeHtml(p.author.name)}</span>`
        : '';

    return `
        <div class="pl-card ${expanded ? 'expanded' : ''}" data-id="${escapeHtml(p.id)}">
            <div class="pl-card-head">
                <div class="pl-card-title">
                    <span class="pl-name">${escapeHtml(p.name)}</span>
                    ${statusBadge}
                </div>
                <div class="pl-card-actions">${renderActions(p)}</div>
            </div>
            <div class="pl-card-desc ${expanded ? '' : 'clamped'}">${escapeHtml(p.description || '')}</div>
            <div class="pl-card-meta">
                <span class="pl-marketplace">${escapeHtml(p.marketplace || '')}</span>
                ${installCount}
                ${author}
                <div class="pl-components">${components}</div>
            </div>
        </div>
    `;
}

function render() {
    if (!state.container) return;

    const filtered = filteredPlugins();
    const pillsMeta = [
        ['all', 'All', state.plugins.length],
        ['installed', 'Installed', state.counts.installed],
        ['available', 'Available', state.plugins.length - state.counts.installed],
        ['enabled', 'Enabled', state.counts.enabled],
        ['disabled', 'Disabled', state.counts.installed - state.counts.enabled],
    ];
    const pills = pillsMeta.map(([k, label, count]) => {
        const active = state.filter === k ? 'active' : '';
        return `<button class="sk-pill ${active}" data-filter="${k}">
            <span class="sk-pill-label">${label}</span>
            <span class="sk-pill-count">${count}</span>
        </button>`;
    }).join('');

    let body;
    if (state.loading && state.plugins.length === 0) {
        body = `<div class="pl-empty">Loading plugins…</div>`;
    } else if (state.error) {
        body = `<div class="pl-empty pl-error">Failed to load: ${escapeHtml(state.error)}</div>`;
    } else if (filtered.length === 0) {
        body = `<div class="pl-empty">No plugins match your filter.</div>`;
    } else {
        body = `<div class="pl-list">${filtered.map(renderCard).join('')}</div>`;
    }

    state.container.innerHTML = `
        <div class="sk-toolbar">
            <div class="sk-search-wrap">
                <svg class="sk-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                </svg>
                <input type="text" class="sk-search" placeholder="Search plugins…"
                    value="${escapeHtml(state.search)}" autocomplete="off" spellcheck="false" />
            </div>
        </div>
        <div class="sk-pills">${pills}</div>
        <div class="pl-body">${body}</div>
    `;

    attachHandlers();
}

function attachHandlers() {
    const root = state.container;
    if (!root) return;

    const searchInput = root.querySelector('.sk-search');
    if (searchInput) {
        searchInput.addEventListener('input', e => {
            state.search = e.target.value;
            render();
            root.querySelector('.sk-search')?.focus();
        });
    }

    root.querySelectorAll('.sk-pill').forEach(btn => {
        btn.addEventListener('click', () => {
            state.filter = btn.dataset.filter;
            render();
        });
    });

    root.querySelectorAll('.pl-card-actions button').forEach(btn => {
        btn.addEventListener('click', e => {
            e.stopPropagation();
            const verb = btn.dataset.action;
            const id = btn.dataset.id;
            if (!verb || !id || state.actionInFlight) return;
            runAction(verb, id);
        });
    });

    root.querySelectorAll('.pl-card').forEach(card => {
        card.addEventListener('click', e => {
            if (e.target.closest('button')) return;
            const id = card.dataset.id;
            state.expandedId = state.expandedId === id ? null : id;
            render();
        });
    });
}

// ══════════════════════════════════════════════════════════════════
// REGISTER
// ══════════════════════════════════════════════════════════════════

export function registerPluginsWidget() {
    WidgetManager.register('plugins', {
        title: S.widgets.titles.plugins || 'Plugins',
        icon: 'tool',
        type: 'floating',
        scope: 'global',
        defaultWidth: 820,
        defaultHeight: 640,

        headerActions: [
            {
                icon: 'refresh',
                title: 'Refresh',
                onClick: () => loadPlugins(),
            },
        ],

        render(container) {
            state.container = container;
            container.classList.add('skills-widget', 'plugins-widget');
            loadPlugins();
        },

        onOpen() {
            loadPlugins();
            requestAnimationFrame(() => {
                state.container?.querySelector('.sk-search')?.focus();
            });
        },
    });

    debug.log('[PluginsWidget] registered');
}

export const PluginsWidget = {
    open: () => WidgetManager.open('plugins'),
    close: () => WidgetManager.close('plugins'),
    toggle: () => WidgetManager.toggle('plugins'),
    reload: () => loadPlugins(),
};
