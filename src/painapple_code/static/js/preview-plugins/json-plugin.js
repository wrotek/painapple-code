/**
 * JSON preview plugin
 *
 * Handles: .json (except .vl.json, which is handled by chart-plugin earlier in the registry)
 * Renders a collapsible tree view with live search and expand/collapse-all controls.
 * Falls through to code/edit modes for raw editing.
 */

import { escapeHtml } from './plugin-helpers.js';
import { renderJsonTree, bindJsonTreeEvents } from '../preview/json-tree.js';
import S from '../strings.js';

const treeIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h4v4H3zM3 14h4v4H3zM11 6h10M11 10h7M11 14h10M11 18h7"/></svg>`;

export default {
    id: 'json',

    match(path) {
        if (!path) return false;
        const lower = path.toLowerCase();
        if (lower.endsWith('.vl.json')) return false;
        return lower.endsWith('.json');
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
        const searchVal = escapeHtml(ps.search || '');

        let body = '';
        try {
            const parsed = JSON.parse(state.content || 'null');
            body = renderJsonTree(parsed, { search: (ps.search || '').trim() });
        } catch (e) {
            body = `
                <div class="json-parse-error">
                    <strong>Invalid JSON:</strong> ${escapeHtml(e.message)}
                </div>
                <pre class="json-raw">${escapeHtml(state.content || '')}</pre>
            `;
        }

        const placeholder = S.preview?.json_search_placeholder || 'Search keys and values…';
        const expandTip = S.preview?.json_expand_all || 'Expand all';
        const collapseTip = S.preview?.json_collapse_all || 'Collapse all';

        return `
            <div class="preview-body json-preview-body">
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
                ${body}
            </div>
        `;
    },

    setupEvents(container, state, helpers) {
        if (state.viewMode !== 'tree') return;

        const ps = state.pluginState;
        const tree = container.querySelector('.json-tree');
        if (tree) bindJsonTreeEvents(tree);

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
                    container.querySelectorAll('.json-collapsible').forEach((el, i) => {
                        // Keep the outermost node expanded so the user sees something
                        if (i === 0) el.classList.add('expanded');
                        else el.classList.remove('expanded');
                    });
                } else if (act === 'clear-search') {
                    ps.search = '';
                    helpers.rerenderContent();
                }
            });
        });
    },
};
