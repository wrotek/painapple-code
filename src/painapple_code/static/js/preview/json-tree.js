/**
 * JSON tree renderer — shared between log explorer and file preview.
 *
 * Pure render-as-HTML-string; click handling is done via delegated events
 * attached by the caller to the container (see bindJsonTreeEvents).
 *
 * Supports:
 * - Color-coded keys/values
 * - Collapsible objects/arrays (default: collapsed when count > 3, root always expanded)
 * - Nested JSON detection inside strings (with parse button)
 * - Search: highlights matching substrings and auto-expands ancestors
 *
 * Search invariant: **a node matches iff the text we actually paint contains
 * the query**. Matching used to run against the raw value while highlighting
 * ran against the display form (newlines rendered as `\n`, strings cut at 200
 * chars), so the two disagreed — a hit could expand a subtree and then show
 * nothing, and a hit on a literal `\n` highlighted without expanding. Every
 * value is normalized once here and both decisions read that same string.
 */

import { escapeHtml } from '../utils.js';

export function getJsonType(value) {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    return typeof value;
}

// Longest string rendered inline. Longer values are windowed — around the
// first match when searching, from the start otherwise.
const MAX_STRING_LEN = 200;
// Characters of lead-in kept before a match when the window has to slide.
const MATCH_CONTEXT = 60;

/**
 * Display form of a string value: control characters become their visible
 * escapes. Matching runs against this, not the raw value.
 */
function normalizeString(text) {
    return String(text)
        .replace(/\r\n?/g, '\\n')
        .replace(/\n/g, '\\n')
        .replace(/\t/g, '\\t');
}

/**
 * @param {*} value - Parsed JSON value
 * @param {object} [opts]
 * @param {string} [opts.search] - Case-insensitive search query
 * @param {boolean} [opts.expandAll] - Force all nodes expanded
 * @param {boolean} [opts.collapseAll] - Force all nodes collapsed (root excepted)
 * @param {boolean} [opts.collapseRoot] - Don't auto-expand the root node (for JSONL-style multi-tree views)
 * @param {Map<string, boolean>} [opts.overrides] - Per-path expand state from explicit user toggles
 * @param {string} [opts.path] - Root path prefix (namespaces overrides across JSONL rows)
 * @returns {string} HTML
 */
export function renderJsonTree(value, opts = {}) {
    const ctx = {
        search: (opts.search || '').toLowerCase(),
        expandAll: !!opts.expandAll,
        collapseAll: !!opts.collapseAll,
        collapseRoot: !!opts.collapseRoot,
        overrides: opts.overrides instanceof Map ? opts.overrides : new Map(),
    };
    const { html } = renderValue(value, '', true, ctx, opts.path || '$');
    return `<div class="json-tree">${html}</div>`;
}

/**
 * Does `value` (or any descendant, or any key along the way) contain `search`?
 * Only used by callers that filter whole rows before rendering (JSONL); the
 * renderer itself derives the same answer bottom-up as it builds the HTML,
 * which is why this is no longer called once per node (that was quadratic).
 */
export function valueContainsMatch(value, search) {
    if (!search) return false;
    return matchesValue(value, String(search).toLowerCase());
}

function matchesValue(value, search) {
    if (value === null) return 'null'.includes(search);
    if (typeof value === 'string') return normalizeString(value).toLowerCase().includes(search);
    if (typeof value === 'number' || typeof value === 'boolean') {
        return String(value).toLowerCase().includes(search);
    }
    if (Array.isArray(value)) {
        return value.some(v => matchesValue(v, search));
    }
    if (typeof value === 'object') {
        return Object.keys(value).some(k =>
            k.toLowerCase().includes(search) || matchesValue(value[k], search)
        );
    }
    return false;
}

export function highlightText(text, search) {
    if (!search) return escapeHtml(text);
    const lower = text.toLowerCase();
    let out = '';
    let pos = 0;
    while (pos <= text.length) {
        const idx = lower.indexOf(search, pos);
        if (idx < 0) {
            out += escapeHtml(text.slice(pos));
            break;
        }
        out += escapeHtml(text.slice(pos, idx));
        out += `<span class="json-match">${escapeHtml(text.slice(idx, idx + search.length))}</span>`;
        pos = idx + search.length;
    }
    return out;
}

// Every renderer below returns { html, matched } so the "does this subtree hold
// a match?" answer propagates up from the leaves in the same single pass that
// builds the markup.

function renderValue(value, key, isRoot, ctx, path) {
    const type = getJsonType(value);
    const keyMatched = !!(ctx.search && key !== '' && key.toLowerCase().includes(ctx.search));
    const keyHtml = key !== ''
        ? `<span class="json-key">"${highlightText(key, ctx.search)}"</span><span class="json-colon">: </span>`
        : '';

    switch (type) {
        case 'null':
            return renderLeaf(keyHtml, 'json-null', 'null', keyMatched, ctx, path);
        case 'boolean':
            return renderLeaf(keyHtml, 'json-boolean', String(value), keyMatched, ctx, path);
        case 'number':
            return renderLeaf(keyHtml, 'json-number', String(value), keyMatched, ctx, path);
        case 'string':
            return renderString(value, keyHtml, keyMatched, ctx, path);
        case 'array':
            return renderArray(value, keyHtml, keyMatched, isRoot, ctx, path);
        case 'object':
            return renderObject(value, keyHtml, keyMatched, isRoot, ctx, path);
        default:
            return {
                html: `<div class="json-line"${pathAttr(path)}>${keyHtml}<span class="json-unknown">${escapeHtml(String(value))}</span></div>`,
                matched: keyMatched,
            };
    }
}

/**
 * Every addressable node carries its path. Two consumers: the expand-state
 * overrides that survive a re-render, and the right-click menu, which resolves
 * the path back to the underlying value (see resolveJsonPath).
 */
function pathAttr(path) {
    return ` data-json-path="${escapeHtml(path)}"`;
}

function renderLeaf(keyHtml, cls, text, keyMatched, ctx, path) {
    // `null` is a searchable token like any other — it used to be the one
    // literal the renderer neither matched nor highlighted.
    const selfMatched = !!(ctx.search && text.toLowerCase().includes(ctx.search));
    return {
        html: `<div class="json-line"${pathAttr(path)}>${keyHtml}<span class="${cls}">${highlightText(text, ctx.search)}</span></div>`,
        matched: keyMatched || selfMatched,
    };
}

/**
 * Visible slice of a long string. When the first match sits past the
 * truncation point the window slides to cover it — otherwise the tree expanded
 * to reveal a "match" the user could never see.
 */
function windowString(norm, search, idx) {
    if (norm.length <= MAX_STRING_LEN) {
        return { html: highlightText(norm, search), truncated: false };
    }
    const start = idx > MAX_STRING_LEN - MATCH_CONTEXT ? Math.max(0, idx - MATCH_CONTEXT) : 0;
    const end = Math.min(norm.length, start + MAX_STRING_LEN);
    const lead = start > 0 ? '…' : '';
    return { html: `${lead}${highlightText(norm.slice(start, end), search)}`, truncated: true };
}

function renderString(value, keyHtml, keyMatched, ctx, path) {
    const norm = normalizeString(value);
    const idx = ctx.search ? norm.toLowerCase().indexOf(ctx.search) : -1;
    const selfMatched = idx >= 0;

    // Nested JSON detection — a string that is itself a JSON document.
    const trimmed = value.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
            const nested = JSON.parse(trimmed);
            const inner = renderValue(nested, '', true, ctx, `${path}~`);
            const nestedPath = `${path}!`;
            // Auto-open when the parsed tree holds a match: the block used to
            // stay `hidden`, so search reported hits nobody could see. An
            // explicit user toggle still wins.
            const open = ctx.overrides.has(nestedPath)
                ? ctx.overrides.get(nestedPath)
                : (!!ctx.search && inner.matched);
            const preview = windowString(norm, ctx.search, idx);
            return {
                html: `
                <div class="json-nested-container" data-json-path="${escapeHtml(nestedPath)}">
                    ${keyHtml}<span class="json-string-preview"${open ? ' hidden' : ''}>"${preview.html}"</span>
                    <button class="json-parse-btn${open ? ' active' : ''}" data-tooltip="Parse nested JSON">{ }</button>
                    <div class="json-nested-content"${open ? '' : ' hidden'}>
                        ${inner.html}
                    </div>
                </div>
            `,
                matched: keyMatched || selfMatched || inner.matched,
            };
        } catch (e) { /* not JSON */ }
    }

    const shown = windowString(norm, ctx.search, idx);
    return {
        html: `<div class="json-line"${pathAttr(path)}>${keyHtml}<span class="json-string">"${shown.html}"</span>${shown.truncated ? '<span class="json-truncated">[...]</span>' : ''}</div>`,
        matched: keyMatched || selfMatched,
    };
}

/**
 * Expand decision, in precedence order:
 *   1. a subtree holding a search hit reveals itself — that IS what search is
 *      for, and a hit inside a folded branch isn't counted or reachable
 *   2. an explicit user toggle for this exact node, which survives re-renders
 *      (search is a full re-render, so without this every keystroke threw the
 *      user's manual expansion away)
 *   3. expand-all / collapse-all
 *   4. the default heuristic (root open, ≤3 children open)
 *
 * Rule 1 outranking rule 2 means a matching branch you folded away comes back
 * on the next keystroke. That's the lesser evil: the alternative is a match
 * count that points at nodes you can't see.
 */
function resolveExpanded(ctx, path, isRoot, count, childMatched) {
    if (ctx.search && childMatched) return true;
    if (ctx.overrides.has(path)) return ctx.overrides.get(path);
    if (ctx.expandAll) return true;
    const rootExpanded = isRoot && !ctx.collapseRoot;
    if (ctx.collapseAll) return rootExpanded;
    return rootExpanded || count <= 3;
}

function collapsibleHtml({ path, expanded, keyHtml, open, close, summary, children }) {
    return `
        <div class="json-collapsible ${expanded ? 'expanded' : ''}" data-json-path="${escapeHtml(path)}">
            <div class="json-line json-toggle">
                ${keyHtml}<span class="json-bracket">${open}</span><span class="json-summary">${summary}</span><span class="json-ellipsis">...</span><span class="json-bracket json-close-bracket">${close}</span>
            </div>
            <div class="json-children">
                ${children}
                <div class="json-line"><span class="json-bracket">${close}</span></div>
            </div>
        </div>
    `;
}

function renderArray(arr, keyHtml, keyMatched, isRoot, ctx, path) {
    const count = arr.length;
    if (count === 0) {
        return {
            html: `<div class="json-line"${pathAttr(path)}>${keyHtml}<span class="json-bracket">[]</span></div>`,
            matched: keyMatched,
        };
    }

    let children = '';
    let childMatched = false;
    for (let i = 0; i < count; i++) {
        const child = renderValue(arr[i], '', false, ctx, `${path}/${i}`);
        childMatched = childMatched || child.matched;
        children += `<div class="json-array-item">${child.html}</div>`;
    }

    return {
        html: collapsibleHtml({
            path,
            expanded: resolveExpanded(ctx, path, isRoot, count, childMatched),
            keyHtml,
            open: '[',
            close: ']',
            summary: escapeHtml(`${count} item${count !== 1 ? 's' : ''}`),
            children,
        }),
        matched: keyMatched || childMatched,
    };
}

function renderObject(obj, keyHtml, keyMatched, isRoot, ctx, path) {
    const keys = Object.keys(obj);
    const count = keys.length;
    if (count === 0) {
        return {
            html: `<div class="json-line"${pathAttr(path)}>${keyHtml}<span class="json-bracket">{}</span></div>`,
            matched: keyMatched,
        };
    }

    let children = '';
    let childMatched = false;
    for (const k of keys) {
        const child = renderValue(obj[k], k, false, ctx, `${path}/${encodeSegment(k)}`);
        childMatched = childMatched || child.matched;
        children += child.html;
    }

    // The collapsed summary shows real content (the first keys), so it gets
    // highlighted too — a match there was previously invisible.
    const previewKeys = keys.slice(0, 3).map(k => `"${highlightText(k, ctx.search)}"`).join(', ');
    const moreKeys = count > 3 ? `, +${count - 3} more` : '';

    return {
        html: collapsibleHtml({
            path,
            expanded: resolveExpanded(ctx, path, isRoot, count, childMatched),
            keyHtml,
            open: '{',
            close: '}',
            summary: `${previewKeys}${escapeHtml(moreKeys)}`,
            children,
        }),
        matched: keyMatched || childMatched,
    };
}

// ─── Node paths ──────────────────────────────────────────────────────────
//
// A path is '/'-joined: a root prefix ('$', or 'L12' for a JSONL row) followed
// by one segment per step down. Object keys are percent-encoded — including
// '~' and '!', which encodeURIComponent leaves alone but which carry meaning
// here, so a key literally named 'a~' can't forge a nested-document path.
//   trailing '~' on a segment = "the value is a JSON string; step into it"
//   trailing '!' on a segment = the nested-JSON container element itself

function encodeSegment(key) {
    return encodeURIComponent(key).replace(/~/g, '%7E').replace(/!/g, '%21');
}

/**
 * Walk a rendered node's path back to the value it was rendered from.
 * @returns {{found: boolean, value?: *, key?: string|null}}
 */
export function resolveJsonPath(root, path) {
    if (!path) return { found: false };
    const parts = String(path).split('/');
    let cur = root;
    let key = null;

    for (let i = 0; i < parts.length; i++) {
        let seg = parts[i];
        let nesting = 0;
        while (seg.endsWith('~') || seg.endsWith('!')) {
            if (seg.endsWith('~')) nesting++;
            seg = seg.slice(0, -1);
        }
        if (i > 0) {
            if (cur === null || typeof cur !== 'object') return { found: false };
            const step = decodeURIComponent(seg);
            key = Array.isArray(cur) ? null : step;
            cur = Array.isArray(cur) ? cur[Number(step)] : cur[step];
            if (cur === undefined) return { found: false };
        }
        for (let n = 0; n < nesting; n++) {
            if (typeof cur !== 'string') return { found: false };
            try {
                cur = JSON.parse(cur.trim());
            } catch (e) {
                return { found: false };
            }
            key = null;
        }
    }
    return { found: true, value: cur, key };
}

/** Human-readable JSONPath for the same address — `$.users[0]["odd key"]`. */
export function formatJsonPath(path) {
    if (!path) return '';
    const parts = String(path).split('/');
    let out = '$';
    for (let i = 1; i < parts.length; i++) {
        let seg = parts[i];
        let nested = false;
        while (seg.endsWith('~') || seg.endsWith('!')) {
            if (seg.endsWith('~')) nested = true;
            seg = seg.slice(0, -1);
        }
        const step = decodeURIComponent(seg);
        if (/^\d+$/.test(step)) out += `[${step}]`;
        else if (/^[A-Za-z_$][\w$]*$/.test(step)) out += `.${step}`;
        else out += `[${JSON.stringify(step)}]`;
        if (nested) out += '|json';
    }
    return out;
}

/**
 * Search highlights that are actually on screen, in document order.
 *
 * A highlight inside a collapsed node or a closed nested-JSON block is in the
 * DOM but invisible; counting it would make "3 of 12" navigate to nothing.
 * The check walks ancestors rather than reading `offsetParent` so it also works
 * while the whole preview is in a background tab (and forces no layout).
 */
export function collectVisibleMatches(root) {
    if (!root) return [];
    return Array.from(root.querySelectorAll('.json-match')).filter(el => isMatchVisible(el, root));
}

function isMatchVisible(el, root) {
    for (let node = el.parentElement; node && node !== root; node = node.parentElement) {
        if (node.hidden) return false;
        if (node.classList.contains('json-children')
            && !node.parentElement?.classList.contains('expanded')) return false;
    }
    return true;
}

/**
 * Attach click handlers for expand/collapse and nested-JSON parse button.
 * Safe to call per-rerender as long as `target` is a fresh element each time.
 *
 * @param {Element} target
 * @param {object} [opts]
 * @param {(path: string, expanded: boolean) => void} [opts.onToggle] - Record the
 *   toggle so it survives the next re-render (search is a full re-render, and
 *   without this every keystroke threw away the user's manual expansion).
 */
export function bindJsonTreeEvents(target, opts = {}) {
    target.addEventListener('click', (e) => {
        const toggle = e.target.closest('.json-toggle');
        if (toggle && target.contains(toggle)) {
            e.stopPropagation();
            const collapsible = toggle.closest('.json-collapsible');
            if (collapsible) {
                const expanded = collapsible.classList.toggle('expanded');
                opts.onToggle?.(collapsible.dataset.jsonPath, expanded);
            }
            return;
        }
        const parseBtn = e.target.closest('.json-parse-btn');
        if (parseBtn && target.contains(parseBtn)) {
            e.stopPropagation();
            const container = parseBtn.closest('.json-nested-container');
            if (!container) return;
            const nested = container.querySelector('.json-nested-content');
            const preview = container.querySelector('.json-string-preview');
            if (!nested) return;
            const open = nested.hidden;
            nested.hidden = !open;
            parseBtn.classList.toggle('active', open);
            if (preview) preview.hidden = open;
            opts.onToggle?.(container.dataset.jsonPath, open);
        }
    });
}
