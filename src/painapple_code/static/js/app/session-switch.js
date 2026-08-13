/**
 * Session-switching lifecycle mixin — creating a session, the switch queue and
 * the heavy _doSessionSwitch (tears down/rebinds the active session's DOM,
 * scroll, selection, permission/effort/token UI), plus closeSession. Extracted
 * from app.js; applied to App.prototype via Object.assign. Uses `this` (App
 * instance) plus the imports below.
 */
import { CONFIG, HAS_PHYSICAL_KEYBOARD, debug } from '../config.js';
import { Storage } from '../utils.js';
import { Session } from '../session.js';
import { WidgetManager, WidgetBus } from '../widget-system/init.js';
import { exitSelectionMode, restoreSelectionState } from '../selection/selection-handler.js';
import { loadStashForSession } from '../stash-ui.js';
import { effortSettings } from '../effort-settings.js';
import { permissionSettings } from '../permission-settings.js';
import { tokenProfile } from '../token-profile.js';

export const sessionSwitchMethods = {
    createSession(options = {}) {
        const { background = false } = options;

        // Use saved welcome tab position so new session replaces it visually
        const atIndex = this._welcomeReplaceIndex;
        delete this._welcomeReplaceIndex;
        const session = this.sessionManager.create({ atIndex });
        if (session) {
            if (!background) {
                // Use tabCtrl.switchToSession to properly switch view mode
                // (handles hiding widget/editor views and showing session view)
                this.tabCtrl.switchToSession(session);
                // Show connection bar for new session
                this.els.connectionBar.classList.add('visible');
                // Don't auto-focus CWD input - let the welcome screen handle project selection
            }
            // Always render tabs to show the new tab
            this.renderTabs();
        }
        return session;
    },

    /**
     * Create a new scratch editor tab (Ctrl+N)
     */
    createScratchTab() {
        this.tabCtrl?.openScratchTab();
    },

    switchSession(session) {
        if (!session || this.activeSession === session) return;

        // ─────────────────────────────────────────────────────────────────
        // PHASE 1: Synchronous state capture (MUST happen before any async)
        // ─────────────────────────────────────────────────────────────────

        // Save state from outgoing session BEFORE switching
        // Note: scrollPosition is preserved natively by the browser on display:none
        // elements (per-tab scroll architecture), so no manual save needed.
        if (this.activeSession) {
            this.activeSession.isUserScrolledUp = this.isUserScrolledUp;
            // Save input text to prevent accidental cross-session sends
            this.activeSession.inputText = this.els.messageInput.value;
            // Save selection state (returns serializable state, then clears)
            this.activeSession.selectionState = exitSelectionMode();
            // Save upload state (images/files) to prevent cross-session attachment leaks
            if (this.uploadManager) {
                const uploadState = this.uploadManager.saveState();
                this.activeSession.pendingImages = uploadState.pendingImages;
                this.activeSession.pendingFiles = uploadState.pendingFiles;
            }
        }

        // ─────────────────────────────────────────────────────────────────
        // PHASE 2: Queue management (debounce rapid clicks)
        // ─────────────────────────────────────────────────────────────────

        // Cancel any pending switch - only the latest click matters
        if (this._switchQueue.pending) {
            this._switchQueue.pending.cancelled = true;
        }

        // Create new operation
        const op = { session, cancelled: false };
        this._switchQueue.pending = op;

        // If already processing a switch, queue will be processed when current finishes
        if (this._switchQueue.processing) {
            debug.log('[SwitchQueue] Queued switch to:', session.name);
            return;
        }

        // Process the queue
        this._processSwitchQueue();
    },

    /**
     * Process the session switch queue
     * Handles one switch at a time, processing latest pending if current is cancelled
     * @private
     */
    _processSwitchQueue() {
        if (!this._switchQueue.pending || this._switchQueue.pending.cancelled) {
            this._switchQueue.processing = false;
            return;
        }

        this._switchQueue.processing = true;
        const op = this._switchQueue.pending;
        this._switchQueue.pending = null;

        // Execute the switch
        this._doSessionSwitch(op.session, op);

        // After switch completes, check if another was queued during processing
        // Use microtask to allow any sync code to complete first
        queueMicrotask(() => {
            if (this._switchQueue.pending && !this._switchQueue.pending.cancelled) {
                this._processSwitchQueue();
            } else {
                this._switchQueue.processing = false;
            }
        });
    },

    /**
     * Get the active scroll container (per-tab scroll architecture).
     * Returns the visible .session-messages element, or #welcome-container,
     * or falls back to #messages-container.
     * @returns {HTMLElement}
     */
    getActiveScrollContainer() {
        // Welcome view owns its scroll when it's the active top-level view
        if (this.tabCtrl?.activeMode === 'welcome') {
            const wc = this.els.welcomeView?.querySelector('#welcome-container');
            if (wc) return wc;
        }

        // Session view: per-session container pool
        const poolContainer = this.chatCtrl?._containerPool?.getActiveContainer();
        if (poolContainer) return poolContainer;

        // Fallback
        return this.els.messagesContainer;
    },

    /**
     * Predicate: should we show the welcome view for this session?
     * Centralized so _doSessionSwitch and TabController stay in sync.
     */
    shouldShowWelcomeFor(session) {
        if (!session) return false;
        const nonSystemCount = session.messages.filter(m => m.role !== 'system').length;
        return nonSystemCount === 0
            && !session.skipWelcome
            && session.status !== 'connected'
            && !session.cwd;
    },

    /**
     * Actually perform the session switch (internal, called by queue processor)
     * @private
     */
    _doSessionSwitch(session, op) {
        // Double-check not cancelled (could happen if another click came in)
        if (op.cancelled) {
            debug.log('[SwitchQueue] Switch cancelled:', session.name);
            return;
        }

        this.activeSession = session;
        session.unread = false;
        session.isReady = false;  // Clear green "ready" dot - user has now visited

        // Mark switch time to debounce load-more (prevent flicker on session switch)
        session._lastLoadTime = Date.now();

        // Close search bar when switching sessions (each session has different content)
        this.chatSearch?.close();

        // Temporarily block auto-scroll during tab switch
        this._switchingSession = true;
        this.scrollManager?.setSwitching(true);

        // Clear indicator (will be recalculated after scroll restore)
        this.clearNewMessagesIndicator();

        // Persist active session ID to survive page reloads
        Storage.set(CONFIG.ACTIVE_SESSION_KEY, session.id);
        // Also update server-side tab state — immediately, not debounced:
        // the server's activeStoreId is the first-choice restore source on
        // load (app.initFromUrl), so a reload right after a switch must find
        // the new pointer, not the previous one.
        this.sessionManager._postTabStateToServer({ immediate: true });

        this.renderTabs();

        // Branch: welcome view or chat view?
        const showWelcome = this.shouldShowWelcomeFor(session);
        if (showWelcome) {
            this.tabCtrl.switchToWelcome(session);
        } else {
            // If we entered while in welcome mode (e.g., user clicked another
            // session that has cwd), flip back to session view first.
            if (this.tabCtrl.activeMode === 'welcome') {
                this.tabCtrl._enterSessionView();
            }
            this.renderMessages();
        }

        // Retarget scroll-aware components to the new session's scroll container
        const scrollEl = this.getActiveScrollContainer();
        this.scrollManager?.setContainer(scrollEl);
        this.chatNavigator?.setScrollContainer(scrollEl);

        this.updateInputState();
        this.updateStatus();
        this.updateAgentsBadge(session._agentProgress?.size || 0);

        // Restore input text for this session. localStorage draft wins over transient
        // inputText so the draft survives page reload (inputText is not serialized).
        // session.inputText still covers mid-session tab switch before any keystroke
        // has saved a draft to localStorage.
        const persistedDraft = this.inputHandler?.loadDraft() || '';
        // On iPhone: blur the input before swapping value. If the textarea still has
        // focus (user had keyboard open in the previous session), iOS re-shows the
        // software keyboard when its value changes — "ghost focus" popup on tab close.
        // Desktop/tablet restore focus via focusInput() in the rAF block below.
        if (!HAS_PHYSICAL_KEYBOARD && document.activeElement === this.els.messageInput) {
            this.els.messageInput.blur();
        }
        this.els.messageInput.value = persistedDraft || session.inputText || '';
        this.syncInputHighlightBackdrop();
        this.autoResizeInput();

        // Restore upload state (images/files) for this session
        if (this.uploadManager) {
            this.uploadManager.restoreState({
                pendingImages: session.pendingImages,
                pendingFiles: session.pendingFiles
            });

            // Async restore from server after page refresh:
            // pendingImages/pendingFiles are empty (transient), but _savedUpload* has refs from localStorage
            const hasInMemory = session.pendingImages.length > 0 || session.pendingFiles.length > 0;
            const hasSaved = (session._savedUploadImages?.length > 0 || session._savedUploadFiles?.length > 0);
            if (!hasInMemory && hasSaved && session.storeId) {
                this.uploadManager.restoreFromServer({
                    images: session._savedUploadImages,
                    files: session._savedUploadFiles,
                }, session.storeId).then(() => {
                    session._savedUploadImages = [];
                    session._savedUploadFiles = [];
                    this.updateSendButtonState();
                }).catch(err => {
                    console.warn('[App] Failed to restore uploads from server:', err);
                });
            }
        }

        // Update send button state (handles welcome search mode too)
        this.updateSendButtonState();

        // Update activity strip based on THIS session's state
        if (session.isAgentRunning) {
            // Restore activity from session's last known activity, or generic
            const last = session._lastActivity;
            this.setActivity(last || { active: true, icon: 'sparkle', text: 'Working...' });
        } else {
            this.setActivity({ active: false });
        }

        // Log explorer receives session change via WidgetBus.emit('session:changed') below

        // Update widget system with new session
        // Use session.id (always unique) as fallback — storeId is null for unconnected sessions,
        // which would make WidgetManager unable to detect switches between them.
        WidgetBus.emit('session:changed', {
            sessionId: session.storeId || session.id,
            cwd: session.cwd || null
        });

        // Load stash for this session
        loadStashForSession(session.storeId || null);

        // Load effort level for this session
        effortSettings.setSession(session.storeId || null);

        // Load permission level for this session
        permissionSettings.setSession(session.storeId || null);

        // Load token profile for this session (account chip)
        tokenProfile.setSession(session.storeId || null);

        // Load preferred model for this session
        this.statusBar.setSession(session.storeId || null);

        // Restore selection state if saved (from previous tab switch)
        if (session.selectionState) {
            restoreSelectionState(session.selectionState);
        }

        // Session-scoped widgets (git, terminal, etc.) are now handled by
        // WidgetManager.switchSession() — no more setCwd() calls needed.
        // Restore session widgets from localStorage if first visit to this session.
        WidgetManager.restoreSessionWidgets(session.storeId || null);

        // Update status bar git branch and project name
        this.fetchGitBranch(session.cwd);
        this.statusBar.updateProject(session.cwd || null);

        // Hide file autocomplete and clear cache on session switch
        this.fileAutocomplete?.hide();

        // Hide connection bar if connected, or auto-connect if has CWD
        if (session.status === 'connected') {
            this.els.connectionBar.classList.remove('visible');
        } else if (session.cwd && session.storeId) {
            // Session has CWD and is from server (e.g., opened in background) - auto-connect
            this.els.connectionBar.classList.remove('visible');
            session.connect();
        } else {
            // New session without CWD - show connection bar (Open-folder button)
            this.els.connectionBar.classList.add('visible');
        }

        // Update file explorer's home path for this session
        this.fileExplorer.setHomePath(session.cwd);

        // Update autocomplete with this session's slash commands (from Claude init)
        // If session has no commands yet (new session), fetch from project cache
        if (session.slashCommands?.length > 0) {
            this.updateSlashCommands(session.slashCommands);
        } else if (session.cwd) {
            this.fetchProjectCommands(session.cwd);
        } else {
            this.updateSlashCommands([]);
        }

        // Restore any saved draft for this session
        this.restoreDraft();

        // Clear switching flag AFTER browser finishes rendering
        // This prevents scroll events from triggering load-more during render
        requestAnimationFrame(() => {
            this._switchingSession = false;
            this.scrollManager?.setSwitching(false);

            // Plan mode banner shrinks the scroll viewport — force scroll to bottom
            // so the plan approval card (Approve/Revise buttons) isn't hidden.
            // Must happen AFTER setSwitching(false) which cancels pending scroll RAFs.
            if (session.isInPlanMode) {
                this.scrollToBottomForce();
            }

            // Update question indicator for this session
            this.updateQuestionIndicator();

            // Refresh chat navigator for new session's messages
            this.chatNavigator?.refresh();

            // Focus the input after tab switch on desktop
            // Must be in rAF because:
            // 1. iOS/iPadOS has "ghost focus" when value changes while focused
            // 2. DOM needs to be fully updated before focus is reliable
            // Only on desktop to avoid unwanted keyboard popup on mobile
            if (HAS_PHYSICAL_KEYBOARD) {
                this.focusInput();  // Uses blur-then-focus to break ghost state

                // Retry focus after delay to handle:
                // - WebSocket reconnection completing after initial focus attempt
                // - macOS PWA (WebKit) focus timing quirks in standalone mode
                setTimeout(() => {
                    if (document.activeElement === this.els.messageInput) return;
                    if (this.els.messageInput?.disabled) return;
                    if (this.chatCtrl?.isWelcomeShowing()) return;
                    // Don't steal focus from a widget/dialog the user opened
                    // in the meantime (e.g. Cmd+K quick switcher pressed right
                    // after a tab switch). If activeElement is some other
                    // focusable input, leave it alone — the macOS PWA reconnect
                    // race this retry exists for leaves activeElement on body.
                    const active = document.activeElement;
                    if (active && active !== document.body) {
                        if (active.tagName === 'INPUT' ||
                            active.tagName === 'TEXTAREA' ||
                            active.isContentEditable) {
                            return;
                        }
                    }
                    this.focusInput();
                }, 250);
            }
        });
    },

    closeSession(session) {
        const idx = this.sessionManager.sessions.indexOf(session);
        if (idx === -1) return; // Already removed or stale reference

        // If closing the last session, create a new one first
        if (this.sessionManager.sessions.length <= 1) {
            const newSession = this.sessionManager.create({ name: 'New Session' });
            if (!newSession) return; // Couldn't create (shouldn't happen)
        }

        // Destroy session-scoped widgets (terminal, git, changes, etc.)
        const storeId = session.storeId || session.id || session.sessionId;
        WidgetManager.destroySessionWidgets(storeId);

        // Release the container from the pool (frees memory)
        const sessionId = session.id || session.storeId || session.sessionId;
        this.chatCtrl?.releaseSession(sessionId);

        // Resolve the successor from the STRIP order while this tab is still in
        // it (see TabController.pickSuccessorTab) — the sessions array is
        // creation-ordered, so indexing it jumped to an arbitrary tab once
        // anything was pinned or dragged. Only the active tab hands off focus:
        // closing a background tab (strip X, Close Others) must not steal it.
        const wasActive = this.activeSession === session;
        const successor = wasActive ? this.tabCtrl?.pickSuccessorTab('session', session.id) : null;
        // Read the strip slot before removal so Ctrl+Shift+T can restore it here
        const stripIndex = this.tabCtrl?.getTabPosition('session', session.id).index;

        this.sessionManager.remove(session, { stripIndex });

        if (successor) {
            if (this.tabCtrl.activeMode === 'widget' && successor.type === 'session') {
                // A widget tab is on screen, so the closed session tab wasn't the
                // visible one — rebind activeSession (it must never dangle at a
                // removed session) without yanking the user out of widget mode.
                this.switchSession(successor.data);
            } else {
                this.tabCtrl.activateTab(successor);
            }
        }
        this.renderTabs();
    },
};
