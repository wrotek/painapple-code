/**
 * Skills Manager Widget
 *
 * Floating widget that lists folder-form Claude Code skills (project +
 * personal + plugin) with search, scope pills, and an inline raw editor
 * for SKILL.md.
 *
 * Pattern mirrors prompt-explorer-widget.js: search + filter + expandable cards.
 * Plugin skills are read-only. Legacy `commands/<name>.md` files live in the
 * Commands widget — see `commands-widget.js`.
 */

import S from '../strings.js';
import { escapeHtml, appConfirm } from '../utils.js';
import { CONFIG, debug } from '../config.js';
import { WidgetManager } from '../widget-system/index.js';
import { invalidateSkillsCache } from '../skills-autocomplete.js';

const PREF_KEY_CURRENT = 'skills-current-project-only';
const PREF_KEY_VIEW = 'skills-view-mode';

const state = {
    container: null,
    skills: [],
    counts: { project: 0, personal: 0, plugin: 0 },
    loading: false,
    error: null,
    search: '',
    originFilter: 'all',
    currentProjectOnly: loadCurrentProjectOnly(),
    viewMode: loadViewMode(),
    expandedId: null,   // `${scope}:${name}` of the card currently in edit/preview
    editorState: null,  // { raw, dirty, mtime, saving }
    lastFetchKey: null,
};

function loadCurrentProjectOnly() {
    try { return localStorage.getItem(PREF_KEY_CURRENT) !== 'false'; }
    catch { return true; }
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

async function loadSkills() {
    const cwd = window.app?.activeSession?.cwd || '/';
    state.loading = true;
    state.error = null;
    state.lastFetchKey = cwd;
    // Drop the `$` picker cache so it picks up any creates/deletes immediately.
    invalidateSkillsCache();
    renderShell();
    try {
        const r = await fetch(`${CONFIG.API_BASE}/api/skills?cwd=${encodeURIComponent(cwd)}`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        state.skills = data.skills || [];
        state.counts = data.counts || { project: 0, personal: 0, plugin: 0 };
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

function filteredSkills() {
    const q = state.search.trim().toLowerCase();
    const origin = state.originFilter;
    return state.skills.filter(s => {
        if (state.currentProjectOnly && s.scope !== 'project') return false;
        if (origin !== 'all' && s.scope !== origin) return false;
        if (!q) return true;
        if (s.name.toLowerCase().includes(q)) return true;
        if ((s.description || '').toLowerCase().includes(q)) return true;
        if ((s.body_preview || '').toLowerCase().includes(q)) return true;
        return false;
    });
}

// ══════════════════════════════════════════════════════════════════
// RENDERING
// ══════════════════════════════════════════════════════════════════

const ICONS = {
    sparkles: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3l2.09 4.26L18.5 8l-3.5 3.41.83 4.84L12 14l-3.83 2.25.83-4.84L5.5 8l4.41-.74L12 3z"/><path d="M5 18l1 2 2 1-2 1-1 2-1-2-2-1 2-1 1-2z"/></svg>',
    folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
    layers: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>',
    cube: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>',
    document: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
    pencil: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>',
    refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>',
};

function scopeIcon(scope) {
    if (scope === 'project') return ICONS.folder;
    if (scope === 'personal') return ICONS.layers;
    if (scope === 'plugin') return ICONS.cube;
    return ICONS.document;
}

function renderShell() {
    if (!state.container) return;

    const filtered = filteredSkills();
    const sw = S.skills_widget;

    const pills = ['all', 'project', 'personal', 'plugin'].map(k => {
        const label = k === 'all'
            ? sw.filters.all
            : sw.filters[k];
        const count = k === 'all'
            ? state.skills.length
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
                <input type="text" class="sk-search" placeholder="${sw.search_placeholder}"
                    value="${escapeHtml(state.search)}" autocomplete="off" spellcheck="false" />
            </div>
            <label class="sk-current-toggle" title="${escapeHtml(sw.current_project_tooltip)}">
                <input type="checkbox" ${state.currentProjectOnly ? 'checked' : ''} />
                <span>${sw.current_project_label}</span>
            </label>
            <div class="sk-view-toggle">
                <button class="sk-view-btn ${state.viewMode === 'grid' ? 'active' : ''}" data-view="grid" title="${sw.view_grid}" data-tooltip="${sw.view_grid}">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
                </button>
                <button class="sk-view-btn ${state.viewMode === 'list' ? 'active' : ''}" data-view="list" title="${sw.view_list}" data-tooltip="${sw.view_list}">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
                </button>
            </div>
            <button class="sk-new-btn" data-tooltip="${sw.actions.new_tooltip}" title="${sw.actions.new_tooltip}">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                <span>${sw.actions.new}</span>
            </button>
        </div>
        <div class="sk-pills">${pills}</div>
        <div class="sk-body sk-body--${state.viewMode}">
            ${renderBody(filtered)}
        </div>
    `;

    attachToolbarHandlers();
    attachCardHandlers();
    if (state.expandedId) {
        // Restore editor content if a card was open
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

function renderBody(filtered) {
    if (state.loading && state.skills.length === 0) {
        return `<div class="sk-empty">Loading…</div>`;
    }
    if (state.error) {
        return `<div class="sk-empty sk-error">${escapeHtml(S.skills_widget.load_failed.replace('{error}', state.error))}</div>`;
    }
    if (filtered.length === 0) {
        const msg = state.search
            ? S.skills_widget.empty.no_match
            : state.currentProjectOnly && state.counts.project === 0
                ? S.skills_widget.empty.no_project
                : S.skills_widget.empty.no_skills;
        return `<div class="sk-empty">${escapeHtml(msg)}</div>`;
    }

    // Group by scope
    const groups = { project: [], personal: [], plugin: [] };
    for (const s of filtered) {
        (groups[s.scope] || (groups[s.scope] = [])).push(s);
    }

    const out = [];
    for (const scope of ['project', 'personal', 'plugin']) {
        const arr = groups[scope];
        if (!arr || arr.length === 0) continue;
        out.push(`<div class="sk-group" data-scope="${scope}">
            <div class="sk-group-header">
                <span class="sk-group-icon">${scopeIcon(scope)}</span>
                <span class="sk-group-label">${S.skills_widget.groups[scope]}</span>
                <span class="sk-group-count">${arr.length}</span>
            </div>
            <div class="sk-gallery">
                ${arr.map(renderCard).join('')}
            </div>
        </div>`);
    }
    return out.join('');
}

function renderCard(s) {
    const sw = S.skills_widget;
    const name = escapeHtml(s.name);
    const desc = s.description
        ? escapeHtml(s.description)
        : `<em>${sw.meta.no_description}</em>`;

    const tools = Array.isArray(s.frontmatter?.['allowed-tools'])
        ? s.frontmatter['allowed-tools']
        : (typeof s.frontmatter?.['allowed-tools'] === 'string'
            ? s.frontmatter['allowed-tools'].trim().split(/\s+/).filter(Boolean)
            : []);
    const toolsCount = tools.length;

    const filesCount = (s.supporting_files || []).length;
    const forks = s.frontmatter?.context === 'fork';
    const invMode = sw.invocation[s.invocation_mode?.replace('-', '_')] || '';
    const pluginBadge = s.scope_label && s.scope === 'plugin'
        ? `<span class="sk-badge sk-badge--plugin" title="${escapeHtml(s.scope_label)}">${escapeHtml(s.scope_label.split(' ')[0])}</span>`
        : '';
    const readonlyBadge = !s.editable
        ? `<span class="sk-badge sk-badge--ro">${sw.badges.read_only}</span>`
        : '';
    const forksBadge = forks
        ? `<span class="sk-badge sk-badge--forks">⤴ ${sw.badges.forks}</span>`
        : '';
    const shadowed = s.shadowed_by
        ? `<span class="sk-shadow" title="Shadowed by ${escapeHtml(s.shadowed_by)}">⚠</span>`
        : '';

    const meta = [
        toolsCount ? `<span class="sk-meta-chip" title="${escapeHtml(tools.join(', '))}">⚙ ${sw.meta.tools_count.replace('{n}', toolsCount)}</span>` : '',
        filesCount ? `<span class="sk-meta-chip">📎 ${sw.meta.files_count.replace('{n}', filesCount)}</span>` : '',
        invMode ? `<span class="sk-meta-chip sk-meta-chip--mode sk-meta-chip--${s.invocation_mode}">${invMode}</span>` : '',
    ].filter(Boolean).join('');

    const expanded = state.expandedId === s.id ? 'sk-card--expanded' : '';

    return `
        <div class="sk-card sk-card--${s.scope} ${expanded}" data-id="${escapeHtml(s.id)}" data-scope="${s.scope}">
            <div class="sk-card-head">
                <span class="sk-card-icon">${scopeIcon(s.scope)}</span>
                <span class="sk-card-name">/${name}</span>
                <span class="sk-card-badges">
                    ${pluginBadge}${readonlyBadge}${forksBadge}${shadowed}
                </span>
            </div>
            <p class="sk-card-desc">${desc}</p>
            ${meta ? `<div class="sk-card-meta">${meta}</div>` : ''}
            <div class="sk-card-detail" data-detail-for="${escapeHtml(s.id)}"></div>
        </div>
    `;
}

function renderEditor(skill, detail) {
    const sw = S.skills_widget;
    const readOnly = !skill.editable;
    const dirty = state.editorState?.dirty;
    return `
        <div class="sk-editor ${readOnly ? 'sk-editor--readonly' : ''}" data-id="${escapeHtml(skill.id)}">
            <div class="sk-editor-head">
                <span class="sk-editor-path" title="${escapeHtml(detail.path)}">${escapeHtml(detail.path)}</span>
                ${dirty ? `<span class="sk-editor-dirty">${sw.editor.dirty_indicator}</span>` : ''}
            </div>
            <textarea class="sk-editor-textarea" ${readOnly ? 'readonly' : ''} spellcheck="false">${escapeHtml(detail.raw)}</textarea>
            <div class="sk-editor-foot">
                <button class="sk-btn sk-btn--ghost sk-cancel-btn">${sw.actions.cancel}</button>
                <button class="sk-btn sk-btn--ghost sk-open-full-btn">${sw.actions.open_full_editor}</button>
                ${readOnly ? '' : `<button class="sk-btn sk-btn--primary sk-save-btn" ${dirty ? '' : 'disabled'}>${sw.actions.save}</button>`}
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
        // Restore caret after re-render
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
        openNewSkillModal();
    });
}

function rerenderBodyOnly() {
    const body = state.container?.querySelector('.sk-body');
    if (!body) return renderShell();
    const filtered = filteredSkills();
    body.className = `sk-body sk-body--${state.viewMode}`;
    body.innerHTML = renderBody(filtered);
    attachCardHandlers();

    // Update pill counts (they reflect totals, unaffected by search — keep as is)
    // but update "All" count to reflect current-project-only filter effect
    // Actually the pill counts show scope totals regardless of search; leave as-is.
    if (state.expandedId) mountEditor(state.expandedId);
}

function attachCardHandlers() {
    const root = state.container;
    if (!root) return;

    root.querySelectorAll('.sk-card').forEach(card => {
        card.addEventListener('click', async (e) => {
            // Ignore clicks inside the detail panel
            if (e.target.closest('.sk-card-detail')) return;
            const id = card.dataset.id;
            if (state.expandedId === id) {
                // collapse
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
            const skill = state.skills.find(s => s.id === id);
            if (skill) showCardContextMenu(e.clientX, e.clientY, skill);
        });
    });
}

async function mountEditor(id) {
    const [scope, ...rest] = id.split(':');
    const name = rest.join(':');
    const card = state.container?.querySelector(`.sk-card[data-id="${CSS.escape(id)}"]`);
    const detailEl = card?.querySelector('.sk-card-detail');
    if (!detailEl) return;

    // If editor already mounted, leave it alone
    if (detailEl.dataset.mounted === '1' && state.editorState) return;

    detailEl.innerHTML = `<div class="sk-editor-loading">Loading…</div>`;
    detailEl.dataset.mounted = '1';

    const skill = state.skills.find(s => s.id === id);
    if (!skill) return;

    let detail;
    try {
        const cwd = window.app?.activeSession?.cwd || '/';
        const r = await fetch(`${CONFIG.API_BASE}/api/skills/${encodeURIComponent(scope)}/${encodeURIComponent(name)}?cwd=${encodeURIComponent(cwd)}`);
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
    detailEl.innerHTML = renderEditor(skill, detail);
    bindEditorHandlers(detailEl, skill, detail);
}

function bindEditorHandlers(root, skill, detail) {
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
            // Toggle save button + dirty indicator without full rerender
            const editor = root.querySelector('.sk-editor');
            editor?.classList.toggle('sk-editor--dirty', nowDirty);
            if (saveBtn) saveBtn.disabled = !nowDirty;
            const existing = root.querySelector('.sk-editor-dirty');
            if (nowDirty && !existing) {
                root.querySelector('.sk-editor-head')
                    ?.insertAdjacentHTML('beforeend', `<span class="sk-editor-dirty">${S.skills_widget.editor.dirty_indicator}</span>`);
            } else if (!nowDirty && existing) {
                existing.remove();
            }
        }
    });

    cancelBtn?.addEventListener('click', async () => {
        if (state.editorState?.dirty && !(await appConfirm(S.skills_widget.editor.discard_confirm, { confirmLabel: 'Discard', danger: true }))) return;
        state.expandedId = null;
        state.editorState = null;
        rerenderBodyOnly();
    });

    openFullBtn?.addEventListener('click', () => {
        const WM = window.WidgetManager;
        if (WM && typeof WM.open === 'function') {
            WM.open('file-preview', { filePath: skill.path });
        }
    });

    saveBtn?.addEventListener('click', async () => {
        if (!state.editorState || state.editorState.saving) return;
        state.editorState.saving = true;
        saveBtn.disabled = true;
        saveBtn.textContent = '…';
        try {
            const cwd = window.app?.activeSession?.cwd || '/';
            const r = await fetch(`${CONFIG.API_BASE}/api/skills/${encodeURIComponent(skill.scope)}/${encodeURIComponent(skill.name)}?cwd=${encodeURIComponent(cwd)}`, {
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
            window.app?.showToast?.(S.skills_widget.toast.saved.replace('{name}', skill.name));
            await loadSkills();
        } catch (e) {
            alert(S.skills_widget.editor.save_failed.replace('{error}', e.message));
        } finally {
            if (state.editorState) state.editorState.saving = false;
            const b = state.container?.querySelector(`.sk-card[data-id="${CSS.escape(skill.id)}"] .sk-save-btn`);
            if (b) {
                b.textContent = S.skills_widget.actions.save;
                b.disabled = !state.editorState?.dirty;
            }
        }
    });
}

// ══════════════════════════════════════════════════════════════════
// CONTEXT MENU + v2 ACTIONS
// ══════════════════════════════════════════════════════════════════

function showCardContextMenu(x, y, skill) {
    const sw = S.skills_widget;
    const menu = window.app?.contextMenu;
    const items = [];

    const cwd = window.app?.activeSession?.cwd || '/';

    items.push({
        label: sw.actions.copy_invocation,
        action: () => {
            if (navigator.clipboard) navigator.clipboard.writeText(`/${skill.name}`);
            window.app?.showToast?.(sw.toast.copied_invocation.replace('{name}', skill.name));
        },
    });
    items.push({
        label: sw.actions.copy_path,
        action: () => {
            if (navigator.clipboard) navigator.clipboard.writeText(skill.path);
            window.app?.showToast?.(sw.toast.copied_path);
        },
    });

    items.push({ separator: true });

    const otherScope = skill.scope === 'project' ? 'personal' : 'project';
    items.push({
        label: sw.actions.duplicate_to_project,
        action: () => duplicateSkill(skill, 'project'),
    });
    items.push({
        label: sw.actions.duplicate_to_personal,
        action: () => duplicateSkill(skill, 'personal'),
    });
    if (skill.editable && skill.scope !== 'plugin') {
        items.push({
            label: sw.actions.duplicate_here.replace('{scope}', skill.scope),
            action: () => duplicateSkill(skill, skill.scope),
        });
    }

    if (skill.editable) {
        items.push({ separator: true });
        items.push({
            label: sw.actions.delete,
            action: () => deleteSkill(skill),
        });
    }

    // Used: otherScope avoids linter warning
    void otherScope;

    if (!menu || typeof menu.show !== 'function') return;
    menu.show(x, y, items);
}

async function duplicateSkill(skill, targetScope) {
    const sw = S.skills_widget;
    const cwd = window.app?.activeSession?.cwd || '/';
    try {
        const r = await fetch(
            `${CONFIG.API_BASE}/api/skills/${encodeURIComponent(skill.scope)}/${encodeURIComponent(skill.name)}/duplicate?cwd=${encodeURIComponent(cwd)}`,
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
        window.app?.showToast?.(sw.toast.duplicated.replace('{name}', result.name));
        state.expandedId = result.id;
        state.editorState = null;
        await loadSkills();
        // Auto-expand the new skill's editor
        await mountEditor(result.id);
        scrollCardIntoView(result.id);
    } catch (e) {
        alert(sw.toast.duplicate_failed.replace('{error}', e.message));
    }
}

async function deleteSkill(skill) {
    const sw = S.skills_widget;
    const cwd = window.app?.activeSession?.cwd || '/';
    const msg = sw.confirm.delete.replace('{name}', skill.name);
    if (!(await appConfirm(msg, { confirmLabel: 'Delete', danger: true }))) return;
    try {
        const r = await fetch(
            `${CONFIG.API_BASE}/api/skills/${encodeURIComponent(skill.scope)}/${encodeURIComponent(skill.name)}?cwd=${encodeURIComponent(cwd)}`,
            { method: 'DELETE' }
        );
        if (!r.ok) {
            const b = await r.json().catch(() => ({}));
            throw new Error(b.detail || `HTTP ${r.status}`);
        }
        window.app?.showToast?.(sw.toast.deleted.replace('{name}', skill.name));
        if (state.expandedId === skill.id) {
            state.expandedId = null;
            state.editorState = null;
        }
        await loadSkills();
    } catch (e) {
        alert(sw.toast.delete_failed.replace('{error}', e.message));
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
// NEW SKILL MODAL
// ══════════════════════════════════════════════════════════════════

const TEMPLATES = ['blank', 'task', 'reference', 'fork', 'visual'];

function openNewSkillModal() {
    const sw = S.skills_widget;
    const c = sw.create;

    // Remove any stale instance
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
                <button class="sk-btn sk-btn--ghost sk-modal-cancel">${sw.actions.cancel}</button>
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
            errEl.textContent = S.skills_widget.create.name_hint;
            nameInput?.focus();
            return;
        }
        await createSkill({ scope, name: nm, description: desc, template });
        closeModal();
    });
}

async function createSkill({ scope, name, description, template }) {
    const sw = S.skills_widget;
    const cwd = window.app?.activeSession?.cwd || '/';
    try {
        const r = await fetch(
            `${CONFIG.API_BASE}/api/skills/${encodeURIComponent(scope)}/${encodeURIComponent(name)}?cwd=${encodeURIComponent(cwd)}`,
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
        window.app?.showToast?.(sw.create.created.replace('{name}', result.name));
        // Clear any scope filter that would hide the new skill
        if (state.originFilter !== 'all' && state.originFilter !== scope) {
            state.originFilter = 'all';
        }
        // Make sure "this project" doesn't hide the new personal skill
        if (scope === 'personal' && state.currentProjectOnly) {
            state.currentProjectOnly = false;
            saveCurrentProjectOnly(false);
        }
        state.expandedId = result.id;
        state.editorState = null;
        await loadSkills();
        await mountEditor(result.id);
        scrollCardIntoView(result.id);
    } catch (e) {
        alert(sw.create.create_failed.replace('{error}', e.message));
    }
}

// ══════════════════════════════════════════════════════════════════
// REGISTRATION
// ══════════════════════════════════════════════════════════════════

export function registerSkillsWidget() {
    WidgetManager.register('skills', {
        title: S.widgets.titles.skills,
        icon: 'dollarSign',
        type: 'floating',
        scope: 'global',
        defaultWidth: 760,
        defaultHeight: 620,

        headerActions: [
            {
                icon: 'tool',
                title: S.skills_widget.manage_plugins_tooltip,
                onClick: () => WidgetManager.open('plugins'),
            },
            {
                icon: 'refresh',
                title: S.skills_widget.refresh_tooltip,
                onClick: () => loadSkills(),
            },
        ],

        render(container, ctx) {
            state.container = container;
            container.classList.add('skills-widget');
            if (ctx?.expandSkillId) {
                // Programmatic open from quick-switcher / app: clear filters
                // so the requested skill is visible regardless of current mode.
                state.search = '';
                state.originFilter = 'all';
                state.currentProjectOnly = false;
                state.expandedId = ctx.expandSkillId;
                state.editorState = null;
                state._scrollToExpanded = true;
            }
            loadSkills();
        },

        onOpen() {
            // Note: render() may set state.expandedId from context after this
            // runs (e.g. from the quick-switcher's "Open in Skills Manager"),
            // so don't unconditionally clear it here.
            loadSkills();
            requestAnimationFrame(() => {
                state.container?.querySelector('.sk-search')?.focus();
            });
        },

        onClose() {
            // Drop transient state so next open is clean
            state.expandedId = null;
            state.editorState = null;
        },
    });

    debug.log('[SkillsWidget] registered');
}

export const SkillsWidget = {
    open: () => WidgetManager.open('skills'),
    close: () => WidgetManager.close('skills'),
    toggle: () => WidgetManager.toggle('skills'),
    // Test hook — triggers a re-fetch of the skill list from the server
    reload: () => loadSkills(),
};

// Expose a global test hook so web-tests can force a refresh after backend
// changes without relying on a DOM selector for the refresh header button.
if (typeof window !== 'undefined') {
    window.__skillsWidgetReload = () => loadSkills();
}
