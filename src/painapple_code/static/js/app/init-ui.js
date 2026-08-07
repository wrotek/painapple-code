/**
 * Init-UI mixin — one-time construction of the DOM element cache and all the
 * sub-component instances (autocomplete, chat search/navigator, scroll manager,
 * status bar, activity strip, input handler, the file/snippet/skill
 * autocompletes), server-info fetch, and the left-rail buttons + drawer.
 * Extracted from app.js; applied to App.prototype via Object.assign. Uses `this`
 * (App instance) plus the imports below.
 */
import S from '../strings.js';
import { $ } from '../utils.js';
import { CONFIG, HAS_PHYSICAL_KEYBOARD, debug, setServerHome, setServerWorkspace, setServerVersionInfo } from '../config.js';
import { AutocompleteUI } from '../components.js';
import { ChatSearch } from '../chat-search.js';
import { ChatNavigator } from '../chat-navigator.js';
import { ScrollManager } from '../scroll-manager.js';
import { StatusBar, ensureModelsLoaded } from '../status-bar.js';
import { ActivityStrip } from '../activity-strip.js';
import { InputHandler } from '../input-handler.js';
import { FileAutocomplete } from '../file-autocomplete.js';
import { SnippetsAutocomplete } from '../snippets-autocomplete.js';
import { SkillsAutocomplete } from '../skills-autocomplete.js';
import { WidgetManager, WidgetBus } from '../widget-system/init.js';
import { OpenDialog } from '../open-dialog.js';
import { layoutSwitcher } from '../layout-switcher.js';
import { state as configState } from '../widgets/config/state.js';

/**
 * Rail button → the widget it shows, for the `.active` highlight.
 *
 * Lives here rather than on the widget configs so the rail stays the sole
 * owner of its own visual state — widgets don't need to know a rail exists.
 * Only entries whose target is a registered widget belong here; rail-search-btn
 * (chat search) and the stateless buttons (layout, help) are handled separately.
 */
const RAIL_WIDGET_BUTTONS = {
    'rail-sessions-btn': 'active-sessions',
    'rail-agents-btn': 'sub-agents',
    'rail-bg-tasks-btn': 'background-tasks',
    'rail-files-btn': 'file-explorer',
    'rail-preview-btn': 'file-preview',
    'rail-logs-btn': 'log-explorer',
    'rail-terminal-btn': 'terminal',
    'rail-git-btn': 'git',
    'rail-browser-btn': 'browser',
    'rail-history-btn': 'history-explorer',
    'rail-skills-btn': 'skills',
    'rail-agent-defs-btn': 'agents',
    'rail-snippets-btn': 'snippets',
    'rail-discussion-btn': 'discussion',
    'rail-cost-btn': 'cost-analytics',
    'rail-settings-btn': 'config',
};

export const initUiMethods = {
    initElements() {
        this.els = {
            tabs: $('#tabs'),
            tabsViewport: $('.tabs-viewport'),
            newTabBtn: $('#new-tab-btn'),
            messages: $('#messages'),
            messagesContainer: $('#messages-container'),
            activityStrip: $('#activity-strip'),
            inputContainer: $('#input-container'),
            inputResizeHandle: $('#input-resize-handle'),
            messageInput: $('#message-input'),
            sendBtn: $('#send-btn'),
            followupBtn: $('#followup-btn'),
            stopBtn: $('#stop-btn'),
            connectionBar: $('#connection-bar'),
            inputArea: $('#input-area'),
            openFolderBtn: $('#open-folder-btn'),
            modalOverlay: $('#modal-overlay'),
            modalBody: $('.modal-body'),
            modalClose: $('#modal-close'),
            confirmDialog: $('#confirm-dialog'),
            confirmPath: $('#confirm-path'),
            confirmCancel: $('#confirm-cancel'),
            confirmCreate: $('#confirm-create'),
            statusConnection: $('#status-connection'),
            statusEngine: $('#status-engine'),
            statusModel: $('#status-model'),
            statusBranch: $('#status-branch'),
            statusProject: $('#status-project'),
            statusTokens: $('#status-tokens'),
            statusCost: $('#status-cost'),
            uploadBtn: $('#upload-btn'),
            promptHistoryBtn: $('#prompt-history-btn'),
            uploadsBtn: $('#uploads-btn'),
            discussionBtn: $('#discussion-btn'),
            fileMentionBtn: $('#file-mention-btn'),
            snippetsBtn: $('#snippets-btn'),
            slashCmdBtn: $('#slash-cmd-btn'),
            skillsBtn: $('#skills-btn'),
            chatSearchBar: $('#chat-search-bar'),
            chatSearchInput: $('#chat-search-input'),
            chatSearchCount: $('#chat-search-count'),
            chatSearchPrev: $('#chat-search-prev'),
            chatSearchNext: $('#chat-search-next'),
            chatSearchClose: $('#chat-search-close'),
            // View containers
            sessionView: $('#session-view'),
            welcomeView: $('#welcome-view'),
        };
    },

    initAutocomplete() {
        this.autocomplete = new AutocompleteUI(
            $('#autocomplete'),
            this.els.messageInput
        );

        // Initialize file autocomplete (@-mentions)
        this.fileAutocomplete = new FileAutocomplete(
            this.els.messageInput,
            { apiBase: CONFIG.API_BASE },
            {
                getCwd: () => this.activeSession?.cwd,
                getChangedFiles: () => []
            }
        );

        // Initialize snippets autocomplete (#-trigger for agents and snippets)
        this.snippetsAutocomplete = new SnippetsAutocomplete(
            this.els.messageInput
        );

        // Initialize skills autocomplete (~ trigger for inserting `/skill-name`)
        this.skillsAutocomplete = new SkillsAutocomplete(
            this.els.messageInput
        );

        // While a type-ahead picker (#, /, @, $) is open, tint its toolbar
        // button with the accent color — same look as the Tab-cycle
        // highlight — so typing the trigger char visibly "lights up" its
        // icon. Every popup toggles `.visible` on its container, so a class
        // observer catches all open/close paths (typed trigger, debounced
        // show, Escape, selection commit) without touching the popups.
        this._initTriggerButtonHighlights();

        // The welcome / connection bar is a single button that opens the
        // OpenDialog picker (which handles picking or creating a folder and
        // connecting). Label comes from strings.js.
        if (this.els.openFolderBtn) {
            this.els.openFolderBtn.textContent = S.connection.open_folder;
            this.els.openFolderBtn.addEventListener('click', () => OpenDialog.show());
        }

        // Initialize Chat Search (Ctrl+F in chat)
        this.chatSearch = new ChatSearch(
            this.els.messages,
            {
                searchBar: this.els.chatSearchBar,
                searchInput: this.els.chatSearchInput,
                countDisplay: this.els.chatSearchCount,
                prevBtn: this.els.chatSearchPrev,
                nextBtn: this.els.chatSearchNext,
                closeBtn: this.els.chatSearchClose
            },
            {
                onClose: () => this.els.messageInput?.focus()
            }
        );

        // Initialize Scroll Manager (Slack-style new messages indicator)
        this.scrollManager = new ScrollManager(
            this.els.messagesContainer,
            { scrollThreshold: 100, topThreshold: 100 },
            {
                onScrollTop: () => this.handleScrollTop(),
                getSession: () => this.activeSession
            }
        );

        // Initialize Chat Navigator (Cmd+Up/Down to jump between user messages)
        this.chatNavigator = new ChatNavigator(
            {
                messagesContainer: this.els.messagesContainer,
                messages: this.els.messages
            },
            {
                getSession: () => this.activeSession,
                onLoadMore: () => this.handleScrollTop()
            }
        );

        // Initialize Status Bar (connection status, typing indicator)
        this.statusBar = new StatusBar(
            {
                statusConnection: this.els.statusConnection,
                statusEngine: this.els.statusEngine,
                statusModel: this.els.statusModel,
                statusBranch: this.els.statusBranch,
                statusProject: this.els.statusProject,
                statusCost: this.els.statusCost,
                statusTokens: this.els.statusTokens,
                sendBtn: this.els.sendBtn,
                followupBtn: this.els.followupBtn,
                stopBtn: this.els.stopBtn
            },
            {
                getSession: () => this.activeSession
            }
        );
        this.statusBar.init();  // Set up click handlers for token popover

        // Warm the models cache so {model} placeholders render with the
        // correct label on first paint (helpers modal, settings toggles).
        ensureModelsLoaded();

        // Activity Strip (between messages and input — peripheral, not competing with cursor)
        this.activityStrip = new ActivityStrip(this.els.activityStrip, this.els.inputArea);

        // Initialize Input Handler (history, drafts, input events)
        this.inputHandler = new InputHandler(
            {
                messageInput: this.els.messageInput,
                sendBtn: this.els.sendBtn,
                followupBtn: this.els.followupBtn
            },
            { hasPhysicalKeyboard: HAS_PHYSICAL_KEYBOARD },
            {
                getSession: () => this.activeSession,
                getAutocomplete: () => this.autocomplete,
                getFileAutocomplete: () => this.fileAutocomplete,
                getSnippetsAutocomplete: () => this.snippetsAutocomplete,
                getSkillsAutocomplete: () => this.skillsAutocomplete,
                getCwd: () => this.activeSession?.cwd || null,
                getPendingImages: () => this.pendingImages,
                onSendMessage: (text, options) => this.sendMessage(text, options),
                onSlashCommand: (cmd) => this.handleSlashCommand(cmd),
                onBangCommand: (cmd) => this.handleBangCommand(cmd),
                onPlanComposeChange: (active) => this.onPlanComposeChange(active),
                onConnect: () => this.connectActiveSession(),
                onAutoResize: () => { this.autoResizeInput(); this.syncInputHighlightBackdrop(); },
                onUpdateSendButton: () => this.updateSendButtonState(),
                onPreviewFile: (path) => this.previewFile(path),
                onSendInNewSession: (text) => this.sendInNewSession(text),
                isWelcomeMode: () => this.chatCtrl?.isWelcomeShowing() || false
            }
        );

        // Type-anywhere search: typing on welcome screen focuses input
        this._initTypeAnywhereSearch();

        // Fetch server info first to get home path, then load directories
        this.initServerInfo();
    },

    /**
     * Accent-highlight a trigger's toolbar button while its picker is open.
     * One class observer per popup container; the slash popup only lights
     * the "/" button in slash mode (bang mode shares the same container
     * but has no toolbar button).
     */
    _initTriggerButtonHighlights() {
        const pairs = [
            [this.snippetsAutocomplete, this.els.snippetsBtn],
            [this.fileAutocomplete, this.els.fileMentionBtn],
            [this.skillsAutocomplete, this.els.skillsBtn],
            [this.autocomplete, this.els.slashCmdBtn,
             () => this.autocomplete.mode === 'slash'],
        ];
        for (const [popup, btn, extra] of pairs) {
            if (!popup?.container || !btn) continue;
            const sync = () => btn.classList.toggle(
                'trigger-armed',
                popup.container.classList.contains('visible') && (!extra || extra())
            );
            new MutationObserver(sync).observe(
                popup.container, { attributes: true, attributeFilter: ['class'] }
            );
            sync();
        }
    },

    /**
     * Fetch server info (home path) before loading directories
     */
    async initServerInfo() {
        try {
            const response = await fetch(`${CONFIG.API_BASE}/api/info`);
            const data = await response.json();
            if (data.home) setServerHome(data.home);
            if (data.workspace) setServerWorkspace(data.workspace);
            setServerVersionInfo({
                version: data.version,
                staticBuild: data.static_build,
                diskVersion: data.disk_version,
                restartNeeded: data.restart_needed,
            });
            // Anchor the file explorer to the explicit workspace when set
            // (the project base), falling back to the OS home otherwise.
            const anchor = data.workspace || data.home;
            if (anchor && this.fileExplorer) {
                this.fileExplorer.setHomePath(anchor);
            }
        } catch (err) {
            debug.warn('Failed to fetch server info:', err);
        }
    },

    /**
     * Initialize left rail buttons - mirror functionality from header/toolbar
     * Rail provides quick access to common widgets on desktop
     */
    initLeftRailButtons() {
        // Inject text labels for the expanded rail. The tooltip text is the
        // single source for the label — read before refreshRailShortcutTooltips
        // appends "(key)" (shortcutBase covers a re-run after that).
        document.querySelectorAll('#left-rail .rail-btn').forEach(btn => {
            if (btn.querySelector('.rail-label')) return;
            const text = btn.dataset.shortcutBase || btn.getAttribute('data-tooltip');
            if (!text) return;
            const label = document.createElement('span');
            label.className = 'rail-label';
            label.textContent = text;
            btn.insertBefore(label, btn.querySelector('.rail-badge'));
        });

        // Helper to bind rail button to action (click + touchend for iOS)
        const bind = (id, action) => {
            const btn = document.getElementById(id);
            if (btn) {
                btn.addEventListener('click', action);
                btn.addEventListener('touchend', (e) => {
                    e.preventDefault();
                    action();
                }, { passive: false });
            }
        };

        // Activity / running things
        bind('rail-sessions-btn', () => WidgetManager.toggle('active-sessions'));
        bind('rail-agents-btn', () => WidgetManager.toggle('sub-agents'));
        bind('rail-bg-tasks-btn', () => WidgetManager.toggle('background-tasks'));
        // rail-orphan-terminals-btn is wired by orphan-terminals.js (uses #orphan-terminals-btn wrapper)

        // Files / Code
        // toggle(), not open(): the button now carries an .active highlight, so
        // it has to behave like the toggle it looks like (and like its own
        // Alt+F shortcut, which already toggled).
        bind('rail-files-btn', () => this.fileExplorer?.toggle());
        bind('rail-preview-btn', () => this.togglePreview());
        bind('rail-logs-btn', () => WidgetManager.toggle('log-explorer'));
        bind('rail-terminal-btn', () => this.toggleTerminalPanel());
        bind('rail-git-btn', () => WidgetManager.toggle('git'));
        bind('rail-browser-btn', () => WidgetManager.toggle('browser'));

        // Find
        bind('rail-search-btn', () => this.chatSearch?.toggle());
        bind('rail-history-btn', () => WidgetManager.toggle('history-explorer'));

        // Library (skills / agent definitions / snippets)
        bind('rail-skills-btn', () => WidgetManager.toggle('skills'));
        bind('rail-agent-defs-btn', () => WidgetManager.toggle('agents'));
        bind('rail-snippets-btn', () => WidgetManager.toggle('snippets'));

        // Discussion
        bind('rail-discussion-btn', () => WidgetManager.toggle('discussion'));

        // Bottom buttons
        bind('rail-cost-btn', () => WidgetManager.toggle('cost-analytics'));
        bind('rail-layout-btn', () => layoutSwitcher.toggle(document.getElementById('rail-layout-btn')));
        bind('rail-settings-btn', () => this.showSettings());
        bind('rail-help-btn', () => this.showHelp());

        this.refreshRailShortcutTooltips();
        this.initRailActiveState();
    },

    /**
     * Keep the rail's `.active` highlight in sync with what's actually on
     * screen, so the rail reads as a set of on/off toggles rather than a set
     * of launch buttons.
     *
     * Driven by widget events rather than by the click handlers above, so the
     * highlight stays correct no matter how a widget opened or closed — rail
     * click, keyboard shortcut, quick-switcher, FAB, or Escape.
     */
    initRailActiveState() {
        const sync = () => this.syncRailActiveState();

        // Widget lifecycle. 'destroyed' matters because a destroyed widget
        // never emits 'closed'.
        WidgetBus.on('widget:opened', sync);
        WidgetBus.on('widget:closed', sync);
        WidgetBus.on('widget:destroyed', sync);
        // Promotion to a full tab closes the floating window — re-read state.
        WidgetBus.on('widget:open-as-tab', sync);
        // Session switch shows/hides whole sets of widgets via inline display
        // without touching isVisible, which is why syncRailActiveState() tests
        // isShowing() rather than isOpen().
        WidgetBus.on('session:widgets-shown', sync);

        // Chat search is the one rail entry that isn't a widget, so it has no
        // bus event. Watching the bar's class is cheaper than threading a
        // callback through ChatSearch for a single consumer.
        const searchBar = this.els.chatSearchBar;
        if (searchBar) {
            new MutationObserver(sync).observe(searchBar, {
                attributes: true,
                attributeFilter: ['class'],
            });
        }

        sync();
    },

    /**
     * Paint `.active` on every rail button whose target is currently visible.
     * Safe to call at any time — cheap DOM writes, no widget instantiation
     * (isShowing resolves without creating).
     */
    syncRailActiveState() {
        for (const [btnId, widgetId] of Object.entries(RAIL_WIDGET_BUTTONS)) {
            document.getElementById(btnId)
                ?.classList.toggle('active', WidgetManager.isShowing(widgetId));
        }
        document.getElementById('rail-search-btn')
            ?.classList.toggle('active', !!this.chatSearch?.state?.active);
    },

    /**
     * Resolve the static chrome tooltips declared in web-client.html as
     * data-tooltip-key="<dotted path into strings.yaml>" — the markup carries
     * no user-facing text of its own, so translations stay in one file.
     *
     * Runs before refreshRailShortcutTooltips() so that the shortcut suffix is
     * appended to the resolved string; clearing shortcutBase keeps that safe if
     * the two ever run in the other order.
     */
    applyStaticTooltips() {
        document.querySelectorAll('[data-tooltip-key]').forEach(el => {
            const text = el.dataset.tooltipKey
                .split('.')
                .reduce((o, k) => (o == null ? o : o[k]), S);
            if (typeof text !== 'string') {
                console.warn('Unknown tooltip key:', el.dataset.tooltipKey);
                return;
            }
            el.setAttribute('data-tooltip', text);
            delete el.dataset.shortcutBase;
        });
    },

    /**
     * Append the user-configured key to any rail tooltip that opted in via
     * data-shortcut-action="<shortcutId>". Re-run after the shortcut manager
     * reloads user overrides so the tooltip never drifts from the binding.
     */
    refreshRailShortcutTooltips() {
        // Send tooltip first — it doesn't need the manager on keyboard devices.
        this._refreshSendTooltip();
        const sm = this.shortcutManager;
        if (!sm) return;
        document.querySelectorAll('[data-shortcut-action]').forEach(el => {
            const id = el.dataset.shortcutAction;
            const base = el.dataset.shortcutBase ?? (el.dataset.shortcutBase = el.getAttribute('data-tooltip') || '');
            const keys = sm.getShortcutKeys(id);
            const primary = keys?.[0];
            el.setAttribute('data-tooltip', primary ? `${base} (${primary})` : base);
        });
    },

    /**
     * The send button is NOT a plain shortcut mirror. On keyboard devices plain
     * Enter sends (input-handler.js) and Cmd/Ctrl+Enter is merely the
     * connect-when-disconnected binding — advertising the latter was wrong.
     * On iPhone (no physical keyboard) Enter inserts a newline, so there
     * Cmd+Enter genuinely is the send key.
     */
    _refreshSendTooltip() {
        const btn = this.els?.sendBtn || document.getElementById('send-btn');
        if (!btn) return;
        if (HAS_PHYSICAL_KEYBOARD) {
            btn.setAttribute('data-tooltip', S.ui.input.send_tooltip);
            return;
        }
        const key = this.shortcutManager?.getShortcutKeys('connect')?.[0] || 'Cmd+Enter';
        btn.setAttribute('data-tooltip', S.ui.input.send_tooltip_mod.replace('{key}', key));
    },

    /**
     * Rail hamburger. Mobile: toggles the slide-in drawer (body.rail-open),
     * scrim/rail-btn taps close it; the composite badge keeps passive awareness
     * of running activity while the drawer is closed. iPad/desktop: toggles the
     * rail between icons-only and icons+labels (body.rail-labels, persisted in
     * user config). The mobile drawer always shows labels.
     */
    initRailDrawer() {
        const toggleBtn = document.getElementById('rail-toggle-btn');
        const scrim = document.getElementById('rail-scrim');
        const compositeBadge = document.getElementById('rail-toggle-badge');
        if (!toggleBtn) return;

        const isMobile = () => window.matchMedia('(max-width: 600px)').matches;
        const applyRailLabels = () => {
            document.body.classList.toggle('rail-labels', isMobile() || !!configState.config.railExpanded);
        };
        applyRailLabels();

        const setOpen = (open) => {
            document.body.classList.toggle('rail-open', open);
            toggleBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
        };
        const close = () => setOpen(false);
        const toggle = () => {
            if (isMobile()) {
                setOpen(!document.body.classList.contains('rail-open'));
            } else {
                const expanded = !configState.config.railExpanded;
                configState.setRailExpanded(expanded);
                applyRailLabels();
                toggleBtn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
            }
        };

        // Exposed as an app method for the toggleRailMenu shortcut (Ctrl/Cmd+B)
        this.toggleRailMenu = toggle;

        toggleBtn.addEventListener('click', toggle);
        scrim?.addEventListener('click', close);

        // Auto-close when a rail button is tapped on mobile (after its action runs)
        document.querySelectorAll('#left-rail .rail-btn').forEach(btn => {
            btn.addEventListener('click', () => { if (isMobile()) close(); });
        });

        // Tabs-overview button in the rail drawer (mobile copy of the one in #tabs).
        // Capture rect first (so dropdown anchors where the user tapped), then
        // close the drawer so the dropdown isn't hidden behind it.
        const railOverviewBtn = document.querySelector('.rail-drawer-grid');
        if (railOverviewBtn) {
            railOverviewBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const anchorClone = { getBoundingClientRect: () => railOverviewBtn.getBoundingClientRect() };
                if (isMobile()) close();
                this.tabCtrl?.toggleTabsOverview(anchorClone);
            });
        }

        // Close on viewport resize past the breakpoint so state can't get stuck;
        // re-evaluate labels (drawer forces them on, desktop follows the pref)
        window.addEventListener('resize', () => {
            if (!isMobile()) close();
            applyRailLabels();
        });

        // Hamburger badge mirrors the active-sessions count. Other rail badges
        // (orphan terminals, agents, tasks, summary forks) intentionally don't contribute
        // — orphans are stale state, not active work.
        if (compositeBadge) {
            const sessionsBadge = document.getElementById('sessions-badge');
            if (sessionsBadge) {
                const update = () => {
                    const n = parseInt(sessionsBadge.textContent, 10) || 0;
                    compositeBadge.textContent = n > 0 ? String(n) : '';
                };
                new MutationObserver(update).observe(sessionsBadge, { childList: true, characterData: true, subtree: true });
                update();
            }
        }
    },
};
