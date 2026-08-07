/**
 * Agents Manager Widget
 *
 * Floating widget that lists agent definition files (project + personal) with
 * search, scope pills, and an inline raw editor for the agent's `.md` body.
 *
 * Mirrors `skills-widget.js` in shape, but for flat `<name>.md` files in
 * `~/.claude/agents/` (personal) and `<cwd>/.claude/agents/` (project).
 *
 * Distinct from the Sub-Agents widget (`sub-agents-widget.js`), which is a
 * runtime monitor for Task-tool invocations.
 */

import S from '../strings.js';
import { escapeHtml, appConfirm } from '../utils.js';
import { CONFIG, debug } from '../config.js';
import { WidgetManager } from '../widget-system/index.js';
import {
    loadAgentPatterns,
    saveAgentPatterns,
    DEFAULT_AGENT_PATTERN,
    loadDisabledAgents,
    saveDisabledAgents,
} from '../snippets-autocomplete.js';

const PREF_KEY_CURRENT = 'agents-current-project-only';
const PREF_KEY_VIEW = 'agents-view-mode';
const PREF_KEY_SETTINGS_OPEN = 'agents-settings-section-open';

const state = {
    container: null,
    agents: [],
    counts: { project: 0, personal: 0 },
    loading: false,
    error: null,
    search: '',
    originFilter: 'all',
    currentProjectOnly: loadCurrentProjectOnly(),
    viewMode: loadViewMode(),
    expandedId: null,
    editorState: null,
    lastFetchKey: null,
    settingsOpen: loadSettingsOpen(),
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
function loadSettingsOpen() {
    try { return localStorage.getItem(PREF_KEY_SETTINGS_OPEN) !== 'false'; }
    catch { return true; }
}
function saveSettingsOpen(v) {
    try { localStorage.setItem(PREF_KEY_SETTINGS_OPEN, v ? 'true' : 'false'); } catch {}
}

// ══════════════════════════════════════════════════════════════════
// DATA LOADING
// ══════════════════════════════════════════════════════════════════

async function loadAgents() {
    const cwd = window.app?.activeSession?.cwd || '/';
    state.loading = true;
    state.error = null;
    state.lastFetchKey = cwd;
    renderShell();
    try {
        const r = await fetch(`${CONFIG.API_BASE}/api/agents?cwd=${encodeURIComponent(cwd)}`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        state.agents = data.agents || [];
        state.counts = data.counts || { project: 0, personal: 0 };
    } catch (e) {
        state.error = String(e.message || e);
    } finally {
        state.loading = false;
        renderShell();
    }
}

// ══════════════════════════════════════════════════════════════════
// FILTERING
// ══════════════════════════════════════════════════════════════════

function filteredAgents() {
    const q = state.search.trim().toLowerCase();
    const origin = state.originFilter;
    return state.agents.filter(a => {
        if (state.currentProjectOnly && a.scope !== 'project') return false;
        if (origin !== 'all' && a.scope !== origin) return false;
        if (!q) return true;
        if (a.name.toLowerCase().includes(q)) return true;
        if ((a.description || '').toLowerCase().includes(q)) return true;
        if ((a.body_preview || '').toLowerCase().includes(q)) return true;
        return false;
    });
}

// ══════════════════════════════════════════════════════════════════
// RENDERING
// ══════════════════════════════════════════════════════════════════

const ICONS = {
    folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
    layers: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>',
    document: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
    eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
    eyeOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>',
};

function scopeIcon(scope) {
    if (scope === 'project') return ICONS.folder;
    if (scope === 'personal') return ICONS.layers;
    return ICONS.document;
}

function renderShell() {
    if (!state.container) return;

    const filtered = filteredAgents();
    const aw = S.agents_widget;

    const pills = ['all', 'project', 'personal'].map(k => {
        const label = aw.filters[k];
        const count = k === 'all' ? state.agents.length : (state.counts[k] ?? 0);
        const active = state.originFilter === k ? 'active' : '';
        return `<button class="sk-pill ${active}" data-filter="${k}">
            <span class="sk-pill-label">${label}</span>
            <span class="sk-pill-count">${count}</span>
        </button>`;
    }).join('');

    state.container.innerHTML = `
        ${renderSettingsSection()}
        <div class="sk-toolbar">
            <div class="sk-search-wrap">
                <svg class="sk-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                </svg>
                <input type="text" class="sk-search" placeholder="${aw.search_placeholder}"
                    value="${escapeHtml(state.search)}" autocomplete="off" spellcheck="false" />
            </div>
            <label class="sk-current-toggle" title="${escapeHtml(aw.current_project_tooltip)}">
                <input type="checkbox" ${state.currentProjectOnly ? 'checked' : ''} />
                <span>${aw.current_project_label}</span>
            </label>
            <div class="sk-view-toggle">
                <button class="sk-view-btn ${state.viewMode === 'grid' ? 'active' : ''}" data-view="grid" title="${aw.view_grid}" data-tooltip="${aw.view_grid}">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
                </button>
                <button class="sk-view-btn ${state.viewMode === 'list' ? 'active' : ''}" data-view="list" title="${aw.view_list}" data-tooltip="${aw.view_list}">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
                </button>
            </div>
            <button class="sk-new-btn" data-tooltip="${aw.actions.new_tooltip}" title="${aw.actions.new_tooltip}">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                <span>${aw.actions.new}</span>
            </button>
        </div>
        <div class="sk-pills">${pills}</div>
        <div class="sk-body sk-body--${state.viewMode}">
            ${renderBody(filtered)}
        </div>
    `;

    attachSettingsHandlers();
    attachToolbarHandlers();
    attachCardHandlers();
    if (state.expandedId) {
        mountEditor(state.expandedId);
        if (state._scrollToExpanded) {
            state._scrollToExpanded = false;
            requestAnimationFrame(() => {
                state.container?.querySelector(`.sk-card[data-id="${CSS.escape(state.expandedId)}"]`)
                    ?.scrollIntoView({ block: 'start', behavior: 'smooth' });
            });
        }
    }
}

function renderSettingsSection() {
    const patterns = loadAgentPatterns();
    const currentPattern = patterns.global !== DEFAULT_AGENT_PATTERN ? patterns.global : '';
    const open = state.settingsOpen;

    return `
        <div class="ag-settings ${open ? '' : 'collapsed'}">
            <button class="ag-settings-header" type="button" aria-expanded="${open}">
                <svg class="ag-settings-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="6 9 12 15 18 9"/>
                </svg>
                <span class="ag-settings-title">${S.settings.sections.agent_pattern}</span>
            </button>
            <div class="ag-settings-body">
                <p class="ag-settings-hint">Use <code>{agent}</code> as placeholder for agent name</p>
                <div class="ag-pattern-row">
                    <input type="text" id="ag-global-pattern" class="ag-pattern-input"
                           placeholder="${escapeHtml(DEFAULT_AGENT_PATTERN)}"
                           value="${escapeHtml(currentPattern)}">
                    <button class="ag-pattern-reset" id="ag-reset-pattern" data-tooltip="Reset to default" type="button">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
                            <path d="M3 3v5h5"/>
                        </svg>
                    </button>
                </div>
            </div>
        </div>
    `;
}

function attachSettingsHandlers() {
    const root = state.container;
    if (!root) return;

    root.querySelector('.ag-settings-header')?.addEventListener('click', () => {
        state.settingsOpen = !state.settingsOpen;
        saveSettingsOpen(state.settingsOpen);
        renderShell();
    });

    const patternInput = root.querySelector('#ag-global-pattern');
    const persistPattern = () => {
        const value = patternInput.value.trim();
        const patterns = loadAgentPatterns();
        patterns.global = value || DEFAULT_AGENT_PATTERN;
        saveAgentPatterns(patterns);
    };
    patternInput?.addEventListener('change', persistPattern);
    patternInput?.addEventListener('blur', persistPattern);

    root.querySelector('#ag-reset-pattern')?.addEventListener('click', () => {
        const patterns = loadAgentPatterns();
        patterns.global = DEFAULT_AGENT_PATTERN;
        saveAgentPatterns(patterns);
        if (patternInput) patternInput.value = '';
    });
}

function renderBody(filtered) {
    const aw = S.agents_widget;
    if (state.loading && state.agents.length === 0) {
        return `<div class="sk-empty">Loading…</div>`;
    }
    if (state.error) {
        return `<div class="sk-empty sk-error">${escapeHtml(aw.load_failed.replace('{error}', state.error))}</div>`;
    }
    if (filtered.length === 0) {
        const msg = state.search
            ? aw.empty.no_match
            : state.currentProjectOnly && state.counts.project === 0
                ? aw.empty.no_project
                : aw.empty.no_agents;
        return `<div class="sk-empty">${escapeHtml(msg)}</div>`;
    }

    const groups = { project: [], personal: [] };
    for (const a of filtered) {
        (groups[a.scope] || (groups[a.scope] = [])).push(a);
    }

    const out = [];
    for (const scope of ['project', 'personal']) {
        const arr = groups[scope];
        if (!arr || arr.length === 0) continue;
        out.push(`<div class="sk-group" data-scope="${scope}">
            <div class="sk-group-header">
                <span class="sk-group-icon">${scopeIcon(scope)}</span>
                <span class="sk-group-label">${aw.groups[scope]}</span>
                <span class="sk-group-count">${arr.length}</span>
            </div>
            <div class="sk-gallery">
                ${arr.map(renderCard).join('')}
            </div>
        </div>`);
    }
    return out.join('');
}

function renderCard(a) {
    const aw = S.agents_widget;
    const name = escapeHtml(a.name);
    const desc = a.description
        ? escapeHtml(a.description)
        : `<em>${aw.meta.no_description}</em>`;

    const tools = typeof a.frontmatter?.tools === 'string'
        ? a.frontmatter.tools.split(',').map(s => s.trim()).filter(Boolean)
        : Array.isArray(a.frontmatter?.tools) ? a.frontmatter.tools : [];
    const toolsCount = tools.length;
    const model = a.frontmatter?.model || '';

    const shadowed = a.shadowed_by
        ? `<span class="sk-shadow" title="Shadowed by ${escapeHtml(a.shadowed_by)}">⚠</span>`
        : '';

    const meta = [
        toolsCount ? `<span class="sk-meta-chip" title="${escapeHtml(tools.join(', '))}">⚙ ${aw.meta.tools_count.replace('{n}', toolsCount)}</span>` : '',
        model ? `<span class="sk-meta-chip">${escapeHtml(model)}</span>` : '',
    ].filter(Boolean).join('');

    const expanded = state.expandedId === a.id ? 'sk-card--expanded' : '';

    const hidden = loadDisabledAgents().has(a.id);
    const st = aw.suggest_toggle;
    const eyeBtn = `<button class="sk-card-eye${hidden ? ' is-hidden' : ''}" data-eye-id="${escapeHtml(a.id)}" type="button"
                data-tooltip="${escapeHtml(hidden ? st.show_tooltip : st.hide_tooltip)}"
                title="${escapeHtml(hidden ? st.show_tooltip : st.hide_tooltip)}"
                aria-label="${escapeHtml(hidden ? st.show_label : st.hide_label)}">${hidden ? ICONS.eyeOff : ICONS.eye}</button>`;

    return `
        <div class="sk-card sk-card--${a.scope} ${expanded}${hidden ? ' sk-card--hidden' : ''}" data-id="${escapeHtml(a.id)}" data-scope="${a.scope}">
            <div class="sk-card-head">
                <span class="sk-card-icon">${scopeIcon(a.scope)}</span>
                <span class="sk-card-name">${name}</span>
                <span class="sk-card-badges">${shadowed}</span>
                ${eyeBtn}
            </div>
            <p class="sk-card-desc">${desc}</p>
            ${meta ? `<div class="sk-card-meta">${meta}</div>` : ''}
            <div class="sk-card-detail" data-detail-for="${escapeHtml(a.id)}"></div>
        </div>
    `;
}

function renderEditor(agent, detail) {
    const aw = S.agents_widget;
    const dirty = state.editorState?.dirty;
    return `
        <div class="sk-editor" data-id="${escapeHtml(agent.id)}">
            <div class="sk-editor-head">
                <span class="sk-editor-path" title="${escapeHtml(detail.path)}">${escapeHtml(detail.path)}</span>
                ${dirty ? `<span class="sk-editor-dirty">${aw.editor.dirty_indicator}</span>` : ''}
            </div>
            <textarea class="sk-editor-textarea" spellcheck="false">${escapeHtml(detail.raw)}</textarea>
            <div class="sk-editor-foot">
                <button class="sk-btn sk-btn--ghost sk-cancel-btn">${aw.actions.cancel}</button>
                <button class="sk-btn sk-btn--ghost sk-open-full-btn">${aw.actions.open_full_editor}</button>
                <button class="sk-btn sk-btn--primary sk-save-btn" ${dirty ? '' : 'disabled'}>${aw.actions.save}</button>
            </div>
        </div>
    `;
}

// ══════════════════════════════════════════════════════════════════
// EVENT HANDLERS
// ══════════════════════════════════════════════════════════════════

function attachToolbarHandlers() {
    const root = state.container;
    if (!root) return;

    const search = root.querySelector('.sk-search');
    if (search) {
        let focused = document.activeElement === search;
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

    root.querySelector('.sk-new-btn')?.addEventListener('click', () => {
        openNewAgentModal();
    });
}

function rerenderBodyOnly() {
    const body = state.container?.querySelector('.sk-body');
    if (!body) return renderShell();
    const filtered = filteredAgents();
    body.className = `sk-body sk-body--${state.viewMode}`;
    body.innerHTML = renderBody(filtered);
    attachCardHandlers();
    if (state.expandedId) mountEditor(state.expandedId);
}

function attachCardHandlers() {
    const root = state.container;
    if (!root) return;

    root.querySelectorAll('.sk-card-eye').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleAgentSuggest(btn.dataset.eyeId);
        });
    });

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
            const agent = state.agents.find(a => a.id === id);
            if (agent) showCardContextMenu(e.clientX, e.clientY, agent);
        });
    });
}

async function mountEditor(id) {
    const [scope, ...rest] = id.split(':');
    const name = rest.join(':');
    const card = state.container?.querySelector(`.sk-card[data-id="${CSS.escape(id)}"]`);
    const detailEl = card?.querySelector('.sk-card-detail');
    if (!detailEl) return;

    if (detailEl.dataset.mounted === '1' && state.editorState) return;

    detailEl.innerHTML = `<div class="sk-editor-loading">Loading…</div>`;
    detailEl.dataset.mounted = '1';

    const agent = state.agents.find(a => a.id === id);
    if (!agent) return;

    let detail;
    try {
        const cwd = window.app?.activeSession?.cwd || '/';
        const r = await fetch(`${CONFIG.API_BASE}/api/agents/${encodeURIComponent(scope)}/${encodeURIComponent(name)}?cwd=${encodeURIComponent(cwd)}`);
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
    detailEl.innerHTML = renderEditor(agent, detail);
    bindEditorHandlers(detailEl, agent, detail);
}

function bindEditorHandlers(root, agent /*, detail */) {
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
                    ?.insertAdjacentHTML('beforeend', `<span class="sk-editor-dirty">${S.agents_widget.editor.dirty_indicator}</span>`);
            } else if (!nowDirty && existing) {
                existing.remove();
            }
        }
    });

    cancelBtn?.addEventListener('click', async () => {
        if (state.editorState?.dirty && !(await appConfirm(S.agents_widget.editor.discard_confirm, { confirmLabel: 'Discard', danger: true }))) return;
        state.expandedId = null;
        state.editorState = null;
        rerenderBodyOnly();
    });

    openFullBtn?.addEventListener('click', () => {
        const WM = window.WidgetManager;
        if (WM && typeof WM.open === 'function') {
            WM.open('file-preview', { filePath: agent.path });
        }
    });

    saveBtn?.addEventListener('click', async () => {
        if (!state.editorState || state.editorState.saving) return;
        state.editorState.saving = true;
        saveBtn.disabled = true;
        saveBtn.textContent = '…';
        try {
            const cwd = window.app?.activeSession?.cwd || '/';
            const r = await fetch(`${CONFIG.API_BASE}/api/agents/${encodeURIComponent(agent.scope)}/${encodeURIComponent(agent.name)}?cwd=${encodeURIComponent(cwd)}`, {
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
            window.app?.showToast?.(S.agents_widget.toast.saved.replace('{name}', agent.name));
            await loadAgents();
        } catch (e) {
            alert(S.agents_widget.editor.save_failed.replace('{error}', e.message));
        } finally {
            if (state.editorState) state.editorState.saving = false;
            const b = state.container?.querySelector(`.sk-card[data-id="${CSS.escape(agent.id)}"] .sk-save-btn`);
            if (b) {
                b.textContent = S.agents_widget.actions.save;
                b.disabled = !state.editorState?.dirty;
            }
        }
    });
}

// ══════════════════════════════════════════════════════════════════
// CONTEXT MENU + ACTIONS
// ══════════════════════════════════════════════════════════════════

/**
 * Toggle whether an agent is suggested in the `#` autocomplete. The hidden
 * set is shared with snippets-autocomplete (server-backed `disabled_agents`),
 * keyed by the `scope:name` agent id.
 */
function toggleAgentSuggest(id) {
    const aw = S.agents_widget;
    const disabled = new Set(loadDisabledAgents());
    const willHide = !disabled.has(id);
    if (willHide) disabled.add(id);
    else disabled.delete(id);
    saveDisabledAgents(disabled);

    const agent = state.agents.find(a => a.id === id);
    const name = agent?.name || id;
    window.app?.showToast?.(
        (willHide ? aw.toast.hidden_from_suggest : aw.toast.shown_in_suggest).replace('{name}', name)
    );
    rerenderBodyOnly();
}

function showCardContextMenu(x, y, agent) {
    const aw = S.agents_widget;
    const menu = window.app?.contextMenu;
    const items = [];

    items.push({
        label: aw.actions.copy_name,
        action: () => {
            if (navigator.clipboard) navigator.clipboard.writeText(agent.name);
            window.app?.showToast?.(aw.toast.copied_name.replace('{name}', agent.name));
        },
    });
    items.push({
        label: aw.actions.copy_path,
        action: () => {
            if (navigator.clipboard) navigator.clipboard.writeText(agent.path);
            window.app?.showToast?.(aw.toast.copied_path);
        },
    });

    items.push({ separator: true });

    items.push({
        label: loadDisabledAgents().has(agent.id)
            ? aw.actions.show_in_suggest
            : aw.actions.hide_from_suggest,
        action: () => toggleAgentSuggest(agent.id),
    });

    items.push({ separator: true });

    items.push({
        label: aw.actions.duplicate_to_project,
        action: () => duplicateAgent(agent, 'project'),
    });
    items.push({
        label: aw.actions.duplicate_to_personal,
        action: () => duplicateAgent(agent, 'personal'),
    });

    items.push({ separator: true });
    items.push({
        label: aw.actions.delete,
        action: () => deleteAgent(agent),
    });

    if (!menu || typeof menu.show !== 'function') return;
    menu.show(x, y, items);
}

async function duplicateAgent(agent, targetScope) {
    const aw = S.agents_widget;
    const cwd = window.app?.activeSession?.cwd || '/';
    try {
        const r = await fetch(
            `${CONFIG.API_BASE}/api/agents/${encodeURIComponent(agent.scope)}/${encodeURIComponent(agent.name)}/duplicate?cwd=${encodeURIComponent(cwd)}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ target_scope: targetScope }),
            }
        );
        if (!r.ok) {
            const b = await r.json().catch(() => ({}));
            throw new Error(b.detail || `HTTP ${r.status}`);
        }
        const result = await r.json();
        window.app?.showToast?.(aw.toast.duplicated.replace('{name}', result.name));
        state.expandedId = result.id;
        state.editorState = null;
        await loadAgents();
        await mountEditor(result.id);
        scrollCardIntoView(result.id);
    } catch (e) {
        alert(aw.toast.duplicate_failed.replace('{error}', e.message));
    }
}

async function deleteAgent(agent) {
    const aw = S.agents_widget;
    const cwd = window.app?.activeSession?.cwd || '/';
    const msg = aw.confirm.delete.replace('{name}', agent.name);
    if (!(await appConfirm(msg, { confirmLabel: 'Delete', danger: true }))) return;
    try {
        const r = await fetch(
            `${CONFIG.API_BASE}/api/agents/${encodeURIComponent(agent.scope)}/${encodeURIComponent(agent.name)}?cwd=${encodeURIComponent(cwd)}`,
            { method: 'DELETE' }
        );
        if (!r.ok) {
            const b = await r.json().catch(() => ({}));
            throw new Error(b.detail || `HTTP ${r.status}`);
        }
        window.app?.showToast?.(aw.toast.deleted.replace('{name}', agent.name));
        if (state.expandedId === agent.id) {
            state.expandedId = null;
            state.editorState = null;
        }
        await loadAgents();
    } catch (e) {
        alert(aw.toast.delete_failed.replace('{error}', e.message));
    }
}

function scrollCardIntoView(id) {
    requestAnimationFrame(() => {
        state.container
            ?.querySelector(`.sk-card[data-id="${CSS.escape(id)}"]`)
            ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
}

// ══════════════════════════════════════════════════════════════════
// NEW AGENT MODAL
// ══════════════════════════════════════════════════════════════════

const TEMPLATES = ['blank', 'researcher', 'reviewer', 'implementer'];

function openNewAgentModal() {
    const aw = S.agents_widget;
    const c = aw.create;

    document.querySelector('.sk-modal-backdrop')?.remove();

    const backdrop = document.createElement('div');
    backdrop.className = 'sk-modal-backdrop';

    const templateOptions = TEMPLATES.map((t) => `
        <label class="sk-tpl-option">
            <input type="radio" name="sk-tpl" value="${t}" ${t === 'blank' ? 'checked' : ''} />
            <div class="sk-tpl-content">
                <div class="sk-tpl-label">${c.templates[t]}</div>
                <div class="sk-tpl-desc">${c.templates[`${t}_desc`]}</div>
            </div>
        </label>
    `).join('');

    backdrop.innerHTML = `
        <div class="sk-modal" role="dialog" aria-modal="true">
            <div class="sk-modal-head">
                <h3>${c.title}</h3>
                <button class="sk-modal-close" aria-label="Close">×</button>
            </div>
            <div class="sk-modal-body">
                <div class="sk-form-row">
                    <label>${c.scope_label}</label>
                    <div class="sk-scope-picker">
                        <label><input type="radio" name="sk-scope" value="project" checked /> Project</label>
                        <label><input type="radio" name="sk-scope" value="personal" /> Personal (~/.claude)</label>
                    </div>
                </div>
                <div class="sk-form-row">
                    <label for="sk-new-name">${c.name_label}</label>
                    <input type="text" id="sk-new-name" class="sk-input" placeholder="${c.name_placeholder}" autocomplete="off" spellcheck="false" />
                    <div class="sk-form-hint">${c.name_hint}</div>
                    <div class="sk-form-error" id="sk-new-name-error"></div>
                </div>
                <div class="sk-form-row">
                    <label for="sk-new-desc">${c.description_label}</label>
                    <textarea id="sk-new-desc" class="sk-input sk-textarea-short" rows="2" placeholder="${c.description_placeholder}"></textarea>
                    <div class="sk-form-hint">${c.description_hint}</div>
                </div>
                <div class="sk-form-row">
                    <label>${c.template_label}</label>
                    <div class="sk-tpl-list">${templateOptions}</div>
                </div>
            </div>
            <div class="sk-modal-foot">
                <button class="sk-btn sk-btn--ghost sk-modal-cancel">${aw.actions.cancel}</button>
                <button class="sk-btn sk-btn--primary sk-modal-submit">${c.submit}</button>
            </div>
        </div>
    `;

    document.body.appendChild(backdrop);

    const closeModal = () => backdrop.remove();
    backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) closeModal();
    });
    backdrop.querySelector('.sk-modal-close')?.addEventListener('click', closeModal);
    backdrop.querySelector('.sk-modal-cancel')?.addEventListener('click', closeModal);

    const nameInput = backdrop.querySelector('#sk-new-name');
    const errEl = backdrop.querySelector('#sk-new-name-error');
    nameInput?.focus();

    backdrop.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeModal();
        if (e.key === 'Enter' && (e.target === nameInput || e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            backdrop.querySelector('.sk-modal-submit')?.click();
        }
    });

    backdrop.querySelector('.sk-modal-submit')?.addEventListener('click', async () => {
        const nm = (nameInput?.value || '').trim();
        const scope = backdrop.querySelector('input[name="sk-scope"]:checked')?.value;
        const desc = (backdrop.querySelector('#sk-new-desc')?.value || '').trim();
        const template = backdrop.querySelector('input[name="sk-tpl"]:checked')?.value || 'blank';

        errEl.textContent = '';
        if (!/^[a-z][a-z0-9-]{0,63}$/.test(nm)) {
            errEl.textContent = c.name_hint;
            nameInput?.focus();
            return;
        }
        await createAgent({ scope, name: nm, description: desc, template });
        closeModal();
    });
}

async function createAgent({ scope, name, description, template }) {
    const aw = S.agents_widget;
    const cwd = window.app?.activeSession?.cwd || '/';
    try {
        const r = await fetch(
            `${CONFIG.API_BASE}/api/agents/${encodeURIComponent(scope)}/${encodeURIComponent(name)}?cwd=${encodeURIComponent(cwd)}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ description, template }),
            }
        );
        if (!r.ok) {
            const b = await r.json().catch(() => ({}));
            throw new Error(b.detail || `HTTP ${r.status}`);
        }
        const result = await r.json();
        window.app?.showToast?.(aw.create.created.replace('{name}', result.name));
        if (state.originFilter !== 'all' && state.originFilter !== scope) {
            state.originFilter = 'all';
        }
        if (scope === 'personal' && state.currentProjectOnly) {
            state.currentProjectOnly = false;
            saveCurrentProjectOnly(false);
        }
        state.expandedId = result.id;
        state.editorState = null;
        await loadAgents();
        await mountEditor(result.id);
        scrollCardIntoView(result.id);
    } catch (e) {
        alert(aw.create.create_failed.replace('{error}', e.message));
    }
}

// ══════════════════════════════════════════════════════════════════
// REGISTRATION
// ══════════════════════════════════════════════════════════════════

export function registerAgentsWidget() {
    WidgetManager.register('agents', {
        title: S.widgets.titles.agents,
        icon: 'brain',
        type: 'floating',
        scope: 'global',
        defaultWidth: 760,
        defaultHeight: 620,

        headerActions: [
            {
                icon: 'refresh',
                title: S.agents_widget.refresh_tooltip,
                onClick: () => loadAgents(),
            },
        ],

        render(container, ctx) {
            state.container = container;
            container.classList.add('skills-widget');
            if (ctx?.expandAgentId) {
                state.search = '';
                state.originFilter = 'all';
                state.currentProjectOnly = false;
                state.expandedId = ctx.expandAgentId;
                state.editorState = null;
                state._scrollToExpanded = true;
            }
            loadAgents();
        },

        onOpen() {
            loadAgents();
            requestAnimationFrame(() => {
                state.container?.querySelector('.sk-search')?.focus();
            });
        },

        onClose() {
            state.expandedId = null;
            state.editorState = null;
        },
    });

    debug.log('[AgentsWidget] registered');
}

export const AgentsWidget = {
    open: () => WidgetManager.open('agents'),
    close: () => WidgetManager.close('agents'),
    toggle: () => WidgetManager.toggle('agents'),
    reload: () => loadAgents(),
};

if (typeof window !== 'undefined') {
    window.__agentsWidgetReload = () => loadAgents();
}
