/**
 * Preview rendering
 *
 * Handles all HTML rendering for the preview widget:
 * renderPreview, renderBody, renderBodyWithState, highlightContent, scrollToLine
 */

import { state, pluginHelpers, isEditMode, isHistoryMode, isEditable, wrapLines } from './preview-state.js';
import { getHighlightLanguage, getEffectiveLanguage, addLineNumbers, AVAILABLE_LANGUAGES } from './preview-utils.js';
import { escapeHtml } from '../utils.js';
import { detectLanguage } from '../file-tabs.js';
import { downloadBtnHtml } from '../preview-plugins/plugin-helpers.js';
import { highlightCodeToLines } from '../editor-view.js';
import { renderHistoryBody } from './preview-history.js';
import S from '../strings.js';

/**
 * Empty state — no file is open. Shown when the preview is summoned on its own
 * (rail button / Alt+V with nothing previewed yet) rather than by a file click,
 * so it has to offer a way IN: the button opens the same path picker as Cmd+O.
 *
 * The key hint is read from the live shortcut registry rather than hardcoded,
 * so it follows a user rebind (and the Mac/other split) the way the rail
 * tooltips do.
 */
function emptyStateHtml() {
    const key = window.app?.shortcutManager?.getShortcutKeys('openDialog')?.[0];
    const kbd = key ? `<kbd>${escapeHtml(key)}</kbd>` : '';

    return `
        <div class="preview-body">
            <div class="preview-empty">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                    <polyline points="14 2 14 8 20 8"/>
                </svg>
                <span>${escapeHtml(S.widgets.file_preview.empty_title)}</span>
                <span class="preview-empty-hint">${escapeHtml(S.widgets.file_preview.empty_hint)}</span>
                <button type="button" class="preview-empty-open" data-action="open-file">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                    </svg>
                    <span>${escapeHtml(S.widgets.file_preview.empty_open)}</span>
                    ${kbd}
                </button>
            </div>
        </div>
    `;
}

export function renderPreview() {
    const body = renderBody();

    return `
        <div class="file-preview-widget">
            ${body}
        </div>
    `;
}

export function renderBody() {
    if (state.isLoading) {
        return `
            <div class="preview-body">
                <div class="preview-loading">
                    <div class="loading-spinner"></div>
                    <span>Loading...</span>
                </div>
            </div>
        `;
    }

    if (state.error) {
        return `
            <div class="preview-body">
                <div class="preview-error">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="12" cy="12" r="10"/>
                        <line x1="15" y1="9" x2="9" y2="15"/>
                        <line x1="9" y1="9" x2="15" y2="15"/>
                    </svg>
                    <span>${escapeHtml(state.error)}</span>
                </div>
            </div>
        `;
    }

    if (!state.currentPath && !state.isScratch) {
        return emptyStateHtml();
    }

    // Non-editable plugin rendering (image, excalidraw, chart):
    // These return full HTML including their own toolbar, so return directly.
    if (state.plugin && !state.plugin.editable) {
        const pluginHtml = state.plugin.renderBody(state, pluginHelpers);
        if (pluginHtml !== null) return pluginHtml;
    }

    // View mode toggle — shown for all editable text files (not scratch, which is always edit)
    let viewToggle = '';
    if (isEditable() && !state.isScratch) {
        const tabs = [
            { mode: 'code', label: 'Code', icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>` },
        ];
        // Plugin-defined view modes (e.g. 'rendered' for markdown, 'table' for CSV)
        if (state.plugin?.viewModes) {
            tabs.push(...state.plugin.viewModes);
        }
        tabs.push({ mode: 'edit', label: S.preview?.tab_edit || 'Edit', icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>` });
        // History tab — shadow-git diff browser. Only when we have a backing file path.
        if (state.currentPath) {
            tabs.push({ mode: 'history', label: S.preview?.tab_history || 'History', icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>` });
        }

        viewToggle = `<div class="preview-view-toggle">${tabs.map(t =>
            `<button class="toggle-btn ${state.viewMode === t.mode ? 'active' : ''} ${t.mode === 'edit' && state.modified ? 'modified' : ''}" data-mode="${t.mode}">${t.icon} ${t.label}</button>`
        ).join('')}</div>`;
    }

    // Line range badge (shows when viewing specific lines) - clickable to scroll back
    let lineBadge = '';
    if (state.lineRange) {
        const { start, end } = state.lineRange;
        const count = end - start + 1;
        lineBadge = `
            <button class="preview-line-badge" data-scroll-line="${start}" data-tooltip="Scroll to highlighted lines">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M4 6h16M4 12h16M4 18h16"/>
                </svg>
                <span>Lines ${start}\u2013${end}</span>
                <span class="line-count">(${count} line${count > 1 ? 's' : ''})</span>
            </button>
        `;
    } else if (state.highlightLines?.length) {
        const line = state.highlightLines[0];
        lineBadge = `
            <button class="preview-line-badge" data-scroll-line="${line}" data-tooltip="Scroll to highlighted line">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M4 6h16M4 12h16M4 18h16"/>
                </svg>
                <span>Line ${line}</span>
            </button>
        `;
    }

    // Language selector (code + edit views)
    const effectiveLang = getEffectiveLanguage();
    const isOverridden = state.languageOverride !== null;
    const languageSelector = (!isHistoryMode() && (!state.plugin?.viewModes || state.viewMode === 'code' || state.viewMode === 'edit')) ? `
        <div class="preview-language-selector ${isOverridden ? 'overridden' : ''}">
            <select class="language-select" data-tooltip="Syntax highlighting language">
                ${AVAILABLE_LANGUAGES.map(l =>
                    `<option value="${l.value}" ${effectiveLang === l.value ? 'selected' : ''}>${l.label}</option>`
                ).join('')}
            </select>
            ${isOverridden ? `<button class="reset-language-btn" data-tooltip="Reset to auto-detected (${state.language})">×</button>` : ''}
        </div>
    ` : '';

    // Wrap toggle button (for code and edit views)
    const wrapToggle = (!isHistoryMode() && (!state.plugin?.viewModes || state.viewMode === 'code' || state.viewMode === 'edit')) ? `
        <button class="preview-wrap-toggle ${wrapLines ? 'active' : ''}" data-action="wrap" data-tooltip="${wrapLines ? 'Disable line wrap' : 'Enable line wrap'}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M3 6h18M3 12h15M3 18h18"/>
                <path d="M19 12v3a2 2 0 0 1-2 2h-2"/>
                <polyline points="13 15 15 17 13 19"/>
            </svg>
        </button>
    ` : '';

    // Search button (shown for text-based files; hidden in history view)
    const searchButton = (isEditable() && !isHistoryMode()) ? `
        <button class="preview-search-btn" data-action="search" data-tooltip="Search (Ctrl+F)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="11" cy="11" r="8"/>
                <line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
        </button>
    ` : '';

    // Download link button
    const downloadButton = state.currentPath ? downloadBtnHtml() : '';

    // Edit-mode search buttons — open the CodeMirror search panel (the code
    // view's own search bar doesn't exist in edit mode). Two entry points:
    // plain search, and search & replace (opens with the replace row expanded).
    const editorSearchButtons = isEditMode() ? `
        <button class="preview-search-btn" data-action="editor-search" data-tooltip="${S.preview?.editor_search || 'Search (Ctrl+F)'}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="11" cy="11" r="8"/>
                <line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
        </button>
        <button class="preview-search-btn" data-action="editor-replace" data-tooltip="${S.preview?.editor_replace || 'Search & replace'}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="10" cy="10" r="7"/>
                <line x1="21" y1="21" x2="15" y2="15"/>
                <path d="M7 10h4"/>
                <polyline points="9.5 7.5 12 10 9.5 12.5"/>
            </svg>
        </button>
    ` : '';

    // Search bar (shown when search is active)
    const searchBar = state.search.active ? `
        <div class="preview-search-bar">
            <input type="text" class="preview-search-input" placeholder="Search..." value="${escapeHtml(state.search.query)}" autofocus>
            <span class="preview-search-count">${state.search.matches.length > 0 ? `${state.search.currentIndex + 1} of ${state.search.matches.length}` : (state.search.query ? 'No results' : '')}</span>
            <button class="preview-search-nav" data-action="search-prev" data-tooltip="Previous (Shift+Enter)" ${state.search.matches.length === 0 ? 'disabled' : ''}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="18 15 12 9 6 15"/>
                </svg>
            </button>
            <button class="preview-search-nav" data-action="search-next" data-tooltip="Next (Enter)" ${state.search.matches.length === 0 ? 'disabled' : ''}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="6 9 12 15 18 9"/>
                </svg>
            </button>
            <button class="preview-search-close" data-action="search-close" data-tooltip="Close (Escape)">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <line x1="18" y1="6" x2="6" y2="18"/>
                    <line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
            </button>
        </div>
    ` : '';

    // Right-side toolbar controls depend on viewMode
    let rightControls = '';
    if (isEditMode() && state.isScratch) {
        // Scratch mode: language selector + Save As
        rightControls = `
            ${languageSelector}
            ${editorSearchButtons}
            ${wrapToggle}
            <span class="preview-modified-dot ${state.modified ? 'visible' : ''}" data-tooltip="Unsaved changes"></span>
            <button class="preview-edit-btn save-as-btn" data-action="save-as" data-tooltip="Save to file">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
                    <polyline points="17 21 17 13 7 13 7 21"/>
                    <polyline points="7 3 7 8 15 8"/>
                </svg>
                Save As
            </button>
        `;
    } else if (isEditMode()) {
        rightControls = `
            ${languageSelector}
            ${editorSearchButtons}
            ${wrapToggle}
            <span class="preview-modified-dot ${state.modified ? 'visible' : ''}" data-tooltip="Unsaved changes"></span>
            <button class="preview-edit-btn save-btn" data-action="edit-save" data-tooltip="Save (Ctrl+S)" ${state.saving ? 'disabled' : ''}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
                    <polyline points="17 21 17 13 7 13 7 21"/>
                    <polyline points="7 3 7 8 15 8"/>
                </svg>
                ${state.saving ? 'Saving...' : 'Save'}
            </button>
        `;
    } else {
        rightControls = `
            ${languageSelector}
            ${searchButton}
            ${downloadButton}
            ${wrapToggle}
        `;
    }

    // Unified toolbar: view tabs + right-side controls
    const hasToolbar = viewToggle || lineBadge || rightControls || state.search.active;
    const toolbar = hasToolbar ? `
        <div class="preview-toolbar">
            ${state.search.active ? searchBar : ''}
            ${!state.search.active ? viewToggle : ''}
            ${!state.search.active ? lineBadge : ''}
            <div class="toolbar-spacer"></div>
            ${!state.search.active ? rightControls : ''}
        </div>
    ` : '';

    // Edit view (CodeMirror editor)
    if (isEditMode()) {
        return `
            ${toolbar}
            <div class="preview-body preview-edit-body">
                <div class="preview-cm-container">
                    <div class="cm-loading">Loading editor...</div>
                </div>
            </div>
        `;
    }

    // History view (shadow-git diff browser)
    if (isHistoryMode()) {
        return `
            ${toolbar}
            ${renderHistoryBody()}
        `;
    }

    // Plugin custom view mode (e.g. markdown 'rendered', CSV 'table')
    // Plugin returns HTML for its custom mode, or null to fall through to code view
    if (state.plugin && state.viewMode !== 'code' && state.viewMode !== 'edit') {
        const pluginHtml = state.plugin.renderBody(state, pluginHelpers);
        if (pluginHtml !== null) {
            return `
                ${toolbar}
                ${pluginHtml}
            `;
        }
    }

    // Text/code content
    const hlLang = getHighlightLanguage(getEffectiveLanguage());
    const linesHtml = addLineNumbers(state.content || '', state.highlightLines, state.lineRange);
    const wrapClass = wrapLines ? ' wrap-lines' : '';

    return `
        ${toolbar}
        <div class="preview-body">
            <div class="preview-code-wrapper${wrapClass}">
                <pre class="preview-code" data-language="${hlLang}"><code class="language-${hlLang}">${linesHtml}</code></pre>
            </div>
        </div>
    `;
}

/**
 * Render body with a provided state object (for tab-specific rendering)
 */
export function renderBodyWithState(s) {
    if (s.isLoading) {
        return `
            <div class="preview-body">
                <div class="preview-loading">
                    <div class="loading-spinner"></div>
                    <span>Loading...</span>
                </div>
            </div>
        `;
    }

    if (s.error) {
        return `
            <div class="preview-body">
                <div class="preview-error">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="12" cy="12" r="10"/>
                        <line x1="15" y1="9" x2="9" y2="15"/>
                        <line x1="9" y1="9" x2="15" y2="15"/>
                    </svg>
                    <span>${escapeHtml(s.error)}</span>
                </div>
            </div>
        `;
    }

    if (!s.currentPath) {
        return emptyStateHtml();
    }

    // Plugin rendering
    if (s.plugin) {
        const pluginHtml = s.plugin.renderBody(s, pluginHelpers);
        if (pluginHtml !== null) return pluginHtml;
    }

    // Text/code content
    const hlLang = getHighlightLanguage(s.language || detectLanguage(s.currentPath));
    const linesHtml = addLineNumbers(s.content || '', s.highlightLines, s.lineRange);
    const wrapClass = s.wrapLines ? ' wrap-lines' : '';

    return `
        <div class="preview-body">
            <div class="preview-code-wrapper${wrapClass}">
                <pre class="preview-code" data-language="${hlLang}"><code class="language-${hlLang}">${linesHtml}</code></pre>
            </div>
        </div>
    `;
}

/**
 * Apply syntax highlighting to code content.
 *
 * Primary path: the SAME lezer parser + tagHighlighter the CodeMirror editor
 * uses (highlightCodeToLines from editor-view.js), so the Code view renders
 * identically to Edit mode — one engine, one palette (.tok-* classes in
 * 67-editor-view.css). Falls back to per-line hljs for languages without a
 * CM parser (makefile) and for oversized files. Async: the plain pre-render
 * from renderBody stays visible until the highlighted swap lands.
 */
export function highlightContent(container) {
    if (!state.content) return;
    if (!container.querySelector('.preview-code-wrapper')) return;

    const content = state.content;
    const language = getEffectiveLanguage();

    highlightCodeToLines(content, language).then(result => {
        // Supersede guards: content/language switched while highlighting, the
        // code wrapper re-rendered away, or a search is actively marking lines
        // (closeSearch triggers a fresh rerender + highlight pass anyway).
        const codeWrapper = container.querySelector('.preview-code-wrapper');
        if (!codeWrapper) return;
        if (state.content !== content || getEffectiveLanguage() !== language) return;
        if (codeWrapper.querySelector('.search-match')) return;

        if (result) {
            renderCodeLines(codeWrapper, result.lines, getHighlightLanguage(language), result.folds);
        } else {
            highlightContentHljs(codeWrapper, content, language);
        }
    });
}

/**
 * Fallback: per-line hljs highlighting (the pre-lezer engine). Kept for
 * languages the CM bundle has no parser for and for very large files.
 */
function highlightContentHljs(codeWrapper, content, language) {
    if (!window.hljs) return;
    const hlLang = getHighlightLanguage(language);
    const htmlLines = content.split('\n').map(line => {
        try {
            return window.hljs.highlight(line || ' ', { language: hlLang, ignoreIllegals: true }).value;
        } catch {
            return escapeHtml(line) || ' ';
        }
    });
    renderCodeLines(codeWrapper, htmlLines, hlLang);
}

/**
 * Rebuild the code DOM from pre-highlighted per-line HTML, reapplying
 * line-state classes (highlight ranges, flash) from state. `folds` (from the
 * lezer path) renders the same collapse arrows the editor's fold gutter
 * shows, in a fixed-width cell so Code and Edit line up pixel-for-pixel.
 */
function renderCodeLines(codeWrapper, htmlLines, langLabel, folds) {
    const highlightSet = new Set(state.highlightLines || []);
    const lineRange = state.lineRange;
    // Preserve an in-flight flash animation across the swap (scrollToLine may
    // have landed while we were highlighting)
    const flashed = new Set(
        [...codeWrapper.querySelectorAll('.preview-line.flash')].map(el => el.dataset.line)
    );
    const foldMap = new Map((folds || []).map(f => [f.start, f.end]));

    const rendered = htmlLines.map((lineHtml, i) => {
        const lineNum = i + 1;
        const classes = ['preview-line'];
        if (highlightSet.has(lineNum)) classes.push('highlighted');
        if (lineRange) {
            if (lineNum === lineRange.start) classes.push('range-start');
            if (lineNum === lineRange.end) classes.push('range-end');
        }
        if (flashed.has(String(lineNum))) classes.push('flash');
        const foldEnd = foldMap.get(lineNum);
        const foldCell = foldEnd
            ? `<span class="preview-fold" data-fold-end="${foldEnd}"></span>`
            : '<span class="preview-fold"></span>';
        return `<div class="${classes.join(' ')}" data-line="${lineNum}"><span class="line-number">${lineNum}</span>${foldCell}<span class="line-content">${lineHtml || ' '}</span></div>`;
    });

    codeWrapper.innerHTML = `<pre class="preview-code highlighted"><code class="language-${langLabel}">${rendered.join('')}</code></pre>`;

    // Fold arrow clicks — delegated; wrapper survives highlight swaps within
    // one body render, and re-renders re-run this whole function anyway.
    if (!codeWrapper._foldBound) {
        codeWrapper._foldBound = true;
        codeWrapper.addEventListener('click', handleFoldClick);
    }
}

/**
 * Toggle a fold region: hides/shows the lines inside the range, mirroring
 * the editor's fold gutter behavior. Expanding also resets any nested
 * collapsed folds inside the range.
 */
function handleFoldClick(e) {
    const btn = e.target.closest('.preview-fold[data-fold-end]');
    if (!btn) return;
    const lineEl = btn.closest('.preview-line');
    if (!lineEl) return;
    const end = parseInt(btn.dataset.foldEnd, 10);
    const collapsed = lineEl.classList.toggle('fold-collapsed');
    for (let el = lineEl.nextElementSibling; el; el = el.nextElementSibling) {
        const n = parseInt(el.dataset.line, 10);
        if (isNaN(n) || n > end) break;
        el.classList.toggle('fold-hidden', collapsed);
        if (!collapsed) el.classList.remove('fold-collapsed');
    }
}

/**
 * Scroll to a specific line
 * @param {Element} container - Widget container
 * @param {number} lineNum - Line number to scroll to
 * @param {object} options - Options
 * @param {boolean} options.flash - Add flash animation (default: true)
 * @param {string} options.position - 'center' or 'top' (default: 'center')
 */
export function scrollToLine(container, lineNum, options = {}) {
    const { flash = true, position = 'center' } = options;
    // Code/edit views: line-marked DOM. Rendered views (e.g. markdown):
    // map line → source byte offset → block tagged with data-source-start/end.
    const target = container.querySelector(`.preview-line[data-line="${lineNum}"]`)
        || findRenderedBlockForLine(container, lineNum);
    if (!target) return;

    const scrollContainer = container.querySelector('.preview-body');

    if (position === 'top' && scrollContainer) {
        const containerRect = scrollContainer.getBoundingClientRect();
        const lineRect = target.getBoundingClientRect();
        const currentScrollTop = scrollContainer.scrollTop;
        const lineOffset = lineRect.top - containerRect.top + currentScrollTop;
        scrollContainer.scrollTop = lineOffset;
    } else {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    if (flash) {
        target.classList.add('flash');
        setTimeout(() => target.classList.remove('flash'), 1500);
    }
}

function findRenderedBlockForLine(container, lineNum) {
    const rendered = container.querySelector('.preview-rendered');
    if (!rendered) return null;

    const content = state.content || '';
    let offset = 0;
    let line = 1;
    while (line < lineNum && offset < content.length) {
        const nl = content.indexOf('\n', offset);
        if (nl === -1) break;
        offset = nl + 1;
        line++;
    }

    let best = null;
    let bestStart = -1;
    for (const el of rendered.querySelectorAll('[data-source-start]')) {
        const start = parseInt(el.getAttribute('data-source-start'), 10);
        const end = parseInt(el.getAttribute('data-source-end'), 10);
        if (offset >= start && offset <= end) return el;
        if (start <= offset && start > bestStart) {
            best = el;
            bestStart = start;
        }
    }
    return best;
}
