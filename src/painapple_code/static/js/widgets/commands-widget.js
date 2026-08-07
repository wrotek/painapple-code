/**
 * Commands Manager Widget
 *
 * Floating widget that lists all slash commands the user can invoke:
 * built-in Claude CLI commands, project/personal `commands/<name>.md`
 * files, plugin commands, and custom commands saved on this device
 * (localStorage `CommandStore`).
 *
 * Folder-form skills (`SKILL.md`) live in the Skills widget.
 *
 * Reuses `.skills-widget` CSS for layout — the container gets both
 * `commands-widget` and `skills-widget` classes so existing rules apply.
 */

import S from '../strings.js';
import { escapeHtml, appConfirm } from '../utils.js';
import { CONFIG, COMMANDS as APP_BUILTIN_COMMANDS, debug } from '../config.js';
import { WidgetManager } from '../widget-system/index.js';
import { getCommandStore, CommandType } from '../command-store.js';
import { invalidateSkillsCache } from '../skills-autocomplete.js';

const PREF_KEY_CURRENT = 'commands-current-project-only';
const PREF_KEY_VIEW = 'commands-view-mode';

const SCOPE_ORDER = ['builtin', 'project', 'personal', 'plugin', 'custom'];

const state = {
    container: null,
    commands: [],          // server commands (builtin, project, personal, plugin)
    customCommands: [],    // CommandStore-derived (browser-side)
    counts: { builtin: 0, project: 0, personal: 0, plugin: 0, custom: 0 },
    loading: false,
    error: null,
    search: '',
    originFilter: 'all',
    currentProjectOnly: loadCurrentProjectOnly(),
    viewMode: loadViewMode(),
    expandedId: null,
    editorState: null,
    lastFetchKey: null,
};

function loadCurrentProjectOnly() {
    try { return localStorage.getItem(PREF_KEY_CURRENT) === 'true'; }
    catch { return false; }
}
function saveCurrentProjectOnly(v) {
    try { localStorage.setItem(PREF_KEY_CURRENT, v ? 'true' : 'false'); } catch {}
}
function loadViewMode() {
    try { return localStorage.getItem(PREF_KEY_VIEW) === 'list' ? 'list' : 'grid'; }
    catch { return 'grid'; }
}
function saveViewMode(v) {
    try { localStorage.setItem(PREF_KEY_VIEW, v); } catch {}
}

// ══════════════════════════════════════════════════════════════════
// DATA LOADING
// ══════════════════════════════════════════════════════════════════

function buildAppBuiltins() {
    // The 8 client-side commands defined in static/js/config.js (eg /help, /fork).
    return APP_BUILTIN_COMMANDS.map(c => ({
        id: `app:${c.cmd.replace(/^\//, '')}`,
        name: c.cmd.replace(/^\//, ''),
        scope: 'builtin',
        scope_label: 'App built-in',
        kind: 'app-builtin',
        path: null,
        description: c.desc || '',
        editable: false,
        body_preview: '',
        body_length: 0,
    }));
}

function buildCustomCommands() {
    const cwd = window.app?.activeSession?.cwd || null;
    const store = getCommandStore();
    return store.getCommands(cwd, /*includeDisabled=*/false).map(c => ({
        id: `custom:${c.id}`,
        name: c.cmd.replace(/^\//, ''),
        scope: 'custom',
        scope_label: c.scope === 'project' ? `Custom (${c.projectPath || 'project'})` : 'Custom (global)',
        kind: c.type === CommandType.SHELL ? 'custom-shell' : 'custom-prompt',
        path: null,
        description: c.desc || (c.type === CommandType.SHELL ? 'Shell command' : 'Custom prompt'),
        editable: false,
        body_preview: c.type === CommandType.SHELL ? (c.shell || '') : (c.prompt || ''),
        body_length: ((c.type === CommandType.SHELL ? c.shell : c.prompt) || '').length,
        customData: c,
    }));
}

async function loadCommands() {
    const cwd = window.app?.activeSession?.cwd || '/';
    state.loading = true;
    state.error = null;
    state.lastFetchKey = cwd;
    renderShell();
    try {
        const r = await fetch(`${CONFIG.API_BASE}/api/commands?cwd=${encodeURIComponent(cwd)}`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        // Server commands + app-side built-ins (8 from config.js prepended into builtin group)
        state.commands = [...buildAppBuiltins(), ...(data.commands || [])];
        state.counts = { ...(data.counts || {}), custom: 0 };
        state.counts.builtin = (state.counts.builtin || 0) + APP_BUILTIN_COMMANDS.length;
    } catch (e) {
        state.error = String(e.message || e);
    } finally {
        state.customCommands = buildCustomCommands();
        state.counts.custom = state.customCommands.length;
        state.loading = false;
        renderShell();
    }
}

// ══════════════════════════════════════════════════════════════════
// FILTERING
// ══════════════════════════════════════════════════════════════════

function filteredCommands() {
    const q = state.search.trim().toLowerCase();
    const origin = state.originFilter;
    const all = [...state.commands, ...state.customCommands];
    return all.filter(c => {
        if (state.currentProjectOnly && c.scope !== 'project') return false;
        if (origin !== 'all' && c.scope !== origin) return false;
        if (!q) return true;
        if (c.name.toLowerCase().includes(q)) return true;
        if ((c.description || '').toLowerCase().includes(q)) return true;
        if ((c.body_preview || '').toLowerCase().includes(q)) return true;
        return false;
    });
}

// ══════════════════════════════════════════════════════════════════
// RENDERING
// ══════════════════════════════════════════════════════════════════

const ICONS = {
    cli: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>',
    folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
    layers: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>',
    cube: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>',
    bookmark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>',
};

function scopeIcon(scope) {
    if (scope === 'builtin') return ICONS.cli;
    if (scope === 'project') return ICONS.folder;
    if (scope === 'personal') return ICONS.layers;
    if (scope === 'plugin') return ICONS.cube;
    if (scope === 'custom') return ICONS.bookmark;
    return ICONS.cli;
}

function renderShell() {
    if (!state.container) return;

    const filtered = filteredCommands();
    const cw = S.commands_widget;

    const pillKeys = ['all', 'builtin', 'project', 'personal', 'plugin', 'custom'];
    const pills = pillKeys.map(k => {
        const label = k === 'all' ? cw.filters.all : cw.filters[k];
        const count = k === 'all'
            ? (state.commands.length + state.customCommands.length)
            : (state.counts[k] ?? 0);
        const active = state.originFilter === k ? 'active' : '';
        return `<button class="sk-pill ${active}" data-filter="${k}">
            <span class="sk-pill-label">${label}</span>
            <span class="sk-pill-count">${count}</span>
        </button>`;
    }).join('');

    state.container.innerHTML = `
        <div class="sk-toolbar">
            <div class="sk-search-wrap">
                <svg class="sk-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                </svg>
                <input type="text" class="sk-search" placeholder="${cw.search_placeholder}"
                    value="${escapeHtml(state.search)}" autocomplete="off" spellcheck="false" />
            </div>
            <label class="sk-current-toggle" title="${escapeHtml(cw.current_project_tooltip)}">
                <input type="checkbox" ${state.currentProjectOnly ? 'checked' : ''} />
                <span>${cw.current_project_label}</span>
            </label>
            <div class="sk-view-toggle">
                <button class="sk-view-btn ${state.viewMode === 'grid' ? 'active' : ''}" data-view="grid" title="${cw.view_grid}" data-tooltip="${cw.view_grid}">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
                </button>
                <button class="sk-view-btn ${state.viewMode === 'list' ? 'active' : ''}" data-view="list" title="${cw.view_list}" data-tooltip="${cw.view_list}">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
                </button>
            </div>
        </div>
        <div class="sk-pills">${pills}</div>
        <div class="sk-body sk-body--${state.viewMode}">
            ${renderBody(filtered)}
        </div>
    `;

    attachToolbarHandlers();
    attachCardHandlers();
    if (state.expandedId) {
        mountEditor(state.expandedId);
    }
}

function renderBody(filtered) {
    const cw = S.commands_widget;
    if (state.loading && state.commands.length === 0) {
        return `<div class="sk-empty">Loading…</div>`;
    }
    if (state.error) {
        return `<div class="sk-empty sk-error">${escapeHtml(cw.load_failed.replace('{error}', state.error))}</div>`;
    }
    if (filtered.length === 0) {
        const msg = state.search
            ? cw.empty.no_match
            : (state.currentProjectOnly && state.counts.project === 0)
                ? cw.empty.no_project
                : cw.empty.no_commands;
        return `<div class="sk-empty">${escapeHtml(msg)}</div>`;
    }

    const groups = {};
    for (const c of filtered) {
        (groups[c.scope] || (groups[c.scope] = [])).push(c);
    }

    const out = [];
    for (const scope of SCOPE_ORDER) {
        const arr = groups[scope];
        if (!arr || arr.length === 0) continue;
        out.push(`<div class="sk-group" data-scope="${scope}">
            <div class="sk-group-header">
                <span class="sk-group-icon">${scopeIcon(scope)}</span>
                <span class="sk-group-label">${cw.groups[scope] || scope}</span>
                <span class="sk-group-count">${arr.length}</span>
            </div>
            <div class="sk-gallery">
                ${arr.map(renderCard).join('')}
            </div>
        </div>`);
    }
    return out.join('');
}

function renderCard(c) {
    const cw = S.commands_widget;
    const name = escapeHtml(c.name);
    const desc = c.description
        ? escapeHtml(c.description)
        : `<em>${cw.meta.no_description}</em>`;

    const builtinBadge = c.scope === 'builtin'
        ? `<span class="sk-badge sk-badge--ro">${cw.badges.builtin}</span>`
        : '';
    const customBadge = c.scope === 'custom'
        ? `<span class="sk-badge sk-badge--custom">${cw.badges.custom}</span>`
        : '';
    const pluginBadge = c.scope === 'plugin'
        ? `<span class="sk-badge sk-badge--plugin" title="${escapeHtml(c.scope_label)}">${escapeHtml((c.scope_label || 'plugin').split(' ')[0])}</span>`
        : '';
    const readonlyBadge = !c.editable && c.scope !== 'builtin' && c.scope !== 'custom' && c.scope !== 'plugin'
        ? `<span class="sk-badge sk-badge--ro">${cw.badges.read_only}</span>`
        : '';

    const expanded = state.expandedId === c.id ? 'sk-card--expanded' : '';

    return `
        <div class="sk-card sk-card--${c.scope} ${expanded}" data-id="${escapeHtml(c.id)}" data-scope="${c.scope}">
            <div class="sk-card-head">
                <span class="sk-card-icon">${scopeIcon(c.scope)}</span>
                <span class="sk-card-name">/${name}</span>
                <span class="sk-card-badges">
                    ${builtinBadge}${customBadge}${pluginBadge}${readonlyBadge}
                </span>
            </div>
            <p class="sk-card-desc">${desc}</p>
            <div class="sk-card-detail" data-detail-for="${escapeHtml(c.id)}"></div>
        </div>
    `;
}

function renderEditor(cmd, detail) {
    const cw = S.commands_widget;
    const readOnly = !cmd.editable;
    const dirty = state.editorState?.dirty;
    const note = readOnly ? renderReadOnlyNote(cmd) : '';
    return `
        <div class="sk-editor ${readOnly ? 'sk-editor--readonly' : ''}" data-id="${escapeHtml(cmd.id)}">
            <div class="sk-editor-head">
                <span class="sk-editor-path" title="${escapeHtml(detail.path || '')}">${escapeHtml(detail.path || cw.badges.builtin)}</span>
                ${dirty ? `<span class="sk-editor-dirty">${cw.editor.dirty_indicator}</span>` : ''}
            </div>
            ${note}
            <textarea class="sk-editor-textarea" ${readOnly ? 'readonly' : ''} spellcheck="false">${escapeHtml(detail.raw || detail.description || '')}</textarea>
            <div class="sk-editor-foot">
                <button class="sk-btn sk-btn--ghost sk-cancel-btn">${cw.actions.cancel}</button>
                ${detail.path ? `<button class="sk-btn sk-btn--ghost sk-open-full-btn">${cw.actions.open_full_editor}</button>` : ''}
                ${readOnly ? '' : `<button class="sk-btn sk-btn--primary sk-save-btn" ${dirty ? '' : 'disabled'}>${cw.actions.save}</button>`}
            </div>
        </div>
    `;
}

function renderReadOnlyNote(cmd) {
    const cw = S.commands_widget;
    if (cmd.scope === 'builtin') {
        return `<div class="sk-editor-note">${cw.editor.builtin_readonly}</div>`;
    }
    if (cmd.scope === 'custom') {
        return `<div class="sk-editor-note">${cw.editor.custom_readonly}</div>`;
    }
    return '';
}

// ══════════════════════════════════════════════════════════════════
// EVENT HANDLERS
// ══════════════════════════════════════════════════════════════════

function attachToolbarHandlers() {
    const root = state.container;
    if (!root) return;

    const search = root.querySelector('.sk-search');
    if (search) {
        const focused = document.activeElement === search;
        search.addEventListener('input', (e) => {
            state.search = e.target.value;
            rerenderBodyOnly();
        });
        if (focused) {
            const len = search.value.length;
            search.focus();
            search.setSelectionRange(len, len);
        }
    }

    root.querySelector('.sk-current-toggle input')?.addEventListener('change', (e) => {
        state.currentProjectOnly = e.target.checked;
        saveCurrentProjectOnly(state.currentProjectOnly);
        rerenderBodyOnly();
    });

    root.querySelectorAll('.sk-pill').forEach(btn => {
        btn.addEventListener('click', () => {
            state.originFilter = btn.dataset.filter;
            renderShell();
        });
    });

    root.querySelectorAll('.sk-view-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const next = btn.dataset.view;
            if (next === state.viewMode) return;
            state.viewMode = next;
            saveViewMode(next);
            renderShell();
        });
    });
}

function rerenderBodyOnly() {
    const body = state.container?.querySelector('.sk-body');
    if (!body) return renderShell();
    const filtered = filteredCommands();
    body.className = `sk-body sk-body--${state.viewMode}`;
    body.innerHTML = renderBody(filtered);
    attachCardHandlers();
    if (state.expandedId) mountEditor(state.expandedId);
}

function attachCardHandlers() {
    const root = state.container;
    if (!root) return;

    root.querySelectorAll('.sk-card').forEach(card => {
        card.addEventListener('click', async (e) => {
            if (e.target.closest('.sk-card-detail')) return;
            const id = card.dataset.id;
            if (state.expandedId === id) {
                state.expandedId = null;
                state.editorState = null;
                rerenderBodyOnly();
                return;
            }
            state.expandedId = id;
            state.editorState = null;
            rerenderBodyOnly();
            await mountEditor(id);
        });

        card.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            const id = card.dataset.id;
            const cmd = findCommandById(id);
            if (cmd) showCardContextMenu(e.clientX, e.clientY, cmd);
        });
    });
}

function findCommandById(id) {
    return state.commands.find(c => c.id === id) || state.customCommands.find(c => c.id === id);
}

async function mountEditor(id) {
    const card = state.container?.querySelector(`.sk-card[data-id="${CSS.escape(id)}"]`);
    const detailEl = card?.querySelector('.sk-card-detail');
    if (!detailEl) return;
    if (detailEl.dataset.mounted === '1' && state.editorState) return;

    detailEl.innerHTML = `<div class="sk-editor-loading">Loading…</div>`;
    detailEl.dataset.mounted = '1';

    const cmd = findCommandById(id);
    if (!cmd) return;

    // Built-in / custom / app-builtin: no server fetch — render inline detail
    if (cmd.scope === 'builtin' || cmd.scope === 'custom') {
        const detail = {
            path: cmd.path,
            description: cmd.description,
            raw: cmd.body_preview || '',
        };
        state.editorState = {
            raw: detail.raw,
            original: detail.raw,
            dirty: false,
            mtime: 0,
            saving: false,
        };
        detailEl.innerHTML = renderEditor(cmd, detail);
        bindEditorHandlers(detailEl, cmd, detail);
        return;
    }

    // File-backed (project/personal/plugin): fetch full content from server
    const [scope, ...rest] = id.split(':');
    const name = rest.join(':');
    let detail;
    try {
        const cwd = window.app?.activeSession?.cwd || '/';
        const r = await fetch(`${CONFIG.API_BASE}/api/commands/${encodeURIComponent(scope)}/${encodeURIComponent(name)}?cwd=${encodeURIComponent(cwd)}`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        detail = await r.json();
    } catch (e) {
        detailEl.innerHTML = `<div class="sk-editor-error">${escapeHtml('Failed to load: ' + e.message)}</div>`;
        return;
    }

    state.editorState = {
        raw: detail.raw,
        original: detail.raw,
        dirty: false,
        mtime: detail.mtime,
        saving: false,
    };
    detailEl.innerHTML = renderEditor(cmd, detail);
    bindEditorHandlers(detailEl, cmd, detail);
}

function bindEditorHandlers(root, cmd, detail) {
    const ta = root.querySelector('.sk-editor-textarea');
    const saveBtn = root.querySelector('.sk-save-btn');
    const cancelBtn = root.querySelector('.sk-cancel-btn');
    const openFullBtn = root.querySelector('.sk-open-full-btn');

    ta?.addEventListener('input', (e) => {
        if (!state.editorState) return;
        state.editorState.raw = e.target.value;
        const nowDirty = state.editorState.raw !== state.editorState.original;
        if (nowDirty !== state.editorState.dirty) {
            state.editorState.dirty = nowDirty;
            const editor = root.querySelector('.sk-editor');
            editor?.classList.toggle('sk-editor--dirty', nowDirty);
            if (saveBtn) saveBtn.disabled = !nowDirty;
            const existing = root.querySelector('.sk-editor-dirty');
            if (nowDirty && !existing) {
                root.querySelector('.sk-editor-head')
                    ?.insertAdjacentHTML('beforeend', `<span class="sk-editor-dirty">${S.commands_widget.editor.dirty_indicator}</span>`);
            } else if (!nowDirty && existing) {
                existing.remove();
            }
        }
    });

    cancelBtn?.addEventListener('click', async () => {
        if (state.editorState?.dirty && !(await appConfirm(S.commands_widget.editor.discard_confirm, { confirmLabel: 'Discard', danger: true }))) return;
        state.expandedId = null;
        state.editorState = null;
        rerenderBodyOnly();
    });

    openFullBtn?.addEventListener('click', () => {
        const WM = window.WidgetManager;
        if (WM && typeof WM.open === 'function' && cmd.path) {
            WM.open('file-preview', { filePath: cmd.path });
        }
    });

    saveBtn?.addEventListener('click', async () => {
        if (!state.editorState || state.editorState.saving) return;
        state.editorState.saving = true;
        saveBtn.disabled = true;
        saveBtn.textContent = '…';
        try {
            const cwd = window.app?.activeSession?.cwd || '/';
            const r = await fetch(`${CONFIG.API_BASE}/api/commands/${encodeURIComponent(cmd.scope)}/${encodeURIComponent(cmd.name)}?cwd=${encodeURIComponent(cwd)}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    raw: state.editorState.raw,
                    expected_mtime: state.editorState.mtime,
                }),
            });
            if (!r.ok) {
                const body = await r.json().catch(() => ({}));
                throw new Error(body.detail || `HTTP ${r.status}`);
            }
            const result = await r.json();
            state.editorState.original = state.editorState.raw;
            state.editorState.dirty = false;
            state.editorState.mtime = result.mtime;
            window.app?.showToast?.(S.commands_widget.toast.saved.replace('{name}', cmd.name));
            await loadCommands();
        } catch (e) {
            alert(S.commands_widget.editor.save_failed.replace('{error}', e.message));
        } finally {
            if (state.editorState) state.editorState.saving = false;
            const b = state.container?.querySelector(`.sk-card[data-id="${CSS.escape(cmd.id)}"] .sk-save-btn`);
            if (b) {
                b.textContent = S.commands_widget.actions.save;
                b.disabled = !state.editorState?.dirty;
            }
        }
    });
}

// ══════════════════════════════════════════════════════════════════
// CONTEXT MENU
// ══════════════════════════════════════════════════════════════════

function showCardContextMenu(x, y, cmd) {
    const cw = S.commands_widget;
    const menu = window.app?.contextMenu;
    const items = [];

    items.push({
        label: cw.actions.copy_invocation,
        action: () => {
            if (navigator.clipboard) navigator.clipboard.writeText(`/${cmd.name}`);
            window.app?.showToast?.(cw.toast.copied_invocation.replace('{name}', cmd.name));
        },
    });
    if (cmd.path) {
        items.push({
            label: cw.actions.copy_path,
            action: () => {
                if (navigator.clipboard) navigator.clipboard.writeText(cmd.path);
                window.app?.showToast?.(cw.toast.copied_path);
            },
        });
    }

    if (cmd.editable && cmd.kind === 'file') {
        items.push({ separator: true });
        items.push({
            label: cw.actions.upgrade_to_skill,
            action: () => upgradeToSkill(cmd),
        });
        items.push({ separator: true });
        items.push({
            label: cw.actions.delete,
            action: () => deleteCommand(cmd),
        });
    }

    if (!menu || typeof menu.show !== 'function') return;
    menu.show(x, y, items);
}

async function deleteCommand(cmd) {
    const cw = S.commands_widget;
    const cwd = window.app?.activeSession?.cwd || '/';
    const msg = cw.confirm.delete.replace('{name}', cmd.name);
    if (!(await appConfirm(msg, { confirmLabel: 'Delete', danger: true }))) return;
    try {
        const r = await fetch(
            `${CONFIG.API_BASE}/api/commands/${encodeURIComponent(cmd.scope)}/${encodeURIComponent(cmd.name)}?cwd=${encodeURIComponent(cwd)}`,
            { method: 'DELETE' }
        );
        if (!r.ok) {
            const b = await r.json().catch(() => ({}));
            throw new Error(b.detail || `HTTP ${r.status}`);
        }
        window.app?.showToast?.(cw.toast.deleted.replace('{name}', cmd.name));
        if (state.expandedId === cmd.id) {
            state.expandedId = null;
            state.editorState = null;
        }
        await loadCommands();
    } catch (e) {
        alert(cw.toast.delete_failed.replace('{error}', e.message));
    }
}

async function upgradeToSkill(cmd) {
    const cw = S.commands_widget;
    const cwd = window.app?.activeSession?.cwd || '/';
    try {
        const r = await fetch(
            `${CONFIG.API_BASE}/api/commands/${encodeURIComponent(cmd.scope)}/${encodeURIComponent(cmd.name)}/upgrade?cwd=${encodeURIComponent(cwd)}`,
            { method: 'POST' }
        );
        if (!r.ok) {
            const b = await r.json().catch(() => ({}));
            throw new Error(b.detail || `HTTP ${r.status}`);
        }
        const result = await r.json();
        window.app?.showToast?.(cw.toast.upgraded.replace('{name}', result.name));
        // Drop the `~` picker cache so it picks up the new skill immediately
        invalidateSkillsCache();
        // Refresh local listing
        await loadCommands();
        // Also kick the Skills widget to reload if it's mounted
        window.__skillsWidgetReload?.();
    } catch (e) {
        alert(cw.toast.upgrade_failed.replace('{error}', e.message));
    }
}

// ══════════════════════════════════════════════════════════════════
// REGISTRATION
// ══════════════════════════════════════════════════════════════════

export function registerCommandsWidget() {
    WidgetManager.register('commands', {
        title: S.widgets.titles.commands,
        icon: 'chevron-right',
        type: 'floating',
        scope: 'global',
        defaultWidth: 760,
        defaultHeight: 620,

        headerActions: [
            {
                icon: 'refresh',
                title: S.commands_widget.refresh_tooltip,
                onClick: () => loadCommands(),
            },
        ],

        render(container) {
            state.container = container;
            // Borrow skills-widget CSS by adding both classes (CSS rules in 62-skills-widget.css use `.skills-widget`).
            container.classList.add('commands-widget', 'skills-widget');
            loadCommands();
        },

        onOpen() {
            state.expandedId = null;
            state.editorState = null;
            loadCommands();
            requestAnimationFrame(() => {
                state.container?.querySelector('.sk-search')?.focus();
            });
        },

        onClose() {
            state.expandedId = null;
            state.editorState = null;
        },
    });

    debug.log('[CommandsWidget] registered');
}

export const CommandsWidget = {
    open: () => WidgetManager.open('commands'),
    close: () => WidgetManager.close('commands'),
    toggle: () => WidgetManager.toggle('commands'),
    reload: () => loadCommands(),
};

if (typeof window !== 'undefined') {
    window.__commandsWidgetReload = () => loadCommands();
}
