/**
 * Prompt Explorer Widget - Redesigned for usability
 *
 * Design principles:
 * - Show more text by default (recognition is key)
 * - One-tap copy (most common action)
 * - Timeline grouping (Today, Yesterday, This Week, etc.)
 * - Expand to see full prompt
 * - Touch-friendly with large tap targets
 * - Clean, scannable layout
 */

import S from '../strings.js';
import { escapeHtml, $, formatTimeOrDate } from '../utils.js';
import { CONFIG, debug } from '../config.js';
import { WidgetManager, ICONS } from '../widget-system/index.js';
import * as PromptFavorites from '../prompt-favorites.js';
import { MarkdownRenderer } from '../components.js';
import { SHORTCUTS, resolveKeys, formatKeyForDisplay } from '../shortcuts.js';
import { getProjectColor } from '../project-colors.js';
import { showToast } from '../context-menu.js';

let mdRenderer = null;
function getMarkdown() {
    if (!mdRenderer) mdRenderer = new MarkdownRenderer();
    return mdRenderer;
}

// ═══════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════

class PromptExplorerState {
    constructor() {
        this.prompts = [];
        this.total = 0;
        this.loading = false;
        this.error = null;
        this.container = null;
        this.searchQuery = '';
        this.expandedId = null;  // Currently expanded prompt
        this.responseCache = new Map();  // prompt_id -> { state: 'loading'|'ready'|'error', text: string }
        this._searchDebounce = null;
        // Query parsing info from API
        this.queryInfo = null;  // { filters: [], highlight_terms: [] }
        this.showHints = false; // Toggle search syntax hints
        this.currentProjectOnly = localStorage.getItem('pe-current-project-only') !== 'false'; // default true
        // View switcher: 'history' (sent prompts) | 'drafts' (saved for later)
        this.view = 'history';
        this.drafts = [];
        this.draftsLoading = false;
        this.draftsError = null;
        this.armedDeleteId = null;  // Two-click delete confirmation (no window.confirm on iPad)
        this.armedClearAll = false; // Two-click confirm for "Clear All" drafts
    }
}

const state = new PromptExplorerState();

// ═══════════════════════════════════════════════════════════════════════
// SEARCH SYNTAX HINTS
// ═══════════════════════════════════════════════════════════════════════

const SEARCH_SYNTAX = [
    { syntax: '"exact phrase"', desc: 'Exact match' },
    { syntax: '-exclude', desc: 'Exclude term' },
    { syntax: 'word1 OR word2', desc: 'Either term' },
    { syntax: 'in:response', desc: 'Search Claude\'s responses' },
    { syntax: 'fav:', desc: 'Favorited prompts only' },
    { syntax: 'long:', desc: 'Long prompts (>500 chars)' },
    { syntax: 'short:', desc: 'Short prompts (<100 chars)' },
    { syntax: 'has:image', desc: 'Prompts with images' },
    { syntax: 'has:stash', desc: 'Prompts with stash context' },
    { syntax: 'today:', desc: 'Today only' },
    { syntax: 'week:', desc: 'Last 7 days' },
    { syntax: 'after:2026-01-15', desc: 'After date' },
    { syntax: 'project:name', desc: 'Filter by project' },
];

const _pf = S.widgets.prompt_explorer.quick_filters;
const QUICK_FILTERS = [
    { label: _pf.favorites, query: 'fav:' },
    { label: _pf.today, query: 'today:' },
    { label: _pf.this_week, query: 'week:' },
    { label: _pf.long, query: 'long:' },
    { label: _pf.with_images, query: 'has:image' },
    { label: _pf.with_stash, query: 'has:stash' },
];

// ═══════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════

/**
 * Group prompts by time period
 */
function groupByTimePeriod(prompts) {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today.getTime() - 86400000);
    const thisWeek = new Date(today.getTime() - 7 * 86400000);
    const thisMonth = new Date(today.getTime() - 30 * 86400000);

    const _tp = S.time_periods;
    const groups = {
        [_tp.today]: [],
        [_tp.yesterday]: [],
        [_tp.this_week]: [],
        [_tp.this_month]: [],
        [_tp.older]: []
    };

    for (const prompt of prompts) {
        const date = new Date(prompt.timestamp);
        if (date >= today) {
            groups[_tp.today].push(prompt);
        } else if (date >= yesterday) {
            groups[_tp.yesterday].push(prompt);
        } else if (date >= thisWeek) {
            groups[_tp.this_week].push(prompt);
        } else if (date >= thisMonth) {
            groups[_tp.this_month].push(prompt);
        } else {
            groups[_tp.older].push(prompt);
        }
    }

    return groups;
}

/**
 * Get short project name
 */
function getProjectName(path) {
    if (!path) return '';
    const parts = path.split('/');
    return parts[parts.length - 1] || parts[parts.length - 2] || '';
}

/**
 * Highlight search matches - supports multiple terms from parsed query
 */
function highlightMatches(text, query) {
    if (!text) return escapeHtml(text);

    // Get highlight terms from query info if available
    let terms = [];
    if (state.queryInfo?.highlight_terms?.length) {
        terms = state.queryInfo.highlight_terms;
    } else if (query) {
        // Fallback to simple query split
        terms = query.split(/\s+/).filter(t => t && !t.startsWith('-') && t !== 'OR');
    }

    if (terms.length === 0) return escapeHtml(text);

    const escaped = escapeHtml(text);
    try {
        // Build pattern for all terms
        const patterns = terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        const pattern = new RegExp(`(${patterns.join('|')})`, 'gi');
        return escaped.replace(pattern, '<mark>$1</mark>');
    } catch {
        return escaped;
    }
}

// ═══════════════════════════════════════════════════════════════════════
// DATA LOADING
// ═══════════════════════════════════════════════════════════════════════

async function loadPrompts() {
    state.loading = true;
    state.error = null;
    renderContent();

    try {
        const params = new URLSearchParams({ limit: '100' });
        if (state.searchQuery) {
            params.set('q', state.searchQuery);
        }
        if (state.currentProjectOnly) {
            const cwd = window.app?.activeSession?.cwd;
            if (cwd) params.set('project', cwd);
        }

        const url = `${CONFIG.API_BASE}/api/prompts?${params}`;
        const response = await fetch(url);
        const data = await response.json();

        state.prompts = data.prompts || [];
        state.total = data.total || 0;
        state.queryInfo = data.query || null;  // Store parsed query info
        state.loading = false;
        renderContent();
    } catch (error) {
        console.error('Failed to load prompts:', error);
        state.loading = false;
        state.error = 'Failed to load prompts';
        state.queryInfo = null;
        renderContent();
    }
}

function debouncedSearch(query) {
    state.searchQuery = query;
    if (state._searchDebounce) clearTimeout(state._searchDebounce);
    // 400ms debounce - enough time to type several characters
    state._searchDebounce = setTimeout(() => loadPrompts(), 400);
}

async function loadDrafts() {
    state.draftsLoading = true;
    state.draftsError = null;
    renderContent();

    try {
        const response = await fetch(`${CONFIG.API_BASE}/api/drafts`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        state.drafts = data.drafts || [];
        state.draftsLoading = false;
        renderContent();
    } catch (error) {
        console.error('Failed to load drafts:', error);
        state.draftsLoading = false;
        state.draftsError = S.widgets.prompt_explorer.drafts.error;
        renderContent();
    }
}

// ═══════════════════════════════════════════════════════════════════════
// ACTIONS
// ═══════════════════════════════════════════════════════════════════════

async function copyPrompt(prompt, btn) {
    try {
        await navigator.clipboard.writeText(prompt.content);
        // Visual feedback
        const originalHTML = btn.innerHTML;
        btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg> Copied!`;
        btn.classList.add('copied');
        setTimeout(() => {
            btn.innerHTML = originalHTML;
            btn.classList.remove('copied');
        }, 1500);
    } catch (error) {
        console.error('Copy failed:', error);
    }
}

function insertPrompt(prompt) {
    const input = $('#message-input');
    if (input) {
        input.value = prompt.content;
        input.focus();
        input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    WidgetManager.close('prompt-explorer');
}

async function openSession(prompt) {
    const app = window.app;
    if (!app) return;

    WidgetManager.close('prompt-explorer');

    // Check if session is already open in a tab
    const existing = app.sessionManager?.sessions?.find(s => s.storeId === prompt.session_id);
    if (existing) {
        app.switchToSession(existing);
        // Scroll to the specific prompt after a brief delay for render
        setTimeout(() => {
            app.chatCtrl?.scrollToMessage(prompt.timestamp, prompt.id);
        }, 100);
        return;
    }

    // Load from server if not already open
    const loaded = await app.loadSessionFromServer(prompt.session_id);
    if (loaded) {
        // Scroll to the specific prompt after session loads
        setTimeout(() => {
            app.chatCtrl?.scrollToMessage(prompt.timestamp, prompt.id);
        }, 200);
    }
}

function runInNewSession(prompt) {
    const app = window.app;
    if (!app) return;

    WidgetManager.close('prompt-explorer');

    // Create a new session
    const session = app.createSession();
    if (!session) return;

    // Set CWD from original prompt's project
    const cwd = prompt.project_path;
    if (cwd) {
        session.cwd = cwd;
    }

    // cwd set → switch into chat view to populate the input
    app.tabCtrl?.switchToSession(session);
    app.els.messageInput.value = prompt.content;
    app.els.messageInput.focus();
    app.adjustTextareaHeight?.();
}

function switchView(view) {
    if (state.view === view) return;
    state.view = view;
    state.armedDeleteId = null;
    state.armedClearAll = false;

    // Search area only applies to history; tabs re-render for active state
    const searchArea = state.container?.querySelector('.pe-search-area');
    if (searchArea) searchArea.style.display = view === 'drafts' ? 'none' : '';
    state.container?.querySelectorAll('.pe-tab').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.view === view);
    });

    if (view === 'drafts') {
        loadDrafts();
    } else {
        renderContent();
    }
}

/**
 * Open the widget directly on the Drafts view (used by the input-area
 * drafts pill). Handles both cold-open and already-open-on-History.
 */
export function openPromptExplorerDrafts() {
    const wasDrafts = state.view === 'drafts';
    state.view = 'drafts';
    state.armedDeleteId = null;
    state.armedClearAll = false;
    WidgetManager.open('prompt-explorer');   // onOpen loads drafts for this view
    if (!wasDrafts && state.container) {
        // Widget may have been open on History — sync tabs + search area
        const searchArea = state.container.querySelector('.pe-search-area');
        if (searchArea) searchArea.style.display = 'none';
        state.container.querySelectorAll('.pe-tab').forEach(btn =>
            btn.classList.toggle('active', btn.dataset.view === 'drafts'));
        loadDrafts();
    }
}

/** Load a draft into the chat input — sending it consumes (deletes) it. */
function insertDraft(draft) {
    const handler = window.app?.inputHandler;
    if (!handler) return;
    handler.insertSavedDraft(draft);
    WidgetManager.close('prompt-explorer');
}

async function copyDraft(draft, btn) {
    try {
        await navigator.clipboard.writeText(draft.text);
        btn.classList.add('copied');
        setTimeout(() => btn.classList.remove('copied'), 1500);
    } catch (error) {
        console.error('Copy failed:', error);
    }
}

/** Two-click delete: first click arms the button, second commits. */
async function deleteDraft(draft) {
    if (state.armedDeleteId !== draft.id) {
        state.armedDeleteId = draft.id;
        renderContent();
        return;
    }
    state.armedDeleteId = null;
    state.armedClearAll = false;
    try {
        const res = await fetch(`${CONFIG.API_BASE}/api/drafts/${encodeURIComponent(draft.id)}`, {
            method: 'DELETE'
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        state.drafts = state.drafts.filter(d => d.id !== draft.id);
        // If this draft mirrored the live input (auto-sync link), unlink so
        // the next sync doesn't 404 — note the still-typed text re-banks as
        // a fresh draft on the next tick, by design
        const handler = window.app?.inputHandler;
        if (handler?.pendingDraftId === draft.id) handler.unlinkSavedDraft();
        window.dispatchEvent(new CustomEvent('drafts-changed'));
    } catch (error) {
        console.error('Failed to delete draft:', error);
    }
    renderContent();
}

/** Two-click Clear All: first click arms the button, second wipes every draft. */
async function clearAllDrafts() {
    if (!state.armedClearAll) {
        state.armedClearAll = true;
        renderContent();
        return;
    }
    state.armedClearAll = false;
    try {
        const res = await fetch(`${CONFIG.API_BASE}/api/drafts`, { method: 'DELETE' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        state.drafts = [];
        state.armedDeleteId = null;
        // Every draft is gone — unlink the live input's auto-sync draft (if any)
        // so the next sync doesn't 404 against a deleted ID
        const handler = window.app?.inputHandler;
        if (handler?.pendingDraftId) handler.unlinkSavedDraft();
        window.dispatchEvent(new CustomEvent('drafts-changed'));
        showToast(S.widgets.prompt_explorer.drafts.cleared);
    } catch (error) {
        console.error('Failed to clear drafts:', error);
        showToast(S.widgets.prompt_explorer.drafts.clear_failed);
    }
    renderContent();
}

function toggleExpand(promptId) {
    const wasExpanded = state.expandedId === promptId;
    state.expandedId = wasExpanded ? null : promptId;
    renderContent();
    if (!wasExpanded) {
        ensureResponseFetched(promptId);
    }
}

async function ensureResponseFetched(promptId) {
    const cached = state.responseCache.get(promptId);
    if (cached && cached.state !== 'error') return;

    state.responseCache.set(promptId, { state: 'loading', text: '' });
    try {
        const url = `${CONFIG.API_BASE}/api/prompts/response/${encodeURIComponent(promptId)}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        state.responseCache.set(promptId, { state: 'ready', text: data.response || '' });
    } catch (err) {
        console.error('Failed to load full response:', err);
        state.responseCache.set(promptId, { state: 'error', text: '' });
    }
    if (state.expandedId === promptId) renderContent();
}

// ═══════════════════════════════════════════════════════════════════════
// RENDERING
// ═══════════════════════════════════════════════════════════════════════

function renderViewTabs() {
    const _t = S.widgets.prompt_explorer.tabs;
    return `
        <div class="pe-tabs">
            <button class="pe-tab ${state.view === 'history' ? 'active' : ''}" data-view="history">${_t.history}</button>
            <button class="pe-tab ${state.view === 'drafts' ? 'active' : ''}" data-view="drafts">${_t.drafts}</button>
        </div>
    `;
}

function renderDraftCard(draft) {
    const _d = S.widgets.prompt_explorer.drafts;
    const projectName = getProjectName(draft.cwd);
    const projectColor = getProjectColor(draft.cwd);
    const time = formatTimeOrDate(draft.updatedAt || draft.createdAt);
    const preview = draft.text.length > 300 ? draft.text.substring(0, 300) + '...' : draft.text;
    const isArmed = state.armedDeleteId === draft.id;

    return `
        <div class="pe-card pe-draft-card" data-id="${escapeHtml(draft.id)}">
            <div class="pe-card-header">
                <span class="pe-draft-title">${escapeHtml(draft.title || _d.untitled || 'Draft')}</span>
                <span class="pe-card-time">${time}</span>
                ${projectName ? `
                    <span class="pe-card-project">
                        ${projectColor ? `<span class="project-color-dot" style="background: ${projectColor}"></span>` : ''}
                        ${escapeHtml(projectName)}
                    </span>
                ` : ''}
            </div>
            <div class="pe-card-content">${escapeHtml(preview)}</div>
            <div class="pe-card-actions">
                <button class="pe-btn pe-btn-insert" data-action="use-draft" data-tooltip="${escapeHtml(_d.use)}">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M12 5v14M5 12h14"/>
                    </svg>
                    ${_d.use}
                </button>
                <button class="pe-btn pe-btn-copy" data-action="copy-draft" data-tooltip="${escapeHtml(_d.copy)}">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <rect x="9" y="9" width="13" height="13" rx="2"/>
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                    </svg>
                    ${_d.copy}
                </button>
                <button class="pe-btn pe-btn-delete-draft ${isArmed ? 'armed' : ''}" data-action="delete-draft">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="3 6 5 6 21 6"/>
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                    </svg>
                    ${isArmed ? _d.delete_confirm : _d.delete}
                </button>
            </div>
        </div>
    `;
}

function renderDraftsList() {
    const _d = S.widgets.prompt_explorer.drafts;

    if (state.draftsLoading) {
        return `<div class="pe-loading">
            <div class="pe-spinner"></div>
            <span>${_d.loading}</span>
        </div>`;
    }

    if (state.draftsError) {
        return `<div class="pe-error">${escapeHtml(state.draftsError)}</div>`;
    }

    if (state.drafts.length === 0) {
        // Show the actual (possibly user-remapped) binding in the hint
        const sc = SHORTCUTS.find(s => s.id === 'savePromptDraft');
        const key = sc ? formatKeyForDisplay(resolveKeys(sc)[0] || 'Ctrl+Shift+S') : 'Ctrl+Shift+S';
        return `<div class="pe-empty">${escapeHtml(_d.empty).replace('{shortcut}', `<kbd>${escapeHtml(key)}</kbd>`)}</div>`;
    }

    const clearArmed = state.armedClearAll;
    const toolbar = `
        <div class="pe-drafts-toolbar">
            <button class="pe-clear-all-drafts ${clearArmed ? 'armed' : ''}" data-action="clear-all-drafts">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="3 6 5 6 21 6"/>
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                </svg>
                ${clearArmed ? _d.clear_all_confirm : _d.clear_all}
            </button>
        </div>`;

    return `${toolbar}<div class="pe-list">${state.drafts.map(d => renderDraftCard(d)).join('')}</div>`;
}

function renderSearchBar() {
    const hasFilters = state.queryInfo?.filters?.length > 0;

    return `
        <div class="pe-search-area">
            <div class="pe-search">
                <svg class="pe-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
                </svg>
                <input
                    type="text"
                    class="pe-search-input"
                    placeholder="Search prompts... (try: long: or -exclude)"
                    value="${escapeHtml(state.searchQuery)}"
                    autofocus
                />
                <label class="pe-project-filter">
                    <input type="checkbox"
                           class="pe-project-checkbox"
                           data-action="toggle-project-filter"
                           ${state.currentProjectOnly ? 'checked' : ''}>
                    <span>${S.widgets.prompt_explorer.current_project_only}</span>
                </label>
                <button class="pe-hints-toggle ${state.showHints ? 'active' : ''}" data-tooltip="Search syntax help">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/>
                        <line x1="12" y1="17" x2="12.01" y2="17"/>
                    </svg>
                </button>
                ${state.searchQuery ? `
                    <button class="pe-search-clear" data-tooltip="Clear">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <circle cx="12" cy="12" r="10"/><path d="m15 9-6 6M9 9l6 6"/>
                        </svg>
                    </button>
                ` : ''}
            </div>

            ${!state.searchQuery ? `
                <div class="pe-quick-filters">
                    ${QUICK_FILTERS.map(f => `
                        <button class="pe-quick-filter" data-query="${escapeHtml(f.query)}">${f.label}</button>
                    `).join('')}
                </div>
            ` : ''}

            ${hasFilters ? `
                <div class="pe-active-filters">
                    ${state.queryInfo.filters.map(f => `
                        <span class="pe-filter-chip" data-type="${f.type}">
                            ${escapeHtml(f.label)}
                            <button class="pe-filter-remove" data-filter="${escapeHtml(f.label)}" data-tooltip="Remove">&times;</button>
                        </span>
                    `).join('')}
                </div>
            ` : ''}

            ${state.showHints ? `
                <div class="pe-hints">
                    <div class="pe-hints-title">Search Syntax</div>
                    <div class="pe-hints-grid">
                        ${SEARCH_SYNTAX.map(h => `
                            <div class="pe-hint">
                                <code class="pe-hint-syntax">${escapeHtml(h.syntax)}</code>
                                <span class="pe-hint-desc">${h.desc}</span>
                            </div>
                        `).join('')}
                    </div>
                </div>
            ` : ''}
        </div>
    `;
}

function renderStashRefs(refs) {
    if (!refs || refs.length === 0) return '';
    const items = refs.map(ref => {
        const icon = ref.type === 'file'
            ? '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>'
            : '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
        const label = ref.type === 'file' && ref.filePath
            ? ref.filePath.split('/').pop()
            : (ref.selectedText || '').substring(0, 80);
        const note = ref.note ? `<span class="pe-stash-note">${escapeHtml(ref.note)}</span>` : '';
        return `<div class="pe-stash-item">${icon} <span class="pe-stash-text">${escapeHtml(label)}${label.length >= 80 ? '...' : ''}</span>${note}</div>`;
    }).join('');
    return `<div class="pe-stash-refs"><div class="pe-stash-label"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg> ${refs.length} stash ref${refs.length > 1 ? 's' : ''}</div>${items}</div>`;
}

function renderFullResponse(promptId) {
    const entry = state.responseCache.get(promptId);
    if (!entry || entry.state === 'loading') {
        return `<div class="pe-card-full-response loading">
            <div class="pe-spinner"></div>
            <span>Loading response…</span>
        </div>`;
    }
    if (entry.state === 'error') {
        return `<div class="pe-card-full-response error">Failed to load response.</div>`;
    }
    if (!entry.text) {
        return `<div class="pe-card-full-response empty">No response recorded.</div>`;
    }
    let rendered;
    try {
        rendered = getMarkdown().render(entry.text);
    } catch {
        rendered = `<pre>${escapeHtml(entry.text)}</pre>`;
    }
    return `<div class="pe-card-full-response">
        <div class="pe-full-response-label">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
            Response
        </div>
        <div class="pe-full-response-body markdown-content">${rendered}</div>
    </div>`;
}

function renderPromptCard(prompt) {
    const isExpanded = state.expandedId === prompt.id;
    const projectName = getProjectName(prompt.project_path);
    const sessionName = prompt.session_name || 'Unnamed';
    const time = formatTimeOrDate(prompt.timestamp);
    const isFavorite = prompt.is_favorite;

    // Show more text by default - 300 chars collapsed, full when expanded
    const displayText = isExpanded
        ? prompt.content
        : (prompt.content.length > 300 ? prompt.content.substring(0, 300) + '...' : prompt.content);

    const highlightedText = state.searchQuery
        ? highlightMatches(displayText, state.searchQuery)
        : escapeHtml(displayText);

    const needsExpand = prompt.content.length > 300 || !!prompt.response_preview;

    return `
        <div class="pe-card ${isExpanded ? 'expanded' : ''} ${isFavorite ? 'is-favorite' : ''}" data-id="${prompt.id}">
            <div class="pe-card-header">
                <button class="pe-btn-favorite ${isFavorite ? 'active' : ''}" data-action="favorite" data-tooltip="${isFavorite ? 'Remove from favorites' : 'Add to favorites'}">
                    <svg class="heart-outline" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
                    </svg>
                    <svg class="heart-filled" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                        <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
                    </svg>
                </button>
                <span class="pe-card-time">${time}</span>
                <span class="pe-card-project">${escapeHtml(projectName)}</span>
                <span class="pe-card-session" data-tooltip="${escapeHtml(sessionName)}">${escapeHtml(sessionName.length > 25 ? sessionName.substring(0, 25) + '...' : sessionName)}</span>
            </div>
            <div class="pe-card-content ${needsExpand && !isExpanded ? 'truncated' : ''}">${highlightedText}</div>
            ${prompt.stash_refs ? renderStashRefs(prompt.stash_refs) : ''}
            ${prompt.response_preview && !isExpanded ? `
                <div class="pe-card-response">
                    <span class="pe-response-arrow">→</span>
                    <span class="pe-response-text">${escapeHtml(prompt.response_preview.substring(0, 100))}${prompt.response_preview.length > 100 ? '...' : ''}</span>
                </div>
            ` : ''}
            ${isExpanded ? renderFullResponse(prompt.id) : ''}
            <div class="pe-card-actions">
                <button class="pe-btn pe-btn-copy" data-action="copy" data-tooltip="Copy to clipboard">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <rect x="9" y="9" width="13" height="13" rx="2"/>
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                    </svg>
                    Copy
                </button>
                <button class="pe-btn pe-btn-insert" data-action="insert" data-tooltip="Paste into current input">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M12 5v14M5 12h14"/>
                    </svg>
                    Use
                </button>
                <button class="pe-btn pe-btn-run-new" data-action="run-new" data-tooltip="Open in new session for editing">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>
                    </svg>
                    Open New
                </button>
                <button class="pe-btn pe-btn-session" data-action="session" data-tooltip="Open original session">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                        <polyline points="15 3 21 3 21 9"/>
                        <line x1="10" y1="14" x2="21" y2="3"/>
                    </svg>
                    Session
                </button>
                ${needsExpand ? `
                    <button class="pe-btn pe-btn-expand" data-action="expand">
                        ${isExpanded ? '▲ Less' : '▼ More'}
                    </button>
                ` : ''}
            </div>
        </div>
    `;
}

function renderGroupedPrompts() {
    if (state.loading) {
        return `<div class="pe-loading">
            <div class="pe-spinner"></div>
            <span>Loading prompts...</span>
        </div>`;
    }

    if (state.error) {
        return `<div class="pe-error">${escapeHtml(state.error)}</div>`;
    }

    if (state.prompts.length === 0) {
        return `<div class="pe-empty">
            ${state.searchQuery
                ? `No prompts matching "<strong>${escapeHtml(state.searchQuery)}</strong>"`
                : 'No prompts yet. Start chatting with Claude!'}
        </div>`;
    }

    // If searching, don't group - just show flat list
    if (state.searchQuery) {
        return `
            <div class="pe-results-header">
                Found ${state.total} prompt${state.total !== 1 ? 's' : ''}
            </div>
            <div class="pe-list">
                ${state.prompts.map(p => renderPromptCard(p)).join('')}
            </div>
        `;
    }

    // Group by time period
    const groups = groupByTimePeriod(state.prompts);
    let html = '';

    for (const [period, prompts] of Object.entries(groups)) {
        if (prompts.length === 0) continue;

        html += `
            <div class="pe-group">
                <div class="pe-group-header">
                    <span class="pe-group-title">${period}</span>
                    <span class="pe-group-count">${prompts.length}</span>
                </div>
                <div class="pe-list">
                    ${prompts.map(p => renderPromptCard(p)).join('')}
                </div>
            </div>
        `;
    }

    return html;
}

function renderContent() {
    if (!state.container) return;

    // Check if we already have the structure
    let contentEl = state.container.querySelector('.pe-content');

    if (!contentEl) {
        // First render - create full structure
        state.container.innerHTML = `
            ${renderViewTabs()}
            ${renderSearchBar()}
            <div class="pe-content">
                ${state.view === 'drafts' ? renderDraftsList() : renderGroupedPrompts()}
            </div>
        `;
        const searchArea = state.container.querySelector('.pe-search-area');
        if (searchArea && state.view === 'drafts') searchArea.style.display = 'none';
        attachTabListeners();
        attachSearchListeners();
    } else {
        // Subsequent renders - only update results, preserve search input
        contentEl.innerHTML = state.view === 'drafts' ? renderDraftsList() : renderGroupedPrompts();
    }

    if (state.view === 'drafts') {
        attachDraftListeners();
    } else {
        attachCardListeners();
    }
}

function attachTabListeners() {
    state.container?.querySelectorAll('.pe-tab').forEach(btn => {
        btn.addEventListener('click', () => switchView(btn.dataset.view));
    });
}

function attachDraftListeners() {
    if (!state.container) return;

    const clearAllBtn = state.container.querySelector('.pe-clear-all-drafts');
    if (clearAllBtn) {
        clearAllBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            clearAllDrafts();
        });
    }

    state.container.querySelectorAll('.pe-draft-card').forEach(card => {
        const draft = state.drafts.find(d => d.id === card.dataset.id);
        if (!draft) return;

        // Double-click to load into input (same convention as history cards)
        card.addEventListener('dblclick', (e) => {
            if (!e.target.closest('.pe-btn')) insertDraft(draft);
        });

        card.querySelectorAll('.pe-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                switch (btn.dataset.action) {
                    case 'use-draft': insertDraft(draft); break;
                    case 'copy-draft': copyDraft(draft, btn); break;
                    case 'delete-draft': deleteDraft(draft); break;
                }
            });
        });
    });
}

function attachSearchListeners() {
    if (!state.container) return;

    const searchInput = state.container.querySelector('.pe-search-input');
    if (searchInput) {
        searchInput.addEventListener('input', (e) => debouncedSearch(e.target.value));
        searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                if (state.searchQuery) {
                    state.searchQuery = '';
                    searchInput.value = '';
                    state.queryInfo = null;
                    loadPrompts();
                } else {
                    WidgetManager.close('prompt-explorer');
                }
            }
        });
        setTimeout(() => searchInput.focus(), 100);
    }

    // Clear button
    const clearBtn = state.container.querySelector('.pe-search-clear');
    clearBtn?.addEventListener('click', () => {
        state.searchQuery = '';
        state.queryInfo = null;
        if (searchInput) searchInput.value = '';
        loadPrompts();
    });

    // Hints toggle button
    state.container.querySelector('.pe-hints-toggle')?.addEventListener('click', () => {
        state.showHints = !state.showHints;
        // Re-render search area only
        const searchArea = state.container.querySelector('.pe-search-area');
        if (searchArea) {
            searchArea.outerHTML = renderSearchBar();
            attachSearchListeners();  // Re-attach after re-render
        }
    });

    // Project filter toggle
    state.container.querySelector('.pe-project-checkbox')?.addEventListener('change', (e) => {
        state.currentProjectOnly = e.target.checked;
        localStorage.setItem('pe-current-project-only', state.currentProjectOnly);
        loadPrompts();
    });

    // Quick filter buttons
    state.container.querySelectorAll('.pe-quick-filter').forEach(btn => {
        btn.addEventListener('click', () => {
            const query = btn.dataset.query;
            state.searchQuery = query;
            if (searchInput) searchInput.value = query;
            loadPrompts();
        });
    });

    // Filter chip removal
    state.container.querySelectorAll('.pe-filter-remove').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const filterLabel = btn.dataset.filter;
            // Remove this filter from the query
            removeFilterFromQuery(filterLabel);
        });
    });

    // Clicking a syntax hint inserts it into search
    state.container.querySelectorAll('.pe-hint-syntax').forEach(code => {
        code.addEventListener('click', () => {
            const syntax = code.textContent;
            // Append to current query
            const current = state.searchQuery ? state.searchQuery + ' ' : '';
            state.searchQuery = current + syntax;
            if (searchInput) {
                searchInput.value = state.searchQuery;
                searchInput.focus();
            }
            state.showHints = false;
            loadPrompts();
        });
    });
}

/**
 * Remove a specific filter from the query string
 */
function removeFilterFromQuery(filterLabel) {
    if (!state.searchQuery) return;

    let query = state.searchQuery;

    // Handle quoted phrases
    if (filterLabel.startsWith('"') && filterLabel.endsWith('"')) {
        query = query.replace(filterLabel, '');
    }
    // Handle exclusions
    else if (filterLabel.startsWith('-')) {
        query = query.replace(filterLabel, '');
    }
    // Handle field filters (project:, in:, after:, etc.)
    else if (filterLabel.includes(':')) {
        const pattern = new RegExp(filterLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*', 'gi');
        query = query.replace(pattern, '');
    }
    // Handle special keywords (long:, short:, today:, week:)
    else if (['long (>500 chars)', 'short (<100 chars)', 'today', 'yesterday', 'this week'].includes(filterLabel.toLowerCase())) {
        const keywordMap = {
            'long (>500 chars)': 'long:',
            'short (<100 chars)': 'short:',
            'today': 'today:',
            'yesterday': 'yesterday:',
            'this week': 'week:',
        };
        const keyword = keywordMap[filterLabel.toLowerCase()] || filterLabel;
        query = query.replace(new RegExp(keyword + '\\s*', 'gi'), '');
    }
    // Handle regular terms
    else {
        query = query.replace(new RegExp('\\b' + filterLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b\\s*', 'gi'), '');
    }

    // Clean up extra spaces
    query = query.replace(/\s+/g, ' ').trim();

    state.searchQuery = query;
    const searchInput = state.container?.querySelector('.pe-search-input');
    if (searchInput) searchInput.value = query;
    loadPrompts();
}

async function toggleFavorite(prompt, btn) {
    const card = btn.closest('.pe-card');
    const wasActive = btn.classList.contains('active');

    // Optimistic UI update
    btn.classList.toggle('active');
    card?.classList.toggle('is-favorite');

    // Call API
    const newState = await PromptFavorites.toggleFavorite(prompt.id, prompt.content);

    // Update local state
    prompt.is_favorite = newState;

    // Revert UI if API failed (state mismatch)
    if (newState === wasActive) {
        btn.classList.toggle('active');
        card?.classList.toggle('is-favorite');
    }
}

function attachCardListeners() {
    if (!state.container) return;

    // Card actions
    state.container.querySelectorAll('.pe-card').forEach(card => {
        const promptId = card.dataset.id;
        const prompt = state.prompts.find(p => p.id === promptId);
        if (!prompt) return;

        // Double-click to insert
        card.addEventListener('dblclick', (e) => {
            if (!e.target.closest('.pe-btn') && !e.target.closest('.pe-btn-favorite')) {
                insertPrompt(prompt);
            }
        });

        // Favorite button (header)
        const favBtn = card.querySelector('.pe-btn-favorite');
        if (favBtn) {
            favBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                toggleFavorite(prompt, favBtn);
            });
        }

        // Action buttons
        card.querySelectorAll('.pe-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const action = btn.dataset.action;
                switch (action) {
                    case 'copy': copyPrompt(prompt, btn); break;
                    case 'insert': insertPrompt(prompt); break;
                    case 'run-new': runInNewSession(prompt); break;
                    case 'session': openSession(prompt); break;
                    case 'expand': toggleExpand(promptId); break;
                }
            });
        });
    });
}

// ═══════════════════════════════════════════════════════════════════════
// WIDGET REGISTRATION
// ═══════════════════════════════════════════════════════════════════════

export function registerPromptExplorerWidget() {
    WidgetManager.register('prompt-explorer', {
        title: S.widgets.titles.prompt_history,
        icon: 'clock',
        type: 'floating',
        scope: 'global',
        defaultWidth: 650,
        defaultHeight: 550,

        headerActions: [
            {
                icon: 'refresh',
                title: S.widgets.header_actions.refresh,
                onClick: () => state.view === 'drafts' ? loadDrafts() : loadPrompts()
            }
        ],

        render(container, ctx) {
            state.container = container;
            container.classList.add('prompt-explorer-widget');
            if (state.view === 'drafts') loadDrafts(); else loadPrompts();
        },

        onOpen() {
            state.expandedId = null;
            state.armedDeleteId = null;
            state.armedClearAll = false;
            if (state.view === 'drafts') loadDrafts(); else loadPrompts();
            // Focus search input after render (history view only)
            requestAnimationFrame(() => {
                if (state.view !== 'drafts') {
                    state.container?.querySelector('.pe-search-input')?.focus();
                }
            });
        },

        onClose() {
            // Focus chat input when closing
            document.querySelector('#message-input')?.focus();
        }
    });

    debug.log('[PromptExplorer] Widget registered');
}

export const PromptExplorerWidget = {
    open: () => WidgetManager.open('prompt-explorer'),
    close: () => WidgetManager.close('prompt-explorer'),
    toggle: () => WidgetManager.toggle('prompt-explorer'),
};
