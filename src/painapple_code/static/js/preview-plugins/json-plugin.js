/**
 * JSON preview plugin
 *
 * Handles: .json (except .vl.json, which is handled by chart-plugin earlier in the registry)
 * Renders a collapsible tree view with live search and expand/collapse-all controls.
 * Falls through to code/edit modes for raw editing.
 */

import { escapeHtml } from './plugin-helpers.js';
import { renderJsonTree, bindJsonTreeEvents } from '../preview/json-tree.js';
import {
    initJsonToolbarState, normalizeToolbarState, treeOptions,
    renderJsonToolbar, bindJsonToolbar,
} from '../preview/json-tree-toolbar.js';
import { bindJsonTreeContextMenu } from '../preview/json-tree-menu.js';
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
        return initJsonToolbarState();
    },

    renderBody(state, helpers) {
        if (state.viewMode !== 'tree') return null;

        const ps = normalizeToolbarState(state.pluginState);

        let body = '';
        try {
            const parsed = JSON.parse(state.content || 'null');
            body = renderJsonTree(parsed, treeOptions(ps));
        } catch (e) {
            body = `
                <div class="json-parse-error">
                    <strong>Invalid JSON:</strong> ${escapeHtml(e.message)}
                </div>
                <pre class="json-raw">${escapeHtml(state.content || '')}</pre>
            `;
        }

        return `
            <div class="preview-body json-preview-body">
                ${renderJsonToolbar(ps)}
                ${body}
            </div>
        `;
    },

    setupEvents(container, state, helpers) {
        if (state.viewMode !== 'tree') return;

        const ps = normalizeToolbarState(state.pluginState);
        const toolbar = bindJsonToolbar(container, ps, helpers, '.json-tree');

        const tree = container.querySelector('.json-tree');
        if (tree) {
            bindJsonTreeEvents(tree, { onToggle: toolbar.onToggle });
            // Parsed lazily and cached per render — the menu only needs it when
            // it actually opens, and re-parsing a large document on every
            // right-click would be a visible stall.
            let doc;
            bindJsonTreeContextMenu(tree, {
                getRoot: () => {
                    if (doc === undefined) {
                        try { doc = JSON.parse(state.content || 'null'); } catch (e) { doc = null; }
                    }
                    return doc;
                },
                onSearch: toolbar.setQuery,
                onSetExpanded: toolbar.record,
                onAfterExpand: () => toolbar.refresh({ scroll: false }),
            });
        }

        toolbar.refresh({ scroll: false });
    },
};
