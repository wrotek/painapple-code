/**
 * JSONL (JSON Lines) preview plugin
 *
 * Handles: .jsonl
 * Renders one collapsible tree per line, with line numbers, search,
 * and expand/collapse-all controls. Falls through to code/edit modes.
 */

import { escapeHtml } from './plugin-helpers.js';
import { renderJsonTree, bindJsonTreeEvents, valueContainsMatch } from '../preview/json-tree.js';
import S from '../strings.js';

const treeIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h4v4H3zM3 14h4v4H3zM11 6h10M11 10h7M11 14h10M11 18h7"/></svg>`;

const MAX_LINES = 5000;

export default {
    id: 'jsonl',

    match(path) {
        if (!path) return false;
        return path.toLowerCase().endsWith('.jsonl');
    },

    needsFetch: true,
    editable: true,

    viewModes: [{
        mode: 'tree',
        label: S.preview?.json_tree_label || 'Tree',
        icon: treeIcon,
    }],

    defaultViewMode: 'tree',

    initState() {
        return { search: '' };
    },

    renderBody(state, helpers) {
        if (state.viewMode !== 'tree') return null;

        const ps = state.pluginState;
        const search = (ps.search || '').trim();
        const searchLower = search.toLowerCase();
        const searchVal = escapeHtml(ps.search || '');

        const allLines = (state.content || '').split('\n');
        const truncated = allLines.length > MAX_LINES;
        const lines = truncated ? allLines.slice(0, MAX_LINES) : allLines;

        const parsed = [];
        lines.forEach((raw, idx) => {
            if (!raw.trim()) return;
            try {
                parsed.push({ lineNum: idx + 1, value: JSON.parse(raw), raw });
            } catch (e) {
                parsed.push({ lineNum: idx + 1, error: e.message, raw });
            }
        });

        const visible = search
            ? parsed.filter(p => p.error
                ? p.raw.toLowerCase().includes(searchLower)
                : valueContainsMatch(p.value, searchLower))
            : parsed;

        const rows = visible.map(p => {
            if (p.error) {
                return `
                    <div class="jsonl-row jsonl-row-error">
                        <div class="jsonl-row-num">${p.lineNum}</div>
                        <div class="jsonl-row-content">
                            <div class="json-parse-error"><strong>Invalid JSON:</strong> ${escapeHtml(p.error)}</div>
                            <pre class="json-raw">${escapeHtml(p.raw)}</pre>
                        </div>
                    </div>
                `;
            }
            return `
                <div class="jsonl-row">
                    <div class="jsonl-row-num">${p.lineNum}</div>
                    <div class="jsonl-row-content">${renderJsonTree(p.value, { search: searchLower, collapseRoot: true })}</div>
                </div>
            `;
        }).join('');

        const placeholder = S.preview?.json_search_placeholder || 'Search keys and values…';
        const expandTip = S.preview?.json_expand_all || 'Expand all';
        const collapseTip = S.preview?.json_collapse_all || 'Collapse all';

        const countLabel = search
            ? `${visible.length} / ${parsed.length} lines`
            : `${parsed.length} line${parsed.length !== 1 ? 's' : ''}`;
        const truncNote = truncated
            ? `<span class="jsonl-trunc-note">first ${MAX_LINES} lines shown (file has ${allLines.length})</span>`
            : '';

        const body = parsed.length === 0
            ? `<div class="jsonl-empty">No JSON lines found</div>`
            : visible.length === 0
                ? `<div class="jsonl-empty">No matches</div>`
                : `<div class="jsonl-rows">${rows}</div>`;

        return `
            <div class="preview-body jsonl-preview-body">
                <div class="json-toolbar">
                    <div class="json-search-wrap">
                        <svg class="json-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <circle cx="11" cy="11" r="8"/>
                            <line x1="21" y1="21" x2="16.65" y2="16.65"/>
                        </svg>
                        <input type="search" class="json-search-input" placeholder="${escapeHtml(placeholder)}" value="${searchVal}" autocomplete="off" spellcheck="false">
                        ${ps.search ? `<button class="json-search-clear" data-action="clear-search" data-tooltip="Clear">×</button>` : ''}
                    </div>
                    <button class="json-ctrl-btn" data-action="expand-all" data-tooltip="${escapeHtml(expandTip)}">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
                    </button>
                    <button class="json-ctrl-btn" data-action="collapse-all" data-tooltip="${escapeHtml(collapseTip)}">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="18 15 12 9 6 15"/></svg>
                    </button>
                </div>
                <div class="jsonl-status">${countLabel}${truncNote}</div>
                ${body}
            </div>
        `;
    },

    setupEvents(container, state, helpers) {
        if (state.viewMode !== 'tree') return;

        const ps = state.pluginState;
        const rows = container.querySelector('.jsonl-rows');
        if (rows) bindJsonTreeEvents(rows);

        const searchInput = container.querySelector('.json-search-input');
        if (searchInput) {
            let debounce;
            searchInput.addEventListener('input', () => {
                clearTimeout(debounce);
                debounce = setTimeout(() => {
                    ps.search = searchInput.value;
                    helpers.rerenderContent();
                    requestAnimationFrame(() => {
                        const next = container.querySelector('.json-search-input');
                        if (next) {
                            next.focus();
                            const len = next.value.length;
                            next.setSelectionRange(len, len);
                        }
                    });
                }, 120);
            });
        }

        container.querySelectorAll('.json-ctrl-btn, .json-search-clear').forEach(btn => {
            btn.addEventListener('click', () => {
                const act = btn.dataset.action;
                if (act === 'expand-all') {
                    container.querySelectorAll('.json-collapsible').forEach(el => el.classList.add('expanded'));
                } else if (act === 'collapse-all') {
                    container.querySelectorAll('.json-collapsible').forEach(el => el.classList.remove('expanded'));
                } else if (act === 'clear-search') {
                    ps.search = '';
                    helpers.rerenderContent();
                }
            });
        });
    },
};
