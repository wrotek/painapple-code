/**
 * SearchFilesWidget — project-wide content search ("Search in Files")
 *
 * VS Code-style search panel: one query input with inline Aa / whole-word / .*
 * toggle buttons, an optional filters row (include/exclude globs, ignored
 * files), and results grouped per file with highlighted match spans.
 * Click a match (or Enter) → file preview opened at that line.
 *
 * Backend: GET /api/search (routes/api_search.py) — ripgrep with a
 * pure-Python fallback; the response self-describes the engine so the UI
 * can show a degraded-mode notice.
 */

import S from '../strings.js';
import { escapeHtml } from '../utils.js';
import { CONFIG, debug } from '../config.js';
import { WidgetManager, ICONS } from '../widget-system/index.js';
import { basename, isAbsolutePath } from '../path-utils.js';

const MIN_QUERY = 2;
const DEBOUNCE_MS = 300;

// ============================================================================
// State (per-session, survives widget close/transform)
// ============================================================================

const states = new Map();

class SearchFilesState {
    constructor(sessionId) {
        this.sessionId = sessionId;
        this.cwd = null;
        this.query = '';
        this.caseSensitive = false;
        this.wholeWord = false;
        this.regex = false;
        this.includeGlob = '';
        this.excludeGlob = '';
        this.includeIgnored = false;
        this.showFilters = false;
        this.results = null;        // last successful /api/search response
        this.loading = false;
        this.error = null;          // e.g. invalid-regex message from server
        this.collapsed = new Set(); // collapsed file paths
        this.selected = -1;         // index into flatRows
        this.flatRows = [];         // [{path, line}] in display order
        this.container = null;
        this._debounce = null;
        this._abort = null;
        this._seq = 0;
    }
}

function getState(sessionId) {
    const sid = sessionId || window.app?.activeSession?.id || 'global';
    if (!states.has(sid)) states.set(sid, new SearchFilesState(sid));
    return states.get(sid);
}

// ============================================================================
// Search
// ============================================================================

function scheduleSearch(state) {
    if (state._debounce) clearTimeout(state._debounce);
    state._debounce = setTimeout(() => runSearch(state), DEBOUNCE_MS);
}

async function runSearch(state) {
    if (state._debounce) { clearTimeout(state._debounce); state._debounce = null; }
    const q = state.query;
    if (q.trim().length < MIN_QUERY) {
        state._abort?.abort();
        state.loading = false;
        state.results = null;
        state.error = null;
        renderBody(state);
        return;
    }

    const seq = ++state._seq;
    state._abort?.abort();
    const ctrl = new AbortController();
    state._abort = ctrl;
    state.loading = true;
    state.error = null;
    renderSummary(state); // keep previous results visible while searching

    const params = new URLSearchParams({ cwd: state.cwd || '', q });
    if (state.caseSensitive) params.set('case_sensitive', 'true');
    if (state.wholeWord) params.set('whole_word', 'true');
    if (state.regex) params.set('regex', 'true');
    if (state.includeGlob.trim()) params.set('include', state.includeGlob.trim());
    if (state.excludeGlob.trim()) params.set('exclude', state.excludeGlob.trim());
    if (state.includeIgnored) params.set('include_ignored', 'true');

    try {
        const resp = await fetch(`${CONFIG.API_BASE}/api/search?${params}`, { signal: ctrl.signal });
        if (seq !== state._seq) return;
        if (!resp.ok) {
            let detail = '';
            try { detail = (await resp.json()).detail || ''; } catch (e) { /* ignore */ }
            state.loading = false;
            state.results = null;
            state.error = detail || `HTTP ${resp.status}`;
            renderBody(state);
            return;
        }
        const data = await resp.json();
        if (seq !== state._seq) return;
        state.loading = false;
        state.results = data;
        state.collapsed = new Set();
        state.selected = -1;
        renderBody(state);
    } catch (err) {
        if (err.name === 'AbortError' || seq !== state._seq) return;
        debug.log('[SearchFiles] search failed:', err);
        state.loading = false;
        state.results = null;
        state.error = err.message;
        renderBody(state);
    }
}

// ============================================================================
// Rendering
// ============================================================================

const FILTER_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="4" y1="7" x2="20" y2="7"/><circle cx="9" cy="7" r="2.2" fill="var(--bg-primary)"/><line x1="4" y1="16" x2="20" y2="16"/><circle cx="15" cy="16" r="2.2" fill="var(--bg-primary)"/></svg>';
const CHEVRON_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg>';

function hasActiveFilters(state) {
    return !!(state.includeGlob.trim() || state.excludeGlob.trim() || state.includeIgnored);
}

function renderShell(state) {
    const c = state.container;
    if (!c) return;
    const _s = S.widgets.search_files;

    const toggles = [
        { key: 'caseSensitive', cls: 'sf-t-case', label: 'Aa', tip: _s.case_tooltip },
        { key: 'wholeWord', cls: 'sf-t-word', label: '<u>ab</u>', tip: _s.word_tooltip },
        { key: 'regex', cls: 'sf-t-regex', label: '.*', tip: _s.regex_tooltip },
    ];

    c.innerHTML = `
        <div class="sf-container">
            <div class="sf-search-area">
                <div class="sf-search-row">
                    <div class="sf-input-wrap">
                        <span class="sf-search-icon">${ICONS.search || ''}</span>
                        <input type="text" class="sf-input"
                               placeholder="${escapeHtml(_s.placeholder)}"
                               value="${escapeHtml(state.query)}"
                               spellcheck="false" autocomplete="off">
                        <button class="sf-clear ${state.query ? '' : 'sf-hidden'}" data-tooltip="${escapeHtml(_s.clear_tooltip)}">&times;</button>
                        <div class="sf-toggles">
                            ${toggles.map(t => `
                                <button class="sf-toggle ${t.cls} ${state[t.key] ? 'active' : ''}"
                                        data-toggle="${t.key}" data-tooltip="${escapeHtml(t.tip)}">${t.label}</button>
                            `).join('')}
                        </div>
                    </div>
                    <button class="sf-filters-btn ${state.showFilters ? 'active' : ''} ${hasActiveFilters(state) ? 'has-filters' : ''}"
                            data-tooltip="${escapeHtml(_s.filters_tooltip)}">${FILTER_ICON}</button>
                </div>
                <div class="sf-filters ${state.showFilters ? '' : 'sf-hidden'}">
                    <input type="text" class="sf-filter-input sf-include"
                           placeholder="${escapeHtml(_s.include_placeholder)}"
                           value="${escapeHtml(state.includeGlob)}" spellcheck="false" autocomplete="off">
                    <input type="text" class="sf-filter-input sf-exclude"
                           placeholder="${escapeHtml(_s.exclude_placeholder)}"
                           value="${escapeHtml(state.excludeGlob)}" spellcheck="false" autocomplete="off">
                    <button class="sf-pill sf-ignored ${state.includeIgnored ? 'active' : ''}"
                            data-tooltip="${escapeHtml(_s.ignored_tooltip)}">
                        <span class="sf-pill-dot"></span>${escapeHtml(_s.ignored_toggle)}
                    </button>
                </div>
                <div class="sf-summary"></div>
            </div>
            <div class="sf-body"></div>
        </div>
    `;

    wireEvents(state);
    renderBody(state);
}

function renderSummary(state) {
    const el = state.container?.querySelector('.sf-summary');
    if (!el) return;
    const _s = S.widgets.search_files;

    if (state.loading) {
        el.innerHTML = `<span class="sf-spinner"></span><span>${escapeHtml(_s.searching)}</span>`;
        el.classList.remove('sf-hidden');
        return;
    }
    const r = state.results;
    if (!r || state.error) {
        el.classList.add('sf-hidden');
        el.innerHTML = '';
        return;
    }
    let html = escapeHtml(
        _s.results_summary
            .replace('{matches}', r.total_matches)
            .replace('{files}', r.total_files)
    );
    if (r.truncated) {
        html += ` <span class="sf-truncated">· ${escapeHtml(_s.truncated_notice.replace('{n}', r.total_matches))}</span>`;
    }
    if (r.engine !== 'ripgrep') {
        html += ` <span class="sf-degraded" data-tooltip="${escapeHtml(_s.degraded_notice)}">⚠ ${escapeHtml(_s.degraded_short)}</span>`;
    }
    el.innerHTML = html;
    el.classList.remove('sf-hidden');
}

function renderBody(state) {
    const body = state.container?.querySelector('.sf-body');
    if (!body) return;
    const _s = S.widgets.search_files;
    renderSummary(state);
    state.flatRows = [];

    if (state.error) {
        body.innerHTML = `
            <div class="sf-message sf-error">
                <div class="sf-message-title">${escapeHtml(_s.error_title)}</div>
                <div class="sf-message-detail">${escapeHtml(state.error)}</div>
            </div>`;
        return;
    }

    const r = state.results;
    if (!r) {
        if (state.loading) {
            body.innerHTML = `<div class="sf-message">${escapeHtml(_s.searching)}</div>`;
        } else if (state.query.trim().length > 0 && state.query.trim().length < MIN_QUERY) {
            body.innerHTML = `<div class="sf-message">${escapeHtml(_s.min_chars.replace('{n}', MIN_QUERY))}</div>`;
        } else {
            body.innerHTML = `
                <div class="sf-message sf-idle">
                    <span class="sf-idle-icon">${ICONS.search || ''}</span>
                    <span>${escapeHtml(_s.idle_hint)}</span>
                </div>`;
        }
        return;
    }

    if (!r.files.length) {
        body.innerHTML = `<div class="sf-message">${escapeHtml(_s.no_results.replace('{query}', state.query))}</div>`;
        return;
    }

    let idx = 0;
    const groups = r.files.map(f => {
        const name = basename(f.path);
        const dir = f.path.slice(0, f.path.length - name.length).replace(/\/$/, '');
        const isCollapsed = state.collapsed.has(f.path);
        const rows = isCollapsed ? '' : f.matches.map(m => {
            const i = idx++;
            state.flatRows.push({ path: f.path, line: m.line });
            return `
                <div class="sf-match ${i === state.selected ? 'selected' : ''}" data-idx="${i}" data-path="${escapeHtml(f.path)}" data-line="${m.line}">
                    <span class="sf-line-no">${m.line}</span>
                    <span class="sf-line-text">${m.clipped_start ? '<span class="sf-ellipsis">…</span>' : ''}${highlightLine(m.text, m.spans)}${m.clipped_end ? '<span class="sf-ellipsis">…</span>' : ''}</span>
                </div>`;
        }).join('');
        // Collapsed groups keep their matches out of flatRows (keyboard nav skips them)
        return `
            <div class="sf-file ${isCollapsed ? 'collapsed' : ''}" data-file="${escapeHtml(f.path)}">
                <div class="sf-file-header" data-path="${escapeHtml(f.path)}">
                    <span class="sf-chevron">${CHEVRON_ICON}</span>
                    <span class="sf-file-name">${escapeHtml(name)}</span>
                    ${dir ? `<span class="sf-file-dir">${escapeHtml(dir)}</span>` : ''}
                    <span class="sf-file-count">${f.matches.length}</span>
                </div>
                <div class="sf-file-matches">${rows}</div>
            </div>`;
    }).join('');

    body.innerHTML = `<div class="sf-results">${groups}</div>`;
}

function highlightLine(text, spans) {
    if (!spans?.length) return escapeHtml(text);
    let html = '';
    let pos = 0;
    for (const [s, e] of spans) {
        if (s < pos || e > text.length) continue;
        if (s > pos) html += escapeHtml(text.slice(pos, s));
        html += `<mark class="sf-hl">${escapeHtml(text.slice(s, e))}</mark>`;
        pos = e;
    }
    return html + escapeHtml(text.slice(pos));
}

// ============================================================================
// Interaction
// ============================================================================

function wireEvents(state) {
    const c = state.container;
    const input = c.querySelector('.sf-input');

    input.addEventListener('input', () => {
        state.query = input.value;
        c.querySelector('.sf-clear')?.classList.toggle('sf-hidden', !state.query);
        scheduleSearch(state);
    });

    c.querySelector('.sf-clear')?.addEventListener('click', () => {
        state.query = '';
        input.value = '';
        c.querySelector('.sf-clear')?.classList.add('sf-hidden');
        runSearch(state);
        input.focus();
    });

    c.querySelectorAll('.sf-toggle').forEach(btn => {
        btn.addEventListener('click', () => {
            const key = btn.dataset.toggle;
            state[key] = !state[key];
            btn.classList.toggle('active', state[key]);
            input.focus();
            runSearch(state);
        });
    });

    c.querySelector('.sf-filters-btn')?.addEventListener('click', () => {
        state.showFilters = !state.showFilters;
        c.querySelector('.sf-filters')?.classList.toggle('sf-hidden', !state.showFilters);
        c.querySelector('.sf-filters-btn')?.classList.toggle('active', state.showFilters);
        if (state.showFilters) c.querySelector('.sf-include')?.focus();
        else input.focus();
    });

    c.querySelector('.sf-include')?.addEventListener('input', (e) => {
        state.includeGlob = e.target.value;
        updateFiltersBadge(state);
        scheduleSearch(state);
    });
    c.querySelector('.sf-exclude')?.addEventListener('input', (e) => {
        state.excludeGlob = e.target.value;
        updateFiltersBadge(state);
        scheduleSearch(state);
    });
    c.querySelector('.sf-ignored')?.addEventListener('click', (e) => {
        state.includeIgnored = !state.includeIgnored;
        e.currentTarget.classList.toggle('active', state.includeIgnored);
        updateFiltersBadge(state);
        runSearch(state);
    });

    // Result rows + file headers (delegated — body re-renders often)
    c.querySelector('.sf-body').addEventListener('click', (e) => {
        const header = e.target.closest('.sf-file-header');
        if (header) {
            const path = header.dataset.path;
            if (state.collapsed.has(path)) state.collapsed.delete(path);
            else state.collapsed.add(path);
            renderBody(state);
            return;
        }
        const row = e.target.closest('.sf-match');
        if (row) {
            state.selected = parseInt(row.dataset.idx, 10);
            updateSelection(state);
            openMatch(state, row.dataset.path, parseInt(row.dataset.line, 10));
        }
    });

    // Keyboard: arrows navigate matches, Enter opens, Escape clears then closes
    c.addEventListener('keydown', (e) => {
        if (e.target.classList?.contains('sf-filter-input')) {
            if (e.key === 'Enter') { e.preventDefault(); runSearch(state); }
            return;
        }
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            moveSelection(state, 1);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            moveSelection(state, -1);
        } else if (e.key === 'Enter') {
            const idx = state.selected >= 0 ? state.selected : 0;
            const row = state.flatRows[idx];
            if (row) {
                e.preventDefault();
                openMatch(state, row.path, row.line);
            }
        } else if (e.key === 'Escape' && state.query) {
            // First Esc clears the query; second (empty query) bubbles up and
            // closes the widget via the global handler.
            e.preventDefault();
            e.stopPropagation();
            state.query = '';
            input.value = '';
            c.querySelector('.sf-clear')?.classList.add('sf-hidden');
            runSearch(state);
            input.focus();
        }
    });
}

function updateFiltersBadge(state) {
    state.container?.querySelector('.sf-filters-btn')
        ?.classList.toggle('has-filters', hasActiveFilters(state));
}

function moveSelection(state, delta) {
    if (!state.flatRows.length) return;
    const next = state.selected < 0
        ? (delta > 0 ? 0 : state.flatRows.length - 1)
        : Math.max(0, Math.min(state.flatRows.length - 1, state.selected + delta));
    state.selected = next;
    updateSelection(state);
}

function updateSelection(state) {
    const body = state.container?.querySelector('.sf-body');
    if (!body) return;
    body.querySelectorAll('.sf-match.selected').forEach(el => el.classList.remove('selected'));
    const row = body.querySelector(`.sf-match[data-idx="${state.selected}"]`);
    if (row) {
        row.classList.add('selected');
        row.scrollIntoView({ block: 'nearest' });
    }
}

function openMatch(state, relPath, line) {
    const base = state.cwd || window.app?.activeSession?.cwd || '';
    const abs = isAbsolutePath(relPath)
        ? relPath
        : `${base.replace(/\/$/, '')}/${relPath}`;
    window.app?.previewFile(abs, { line });
}

function focusInput(state) {
    const attempt = () => {
        const input = state.container?.querySelector('.sf-input');
        if (!input) return;
        input.focus({ preventScroll: true });
        input.select();
    };
    attempt();
    // Re-assert shortly after: async renders elsewhere (e.g. the welcome
    // screen's folder input autofocus) can steal focus right after open.
    setTimeout(attempt, 250);
}

// ============================================================================
// Widget Registration
// ============================================================================

export function registerSearchFilesWidget() {
    WidgetManager.register('search-files', {
        type: 'top-sheet',
        title: S.widgets.titles.search_files,
        icon: 'search',
        shortcut: 'Ctrl+Shift+F',

        deviceTypes: {
            default: 'top-sheet',
            phone: 'top-sheet',
            tablet: 'top-sheet',
            desktop: 'floating'
        },

        heights: { half: '50vh', full: '85vh' },
        width: '560px',
        minWidth: '380px',
        maxWidth: '780px',

        sessionAware: true,
        persistState: true,
        allowTransform: true,
        allowedTypes: ['top-sheet', 'bottom-sheet', 'sidebar-left', 'sidebar-right', 'floating', 'tab'],

        render: (container, context) => {
            const state = getState(context.sessionId);
            state.container = container;
            container.tabIndex = -1;

            const cwd = context.cwd || window.app?.activeSession?.cwd || null;
            if (cwd && cwd !== state.cwd) {
                // Project changed under this session — stale results are misleading
                state.cwd = cwd;
                state.results = null;
                state.error = null;
                state.selected = -1;
            }

            renderShell(state);
            focusInput(state);
        },

        onOpen: () => {
            focusInput(getState());
        },

        onDestroy: (sessionId) => {
            const st = states.get(sessionId);
            if (st) {
                st._abort?.abort();
                if (st._debounce) clearTimeout(st._debounce);
                states.delete(sessionId);
            }
        }
    });
}

// Public API (open programmatically, optionally with a seeded query)
export const SearchFilesWidget = {
    open(query = null) {
        if (query != null) {
            const state = getState();
            state.query = query;
        }
        WidgetManager.open('search-files');
    },
    toggle() {
        WidgetManager.toggle('search-files');
    }
};
