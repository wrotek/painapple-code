/**
 * JSONL (JSON Lines) preview plugin
 *
 * Handles: .jsonl
 * Renders one collapsible tree per line, with line numbers, search,
 * and expand/collapse-all controls. Falls through to code/edit modes.
 */

import { escapeHtml } from './plugin-helpers.js';
import { renderJsonTree, bindJsonTreeEvents, valueContainsMatch } from '../preview/json-tree.js';
import {
    initJsonToolbarState, normalizeToolbarState, treeOptions,
    renderJsonToolbar, bindJsonToolbar,
} from '../preview/json-tree-toolbar.js';
import { bindJsonTreeContextMenu } from '../preview/json-tree-menu.js';
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
        return initJsonToolbarState();
    },

    renderBody(state, helpers) {
        if (state.viewMode !== 'tree') return null;

        const ps = normalizeToolbarState(state.pluginState);
        const search = (ps.search || '').trim();
        const searchLower = search.toLowerCase();

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
                    <div class="jsonl-row-content">${renderJsonTree(p.value, treeOptions(ps, {
                        collapseRoot: true,
                        // Namespace expand-state paths per source line — line
                        // numbers are stable across a re-filter, indexes aren't.
                        path: `L${p.lineNum}`,
                    }))}</div>
                </div>
            `;
        }).join('');

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
                ${renderJsonToolbar(ps)}
                <div class="jsonl-status">${countLabel}${truncNote}</div>
                ${body}
            </div>
        `;
    },

    setupEvents(container, state, helpers) {
        if (state.viewMode !== 'tree') return;

        const ps = normalizeToolbarState(state.pluginState);
        const toolbar = bindJsonToolbar(container, ps, helpers, '.jsonl-rows');

        const rows = container.querySelector('.jsonl-rows');
        if (rows) {
            bindJsonTreeEvents(rows, { onToggle: toolbar.onToggle });
            // Each row is its own document; the `L<n>` path prefix says which
            // source line to re-parse (split cached, parse on demand).
            let lines;
            bindJsonTreeContextMenu(rows, {
                rootLabel: S.preview?.json_menu?.copy_line || 'Copy whole line',
                rootToast: S.preview?.json_menu?.copied_line || 'Line copied',
                getRoot: (path) => {
                    const m = /^L(\d+)/.exec(path || '');
                    if (!m) return undefined;
                    if (!lines) lines = (state.content || '').split('\n');
                    try {
                        return JSON.parse(lines[Number(m[1]) - 1]);
                    } catch (e) {
                        return undefined;
                    }
                },
                onSearch: toolbar.setQuery,
                onSetExpanded: toolbar.record,
                onAfterExpand: () => toolbar.refresh({ scroll: false }),
            });
        }

        toolbar.refresh({ scroll: false });
    },
};
