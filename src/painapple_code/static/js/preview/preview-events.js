/**
 * Preview event handlers
 *
 * Sets up DOM event listeners for the preview widget.
 */

import { state, isEditMode, isHistoryMode, isEditable, fns, pluginHelpers, rememberScroll } from './preview-state.js';
import { WidgetManager } from '../widget-system/index.js';
import { registerSelectionContainer, updateStashIndicators } from '../selection/selection-handler.js';
import { isSelectionInPreviewEnabled } from '../widgets/config-widget.js';
import { isInlineEditActive } from './preview-inline-edit.js';
import { wireHistoryEvents } from './preview-history.js';
import { debug } from '../config.js';

export function setupEventHandlers(container) {
    // Plugin event handlers (panzoom, dark toggle, custom interactivity, etc.)
    if (state.plugin?.setupEvents) {
        state.plugin.setupEvents(container, state, pluginHelpers);
    }

    // Wrap toggle button
    const wrapBtn = container.querySelector('.preview-wrap-toggle');
    if (wrapBtn) {
        wrapBtn.addEventListener('click', () => fns.toggleWrapLines());
    }

    // Search button (code view — DOM-based search bar)
    const searchBtn = container.querySelector('.preview-search-btn[data-action="search"]');
    if (searchBtn) {
        searchBtn.addEventListener('click', () => fns.openSearch());
    }

    // Edit-mode search buttons — open the CodeMirror search panel; the
    // replace variant expands + focuses the replace row.
    container.querySelectorAll('[data-action="editor-search"], [data-action="editor-replace"]').forEach(btn => {
        btn.addEventListener('click', () => {
            state.editor?.openSearch?.({ replace: btn.dataset.action === 'editor-replace' });
        });
    });

    // Empty-state "Open a file…" — the way in when the preview was summoned
    // with nothing to show. Routed through fns so this module stays free of
    // the OpenDialog import.
    const openFileBtn = container.querySelector('[data-action="open-file"]');
    if (openFileBtn) {
        openFileBtn.addEventListener('click', () => fns.openFileDialog());
    }

    // Download link button
    const downloadBtn = container.querySelector('.preview-download-btn');
    if (downloadBtn) {
        downloadBtn.addEventListener('click', () => fns.handleDownload());
    }

    // Search bar events
    const searchInput = container.querySelector('.preview-search-input');
    debug.log('[FilePreview Search] Setting up search input handler, found:', !!searchInput);
    if (searchInput) {
        // Focus input when search opens
        setTimeout(() => searchInput.focus(), 0);

        // Debounced search on input
        let debounceTimer = null;
        searchInput.addEventListener('input', (e) => {
            debug.log('[FilePreview Search] Input event, value:', e.target.value);
            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                fns.performSearch(e.target.value);
            }, 150);
        });

        // Keyboard navigation
        searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                fns.navigateSearch(e.shiftKey ? -1 : 1);
            } else if (e.key === 'Escape') {
                e.preventDefault();
                fns.closeSearch();
            }
        });
    }

    // Search nav buttons
    container.querySelectorAll('.preview-search-nav').forEach(btn => {
        btn.addEventListener('click', () => {
            const action = btn.dataset.action;
            if (action === 'search-prev') fns.navigateSearch(-1);
            if (action === 'search-next') fns.navigateSearch(1);
        });
    });

    // Search close button
    const searchCloseBtn = container.querySelector('.preview-search-close');
    if (searchCloseBtn) {
        searchCloseBtn.addEventListener('click', () => fns.closeSearch());
    }

    // Line badge click - scroll to highlighted lines
    const lineBadge = container.querySelector('.preview-line-badge[data-scroll-line]');
    if (lineBadge) {
        lineBadge.addEventListener('click', () => {
            const lineNum = parseInt(lineBadge.dataset.scrollLine, 10);
            if (lineNum) {
                fns.scrollToLine(container, lineNum, { flash: true, position: 'center' });
            }
        });
    }

    // Edit mode Save button
    container.querySelectorAll('[data-action="edit-save"]').forEach(btn => {
        btn.addEventListener('click', () => fns.saveFile());
    });

    // Scratch Save As button
    container.querySelectorAll('[data-action="save-as"]').forEach(btn => {
        btn.addEventListener('click', () => fns.saveAsFile());
    });

    // View toggle tab clicks (Code / Rendered / Edit)
    container.querySelectorAll('.preview-view-toggle .toggle-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const mode = btn.dataset.mode;
            if (!mode || mode === state.viewMode) return;

            if (mode === 'edit') {
                await fns.switchToEditView();
            } else if (isEditMode()) {
                fns.leaveEditView(mode);
            } else {
                state.viewMode = mode;
                // Use rerenderContent (tab-aware) — WidgetManager.update would
                // auto-create + render the floating widget and call
                // activateState(null), swapping the state pointer away from the
                // active tab and breaking the next click's viewMode guard.
                fns.rerenderContent();
            }
        });
    });

    // Ctrl+S to save, Ctrl+E to toggle edit (only when NOT editing), Escape to leave edit
    container.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 's' && isEditMode()) {
            e.preventDefault();
            if (state.isScratch) {
                fns.saveAsFile();
            } else {
                fns.saveFile();
            }
        }
        // Ctrl+E: only enter edit mode from code/preview view.
        // In edit mode or inline edit, let Ctrl+E pass through for end-of-line (iPadOS/Emacs).
        if ((e.ctrlKey || e.metaKey) && e.key === 'e' && !isEditMode() && !isInlineEditActive(container)) {
            if (isEditable()) {
                e.preventDefault();
                fns.switchToEditView();
            }
        }
        // Escape in edit mode: leave edit, return to code view
        // Skip if CM search panel is open (let CM close it first)
        if (e.key === 'Escape' && isEditMode()) {
            const cmSearch = container.querySelector('.cm-panel, .cm-search');
            if (!cmSearch) {
                e.preventDefault();
                e.stopPropagation();
                fns.leaveEditView('code');
            }
        }
    });

    // Language selector
    const langSelect = container.querySelector('.language-select');
    if (langSelect) {
        langSelect.addEventListener('change', (e) => {
            const newLang = e.target.value;
            if (newLang === state.language) {
                state.languageOverride = null;
            } else {
                state.languageOverride = newLang;
            }

            // For scratch mode: recreate CodeMirror with new language + persist
            if (state.isScratch) {
                state.language = newLang;
                state.languageOverride = null;
                if (state.editor) {
                    state.editBuffer = state.editor.getContent();
                    state.editor.destroy();
                    state.editor = null;
                    state.viewMode = 'code'; // Allow switchToEditView to run
                    fns.switchToEditView();
                }
                if (state.scratchId) {
                    try {
                        const raw = localStorage.getItem(`claude-scratch-${state.scratchId}`);
                        const saved = raw ? JSON.parse(raw) : {};
                        saved.language = newLang;
                        localStorage.setItem(`claude-scratch-${state.scratchId}`, JSON.stringify(saved));
                    } catch (e2) { /* ignore */ }
                }
                return;
            }

            // File edit mode: recreate CodeMirror with the new language,
            // preserving the (possibly modified) buffer.
            if (isEditMode()) {
                recreateEditorWithLanguage();
                return;
            }

            WidgetManager.update('file-preview');
        });
    }

    // Reset language button
    const resetLangBtn = container.querySelector('.reset-language-btn');
    if (resetLangBtn) {
        resetLangBtn.addEventListener('click', () => {
            state.languageOverride = null;
            if (!state.isScratch && isEditMode()) {
                recreateEditorWithLanguage();
                return;
            }
            WidgetManager.update('file-preview');
        });
    }

    // Track scroll position so reopening this file lands where the user left it.
    //
    // A live listener rather than a read at close time: by the time onClose()
    // fires the body can already be display:none, and scrollTop of a hidden
    // element reads 0 — the same trap chat-controller works around with its
    // onBeforeEvict capture. Recording as it happens sidesteps it entirely.
    //
    // path/viewMode are captured HERE, not read off `state` inside the handler:
    // the module-level `state` is a swappable pointer (session change, tab
    // activation), and a late scroll event must not write into whichever state
    // happens to be active by then. Every path/viewMode change re-renders and
    // re-runs this setup, so the captured pair is always current for this DOM.
    const scrollBody = container.querySelector('.preview-body');
    if (scrollBody && !state.isScratch && state.currentPath && !isEditMode()) {
        const scrollState = state;
        const scrollPath = state.currentPath;
        const scrollViewMode = state.viewMode;
        scrollBody.addEventListener('scroll', () => {
            rememberScroll(scrollPath, scrollViewMode, scrollBody.scrollTop, scrollState);
        }, { passive: true });
    }

    // History view: wire stepper / picker / mode-toggle
    if (isHistoryMode()) {
        wireHistoryEvents(container);
    }

    // Register text selection for comments (rendered markdown view)
    setupTextSelection(container);
}

/**
 * Tear down and relaunch the CM editor so a language change applies —
 * the buffer (with any unsaved edits) carries over via editBuffer.
 */
function recreateEditorWithLanguage() {
    if (state.editor) {
        state.editBuffer = state.editor.getContent();
        state.editor.destroy();
        state.editor = null;
    }
    state.viewMode = 'code';  // let switchToEditView's guard pass
    fns.switchToEditView();
}

/**
 * Setup text selection handler for rendered markdown
 */
export function setupTextSelection(container) {
    window.debugLog?.('FilePreview', 'setupTextSelection called');

    const renderedEl = container.querySelector('.preview-rendered');
    if (!renderedEl) {
        window.debugLog?.('FilePreview', 'No .preview-rendered element found');
        return;
    }

    // The tap-to-comment bubbles always render in the markdown preview, so the
    // stash wiring that makes them functional must run regardless of the
    // "selection in preview" setting:
    //   1. Stamp the displayed file path so the stash indicator pass
    //      (selection-handler updateStashIndicators) can match file-type items
    //      to this rendered view without reaching into preview state.
    //   2. Refresh the purple has-stash markers now, so a commented block
    //      carries its stashId and re-clicking its bubble reopens the existing
    //      note instead of an empty form.
    // The setting only gates native drag-to-select (container registration).
    if (state.currentPath) {
        renderedEl.dataset.filePath = state.currentPath;
    }
    updateStashIndicators();

    if (!isSelectionInPreviewEnabled()) {
        window.debugLog?.('FilePreview', 'Drag-to-select in preview disabled by config (bubbles still active)');
        return;
    }

    window.debugLog?.('FilePreview', 'Found .preview-rendered, registering with selection handler');

    registerSelectionContainer('file-preview-rendered', renderedEl, {
        buildAnchor: (range, text) => {
            window.debugLog?.('FilePreview', 'buildAnchor called', { text: text?.slice?.(0, 50) || text });
            const anchor = {
                type: 'file',
                filePath: state.currentPath,
                selectedText: text
            };
            const lines = sourceLinesForRange(range);
            if (lines) {
                anchor.startLine = lines.start;
                anchor.endLine = lines.end;
            }
            return anchor;
        }
    });
}

/**
 * Derive source line numbers for a selection range in the rendered view.
 * Rendered blocks carry data-source-start/end — character offsets into the
 * full file content (renderWithSourceMap shifts past front matter). Walk up
 * from the range endpoints to the nearest mapped blocks and count newlines.
 * Returns { start, end } (1-based, inclusive) or null when unmapped.
 */
function sourceLinesForRange(range) {
    const content = state.content;
    if (!content || !range) return null;

    const toElement = (node) => node?.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    const startBlock = toElement(range.startContainer)?.closest?.('[data-source-start]');
    const endBlock = toElement(range.endContainer)?.closest?.('[data-source-start]') || startBlock;
    if (!startBlock) return null;

    const startOffset = parseInt(startBlock.getAttribute('data-source-start'), 10);
    const endOffset = parseInt(endBlock.getAttribute('data-source-end'), 10);
    if (isNaN(startOffset) || isNaN(endOffset)) return null;

    const lineAt = (offset) => {
        let line = 1;
        const max = Math.min(offset, content.length);
        for (let i = 0; i < max; i++) {
            if (content.charCodeAt(i) === 10) line++;
        }
        return line;
    };

    // data-source-end includes the block's trailing newline(s) — step back to
    // the last content character so endLine doesn't spill onto the next line.
    let lastChar = Math.min(endOffset, content.length) - 1;
    while (lastChar > startOffset && content[lastChar] === '\n') lastChar--;

    const start = lineAt(startOffset);
    return { start, end: Math.max(lineAt(lastChar), start) };
}
