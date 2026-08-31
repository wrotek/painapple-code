/**
 * Session and SessionManager classes — orchestrator.
 *
 * Class skeleton + WebSocket lifecycle + send paths live here. Cohesive sub-
 * concerns are mixed onto Session.prototype from `static/js/session/`:
 *
 *   restore.js              constructor message restoration
 *   messages.js             addMessage / addSystemLog / addToolUse / addToolResult
 *                           addThinkingMessage / addToolToThinkingMessage
 *                           updateThinkingToolResult / _updateLastUserMessageWithPromptId
 *   message-store.js        signature / find / dedup / sort / updateSyncTimestamp
 *   sync.js                 syncMessages / loadOlderMessages / loadPromptHistory
 *   handle-message.js       WebSocket envelope handler (the type switch)
 *   handle-agent-message.js Claude-stream handler (system/assistant/user/result)
 *   interactive.js          AskUserQuestion + ExitPlanMode + sendToolAnswer(s)
 *   agent-progress.js       task_progress events for background agents
 *   persistence.js          toJSON serialization for localStorage
 *
 * SessionManager stays inline below — it owns persist + reconcile + create/remove.
 */

import S from './strings.js';
import { CONFIG, debug, HAS_PHYSICAL_KEYBOARD } from './config.js';
import { genId, Storage } from './utils.js';
import { effortSettings } from './effort-settings.js';

import { restoreMessages } from './session/restore.js';
import { messageWriteMethods } from './session/messages.js';
import { messageStoreMethods } from './session/message-store.js';
import { syncMethods } from './session/sync.js';
import { wsHandlerMethods } from './session/handle-message.js';
import { agentStreamMethods } from './session/handle-agent-message.js';
import { interactiveMethods } from './session/interactive.js';
import { agentProgressMethods } from './session/agent-progress.js';
import { persistenceMethods } from './session/persistence.js';

// Helper to get app instance (set globally by app.js)
const getApp = () => window.app;

/**
 * Represents a single Claude Code session
 */
export class Session {
    constructor(options = {}) {
        this.id = options.id || genId();
        this.name = options.name || 'New Session';
        this.cwd = options.cwd || '';
        this.ws = null;
        this.status = 'disconnected';
        // Restore messages from saved, marking incomplete tools as completed,
        // and extracting interactive tools (ExitPlanMode, AskUserQuestion) from
        // thinking blocks so they re-render on session restore.
        this.messages = restoreMessages(options.messages, options);
        this.unread = false;
        this.createdAt = options.createdAt || new Date().toISOString();
        this.lastActivity = options.lastActivity || new Date().toISOString();
        this.totalCost = options.totalCost || 0;
        this.reconnectAttempt = 0;
        this.reconnectTimer = null;
        this.wasConnected = options.wasConnected || false;
        this.pendingBangOutput = null;
        this.model = options.model || null;
        // The provider's conversation/session id (for resuming)
        this.providerSessionId = options.providerSessionId || options.claudeSessionId || null;  // back-compat: pre-rename localStorage key
        // Track if we're in extended thinking mode (tools go to thinking drawer)
        this.inThinkingMode = false;
        // Track tool IDs that were used during thinking (for matching results)
        this.thinkingToolIds = new Set();
        // Current thinking message ID (for adding tools to it)
        this.currentThinkingMsgId = null;
        // Turn counter - incremented on each new API response, used for grouping boundaries
        this.turnId = 0;
        this._lastApiMessageId = null;
        this._deniedToolsThisTurn = new Set();
        // Server-side session store ID (for URL sharing and persistence)
        this.storeId = options.storeId || null;
        // Track if Claude is currently processing (for per-session typing state)
        this.isAgentRunning = false;
        // Track if shadow git (summary fork) is running for this session
        this.hasShadowGitRunning = false;
        // Track if Claude just finished (ready for user input) - shows green dot
        this.isReady = false;
        // Token usage tracking
        this.contextTokens = options.contextTokens || 0;  // Current context usage
        this.contextWindow = options.contextWindow || 200000;  // Max context size
        this.contextBreakdown = options.contextBreakdown || null;  // Detailed breakdown from /context
        this.contextMemoryFiles = options.contextMemoryFiles || null;  // Memory files detail
        this.contextUpdatedAt = options.contextUpdatedAt || null;  // When /context was last fetched
        this.totalInputTokens = options.totalInputTokens || 0;
        this.totalOutputTokens = options.totalOutputTokens || 0;
        // Slash commands from Claude init (populated when Claude starts)
        this.slashCommands = options.slashCommands || [];
        // Permission mode (e.g., 'plan', 'default', 'bypassPermissions')
        // Captured from Claude init message or set via /plan command
        this.permissionMode = options.permissionMode || null;
        // Provider (provider) this session runs on — bound server-side at
        // creation, authoritative value arrives on every `connected` frame.
        // pendingProvider is the picker choice for a tab that hasn't created
        // its server session yet; it rides the create WS URL (?provider=)
        // and is cleared once the server confirms.
        this.provider = options.provider || null;
        this.providerDisplayName = options.providerDisplayName || null;
        this.providerCaps = options.providerCaps || null;
        this.pendingProvider = options.pendingProvider || null;
        // Provider locks permanently once the session runs a turn (the
        // conversation lives in that provider's format). Server-reported on
        // connect; providerSessionId doubles as the live post-turn signal.
        this.providerLocked = options.providerLocked || false;
        // Client-side caches of the per-session prefs the status-bar managers
        // fetch on switch. Seeded from persistence/meta and written back on
        // every fetch/pick, they let a tab switch paint the correct model /
        // permission / effort / account state synchronously — the manager
        // fetches then merely confirm (kills the wrong-provider flash).
        this.preferredModel = options.preferredModel ?? null;   // model pin ('' ≡ null)
        this.permissionLevel = options.permissionLevel || null; // provider-vocab mode value
        this.effortLevel = options.effortLevel || null;
        this.tokenProfileName = options.tokenProfileName ?? null;
        // Sync state tracking (for background/foreground sync)
        this.lastSyncTimestamp = options.lastSyncTimestamp || null;
        this.isSyncing = false;
        // Lazy loading state (for paginated message history)
        this.hasMoreMessages = options.hasMoreMessages ?? true;  // Assume more until proven otherwise
        this.totalMessageCount = options.totalMessageCount || 0;  // Total messages on server
        this.totalUserPromptCount = options.totalUserPromptCount || 0;  // Total user prompts on server
        this.isLoadingMore = false;  // Prevent duplicate fetches
        this.isLoadingFromServer = false;  // Prevent sync race condition during initial load
        // Scroll position (transient, not persisted)
        this.scrollPosition = null;  // null = scroll to bottom, number = restore position
        this.isUserScrolledUp = false;  // Track if user manually scrolled up
        // Input text draft (transient, not persisted - prevents accidental cross-session sends)
        this.inputText = '';  // Current message input content for this session
        // Upload state (transient in-memory for tab switching)
        this.pendingImages = [];  // Saved from UploadManager on tab switch
        this.pendingFiles = [];   // Saved from UploadManager on tab switch
        // Serialized upload metadata (from localStorage, for async restore after page refresh)
        this._savedUploadImages = options.pendingUploadImages || [];
        this._savedUploadFiles = options.pendingUploadFiles || [];
        // Agent progress tracking (from task_progress system events)
        // Keyed by tool_use_id → { description, toolCount, totalTokens, durationMs, lastToolName, lastUpdate }
        this._agentProgress = new Map();
        this._completedAgents = [];  // { toolUseId, description, toolCount, totalTokens, durationMs, completedAt }
        this._agentStallInterval = null;
        this._agentBatchPeak = 0;  // Peak number of concurrent agents (for "N/total" display)
        // System logs (connection status, errors, lifecycle events)
        // Client-side only, not persisted to server
        this.systemLogs = [];
        // Per-session prompt history (loaded from server, kept in-memory)
        // Populated on connect from server's messages.jsonl
        this.promptHistory = [];
        this.promptHistoryLoaded = false;  // Track if we've loaded from server

        // If restored from localStorage with storeId, load history immediately
        // (don't wait for WebSocket connect - user might press Up arrow first)
        if (this.storeId) {
            this.loadPromptHistory();
        }
    }

    // Check if this session is currently active (selected tab)
    get isActive() {
        const app = getApp();
        return app && app.activeSession === this;
    }

    /**
     * Check if session is in plan mode
     * @returns {boolean}
     */
    get isInPlanMode() {
        return this.permissionMode === 'plan';
    }

    /**
     * Check if session has unanswered questions
     * @returns {boolean}
     */
    get hasPendingQuestion() {
        return this.messages.some(m => (m.role === 'question' || m.role === 'plan_approval' || m.role === 'permission') && !m.answered);
    }

    /**
     * Get the type of pending interactive message ('question', 'plan_approval', or null)
     * @returns {string|null}
     */
    get pendingQuestionType() {
        const msg = this.messages.findLast(m => (m.role === 'question' || m.role === 'plan_approval' || m.role === 'permission') && !m.answered);
        return msg?.role || null;
    }

    /**
     * Get the process status class for tab rendering.
     * Priority: main Claude > shadow git > ready > none
     * @returns {string} CSS class name: 'running-claude', 'running-shadowgit', 'ready', or ''
     */
    get processStatusClass() {
        if (this.isAgentRunning) {
            return 'running-claude';
        }
        if (this.hasShadowGitRunning) {
            return 'running-shadowgit';
        }
        if (this.isReady) {
            return 'ready';
        }
        return '';
    }

    connect(wsUrl) {
        // Don't connect if already open or in progress
        if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
            return;
        }

        this.status = 'connecting';
        this.updateTab();

        let url = wsUrl || CONFIG.WS_URL;

        // Use server-side session ID if available (for resuming/rejoining)
        if (this.storeId) {
            url += (url.includes('?') ? '&' : '?') + 'session=' + encodeURIComponent(this.storeId);
        } else if (this.cwd) {
            // New session - pass cwd for initial creation
            url += (url.includes('?') ? '&' : '?') + 'cwd=' + encodeURIComponent(this.cwd);
            // Provider picker choice rides the create connect; the server
            // records it in meta and echoes it back on `connected`.
            if (this.pendingProvider) {
                url += '&provider=' + encodeURIComponent(this.pendingProvider);
            }
        }

        try {
            this.ws = new WebSocket(url);

            this.ws.onopen = () => {
                const app = getApp();
                this.status = 'connected';
                this.wasConnected = true;
                this.reconnectAttempt = 0;
                this._lastServerFrame = Date.now();
                this.updateTab();
                if (app.activeSession === this) {
                    app.updateInputState();
                    app.updateStatus();
                    app.els.connectionBar.classList.remove('visible');
                    if (HAS_PHYSICAL_KEYBOARD) app.focusInput();
                }
                app.sessionManager.saveSessions();
                // Start keepalive pings to prevent iPadOS/Cloudflare from
                // dropping idle WebSocket connections (30s interval)
                this._startKeepalive();
            };

            this.ws.onclose = (e) => {
                const app = getApp();
                this.status = 'disconnected';
                this._stopKeepalive();
                this.updateTab();
                if (app.activeSession === this) {
                    // Don't clear activity strip on abnormal close — we'll reconnect
                    // and the server will tell us the real state. Only clear on clean close.
                    if (e.code === 1000) {
                        this._setActivity({ active: false });
                    }
                    app.updateInputState();
                    app.updateStatus();
                }

                if (e.code !== 1000) {
                    this.addSystemLog(S.status.reconnecting);
                    this.scheduleReconnect();
                }
            };

            this.ws.onerror = (e) => {
                console.warn('WebSocket error (connection lost):', e);
                this.addSystemLog(S.status.connection_error);
            };

            this.ws.onmessage = (e) => {
                // Liveness marker for the half-open-socket detector in
                // _startKeepalive — every server frame (incl. pongs and turn
                // heartbeats) proves the socket is really alive.
                this._lastServerFrame = Date.now();
                try {
                    const msg = JSON.parse(e.data);
                    this.handleMessage(msg);
                } catch (err) {
                    console.error('Message parse error:', err);
                }
            };
        } catch (e) {
            this.status = 'disconnected';
            this.addSystemLog(`Failed to connect: ${e.message}`);
            // Constructor-throw is rare (invalid URL etc.) but if we don't
            // schedule a retry, the session is wedged until the user reloads.
            this.scheduleReconnect();
        }
    }

    /**
     * User-initiated reconnect. Cancels any in-flight WS, clears the backoff
     * timer, resets the attempt counter so the next try is immediate, then
     * reconnects. Safe to call from any status (disconnected / connecting /
     * even connected — we tear down first).
     */
    forceReconnect() {
        this._stopKeepalive();
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.ws) {
            // null out handlers so the close doesn't fire onclose →
            // scheduleReconnect race against our own immediate connect().
            try {
                this.ws.onopen = null;
                this.ws.onclose = null;
                this.ws.onerror = null;
                this.ws.onmessage = null;
                this.ws.close(1000);
            } catch (_) { /* ignore */ }
            this.ws = null;
        }
        this.status = 'disconnected';
        this.reconnectAttempt = 0;
        this.updateTab();
        this.connect();
    }

    /**
     * Foreground-resume liveness check. iOS freezes the _startKeepalive
     * interval while the PWA is backgrounded, so the half-open detector
     * cannot be trusted to fire after a resume. On visibilitychange→visible
     * we call this to actively re-establish a healthy socket:
     *   - not OPEN (null / stuck CONNECTING / CLOSING / CLOSED) → reconnect now
     *   - OPEN but readyState lies on WKWebView resume → restart the keepalive
     *     loop (so it's not a frozen timer) and probe with a ping; if no server
     *     frame lands within the probe window, the socket is a zombie → reconnect.
     */
    checkLiveness() {
        if (!this.wasConnected || !this.cwd) return;
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            // Covers CONNECTING-stuck too: forceReconnect tears down the
            // in-flight socket before connect() (which would otherwise
            // early-return on CONNECTING).
            this.forceReconnect();
            return;
        }
        // OPEN — restart keepalive so the 30s watchdog isn't a frozen timer,
        // then probe. If the pong (or any frame) doesn't update _lastServerFrame
        // past our probe mark within the window, the socket is dead-but-OPEN.
        this._startKeepalive();
        const probeAt = Date.now();
        try {
            this.ws.send(JSON.stringify({ type: 'ping' }));
        } catch (e) {
            this.forceReconnect();
            return;
        }
        setTimeout(() => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN &&
                (!this._lastServerFrame || this._lastServerFrame < probeAt)) {
                debug.log('[Liveness] No server frame after resume probe — forcing reconnect');
                this.forceReconnect();
            }
        }, CONFIG.LIVENESS_PROBE_MS || 5000);
    }

    disconnect(explicit = true) {
        this._stopKeepalive();
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.ws) {
            this.ws.close(1000);
            this.ws = null;
        }
        this.status = 'disconnected';
        if (explicit) {
            this.wasConnected = false;
        }
        this.updateTab();
    }

    _startKeepalive() {
        this._stopKeepalive();
        this._keepaliveTimer = setInterval(() => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                // Half-open detector: we ping every 30s and the server pongs, so
                // >75s without ANY server frame (2+ missed pongs) means the
                // socket is dead in a way WKWebView never surfaces (iPad PWA
                // resume). Force-close it — onclose schedules the reconnect and
                // the server's `connected` payload reconciles activity state
                // from truth. This is what un-sticks a tab whose terminal
                // result frame was silently lost.
                if (this._lastServerFrame && Date.now() - this._lastServerFrame > 75_000) {
                    debug.log('[Keepalive] No server frames for >75s — forcing reconnect');
                    try { this.ws.close(); } catch (e) { /* onclose handles it */ }
                    return;
                }
                try {
                    this.ws.send(JSON.stringify({ type: 'ping' }));
                } catch (e) {
                    // WebSocket dead — onclose will handle reconnect
                }
            }
        }, 30_000);
    }

    _stopKeepalive() {
        if (this._keepaliveTimer) {
            clearInterval(this._keepaliveTimer);
            this._keepaliveTimer = null;
        }
    }

    scheduleReconnect() {
        if (this.reconnectTimer) return;

        const delay = CONFIG.RECONNECT_DELAYS[
            Math.min(this.reconnectAttempt, CONFIG.RECONNECT_DELAYS.length - 1)
        ];

        this.reconnectAttempt++;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, delay);
    }

    send(content, options = {}) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            this.addSystemLog(S.errors.not_connected);
            return false;
        }

        // Optimistically mark as working — server's system/init / assistant
        // messages will reassert this, but without it the tab dot stays dark
        // for 1-2s during subprocess startup on cold-start sends.
        this.isAgentRunning = true;
        // Clear ready state when user sends new message
        this.isReady = false;
        this.updateTab();

        const msg = {
            type: 'user_message',
            content: content
        };

        // Include markAsFavorite flag if specified
        if (options.markAsFavorite) {
            msg.markAsFavorite = true;
        }

        // Include current token profile selection
        if (window.tokenProfile?.currentProfile) {
            msg.token_profile = window.tokenProfile.currentProfile;
        }

        // Include preferred model selection
        if (window.app?.statusBar?.currentModel) {
            msg.preferred_model = window.app.statusBar.currentModel;
        }

        // One-shot effort override (Ctrl+Shift+'): consume the armed value
        // and forward as msg.effort_level. Server applies it for this turn
        // only, then reverts to the persistent session.effort_level.
        const oneShotEffort = effortSettings.consumeOneShot();
        if (oneShotEffort) {
            msg.effort_level = oneShotEffort;
        }

        // Forward a permission choice made before this session had a storeId.
        // The picker can only stash it on the session until then; carrying it on
        // the first message persists it server-side so YOLO/etc. survives instead
        // of reverting to the global default. Cleared once sent — later picks go
        // through the normal PUT + set_permission_mode path.
        if (this.pendingPermission) {
            msg.permission_mode = this.pendingPermission;
            this.pendingPermission = null;
        }

        this.ws.send(JSON.stringify(msg));

        // Display level matches what was actually sent (one-shot if armed,
        // else the persistent level).
        const effortLevel = oneShotEffort || effortSettings.getLevel();
        this.addMessage({
            role: 'user',
            content,
            effort_level: effortLevel !== 'high' ? effortLevel : null,
        });

        return true;
    }

    // Send without adding to UI messages (used when message already added separately)
    sendRaw(content) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            this.addSystemLog(S.errors.not_connected);
            return false;
        }

        // See send() — optimistically mark as working so tab dot lights up
        // immediately rather than after subprocess startup.
        this.isAgentRunning = true;
        // Clear ready state when user sends new message
        this.isReady = false;
        this.updateTab();

        const msg = {
            type: 'user_message',
            content: content
        };

        // Include current token profile selection
        if (window.tokenProfile?.currentProfile) {
            msg.token_profile = window.tokenProfile.currentProfile;
        }

        // Include preferred model selection
        if (window.app?.statusBar?.currentModel) {
            msg.preferred_model = window.app.statusBar.currentModel;
        }

        // One-shot effort override — see send() for the full contract.
        const oneShotEffortRaw = effortSettings.consumeOneShot();
        if (oneShotEffortRaw) {
            msg.effort_level = oneShotEffortRaw;
        }

        // Forward a pre-storeId permission choice — see send() for the contract.
        if (this.pendingPermission) {
            msg.permission_mode = this.pendingPermission;
            this.pendingPermission = null;
        }

        this.ws.send(JSON.stringify(msg));
        return true;
    }

    // Send message with optional images (Claude API format)
    // options.stashRefs - Array of stash items to store with message
    // options.displayContent - Original content for storage (if different from content sent to Claude)
    sendWithImages(content, images = [], options = {}) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            this.addSystemLog(S.errors.not_connected);
            return false;
        }

        // See send() — optimistically mark as working so tab dot lights up
        // immediately rather than after subprocess startup.
        this.isAgentRunning = true;
        // Clear ready state when user sends new message
        this.isReady = false;
        this.updateTab();

        const msg = {
            type: 'user_message',
            content: content,
            images: images  // Array of {type: 'image', source: {...}} objects
        };

        // Include stash refs for server-side storage (displayed in message bubble)
        if (options.stashRefs && options.stashRefs.length > 0) {
            msg.stashRefs = options.stashRefs;
        }

        // Include original content for storage (different from content sent to Claude)
        if (options.displayContent !== undefined) {
            msg.displayContent = options.displayContent;
        }

        // Uploaded file paths — displayContent strips the "Uploaded file:"
        // block out of the stored message, so the attachment count has to
        // travel separately or a reloaded bubble loses it.
        if (options.files && options.files.length > 0) {
            msg.files = options.files;
        }

        // Include plan mode flag for server-side storage
        if (options.planMode) {
            msg.planMode = true;
        }

        // Include markAsFavorite flag if specified
        if (options.markAsFavorite) {
            msg.markAsFavorite = true;
        }

        // Include current token profile selection
        if (window.tokenProfile?.currentProfile) {
            msg.token_profile = window.tokenProfile.currentProfile;
        }

        // Include preferred model selection
        if (window.app?.statusBar?.currentModel) {
            msg.preferred_model = window.app.statusBar.currentModel;
        }

        // One-shot effort override — see send() for the full contract.
        const oneShotEffortImgs = effortSettings.consumeOneShot();
        if (oneShotEffortImgs) {
            msg.effort_level = oneShotEffortImgs;
        }

        // Forward a pre-storeId permission choice — see send() for the contract.
        if (this.pendingPermission) {
            msg.permission_mode = this.pendingPermission;
            this.pendingPermission = null;
        }

        this.ws.send(JSON.stringify(msg));

        // Track whether this send included images (for uploads:changed event)
        this._lastSendHadImages = images.length > 0;

        return true;
    }

    // Send stop/interrupt signal to Claude
    stop() {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            return false;
        }

        const msg = { type: 'stop' };
        this.ws.send(JSON.stringify(msg));
        return true;
    }

    // Send clear_session to server to reset Claude's conversation
    clearServer() {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            return false;
        }

        const msg = { type: 'clear_session' };
        this.ws.send(JSON.stringify(msg));
        return true;
    }

    /**
     * Update activity strip for this session (only if active).
     * Stores last activity for tab-switch restore.
     * @param {{ active: boolean, icon?: string, text?: string }} activity
     */
    _setActivity(activity) {
        if (activity.active) {
            // Track when this turn started (first activity call per turn)
            if (!this._turnStartTime) {
                this._turnStartTime = Date.now();
            }
            this._lastActivity = { ...activity, startTime: this._turnStartTime };
        } else {
            this._lastActivity = null;
            this._turnStartTime = null;
            // Turn is over — any permission-pause bookkeeping is moot
            this._permPausedAt = null;
            this._activityBeforePermission = null;
        }
        if (this.isActive) {
            const app = getApp();
            app.setActivity(this._lastActivity || activity);
        }
    }

    /**
     * Extract token usage from result message
     *
     * NOTE: contextTokens is now set by server-side /context command (context_update message)
     * which is more accurate. This method only tracks cumulative totals for cost display.
     */
    extractTokenUsage(data) {
        const app = getApp();

        // Track cumulative totals (for cost display)
        if (data.modelUsage) {
            const models = Object.keys(data.modelUsage);
            const modelKey = this.model && models.includes(this.model) ? this.model : models[0];

            if (modelKey) {
                const usage = data.modelUsage[modelKey];
                this.totalInputTokens += (usage.inputTokens || 0) +
                                        (usage.cacheCreationInputTokens || 0);
                this.totalOutputTokens += usage.outputTokens || 0;
            }
        } else if (data.usage) {
            const usage = data.usage;
            this.totalInputTokens += (usage.input_tokens || 0) +
                                    (usage.cache_creation_input_tokens || 0);
            this.totalOutputTokens += usage.output_tokens || 0;
        }

        // Persist to localStorage
        if (app) {
            app.sessionManager.saveSessions();
        }
    }

    updateTab() {
        const app = getApp();
        if (app) {
            app.renderTabs();
        }
    }

    clear() {
        const app = getApp();
        this.messages = [];
        this.providerSessionId = null;  // Reset to start fresh conversation
        this.lastSyncTimestamp = null;  // Reset sync state
        if (app.activeSession === this) {
            app.renderMessages();
        }
        // Persist cleared state
        app.sessionManager.saveSessions();
    }
}

// Mix in cohesive sub-concerns. Each module exports a plain object of methods
// that use `this` (Session instance state) — assigning onto the prototype
// keeps the class API identical to the pre-split implementation.
Object.assign(
    Session.prototype,
    messageWriteMethods,
    messageStoreMethods,
    syncMethods,
    wsHandlerMethods,
    agentStreamMethods,
    interactiveMethods,
    agentProgressMethods,
    persistenceMethods,
);

/**
 * Manages multiple sessions
 */
export class SessionManager {
    constructor() {
        this.sessions = [];
        this.recentlyClosed = [];  // Stack of recently closed sessions (for Ctrl+Shift+T)
        this._maxRecentlyClosed = 10;  // Limit stack size
        this._saveFailCount = 0;  // Track consecutive save failures
        this._lastSaveTime = 0;   // Debounce saves
        this.loadSessions();
    }

    loadSessions() {
        const saved = Storage.get(CONFIG.STORAGE_KEY, []);
        debug.log('[SessionManager] Loading sessions from localStorage:', saved.length, 'sessions');
        debug.log('[SessionManager] Session IDs:', saved.map(s => s.id));
        saved.forEach(data => {
            const session = new Session(data);
            // Deduplicate on load (handles any persisted duplicates from earlier bugs)
            session.deduplicateMessages();
            // Persisted session fields can lag behind persisted messages
            // (context_update saved messages but the field save failed, or
            // vice versa) — the newest context message is the truth.
            session.adoptContextFromMessages();
            this.sessions.push(session);
        });
    }

    /**
     * Save sessions to localStorage IMMEDIATELY, bypassing debounce.
     * Use for critical save points like beforeunload/visibilitychange where
     * page may close before a debounced timer fires.
     * @returns {boolean} true if save succeeded
     */
    saveSessionsImmediate() {
        // Clear any pending debounced save
        if (this._pendingSave) {
            clearTimeout(this._pendingSave);
            this._pendingSave = null;
        }
        this._lastSaveTime = Date.now();

        const data = this.sessions.map(s => s.toJSON());
        debug.log('[SessionManager] IMMEDIATE SAVE:', data.length, 'sessions, IDs:', data.map(s => s.id));
        const success = Storage.set(CONFIG.STORAGE_KEY, data);

        // Also persist tab identity to server (fire-and-forget).
        // iPadOS PWA localStorage writes can silently fail to persist to disk,
        // so the server copy is the reliable source of truth on reload.
        this._postTabStateToServer();

        return success;
    }

    /**
     * Save sessions to localStorage with automatic cleanup on quota exceeded
     * @returns {boolean} true if save succeeded
     */
    saveSessions() {
        // Debounce saves - at most once per 100ms
        const now = Date.now();
        if (now - this._lastSaveTime < 100) {
            // Schedule a deferred save to ensure we don't lose the last update
            if (!this._pendingSave) {
                this._pendingSave = setTimeout(() => {
                    this._pendingSave = null;
                    this.saveSessions();
                }, 100);
            }
            return true; // Assume success for debounced calls
        }
        this._lastSaveTime = now;
        if (this._pendingSave) {
            clearTimeout(this._pendingSave);
            this._pendingSave = null;
        }

        const data = this.sessions.map(s => s.toJSON());
        debug.log('[SessionManager] saveSessions() - saving IDs:', data.map(s => s.id));
        let success = Storage.set(CONFIG.STORAGE_KEY, data);

        if (!success) {
            this._saveFailCount++;
            debug.warn(`[SessionManager] Save failed (attempt ${this._saveFailCount})`);

            // Try aggressive cleanup: reduce message limit per session
            if (this._saveFailCount <= 3) {
                const reducedLimit = Math.max(5, 30 - (this._saveFailCount * 10));
                const reducedData = this.sessions.map(s => s.toJSON(reducedLimit));
                success = Storage.set(CONFIG.STORAGE_KEY, reducedData);

                if (success) {
                    debug.log(`[SessionManager] Saved with reduced message limit: ${reducedLimit}`);
                    this._saveFailCount = 0;
                }
            }

            // Notify user if all retry attempts failed
            if (!success && this._saveFailCount >= 3) {
                console.error('[SessionManager] localStorage save failed after retries - storage full');
                window.app?.activeSession?.addSystemLog(
                    'Session save failed - browser storage full. Consider clearing old sessions.',
                    'error'
                );
            }
        } else {
            this._saveFailCount = 0;
        }

        return success;
    }

    /**
     * POST current tab identity to the server (fire-and-forget).
     * Server persists to disk — immune to iPadOS PWA localStorage write-loss.
     * Debounced: at most once per 500ms to avoid flooding on rapid saves.
     */
    _postTabStateToServer(opts = {}) {
        if (this._tabPostTimer) {
            clearTimeout(this._tabPostTimer);
        }
        // immediate: active-session switches post right away instead of
        // waiting out the debounce — the server's activeStoreId pointer is
        // now consulted unconditionally on load (see app.initFromUrl), so a
        // reload landing inside the 500ms window must not restore the
        // previous session. Structural saves keep the debounce.
        const send = () => {
            this._tabPostTimer = null;

            // Don't publish a half-built strip. The init path switches to the
            // saved session (which posts immediately) BEFORE restoreWidgetTabs()
            // recreates the widget tabs, so posting here would write
            // widgetTabs: [] and wipe the server's record of them — the strip
            // would come back short a tab, with everything behind it shifted.
            // Retry-capped so a boot that never restores can still persist.
            const tabCtrl = window.app?.tabCtrl;
            if (tabCtrl && !tabCtrl.widgetTabsRestored
                && (this._tabPostDeferred = (this._tabPostDeferred || 0) + 1) <= 20) {
                this._tabPostTimer = setTimeout(send, 250);
                return;
            }
            this._tabPostDeferred = 0;

            const sessions = this.sessions
                .filter(s => s.storeId)
                .map(s => ({
                    storeId: s.storeId,
                    name: s.name,
                    cwd: s.cwd,
                    // Provider identity rides along so a server-state rebuild
                    // (iPadOS localStorage loss) repaints the right provider's
                    // vocabulary immediately instead of flashing the default
                    // provider until the WS `connected` frame arrives.
                    provider: s.provider || s.pendingProvider || undefined,
                    providerLocked: s.providerLocked || undefined,
                }));
            const activeStoreId = window.app?.activeSession?.storeId || null;

            // v2: widget tabs + unified strip order ride along so the whole
            // strip (not just sessions) survives iPadOS localStorage loss.
            const widgetTabs = tabCtrl ? tabCtrl.serializeWidgetTabs() : [];
            const order = tabCtrl ? tabCtrl.getOrderForPersistence() : [];
            const activeTab = (tabCtrl?.activeMode === 'widget' && tabCtrl.activeWidgetTabId)
                ? { kind: 'widget', id: tabCtrl.activeWidgetTabId }
                : { kind: 'session', storeId: activeStoreId };

            fetch(`${CONFIG.API_BASE}/api/app/tabs`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sessions, activeStoreId, widgetTabs, order, activeTab }),
            }).catch(() => {});  // Fire-and-forget
        };
        if (opts.immediate) {
            send();
        } else {
            this._tabPostTimer = setTimeout(send, 500);
        }
    }

    /**
     * Fetch server-side tab state and reconcile with localStorage sessions.
     * Called during app init. If server has different tabs than localStorage,
     * server wins — rebuild session list from server storeIds.
     * @returns {boolean} true if sessions were replaced from server state
     */
    async reconcileWithServer() {
        try {
            const resp = await fetch(`${CONFIG.API_BASE}/api/app/tabs`);
            if (!resp.ok) return false;
            const serverState = await resp.json();

            // Stash full state for TabController (widget tabs + strip order),
            // regardless of whether the session set matches.
            this._serverTabState = serverState;

            const serverSessions = serverState.sessions || [];
            if (serverSessions.length === 0) return false;

            // Compare: do localStorage sessions have the same storeIds as server?
            const localStoreIds = new Set(this.sessions.map(s => s.storeId).filter(Boolean));
            const serverStoreIds = serverSessions.map(s => s.storeId);

            const match = serverStoreIds.length === localStoreIds.size &&
                serverStoreIds.every(id => localStoreIds.has(id));

            if (match) {
                debug.log('[SessionManager] Server tab state matches localStorage');
                return false;
            }

            // Mismatch! Server has different tabs. Rebuild from server.
            console.warn('[SessionManager] TAB STATE MISMATCH — rebuilding from server.',
                'Server:', serverStoreIds, 'Local:', [...localStoreIds]);

            // Disconnect old sessions
            this.sessions.forEach(s => s.disconnect());
            this.sessions = [];

            // Create stub sessions from server state (messages will load via syncMessages)
            for (const srv of serverSessions) {
                const session = new Session({
                    storeId: srv.storeId,
                    name: srv.name || '',
                    cwd: srv.cwd || '',
                    wasConnected: true,
                    // Provider identity persisted with the tab state — first
                    // paint is provider-correct, reconfirmed on connect.
                    provider: srv.provider || null,
                    providerLocked: !!srv.providerLocked,
                });
                this.sessions.push(session);
            }

            // (Active-session pointer is read from _serverTabState.activeStoreId
            // by app.initFromUrl — unconditionally, not just on rebuild.)

            // Persist the corrected state to localStorage
            Storage.set(CONFIG.STORAGE_KEY, this.sessions.map(s => s.toJSON()));

            debug.log('[SessionManager] Rebuilt', this.sessions.length,
                'sessions from server tab state');
            return true;
        } catch (e) {
            console.warn('[SessionManager] Failed to fetch server tab state:', e);
            return false;
        }
    }

    create(options = {}) {
        const { atIndex, ...sessionOptions } = options;
        const session = new Session(sessionOptions);
        if (atIndex !== undefined && atIndex >= 0 && atIndex <= this.sessions.length) {
            this.sessions.splice(atIndex, 0, session);
        } else {
            this.sessions.push(session);
        }
        debug.log('[SessionManager] create() new session:', session.id, 'total:', this.sessions.length);
        // CRITICAL: Bypass debounce for structural changes (add/remove sessions).
        // The debounced saveSessions() can be swallowed if a WebSocket message
        // triggered a save within the last 100ms, and on iPadOS PWA beforeunload
        // is unreliable — so the deferred save may never fire before reload.
        this.saveSessionsImmediate();
        return session;
    }

    /**
     * @param {Session} session
     * @param {Object} [options]
     * @param {number} [options.stripIndex] - Strip slot this tab occupied, so
     *   Ctrl+Shift+T can put it back there instead of appending at the end.
     *   Callers must read it (tabCtrl.getTabPosition) BEFORE calling remove().
     */
    remove(session, options = {}) {
        debug.log('[SessionManager] remove() called for session:', session.id);
        // Save session data for potential reopening (Ctrl+Shift+T)
        // Only save if session has a storeId (persisted to server)
        if (session.storeId) {
            this.recentlyClosed.push({
                storeId: session.storeId,
                name: session.name,
                cwd: session.cwd,
                stripIndex: options.stripIndex,
                closedAt: new Date().toISOString()
            });
            // Limit stack size
            if (this.recentlyClosed.length > this._maxRecentlyClosed) {
                this.recentlyClosed.shift();
            }
        }

        session.disconnect();
        const idx = this.sessions.indexOf(session);
        if (idx > -1) {
            this.sessions.splice(idx, 1);
            debug.log('[SessionManager] After remove, session IDs:', this.sessions.map(s => s.id));
            // CRITICAL: Bypass debounce for structural changes (add/remove sessions).
            // See create() comment for full explanation.
            this.saveSessionsImmediate();
        }
    }

    get(id) {
        return this.sessions.find(s => s.id === id);
    }

    getTotalCost() {
        return this.sessions.reduce((sum, s) => sum + s.totalCost, 0);
    }
}
