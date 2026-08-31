/**
 * UI Components: MarkdownRenderer and AutocompleteUI
 */

import { COMMANDS, getRecentShellCommands } from './config.js';
import { escapeHtml, escapeAttr, decodeHtml, sanitizeSvg } from './utils.js';
import { getCommandStore, CommandType } from './command-store.js';
import { anchorAbove } from './caret-position.js';
import S from './strings.js';
import {
    buildPathPattern,
    buildStandalonePattern,
    buildUrlPattern,
    cleanUrlTrailingPunct,
    isValidStandaloneFile,
    parseLineInfo
} from './linkify-utils.js';

// Helper to get app instance
const getApp = () => window.app;

/**
 * Markdown renderer using marked.js and highlight.js
 * (Both are loaded as external scripts in HTML)
 */
export class MarkdownRenderer {
    constructor() {
        this.setupMarked();
    }

    setupMarked() {
        const renderer = new marked.Renderer();

        // Custom code block rendering with syntax highlighting
        renderer.code = (code, language) => {
            // Excalidraw diagram rendering — placeholder for async SVG fetch
            if (language === 'excalidraw' || language === 'excalidraw-json') {
                try {
                    const parsed = JSON.parse(code);
                    if (parsed.type === 'excalidraw' || (parsed.elements && Array.isArray(parsed.elements))) {
                        const id = 'excalidraw-' + Math.random().toString(36).substr(2, 9);
                        // base64 the JSON into a data attribute (like vega-lite below) rather
                        // than an inline <script> — DOMPurify strips <script>, and a data attr
                        // also sidesteps the markdown linkifier corrupting URLs in the spec.
                        const encoded = btoa(unescape(encodeURIComponent(code)));
                        return `
                            <div class="excalidraw-inline" id="${id}" data-excalidraw-json="${encoded}">
                                <div class="excalidraw-inline-loading">
                                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <path d="M12 2L13.5 8.5L20 10L13.5 11.5L12 18L10.5 11.5L4 10L10.5 8.5L12 2Z"/>
                                    </svg>
                                    Rendering diagram...
                                </div>
                            </div>
                        `;
                    }
                } catch { /* not valid excalidraw JSON, fall through to normal code block */ }
            }

            // Vega-Lite chart rendering — placeholder for async SVG fetch
            // Uses base64 data attribute instead of <script> to prevent the markdown
            // linkifier from corrupting URLs in the JSON (e.g., $schema field).
            if (language === 'vega-lite' || language === 'vegalite') {
                try {
                    const parsed = JSON.parse(code);
                    if (parsed.$schema?.includes('vega-lite') || parsed.mark || parsed.layer || parsed.hconcat || parsed.vconcat) {
                        const id = 'chart-' + Math.random().toString(36).substr(2, 9);
                        const encoded = btoa(unescape(encodeURIComponent(code)));
                        return `
                            <div class="chart-inline" id="${id}" data-chart-json="${encoded}">
                                <div class="chart-inline-loading">
                                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <rect x="3" y="3" width="18" height="18" rx="2"/>
                                        <path d="M3 15l4-4 3 3 4-6 7 7"/>
                                    </svg>
                                    Rendering chart...
                                </div>
                            </div>
                        `;
                    }
                } catch { /* not valid Vega-Lite JSON, fall through to normal code block */ }
            }

            // Handle malformed code fences where language got concatenated with code
            // e.g., "pythonproc = await..." instead of "python" + "proc = await..."
            let lang = language || 'plaintext';
            let actualCode = code;

            // If language contains spaces, newlines, or is too long, it's likely malformed
            if (lang && (lang.includes(' ') || lang.includes('\n') || lang.length > 20)) {
                // Try to extract real language (first word) and prepend rest to code
                const match = lang.match(/^([a-z]+)(.*)$/is);
                if (match && match[1].length <= 15) {
                    const possibleLang = match[1].toLowerCase();
                    const rest = match[2];
                    // Check if it's a known language
                    if (hljs.getLanguage(possibleLang)) {
                        lang = possibleLang;
                        actualCode = rest + (rest && !rest.endsWith('\n') ? '\n' : '') + code;
                    } else {
                        lang = 'plaintext';
                    }
                } else {
                    lang = 'plaintext';
                }
            }

            // Fall back to plaintext for languages not in the hljs bundle
            if (lang !== 'plaintext' && !hljs.getLanguage(lang)) {
                lang = 'plaintext';
            }

            let highlighted;
            try {
                highlighted = hljs.highlight(actualCode, { language: lang, ignoreIllegals: true }).value;
            } catch {
                highlighted = hljs.highlightAuto(actualCode).value;
            }

            const id = 'code-' + Math.random().toString(36).substr(2, 9);
            const wrapped = MarkdownRenderer.getCodeWrapPref();
            return `
                <div class="code-block-wrapper${wrapped ? ' wrapped' : ''}">
                    <div class="code-block-header">
                        <span class="code-block-lang">${escapeHtml(lang)}</span>
                        <button class="code-block-wrap wrap-toggle${wrapped ? ' active' : ''}" data-tooltip="${S.code_block.toggle_wrap}" aria-pressed="${wrapped}">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <path d="M3 6h18"/><path d="M3 12h15a3 3 0 1 1 0 6h-4"/><polyline points="16 16 14 18 16 20"/><path d="M3 18h7"/>
                            </svg>
                        </button>
                        <button class="code-block-copy" data-code-id="${id}" data-tooltip="${S.code_block.copy_code}">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <rect x="9" y="9" width="13" height="13" rx="2"/>
                                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                            </svg>
                        </button>
                    </div>
                    <pre><code id="${id}" class="hljs language-${lang}">${highlighted}</code></pre>
                </div>
            `;
        };

        // Links open in new tab. Allow only safe protocols (defense-in-depth on
        // top of DOMPurify) — reject javascript:/data:/vbscript: hrefs outright.
        renderer.link = (href, title, text) => {
            const safe = this.constructor.sanitizeHref(href);
            // escapeAttr, not escapeHtml: both the href and the markdown link
            // title are author-controlled, and escapeHtml leaves quotes intact
            // — a title containing `"` could otherwise close the attribute and
            // inject new ones. DOMPurify runs after this and would strip an
            // injected handler, but that's the backstop, not the seatbelt.
            return `<a href="${escapeAttr(safe)}" target="_blank" rel="noopener noreferrer"${title ? ` data-tooltip="${escapeAttr(title)}"` : ''}>${text}</a>`;
        };

        // Wrap tables in scrollable container. The extra .table-block around the
        // scroller exists purely to anchor the layout switch: .table-wrapper is
        // the overflow-x container, so a button positioned inside it would scroll
        // away with the content and clip. Keep .table-wrapper's markup and CSS
        // untouched — it's measured directly by markdown_table_wrap_test.json.
        // Every table gets the switch. An earlier version gated it at 3+ columns
        // on the theory that narrow tables aren't awkward enough to need it, but
        // that made the control appear and disappear for no reason the reader can
        // see — and text mode is genuinely useful on a 2-column table, which is
        // exactly the label/value shape it renders.
        renderer.table = (header, body) =>
            `<div class="table-block"><div class="table-wrapper"><table><thead>${header}</thead><tbody>${body}</tbody></table></div>${MarkdownRenderer.layoutSwitchHtml()}</div>`;

        marked.setOptions({
            renderer,
            gfm: true,
            breaks: true,
            headerIds: false,
        });

        MarkdownRenderer._installDelegation();
    }

    /**
     * DOMPurify config for sanitizing rendered markdown. ALLOW_DATA_ATTR is true
     * by default, so every attribute the renderer emits (data-source-start/end,
     * data-selectable, data-chart-json, data-excalidraw-json, data-code-id,
     * data-line-opts, data-resolved, data-tooltip) survives. ADD_ATTR keeps
     * target=_blank on links.
     */
    static _PURIFY_CONFIG = { ADD_ATTR: ['target'] };

    /**
     * Sanitize rendered HTML before it reaches innerHTML. This is the single XSS
     * gate for all markdown output — marked v4 passes raw HTML through verbatim,
     * so without this a message body could inject same-origin script. Falls back
     * to the raw string only if DOMPurify failed to load (script-tag order bug),
     * which is logged loudly so it can't pass silently.
     */
    static sanitizeHtml(html) {
        if (typeof DOMPurify === 'undefined' || typeof DOMPurify.sanitize !== 'function') {
            // Fail CLOSED: never emit untrusted HTML. Degrade to escaped text
            // so the content is still readable but inert.
            console.error('DOMPurify not loaded — rendering as escaped text (fail-closed)');
            return escapeHtml(html);
        }
        return DOMPurify.sanitize(html, MarkdownRenderer._PURIFY_CONFIG);
    }

    /**
     * Scrub a markdown link href down to safe schemes. Defense-in-depth on top of
     * DOMPurify: control chars are stripped first (defeats `jav&#9;ascript:` style
     * bypasses) and any scheme outside the allowlist collapses to '#'.
     *
     * Returns a RAW, UNESCAPED url — scheme-checked, not attribute-safe. Every
     * caller must wrap it in escapeAttr() before interpolating into an
     * attribute; tests/test_no_unsafe_sinks.py enforces that at every href site.
     *
     * It used to return escapeHtml(cleaned), which read as safer and was
     * actually worse in both directions. escapeHtml doesn't escape quotes, so
     * the output was never attribute-safe on its own and callers still needed
     * escapeAttr — and layering escapeAttr on top double-escaped `&`, so
     * `?a=1&b=2` reached the DOM as `?a=1&amp;b=2` and the link resolved to the
     * wrong URL. One escape, applied by the caller that knows the context, is
     * the only arrangement that is both safe and correct.
     */
    static sanitizeHref(href) {
        if (!href) return '#';
        const cleaned = String(href).replace(/[\u0000-\u001F\u007F-\u009F]/g, '').trim();
        const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(cleaned);
        if (scheme && !['http', 'https', 'mailto', 'tel', 'ftp'].includes(scheme[1].toLowerCase())) {
            return '#';
        }
        return cleaned;
    }

    /**
     * Code-block line-wrap preference. Wrapping is ON by default; the user's last
     * choice is remembered in localStorage so it carries across renders and reloads.
     * Stored as '0' (off) / '1' (on) — a missing key reads as on.
     */
    static _WRAP_KEY = 'code-block-wrap';

    static getCodeWrapPref() {
        try {
            return localStorage.getItem(MarkdownRenderer._WRAP_KEY) !== '0';
        } catch {
            return true;
        }
    }

    /**
     * Flip the wrap preference, persist it, and apply it live to every wrappable
     * block currently in the DOM. One preference drives wrapping everywhere in
     * chat: markdown code blocks (`.code-block-wrapper`) and the monospace tool
     * previews that default to `white-space: pre` (Read / Write blocks). Every
     * toggle button carries the `.wrap-toggle` marker so its `.active` state and
     * aria-pressed stay in sync no matter which one was clicked.
     */
    static toggleCodeWrap() {
        MarkdownRenderer.setCodeWrap(!MarkdownRenderer.getCodeWrapPref());
    }

    /**
     * Set the wrap preference explicitly, persist it, and apply it live to every
     * wrappable block currently in the DOM. Used both by the per-block toggles
     * (via toggleCodeWrap) and by the Settings → Appearance switch, so the two
     * surfaces can never drift: there is one key and one apply path.
     */
    static setCodeWrap(enabled) {
        const next = !!enabled;
        try {
            localStorage.setItem(MarkdownRenderer._WRAP_KEY, next ? '1' : '0');
        } catch { /* private mode — preference just won't persist */ }
        document.querySelectorAll('.code-block-wrapper, .read-block, .write-block, .edit-diff').forEach((el) => {
            el.classList.toggle('wrapped', next);
        });
        document.querySelectorAll('.wrap-toggle').forEach((btn) => {
            btn.classList.toggle('active', next);
            btn.setAttribute('aria-pressed', String(next));
        });
        // Keep the Settings → Appearance switch honest if it happens to be open.
        const settingsToggle = document.getElementById('code-block-wrap');
        if (settingsToggle) settingsToggle.checked = next;
    }

    /**
     * The three table layouts, in the order they appear in the switch. `table`
     * is the plain grid and is the DEFAULT, represented by the absence of a
     * data-layout attribute (keeps the CSS to [data-layout="..."] selectors
     * only). `stacked` is the mysql-\G style label|value column pair, and
     * `text` drops all table chrome for a prose report ("**label:** value") —
     * the one you want when you'd rather read a table than cross-reference it.
     */
    static LAYOUTS = ['table', 'stacked', 'text'];

    /** One glyph per layout, drawn to read as what it produces. */
    static LAYOUT_ICONS = {
        // Grid: header row + first column divider.
        table: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M9 9v12"/></svg>`,
        // Stacked: short label paired with a long value, three times over.
        stacked: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h5"/><path d="M13 6h7"/><path d="M4 12h5"/><path d="M13 12h7"/><path d="M4 18h5"/><path d="M13 18h7"/></svg>`,
        // Text: ragged prose lines.
        text: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h16"/><path d="M4 10h11"/><path d="M4 15h16"/><path d="M4 20h8"/></svg>`,
    };

    static layoutLabel(layout) {
        return S.table?.[`layout_${layout}`] || `${layout} view`;
    }

    /**
     * The layout switch: one segmented control of three connected buttons, the
     * active segment highlighted. Deliberately NOT a single cycling button —
     * a cycler can only ever show one state, so it can't tell you which layouts
     * exist or which one you're in without being clicked to find out. Three
     * segments make the whole vocabulary and the current selection readable at
     * a glance, and let you jump straight to the layout you want.
     */
    static layoutSwitchHtml() {
        const opts = MarkdownRenderer.LAYOUTS.map(layout => {
            const label = MarkdownRenderer.layoutLabel(layout);
            const active = layout === 'table';
            return `<button class="table-layout-opt${active ? ' active' : ''}" data-layout-opt="${layout}" data-tooltip="${label}" aria-label="${label}" aria-pressed="${active}">${MarkdownRenderer.LAYOUT_ICONS[layout]}</button>`;
        }).join('');
        const groupLabel = S.table?.layout_switch_label || 'Table layout';
        return `<div class="table-layout-switch" role="group" aria-label="${groupLabel}">${opts}</div>`;
    }

    /**
     * Put ONE table into the layout its clicked segment names.
     *
     * Deliberately per-table and not persisted, unlike the global code-wrap
     * preference: reformatting a table is a "show me *this* row set differently"
     * gesture, and reformatting every table in a long transcript at once is
     * almost never what you want. State is a data-layout attribute on the
     * table's own .table-block, so nothing re-renders — same live-DOM approach
     * as toggleCodeWrap.
     */
    static setTableLayout(btn) {
        const block = btn.closest('.table-block');
        const layout = btn.dataset.layoutOpt;
        if (!block || !MarkdownRenderer.LAYOUTS.includes(layout)) return;
        if ((block.dataset.layout || 'table') === layout) return;

        MarkdownRenderer._prepareTableLayouts(block);
        if (layout === 'table') delete block.dataset.layout;
        else block.dataset.layout = layout;

        // Repaint the whole group, not just the clicked segment — exactly one
        // may be active.
        btn.parentElement?.querySelectorAll('.table-layout-opt').forEach(opt => {
            const on = opt.dataset.layoutOpt === layout;
            opt.classList.toggle('active', on);
            opt.setAttribute('aria-pressed', String(on));
        });
    }

    /**
     * One-time DOM prep shared by the stacked and text layouts, done on first
     * switch rather than at render time. Two reasons: tables that are never flipped pay nothing,
     * and there is exactly ONE place this can happen — a table feature split
     * across render() and renderWithSourceMap() silently diverged for months
     * once already (table rows had no stash bubbles at all in the previewer).
     *
     * Does two things per body cell:
     *
     *  1. Copies its column header onto it as data-label, which CSS prints via
     *     `content: attr(data-label)`. Generated content contributes nothing to
     *     textContent, and selection-handler reads element text raw (a row
     *     canonicalizes to cells.join(' | ')) — so selection, stash and copy
     *     produce identical text in both layouts. Same reasoning as the stash
     *     bubble's masked-svg glyph.
     *
     *  2. Wraps the cell's own content in a single .cell-value span. The
     *     stacked layout makes each cell a 2-column grid, and a grid container
     *     promotes EVERY child element plus every contiguous text run to its own
     *     grid item — so a cell like "Add `env=...` to the call" would explode
     *     into three items and spill the code span into the label gutter. One
     *     wrapper collapses it back to exactly [label, value]. The stash bubble
     *     is left outside the wrapper on purpose: it's position:absolute, so it
     *     is never a grid item, and moving it would break its cell anchoring.
     *
     * Scoped child selectors keep a nested table's rows from being labelled with
     * the outer table's headers.
     */
    static _prepareTableLayouts(block) {
        if (block.dataset.layoutReady) return;
        block.dataset.layoutReady = '1';

        block.querySelectorAll('table').forEach(table => {
            const headRow = table.querySelector(':scope > thead > tr');
            if (!headRow) return;
            const labels = [...headRow.cells].map(c => c.textContent.trim());
            // An all-blank header row carries nothing worth stacking.
            if (!labels.some(Boolean)) return;

            table.querySelectorAll(':scope > tbody > tr').forEach(tr => {
                [...tr.cells].forEach((td, i) => {
                    // Ragged rows (more cells than headers) get '' and render
                    // full-width — see the [data-label=""] rules in 30-markdown.css.
                    td.setAttribute('data-label', labels[i] ?? '');
                    if (td.querySelector(':scope > .cell-value')) return;
                    const span = document.createElement('span');
                    span.className = 'cell-value';
                    // Leave out-of-flow chrome where it is: the stash bubble is
                    // absolutely positioned against this cell, and the previewer's
                    // inline-edit trash button is its own control.
                    [...td.childNodes]
                        .filter(n => !(n.nodeType === 1 &&
                            (n.classList?.contains('stash-bubble') || n.tagName === 'BUTTON')))
                        .forEach(n => span.appendChild(n));
                    td.insertBefore(span, td.firstChild);
                });
            });
        });
    }

    /**
     * One document-level click delegate for the interactive chrome the renderer
     * emits — the code-block wrap toggle, copy button, and clickable file paths.
     * Inline onclick handlers were removed so DOMPurify can strip all event
     * attributes; the data they need already lives in data-* attributes.
     */
    static _installDelegation() {
        if (MarkdownRenderer._delegationInstalled) return;
        MarkdownRenderer._delegationInstalled = true;

        document.addEventListener('click', (event) => {
            const wrapBtn = event.target.closest?.('.wrap-toggle');
            if (wrapBtn) {
                MarkdownRenderer.toggleCodeWrap();
                return;
            }
            const layoutOpt = event.target.closest?.('.table-layout-opt');
            if (layoutOpt) {
                MarkdownRenderer.setTableLayout(layoutOpt);
                return;
            }
            const copyBtn = event.target.closest?.('.code-block-copy');
            if (copyBtn) {
                if (copyBtn.dataset.codeId) window.app?.copyCode(copyBtn.dataset.codeId);
                return;
            }
            const fileLink = event.target.closest?.('.file-path-link');
            if (fileLink) {
                // Links carrying data-act are owned by the action-delegate
                // (tool-renderer file links, which may call previewFile rather
                // than openFileLink). Only markdown-linkified paths — which
                // have no data-act — are handled here.
                if (fileLink.dataset.act) return;
                event.preventDefault();
                let opts = {};
                try {
                    opts = fileLink.dataset.lineOpts ? JSON.parse(fileLink.dataset.lineOpts) : {};
                } catch { /* malformed opts — open without line targeting */ }
                // data-resolved (verified path) preferred; data-file is the
                // fallback for tool-renderer links that carry only the raw
                // path. Those links used to have their own inline onclick and
                // double-fired this delegate; now this is their only handler.
                const target = fileLink.dataset.resolved || fileLink.dataset.file;
                if (target) {
                    window.app?.openFileLink(target, opts, event);
                }
            }
        });
    }

    render(text, verifiedFiles = null) {
        try {
            let html = marked.parse(text);
            // Post-process to make file paths clickable
            html = this.linkifyFilePaths(html, verifiedFiles);
            // Add selectable markers for tap-to-select on touch devices
            html = this.addSelectableMarkers(html);
            return MarkdownRenderer.sanitizeHtml(html);
        } catch (e) {
            console.error('Markdown error:', e);
            return escapeHtml(text);
        }
    }

    /**
     * Render markdown with source map annotations.
     * Each block-level element gets data-source-start and data-source-end
     * attributes indicating byte offsets into the original source string.
     * Used by the file preview inline editor to map clicks → source positions.
     *
     * baseOffset shifts all recorded offsets — pass it when `source` is a
     * substring of the real document (e.g. body after stripped front matter)
     * so offsets still index into the full original content.
     */
    renderWithSourceMap(source, baseOffset = 0) {
        try {
            const tokens = marked.lexer(source);
            const sourceMap = this._buildSourceMap(source, tokens);
            const tableRowMap = this._buildTableRowMap(source, tokens);
            if (baseOffset) {
                for (const entry of [...sourceMap, ...tableRowMap]) {
                    entry.start += baseOffset;
                    entry.end += baseOffset;
                }
            }
            let html = marked.parser(tokens);
            html = this.linkifyFilePaths(html, null);
            html = this._addSelectableMarkersWithSourceMap(html, sourceMap, tableRowMap);
            return MarkdownRenderer.sanitizeHtml(html);
        } catch (e) {
            console.error('Markdown renderWithSourceMap error:', e);
            return this.render(source);
        }
    }

    /**
     * Walk marked tokens and compute source byte offsets for each block element.
     * Returns flat array of {type, start, end} in document order.
     *
     * Key challenge: nested lists. marked v4 stores nested sub-lists inside
     * item.tokens, so we must recurse into each item's token stream.
     * We track offset per recursion level to avoid searchFrom drift.
     */
    _buildSourceMap(source, tokens) {
        const entries = [];

        // Walk top-level tokens — each token.raw is the exact source text for that block.
        // For lists, only map direct (top-level) items. Nested list items have
        // de-indented raw text that can't be reliably found via indexOf, so they
        // fall back to fuzzy matching in the inline editor.
        let searchFrom = 0;
        for (const token of tokens) {
            const type = token.type;
            if (!token.raw) continue;

            const idx = source.indexOf(token.raw, searchFrom);
            if (idx === -1) continue;
            const end = idx + token.raw.length;

            if (type === 'heading' || type === 'paragraph' || type === 'blockquote') {
                entries.push({ type, start: idx, end });
            } else if (type === 'list' && token.items) {
                // Only top-level items — their raw IS found verbatim in the source
                let cursor = idx;
                for (const item of token.items) {
                    if (!item.raw) continue;
                    const itemIdx = source.indexOf(item.raw, cursor);
                    if (itemIdx === -1) continue;
                    entries.push({ type: 'list_item', start: itemIdx, end: itemIdx + item.raw.length });
                    cursor = itemIdx + item.raw.length;
                }
            }
            searchFrom = end;
        }

        return entries;
    }

    /**
     * Like addSelectableMarkers but also injects data-source-start/end from sourceMap.
     * DOM elements and sourceMap entries are both in document order, so we zip them.
     *
     * Key subtlety: marked renders <blockquote><p>text</p></blockquote>, so
     * a TreeWalker sees both <blockquote> and inner <p>. But the source map
     * only has a 'blockquote' entry (not a nested 'paragraph'). We must skip
     * inner <p> elements within blockquotes to keep the zip aligned.
     */
    _addSelectableMarkersWithSourceMap(html, sourceMap, tableRowMap = null) {
        const template = document.createElement('template');
        template.innerHTML = html.trim();
        const doc = template.content;

        // Collect block elements in document order, filtering to only elements
        // that have source map entries:
        // - headings, paragraphs (not inside blockquotes), blockquotes
        // - top-level <li> only (not nested inside another <li>)
        const blockEls = [];
        const walker = document.createTreeWalker(doc, NodeFilter.SHOW_ELEMENT, {
            acceptNode(node) {
                const tag = node.tagName?.toLowerCase();
                if (tag === 'p' && node.closest('blockquote')) {
                    return NodeFilter.FILTER_SKIP;
                }
                if (tag === 'li' && node.parentElement?.closest('li')) {
                    return NodeFilter.FILTER_SKIP;
                }
                if (/^h[1-6]$/.test(tag) || tag === 'p' || tag === 'li' || tag === 'blockquote') {
                    return NodeFilter.FILTER_ACCEPT;
                }
                return NodeFilter.FILTER_SKIP;
            }
        });
        while (walker.nextNode()) {
            blockEls.push(walker.currentNode);
        }

        // Zip: match DOM elements to sourceMap entries.
        // Both are in document order, so we advance through both lists together.
        // Only skip a few entries on type mismatch to avoid catastrophic drift.
        let mapIdx = 0;
        for (const el of blockEls) {
            if (mapIdx >= sourceMap.length) break;
            const tag = el.tagName.toLowerCase();

            let expectedType;
            if (/^h[1-6]$/.test(tag)) expectedType = 'heading';
            else if (tag === 'p') expectedType = 'paragraph';
            else if (tag === 'li') expectedType = 'list_item';
            else if (tag === 'blockquote') expectedType = 'blockquote';

            // Look ahead at most 3 entries for a type match to prevent drift
            let found = -1;
            for (let look = 0; look < 3 && mapIdx + look < sourceMap.length; look++) {
                if (sourceMap[mapIdx + look].type === expectedType) {
                    found = mapIdx + look;
                    break;
                }
            }

            if (found !== -1) {
                const entry = sourceMap[found];
                el.setAttribute('data-source-start', entry.start);
                el.setAttribute('data-source-end', entry.end);
                mapIdx = found + 1;
            }

            // Always add selectable markers regardless of source map match
            if (tag === 'li') {
                el.setAttribute('data-selectable', 'bullet');
            } else if (tag === 'blockquote') {
                el.setAttribute('data-selectable', 'quote');
            } else if (/^h[1-6]$/.test(tag)) {
                el.setAttribute('data-selectable', 'heading');
            } else if (tag === 'p') {
                this.processParagraphSentences(el);
            }
        }

        // Handle remaining elements not in blockEls
        doc.querySelectorAll('p:not([data-selectable])').forEach(p => {
            this.processParagraphSentences(p);
        });
        doc.querySelectorAll('li:not([data-selectable])').forEach(li => {
            li.setAttribute('data-selectable', 'bullet');
        });
        doc.querySelectorAll('blockquote:not([data-selectable])').forEach(bq => {
            bq.setAttribute('data-selectable', 'quote');
        });

        // Table rows are marked on their own pass (they're deliberately absent
        // from blockEls/sourceMap so they can't drift the zip above) and get
        // their source offsets from the independent tableRowMap.
        this._markTableRows(doc, tableRowMap);
        this._appendStashBubbles(doc);

        const wrapper = document.createElement('div');
        wrapper.appendChild(doc);
        return wrapper.innerHTML;
    }

    /**
     * Mark <tbody> rows as selectable so each row gets its own stash bubble.
     * Shared by BOTH render paths — addSelectableMarkers() (chat messages) and
     * _addSelectableMarkersWithSourceMap() (file-preview rendered view). Keep it
     * that way: table rows were originally only marked on the chat path, which
     * silently left markdown tables in the file previewer with no bubbles at all.
     *
     * @param {DocumentFragment} doc
     * @param {Array<{start:number,end:number}>|null} tableRowMap - optional
     *        per-row source offsets, zipped 1:1 in document order. Applied only
     *        when the count matches exactly (a table nested in a blockquote or
     *        list isn't in the map, so a mismatch means "don't guess").
     */
    _markTableRows(doc, tableRowMap = null) {
        const rows = doc.querySelectorAll('tbody tr');
        const canMap = Array.isArray(tableRowMap) && tableRowMap.length === rows.length;
        rows.forEach((tr, i) => {
            tr.setAttribute('data-selectable', 'table-row');
            if (canMap) {
                tr.setAttribute('data-source-start', tableRowMap[i].start);
                tr.setAttribute('data-source-end', tableRowMap[i].end);
            }
        });
    }

    /**
     * Byte offsets for every GFM table *body* row, in document order.
     * Kept separate from _buildSourceMap so a 20-row table can't push the
     * heading/paragraph/list zip past its 3-entry lookahead window.
     * Only top-level tables are walked — same reasoning as nested lists.
     */
    _buildTableRowMap(source, tokens) {
        const entries = [];
        let searchFrom = 0;
        for (const token of tokens) {
            if (!token.raw) continue;
            const idx = source.indexOf(token.raw, searchFrom);
            if (idx === -1) continue;
            const end = idx + token.raw.length;
            searchFrom = end;
            if (token.type !== 'table') continue;

            // A GFM table's raw is: header line, delimiter line, then one line
            // per body row. Walk the raw line-by-line and record the data rows.
            let cursor = idx;
            let lineNo = 0;
            for (const line of token.raw.split('\n')) {
                const lineStart = cursor;
                cursor += line.length + 1; // +1 for the consumed '\n'
                lineNo++;
                if (lineNo <= 2) continue;      // header + delimiter
                if (!line.trim()) continue;     // trailing blank line
                entries.push({ type: 'table_row', start: lineStart, end: lineStart + line.length });
            }
        }
        return entries;
    }

    /**
     * Add selectable markers to elements for tap-to-select on touch devices.
     * Adds data-selectable attributes and wraps sentences for easy selection.
     * @param {string} html - HTML to process
     */
    addSelectableMarkers(html) {
        // Parse HTML into DOM
        const template = document.createElement('template');
        template.innerHTML = html.trim();
        const doc = template.content;

        // PERF: Single querySelectorAll with combined selector for simple elements
        // This reduces 4 DOM scans to 2 (one for simple attrs, one for complex paragraphs)
        doc.querySelectorAll('li, blockquote, h1, h2, h3, h4, h5, h6').forEach(el => {
            const tag = el.tagName.toLowerCase();
            if (tag === 'li') {
                el.setAttribute('data-selectable', 'bullet');
            } else if (tag === 'blockquote') {
                el.setAttribute('data-selectable', 'quote');
            } else {
                el.setAttribute('data-selectable', 'heading');
            }
        });

        // Process paragraphs - try sentence-level splitting (needs separate pass)
        doc.querySelectorAll('p').forEach(p => {
            this.processParagraphSentences(p);
        });

        this._markTableRows(doc);
        this._appendStashBubbles(doc);

        // Serialize back to HTML
        const wrapper = document.createElement('div');
        wrapper.appendChild(doc);
        return wrapper.innerHTML;
    }

    /**
     * Append a real <span class="stash-bubble"> to every [data-selectable] so
     * the bubble icon can carry data-tooltip and have its own :hover.
     * The glyph is drawn by CSS ::before — a masked svg tinted with
     * background-color (see 30-markdown.css), so it contributes no text and
     * stays out of parent.textContent (selection-handler captures element text
     * raw). It is deliberately NOT an emoji: emoji render in their own fixed
     * colours, so the "has a comment" state couldn't just switch colour.
     * Table rows put the bubble in their LAST CELL (a <tr> can't be a
     * positioning context), tagged with data-stash-cell so CSS and the
     * selection handler can find it without positional guessing. Do NOT go back
     * to `td:last-child`/lastElementChild here: the file-preview widget appends
     * an inline-edit trash <button> as a direct child of the <tr>, which makes
     * the last *child* a BUTTON — that silently broke the bubble's CSS (no
     * position:relative, no hover rule → invisible/mispositioned bubbles) and
     * the has-stash lookup on every table in the previewer.
     */
    _appendStashBubbles(doc) {
        const tipText = S?.ui?.stash?.bubble_tooltip || 'Click to add comment';
        doc.querySelectorAll('[data-selectable]').forEach(el => {
            if (el.tagName === 'TR' && el.dataset.selectable === 'table-row') {
                // el.cells is td+th only, always direct children — trailing
                // non-cell elements can't confuse it.
                const lastCell = el.cells?.[el.cells.length - 1];
                if (lastCell) {
                    lastCell.setAttribute('data-stash-cell', '');
                    if (!lastCell.querySelector(':scope > .stash-bubble')) {
                        lastCell.appendChild(this._buildStashBubble(tipText));
                    }
                }
                return;
            }
            if (!el.querySelector(':scope > .stash-bubble')) {
                el.appendChild(this._buildStashBubble(tipText));
            }
        });
    }

    _buildStashBubble(tipText) {
        const bubble = document.createElement('span');
        bubble.className = 'stash-bubble';
        bubble.setAttribute('data-tooltip', tipText);
        bubble.setAttribute('aria-hidden', 'true');
        return bubble;
    }

    /**
     * Process a paragraph for sentence-level selection.
     * If paragraph has complex inline elements, marks whole paragraph.
     * Otherwise splits into sentences.
     * @param {HTMLElement} p - Paragraph element
     */
    processParagraphSentences(p) {
        // Skip if paragraph is inside a blockquote (already selectable)
        if (p.closest('blockquote')) return;

        // Check if paragraph has complex inline elements that would break splitting
        const hasComplexInline = p.querySelector('a, pre, code, img');

        if (hasComplexInline) {
            // Too complex for sentence splitting, mark whole paragraph
            p.setAttribute('data-selectable', 'paragraph');
            return;
        }

        // Get text content for sentence detection
        const text = p.textContent.trim();
        if (!text) return;

        // Split into sentences using regex
        // Matches: .!? followed by space(s) and capital letter or quote
        // Avoids splitting after common abbreviations
        const sentences = this.splitIntoSentences(text);

        if (sentences.length <= 1) {
            // Single sentence, mark whole paragraph
            p.setAttribute('data-selectable', 'sentence');
            return;
        }

        // Multiple sentences - check if we can safely split
        // Only split if paragraph has no inline elements (just text)
        if (p.children.length > 0) {
            // Has inline elements like <strong>, <em> - mark whole paragraph
            p.setAttribute('data-selectable', 'paragraph');
            return;
        }

        // Pure text paragraph - wrap each sentence
        p.textContent = ''; // Clear
        sentences.forEach((sentence, i) => {
            const span = document.createElement('span');
            span.setAttribute('data-selectable', 'sentence');
            span.textContent = sentence.trim();
            p.appendChild(span);
            if (i < sentences.length - 1) {
                p.appendChild(document.createTextNode(' '));
            }
        });
    }

    /**
     * Split text into sentences.
     * @param {string} text - Plain text to split
     * @returns {string[]} Array of sentences
     */
    splitIntoSentences(text) {
        // Sentence-ending pattern:
        // - Period, exclamation, or question mark
        // - Followed by one or more spaces
        // - Followed by capital letter, quote, or number
        // Negative lookbehind to avoid splitting after abbreviations
        const pattern = /(?<![A-Z][a-z]|Mr|Mrs|Ms|Dr|Jr|Sr|vs|etc|e\.g|i\.e|[0-9])\.\s+(?=[A-Z"'\d])|(?<=[!?])\s+(?=[A-Z"'])/g;

        const parts = text.split(pattern);
        return parts.filter(s => s && s.trim().length > 0);
    }

    /**
     * Convert file paths in text to clickable preview links.
     * Skips content inside <pre> (code blocks) and <a> (already linked).
     * Uses server-side verifiedFiles map to determine which paths exist.
     * @param {string} html - HTML to process
     * @param {Object|null} verifiedFiles - Map of {filename: resolvedPath|null} from server
     */
    linkifyFilePaths(html, verifiedFiles = null) {
        // Track tag nesting to skip a tags (avoid nested links)
        // Note: We DO linkify inside <pre> (code blocks) since paths are server-verified
        const tagStack = [];
        const skipTags = new Set(['a']);
        let result = '';
        let lastIndex = 0;

        // Match all HTML tags
        const tagRegex = /<\/?([a-zA-Z][a-zA-Z0-9]*)[^>]*>/g;
        let tagMatch;

        while ((tagMatch = tagRegex.exec(html)) !== null) {
            // Process text before this tag
            const textBefore = html.slice(lastIndex, tagMatch.index);

            // Only linkify if we're not inside a skip tag
            const inSkipTag = tagStack.some(t => skipTags.has(t.toLowerCase()));
            if (!inSkipTag && textBefore) {
                result += this.linkifyPathsInText(textBefore, verifiedFiles);
            } else {
                result += textBefore;
            }

            // Add the tag itself
            result += tagMatch[0];

            // Update tag stack
            const tagName = tagMatch[1].toLowerCase();
            if (tagMatch[0].startsWith('</')) {
                // Closing tag
                const idx = tagStack.lastIndexOf(tagName);
                if (idx !== -1) tagStack.splice(idx, 1);
            } else if (!tagMatch[0].endsWith('/>')) {
                // Opening tag (not self-closing)
                tagStack.push(tagName);
            }

            lastIndex = tagMatch.index + tagMatch[0].length;
        }

        // Process remaining text after last tag
        const remaining = html.slice(lastIndex);
        const inSkipTag = tagStack.some(t => skipTags.has(t.toLowerCase()));
        if (!inSkipTag && remaining) {
            result += this.linkifyPathsInText(remaining, verifiedFiles);
        } else {
            result += remaining;
        }

        return result;
    }

    /**
     * Linkify file paths and URLs within a text segment (no HTML tags).
     * Uses position tracking to avoid overlapping matches.
     * File paths are ONLY linked when server-verified (no client-side fallback).
     * URLs are always linked (no verification needed).
     * @param {string} text - Text to process
     * @param {Object|null} verifiedFiles - Map of {filename: resolvedPath|null} from server. Required for file links.
     */
    linkifyPathsInText(text, verifiedFiles = null) {
        const replacements = []; // [{start, end, html}]

        // 1. Find URLs first (higher priority)
        const urlPattern = buildUrlPattern();
        let match;
        while ((match = urlPattern.exec(text)) !== null) {
            let url = match[0];
            const cleaned = cleanUrlTrailingPunct(url);
            url = cleaned.url;
            const end = match.index + url.length;

            // Decode HTML entities (text is already escaped by markdown parser)
            // e.g., &amp; -> & so URLs work correctly
            const decodedUrl = decodeHtml(url);
            // Re-escape per context: the href needs quote-safety plus a scheme
            // check (escapeHtml alone gave neither), the link text only needs
            // element-content escaping. Same string, two different escapes —
            // reusing one value for both was the bug shape this gate exists to
            // catch, it just evaded the grep by living on an earlier line.
            const safeHref = escapeAttr(MarkdownRenderer.sanitizeHref(decodedUrl));
            const escapedUrl = escapeHtml(decodedUrl);
            replacements.push({
                start: match.index,
                end: end,
                html: `<a href="${safeHref}" class="external-link" target="_blank" rel="noopener noreferrer">${escapedUrl}</a>`
            });
        }

        // 2. Find file paths (skip positions covered by URLs)
        const pathPattern = buildPathPattern();

        while ((match = pathPattern.exec(text)) !== null) {
            const path = match[1];
            const lineInfo = match[2] || '';
            const fullMatch = match[0];

            // Skip invalid paths
            if (!path.includes('/')) continue;
            if (/^\d+\.\d+/.test(path)) continue;
            if (/^\d+\/\d+/.test(path)) continue;

            // Only create links for server-verified files (no client-side fallback)
            if (!verifiedFiles) continue;
            const resolvedPath = verifiedFiles[path];
            if (!resolvedPath) continue;

            // Check for overlap with URL replacements
            const overlaps = replacements.some(r =>
                (match.index < r.end && match.index + fullMatch.length > r.start)
            );
            if (overlaps) continue;

            const fullDisplay = lineInfo ? path + lineInfo : path;

            // Parse line info into options for preview
            const lineOpts = parseLineInfo(lineInfo);
            const optsJson = lineOpts ? JSON.stringify(lineOpts).replace(/"/g, '&quot;') : '';
            const optsAttr = optsJson ? ` data-line-opts="${optsJson}"` : '';

            replacements.push({
                start: match.index,
                end: match.index + fullMatch.length,
                html: `<a href="#" class="file-path-link" data-file="${escapeHtml(path)}" data-resolved="${escapeHtml(resolvedPath)}" data-tooltip="${escapeHtml(resolvedPath)}"${optsAttr}>${escapeHtml(fullDisplay)}</a>`
            });
        }

        // 3. Match standalone filenames (e.g., server.py, CLAUDE.md)
        // Server verification eliminates false positives, so no inInlineCode restriction needed
        const standalonePattern = buildStandalonePattern();

        while ((match = standalonePattern.exec(text)) !== null) {
            const filename = match[1];
            const lineInfo = match[2] || '';
            const fullMatch = match[0];

            // Get preceding text for context validation
            const precedingText = text.slice(Math.max(0, match.index - 20), match.index);

            // Validate the match to reduce false positives
            if (!isValidStandaloneFile(filename, precedingText)) {
                continue;
            }

            // Only create links for server-verified files (no client-side fallback)
            if (!verifiedFiles) continue;
            const resolvedPath = verifiedFiles[filename];
            if (!resolvedPath) continue;

            // Check for overlap with existing replacements
            const overlaps = replacements.some(r =>
                (match.index < r.end && match.index + fullMatch.length > r.start)
            );
            if (overlaps) continue;

            const fullDisplay = lineInfo ? filename + lineInfo : filename;

            // Parse line info into options for preview
            const lineOpts = parseLineInfo(lineInfo);
            const optsJson = lineOpts ? JSON.stringify(lineOpts).replace(/"/g, '&quot;') : '';
            const optsAttr = optsJson ? ` data-line-opts="${optsJson}"` : '';

            replacements.push({
                start: match.index,
                end: match.index + fullMatch.length,
                html: `<a href="#" class="file-path-link" data-file="${escapeHtml(filename)}" data-resolved="${escapeHtml(resolvedPath)}" data-tooltip="${escapeHtml(resolvedPath)}"${optsAttr}>${escapeHtml(fullDisplay)}</a>`
            });
        }

        // 4. Sort by position (descending) and apply replacements
        replacements.sort((a, b) => b.start - a.start);
        for (const r of replacements) {
            text = text.slice(0, r.start) + r.html + text.slice(r.end);
        }

        return text;
    }

    /**
     * Process excalidraw placeholder blocks after DOM insertion.
     * Finds unprocessed .excalidraw-inline elements, fetches SVG from server,
     * and replaces the loading state with the rendered diagram.
     * @param {HTMLElement} container - DOM element to scan for excalidraw blocks
     */
    /**
     * Server-side chart/excalidraw rendering gate. Off unless the server
     * injected `renderers_enabled: true` (it defaults off — model-authored
     * specs render via a Node subprocess with an SSRF-capable data loader).
     * @returns {boolean}
     */
    static renderersEnabled() {
        return window.INSTANCE_CONFIG?.renderers_enabled === true;
    }

    static processExcalidrawBlocks(container) {
        const blocks = container.querySelectorAll('.excalidraw-inline:not([data-rendered])');
        if (blocks.length === 0) return;

        blocks.forEach(block => {
            block.setAttribute('data-rendered', 'true');

            // Decode base64-encoded JSON from data attribute
            // (stored as base64 so DOMPurify keeps it and the linkifier can't corrupt it)
            const encoded = block.dataset.excalidrawJson;
            if (!encoded) return;

            let jsonText;
            try {
                jsonText = decodeURIComponent(escape(atob(encoded)));
            } catch {
                return;
            }

            // Rendering disabled: show an inert notice, never POST the spec.
            if (!MarkdownRenderer.renderersEnabled()) {
                block.innerHTML = `
                    <div class="excalidraw-inline-error">
                        <span>${escapeHtml(S.tool_renderer.errors.diagram_disabled)}</span>
                    </div>
                `;
                return;
            }

            fetch('/api/excalidraw/render', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: jsonText,
            })
            .then(resp => {
                if (!resp.ok) throw new Error(`Render failed: ${resp.status}`);
                return resp.text();
            })
            .then(svg => {
                block.innerHTML = `
                    <div class="excalidraw-inline-rendered">
                        <div class="excalidraw-inline-svg">${sanitizeSvg(svg)}</div>
                        <div class="excalidraw-inline-actions">
                            <button class="excalidraw-copy-btn" data-tooltip="Copy JSON">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <rect x="9" y="9" width="13" height="13" rx="2"/>
                                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                                </svg>
                            </button>
                        </div>
                    </div>
                `;
                // Store JSON for copy action
                block._excalidrawJson = jsonText;
                block.querySelector('.excalidraw-copy-btn')?.addEventListener('click', () => {
                    navigator.clipboard.writeText(jsonText).then(() => {
                        const btn = block.querySelector('.excalidraw-copy-btn');
                        if (btn) { btn.setAttribute('data-tooltip', 'Copied!'); setTimeout(() => btn.setAttribute('data-tooltip', 'Copy JSON'), 1500); }
                    });
                });
            })
            .catch(err => {
                console.error('Excalidraw render error:', err);
                block.innerHTML = `
                    <div class="excalidraw-inline-error">
                        <span>Failed to render diagram: ${escapeHtml(err.message)}</span>
                    </div>
                `;
            });
        });
    }

    /**
     * Process Vega-Lite chart placeholder blocks after DOM insertion.
     * Finds unprocessed .chart-inline elements, fetches SVG from server,
     * and replaces the loading state with the rendered chart.
     * @param {HTMLElement} container - DOM element to scan for chart blocks
     */
    static processChartBlocks(container) {
        const blocks = container.querySelectorAll('.chart-inline:not([data-rendered])');
        if (blocks.length === 0) return;

        blocks.forEach(block => {
            block.setAttribute('data-rendered', 'true');

            // Decode base64-encoded JSON from data attribute
            // (stored as base64 to prevent linkifier from corrupting URLs in the spec)
            const encoded = block.dataset.chartJson;
            if (!encoded) return;

            let jsonText;
            try {
                jsonText = decodeURIComponent(escape(atob(encoded)));
            } catch {
                return;
            }

            // Rendering disabled: show an inert notice, never POST the spec.
            if (!MarkdownRenderer.renderersEnabled()) {
                block.innerHTML = `
                    <div class="chart-inline-error">
                        <span>${escapeHtml(S.tool_renderer.errors.chart_disabled)}</span>
                    </div>
                `;
                return;
            }

            fetch('/api/chart/render', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: jsonText,
            })
            .then(resp => {
                if (!resp.ok) throw new Error(`Render failed: ${resp.status}`);
                return resp.text();
            })
            .then(svg => {
                block.innerHTML = `
                    <div class="chart-inline-rendered">
                        <div class="chart-inline-svg">${sanitizeSvg(svg)}</div>
                        <div class="chart-inline-actions">
                            <button class="chart-copy-btn" data-tooltip="Copy JSON">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <rect x="9" y="9" width="13" height="13" rx="2"/>
                                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                                </svg>
                            </button>
                        </div>
                    </div>
                `;
                block._chartJson = jsonText;
                block.querySelector('.chart-copy-btn')?.addEventListener('click', () => {
                    navigator.clipboard.writeText(jsonText).then(() => {
                        const btn = block.querySelector('.chart-copy-btn');
                        if (btn) { btn.setAttribute('data-tooltip', 'Copied!'); setTimeout(() => btn.setAttribute('data-tooltip', 'Copy JSON'), 1500); }
                    });
                });
            })
            .catch(err => {
                console.error('Chart render error:', err);
                block.innerHTML = `
                    <div class="chart-inline-error">
                        <span>Failed to render chart: ${escapeHtml(err.message)}</span>
                    </div>
                `;
            });
        });
    }
}

/**
 * Autocomplete dropdown for slash commands and shell commands
 */
export class AutocompleteUI {
    constructor(container, input) {
        this.container = container;
        this.input = input;
        this.visible = false;
        this.items = [];
        this.selectedIndex = -1;
        this.mode = null; // 'slash' or 'bang'
        this.agentCommands = []; // Commands fetched from server
        this.triggerPos = 0; // index of '/' or start of bang
        this.query = '';
    }

    /**
     * Set Claude commands from system init message
     * @param {Array} commandNames - ["todo", "compact", "cost", ...] (names without leading /)
     * @param {Set} [userCommandNames] - Set of user-defined command names (from ~/.claude/commands/)
     * @param {Object} [descriptions] - {name: "description"} from server
     */
    setAgentCommands(commandNames, userCommandNames, descriptions) {
        this.agentCommands = (commandNames || []).map(name => ({
            cmd: '/' + name,
            desc: descriptions?.[name] || (userCommandNames?.has(name) ? 'User command' : 'Claude command'),
            isAgentCommand: true,
        }));
    }

    show(mode, filter = '', triggerPos = 0) {
        this.mode = mode;
        this.triggerPos = triggerPos;
        this.query = filter;

        if (mode === 'slash') {
            // Build command list: built-in → custom → Claude
            const allCommands = [];
            const seenCmds = new Set();

            // 1. Built-in commands (highest priority)
            for (const cmd of COMMANDS) {
                allCommands.push(cmd);
                seenCmds.add(cmd.cmd);
            }

            // 2. Custom commands from CommandStore
            const app = getApp();
            const projectPath = app?.cwd || null;
            const commandStore = getCommandStore();
            const customCommands = commandStore.getCommands(projectPath);

            for (const cmd of customCommands) {
                if (!seenCmds.has(cmd.cmd)) {
                    allCommands.push({
                        cmd: cmd.cmd,
                        desc: cmd.desc || (cmd.type === CommandType.SHELL ? 'Shell command' : 'Custom prompt'),
                        isCustomCommand: true,
                        customData: cmd,
                    });
                    seenCmds.add(cmd.cmd);
                }
            }

            // 3. Claude commands (from server, lowest priority)
            for (const cmd of this.agentCommands) {
                if (!seenCmds.has(cmd.cmd)) {
                    allCommands.push(cmd);
                    seenCmds.add(cmd.cmd);
                }
            }

            // Filter by search term
            this.items = allCommands.filter(c =>
                c.cmd.toLowerCase().includes(filter.toLowerCase())
            );
        } else if (mode === 'bang') {
            const recentCommands = getRecentShellCommands();
            this.items = recentCommands
                .filter(c => c.toLowerCase().includes(filter.toLowerCase()))
                .map(c => ({ cmd: '!' + c, desc: 'Recent command' }));
        }

        if (this.items.length === 0) {
            this.hide();
            return;
        }

        // Auto-select first item so Tab works immediately (suppressed for Tab-cycle browse)
        this.selectedIndex = this.noPreselectOnce ? -1 : 0;
        this.noPreselectOnce = false;
        this.render();
        this.visible = true;
        this.container.classList.add('visible');
        this._detachAnchor?.();
        this._detachAnchor = anchorAbove(this.container, this.input, this.triggerPos);
    }

    hide() {
        this.visible = false;
        this.container.classList.remove('visible');
        this.items = [];
        this.selectedIndex = -1;
        this.triggerPos = 0;
        this.query = '';
        this._detachAnchor?.();
        this._detachAnchor = null;
    }

    render() {
        const sectionTitle = this.mode === 'slash' ? 'Commands' : 'Recent Shell Commands';

        this.container.innerHTML = `
            <div class="autocomplete-section">${sectionTitle}</div>
            ${this.items.map((item, i) => `
                <div class="autocomplete-item ${i === this.selectedIndex ? 'selected' : ''}"
                     data-index="${i}"${item.desc && item.desc.length > 120
                         ? ` data-tooltip="${escapeAttr(item.desc)}" data-tooltip-multiline=""`
                         : ''}>
                    <span class="autocomplete-cmd">${escapeHtml(item.cmd)}</span>
                    <span class="autocomplete-desc">${escapeHtml(item.desc)}</span>
                </div>
            `).join('')}
        `;

        // Click handlers
        this.container.querySelectorAll('.autocomplete-item').forEach(el => {
            el.addEventListener('click', () => {
                this.select(parseInt(el.dataset.index));
            });
        });
    }

    moveSelection(delta) {
        if (!this.visible || this.items.length === 0) return;

        this.selectedIndex += delta;
        if (this.selectedIndex < 0) this.selectedIndex = this.items.length - 1;
        if (this.selectedIndex >= this.items.length) this.selectedIndex = 0;

        this.render();

        requestAnimationFrame(() => {
            const selectedEl = this.container.querySelector('.autocomplete-item.selected');
            if (selectedEl) {
                selectedEl.scrollIntoView({ block: 'nearest', behavior: 'auto' });
            }
        });
    }

    select(index = this.selectedIndex) {
        if (index < 0 || index >= this.items.length) return;
        const item = this.items[index];

        if (this.mode === 'slash') {
            // Determine whether the command needs args (forces trailing space, no auto-execute)
            let needsArgs = false;
            if (item.isCustomCommand) {
                const customData = item.customData;
                const needsInput = customData.prompt?.includes('{input}') ||
                                   customData.shell?.includes('{input}');
                if (needsInput) needsArgs = true;
            } else if (!item.isAgentCommand && item.hasArgs) {
                needsArgs = true;
            }
            const insertText = needsArgs ? item.cmd + ' ' : item.cmd;

            // Position-aware replacement: replace `/query` at triggerPos with insertText.
            const value = this.input.value;
            const before = value.slice(0, this.triggerPos);
            const after = value.slice(this.triggerPos + 1 + this.query.length);
            this.input.value = before + insertText + after;
            const newCursor = before.length + insertText.length;
            this.input.selectionStart = this.input.selectionEnd = newCursor;
            this.input.dispatchEvent(new Event('input', { bubbles: true }));
            this.input.focus();
            this.hide();

            // Auto-execute only when: command was the entire input (start-of-line, no other text),
            // it takes no args, and it isn't a Claude-side command (those need Enter to forward).
            const isWholeInput = before === '' && after === '';
            if (isWholeInput && !needsArgs && !item.isAgentCommand) {
                const app = getApp();
                if (app) app.handleInput();
            }
            return;
        }

        // Bang mode: replace whole input with the recent shell command
        this.input.value = item.cmd;
        this.input.dispatchEvent(new Event('input', { bubbles: true }));
        this.input.focus();
        this.hide();
    }

    hasSelection() {
        return this.selectedIndex >= 0;
    }
}
