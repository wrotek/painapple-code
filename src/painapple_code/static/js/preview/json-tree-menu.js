/**
 * Right-click / long-press context menu for JSON tree nodes.
 *
 * The tree is rendered as an HTML string, so the menu can't hold a reference to
 * the value it was opened on — it resolves the clicked element's
 * `data-json-path` back through the parsed document (resolveJsonPath). That
 * keeps the renderer pure and means the same code serves the JSON preview, the
 * JSONL preview (one document per row) and any future caller.
 */

import { copyToClipboard, showToast } from '../context-menu.js';
import { resolveJsonPath, formatJsonPath } from './json-tree.js';
import S from '../strings.js';

const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP = 10;

/**
 * @param {Element} target - the tree root to delegate from ('.json-tree' / '.jsonl-rows')
 * @param {object} opts
 * @param {(path: string) => *} opts.getRoot - parsed document a path is rooted in
 * @param {(text: string) => void} [opts.onSearch] - fill the search box with this text
 * @param {(path: string, expanded: boolean) => void} [opts.onSetExpanded] - record one node's state
 * @param {() => void} [opts.onAfterExpand] - called once after a bulk expand/collapse
 */
export function bindJsonTreeContextMenu(target, opts = {}) {
    const open = (x, y, el) => {
        const node = el?.closest?.('[data-json-path]');
        if (!node || !target.contains(node)) return false;
        const items = buildItems(node, target, opts);
        if (!items.length) return false;
        const menu = window.app?.contextMenu;
        if (!menu) return false;
        menu.show(x, y, items);
        return true;
    };

    target.addEventListener('contextmenu', (e) => {
        // Let the browser's own menu handle a real text selection — that's the
        // one case where the native "Copy" is more useful than ours.
        if (!window.getSelection?.().isCollapsed) return;
        if (open(e.clientX, e.clientY, e.target)) {
            e.preventDefault();
            e.stopPropagation();
        }
    });

    // Touch long-press. iOS synthesizes a click after touchend, which would
    // toggle the node the menu just opened on, so it gets swallowed.
    let timer = null;
    let startX = 0;
    let startY = 0;
    let fired = false;

    const cancel = () => {
        clearTimeout(timer);
        timer = null;
    };

    target.addEventListener('touchstart', (e) => {
        if (e.touches.length !== 1) return cancel();
        const t = e.touches[0];
        startX = t.clientX;
        startY = t.clientY;
        fired = false;
        const el = e.target;
        timer = setTimeout(() => {
            timer = null;
            fired = open(startX, startY, el);
        }, LONG_PRESS_MS);
    }, { passive: true });

    target.addEventListener('touchmove', (e) => {
        const t = e.touches[0];
        if (!t) return;
        if (Math.abs(t.clientX - startX) > LONG_PRESS_SLOP
            || Math.abs(t.clientY - startY) > LONG_PRESS_SLOP) cancel();
    }, { passive: true });

    target.addEventListener('touchend', cancel, { passive: true });
    target.addEventListener('touchcancel', cancel, { passive: true });

    target.addEventListener('click', (e) => {
        if (!fired) return;
        fired = false;
        e.preventDefault();
        e.stopPropagation();
    }, { capture: true });
}

// ─── Menu contents ───────────────────────────────────────────────────────

function buildItems(node, target, opts) {
    const M = S.preview?.json_menu || {};
    const path = node.dataset.jsonPath;
    const root = opts.getRoot?.(path);
    const resolved = root === undefined ? { found: false } : resolveJsonPath(root, path);
    const items = [];

    if (resolved.found) {
        const { value, key } = resolved;
        const pretty = safeStringify(value);
        const isScalar = value === null || typeof value !== 'object';
        // For a string, "value" means the string itself — copying `"foo"` with
        // the quotes baked in is almost never what you wanted.
        const plain = typeof value === 'string' ? value
            : isScalar ? String(value)
                : pretty;

        items.push({
            label: M.copy_value || 'Copy value',
            icon: 'copy',
            action: () => copy(plain, M.copied_value || 'Value copied'),
        });
        if (pretty !== null && pretty !== plain) {
            items.push({
                label: M.copy_json || 'Copy as JSON',
                icon: 'code',
                action: () => copy(pretty, M.copied_json || 'JSON copied'),
            });
        }
        if (key) {
            items.push({
                label: M.copy_key || 'Copy key',
                action: () => copy(key, M.copied_key || 'Key copied'),
            });
            if (isScalar) {
                items.push({
                    label: M.copy_pair || 'Copy "key": value',
                    action: () => copy(`${JSON.stringify(key)}: ${safeStringify(value, 0)}`,
                        M.copied_pair || 'Entry copied'),
                });
            }
        }
        items.push({
            label: M.copy_path || 'Copy path',
            action: () => copy(formatJsonPath(path), M.copied_path || 'Path copied'),
        });

        if (isScalar && value !== null && opts.onSearch) {
            const term = String(value);
            if (term && term.length <= 200) {
                items.push({ type: 'separator' });
                items.push({
                    label: M.search_value || 'Search for this value',
                    icon: 'search',
                    action: () => opts.onSearch(term),
                });
            }
        }
    }

    // Subtree expand/collapse — only meaningful where there's something to fold.
    const subtree = node.classList.contains('json-collapsible')
        ? node
        : node.querySelector('.json-collapsible');
    if (subtree) {
        items.push({ type: 'separator' });
        items.push({
            label: M.expand_subtree || 'Expand subtree',
            icon: 'chevronDown',
            action: () => setSubtree(node, true, opts),
        });
        items.push({
            label: M.collapse_subtree || 'Collapse subtree',
            icon: 'chevronRight',
            action: () => setSubtree(node, false, opts),
        });
    }

    if (root !== undefined) {
        const whole = safeStringify(root);
        if (whole !== null) {
            items.push({ type: 'separator' });
            items.push({
                label: opts.rootLabel || M.copy_document || 'Copy whole document',
                icon: 'file',
                action: () => copy(whole, opts.rootToast || M.copied_document || 'Document copied'),
            });
        }
    }

    return items;
}

/**
 * Fold or unfold everything under `node` in one shot: the DOM classes AND the
 * override records, so the next re-render (any keystroke in the search box)
 * doesn't undo it.
 */
function setSubtree(node, expanded, opts) {
    const nodes = [];
    if (node.classList.contains('json-collapsible')) nodes.push(node);
    nodes.push(...node.querySelectorAll('.json-collapsible'));
    for (const el of nodes) {
        el.classList.toggle('expanded', expanded);
        opts.onSetExpanded?.(el.dataset.jsonPath, expanded);
    }
    for (const el of node.querySelectorAll('.json-nested-container')) {
        const nested = el.querySelector('.json-nested-content');
        const preview = el.querySelector('.json-string-preview');
        const btn = el.querySelector('.json-parse-btn');
        if (!nested) continue;
        nested.hidden = !expanded;
        if (preview) preview.hidden = expanded;
        btn?.classList.toggle('active', expanded);
        opts.onSetExpanded?.(el.dataset.jsonPath, expanded);
    }
    opts.onAfterExpand?.();
}

/** JSON.stringify that survives circular refs / BigInt rather than throwing mid-menu. */
function safeStringify(value, indent = 2) {
    try {
        const out = JSON.stringify(value, null, indent);
        return out === undefined ? null : out;
    } catch (e) {
        return null;
    }
}

function copy(text, toast) {
    copyToClipboard(text).then(ok => {
        showToast(ok ? toast : (S.preview?.json_menu?.copy_failed || 'Copy failed'));
    });
}
