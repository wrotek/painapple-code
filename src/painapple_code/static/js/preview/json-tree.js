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
 */

import { escapeHtml } from '../utils.js';

export function getJsonType(value) {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    return typeof value;
}

/**
 * @param {*} value - Parsed JSON value
 * @param {object} [opts]
 * @param {string} [opts.search] - Case-insensitive search query
 * @param {boolean} [opts.expandAll] - Force all nodes expanded
 * @param {boolean} [opts.collapseRoot] - Don't auto-expand the root node (for JSONL-style multi-tree views)
 * @returns {string} HTML
 */
export function renderJsonTree(value, opts = {}) {
    const ctx = {
        search: (opts.search || '').toLowerCase(),
        expandAll: !!opts.expandAll,
        collapseRoot: !!opts.collapseRoot,
    };
    return `<div class="json-tree">${renderValue(value, '', true, ctx)}</div>`;
}

export function valueContainsMatch(value, search) {
    if (!search) return false;
    if (value === null) return false;
    if (typeof value === 'string') return value.toLowerCase().includes(search);
    if (typeof value === 'number' || typeof value === 'boolean') {
        return String(value).toLowerCase().includes(search);
    }
    if (Array.isArray(value)) {
        return value.some(v => valueContainsMatch(v, search));
    }
    if (typeof value === 'object') {
        return Object.keys(value).some(k =>
            k.toLowerCase().includes(search) || valueContainsMatch(value[k], search)
        );
    }
    return false;
}

function highlightText(text, search) {
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

function renderValue(value, key, isRoot, ctx) {
    const type = getJsonType(value);
    const keyHtml = key !== ''
        ? `<span class="json-key">"${highlightText(key, ctx.search)}"</span><span class="json-colon">: </span>`
        : '';

    switch (type) {
        case 'null':
            return `<div class="json-line">${keyHtml}<span class="json-null">null</span></div>`;
        case 'boolean':
            return `<div class="json-line">${keyHtml}<span class="json-boolean">${highlightText(String(value), ctx.search)}</span></div>`;
        case 'number':
            return `<div class="json-line">${keyHtml}<span class="json-number">${highlightText(String(value), ctx.search)}</span></div>`;
        case 'string':
            return renderString(value, keyHtml, ctx);
        case 'array':
            return renderArray(value, keyHtml, isRoot, ctx);
        case 'object':
            return renderObject(value, keyHtml, isRoot, ctx);
        default:
            return `<div class="json-line">${keyHtml}<span class="json-unknown">${escapeHtml(String(value))}</span></div>`;
    }
}

function renderString(value, keyHtml, ctx) {
    const maxLen = 200;
    const truncated = value.length > maxLen;
    const display = truncated ? value.slice(0, maxLen) + '...' : value;
    // Highlight first, then escape newlines — avoid mangling the <span> tag.
    // highlightText already escaped HTML, so only tab/newline to visible forms on the raw-display parts.
    // Simpler: do the tab/newline substitution on the plain text before highlighting.
    const display2 = display.replace(/\n/g, '\\n').replace(/\t/g, '\\t');
    const escaped = highlightText(display2, ctx.search);

    // Nested JSON detection
    if (value.startsWith('{') || value.startsWith('[')) {
        try {
            const nested = JSON.parse(value);
            return `
                <div class="json-nested-container">
                    ${keyHtml}<span class="json-string-preview">"${escaped}"</span>
                    <button class="json-parse-btn" data-tooltip="Parse nested JSON">{ }</button>
                    <div class="json-nested-content" hidden>
                        ${renderValue(nested, '', true, ctx)}
                    </div>
                </div>
            `;
        } catch (e) { /* not JSON */ }
    }

    return `<div class="json-line">${keyHtml}<span class="json-string">"${escaped}"</span>${truncated ? '<span class="json-truncated">[...]</span>' : ''}</div>`;
}

function renderArray(arr, keyHtml, isRoot, ctx) {
    const count = arr.length;
    if (count === 0) {
        return `<div class="json-line">${keyHtml}<span class="json-bracket">[]</span></div>`;
    }

    let children = '';
    for (const item of arr) {
        children += `<div class="json-array-item">${renderValue(item, '', false, ctx)}</div>`;
    }

    const hasMatch = ctx.search && valueContainsMatch(arr, ctx.search);
    const expanded = ctx.expandAll || (isRoot && !ctx.collapseRoot) || count <= 3 || hasMatch;

    return `
        <div class="json-collapsible ${expanded ? 'expanded' : ''}">
            <div class="json-line json-toggle">
                ${keyHtml}<span class="json-bracket">[</span><span class="json-summary">${count} item${count !== 1 ? 's' : ''}</span><span class="json-ellipsis">...</span><span class="json-bracket json-close-bracket">]</span>
            </div>
            <div class="json-children">
                ${children}
                <div class="json-line"><span class="json-bracket">]</span></div>
            </div>
        </div>
    `;
}

function renderObject(obj, keyHtml, isRoot, ctx) {
    const keys = Object.keys(obj);
    const count = keys.length;
    if (count === 0) {
        return `<div class="json-line">${keyHtml}<span class="json-bracket">{}</span></div>`;
    }

    let children = '';
    for (const k of keys) {
        children += renderValue(obj[k], k, false, ctx);
    }

    const previewKeys = keys.slice(0, 3).map(k => `"${escapeHtml(k)}"`).join(', ');
    const moreKeys = count > 3 ? `, +${count - 3} more` : '';
    const hasMatch = ctx.search && valueContainsMatch(obj, ctx.search);
    const expanded = ctx.expandAll || (isRoot && !ctx.collapseRoot) || count <= 3 || hasMatch;

    return `
        <div class="json-collapsible ${expanded ? 'expanded' : ''}">
            <div class="json-line json-toggle">
                ${keyHtml}<span class="json-bracket">{</span><span class="json-summary">${previewKeys}${moreKeys}</span><span class="json-ellipsis">...</span><span class="json-bracket json-close-bracket">}</span>
            </div>
            <div class="json-children">
                ${children}
                <div class="json-line"><span class="json-bracket">}</span></div>
            </div>
        </div>
    `;
}

/**
 * Attach click handlers for expand/collapse and nested-JSON parse button.
 * Safe to call per-rerender as long as `target` is a fresh element each time.
 */
export function bindJsonTreeEvents(target) {
    target.addEventListener('click', (e) => {
        const toggle = e.target.closest('.json-toggle');
        if (toggle && target.contains(toggle)) {
            e.stopPropagation();
            const collapsible = toggle.closest('.json-collapsible');
            if (collapsible) collapsible.classList.toggle('expanded');
            return;
        }
        const parseBtn = e.target.closest('.json-parse-btn');
        if (parseBtn && target.contains(parseBtn)) {
            e.stopPropagation();
            const container = parseBtn.closest('.json-nested-container');
            if (!container) return;
            const nested = container.querySelector('.json-nested-content');
            const preview = container.querySelector('.json-string-preview');
            if (nested) {
                const isHidden = nested.hidden;
                nested.hidden = !isHidden;
                parseBtn.classList.toggle('active', isHidden);
                if (preview) preview.hidden = isHidden;
            }
        }
    });
}
