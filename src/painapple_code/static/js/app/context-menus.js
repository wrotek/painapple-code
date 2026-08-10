/**
 * Context-menu mixin — builds the custom right-click / long-press menus for
 * file-path elements, tab strips (session tabs and widget tabs). Extracted
 * from app.js; applied to App.prototype via Object.assign. Every method uses
 * `this` (App instance) plus the imports below.
 */
import { CONFIG } from '../config.js';
import S from '../strings.js';
import { openExternal } from '../utils.js';
import { copyToClipboard, showToast, fileDownloadAction, getDownloadLabel } from '../context-menu.js';
import { isFavoriteSession, toggleFavoriteSession } from '../welcome.js';
import { DiffViewerWidget } from '../widget-system/init.js';
import { showProjectColorPicker } from '../project-color-picker.js';
import { basename, isAbsolutePath, joinPath } from '../path-utils.js';

export const contextMenuMethods = {
    /**
     * Initialize custom context menu for file paths and other elements.
     * Captures right-click (desktop) and long-press (iPad) events.
     */
    initContextMenu() {
        // Build the Compare submenu — quick presets above the wizard.
        // The first three presets route to the file preview's History tab
        // (their refs all map cleanly onto preview-history's From/To cursors).
        // The remaining presets and the wizard still use the legacy
        // DiffViewerWidget pending preview-history support for git refs.
        const compareThisTurn = async (fullPath, cwd, turnId) => {
            try {
                const turnResp = await fetch(`${CONFIG.API_BASE}/api/turns/${encodeURIComponent(turnId)}`);
                if (!turnResp.ok) throw new Error('Turn not found');
                const turn = await turnResp.json();
                if (!turn.git_hash) {
                    showToast(S.toast.compare_no_turn_changes);
                    return;
                }
                await this.previewFileWithHistory(fullPath, {
                    cwd,
                    seed: { toKind: 'snapshot', toHash: turn.git_hash, fromKind: 'auto' }
                });
            } catch (err) {
                console.error('[Compare] this-turn failed:', err);
                showToast(`${S.toast.compare_failed}: ${err.message}`);
            }
        };

        const buildCompareSubmenu = (fullPath, cwd, turnId) => {
            const items = [];
            if (turnId) {
                items.push({
                    label: S.context_menus.file.compare_this_turn,
                    action: () => compareThisTurn(fullPath, cwd, turnId)
                });
            }
            items.push(
                {
                    label: S.context_menus.file.compare_last_change,
                    action: () => this.previewFileWithHistory(fullPath, { cwd })
                },
                {
                    label: S.context_menus.file.compare_session_start,
                    action: () => this.previewFileWithHistory(fullPath, {
                        cwd,
                        seed: { toKind: 'working', fromKind: 'initial' }
                    })
                },
                {
                    label: S.context_menus.file.compare_git_head,
                    action: () => DiffViewerWidget.quickCompareGitHead(fullPath, cwd)
                },
                {
                    label: S.context_menus.file.compare_previous_commit,
                    action: () => DiffViewerWidget.quickComparePreviousCommit(fullPath, cwd)
                },
                {
                    label: S.context_menus.file.compare_wizard,
                    action: () => DiffViewerWidget.openCompareWizard(fullPath, cwd)
                }
            );
            return items;
        };

        // Helper to show file context menu (shared by file-path-link and turn-file-pill)
        const showFileMenu = (path, cwd, fullPath, x, y, turnId) => {
            this.contextMenu.show(x, y, [
                {
                    label: S.context_menus.file.copy_path,
                    action: async () => {
                        if (await copyToClipboard(path)) showToast(S.toast.copied);
                    }
                },
                {
                    label: S.context_menus.file.copy_full_path,
                    action: async () => {
                        if (await copyToClipboard(fullPath)) showToast(S.toast.copied);
                    }
                },
                {
                    label: S.context_menus.file.copy_content,
                    action: () => {
                        const contentPromise = fetch(`/api/file?path=${encodeURIComponent(fullPath)}`)
                            .then(r => r.json())
                            .then(data => {
                                if (data.error) throw new Error(data.error);
                                return new Blob([data.content], { type: 'text/plain' });
                            });
                        navigator.clipboard.write([new ClipboardItem({ 'text/plain': contentPromise })])
                            .then(() => showToast(S.toast.copied))
                            .catch(() => showToast(S.errors.copy_failed));
                    }
                },
                { type: 'separator' },
                {
                    label: S.context_menus.file.preview,
                    action: () => this.previewFile(fullPath)
                },
                {
                    label: S.context_menus.file.open_in_new_tab,
                    action: () => this.tabCtrl?.openFilePreviewTab(fullPath, null, { newTab: true })
                },
                {
                    label: S.context_menus.file.open_in_background,
                    action: () => this.tabCtrl?.openFilePreviewTab(fullPath, null, { background: true })
                },
                {
                    label: S.context_menus.file.open_editor,
                    action: () => this.openFileInEditor(fullPath)
                },
                { type: 'separator' },
                {
                    label: S.context_menus.file.show_history,
                    action: () => {
                        const relativePath = fullPath.startsWith(cwd + '/')
                            ? fullPath.slice(cwd.length + 1)
                            : path;
                        this.showFileHistory(relativePath, cwd);
                    }
                },
                {
                    label: getDownloadLabel(),
                    action: () => fileDownloadAction(fullPath)
                },
                { type: 'separator' },
                {
                    label: S.context_menus.file.compare,
                    submenu: buildCompareSubmenu(fullPath, cwd, turnId)
                },
                // Shortcut for the 99% case on turn-summary file pills: skip the
                // submenu and jump straight to "to last change". Only shown in
                // turn-summary contexts (turn pills, session file rows) where
                // verifying what just changed is the dominant intent.
                ...(turnId ? [{
                    label: S.context_menus.file.compare_last_change,
                    action: () => this.previewFileWithHistory(fullPath, { cwd })
                }] : [])
            ]);
        };

        // Wrapper for .file-path-link elements
        const showFileLinkMenu = (fileLink, x, y) => {
            const path = fileLink.dataset.file;
            const cwd = this.activeSession?.cwd || CONFIG.HOME;
            const fullPath = fileLink.dataset.resolved || (isAbsolutePath(path) ? path : joinPath(cwd, path));
            showFileMenu(path, cwd, fullPath, x, y);
        };

        // Wrapper for .turn-file-pill elements (changed files in turn summary bar)
        const showTurnFilePillMenu = (pill, x, y) => {
            const filePath = pill.dataset.filePath;
            const summaryBar = pill.closest('.turn-summary-bar');
            const cwd = summaryBar?.dataset.cwd || this.activeSession?.cwd || CONFIG.HOME;
            const turnId = summaryBar?.dataset.turnId;
            const fullPath = isAbsolutePath(filePath) ? filePath : joinPath(cwd, filePath);
            showFileMenu(filePath, cwd, fullPath, x, y, turnId);
        };

        // Wrapper for .session-file-row elements (expanded session files list)
        const showSessionFileRowMenu = (row, x, y) => {
            const filePath = row.dataset.filePath;
            const summaryBar = row.closest('.turn-summary-bar');
            const cwd = summaryBar?.dataset.cwd || this.activeSession?.cwd || CONFIG.HOME;
            const turnId = summaryBar?.dataset.turnId;
            const fullPath = isAbsolutePath(filePath) ? filePath : joinPath(cwd, filePath);
            showFileMenu(filePath, cwd, fullPath, x, y, turnId);
        };

        // Wrapper for git-widget file rows (.git-file-item / .git-commit-file).
        // Both carry data-path and data-cwd; no turnId, so the "compare to last
        // change" shortcut is omitted — the standard Compare submenu still applies.
        const showGitFileMenu = (item, x, y) => {
            const filePath = item.dataset.path;
            const cwd = item.dataset.cwd || this.activeSession?.cwd || CONFIG.HOME;
            const fullPath = isAbsolutePath(filePath) ? filePath : joinPath(cwd, filePath);
            showFileMenu(filePath, cwd, fullPath, x, y);
        };

        // iOS long-press detection for file links (contextmenu doesn't fire on iOS)
        // Uses click blocker pattern from tab-controller.js to handle iOS synthetic click
        let longPressTimer = null;
        let clickBlocker = null;

        const removeClickBlocker = () => {
            if (clickBlocker) {
                document.removeEventListener('click', clickBlocker, { capture: true });
                clickBlocker = null;
            }
        };

        // Exposed so bindTapHandler (chat-controller.js) can cancel a pending
        // long-press when it fires the tap action. Without this, a tap's
        // e.stopPropagation() blocks the document touchend, leaving the 400 ms
        // timer live — and it opens the context menu on top of the preview.
        window.__cancelFileLongPress = () => {
            if (longPressTimer) {
                clearTimeout(longPressTimer);
                longPressTimer = null;
            }
        };

        document.addEventListener('touchstart', (e) => {
            const fileLink = e.target.closest('.file-path-link');
            const turnFilePill = !fileLink ? e.target.closest('.turn-file-pill') : null;
            const sessionFileRow = !fileLink && !turnFilePill ? e.target.closest('.session-file-row[data-file-path]') : null;
            const gitFileItem = !fileLink && !turnFilePill && !sessionFileRow
                ? e.target.closest('.git-file-item[data-path], .git-commit-file[data-path]')
                : null;
            if (!fileLink && !turnFilePill && !sessionFileRow && !gitFileItem) return;

            // Clean up any existing blocker from previous interaction
            removeClickBlocker();

            const touch = e.touches[0];
            const x = touch.clientX;
            const y = touch.clientY;

            longPressTimer = setTimeout(() => {
                // Clear any text selection so iOS native menu doesn't compete
                window.getSelection()?.removeAllRanges();

                // Create click blocker BEFORE showing menu
                // This ensures it's registered before menu's click-to-dismiss handler
                clickBlocker = (evt) => {
                    evt.preventDefault();
                    evt.stopPropagation();
                    evt.stopImmediatePropagation();
                };
                document.addEventListener('click', clickBlocker, { capture: true });

                // Now show context menu
                if (fileLink) {
                    showFileLinkMenu(fileLink, x, y);
                } else if (turnFilePill) {
                    showTurnFilePillMenu(turnFilePill, x, y);
                } else if (sessionFileRow) {
                    showSessionFileRowMenu(sessionFileRow, x, y);
                } else {
                    showGitFileMenu(gitFileItem, x, y);
                }
            }, 400);
        }, { passive: true });

        document.addEventListener('touchend', (e) => {
            if (longPressTimer) {
                clearTimeout(longPressTimer);
                longPressTimer = null;
            }
            // If menu was shown (blocker exists), prevent default and schedule blocker removal
            if (clickBlocker) {
                e.preventDefault();
                e.stopPropagation();
                // Remove blocker after iOS synthetic click window (~400ms after touchend)
                setTimeout(removeClickBlocker, 400);
            }
        }, { passive: false });

        document.addEventListener('touchmove', () => {
            if (longPressTimer) {
                clearTimeout(longPressTimer);
                longPressTimer = null;
            }
        }, { passive: true });

        document.addEventListener('contextmenu', (e) => {
            // Check for file-path-link
            const fileLink = e.target.closest('.file-path-link');
            if (fileLink) {
                e.preventDefault();
                e.stopPropagation();
                showFileLinkMenu(fileLink, e.clientX, e.clientY);
                return;
            }

            // Check for turn-file-pill (changed files in turn summary bar)
            const turnFilePill = e.target.closest('.turn-file-pill');
            if (turnFilePill) {
                e.preventDefault();
                e.stopPropagation();
                showTurnFilePillMenu(turnFilePill, e.clientX, e.clientY);
                return;
            }

            // Check for session-file-row (expanded session files list)
            const sessionFileRow = e.target.closest('.session-file-row[data-file-path]');
            if (sessionFileRow) {
                e.preventDefault();
                e.stopPropagation();
                showSessionFileRowMenu(sessionFileRow, e.clientX, e.clientY);
                return;
            }

            // Check for git-widget file rows (status view + commit detail view)
            const gitFileItem = e.target.closest('.git-file-item[data-path], .git-commit-file[data-path]');
            if (gitFileItem) {
                e.preventDefault();
                e.stopPropagation();
                showGitFileMenu(gitFileItem, e.clientX, e.clientY);
                return;
            }

            // Check for external links
            const externalLink = e.target.closest('.external-link');
            if (externalLink) {
                e.preventDefault();
                const url = externalLink.href;
                this.contextMenu.show(e.clientX, e.clientY, [
                    {
                        label: S.context_menus.link.copy_url,
                        action: async () => {
                            if (await copyToClipboard(url)) showToast(S.toast.copied);
                        }
                    },
                    {
                        label: S.context_menus.link.open_new_tab,
                        // Anchor-click, not window.open — the latter silently
                        // no-ops in the iPad standalone PWA (see openExternal)
                        action: () => openExternal(url)
                    }
                ]);
                return;
            }

            // Check for tabs (session, file, widget)
            const tabEl = e.target.closest('.tab');
            if (tabEl) {
                e.preventDefault();
                e.stopPropagation();
                const items = this.buildTabContextMenu(tabEl);
                if (items.length > 0) {
                    this.contextMenu.show(e.clientX, e.clientY, items);
                }
                return;
            }
        });
    },

    /**
     * Build context menu items for a tab element
     * @param {HTMLElement} tabEl - The tab element
     * @returns {Array} Context menu items
     */
    buildTabContextMenu(tabEl) {
        const tabType = tabEl.dataset.type;
        const tabId = tabEl.dataset.id;

        if (tabType === 'session') {
            return this.buildSessionTabContextMenu(tabId);
        } else if (tabType === 'widget') {
            return this.buildWidgetTabContextMenu(tabId);
        }
        return [];
    },

    /**
     * Build context menu for session tabs
     */
    buildSessionTabContextMenu(sessionId) {
        const session = this.sessionManager.get(sessionId);
        if (!session) return [];

        const baseUrl = window.location.origin + window.location.pathname;
        const sessionUrl = `${baseUrl}?session=${session.storeId || sessionId}`;
        const sessions = this.sessionManager.sessions;
        const hasMultipleSessions = sessions.length > 1;
        const tabPos = this.tabCtrl.getTabPosition('session', sessionId);

        // Only show favorites for saved sessions (those with a server-side storeId)
        const canFavorite = session.storeId != null;
        const isFav = canFavorite && isFavoriteSession(session.storeId);

        const items = [];
        const isPinned = this.tabCtrl.isTabPinned('session', sessionId);

        // Favorites option only for saved sessions
        if (canFavorite) {
            items.push({
                label: isFav
                    ? S.context_menus.session.remove_favorite
                    : S.context_menus.session.add_favorite,
                icon: isFav ? 'starFilled' : 'star',
                action: async () => {
                    const newState = await toggleFavoriteSession(session.storeId);
                    if (newState === null) {
                        showToast(S.errors.update_favorite);
                    } else {
                        showToast(newState ? S.toast.added_favorite : S.toast.removed_favorite);
                    }
                }
            });
        }

        // Pin sits directly under Favorites — both are "keep this around"
        // actions, so they read as a pair above the copy/manage/close groups.
        items.push({
            label: isPinned ? S.context_menus.tab.unpin : S.context_menus.tab.pin,
            icon: isPinned ? 'pinOff' : 'pin',
            action: () => this.tabCtrl.toggleTabPin('session', sessionId)
        });
        items.push({ type: 'separator' });

        items.push(
            {
                label: S.context_menus.session.copy_id,
                action: async () => {
                    const id = session.storeId || sessionId;
                    if (await copyToClipboard(id)) showToast(S.toast.session_id_copied);
                }
            },
            {
                label: S.context_menus.session.copy_url,
                action: async () => {
                    if (await copyToClipboard(sessionUrl)) showToast(S.toast.url_copied);
                }
            },
            {
                label: S.context_menus.session.copy_cwd,
                action: async () => {
                    if (await copyToClipboard(session.cwd)) showToast(S.toast.cwd_copied);
                }
            },
            { type: 'separator' },
            {
                label: S.context_menus.session.rename,
                action: () => this.renameSession(session)
            },
            {
                label: S.context_menus.session.edit_color,
                // Anchor the swatch popup to this session's tab element so it
                // opens next to the tab regardless of click vs. long-press.
                action: () => {
                    const tab = document.querySelector(
                        `.tab[data-type="session"][data-id="${sessionId}"]`);
                    const rect = tab
                        ? tab.getBoundingClientRect()
                        : { left: 100, bottom: 100 };
                    showProjectColorPicker(
                        session.cwd, rect.left, rect.bottom + 4,
                        () => this.tabCtrl.renderTabs(),
                    );
                },
                disabled: !session.cwd  // No project path → nothing to color
            },
            {
                label: S.context_menus.session.fork,
                action: () => {
                    // forkSession uses activeSession, so switch first if needed
                    if (this.activeSession !== session) {
                        this.switchToSession(session);
                    }
                    this.forkSession();
                },
                disabled: !session.providerSessionId  // Need existing conversation to fork
            },
            {
                label: S.context_menus.session.clone,
                action: () => this.createNewSession(session.cwd)
            },
            { type: 'separator' },
            {
                label: S.context_menus.tab.move_left,
                action: () => this.tabCtrl.moveTab('session', sessionId, -1),
                disabled: !tabPos.canMoveLeft
            },
            {
                label: S.context_menus.tab.move_right,
                action: () => this.tabCtrl.moveTab('session', sessionId, 1),
                disabled: !tabPos.canMoveRight
            },
            { type: 'separator' },
            {
                label: S.context_menus.session.close,
                action: () => this.closeSession(session)
            },
            {
                label: S.context_menus.session.close_others,
                action: () => this.closeOtherSessions(session),
                disabled: !hasMultipleSessions
            },
            {
                label: S.context_menus.session.close_all,
                action: () => this.closeAllSessions(),
                disabled: !hasMultipleSessions
            }
        );

        return items;
    },


    /**
     * Build context menu for widget tabs (terminals, etc.)
     */
    buildWidgetTabContextMenu(tabId) {
        const tab = this.tabCtrl.widgetTabs.find(t => t.id === tabId);
        if (!tab) return [];

        const isTerminal = tab.isTerminal || tab.widgetId === 'terminal';
        const isFilePreview = tab.widgetId === 'file-preview' && tab.filePath;
        const terminalTabs = this.tabCtrl.widgetTabs.filter(t => t.isTerminal || t.widgetId === 'terminal');
        const hasMultipleTerminals = terminalTabs.length > 1;

        const items = [];

        if (isTerminal) {
            items.push(
                {
                    label: S.context_menus.terminal.new_terminal,
                    action: () => this.tabCtrl.openTerminalWidgetTab()
                },
                { type: 'separator' }
            );
        }

        if (isFilePreview) {
            const filePath = tab.filePath;
            const fileName = basename(filePath);
            const cwd = this.activeSession?.cwd || CONFIG.HOME;
            const relativePath = filePath.startsWith(cwd + '/')
                ? filePath.slice(cwd.length + 1) : fileName;
            items.push(
                {
                    label: S.context_menus.terminal.copy_path,
                    action: async () => {
                        if (await copyToClipboard(relativePath)) showToast(S.toast.copied);
                    }
                },
                {
                    label: S.context_menus.terminal.copy_full_path,
                    action: async () => {
                        if (await copyToClipboard(filePath)) showToast(S.toast.copied);
                    }
                },
                {
                    label: S.context_menus.terminal.copy_content,
                    action: () => {
                        const contentPromise = fetch(`/api/file?path=${encodeURIComponent(filePath)}`)
                            .then(r => r.json())
                            .then(data => {
                                if (data.error) throw new Error(data.error);
                                return new Blob([data.content], { type: 'text/plain' });
                            });
                        navigator.clipboard.write([new ClipboardItem({ 'text/plain': contentPromise })])
                            .then(() => showToast(S.toast.copied))
                            .catch(() => showToast(S.errors.copy_failed));
                    }
                },
                {
                    label: getDownloadLabel(),
                    action: () => fileDownloadAction(filePath)
                },
                { type: 'separator' },
                {
                    label: S.context_menus.file.show_history,
                    action: () => this.showFileHistory(relativePath, cwd)
                },
                { type: 'separator' }
            );
        }

        const tabPos = this.tabCtrl.getTabPosition('widget', tabId);
        const isPinned = this.tabCtrl.isTabPinned('widget', tabId);
        items.push(
            {
                label: isPinned ? S.context_menus.tab.unpin : S.context_menus.tab.pin,
                icon: isPinned ? 'pinOff' : 'pin',
                action: () => this.tabCtrl.toggleTabPin('widget', tabId)
            },
            { type: 'separator' },
            {
                label: S.context_menus.tab.move_left,
                action: () => this.tabCtrl.moveTab('widget', tabId, -1),
                disabled: !tabPos.canMoveLeft
            },
            {
                label: S.context_menus.tab.move_right,
                action: () => this.tabCtrl.moveTab('widget', tabId, 1),
                disabled: !tabPos.canMoveRight
            },
            { type: 'separator' },
            {
                label: S.context_menus.terminal.close,
                action: () => this.tabCtrl.closeWidgetTab(tabId)
            }
        );

        if (isTerminal && hasMultipleTerminals) {
            items.push({
                label: S.context_menus.terminal.close_all,
                action: () => {
                    // Pinned terminals survive a bulk close.
                    const termIds = terminalTabs
                        .filter(t => !this.tabCtrl.isTabPinned('widget', t.id))
                        .map(t => t.id);
                    termIds.forEach(id => this.tabCtrl.closeWidgetTab(id));
                }
            });
        }

        return items;
    },
};
