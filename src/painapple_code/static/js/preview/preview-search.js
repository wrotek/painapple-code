/**
 * Preview search functionality
 *
 * Search within file preview content, including code view and rendered markdown.
 * Also handles rerenderContent — the central rerender function.
 */

import { state, isEditMode, isEditable, fns, recallScroll } from './preview-state.js';
import { escapeHtml } from '../utils.js';
import { WidgetManager } from '../widget-system/index.js';
import { resetDeleteSession } from './preview-inline-edit.js';
import { debug } from '../config.js';

/**
 * Re-render the file preview content (works in widget or tab mode)
 * Preserves scroll position across re-renders
 */
export function rerenderContent() {
    debug.log('[FilePreview] rerenderContent called, state:', {
        isLoading: state.isLoading,
        hasContent: !!state.content,
        error: state.error,
        currentPath: state.currentPath
    });

    // A full re-render wipes any in-DOM inline-edit placeholders, so the
    // tracker for pending deletes is no longer meaningful.
    resetDeleteSession();

    // Save scroll position before re-render (scoped to THIS instance's
    // container — multiple session tabs each keep their own hidden
    // .file-preview-widget in the DOM, so a global query can hit the wrong one)
    const existingContent = fns.findPreviewContainer()?.querySelector('.preview-body');
    const scrollTop = existingContent ? existingContent.scrollTop : 0;
    // When there's nothing to preserve (scrollTop 0 — the file was just fetched
    // into a fresh loading shell), fall back to this file's remembered position.
    // The live position always wins: a silent poll reload must not teleport the
    // user away from where they're currently reading.
    const remembered = scrollTop ? 0 : (recallScroll(state.currentPath, state.viewMode) || 0);

    // IMPORTANT: Check floating widget FIRST
    if (WidgetManager.isOpen('file-preview')) {
        debug.log('[FilePreview] rerenderContent: floating widget mode');
        WidgetManager.update('file-preview');
        requestAnimationFrame(() => {
            const newContent = fns.findPreviewContainer()?.querySelector('.preview-body');
            if (newContent && scrollTop) newContent.scrollTop = scrollTop;
        });
        return;
    }

    // Check if the file preview is in a TAB
    const tabContainer = document.querySelector('.widget-tab-content .file-preview-widget');
    debug.log('[FilePreview] Tab container found:', !!tabContainer);

    if (tabContainer) {
        debug.log('[FilePreview] rerenderContent: tab mode, updating innerHTML');
        tabContainer.innerHTML = fns.renderBody();
        fns.setupEventHandlers(tabContainer);

        if (state.content && !state.plugin && window.hljs) {
            fns.highlightContent(tabContainer);
        }

        // Defer scroll to after layout (same pattern as floating widget path)
        const pendingScrollToLine = state.scrollToLine;
        const pendingScrollOptions = state.scrollOptions;
        if (pendingScrollToLine) {
            state.scrollToLine = null;
            state.scrollOptions = null;
        }
        // Double-rAF: first for layout, second to ensure scroll target has correct dimensions
        requestAnimationFrame(() => requestAnimationFrame(() => {
            const newContent = tabContainer.querySelector('.preview-body');
            if (!newContent) return;
            if (pendingScrollToLine && state.content && !state.isLoading) {
                fns.scrollToLine(tabContainer, pendingScrollToLine, pendingScrollOptions || {});
            } else if (scrollTop || remembered) {
                newContent.scrollTop = scrollTop || remembered;
            }
        }));
        return;
    }

    // Fallback: find any .file-preview-widget container
    const container = document.querySelector('.file-preview-widget');
    if (container) {
        debug.log('[FilePreview] rerenderContent: fallback mode');
        container.innerHTML = fns.renderBody();
        fns.setupEventHandlers(container);

        if (state.content && !state.plugin && window.hljs) {
            fns.highlightContent(container);
        }

        const newContent = container.querySelector('.preview-body');
        if (newContent && (scrollTop || remembered)) newContent.scrollTop = scrollTop || remembered;
    }
}

/**
 * Open search bar
 */
export function openSearch() {
    debug.log('[FilePreview Search] openSearch called, plugin:', state.plugin?.id, 'viewMode:', state.viewMode);
    if (!isEditable()) return; // No search for non-editable types (images, diagrams, charts)
    // In edit mode, delegate to CodeMirror's built-in search (Ctrl+F)
    if (isEditMode() && state.editor) {
        state.editor.openSearch?.();
        return;
    }
    // JSON tree has its own search input — focus it instead of showing the generic bar.
    if (state.plugin?.id === 'json' && state.viewMode === 'tree') {
        const input = fns.findPreviewContainer()?.querySelector('.json-search-input');
        if (input) {
            input.focus();
            input.select();
            return;
        }
    }
    // Already open → re-focus the live query instead of blanking it. The search
    // button stays visible in the toolbar while the bar is open, and Ctrl+F is
    // a reflex, so the reset below would otherwise throw away a query mid-hunt.
    if (state.search.active) {
        const input = fns.findPreviewContainer()?.querySelector('.preview-search-input');
        if (input) {
            input.focus();
            input.select();
            return;
        }
    }
    state.search.active = true;
    state.search.query = '';
    state.search.matches = [];
    state.search.currentIndex = -1;
    rerenderContent();
}

/**
 * Close search bar and clear highlights
 */
export function closeSearch() {
    state.search.active = false;
    state.search.query = '';
    state.search.matches = [];
    state.search.currentIndex = -1;
    clearSearchHighlights();
    rerenderContent();
}

/**
 * Perform search on current content
 */
export function performSearch(query) {
    state.search.query = query;
    state.search.matches = [];
    state.search.currentIndex = -1;

    clearSearchHighlights();

    if (!query.trim()) {
        updateSearchCount();
        return;
    }

    // Scope to THIS instance's container — with per-session/per-tab preview
    // widgets, other (hidden) .file-preview-widget nodes coexist in the DOM
    // and a global querySelector would search the wrong file's content.
    const container = fns.findPreviewContainer();
    if (!container) {
        console.warn('[FilePreview Search] Container not found');
        return;
    }

    const lowerQuery = query.toLowerCase();

    debug.log('[FilePreview Search] Searching for:', query, 'viewMode:', state.viewMode);

    // Search in code view
    const lines = container.querySelectorAll('.preview-line');
    debug.log('[FilePreview Search] Found', lines.length, 'code lines');
    lines.forEach((line) => {
        const lineContent = line.querySelector('.line-content');
        if (!lineContent) return;

        const text = lineContent.textContent || '';
        const lowerText = text.toLowerCase();
        let index = lowerText.indexOf(lowerQuery);

        if (index === -1) return;

        const lineNum = parseInt(line.dataset.line, 10);

        let lastIndex = 0;
        const parts = [];

        while (index !== -1) {
            if (index > lastIndex) {
                parts.push(escapeHtml(text.slice(lastIndex, index)));
            }

            const matchIndex = state.search.matches.length;
            parts.push(`<span class="search-match" data-match-index="${matchIndex}">${escapeHtml(text.slice(index, index + query.length))}</span>`);

            state.search.matches.push({
                lineNum,
                index: matchIndex,
                lineElement: line
            });

            lastIndex = index + query.length;
            index = lowerText.indexOf(lowerQuery, lastIndex);
        }

        if (lastIndex < text.length) {
            parts.push(escapeHtml(text.slice(lastIndex)));
        }

        lineContent.innerHTML = parts.join('');
    });

    // Also search in rendered markdown
    const rendered = container.querySelector('.preview-rendered');
    debug.log('[FilePreview Search] Found .preview-rendered:', !!rendered);
    if (rendered) {
        highlightInElement(rendered, query);
    }

    debug.log('[FilePreview Search] Total matches found:', state.search.matches.length);

    // Navigate to first match
    if (state.search.matches.length > 0) {
        state.search.currentIndex = 0;
        highlightCurrentMatch();
    }

    updateSearchCount();
}

/**
 * Navigate to next/previous match
 */
export function navigateSearch(direction) {
    if (state.search.matches.length === 0) return;

    state.search.currentIndex += direction;

    // Wrap around
    if (state.search.currentIndex >= state.search.matches.length) {
        state.search.currentIndex = 0;
    } else if (state.search.currentIndex < 0) {
        state.search.currentIndex = state.search.matches.length - 1;
    }

    highlightCurrentMatch();
    updateSearchCount();
}

// ─── Internal helpers ────────────────────────────────────────────────────

/**
 * Highlight matches in an element (for rendered markdown)
 */
function highlightInElement(element, query) {
    const walker = document.createTreeWalker(
        element,
        NodeFilter.SHOW_TEXT,
        null,
        false
    );

    const textNodes = [];
    while (walker.nextNode()) {
        textNodes.push(walker.currentNode);
    }

    debug.log('[FilePreview Search] highlightInElement: found', textNodes.length, 'text nodes');

    const lowerQuery = query.toLowerCase();
    let matchesInElement = 0;

    textNodes.forEach(node => {
        const text = node.textContent;
        const lowerText = text.toLowerCase();
        let index = lowerText.indexOf(lowerQuery);

        if (index === -1) return;

        const fragment = document.createDocumentFragment();
        let lastIndex = 0;

        while (index !== -1) {
            if (index > lastIndex) {
                fragment.appendChild(document.createTextNode(text.slice(lastIndex, index)));
            }

            const span = document.createElement('span');
            span.className = 'search-match';
            span.dataset.matchIndex = state.search.matches.length;
            span.textContent = text.slice(index, index + query.length);
            fragment.appendChild(span);

            state.search.matches.push({
                lineNum: -1,
                index: state.search.matches.length,
                element: span
            });

            lastIndex = index + query.length;
            index = lowerText.indexOf(lowerQuery, lastIndex);
        }

        if (lastIndex < text.length) {
            fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
        }

        node.parentNode.replaceChild(fragment, node);
        matchesInElement++;
    });

    debug.log('[FilePreview Search] highlightInElement: found', matchesInElement, 'nodes with matches');
}

/**
 * Clear all search highlights
 */
function clearSearchHighlights() {
    const container = fns.findPreviewContainer();
    if (!container) return;

    // Clear highlights in code view - restore original text
    const lines = container.querySelectorAll('.preview-line');
    lines.forEach(line => {
        const lineContent = line.querySelector('.line-content');
        if (!lineContent) return;

        const matches = lineContent.querySelectorAll('.search-match');
        if (matches.length === 0) return;

        const text = lineContent.textContent;
        lineContent.textContent = text;
    });

    // Clear highlights in rendered markdown
    const rendered = container.querySelector('.preview-rendered');
    if (rendered) {
        const highlights = rendered.querySelectorAll('.search-match');
        highlights.forEach(span => {
            const text = document.createTextNode(span.textContent);
            span.parentNode.replaceChild(text, span);
        });
        rendered.normalize();
    }
}

/**
 * Highlight and scroll to current match
 */
function highlightCurrentMatch() {
    const container = fns.findPreviewContainer();
    if (!container) return;

    container.querySelectorAll('.search-match.current').forEach(el => {
        el.classList.remove('current');
    });

    const match = state.search.matches[state.search.currentIndex];
    if (!match) return;

    const matchEl = container.querySelector(`.search-match[data-match-index="${match.index}"]`);
    if (!matchEl) return;
    matchEl.classList.add('current');

    // iOS WKWebView ignores scrollIntoView({block:'center'}) on overflow:auto
    // containers (rendered-markdown shows "N of M" but never scrolls). Compute
    // scrollTop against .preview-body directly — the same manual approach used
    // by scrollToLine — so the match centers on every platform.
    const scrollContainer = container.querySelector('.preview-body');
    if (!scrollContainer) {
        matchEl.scrollIntoView({ block: 'center' });
        return;
    }
    const containerRect = scrollContainer.getBoundingClientRect();
    const matchRect = matchEl.getBoundingClientRect();
    const matchOffset = matchRect.top - containerRect.top + scrollContainer.scrollTop;
    const centered = matchOffset - scrollContainer.clientHeight / 2 + matchRect.height / 2;
    scrollContainer.scrollTop = Math.max(0, centered);
}

/**
 * Update the search count display
 */
function updateSearchCount() {
    const container = fns.findPreviewContainer();
    if (!container) return;
    const countEl = container.querySelector('.preview-search-count');
    if (!countEl) return;

    if (state.search.matches.length === 0 && state.search.query.trim()) {
        countEl.textContent = 'No results';
        countEl.classList.add('no-results');
    } else if (state.search.matches.length > 0) {
        countEl.textContent = `${state.search.currentIndex + 1} of ${state.search.matches.length}`;
        countEl.classList.remove('no-results');
    } else {
        countEl.textContent = '';
        countEl.classList.remove('no-results');
    }

    const prevBtn = container.querySelector('.preview-search-nav[data-action="search-prev"]');
    const nextBtn = container.querySelector('.preview-search-nav[data-action="search-next"]');
    if (prevBtn) prevBtn.disabled = state.search.matches.length === 0;
    if (nextBtn) nextBtn.disabled = state.search.matches.length === 0;
}
