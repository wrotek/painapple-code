/**
 * Markdown preview plugin
 *
 * Handles: .md, .markdown
 * Adds a "Rendered" view mode that renders markdown via MarkdownRenderer.
 * Falls through to default code view for 'code' mode.
 * Supports inline editing: click any block to edit its raw markdown in-place.
 */

import { MarkdownRenderer } from '../components.js';
import { setupInlineEdit, isInlineEditActive, setupCheckboxes } from '../preview/preview-inline-edit.js';
import { escapeHtml } from '../utils.js';
import S from '../strings.js';

let mdRenderer = null;
function getRenderer() {
    if (!mdRenderer) mdRenderer = new MarkdownRenderer();
    return mdRenderer;
}

// ═══════════════════════════════════════════════════════════════════
// YAML front matter — parsed into a friendly key/value panel instead
// of letting marked render the fences as <hr> + garbled heading.
// ═══════════════════════════════════════════════════════════════════

const FRONT_MATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

/**
 * Detect and parse a leading YAML front matter block.
 * Light line-based parse: top-level `key: value` pairs, with any indented
 * continuation lines (nested maps, lists, |/> scalars) kept as a raw block.
 * Returns { fields, bodyOffset } or null when the file has no front matter.
 */
function parseFrontMatter(content) {
    const m = content?.match(FRONT_MATTER_RE);
    if (!m) return null;
    const fields = [];
    let current = null;
    for (const line of m[1].split('\n')) {
        const top = line.match(/^([A-Za-z0-9_][\w.-]*)\s*:\s?(.*)$/);
        if (top) {
            current = { key: top[1], value: top[2].trim(), block: [] };
            fields.push(current);
        } else if (current && (line.trim() === '' || /^\s/.test(line))) {
            current.block.push(line);
        }
    }
    if (!fields.length) return null;
    return { fields, bodyOffset: m[0].length };
}

function unquote(s) {
    const m = s.match(/^(['"])(.*)\1$/);
    return m ? m[2] : s;
}

/** Extract list items from `[a, b]` flow or `- item` block syntax, else null. */
function frontMatterListItems(field) {
    if (/^\[.*\]$/.test(field.value)) {
        return field.value.slice(1, -1).split(',')
            .map(s => unquote(s.trim())).filter(Boolean);
    }
    const nonEmpty = field.block.filter(l => l.trim());
    if (field.value === '' && nonEmpty.length && nonEmpty.every(l => /^\s*-\s/.test(l))) {
        return nonEmpty.map(l => unquote(l.replace(/^\s*-\s+/, '').trim()));
    }
    return null;
}

function frontMatterValueHtml(field) {
    const items = frontMatterListItems(field);
    if (items) {
        return items.map(it => `<span class="preview-fm-chip">${escapeHtml(it)}</span>`).join('');
    }
    const nonEmpty = field.block.filter(l => l.trim());
    if (nonEmpty.length && (field.value === '' || /^[|>][+-]?\d*$/.test(field.value))) {
        // Nested map or literal/folded scalar — show the dedented raw block
        const indent = Math.min(...nonEmpty.map(l => l.match(/^\s*/)[0].length));
        const block = field.block.map(l => l.slice(indent)).join('\n').replace(/\s+$/, '');
        return `<pre class="preview-fm-block">${escapeHtml(block)}</pre>`;
    }
    return `<span class="preview-fm-value">${escapeHtml(unquote(field.value))}</span>`;
}

function renderFrontMatterHtml(fm, collapsed) {
    const rows = fm.fields.map(f => `
        <div class="preview-fm-row">
            <div class="preview-fm-key">${escapeHtml(f.key)}</div>
            <div class="preview-fm-val">${frontMatterValueHtml(f)}</div>
        </div>`).join('');
    const title = S.preview?.front_matter_title || 'Front matter';
    return `
        <div class="preview-frontmatter ${collapsed ? 'collapsed' : ''}">
            <button class="preview-fm-header" data-tooltip="${S.preview?.front_matter_toggle || 'Toggle front matter'}">
                <svg class="preview-fm-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
                <span class="preview-fm-title">${title}</span>
                <span class="preview-fm-count">${fm.fields.length}</span>
            </button>
            <div class="preview-fm-fields">${rows}</div>
        </div>`;
}

/**
 * Resolve a relative href/src against a base directory (absolute path).
 * Strips query/hash, handles `.`/`..` segments. Returns the absolute
 * path, or null when the result escapes the filesystem root.
 */
function resolveRelative(baseDir, rel) {
    const parts = baseDir.split('/');
    let clean = rel.split(/[?#]/)[0];
    try { clean = decodeURIComponent(clean); } catch { /* keep raw */ }
    for (const seg of clean.split('/')) {
        if (!seg || seg === '.') continue;
        if (seg === '..') parts.pop(); else parts.push(seg);
    }
    if (parts[0] !== '' || parts.length < 2) return null;
    return parts.join('/');
}

// Pencil icon SVG for the inline edit toggle
const pencilIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>`;

export default {
    id: 'markdown',

    match(path) {
        const ext = path?.split('.').pop()?.toLowerCase();
        return ext === 'md' || ext === 'markdown';
    },

    needsFetch: true,
    editable: true,

    viewModes: [{
        mode: 'rendered',
        label: 'Rendered',
        icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>`,
    }],

    defaultViewMode: 'rendered',

    initState() { return {}; },

    renderBody(state, helpers) {
        // Only handle rendered mode — code/edit modes fall through to core
        if (state.viewMode !== 'rendered') return null;

        const renderer = getRenderer();
        const content = state.content || '';

        // Front matter renders as a key/value panel; the markdown body is
        // rendered from the remainder with offsets shifted so inline edits
        // still map back into the full file content.
        const fm = parseFrontMatter(content);
        const fmHtml = fm ? renderFrontMatterHtml(fm, state.fmCollapsed) : '';
        const body = fm ? content.slice(fm.bodyOffset) : content;
        const renderedHtml = renderer.renderWithSourceMap(body, fm ? fm.bodyOffset : 0);
        const isActive = isInlineEditActive();
        const tooltip = isActive
            ? (S.preview?.inline_edit_disable || 'Disable inline editing')
            : (S.preview?.inline_edit_enable || 'Click to edit');

        return `
            <div class="preview-body">
                <div class="preview-rendered-wrapper">
                    ${fmHtml}
                    <button class="inline-edit-toggle ${isActive ? 'active' : ''}" data-tooltip="${tooltip}">
                        ${pencilIcon}
                    </button>
                    <div class="preview-rendered markdown-content ${isActive ? 'inline-edit-mode' : ''}">${renderedHtml}</div>
                </div>
            </div>
        `;
    },

    setupEvents(container, state, helpers) {
        // Markdown rendered view: process inline excalidraw/chart blocks
        if (state.viewMode === 'rendered') {
            MarkdownRenderer.processExcalidrawBlocks?.(container);
            MarkdownRenderer.processChartBlocks?.(container);
            setupInlineEdit(container);
            setupCheckboxes(container);

            const fmHeader = container.querySelector('.preview-fm-header');
            fmHeader?.addEventListener('click', () => {
                const panel = fmHeader.closest('.preview-frontmatter');
                panel?.classList.toggle('collapsed');
                state.fmCollapsed = panel?.classList.contains('collapsed');
            });

            // Relative links (e.g. [notes](notes.md)) open in this preview,
            // resolved against the current file's directory — the renderer's
            // target="_blank" would 404 them against the app origin. Scheme'd
            // URLs, //host, /absolute and #anchor links keep default behavior.
            const rendered = container.querySelector('.preview-rendered');

            // Relative image srcs (![x](assets/a.png), <img src="…">) would
            // resolve against the app origin and 404 — point them at
            // /api/file-raw against the file's directory. On miss, retry
            // against the session cwd: README section sources reference
            // repo-root-relative paths that only compose correctly at root.
            if (rendered) {
                const fileDir = (state.currentPath || '').split('/').slice(0, -1).join('/');
                for (const img of rendered.querySelectorAll('img[src]')) {
                    const src = img.getAttribute('src') || '';
                    if (/^([a-z][a-z0-9+.-]*:|\/\/|\/)/i.test(src)) continue;
                    const abs = resolveRelative(fileDir, src);
                    if (!abs) continue;
                    img.src = `/api/file-raw?path=${encodeURIComponent(abs)}`;
                    const rootAbs = state.cwd ? resolveRelative(state.cwd, src) : null;
                    if (rootAbs && rootAbs !== abs) {
                        img.addEventListener('error', () => {
                            img.src = `/api/file-raw?path=${encodeURIComponent(rootAbs)}`;
                        }, { once: true });
                    }
                }
            }

            rendered?.addEventListener('click', async (e) => {
                if (isInlineEditActive()) return;
                const a = e.target.closest('a[href]');
                if (!a || !rendered.contains(a)) return;
                const href = a.getAttribute('href') || '';
                if (href.startsWith('#')) {
                    // In-page anchors: marked runs with headerIds:false and
                    // target=_blank, so default behavior opens a dead tab.
                    // Resolve the slug against heading text ourselves — same
                    // algorithm as compose.sh's slug() (keep them in sync).
                    e.preventDefault();
                    let want; try { want = decodeURIComponent(href.slice(1)); } catch { want = href.slice(1); }
                    const seen = new Map();
                    for (const h of rendered.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
                        let s = h.textContent.trim().toLowerCase()
                            .replace(/[^\p{L}\p{N}_\s-]/gu, '')
                            .replace(/\s+/g, '-').replace(/^-+|-+$/g, '');
                        const n = seen.get(s) || 0;
                        seen.set(s, n + 1);
                        if (n) s = `${s}-${n}`;
                        if (s === want) { h.scrollIntoView({ behavior: 'smooth', block: 'start' }); break; }
                    }
                    return;
                }
                if (/^([a-z][a-z0-9+.-]*:|\/\/|\/)/i.test(href)) return;
                e.preventDefault();
                const fileDir = (state.currentPath || '').split('/').slice(0, -1).join('/');
                const target = resolveRelative(fileDir, href);
                if (!target) return; // escaped filesystem root
                const { FilePreviewWidget } = await import('../widgets/file-preview-widget.js');
                FilePreviewWidget.preview(target);
            });
        }
    },
};
