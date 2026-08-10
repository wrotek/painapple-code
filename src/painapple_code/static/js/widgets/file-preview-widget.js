/**
 * FilePreviewWidget - File preview and editor
 *
 * Orchestrator: imports modules, wires cross-module deps, registers widget, exposes public API.
 *
 * Entry points:
 * - File explorer, chat file links, search results
 * - Tool output "Open in editor" buttons
 */

import { WidgetManager, WidgetBus } from '../widget-system/index.js';
import { OpenDialog } from '../open-dialog.js';
import { detectLanguage } from '../file-tabs.js';
import { fileDownloadAction } from '../context-menu.js';
import { findPlugin } from '../preview-plugins/index.js';

// Preview modules
import {
    state, activateState, removeTabState, removeSessionState,
    isEditMode, isEditable, pluginHelpers,
    wrapLines, setWrapLines, WRAP_STORAGE_KEY, PATH_STORAGE_KEY,
    rememberLastPath, getLastPath, recallScroll, forgetScroll,
    fns
} from '../preview/preview-state.js';
import {
    getRelativePath, fetchFile, showToast,
    DEFAULT_WIDTH, DEFAULT_HEIGHT, loadSavedSize, saveSize, resetSize
} from '../preview/preview-utils.js';
import { startPolling, stopPolling } from '../preview/preview-poll.js';
import { renderPreview, renderBody, highlightContent, scrollToLine } from '../preview/preview-render.js';
import { rerenderContent, openSearch, closeSearch, performSearch, navigateSearch } from '../preview/preview-search.js';
import { switchToEditView, leaveEditView, discardEdits, saveFile, saveAsFile } from '../preview/preview-edit.js';
import { setupEventHandlers } from '../preview/preview-events.js';
import { renderBreadcrumb, closeMenu as closeBreadcrumbMenu } from '../preview/preview-breadcrumb.js';
import S from '../strings.js';
import { appConfirm } from '../utils.js';
import { debug } from '../config.js';
import { basename } from '../path-utils.js';

// ═══════════════════════════════════════════════════════════════════════════
// MODULE SETUP
// ═══════════════════════════════════════════════════════════════════════════

let widget = null;
const MODULE_ID = Math.random().toString(36).substr(2, 6);
debug.log('[FilePreviewWidget] Module loaded, ID:', MODULE_ID);

// ═══════════════════════════════════════════════════════════════════════════
// ORCHESTRATOR-ONLY FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

function updateWidgetHeader() {
    // Walk from the per-session content container to the outer widget div.
    // Using getElementById('widget-file-preview') would miss session-scoped
    // widgets, whose DOM IDs are widget-file-preview-${sessionId}.
    const widgetEl = state.container?.closest('.widget');
    if (!widgetEl) return;

    const titleEl = widgetEl.querySelector('.widget-title');
    if (!titleEl) return;

    if (state.currentPath && !state.isScratch) {
        // Interactive breadcrumb — click a segment to browse siblings / switch files.
        renderBreadcrumb(titleEl);
        titleEl.setAttribute('data-tooltip', state.currentPath);
    } else {
        closeBreadcrumbMenu();
        titleEl.classList.remove('has-breadcrumb');
        titleEl.textContent = '';
        titleEl.removeAttribute('data-tooltip');
    }
}

async function copyPath() {
    if (!state.currentPath) return;
    try {
        await navigator.clipboard.writeText(state.currentPath);
        showToast(S.toast.path_copied);
    } catch (e) {
        console.error('Failed to copy path:', e);
    }
}

async function copyContent() {
    if (!state.content) return;
    try {
        await navigator.clipboard.writeText(state.content);
        showToast(S.toast.content_copied);
    } catch (e) {
        console.error('Failed to copy content:', e);
    }
}

async function handleDownload() {
    if (!state.currentPath) return;
    await fileDownloadAction(state.currentPath);
}

async function revealInFolder() {
    if (!state.currentPath) return;
    const explorer = window.FileExplorerWidget;
    if (!explorer?.revealFile) {
        showToast(S.toast.reveal_failed.replace('{error}', 'File Explorer not available'));
        return;
    }
    await explorer.revealFile(state.currentPath);
}

/**
 * Find the active preview widget container (floating, tab, or fallback)
 */
function findPreviewContainer() {
    // Per-instance: use state's stored container reference
    if (state.container) {
        return state.container.querySelector('.file-preview-widget') || state.container;
    }
    // Floating/bottom-sheet/sidebar
    if (WidgetManager.isOpen('file-preview')) {
        return document.querySelector('.widget[data-widget-id="file-preview"] .file-preview-widget');
    }
    // Tab mode or fallback
    return document.querySelector('.widget-tab-content .file-preview-widget')
        || document.querySelector('.file-preview-widget');
}

function openPreviewAsTab({ background } = {}) {
    const currentPath = state.currentPath;
    WidgetBus.emit('widget:open-as-tab', {
        widgetId: 'file-preview',
        title: state.currentPath ? getRelativePath(state.currentPath, state.cwd) : 'File Preview',
        icon: 'file',
        filePath: currentPath,
        background
    });
}

function toggleViewMode() {
    if (!state.plugin?.viewModes?.length) return;
    const customMode = state.plugin.viewModes[0].mode;
    state.viewMode = state.viewMode === 'code' ? customMode : 'code';
    WidgetManager.update('file-preview');
}

function toggleWrapLines() {
    const container = document.querySelector('.file-preview-widget');
    const scrollContainer = container?.querySelector('.preview-body');
    let visibleLine = null;

    if (scrollContainer) {
        const scrollTop = scrollContainer.scrollTop;
        const lineRows = scrollContainer.querySelectorAll('.preview-line');

        for (const row of lineRows) {
            const rowTop = row.getBoundingClientRect().top - scrollContainer.getBoundingClientRect().top + scrollTop;
            if (rowTop + row.offsetHeight > scrollTop) {
                visibleLine = parseInt(row.dataset.line, 10);
                break;
            }
        }
    }

    setWrapLines(!wrapLines);
    try {
        localStorage.setItem(WRAP_STORAGE_KEY, wrapLines ? 'true' : 'false');
    } catch (e) { /* ignore */ }

    // Live-reconfigure CodeMirror in edit mode (preserves cursor + unsaved buffer)
    if (isEditMode() && state.editor?.setLineWrapping) {
        state.editor.setLineWrapping(wrapLines);
        // Update only the toggle button's visual state — avoid full re-render
        const wrapBtn = container?.querySelector('.preview-wrap-toggle');
        if (wrapBtn) {
            wrapBtn.classList.toggle('active', wrapLines);
            wrapBtn.setAttribute('data-tooltip', wrapLines ? 'Disable line wrap' : 'Enable line wrap');
        }
        return;
    }

    if (visibleLine) {
        state.scrollToLine = visibleLine;
        state.scrollOptions = { flash: false, position: 'top' };
    }

    WidgetManager.update('file-preview');
}

/**
 * Empty-state "Open a file…" action — deliberately the same picker as Cmd+O
 * rather than the file explorer, so there's one way to reach for a file by
 * name. Opening a file from it routes back through previewFile().
 */
function openFileDialog() {
    OpenDialog.show();
}

function closeWidget() {
    try {
        localStorage.removeItem(PATH_STORAGE_KEY);
    } catch (e) { /* ignore */ }
    WidgetManager.close('file-preview');
}

// ═══════════════════════════════════════════════════════════════════════════
// WIRE CROSS-MODULE DEPENDENCIES
// ═══════════════════════════════════════════════════════════════════════════

Object.assign(fns, {
    // From preview-render.js
    renderBody, renderPreview, highlightContent, scrollToLine,
    // From preview-search.js
    rerenderContent, openSearch, closeSearch, performSearch, navigateSearch,
    // From preview-edit.js
    switchToEditView, leaveEditView, discardEdits, saveFile, saveAsFile,
    // From preview-events.js
    setupEventHandlers,
    // Orchestrator-only
    toggleWrapLines, openPreviewAsTab, handleDownload,
    findPreviewContainer, closeWidget, openFileDialog,
    // Breadcrumb fallback when window.app.previewFile is unavailable
    openPreviewPath: (p) => FilePreviewWidget.preview(p),
    pluginHelpers,
});

// ═══════════════════════════════════════════════════════════════════════════
// WIDGET REGISTRATION
// ═══════════════════════════════════════════════════════════════════════════

export function registerFilePreviewWidget() {
    debug.log('[FilePreviewWidget] registerFilePreviewWidget() called, MODULE_ID:', MODULE_ID);
    const savedSize = loadSavedSize();

    const ICONS = {
        copyPath: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
        </svg>`,
        copyContent: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
        </svg>`,
        edit: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 20h9"/>
            <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
        </svg>`,
        download: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="7 10 12 15 17 10"/>
            <line x1="12" y1="15" x2="12" y2="3"/>
        </svg>`,
        revealInFolder: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
            <circle cx="12" cy="14" r="2.5"/>
        </svg>`
    };

    widget = WidgetManager.register('file-preview', {
        title: '',
        icon: 'file',
        type: 'floating',
        hiddenInPicker: true,
        closeable: true,
        resizable: true,
        minSize: { width: 400, height: 300 },
        size: { width: savedSize.width, height: savedSize.height },
        // Explicit position rather than the top-right default: the file
        // explorer itself spawns top-right and preview is nearly always
        // opened from it, so offsetting left keeps both readable at once.
        // User-dragged position still persists.
        position: { x: 460, y: 80 },

        deviceTypes: {
            phone: 'bottom-sheet',
            tablet: 'bottom-sheet',
            desktop: 'floating'
        },

        allowedTypes: ['floating', 'bottom-sheet', 'sidebar-right', 'tab'],

        onOpenAsTab: openPreviewAsTab,

        headerActions: [
            { icon: ICONS.copyPath, title: S.widgets.header_actions.copy_path, onClick: copyPath },
            { icon: ICONS.revealInFolder, title: S.widgets.header_actions.reveal_in_folder, onClick: revealInFolder },
            { icon: '<span class="header-separator"></span>', title: '', onClick: () => {} },
            { icon: ICONS.copyContent, title: S.widgets.header_actions.copy_content, onClick: copyContent },
        ],

        onResize(dimensions) {
            saveSize(dimensions.width, dimensions.height);
        },

        beforeClose() {
            activateState(null);
            if (state.viewMode === 'edit' && state.modified) {
                // beforeClose is a sync contract — block the close now,
                // confirm asynchronously, then re-close with the flag cleared.
                appConfirm(S.widgets.file_preview.discard_confirm, { confirmLabel: 'Discard', danger: true })
                    .then(ok => {
                        if (!ok) return;
                        state.modified = false;
                        WidgetManager.close('file-preview');
                    });
                return false;
            }
            return true;
        },

        onClose() {
            stopPolling();
            closeBreadcrumbMenu();
            activateState(null);
            if (state.editor) {
                state.editor.destroy();
                state.editor = null;
            }
            if (state.viewMode === 'edit') {
                state.editBuffer = null;
                state.modified = false;
                state.viewMode = 'code';
            }
            state.container = null;
            try {
                localStorage.removeItem(PATH_STORAGE_KEY);
            } catch (e) { /* ignore */ }
        },

        onDestroy(sessionId) {
            // Called when the owning session tab is closed — release the
            // per-session PreviewState so it doesn't leak.
            removeSessionState(sessionId);
        },

        render(container, context) {
            const tabId = (context?.isTab && context?.tabId) ? context.tabId : null;
            activateState(tabId);
            state.container = container;

            // Scratch mode: editable pad with no backing file
            if (context?.isScratch) {
                let saved = null;
                try {
                    const raw = localStorage.getItem(`claude-scratch-${context.scratchId}`);
                    if (raw) saved = JSON.parse(raw);
                } catch (e) { /* ignore */ }

                state.isScratch = true;
                state.scratchId = context.scratchId;
                state.currentPath = null;
                state.content = saved?.content || '';
                state.editBuffer = state.content;
                state.language = saved?.language || 'text';
                state.languageOverride = saved?.language || null;
                if (context.cwd) state.cwd = context.cwd;
                state.viewMode = 'edit';
                state.isLoading = false;
                state.error = null;
                state.plugin = null;
                state.pluginState = {};
                state.modified = false;
                state.search.active = false;

                container.innerHTML = renderPreview();
                setupEventHandlers(container);

                const previewEl = container.querySelector('.file-preview-widget') || container;
                switchToEditView(previewEl);
                return;
            }

            // Clear scratch state when rendering a file
            state.isScratch = false;
            state.scratchId = null;

            if (context?.filePath) {
                const needsFetch = !state.content || state.currentPath !== context.filePath;
                state.currentPath = context.filePath;
                state.plugin = findPlugin(context.filePath);
                state.pluginState = state.plugin?.initState() || {};
                state.language = detectLanguage(context.filePath);
                state.viewMode = state.plugin?.defaultViewMode || 'code';

                state.search.active = false;
                state.search.query = '';
                state.search.matches = [];
                state.search.currentIndex = -1;

                const shouldFetch = state.plugin ? state.plugin.needsFetch : true;
                if (needsFetch && shouldFetch) {
                    state.isLoading = true;
                    state.content = null;
                    state.error = null;

                    const containerId = container.id;
                    const isTab = context.isTab;
                    const capturedTabId = tabId;
                    const filePath = context.filePath;

                    debug.log('[FilePreview] Starting fetch for:', context.filePath, isTab ? '(tab)' : '(floating)');
                    fetchFile(context.filePath).then(({ content, mtime }) => {
                        debug.log('[FilePreview] Fetch complete, content length:', content?.length, 'for:', filePath);

                        // Re-activate correct state — global `state` may have switched
                        // (e.g., setSession() → render() → activateState(null) during init)
                        if (capturedTabId) activateState(capturedTabId);

                        if (state.currentPath === filePath) {
                            state.content = content;
                            state.mtime = mtime;
                            state.isLoading = false;
                        }

                        if (isTab && containerId) {
                            const tabContainer = document.getElementById(containerId);
                            if (tabContainer) {
                                const w = tabContainer.querySelector('.file-preview-widget');
                                if (w) {
                                    w.innerHTML = renderBody();
                                    setupEventHandlers(w);
                                    if (content && window.hljs) {
                                        highlightContent(w);
                                    }
                                    // This path bypasses render()/rerenderContent(),
                                    // so it needs its own scroll restore.
                                    if (!state.scrollToLine) {
                                        const remembered = recallScroll(state.currentPath, state.viewMode);
                                        if (remembered) {
                                            requestAnimationFrame(() => requestAnimationFrame(() => {
                                                const body = w.querySelector('.preview-body');
                                                if (body) body.scrollTop = remembered;
                                            }));
                                        }
                                    }
                                    debug.log('[FilePreview] Tab container updated directly');
                                    return;
                                }
                            }
                        }
                        rerenderContent();
                    }).catch(err => {
                        console.error('[FilePreview] Fetch error:', err);

                        if (capturedTabId) activateState(capturedTabId);

                        if (state.currentPath === filePath) {
                            state.error = err.message || 'Failed to load file';
                            state.isLoading = false;
                        }

                        if (isTab && containerId) {
                            const tabContainer = document.getElementById(containerId);
                            if (tabContainer) {
                                const w = tabContainer.querySelector('.file-preview-widget');
                                if (w) {
                                    w.innerHTML = renderBody();
                                    setupEventHandlers(w);
                                    debug.log('[FilePreview] Tab container updated with error');
                                    return;
                                }
                            }
                        }
                        rerenderContent();
                    });
                } else if (!shouldFetch) {
                    state.isLoading = false;
                }
            }

            // If state has a currentPath + isLoading but no filePath was passed in context,
            // this is a restore from localStorage (module-level init set isLoading=true).
            // The onMount callback was meant to handle this but is never called by the widget system.
            // Initiate the fetch here instead.
            if (!context?.filePath && state.currentPath && state.isLoading && !state.content) {
                const shouldFetch = state.plugin ? state.plugin.needsFetch : true;
                if (shouldFetch) {
                    const filePath = state.currentPath;
                    fetchFile(filePath)
                        .then(({ content, mtime }) => {
                            if (state.currentPath === filePath) {
                                state.content = content;
                                state.mtime = mtime;
                                state.isLoading = false;
                            }
                            rerenderContent();
                        })
                        .catch(error => {
                            if (state.currentPath === filePath) {
                                state.error = error.message;
                                state.isLoading = false;
                            }
                            rerenderContent();
                        });
                } else {
                    state.isLoading = false;
                }
            }

            debug.log('[FilePreviewWidget] render called, state:', JSON.stringify({
                currentPath: state.currentPath,
                hasContent: !!state.content,
                plugin: state.plugin?.id || null,
                isLoading: state.isLoading,
                error: state.error
            }));
            container.innerHTML = renderPreview();
            setupEventHandlers(container);

            if (state.content && !state.plugin && window.hljs) {
                highlightContent(container);
            }

            if (state.scrollToLine && state.content && !state.isLoading) {
                const pendingLine = state.scrollToLine;
                const pendingOptions = state.scrollOptions || {};
                state.scrollToLine = null;
                state.scrollOptions = null;
                // Double-rAF: first for layout after innerHTML, second to ensure scroll target dimensions
                requestAnimationFrame(() => requestAnimationFrame(() => {
                    scrollToLine(container, pendingLine, pendingOptions);
                }));
            } else if (state.content && !state.isLoading && !isEditMode()) {
                // No explicit line target — restore where this file was left.
                // Deliberately the `else` branch: an explicit line request
                // (chat file link, search result) always outranks the memory.
                const remembered = recallScroll(state.currentPath, state.viewMode);
                if (remembered) {
                    requestAnimationFrame(() => requestAnimationFrame(() => {
                        const body = container.querySelector('.preview-body');
                        if (body) body.scrollTop = remembered;
                    }));
                }
            }

            updateWidgetHeader();
        },

        onMount(container) {
            // Preload CodeMirror in background
            import('../editor-view.js').then(m => m.preloadCodeMirror()).catch(() => {});

            const shouldFetch = state.plugin ? state.plugin.needsFetch : true;
            if (state.currentPath && state.isLoading && !state.content && shouldFetch) {
                fetchFile(state.currentPath)
                    .then(({ content, mtime }) => {
                        state.content = content;
                        state.mtime = mtime;
                        state.isLoading = false;
                        rerenderContent();
                    })
                    .catch(error => {
                        state.error = error.message;
                        state.isLoading = false;
                        rerenderContent();
                    });
            } else if (!shouldFetch && state.isLoading) {
                state.isLoading = false;
                rerenderContent();
            }

            startPolling();
        },

        onUnmount() {
            stopPolling();
        }

        // Note: ESC key handling is centralized in app.handleEscape()
    });

    // Listen for session changes — re-point state to the new session's instance,
    // then propagate CWD. Without re-activating, event handlers on a hidden widget
    // would still mutate the previously-active session's state.
    WidgetBus.on('session:changed', ({ cwd }) => {
        activateState(null);
        if (cwd) state.cwd = cwd;
    });

    // Swap per-instance state when switching between widget tabs
    WidgetBus.on('widget:tab-activated', ({ widgetId, tabId }) => {
        if (widgetId === 'file-preview') {
            activateState(tabId);
            if (state.editor) {
                requestAnimationFrame(() => state.editor.focus());
            }
        }
    });

    debug.log('[FilePreviewWidget] Registered');
}

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════════════════

export const FilePreviewWidget = {
    /**
     * Preview a file
     * @param {string} path - File path to preview
     * @param {object} options - Options
     * @param {number} options.line - Single line to scroll to and highlight
     * @param {number} options.start - Start of line range to highlight
     * @param {number} options.end - End of line range to highlight
     * @param {number[]} options.highlightLines - Specific lines to highlight
     */
    async preview(path, options = {}) {
        debug.log('[FilePreviewWidget] preview() called with path:', path, 'options:', options);

        activateState(null);

        state.isScratch = false;
        state.scratchId = null;

        if (state.modified && path !== state.currentPath) {
            const ok = await appConfirm(S.widgets.file_preview.discard_confirm, { confirmLabel: 'Discard', danger: true });
            if (!ok) return;
        }

        if (path !== state.currentPath) {
            if (state.editor) {
                state.editor.destroy();
                state.editor = null;
            }
            discardEdits();
            state.viewMode = 'code';
        }

        state.search.active = false;
        state.search.query = '';
        state.search.matches = [];
        state.search.currentIndex = -1;

        state.currentPath = path;
        state.plugin = findPlugin(path);
        state.pluginState = state.plugin?.initState() || {};

        try {
            localStorage.setItem(PATH_STORAGE_KEY, path);
        } catch (e) { /* ignore */ }
        // Survives close (unlike PATH_STORAGE_KEY) so toggle() can reopen it.
        rememberLastPath(path);

        WidgetBus.emit('widget:file-changed', {
            widgetId: 'file-preview',
            filePath: path,
            fileName: basename(path)
        });

        state.language = detectLanguage(path);
        state.languageOverride = null;
        state.isLoading = true;
        state.error = null;
        state.content = null;

        if (options.start && options.end) {
            state.lineRange = { start: options.start, end: options.end };
            const lines = [];
            for (let i = options.start; i <= options.end; i++) {
                lines.push(i);
            }
            state.highlightLines = lines;
            state.scrollToLine = options.start;
        } else if (options.line) {
            state.lineRange = null;
            state.scrollToLine = options.line;
            state.highlightLines = options.highlightLines || [options.line];
        } else {
            state.lineRange = null;
            state.scrollToLine = null;
            state.highlightLines = options.highlightLines || null;
        }

        // An explicit line target supersedes the remembered position. Drop the
        // memory rather than just letting scrollToLine win once: loading a file
        // renders several times (loading → fetch settle → update), scrollToLine
        // is consumed on the first of those, and a surviving memory entry would
        // yank the view back off the requested line on the next render. The
        // scroll listener re-records wherever the line nav lands.
        if (state.scrollToLine) forgetScroll(path);

        const pluginDefault = state.plugin?.defaultViewMode;
        state.viewMode = (pluginDefault && !state.scrollToLine) ? pluginDefault : 'code';

        WidgetBus.emit('widget:close-tab', { widgetId: 'file-preview', keepScratch: true });

        WidgetManager.open('file-preview', { filePath: path });

        const shouldFetch = state.plugin ? state.plugin.needsFetch : true;
        if (shouldFetch) {
            try {
                const result = await fetchFile(path);
                state.content = result.content;
                state.mtime = result.mtime;
                state.isLoading = false;
            } catch (error) {
                state.error = error.message;
                state.isLoading = false;
            }
        } else {
            state.isLoading = false;
        }

        startPolling();
        WidgetManager.update('file-preview');

        if (options.edit && state.content && isEditable()) {
            await switchToEditView();
        }
    },

    /**
     * Preview a file and open it directly in the History tab. Optionally seeds
     * From/To cursors so the diff lands on a specific shadow snapshot pair
     * instead of the default (newest snapshot vs auto-prev).
     *
     * @param {string} path
     * @param {object} options
     * @param {object} [options.seed] - { fromKind, fromHash, toKind, toHash }
     */
    async previewWithHistory(path, options = {}) {
        activateState(null);
        // Always seed so a repeat click on the same file resets cursors.
        // Default seed = same as preview-history's "fresh load" default.
        state.historyPendingSeed = options.seed || { toKind: 'snapshot', fromKind: 'auto' };
        await this.preview(path, options);
        // preview() resets viewMode to 'code' on path change — flip after.
        state.viewMode = 'history';
        WidgetManager.update('file-preview');
    },

    close: closeWidget,

    /**
     * Show/hide the preview, reopening the last file when it was closed.
     *
     * Unlike WidgetManager.toggle('file-preview'), this restores content: the
     * widget's onClose() tears down the editor and drops the persisted path, so
     * a bare re-open would render an empty shell. Resolution order:
     *   1. the active session's in-memory currentPath (survives Escape)
     *   2. the last-previewed path from localStorage (survives reload)
     *   3. nothing to restore → the empty state, which offers the Cmd+O picker
     *
     * Uses isShowing() rather than isOpen() so a preview hidden by a session
     * switch re-reveals instead of toggling itself further off.
     */
    async toggle() {
        if (WidgetManager.isShowing('file-preview')) {
            closeWidget();
            return;
        }

        activateState(null);
        const path = state.currentPath || getLastPath();
        if (path) {
            await this.preview(path);
            return;
        }

        // Nothing to restore: show the widget anyway rather than swallowing the
        // click. Its empty state carries the "Open a file…" button, so the user
        // lands somewhere with an obvious next step instead of on a no-op.
        //
        // update() is required, not belt-and-braces: open() only re-renders when
        // handed a context, so an already-built widget would keep whatever DOM
        // it had last — showing a stale file that state no longer points at.
        WidgetManager.open('file-preview');
        WidgetManager.update('file-preview');
    },

    isOpen() {
        if (WidgetManager.isOpen('file-preview')) {
            return true;
        }
        const container = document.querySelector('.file-preview-widget');
        return container && container.offsetParent !== null;
    },

    get currentPath() {
        return state.currentPath;
    },

    setCwd(cwd) {
        state.cwd = cwd;
    },

    resetSize() {
        resetSize();
        if (widget && WidgetManager.isOpen('file-preview')) {
            debug.log('[FilePreviewWidget] Size reset to defaults:', DEFAULT_WIDTH, 'x', DEFAULT_HEIGHT);
        }
    },

    getSizeSettings() {
        const saved = loadSavedSize();
        return {
            width: saved.width,
            height: saved.height,
            defaultWidth: DEFAULT_WIDTH,
            defaultHeight: DEFAULT_HEIGHT,
            isCustom: saved.width !== DEFAULT_WIDTH || saved.height !== DEFAULT_HEIGHT
        };
    },

    openSearch() {
        openSearch();
    },

    closeSearch() {
        closeSearch();
    },

    isSearchActive() {
        return state.search.active;
    },

    closeEditorSearch() {
        if (state.editor?.isSearchOpen?.()) {
            state.editor.closeSearch();
            return true;
        }
        return false;
    },

    findNext() {
        navigateSearch(1);
    },

    findPrevious() {
        navigateSearch(-1);
    },

    async switchToEditView() {
        return switchToEditView();
    },

    leaveEditView(targetMode = 'code') {
        return leaveEditView(targetMode);
    },

    discardEdits() {
        return discardEdits();
    },

    async saveFile() {
        return saveFile();
    },

    get isEditing() {
        return isEditMode();
    },

    get isModified() {
        return state.modified;
    },

    removeTabState,
};
