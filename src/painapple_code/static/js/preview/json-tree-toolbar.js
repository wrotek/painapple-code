/**
 * Shared search / expand toolbar for the JSON and JSONL tree previews.
 *
 * Both plugins render the same control row and need the same behavior, so it
 * lives here instead of being copy-pasted twice with two sets of bugs.
 *
 * What it owns:
 * - the query, debounced into a re-render (the tree is a render-to-string
 *   module, so search *is* a re-render — see json-tree.js)
 * - match count + prev/next navigation. The tree search used to highlight and
 *   nothing else: no count, no way to jump, Enter did nothing, and Ctrl+F
 *   handed you an input with none of the affordances the generic preview
 *   search bar has.
 * - caret/focus survival across those re-renders
 * - expand-all / collapse-all and per-node toggles as *state*, so the next
 *   keystroke doesn't throw them away
 *
 * The count is read back out of the DOM rather than tallied during render:
 * whatever is highlighted and visible on screen is by definition what "N of M"
 * has to mean, and there's no second bookkeeping path to drift out of sync.
 */

import { escapeHtml } from '../utils.js';
import { collectVisibleMatches } from './json-tree.js';
import { fns } from './preview-state.js';
import S from '../strings.js';

const DEBOUNCE_MS = 120;

export function initJsonToolbarState() {
    return {
        search: '',
        // path → explicit expand state from a user toggle, so a re-render (i.e.
        // every keystroke in the search box) doesn't undo it. Only expand-all /
        // collapse-all resets the set.
        overrides: new Map(),
        // null | 'expand' | 'collapse' — sticky expand-all / collapse-all
        mode: null,
        matchIndex: 0,
    };
}

/** Tolerate a pluginState that was reset to a bare {} elsewhere. */
export function normalizeToolbarState(ps) {
    if (!ps) return initJsonToolbarState();
    if (typeof ps.search !== 'string') ps.search = '';
    if (!(ps.overrides instanceof Map)) ps.overrides = new Map();
    if (ps.mode !== 'expand' && ps.mode !== 'collapse') ps.mode = null;
    if (typeof ps.matchIndex !== 'number' || ps.matchIndex < 0) ps.matchIndex = 0;
    return ps;
}

/** Render options for the tree itself, derived from toolbar state. */
export function treeOptions(ps, extra = {}) {
    return {
        search: (ps.search || '').trim().toLowerCase(),
        expandAll: ps.mode === 'expand',
        collapseAll: ps.mode === 'collapse',
        overrides: ps.overrides,
        ...extra,
    };
}

export function renderJsonToolbar(ps) {
    const query = (ps.search || '').trim();
    const hide = query ? '' : ' hidden';
    const placeholder = S.preview?.json_search_placeholder || 'Search keys and values…';

    return `
        <div class="json-toolbar">
            <div class="json-search-wrap">
                <svg class="json-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="11" cy="11" r="8"/>
                    <line x1="21" y1="21" x2="16.65" y2="16.65"/>
                </svg>
                <input type="text" class="json-search-input" placeholder="${escapeHtml(placeholder)}" value="${escapeHtml(ps.search || '')}" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
                <span class="json-search-count"${hide}></span>
                <button class="json-search-nav" data-action="search-prev" data-tooltip="${escapeHtml(S.preview?.json_search_prev || 'Previous match (Shift+Enter)')}"${hide}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="18 15 12 9 6 15"/></svg>
                </button>
                <button class="json-search-nav" data-action="search-next" data-tooltip="${escapeHtml(S.preview?.json_search_next || 'Next match (Enter)')}"${hide}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
                </button>
                <button class="json-search-clear" data-action="clear-search" data-tooltip="${escapeHtml(S.preview?.json_search_clear || 'Clear (Escape)')}"${hide}>×</button>
            </div>
            <button class="json-ctrl-btn ${ps.mode === 'expand' ? 'active' : ''}" data-action="expand-all" data-tooltip="${escapeHtml(S.preview?.json_expand_all || 'Expand all')}">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
            </button>
            <button class="json-ctrl-btn ${ps.mode === 'collapse' ? 'active' : ''}" data-action="collapse-all" data-tooltip="${escapeHtml(S.preview?.json_collapse_all || 'Collapse all')}">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="18 15 12 9 6 15"/></svg>
            </button>
        </div>
    `;
}

/**
 * Wire the toolbar. Call once per render from the plugin's setupEvents.
 *
 * @param {Element} container - the preview widget container
 * @param {object} ps - plugin state (see initJsonToolbarState)
 * @param {object} helpers - plugin helpers ({ rerenderContent })
 * @param {string} treeSelector - root the matches live under ('.json-tree', '.jsonl-rows')
 */
export function bindJsonToolbar(container, ps, helpers, treeSelector) {
    normalizeToolbarState(ps);

    const refresh = (opts) => refreshMatches(container, ps, treeSelector, opts);
    const rerender = (scroll) => {
        const input = liveContainer(container).querySelector('.json-search-input');
        const focused = input && document.activeElement === input;
        const selStart = focused ? input.selectionStart : null;
        const selEnd = focused ? input.selectionEnd : null;
        helpers.rerenderContent();
        if (focused) restoreSearchFocus(container, ps, selStart, selEnd);
        refresh({ scroll });
    };

    const applyQuery = (value) => {
        if (value === ps.search) return false;
        ps.search = value;
        // New query, new match set — start navigation at the top. Manual
        // expand/collapse overrides are deliberately KEPT (they outlive a
        // re-render); auto-reveal outranks them anyway, see resolveExpanded.
        ps.matchIndex = 0;
        rerender(true);
        return true;
    };

    const searchInput = container.querySelector('.json-search-input');
    let debounce = null;
    const flush = () => {
        clearTimeout(debounce);
        debounce = null;
        const input = liveContainer(container).querySelector('.json-search-input');
        return input ? applyQuery(input.value) : false;
    };

    if (searchInput) {
        searchInput.addEventListener('input', () => {
            clearTimeout(debounce);
            debounce = setTimeout(flush, DEBOUNCE_MS);
        });

        searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                // Enter straight after typing must search what's in the box,
                // not what the debounce has committed so far.
                if (!flush()) navigate(container, ps, treeSelector, e.shiftKey ? -1 : 1);
            } else if (e.key === 'Escape') {
                // Don't let Escape bubble out and close the whole preview.
                e.preventDefault();
                e.stopPropagation();
                clearTimeout(debounce);
                if (searchInput.value) {
                    searchInput.value = '';
                    applyQuery('');
                } else {
                    searchInput.blur();
                }
            }
        });
    }

    container.querySelectorAll('.json-ctrl-btn, .json-search-nav, .json-search-clear').forEach(btn => {
        btn.addEventListener('click', () => {
            const act = btn.dataset.action;
            if (act === 'expand-all' || act === 'collapse-all') {
                // State, not a DOM sweep: the old version toggled classes
                // directly, so the very next re-render (a keystroke, a poll)
                // silently undid it.
                const next = act === 'expand-all' ? 'expand' : 'collapse';
                ps.mode = ps.mode === next ? null : next;
                ps.overrides = new Map();
                rerender(false);
            } else if (act === 'clear-search') {
                clearTimeout(debounce);
                applyQuery('');
            } else if (act === 'search-prev') {
                navigate(container, ps, treeSelector, -1);
            } else if (act === 'search-next') {
                navigate(container, ps, treeSelector, 1);
            }
        });
    });

    const record = (path, expanded) => {
        if (path) ps.overrides.set(path, expanded);
    };

    return {
        onToggle(path, expanded) {
            record(path, expanded);
            // Folding/unfolding changes which matches are on screen.
            refresh({ scroll: false });
        },
        // Batched variant for the context menu's expand/collapse-subtree, which
        // touches many nodes and wants a single recount at the end.
        record,
        refresh,
        /** Drive the search box from elsewhere (e.g. "Search for this value"). */
        setQuery(value) {
            clearTimeout(debounce);
            const input = liveContainer(container).querySelector('.json-search-input');
            if (input) input.value = value;
            if (!applyQuery(value)) refresh({ scroll: true });
            liveContainer(container).querySelector('.json-search-input')?.focus();
        },
    };
}

// ─── Internal helpers ────────────────────────────────────────────────────

/**
 * A re-render can swap the container node out from under us (the floating
 * widget path rebuilds it); fall back to the live instance lookup rather than
 * writing into a detached tree.
 */
function liveContainer(container) {
    if (container?.isConnected) return container;
    return fns.findPreviewContainer?.() || container;
}

function restoreSearchFocus(container, ps, selStart, selEnd) {
    const apply = (guard) => {
        const input = liveContainer(container).querySelector('.json-search-input');
        if (!input) return;
        // Never clobber a caret the user has moved on with since the re-render.
        if (guard && input.value !== ps.search) return;
        if (document.activeElement !== input) input.focus();
        const end = input.value.length;
        try {
            input.setSelectionRange(Math.min(selStart ?? end, end), Math.min(selEnd ?? end, end));
        } catch (e) { /* input type without selection support */ }
    };
    apply(false);
    requestAnimationFrame(() => apply(true));
}

function refreshMatches(container, ps, treeSelector, { scroll = false } = {}) {
    const root = liveContainer(container);
    const treeRoot = root.querySelector(treeSelector);
    const matches = collectVisibleMatches(treeRoot);
    const query = (ps.search || '').trim();

    ps.matchIndex = matches.length
        ? Math.min(Math.max(ps.matchIndex | 0, 0), matches.length - 1)
        : 0;

    root.querySelectorAll('.json-match.current').forEach(el => el.classList.remove('current'));
    const current = matches[ps.matchIndex];
    if (current) current.classList.add('current');

    const countEl = root.querySelector('.json-search-count');
    if (countEl) {
        countEl.hidden = !query;
        countEl.textContent = matches.length
            ? `${ps.matchIndex + 1} of ${matches.length}`
            : (query ? (S.preview?.json_search_no_results || 'No results') : '');
        countEl.classList.toggle('no-results', !!query && matches.length === 0);
    }
    root.querySelectorAll('.json-search-nav').forEach(btn => {
        btn.hidden = !query;
        btn.disabled = matches.length === 0;
    });
    const clearBtn = root.querySelector('.json-search-clear');
    if (clearBtn) clearBtn.hidden = !query;

    if (scroll && current) scrollMatchIntoView(root, current);
    return matches;
}

function navigate(container, ps, treeSelector, direction) {
    const matches = refreshMatches(container, ps, treeSelector);
    if (!matches.length) return;
    ps.matchIndex = (ps.matchIndex + direction + matches.length) % matches.length;
    refreshMatches(container, ps, treeSelector, { scroll: true });
}

/**
 * Manual scrollTop math rather than scrollIntoView: iOS WKWebView ignores
 * `block:'center'` on overflow:auto containers, which is the same reason
 * preview-search.js does it by hand.
 */
function scrollMatchIntoView(container, el) {
    const scroller = container.querySelector('.preview-body') || container;
    const containerRect = scroller.getBoundingClientRect();
    const matchRect = el.getBoundingClientRect();
    const offset = matchRect.top - containerRect.top + scroller.scrollTop;
    scroller.scrollTop = Math.max(0, offset - scroller.clientHeight / 2 + matchRect.height / 2);
}
