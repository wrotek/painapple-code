/**
 * Main App class and initialization
 */

// Import first so window.fetch is wrapped before any module's poll fires.
import './auth-fetch.js';
import './action-delegate.js';
import S from './strings.js';
import { CONFIG, COMMANDS, HAS_PHYSICAL_KEYBOARD, debug, setServerHome, setServerWorkspace, INSTANCE } from './config.js';
import { $, genId, escapeHtml, formatTime, formatRelativeTime, Storage, highlightThinkingKeywords, hasThinkingKeywords, terminalAvailable } from './utils.js';
import { isThinkingKeywordsHighlightingEnabled } from './widgets/config-widget.js';
import { basename, isAbsolutePath, joinPath } from './path-utils.js';
import { Session, SessionManager } from './session.js';
import { MarkdownRenderer, AutocompleteUI } from './components.js';
// FileExplorer and LogExplorer are now widgets, imported via widget-system
// Widget System (new modular architecture)
import { initWidgetSystem, WidgetManager, WidgetBus, GitWidget, TerminalWidget, LogExplorerWidget, FileExplorerWidget, FilePreviewWidget, HistoryExplorerWidget, DiffViewerWidget } from './widget-system/init.js';
// Selection system - text selection handler for stash and discussion
import { initSelectionHandler, registerSelectionContainer, exitSelectionMode, restoreSelectionState, isSelectionModeActive } from './selection/selection-handler.js';
// ICONS moved to TabController
import { getFileName, isImageFile } from './file-tabs.js';
import { ShortcutManager, reconcileShortcutsWithServer } from './shortcuts.js';
// getCommandStore, CommandType moved to CommandExecutor
import { GestureManager } from './gestures.js';
import { ContextMenu, copyToClipboard, showToast, fileDownloadAction, getDownloadLabel } from './context-menu.js';
import { generateSmartDiff, renderSmartDiff } from './diff-utils.js';
import { ChatSearch } from './chat-search.js';
import { ChatNavigator } from './chat-navigator.js';
import { ScrollManager } from './scroll-manager.js';
import { UploadManager } from './upload-manager.js';
import { StatusBar, ensureModelsLoaded } from './status-bar.js';
import { ActivityStrip } from './activity-strip.js';
import { InputHandler } from './input-handler.js';
import { ShortcutHints } from './shortcut-hints.js';
import { ToolRenderer } from './tool-renderer.js';
import { FileAutocomplete } from './file-autocomplete.js';
import { recordOpen as recordRecentOpen } from './recent-opens.js';
import { SnippetsAutocomplete, initSnippetsData, refreshAgentsForCwd } from './snippets-autocomplete.js';
import { SkillsAutocomplete, invalidateSkillsCache } from './skills-autocomplete.js';
// Stash system - context collector for chat prompts
import { Stash } from './stash.js';
import { initStashUI, loadStashForSession, closeStashPickerIfOpen } from './stash-ui.js';
// Prompt favorites - mark prompts as favorites before/after sending
import * as PromptFavorites from './prompt-favorites.js';
// Welcome screen state management (for "back to sessions" feature)
import { initWelcomeScreen, clearSavedWelcomeState, isFavoriteSession, toggleFavoriteSession, loadFavoritesFromServer, openQuickSearch, isQuickSearchActive, typeIntoQuickSearch, clearWelcomeSearch, closeSessionPreview, closeWelcomeContextMenu } from './welcome.js';
// Tooltip system - unified tooltips for desktop hover and touch long-press
import { TooltipManager, initTooltips } from './tooltips.js';
// Controller Architecture (V2 modularization)
import { AppContext } from './app-context.js';
import { ThinkingController } from './controllers/thinking-controller.js';
import { DialogController } from './controllers/dialog-controller.js';
import { ChatController } from './controllers/chat-controller.js';
import { TabController } from './controllers/tab-controller.js';
import { CommandExecutor } from './command-executor.js';
import { orphanTerminals } from './orphan-terminals.js';
// Effort settings - controls response thoroughness (replaces thinking tokens)
import { effortSettings } from './effort-settings.js';
// Permission settings - per-session permission level control
import { permissionSettings } from './permission-settings.js';
// Token profile - per-session OAuth token selector (account chip)
import { tokenProfile } from './token-profile.js';
// Session setup panel — provider/model/permissions/effort/account pills in
// the empty chat area of a fresh session (self-initializing singleton)
import { sessionSetupPanel } from './session-setup-panel.js';
// Layout density switcher — popup opened from the left-rail density button
import { layoutSwitcher } from './layout-switcher.js';
import { state as configState } from './widgets/config/state.js';
// Quick Actions Menu API + Worktrees
import { QuickActionsMenu, ImagePreviewWidget, DiscussionWidget, handleAnnotatorEscape } from './widgets/index.js';
import { QuickActionsRegistry } from './quick-actions-registry.js';
// Quick Switcher (VS Code-style command palette / file picker)
import { QuickSwitcher } from './quick-switcher/index.js';
// Open Dialog (fish-style path picker — files preview, folders start new sessions)
import { OpenDialog } from './open-dialog.js';
// Grid Switcher (iPad-style session card grid, Alt+Tab)
import { GridSwitcher } from './grid-switcher.js';
// Background task tracking for header badge
import { bgTaskTracker } from './background-tasks.js';

// Prototype mixins extracted from this file (see Object.assign near the bottom).
import { panelMethods } from './app/panels.js';
import { contextMenuMethods } from './app/context-menus.js';
import { renderingDelegatorMethods } from './app/rendering-delegators.js';
import { filePreviewMethods } from './app/file-preview.js';
import { sessionSwitchMethods } from './app/session-switch.js';
import { initUiMethods } from './app/init-ui.js';
import { inputEventMethods } from './app/input-events.js';
import { serverLoadingMethods } from './app/server-loading.js';
import { inputResizeMethods } from './app/input-resize.js';
import { startupWelcomeMethods } from './app/startup-welcome.js';
import { settingsHelperMethods } from './app/settings-helpers.js';
import { messageActionMethods } from './app/message-actions.js';
import { sessionOpsMethods } from './app/session-ops.js';
import { loadProjectColors } from './project-colors.js';
import { closeProjectColorPicker } from './project-color-picker.js';

/**
 * Main application class
 */
class App {
    constructor() {
        this.sessionManager = new SessionManager();
        this.activeSession = null;
        this.markdown = new MarkdownRenderer();
        this.toolRenderer = new ToolRenderer();
        this.autocomplete = null;
        this.userCommandNames = new Set();  // User-defined command names for autocomplete labeling
        this.fileAutocomplete = null;  // Initialized in initAutocomplete()
        this.isTyping = false;

        // Controller Architecture - shared context and controllers
        this.ctx = new AppContext(this);
        this.thinkingCtrl = new ThinkingController(this.ctx);
        this.dialogCtrl = new DialogController(this.ctx);
        this.chatCtrl = null;  // Initialized after thinkingCtrl
        this.tabCtrl = null;   // Initialized after widget system
        this.commandExec = new CommandExecutor(this.ctx);

        // Input handler (initialized in initAutocomplete after DOM refs are ready)
        this.inputHandler = null;

        // Upload manager (initialized in initImageUpload after DOM refs are ready)
        this.uploadManager = null;

        // Font scale (0.75 to 1.5, step 0.1)
        this.fontScale = Storage.get('claude-font-scale', 1.0);

        // Scroll manager (initialized in initAutocomplete after DOM refs are ready)
        this.scrollManager = null;

        // Session switch queue - prevents race conditions from rapid tab clicks
        this._switchQueue = {
            pending: null,      // Pending switch operation {session, cancelled}
            processing: false   // Whether a switch is in progress
        };

        // Chat search (initialized in initAutocomplete after DOM refs are ready)
        this.chatSearch = null;

        // Chat navigator for jumping between user messages (initialized in initAutocomplete)
        this.chatNavigator = null;

        // File explorer (now managed by WidgetManager as 'file-explorer')
        this.fileExplorer = FileExplorerWidget;

        // Log explorer is now a widget (registered via initWidgetSystem)

        // Keyboard bar is now embedded inside the terminal widget (see terminal-widget.js)
        // Widget System initialization
        initWidgetSystem();

        // Initialize TabController after widget system
        this.tabCtrl = new TabController(this.ctx);

        // Grid switcher overlay (iPad-style session grid; Alt+Tab + header button)
        this.gridSwitcher = new GridSwitcher(this);

        // Git panel is now managed by WidgetManager (registered as 'git')

        // Context menu (right-click / long-press)
        this.contextMenu = new ContextMenu();

        // Resolve the markup's data-tooltip-key attributes into real tooltip
        // text BEFORE anything reads data-tooltip. initEventListeners() ->
        // initLeftRailButtons() derives the expanded-rail labels from it, so
        // running late here would leave the rail unlabelled.
        this.applyStaticTooltips?.();
        this.initElements();
        this.initAutocomplete();
        // Initialize ChatController after elements are ready
        this.chatCtrl = new ChatController(this.ctx, this.thinkingCtrl);
        this._initControllerEvents();
        this.initEventListeners();
        this.initContextMenu();
        this.shortcutManager = new ShortcutManager(this);
        // Rail tooltips were rendered before shortcutManager existed — refresh
        // them now so they pick up registered shortcut keys.
        this.refreshRailShortcutTooltips?.();
        this.gestureManager = new GestureManager(this);
        // Config panel is now a widget - registered in initWidgets()
        this.initBeforeUnload();
        this.initWelcomeEvents();
        this.initInputResize();
        this.updateInputAreaHeight(); // Set initial CSS variable for floating elements
        this.initImageUpload();
        this.initVisibilitySync();
        this.tabCtrl.initWidgetTabEvents();
        orphanTerminals.init();
        // Note: initFromUrl() is called after construction to properly await async loading
    }

    async initFromUrl() {
        const urlParams = new URLSearchParams(window.location.search);
        const urlSessionId = urlParams.get('session');

        // Enable expand mode for screenshots (?expand=true)
        if (urlParams.get('expand') === 'true') {
            document.body.classList.add('expand-mode');
        }

        // Load favorites for context menu and quick actions
        loadFavoritesFromServer().catch(e => console.warn('Failed to load favorites:', e));

        // ── Server-side shortcut reconciliation ───────────────────────
        // Keyboard shortcut customizations sync through the server so they
        // persist across devices and survive iPadOS PWA localStorage drift.
        reconcileShortcutsWithServer().then(synced => {
            if (synced && this.shortcutManager) {
                this.shortcutManager.reloadShortcuts();
                this.refreshRailShortcutTooltips?.();
            }
        });

        // ── Server-side tab state reconciliation ──────────────────────
        // iPadOS PWA localStorage writes can silently fail to persist to disk.
        // The server keeps a reliable copy of which tabs are open.
        // If server and localStorage disagree, server wins.
        const rebuiltFromServer = await this.sessionManager.reconcileWithServer();
        let loadedFromServer = rebuiltFromServer;

        // Get active session — server's pointer first, UNCONDITIONALLY (not
        // gated on rebuiltFromServer). The server re-persists activeStoreId on
        // every tab save, so it's the freshest source and the only one that
        // survives localStorage loss (iPadOS write-loss, app reinstall, and
        // the Tauri proxy's per-launch origin). Local ACTIVE_SESSION_KEY is
        // the fallback when the server pointer is absent or doesn't resolve.
        const serverActiveStoreId =
            this.sessionManager._serverTabState?.activeStoreId || null;
        let savedActiveSessionId;
        if (serverActiveStoreId) {
            // Find the session that matches the server's active storeId
            const serverActive = this.sessionManager.sessions.find(
                s => s.storeId === serverActiveStoreId
            );
            savedActiveSessionId = serverActive?.id;
        }
        if (!savedActiveSessionId) {
            savedActiveSessionId = Storage.get(CONFIG.ACTIVE_SESSION_KEY);
        }
        const savedActiveSession = savedActiveSessionId
            ? this.sessionManager.get(savedActiveSessionId)
            : null;

        let sessionLoaded = false;

        // An explicit ?session= in the URL OUTRANKS restored state. Nothing in
        // the app ever writes that param (no pushState/replaceState carries it,
        // and the PWA start_url is a bare /app), so its presence is always a
        // deliberate deep-link/share — the user asked for THAT session. It used
        // to be an `else if` after restored state, which meant a share link
        // silently dropped you into whatever tab happened to be active.
        if (urlSessionId) {
            const localMatch = this.sessionManager.sessions.find(
                s => s.id === urlSessionId || s.storeId === urlSessionId
            );
            if (localMatch) {
                this.switchSession(localMatch);
                sessionLoaded = true;
                debug.log('[initFromUrl] Deep-link ?session= resolved locally:', urlSessionId);
            } else {
                debug.log('[initFromUrl] Deep-link ?session= loading from server:', urlSessionId);
                sessionLoaded = await this.loadSessionFromServer(urlSessionId);
                loadedFromServer = sessionLoaded;
            }
        }

        // Otherwise localStorage (or server-reconciled state) decides.
        if (!sessionLoaded && savedActiveSession) {
            this.switchSession(savedActiveSession);
            sessionLoaded = true;
            debug.log('[initFromUrl] Using session:', savedActiveSession.id,
                'storeId:', savedActiveSession.storeId,
                rebuiltFromServer ? '(rebuilt from server)' : '(from localStorage)');
        }

        if (!sessionLoaded) {
            // Fallback: no valid session and URL load failed (or no URL)
            if (this.sessionManager.sessions.length > 0) {
                this.switchSession(this.sessionManager.sessions[0]);
            } else {
                this.createSession();
            }
        }

        // Restore widget tabs (terminals, etc.) — server v2 state wins over
        // localStorage (same iPadOS write-loss rationale as session tabs)
        const serverTabState = this.sessionManager._serverTabState || null;
        const hasWidgetTabs = this.tabCtrl.restoreWidgetTabs(serverTabState);

        // Restore interleaved strip order (sessions ↔ widget tabs)
        if (serverTabState?.order?.length) {
            this.tabCtrl.applyServerOrder(serverTabState.order);
        }

        // Restore active mode (session/widget)
        const savedMode = Storage.get(CONFIG.ACTIVE_MODE_KEY, 'session');
        const serverActiveWidget = serverTabState?.activeTab?.kind === 'widget'
            ? serverTabState.activeTab.id : null;
        if (serverActiveWidget
            && this.tabCtrl.widgetTabs.some(t => t.id === serverActiveWidget)) {
            // Server's active pointer says a widget tab was in front — trust
            // it unconditionally (same rationale as activeStoreId above: the
            // server copy is the only one that survives localStorage loss).
            this.tabCtrl.switchToWidgetTab(serverActiveWidget);
        } else if (savedMode === 'widget' && hasWidgetTabs && this.tabCtrl.activeWidgetTabId) {
            this.tabCtrl.switchToWidgetTab(this.tabCtrl.activeWidgetTabId);
        } else {
            this.renderTabs();
        }

        // Return whether we loaded fresh from server (to skip unnecessary fullSync)
        return { loadedFromServer };
    }

    /**
     * Initialize event handlers for controller communication
     */
    _initControllerEvents() {
        // Handle events from DialogController
        this.ctx.on('openFileInEditor', ({ path, cwd }) => {
            this.openFileInEditor(path, cwd);
        });

        this.ctx.on('directoryCreated', ({ path }) => {
            // Set cwd and connect
            this.activeSession.cwd = path;
            this.activeSession.connect();
            this.els.connectionBar.classList.remove('visible');
            // cwd is set — flip to chat view
            this.tabCtrl.switchToSession(this.activeSession);
            this.fetchProjectCommands(path);
            this.sessionManager.saveSessions();
        });

        this.ctx.on('showSettings', () => {
            if (this.configPanel) {
                this.configPanel.show();
            }
        });

        this.ctx.on('sessionItemClicked', async ({ sessionId, cwd, fromWelcome }) => {
            const existingSession = this.sessionManager.sessions.find(s => s.storeId === sessionId);
            if (existingSession) {
                // Mark session if opened from welcome (for back button)
                if (fromWelcome) {
                    existingSession.openedFromWelcome = true;
                }
                this.switchToSession(existingSession);
                return;
            }

            const loaded = await this.loadSessionFromServer(sessionId, 50, fromWelcome);
            if (!loaded && cwd) {
                this.createSession();
                this.connectActiveSession(cwd);
            }
        });

        this.ctx.on('projectItemClicked', ({ path }) => {
            this.connectActiveSession(path);
        });
    }



    /**
     * Send a message directly without welcome screen checks.
     * Used when welcome has already determined this should be sent.
     */
    _sendMessageDirect(content) {
        if (!this.activeSession) return;

        // Save to persistent per-project history
        this.addToInputHistory(content);

        // Send with images if any
        const images = [...this.pendingImages];
        const files = [...this.pendingFiles];

        // Appended, not prepended — see the same block in app/input-events.js:
        // a prefix stops a leading slash command from being a command at all.
        let messageToSend = content;
        const sendOptions = {};
        if (files.length > 0) {
            const fileRefs = files.map(f => `Uploaded file: ${f.path}`).join('\n');
            messageToSend = `${messageToSend}\n\n${fileRefs}`;
            // Store the typed text, not the composition, so the server's
            // `message_stored` broadcast is adopted by the bubble already on
            // screen instead of landing as a duplicate.
            sendOptions.displayContent = content;
            sendOptions.files = files.map(f => f.path).filter(Boolean);
        }

        this.clearPendingImages();
        this.clearPendingFiles();
        if (this.activeSession) {
            this.activeSession._savedUploadImages = [];
            this.activeSession._savedUploadFiles = [];
        }

        // Add user message to UI immediately
        // peekEffectiveLevel returns the one-shot override if armed, else
        // the persistent level — the actual sent value is consumed by
        // session.sendWithImages right before the WS message goes out.
        const effortLevel = effortSettings.peekEffectiveLevel();
        this.activeSession.addMessage({
            role: 'user',
            content: content,
            timestamp: new Date().toISOString(),
            images: images.length > 0 ? images : undefined,
            hasFiles: files.length > 0,
            fileCount: files.length,
            effort_level: effortLevel !== 'high' ? effortLevel : undefined,
        });

        // Render immediately so user sees their message
        this.renderMessages();

        // Connect if not connected
        if (this.activeSession.status !== 'connected') {
            this.activeSession.connect();
            // Queue the message to send after connection
            const checkConnection = setInterval(() => {
                if (this.activeSession.status === 'connected') {
                    clearInterval(checkConnection);
                    this.activeSession.sendWithImages(messageToSend, images, sendOptions);
                }
            }, 100);
            setTimeout(() => clearInterval(checkConnection), 10000);
            return;
        }

        // Send
        this.activeSession.sendWithImages(messageToSend, images, {});
    }

    /**
     * Handle storage quota exceeded - show warning to user
     * @param {{key: string, usage: Object}} detail
     */
    handleStorageQuotaExceeded(detail) {
        const { usage } = detail;
        console.error('[Storage] Quota exceeded!', usage);

        // Show a visible warning to the user via system log
        if (this.activeSession) {
            this.activeSession.addSystemLog(
                `Storage full (${usage.usedMB}) - tab state may not persist. Use Storage Cleanup in quick actions menu.`,
                'error'
            );
        }

        // Also show a toast
        showToast(S.errors.storage_full);
    }



    /**
     * Rename a session (set/update name)
     */
    async renameSession(session) {
        const currentName = session.name || '';
        const newName = await this.dialogCtrl.showPrompt({
            title: S.ui.rename_dialog.title,
            label: 'Session name',
            value: currentName,
            placeholder: 'Enter a name for this session',
            confirmText: 'Rename',
            cancelText: 'Cancel'
        });

        if (newName !== null && newName !== currentName) {
            session.name = newName.trim() || 'Session';
            // Persist to server
            if (session.storeId) {
                fetch(`/api/sessions/${session.storeId}/meta`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: session.name })
                }).catch(err => console.error('Failed to save session name:', err));
            }
            // Save to localStorage so it persists across page refresh
            this.sessionManager.saveSessions();
            this.tabCtrl.renderTabs();
            showToast(newName ? S.toast.renamed : S.toast.name_reset);
        }
    }

    /**
     * Create a new session with a specific CWD.
     * Used by Duplicate (default toast) and the project-picker (pass `toast: null`).
     * @param {string} cwd - Working directory for the new session
     * @param {object} [opts]
     * @param {string|null} [opts.toast] - Completion toast; pass null to suppress.
     */
    createNewSession(cwd, opts = {}) {
        const { toast = S.toast.session_cloned } = opts;

        const session = this.sessionManager.create({ name: 'New Session' });
        if (session) {
            session.cwd = cwd;
            this.switchSession(session);
            this.renderTabs();
            session.connect();
            this.els.connectionBar.classList.remove('visible');
            this.sessionManager.saveSessions();
            this.addToHistory(cwd);
            this.fileExplorer.setHomePath(cwd);
            this.fetchProjectCommands(cwd);
            if (toast) showToast(toast);
        }
    }

    /**
     * Close all sessions except the given one.
     * Pinned tabs are protected — only an explicit single Close touches them.
     */
    closeOtherSessions(keepSession) {
        const toClose = this.sessionManager.sessions.filter(
            s => s !== keepSession && !this.tabCtrl.isTabPinned('session', s.id));
        toClose.forEach(s => this.closeSession(s));
    }

    /**
     * Close all sessions (except pinned ones — see closeOtherSessions)
     */
    closeAllSessions() {
        const toClose = this.sessionManager.sessions.filter(
            s => !this.tabCtrl.isTabPinned('session', s.id));
        toClose.forEach(s => this.closeSession(s));
    }


    initVisibilitySync() {
        // Track when page was hidden (for debouncing)
        this.hiddenSince = null;

        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') {
                // Page is going to background - SAVE STATE IMMEDIATELY
                // iOS PWA may not fire beforeunload reliably, so save here too
                // Use immediate save to bypass debounce (page may close any moment)
                debug.log('[App] visibilitychange:hidden - saving state');
                this.hiddenSince = Date.now();
                // Save current upload state to active session before serialization
                if (this.activeSession && this.uploadManager) {
                    const uploadState = this.uploadManager.saveState();
                    this.activeSession.pendingImages = uploadState.pendingImages;
                    this.activeSession.pendingFiles = uploadState.pendingFiles;
                }
                this.sessionManager.saveSessionsImmediate();
                this.tabCtrl?.saveWidgetTabs();
            } else if (document.visibilityState === 'visible') {
                // Page is coming back to foreground
                const hiddenDuration = this.hiddenSince ? Date.now() - this.hiddenSince : 0;
                this.hiddenSince = null;

                // Only act if hidden for >1 second (avoid rapid tab switches)
                if (hiddenDuration > 1000) {
                    // ALWAYS re-render when returning from background
                    // iOS Safari throttles/pauses DOM updates in background, so even if
                    // WebSocket messages arrived and were added to this.messages array,
                    // the DOM may be stale. Re-render ensures UI matches state.
                    if (this.activeSession) {
                        debug.log('[VisibilitySync] Re-rendering after background (hidden for', hiddenDuration, 'ms)');
                        // Capture the live scroll offset BEFORE the forced re-render
                        // nukes the container: an at-bottom reader lands back at the
                        // bottom, a scrolled-up reader keeps their place. scrollPosition
                        // is consumed one-shot by restoreScrollPosition().
                        const scrollEl = this.getActiveScrollContainer();
                        if (scrollEl && scrollEl.clientHeight > 0) {
                            const atBottom = (scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight) <= 100;
                            this.activeSession.scrollPosition = atBottom ? null : scrollEl.scrollTop;
                            this.activeSession.isUserScrolledUp = !atBottom;
                        }
                        // CRITICAL: Invalidate container pool to force full re-render
                        // Without this, the pool thinks container is already rendered and returns cached (stale) DOM
                        const sessionId = this.activeSession.id || this.activeSession.storeId || this.activeSession.sessionId;
                        this.chatCtrl?.invalidateSession(sessionId);
                        this.renderMessages();
                        this.scrollToBottom();
                    }

                    // Re-establish live sockets. iOS freezes the per-session
                    // keepalive interval while backgrounded, so the half-open
                    // detector can't be relied on after resume — kick a liveness
                    // check on every session (reconnects zombie/half-open sockets
                    // that still report readyState OPEN). Without this, the chat
                    // WebSocket can stay wedged forever after inactivity and even
                    // a reload won't recover (frozen network stack / stuck timers).
                    this.sessionManager.sessions.forEach(s => s.checkLiveness?.());

                    // Also sync to catch any messages we missed entirely
                    // (e.g., if WebSocket disconnected while in background)
                    this.syncAllSessions();
                }
            }
        });
    }

    // fullSync=true fetches all messages (used on page load to update incomplete tool outputs)
    async syncAllSessions(fullSync = false) {
        debug.log(`[SyncAll DEBUG] syncAllSessions called, fullSync=${fullSync}`);
        const sessionsToSync = this.sessionManager.sessions.filter(s => s.storeId);
        debug.log(`[SyncAll DEBUG] Sessions to sync: ${sessionsToSync.length}`, sessionsToSync.map(s => s.storeId));
        if (sessionsToSync.length === 0) return;

        this.activeSession?.addSystemLog(S.status.syncing, 'info');

        const results = await Promise.all(
            sessionsToSync.map(s => s.syncMessages(fullSync))
        );

        const totalSynced = results.reduce((sum, r) => sum + r.synced, 0);
        const errors = results.filter(r => r.error);

        if (totalSynced > 0) {
            this.activeSession?.addSystemLog(S.status.synced.replace('{count}', totalSynced), 'info');
        } else if (errors.length === 0) {
            this.activeSession?.addSystemLog(S.status.up_to_date, 'info');
        }

        if (errors.length > 0) {
            this.activeSession?.addSystemLog(S.status.sync_failed.replace('{count}', errors.length), 'error');
        }
    }


    /**
     * Update autocomplete with slash commands from Claude's system init
     * Called when session receives init message with slash_commands array
     * @param {Array} commandNames - ["todo", "compact", "cost", ...] (names without /)
     * @param {Object} [descriptions] - {name: "description"} from server
     */
    updateSlashCommands(commandNames, descriptions) {
        this.commandDescriptions = descriptions || this.commandDescriptions || {};
        this.autocomplete.setAgentCommands(commandNames, this.userCommandNames, this.commandDescriptions);
        debug.log(`Loaded ${commandNames?.length || 0} slash commands from Claude`);
    }

    /**
     * Fetch cached project commands from server
     * Commands are cached per-project so new sessions can show them before Claude starts
     * @param {string} cwd - Project directory path
     */
    async fetchProjectCommands(cwd) {
        if (!cwd) return;
        try {
            const response = await fetch(`${CONFIG.API_BASE}/api/project/commands?cwd=${encodeURIComponent(cwd)}`);
            if (response.ok) {
                const data = await response.json();
                if (data.user_commands?.length > 0) {
                    this.userCommandNames = new Set(data.user_commands);
                }
                if (data.commands?.length > 0) {
                    this.updateSlashCommands(data.commands, data.descriptions);
                    // Also update session's slashCommands for persistence
                    if (this.activeSession) {
                        this.activeSession.slashCommands = data.commands;
                    }
                    debug.log(`Loaded ${data.commands.length} cached project commands for ${cwd}`);
                }
                // Source paths for commands whose definition lives in a .md file
                // (used by the commands gallery to offer "View source").
                if (data.sources) {
                    this.commandSources = data.sources;
                }
            }
        } catch (error) {
            debug.warn('Failed to fetch project commands:', error);
        }
    }

    /**
     * Fetch git branch for current project
     * Updates status bar with branch name
     * @param {string} cwd - Project directory path
     */
    async fetchGitBranch(cwd) {
        if (!cwd) {
            this.statusBar.updateBranch(null);
            return;
        }
        try {
            const response = await fetch(`${CONFIG.API_BASE}/api/git/status?cwd=${encodeURIComponent(cwd)}`);
            if (response.ok) {
                const data = await response.json();
                this.statusBar.updateBranch(data.branch || null);
            } else {
                // Not a git repo or error - hide branch
                this.statusBar.updateBranch(null);
            }
        } catch (error) {
            debug.warn('Failed to fetch git branch:', error);
            this.statusBar.updateBranch(null);
        }
    }



    /**
     * Initialize type-anywhere search: typing with input unfocused auto-focuses and searches.
     * Only active on welcome screen with physical keyboard.
     * Like macOS Finder or VS Code - just start typing to search.
     */
    _initTypeAnywhereSearch() {
        // Only on devices with physical keyboard
        debug.log('[TypeAnywhere] Init check - HAS_PHYSICAL_KEYBOARD:', HAS_PHYSICAL_KEYBOARD, 'UA:', navigator.userAgent.substring(0, 50));
        if (!HAS_PHYSICAL_KEYBOARD) {
            debug.log('[TypeAnywhere] DISABLED - no physical keyboard detected');
            return;
        }
        debug.log('[TypeAnywhere] Handler registered');

        // Click-to-blur: clicking welcome screen background blurs the input
        this.els.welcomeView?.addEventListener('click', (e) => {
            // Only if clicking on welcome background (not on cards, buttons, etc.)
            const target = e.target;
            if (target.closest('.welcome-recent-card, .session-family, button, a, input, .welcome-project-picker, .welcome-hint')) {
                return;
            }

            // Blur the message input
            if (document.activeElement === this.els.messageInput) {
                this.els.messageInput.blur();
            }
        });

        // Type-anywhere: typing on welcome screen with input unfocused triggers quick search
        document.addEventListener('keydown', (e) => {
            // Only single printable characters (check early to reduce noise).
            // e.key can be undefined on iPadOS WKWebView synthetic events
            // (autofill / QuickType / IME) — optional-chain so those fall out.
            if (e.key?.length !== 1) return;

            // Don't capture modifier combos (those are shortcuts)
            if (e.ctrlKey || e.metaKey || e.altKey) return;

            // Only on welcome screen
            if (!this.chatCtrl?.isWelcomeShowing()) {
                return;
            }

            // Already focused on input - let normal typing work
            if (document.activeElement === this.els.messageInput) {
                return;
            }

            // Don't capture if focused on another input/textarea/editable (including quick search)
            if (document.activeElement?.matches('input, textarea, [contenteditable="true"]')) {
                return;
            }

            // Don't capture if widget/modal is open (use class-based detection)
            const hasOpenOverlay = document.querySelector(
                '#modal-overlay.visible, .quick-actions-overlay.visible, ' +
                '.session-context-overlay, .session-preview-overlay, ' +
                '.config-modal-overlay, .prompt-dialog-overlay'
            );
            if (hasOpenOverlay) {
                return;
            }

            // Don't capture space alone (might be scrolling) - unless quick search is already active
            if (e.key === ' ' && !isQuickSearchActive()) return;

            // Capture the keystroke
            e.preventDefault();
            e.stopPropagation();

            // Type into inline quick search
            typeIntoQuickSearch(e.key);
        });
    }

    // ═══════════════════════════════════════════════════════════════
    // SESSION MANAGEMENT
    // ═══════════════════════════════════════════════════════════════

    /**
     * Initialize long-press handler for new tab button
     * Long press shows menu: New Session vs New Terminal
     */
    initNewTabLongPress() {
        const btn = this.els.newTabBtn;
        let pressTimer = null;
        let clickBlocker = null;
        let menuShown = false;

        const removeClickBlocker = () => {
            if (clickBlocker) {
                document.removeEventListener('click', clickBlocker, { capture: true });
                clickBlocker = null;
            }
        };

        const showNewTabMenu = (x, y) => {
            menuShown = true;
            const menuItems = [
                {
                    label: S.context_menus.project.new_session,
                    action: () => this.createSession()
                },
                {
                    label: S.context_menus.project.new_terminal,
                    action: () => this.tabCtrl.openTerminalWidgetTab()
                },
                {
                    label: S.context_menus.project.new_browser,
                    action: () => WidgetManager.open('browser')
                },
                {
                    label: S.context_menus.project.new_draft,
                    action: () => this.createScratchTab()
                }
            ];

            // Add recently closed sessions if any
            const recentlyClosed = this.sessionManager.recentlyClosed;
            if (recentlyClosed.length > 0) {
                menuItems.push({ separator: true });
                menuItems.push({
                    label: S.context_menus.project.reopen,
                    submenu: recentlyClosed.slice().reverse().map(closed => ({
                        label: closed.name || basename(closed.cwd) || 'Session',
                        sublabel: closed.cwd,
                        action: () => this.reopenClosedSession(closed.storeId)
                    }))
                });
            }

            this.contextMenu.show(x, y, menuItems);
        };

        // Long-press for touch devices (iOS)
        // Non-passive to allow preventDefault() which suppresses iOS text selection
        btn.addEventListener('touchstart', (e) => {
            removeClickBlocker();
            menuShown = false;

            const touch = e.touches[0];
            const startX = touch.clientX;
            const startY = touch.clientY;

            pressTimer = setTimeout(() => {
                // Create click blocker BEFORE showing menu
                clickBlocker = (evt) => {
                    evt.preventDefault();
                    evt.stopPropagation();
                    evt.stopImmediatePropagation();
                };
                document.addEventListener('click', clickBlocker, { capture: true });

                // Clear any iOS text selection triggered during long-press
                window.getSelection()?.removeAllRanges();

                // Show menu below the button
                const rect = btn.getBoundingClientRect();
                showNewTabMenu(startX, rect.bottom + 4);
            }, 400);
        }, { passive: false });

        btn.addEventListener('touchend', (e) => {
            if (pressTimer) {
                clearTimeout(pressTimer);
                pressTimer = null;
            }
            if (menuShown) {
                e.preventDefault();
                e.stopPropagation();
                setTimeout(removeClickBlocker, 400);
            }
        }, { passive: false });

        btn.addEventListener('touchmove', () => {
            if (pressTimer) {
                clearTimeout(pressTimer);
                pressTimer = null;
            }
        }, { passive: true });

        // Right-click for desktop
        btn.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            showNewTabMenu(e.clientX, e.clientY);
        });
    }


    // ═══════════════════════════════════════════════════════════════
    // VIEW SWITCHING (delegated to TabController)
    // ═══════════════════════════════════════════════════════════════

    /** @delegate TabController */
    getAllTabs() { return this.tabCtrl.getAllTabs(); }

    /** @delegate TabController */
    getCurrentTabIndex() { return this.tabCtrl.getCurrentTabIndex(); }

    /** @delegate TabController */
    switchToTabByIndex(index) { this.tabCtrl.switchToTabByIndex(index); }

    /** @delegate TabController */
    cycleTab(direction) { this.tabCtrl.cycleTab(direction); }

    /** @delegate TabController */
    switchToSession(session) { this.tabCtrl.switchToSession(session); }

    // ═══════════════════════════════════════════════════════════════
    // WIDGET TABS (delegated to TabController)
    // ═══════════════════════════════════════════════════════════════

    /** @delegate TabController */
    createTerminal() {
        if (!terminalAvailable()) {
            showToast(S.toast.terminal_unavailable);
            return;
        }
        try {
            this.tabCtrl.openTerminalWidgetTab();
        } catch (e) {
            this.activeSession?.addSystemLog(e.message, 'error');
        }
    }

    /**
     * Open a terminal tab running the provider's interactive login flow.
     * Used by the `/login` slash command and the auth-error card — the in-app
     * `/login` is interactive-only, so we drop the user into a PTY where the
     * OAuth/device flow works as designed. `command` (from the auth_error
     * frame's `login_command`) wins; otherwise the active session's provider is
     * resolved via the registry (`/api/app/provider-auth`), falling back to
     * `claude auth login`.
     */
    async openLoginTerminal(command = null) {
        if (!terminalAvailable()) {
            // No PTY on this server (native Windows) — the user runs the
            // login command in their own console instead.
            showToast(S.toast.terminal_unavailable_login);
            return;
        }
        try {
            if (!command) {
                const provider = this.activeSession?.provider || this.activeSession?.pendingProvider;
                if (provider) {
                    try {
                        const resp = await fetch(`/api/app/provider-auth/${encodeURIComponent(provider)}`);
                        if (resp.ok) command = (await resp.json()).login_command || null;
                    } catch { /* fall through to the claude default */ }
                }
            }
            this.tabCtrl.openTerminalWidgetTab({
                title: 'Login',
                icon: 'terminal',
                initialCommand: `${command || 'claude auth login'}\n`,
            });
        } catch (e) {
            this.activeSession?.addSystemLog(e.message, 'error');
        }
    }

    /** Open a terminal tab running `claude auth logout`. Mirror of openLoginTerminal. */
    openLogoutTerminal() {
        try {
            this.tabCtrl.openTerminalWidgetTab({
                title: 'Logout',
                icon: 'terminal',
                initialCommand: 'claude auth logout\n',
            });
        } catch (e) {
            this.activeSession?.addSystemLog(e.message, 'error');
        }
    }

    /** @delegate TabController - called during init */
    initWidgetTabEvents() { this.tabCtrl.initWidgetTabEvents(); }

    /** @delegate TabController */
    openTerminalWidgetTab(options) { return this.tabCtrl.openTerminalWidgetTab(options); }

    /** @delegate TabController */
    openWidgetAsTab(widgetId, title, icon) { this.tabCtrl.openWidgetAsTab(widgetId, title, icon); }

    /** @delegate TabController */
    switchToWidgetTab(tabId) { this.tabCtrl.switchToWidgetTab(tabId); }

    /** @delegate TabController */
    closeWidgetTab(tabId) { this.tabCtrl.closeWidgetTab(tabId); }


    async connectActiveSession(cwd = this.activeSession?.cwd) {
        if (!this.activeSession) return;
        // Prevent connecting if already connected or connecting
        if (this.activeSession.status !== 'disconnected') return;

        cwd = (cwd || '').trim();
        if (!cwd) {
            this.activeSession?.addSystemLog(S.errors.enter_directory);
            return;
        }

        // Expand paths: ~ to home, relative paths to projects base
        let expandedCwd = cwd;
        if (cwd.startsWith('~')) {
            expandedCwd = cwd.replace('~', CONFIG.HOME);
        } else if (!isAbsolutePath(cwd, CONFIG.HOME)) {
            // Relative path - make it relative to projects base
            expandedCwd = joinPath(CONFIG.PROJECTS_BASE, cwd);
        }

        // Check if directory exists
        try {
            const response = await fetch(`${CONFIG.API_BASE}/api/check-dir?path=${encodeURIComponent(expandedCwd)}`);
            const data = await response.json();

            if (!data.exists) {
                // Show confirm dialog to create directory
                this.pendingCwd = data.path;
                this.showConfirmDialog(data.path);
                return;
            }

            if (!data.is_dir) {
                // It's a file - open it in the appropriate viewer
                this.els.connectionBar.classList.remove('visible');
                this.previewFile(data.path);
                return;
            }

            // Directory exists, connect (use resolved path from server)
            this.activeSession.cwd = data.path;
            this.activeSession.connect();
            this.els.connectionBar.classList.remove('visible');
            // cwd is now set → predicate is false → switchToSession lands in chat
            this.tabCtrl.switchToSession(this.activeSession);
            this.sessionManager.saveSessions();
            // Save to history
            this.addToHistory(data.path);
            // Update file explorer's home path
            this.fileExplorer.setHomePath(data.path);
            // Fetch cached project commands (so autocomplete works before Claude starts)
            this.fetchProjectCommands(data.path);
        } catch (error) {
            console.error('Error checking directory:', error);
            // If we can't check, just try to connect anyway
            this.activeSession.cwd = expandedCwd;
            this.activeSession.connect();
            this.els.connectionBar.classList.remove('visible');
            this.tabCtrl.switchToSession(this.activeSession);
            this.fetchProjectCommands(expandedCwd);
            this.sessionManager.saveSessions();
            this.addToHistory(expandedCwd);
            this.fileExplorer.setHomePath(expandedCwd);
        }
    }

    addToHistory(cwd) {
        const history = Storage.get(CONFIG.HISTORY_KEY, []);
        const filtered = history.filter(h => h !== cwd);
        filtered.unshift(cwd);
        Storage.set(CONFIG.HISTORY_KEY, filtered.slice(0, CONFIG.MAX_HISTORY));
    }

    getCwdHistory() {
        return Storage.get(CONFIG.HISTORY_KEY, []);
    }

    // ═══════════════════════════════════════════════════════════════
    // RENDERING
    // ═══════════════════════════════════════════════════════════════

    /** @delegate TabController */
    renderTabs() { this.tabCtrl.renderTabs(); }

    /** @delegate ChatController */
    renderMessages() {
        this.chatCtrl.renderMessages();
    }

    /**
     * Render the welcome screen for a session inside #welcome-view.
     * Per-session container preserves DOM (and therefore scroll position) when
     * switching tabs, mirroring SessionContainerPool's strategy for chat.
     */
    renderWelcome(session) {
        if (!session || !this.els.welcomeView) return;

        const sessionId = session.id || session.storeId;
        const root = this.els.welcomeView;

        // Hide / un-id all existing instances
        for (const child of root.children) {
            child.style.display = 'none';
            if (child.id === 'welcome-container') child.removeAttribute('id');
        }

        // Find-or-create the per-session container
        let container = root.querySelector(`[data-session-id="${CSS.escape(String(sessionId))}"]`);
        const isNew = !container;
        if (isNew) {
            container = document.createElement('div');
            container.className = 'welcome-container-instance';
            container.dataset.sessionId = sessionId;
            root.appendChild(container);
        }

        // Show + mark as the active welcome-container (welcome.js querySelectors hit this one)
        container.style.display = '';
        container.id = 'welcome-container';

        if (isNew) {
            initWelcomeScreen(container, sessionId);
        }

        // No back-to-sessions pill from welcome
        this.chatCtrl?._hideBackToSessionsPill?.();
    }

    /** @delegate ChatController */
    restoreScrollPosition() {
        this.chatCtrl.restoreScrollPosition();
        this.isUserScrolledUp = !this.isNearBottom();
    }

    /** @delegate ChatController */
    async renderRecentProjects(container) {
        this.chatCtrl.renderRecentProjects(container);
    }

    /** @delegate ChatController */
    prependMessages(messages) {
        this.chatCtrl.prependMessages(messages);
    }

    /** @delegate ChatController */
    createMessageElement(msg) {
        return this.chatCtrl.createMessageElement(msg);
    }

    /** @delegate ThinkingController */
    createThinkingGroupElement(thinkingGroup) {
        return this.thinkingCtrl.createThinkingGroupElement(thinkingGroup);
    }

    /** @delegate ChatController */
    async handleScrollTop() {
        this.chatCtrl.handleScrollTop();
    }

    /** @delegate ChatController */
    updateHistoryNotice() {
        this.chatCtrl.updateHistoryNotice();
    }

    /** @delegate ChatController */
    showLoadMoreIndicator(show) {
        this.chatCtrl.showLoadMoreIndicator(show);
    }

    /** @delegate ChatController */

    updateInputState() {
        const connected = this.activeSession?.status === 'connected';
        const welcomeShowing = this.chatCtrl?.isWelcomeShowing();

        // Enable input when connected OR when welcome screen allows search
        const inputEnabled = connected || welcomeShowing;
        const wasDisabled = this.els.messageInput.disabled;

        this.els.inputContainer.classList.toggle('disabled', !inputEnabled);
        this.els.messageInput.disabled = !inputEnabled;

        // When disabling: blur the input to remove false focus state (Safari/iPad bug)
        // Without this, the input can show blue border but not accept typing
        if (!inputEnabled && document.activeElement === this.els.messageInput) {
            this.els.messageInput.blur();
        }

        // When enabling: auto-focus on desktop (don't pop up keyboard on mobile)
        // But NOT on welcome screen - the input area is hidden there, use search bar instead
        if (inputEnabled && wasDisabled && HAS_PHYSICAL_KEYBOARD && !welcomeShowing) {
            // Use requestAnimationFrame to ensure DOM is ready after any renders
            requestAnimationFrame(() => this.focusInput());
        }

        const hasContent = this.els.messageInput.value.trim() || Stash.hasEnabled();
        const welcomeSearchEnabled = welcomeShowing && this.els.messageInput.value.trim();

        this.els.sendBtn.disabled = !hasContent || (!connected && !welcomeSearchEnabled);
        if (this.els.followupBtn) this.els.followupBtn.disabled = this.els.sendBtn.disabled;

        // Update placeholder
        this.updateInputPlaceholder();
    }

    /**
     * Update input placeholder. Plan mode is signalled by the permission
     * button alone — the input keeps its default placeholder and shortcut
     * hints so the empty-input cheat sheet still appears.
     */
    updateInputPlaceholder() {
        if (!this.els.messageInput) return;

        const pendingCount = this.activeSession?.pendingBangOutputs?.length || 0;

        if (pendingCount > 0) {
            this.els.messageInput.placeholder = `${pendingCount} command${pendingCount > 1 ? 's' : ''} buffered. Type message and press Enter...`;
        } else {
            this.els.messageInput.placeholder = S.ui.input.placeholder;
        }
    }

    /**
     * Set activity state via ActivityStrip (replaces old typing dots).
     * @param {{ active: boolean, icon?: string, text?: string }} activity
     */
    setActivity(activity) {
        if (activity.active) {
            this.activityStrip?.show(activity);
            // Strip appearing adds height — scroll after CSS transition (250ms).
            // respectLinkHover: fires on every tool/status change during a
            // turn, and must not yank a link out from under the pointer.
            if (!this.isUserScrolledUp) {
                setTimeout(() => this.scrollManager?.scrollToBottomForce({ respectLinkHover: true }), 300);
            }
        } else {
            this.activityStrip?.hide();
        }
        // Toggle send/stop buttons
        this.statusBar?.toggleStopButton(activity.active);
    }

    /**
     * Backward-compat wrapper: setTyping(bool, statusText) → setActivity()
     */
    setTyping(typing, statusText = null) {
        if (typing) {
            const label = statusText || 'Working...';
            const icon = statusText === 'Compacting...' ? 'compress' : 'sparkle';
            this.setActivity({ active: true, icon, label });
        } else {
            this.setActivity({ active: false });
        }
    }

    /** Compatibility getter for isTyping */
    get isTyping() {
        return this.statusBar?.isTyping ?? false;
    }

    /** Compatibility setter for isTyping */
    set isTyping(value) {
        if (this.statusBar) {
            this.statusBar.isTyping = value;
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // TAB STATE (delegated to TabController)
    // ═══════════════════════════════════════════════════════════════

    /** Widget tabs array from TabController */
    get widgetTabs() {
        return this.tabCtrl?.widgetTabs || [];
    }

    /** Active widget tab ID from TabController */
    get activeWidgetTabId() {
        return this.tabCtrl?.activeWidgetTabId;
    }

    /** Active mode (session/editor/widget) from TabController */
    get activeMode() {
        return this.tabCtrl?.activeMode || 'session';
    }

    /** @deprecated Use toolRenderer.formatThinkingToolInput() */
    formatThinkingToolInput(toolName, input) {
        return this.toolRenderer.formatThinkingToolInput(toolName, input);
    }

    /** @delegate ThinkingController */
    renderToolOutput(content, isCompleted = false, threshold = 5) {
        return this.thinkingCtrl.renderToolOutput(content, isCompleted, threshold);
    }

    /** @delegate ThinkingController */
    renderThinkingEdits(thinkingMsgs) {
        return this.thinkingCtrl.renderThinkingEdits(thinkingMsgs);
    }

    // ═══════════════════════════════════════════════════════════════
    // STATUS (delegated to StatusBar)
    // ═══════════════════════════════════════════════════════════════

    /** Update connection status display */
    updateStatus() {
        this.statusBar?.updateStatus();
        // Fresh-session setup pills ride the same funnel (cheap no-op once
        // the first message exists / on non-fresh tabs).
        sessionSetupPanel.refresh();
    }

    // ═══════════════════════════════════════════════════════════════
    // SCROLL MANAGEMENT (delegated to ScrollManager)
    // ═══════════════════════════════════════════════════════════════

    /** @deprecated Use scrollManager.isNearBottom() */
    isNearBottom() {
        return this.scrollManager?.isNearBottom() ?? true;
    }

    /** @deprecated Use scrollManager.scrollToBottom() */
    scrollToBottom() {
        this.scrollManager?.scrollToBottom();
    }

    /** @deprecated Use scrollManager.trackNewMessage() */
    trackNewMessage() {
        this.scrollManager?.trackNewMessage();
    }

    /** @deprecated Use scrollManager.scrollToBottomForce() */
    scrollToBottomForce() {
        this.scrollManager?.scrollToBottomForce();
    }

    /** @deprecated Use scrollManager.clearIndicator() */
    clearNewMessagesIndicator() {
        this.scrollManager?.clearIndicator();
    }

    /** Compatibility getter for isUserScrolledUp */
    get isUserScrolledUp() {
        return this.scrollManager?.isUserScrolledUp ?? false;
    }

    /** Compatibility setter for isUserScrolledUp */
    set isUserScrolledUp(value) {
        if (this.scrollManager) {
            this.scrollManager.isUserScrolledUp = value;
        }
    }

    /**
     * Update the floating question indicator
     * Call when question state changes (added/answered)
     */
    updateQuestionIndicator() {
        if (!this.scrollManager || !this.activeSession) return;
        const questionMsg = this.activeSession.messages.find(m => (m.role === 'question' || m.role === 'permission') && !m.answered);
        this.scrollManager.updateQuestionIndicator(questionMsg || null);
    }

    // ═══════════════════════════════════════════════════════════════
    // COMMANDS
    // ═══════════════════════════════════════════════════════════════
    // DIALOGS (delegated to DialogController)
    // ═══════════════════════════════════════════════════════════════

    /** @delegate DialogController */
    showHelp() {
        this.dialogCtrl.showHelp();
    }

    /** @delegate DialogController */
    hideModal() {
        this.dialogCtrl.hideModal();
    }

    /**
     * Clear session: archive current session (keep for browsing), start fresh in same project.
     * Unlike the old behavior which destroyed messages, this preserves the session history.
     */
    clearMessages() {
        const session = this.activeSession;
        if (!session?.cwd) {
            showToast(S.errors.no_project_clear);
            return;
        }

        const cwd = session.cwd;

        // Remove current session from local list (disconnects WS, keeps server data intact)
        this.sessionManager.remove(session);

        // Create new session with same CWD
        const newSession = this.sessionManager.create({ name: 'New Session' });
        if (newSession) {
            newSession.cwd = cwd;
            this.switchSession(newSession);
            this.renderTabs();
            newSession.connect();
            this.els.connectionBar.classList.remove('visible');
            this.sessionManager.saveSessions();
            this.addToHistory(cwd);
            this.fileExplorer.setHomePath(cwd);
            this.fetchProjectCommands(cwd);
            showToast(S.status.starting_fresh);
        }
    }


    /** @delegate DialogController */
    showConfirmDialog(path) {
        this.dialogCtrl.showConfirmDialog(path);
        this.pendingCwd = path;  // Keep for backward compatibility
    }

    /** @delegate DialogController */
    hideConfirmDialog() {
        this.dialogCtrl.hideConfirmDialog();
        this.pendingCwd = null;
    }

    /** @delegate DialogController */
    async createDirectoryAndConnect() {
        this.dialogCtrl.createDirectoryAndConnect();
    }

    // ═══════════════════════════════════════════════════════════════
    // FILE & IMAGE UPLOAD (delegated to UploadManager)
    // ═══════════════════════════════════════════════════════════════

    initImageUpload() {
        // Initialize UploadManager (replaces old inline implementation)
        this.uploadManager = new UploadManager(
            {
                inputContainer: this.els.inputContainer,
                messageInput: this.els.messageInput,
                messagesContainer: this.els.messagesContainer,
                sendBtn: this.els.sendBtn
            },
            { apiBase: CONFIG.API_BASE },
            {
                getSessionId: () => this.activeSession?.storeId,
                isConnected: () => this.activeSession?.status === 'connected',
                onError: (msg) => this.activeSession?.addSystemLog(msg, 'error'),
                onStateChange: () => {
                    this.updateSendButtonState();
                    // Uploads settled — release a send that was parked mid-upload
                    this.inputHandler?.flushDeferredSend();
                }
            }
        );
    }

    /** @deprecated Use uploadManager.getPendingImages() */
    get pendingImages() {
        return this.uploadManager?.pendingImages || [];
    }

    /** @deprecated Use uploadManager.getPendingFiles() */
    get pendingFiles() {
        return this.uploadManager?.pendingFiles || [];
    }

    /** @deprecated Use uploadManager.clearImages() */
    clearPendingImages() {
        this.uploadManager?.clearImages();
    }

    /** @deprecated Use uploadManager.clearFiles() */
    clearPendingFiles() {
        this.uploadManager?.clearFiles();
    }

    updateSendButtonState() {
        // In-flight uploads count as content: the user should be able to hit
        // send mid-upload and have it queue (InputHandler defers it) rather
        // than face a dead button or send the message without the attachment.
        const hasContent = this.els.messageInput.value.trim() ||
                          this.uploadManager?.hasPending ||
                          this.uploadManager?.isUploading ||
                          Stash.hasEnabled();
        const connected = this.activeSession?.status === 'connected';

        // Enable send button for welcome search even when disconnected
        const welcomeSearchEnabled = this.chatCtrl?.isWelcomeShowing() &&
                                     this.els.messageInput.value.trim();

        // A send parked on an in-flight upload keeps the button disabled. This
        // method runs on every upload progress tick, so without the check it
        // would re-enable the button underneath the parked send and invite a
        // second Enter that only re-arms the same deferral.
        const awaitingUpload = this.inputHandler?.isAwaitingUpload() || false;

        this.els.sendBtn.disabled = awaitingUpload || !hasContent ||
                                    (!connected && !welcomeSearchEnabled);
        if (this.els.followupBtn) this.els.followupBtn.disabled = this.els.sendBtn.disabled;
    }

    openImageUpload() {
        this.uploadManager?.openImagePicker();
    }

    openFileUpload() {
        this.uploadManager?.openFilePicker();
    }

    // ═══════════════════════════════════════════════════════════════
    // UTILITIES
    // ═══════════════════════════════════════════════════════════════

    // ═══════════════════════════════════════════════════════════════
    // SHORTCUT ACTION METHODS
    // These methods are called by ShortcutManager
    // ═══════════════════════════════════════════════════════════════

    goToPreviousUserMessage() {
        this.chatNavigator?.goToPrevious();
    }

    goToNextUserMessage() {
        this.chatNavigator?.goToNext();
    }

    toggleTerminalPanel() {
        if (!terminalAvailable()) {
            showToast(S.toast.terminal_unavailable);
            return;
        }
        WidgetManager.toggle('terminal');
    }

    /**
     * Handle trim messages action (via FAB quick action).
     * Removes old messages from DOM for better scroll performance.
     * Keeps at least 100 messages, and always preserves the complete last turn.
     */
    handleTrimMessages() {
        const trimCount = this.chatCtrl?.getTrimCount();  // Uses default 100, preserves last turn
        if (!trimCount || trimCount === 0) {
            this.activeSession?.addSystemLog(S.errors.no_messages_trim, 'info');
            return;
        }

        // Perform the trim (uses default 100, preserves last turn)
        const trimmed = this.chatCtrl.trimOldMessages();
        if (trimmed > 0) {
            this.activeSession?.addSystemLog(`Trimmed ${trimmed} old messages. Scroll up to reload.`, 'info');
        }
    }

    /**
     * Send key to the active terminal (tab or floating panel)
     * Used by keyboard bar to inject special keys
     */
    sendKeyToActiveTerminal(key, modifiers = {}) {
        // Map special keys to escape sequences
        const keyMap = {
            'Escape': '\x1b',
            'Tab': '\t',
            'ArrowUp': '\x1b[A',
            'ArrowDown': '\x1b[B',
            'ArrowRight': '\x1b[C',
            'ArrowLeft': '\x1b[D',
            'Home': '\x1b[H',
            'End': '\x1b[F',
            'PageUp': '\x1b[5~',
            'PageDown': '\x1b[6~',
            'Delete': '\x1b[3~',
            'Backspace': '\x7f',
        };

        let data = keyMap[key] || key;

        // Apply Ctrl modifier for single characters
        if (modifiers.ctrl && data.length === 1) {
            const code = data.toLowerCase().charCodeAt(0);
            if (code >= 97 && code <= 122) {
                data = String.fromCharCode(code - 96);
            }
        }

        // Send to terminal widget
        const ws = TerminalWidget.getWebSocket();
        if (ws?.readyState === WebSocket.OPEN) {
            ws.send(data);
        }
    }


    closeActiveTab() {
        // First: close topmost floating widget if any are visible
        // Unlike ESC, Ctrl+W should always close terminal (no passthrough to vim/nano)
        if (WidgetManager.closeTopmost({ allowTerminalPassthrough: false })) {
            return;
        }

        // Then: close tabs (widget tab in tab bar, or session tab)
        if (this.activeMode === 'widget' && this.activeWidgetTabId) {
            this.closeWidgetTab(this.activeWidgetTabId);
        } else if (this.activeSession) {
            this.closeSession(this.activeSession);
        }
    }

    /**
     * Reopen the most recently closed tab (Ctrl+Shift+T).
     * Merges session and widget-tab stacks — whichever was closed last wins.
     */
    async reopenLastClosedTab() {
        const sessionStack = this.sessionManager.recentlyClosed;
        const tabStack = this.tabCtrl?.recentlyClosedTabs || [];
        if (sessionStack.length === 0 && tabStack.length === 0) {
            return;
        }

        const topSession = sessionStack[sessionStack.length - 1];
        const topTab = tabStack[tabStack.length - 1];
        const tabWins = topTab && (!topSession || topTab.closedAt > topSession.closedAt);

        if (tabWins) {
            tabStack.pop();
            if (topTab.widgetId === 'file-preview' && topTab.filePath) {
                const tabId = this.tabCtrl.openFilePreviewTab(topTab.filePath, topTab.title, { newTab: true });
                // Creation appends to the strip end — slide it back to its old slot
                if (tabId) this.tabCtrl.insertTabAt('widget', tabId, topTab.stripIndex);
            }
            return;
        }

        const closedData = sessionStack.pop();

        // Check if this session is already open
        const existing = this.sessionManager.sessions.find(s => s.storeId === closedData.storeId);
        if (existing) {
            this.switchSession(existing);
            return;
        }

        // Load session from server (fetches messages, metadata, then switches)
        const loaded = await this.loadSessionFromServer(closedData.storeId);
        // loadSessionFromServer resolves to a boolean — re-find the session it made
        const reopened = loaded && this.sessionManager.sessions.find(s => s.storeId === closedData.storeId);
        if (reopened) {
            this.tabCtrl?.insertTabAt('session', reopened.id, closedData.stripIndex);
        }
        if (loaded && this.activeSession) {
            // Auto-connect after loading
            if (this.activeSession.status === 'disconnected') {
                this.activeSession.connect();
            }
        }
    }

    /**
     * Reopen a specific closed session by storeId (from + button menu)
     */
    async reopenClosedSession(storeId) {
        // Find and remove from recentlyClosed stack
        const idx = this.sessionManager.recentlyClosed.findIndex(c => c.storeId === storeId);
        if (idx === -1) return;

        const [closedData] = this.sessionManager.recentlyClosed.splice(idx, 1);

        // Check if already open
        const existing = this.sessionManager.sessions.find(s => s.storeId === storeId);
        if (existing) {
            this.switchSession(existing);
            return;
        }

        // Load session from server (fetches messages, metadata, then switches)
        const loaded = await this.loadSessionFromServer(storeId);
        const reopened = loaded && this.sessionManager.sessions.find(s => s.storeId === storeId);
        if (reopened) {
            this.tabCtrl?.insertTabAt('session', reopened.id, closedData.stripIndex);
        }
        if (loaded && this.activeSession) {
            // Auto-connect after loading
            if (this.activeSession.status === 'disconnected') {
                this.activeSession.connect();
            }
        }
    }

    handleEscape() {
        // Priority order: zen mode > selection mode > FAB menu > context menu > legacy dialogs > close widgets > CWD autocomplete > file autocomplete > command autocomplete > close search > file explorer > stop Claude
        // This ensures dialogs, widgets and autocompletes close before stopping Claude

        // 0. Cancel input Tab-cycle (must run before autocomplete-hide branches —
        // those would dismiss the popup but leave the inserted trigger char and
        // active toolbar highlight stranded).
        if (this.inputHandler?.isTabCycleActive?.()) {
            this.inputHandler.cancelTabCycle();
            return;
        }

        // 0. Close grid switcher overlay (highest priority — full-screen modal)
        if (this.gridSwitcher?.visible) {
            this.gridSwitcher.hide();
            return;
        }

        // 0. Close mid-text autocomplete pickers if open (skills `$`, snippets `#`, files `@`)
        if (this.skillsAutocomplete?.visible) {
            this.skillsAutocomplete.hide();
            return;
        }
        if (this.snippetsAutocomplete?.visible) {
            this.snippetsAutocomplete.hide();
            return;
        }
        if (this.fileAutocomplete?.visible) {
            this.fileAutocomplete.hide();
            return;
        }

        // 0. Close Zen Mode overlay (fullscreen, highest priority)
        if (window.isZenModeOpen?.()) {
            window.toggleZenMode();
            return;
        }

        // 1. Exit selection mode (action bar or popup)
        if (isSelectionModeActive()) {
            exitSelectionMode();
            return;
        }

        // 1.5. Close permission/thinking/effort/layout popups if open
        if (permissionSettings.isOpen) {
            permissionSettings.close();
            return;
        }
        if (effortSettings.isOpen) {
            effortSettings.close();
            return;
        }
        if (layoutSwitcher.isOpen) {
            layoutSwitcher.close();
            return;
        }
        // Status-bar model popup — its own document keydown listener can be
        // starved when an earlier branch here (e.g. closeTopmost) eats the
        // key, so close it deterministically in the chain too.
        if (this.statusBar?._modelPopupOpen) {
            this.statusBar._closeModelPopup();
            return;
        }

        // 1.6. Abandon a send parked on an in-flight upload. Ranked below the
        // popups (those are what the user is looking at) but above panels and
        // Stop: Escape here means "don't send that", and every branch below
        // would leave the send armed to fire when the upload lands. Has to live
        // in this chain rather than the textarea's own keydown listener —
        // ShortcutManager claims Escape in the capture phase and calls
        // stopImmediatePropagation(), so the input never sees the key.
        if (this.inputHandler?.isAwaitingUpload?.()) {
            this.inputHandler.cancelDeferredSend();
            return;
        }

        // 2. Close quick actions menu (FAB) if open
        if (QuickActionsMenu.isContextMenuOpen) {
            QuickActionsMenu.closeContextMenu();
            return;
        }
        if (QuickActionsMenu.isOpen) {
            QuickActionsMenu.close();
            return;
        }

        // 2.45. Close the project color-picker swatch popup if open
        if (closeProjectColorPicker()) {
            return;
        }

        // 2.5. Close context menu (right-click menu) if open
        if (this.contextMenu?.visible) {
            this.contextMenu.hide();
            return;
        }

        // 2.6. Close welcome screen context menu if open
        if (closeWelcomeContextMenu()) {
            return;
        }

        // 2.65. Close the Comments Stash picker if open
        if (closeStashPickerIfOpen()) {
            return;
        }

        // 2.7. Close CodeMirror search panel if open (edit/scratch mode)
        if (FilePreviewWidget.isOpen() && FilePreviewWidget.closeEditorSearch()) {
            return;
        }

        // 2.8. Close file preview search if active (read-only mode)
        if (FilePreviewWidget.isOpen() && FilePreviewWidget.isSearchActive()) {
            FilePreviewWidget.closeSearch();
            return;
        }

        // 2.9. Deactivate inline edit mode in file preview instead of closing widget.
        // Match anywhere in DOM — works for both floating widgets and tab-hosted ones,
        // which WidgetManager.get() doesn't always return.
        if (FilePreviewWidget.isOpen()) {
            // Prefer a VISIBLE pane: hidden session/widget tabs keep their
            // .file-preview-widget in the DOM, and the first match could be one
            // of those — Esc would then report "edit mode off" while the pane
            // the user is looking at stays in edit mode.
            const candidates = document.querySelectorAll('.preview-rendered.inline-edit-mode');
            const rendered = Array.from(candidates).find(el => el.offsetParent !== null)
                || candidates[0];
            if (rendered) {
                const container = rendered.closest('.file-preview-widget');
                import('./preview/preview-inline-edit.js').then(({ toggleInlineEdit }) => {
                    toggleInlineEdit(container);
                    showToast(S.preview?.inline_edit_off || 'Edit mode off');
                });
                return;
            }
        }

        // 2.95. Leave edit (CM) view in file preview. State-based — a stale .cm-editor
        // in a different widget instance must not flip the active widget's viewMode.
        if (FilePreviewWidget.isOpen() && FilePreviewWidget.isEditing) {
            import('./preview/preview-edit.js').then(({ leaveEditView }) => {
                leaveEditView('code');
            });
            return;
        }

        // 2.99. Exit file explorer search view → list view (before closing the widget entirely)
        if (window.FileExplorerWidget?.handleEscape?.()) {
            return;
        }

        // 2.99b. Close any open inline modal overlay (snippet editor, prompt dialog)
        // before falling through to closing the widget that hosts it.
        const openModalOverlay = document.querySelector('.config-modal-overlay, .prompt-dialog-overlay');
        if (openModalOverlay) {
            openModalOverlay.remove();
            return;
        }

        // 2.99d. Image annotator owns ESC — dirty-aware discard confirm and
        // cancelling an open text/marker input. Must run before closeTopmost,
        // which would otherwise close the modal outright and skip the confirm.
        if (handleAnnotatorEscape()) {
            return;
        }

        // 2.99e. Close the legacy full-screen dialogs (help page, mkdir confirm).
        // They live at --z-modal, above every widget, so Esc must dismiss them
        // first — and crucially before the Stop-Claude branch below, which used
        // to cancel the running turn while the help page just sat there open.
        // The confirm dialog needs handling here too: the global shortcut
        // listener is capture-phase, so it beats the dialog's own keydown.
        if (this.els?.modalOverlay?.classList.contains('visible')) {
            this.hideModal();
            return;
        }
        if (this.els?.confirmDialog?.classList.contains('visible')) {
            this.hideConfirmDialog();
            return;
        }

        // 3. Close topmost widget (floating windows, modals, panels)
        if (WidgetManager.closeTopmost()) {
            return;
        }

        // 5. Hide file autocomplete dropdown
        if (this.fileAutocomplete?.visible) {
            this.fileAutocomplete.hide();
            return;
        }

        // 6. Hide command autocomplete dropdown
        if (this.autocomplete?.visible) {
            this.autocomplete.hide();
            return;
        }

        // 7. Close chat search
        if (this.chatSearch?.active) {
            this.chatSearch.close();
            return;
        }

        // 7.5. Close session preview on welcome screen
        if (this.chatCtrl?.isWelcomeShowing() && closeSessionPreview()) {
            return;
        }

        // 7.6. Clear welcome screen search
        if (this.chatCtrl?.isWelcomeShowing() && clearWelcomeSearch()) {
            return;
        }

        // 8. Close old-style file explorer (not yet migrated to widget system)
        if (this.fileExplorer?.state !== 'collapsed') {
            this.fileExplorer.close();
            return;
        }

        // 8.5. Deny a pending interactive permission ask (Esc = Deny). More
        // specific than Stop Claude below, so it wins while a card is waiting —
        // but only after transient overlays/widgets above have had their turn.
        if (this.denyPendingPermission()) {
            return;
        }

        // 9. Dismiss back-to-sessions pill (Esc = dismiss, not navigate)
        if (this.chatCtrl?.canGoBackToSessions()) {
            this.chatCtrl._dismissBackToSessionsPill();
            return;
        }

        // 10. Stop Claude if running — only when focused on a session tab.
        // Preview / terminal / other widget tabs shouldn't hijack ESC to cancel
        // the chat in the background.
        if (this.isTyping && this.activeMode === 'session') {
            this.stopClaude();
            return;
        }

        // Nothing left to dismiss — the legacy dialogs are handled at 2.99e,
        // above Stop Claude, so there's no trailing hideModal() here.
    }

    /**
     * Handle Backspace key - navigates back to sessions if pill is visible
     * (Shortcut action for 'backToSessions')
     */
    handleBackToSessions() {
        if (this.chatCtrl?.canGoBackToSessions()) {
            this.chatCtrl._handleBackToSessions();
        }
    }

    openSearch() {
        // Check if file preview is open - prioritize its search
        if (FilePreviewWidget.isOpen()) {
            FilePreviewWidget.openSearch();
            return;
        }

        // File explorer: prioritize its search when it's focused
        if (window.FileExplorerWidget?.isFocused?.()) {
            window.FileExplorerWidget.openSearch();
            return;
        }

        // On welcome screen, open inline quick search
        if (this.chatCtrl?.isWelcomeShowing()) {
            openQuickSearch();
            return;
        }

        if (this.activeMode === 'session') {
            this.chatSearch?.toggle();
        }
    }

    findNext() {
        // Check if file preview search is active
        if (FilePreviewWidget.isOpen() && FilePreviewWidget.isSearchActive()) {
            FilePreviewWidget.findNext();
            return;
        }

        if (this.activeMode === 'session' && this.chatSearch?.active) {
            this.chatSearch.navigate(1);
        }
    }

    findPrevious() {
        // Check if file preview search is active
        if (FilePreviewWidget.isOpen() && FilePreviewWidget.isSearchActive()) {
            FilePreviewWidget.findPrevious();
            return;
        }

        if (this.activeMode === 'session' && this.chatSearch?.active) {
            this.chatSearch.navigate(-1);
        }
    }

    focusInput() {
        // Don't steal focus from terminal — if user is typing in xterm, leave it alone
        const inTerminal = document.activeElement?.closest('.xterm') ||
                          document.activeElement?.closest('.terminal-container') ||
                          document.activeElement?.closest('.terminal-widget-xterm');
        if (inTerminal) {
            return;
        }
        // If terminal widget is open but not focused, focus it instead of input
        if (WidgetManager.isOpen('terminal')) {
            TerminalWidget.focus();
            return;
        }
        // If input is disabled, check if session state has changed (race condition
        // during reconnection: updateInputState ran before WebSocket connected)
        if (this.els.messageInput?.disabled) {
            const connected = this.activeSession?.status === 'connected';
            const welcomeShowing = this.chatCtrl?.isWelcomeShowing();
            if (connected || welcomeShowing) {
                // Session caught up - re-sync input state
                this.updateInputState();
            }
            // Still disabled after re-sync? Fall back to the open-folder button
            if (this.els.messageInput?.disabled) {
                this.els.openFolderBtn?.focus();
                return;
            }
        }
        // On welcome screen, the input area is hidden - don't try to focus it
        // Type-anywhere handler will capture keystrokes and focus the search bar
        if (this.chatCtrl?.isWelcomeShowing()) {
            return;
        }
        // Blur first to break any "ghost focus" state on iOS/iPadOS/macOS PWA
        // (where input appears focused but doesn't receive keystrokes)
        if (document.activeElement === this.els.messageInput) {
            this.els.messageInput.blur();
        }
        // Focus message input
        this.els.messageInput?.focus();
    }

}

// Mix in cohesive sub-concerns extracted from this file. Each module exports a
// plain object of methods that use `this` (App instance state); assigning onto
// the prototype keeps the class API identical to the pre-split implementation.
Object.assign(
    App.prototype,
    panelMethods,
    contextMenuMethods,
    renderingDelegatorMethods,
    filePreviewMethods,
    sessionSwitchMethods,
    initUiMethods,
    inputEventMethods,
    serverLoadingMethods,
    inputResizeMethods,
    startupWelcomeMethods,
    settingsHelperMethods,
    messageActionMethods,
    sessionOpsMethods,
);

// ═══════════════════════════════════════════════════════════════════
// INITIALIZE
// ═══════════════════════════════════════════════════════════════════
window.app = new App();

// Load user-assigned project colors early so tabs/cards paint the custom
// accent on first render (falls back to deterministic hash colors on error).
loadProjectColors();

// Render an optimistic Auto-journal pill immediately so users see it
// instead of empty space; the real status check below will refine
// (e.g. flip to red/yellow if helpers turn out missing/outdated).
window.app?._updateHelpersPill?.({ all_installed: true, all_current: true, any_outdated: false, files: [] });

// Preload CodeMirror in background so editor opens instantly
setTimeout(() => import('./editor-view.js').then(m => m.preloadCodeMirror()).catch(() => {}), 2000);
// Check helper install state once the app has settled — silently updates the
// status-bar pill, and pops the install modal when state warrants it.
setTimeout(() => window.app?._checkHelpersInstall?.(), 800);
window.WidgetManager = WidgetManager;
window.DiffViewerWidget = DiffViewerWidget;
// Expose DeviceManager and FileExplorerWidget for console probing
import('./widget-system/device-manager.js').then(m => { window.DeviceManager = m.DeviceManager; });
import('./widgets/file-explorer-widget.js').then(m => { window.FileExplorerWidget = m.FileExplorerWidget; });
// Initialize text selection handler (for stash and discussion)
initSelectionHandler();
initTooltips();
// Initialize stash UI (context collector)
initStashUI();
// Initialize prompt favorites (mark prompts as favorites before/after sending)
PromptFavorites.init();
// Expose for session.js to call when storeId is set
window.loadStashForSession = loadStashForSession;
// Update send button when stash changes
Stash.subscribe(() => window.app?.updateSendButtonState());

// Register chat messages container for text selection (stash and discussion)
const messagesContainer = document.getElementById('messages');
if (messagesContainer) {
    registerSelectionContainer('chat-messages', messagesContainer, {
        buildAnchor: (range, text) => {
            // Find the closest message element
            const messageEl = range.commonAncestorContainer.nodeType === 1
                ? range.commonAncestorContainer.closest('.message')
                : range.commonAncestorContainer.parentElement?.closest('.message');

            return {
                type: 'message',
                messageId: messageEl?.dataset?.msgId || null,
                messageIndex: messageEl ? Array.from(messagesContainer.children).indexOf(messageEl) + 1 : null,
                selectedText: text
            };
        }
    });
    debug.log('[App] Registered chat-messages container for selection');
}

// Load performance instrumentation if ?perf=true
if (new URLSearchParams(location.search).has('perf')) {
    import('./perf-marks.js');
}

// Wait for URL-based session loading to complete before auto-reconnecting
// This ensures server messages are loaded before connecting
window.app.initFromUrl().then(async (result) => {
    // Initialize snippets data from server (async, non-blocking)
    // Pass initial cwd if available for project-local agents
    const initialCwd = window.app.activeSession?.cwd || null;
    initSnippetsData(initialCwd).catch(e => console.warn('Failed to init snippets:', e));

    // Start WebSocket reconnection IMMEDIATELY — don't wait for message sync.
    // This is the critical path for input focus: input stays disabled until
    // ws.onopen fires, so every ms of delay here = slower time-to-interactive.
    window.app.autoReconnectSessions();

    // Full sync on page load to update incomplete tool outputs in localStorage
    // (visibilitychange doesn't fire on page reload, only on tab switch/background)
    // BUT: skip if we just loaded fresh from server (already have latest data)
    // This runs in parallel with WebSocket connection — no longer blocks input focus.
    if (!result?.loadedFromServer) {
        window.app.syncAllSessions(true).catch(e => console.warn('Background sync failed:', e));
    }
});

