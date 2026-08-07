/**
 * WebSocket envelope-handler mixin — the big switch on `msg.type` for the
 * server's bridge protocol (`connected`, `agent_message`, `session_persisted`,
 * `session_meta_update`, `turn_summary`, `context_update`, `session_ended`,
 * `error`, `auth_error`, `stderr`, `status`, `compact_progress`,
 * `api_retry_status`, `interrupted`, `ready`, `session_cleared`, `stopped`,
 * `waiting_for_input`, `user_message_stored`, `permission_mode_changed`).
 *
 * Doesn't peer into the inner agent stream — that's `agent_message` →
 * `handleAgentMessage` (in handle-agent-message.js).
 *
 * Applied to Session.prototype via Object.assign in session.js.
 */

import S from '../strings.js';
import { debug, setServerHome, setServerWorkspace } from '../config.js';
import { genId } from '../utils.js';
import { refreshAgentsForCwd } from '../snippets-autocomplete.js';
import { WidgetBus } from '../widget-system/event-bus.js';

const getApp = () => window.app;

export const wsHandlerMethods = {
    handleMessage(msg) {
        const app = getApp();
        this.lastActivity = new Date().toISOString();

        switch (msg.type) {
            case 'connected':
                // Set server home + workspace (only first time — values are immutable).
                if (msg.home) setServerHome(msg.home);
                if (msg.workspace) setServerWorkspace(msg.workspace);
                // Anchor the file explorer to the explicit workspace if set
                // (the project base — /workspace/<proj> in Docker), falling
                // back to the OS user home for plain host installs.
                {
                    const anchor = msg.workspace || msg.home;
                    if (anchor && app.fileExplorer) {
                        app.fileExplorer.setHomePath(anchor);
                    }
                }
                if (msg.cwd) {
                    this.cwd = msg.cwd;
                    this.name = this.cwd.split('/').pop() || 'Session';
                    this.updateTab();
                    // Fetch Claude commands for this project
                    if (app.fetchAgentCommands) {
                        app.fetchAgentCommands(msg.cwd);
                    }
                    // Fetch git branch for status bar (if this is the active session)
                    if (this.isActive && app.fetchGitBranch) {
                        app.fetchGitBranch(msg.cwd);
                    }
                    // Update project name in status bar
                    if (this.isActive && app.statusBar?.updateProject) {
                        app.statusBar.updateProject(msg.cwd);
                    }
                    // Refresh agents for project-local agents (async, non-blocking)
                    refreshAgentsForCwd(msg.cwd).catch(e =>
                        console.warn('Failed to refresh agents for cwd:', e)
                    );
                }
                // Adopt the session's engine identity + capabilities. The
                // server is authoritative — an unknown picker choice degrades
                // to the default engine, so this reflects what actually bound.
                if (msg.provider) {
                    const engineChanged = this.provider !== msg.provider;
                    this.provider = msg.provider;
                    this.providerDisplayName = msg.provider_display_name || msg.provider;
                    this.providerCaps = msg.provider_caps || null;
                    this.providerLocked = !!msg.provider_locked;
                    this.pendingProvider = null;  // choice landed (or was overridden)
                    if (this.isActive) {
                        app.updateStatus();
                        // Each engine speaks its own permission vocabulary —
                        // refresh the popup when the binding (first) arrives.
                        if (engineChanged && window.permissionSettings) {
                            window.permissionSettings.setSession(msg.session_id || this.storeId || null);
                        }
                    }
                }
                // Sync name from server (for renamed sessions and summary-fork titles)
                // Server sends this for persisted sessions to sync across clients
                if (msg.name) {
                    this.name = msg.name;
                    this.updateTab();
                    app.sessionManager.saveSessions();
                }
                // Capture server-side session ID for URL sharing
                if (msg.session_id) {
                    this.storeId = msg.session_id;
                    // Load stash for this session (if active)
                    if (this.isActive && window.loadStashForSession) {
                        window.loadStashForSession(this.storeId);
                    }
                    // Update token profile with session ID (was null during switchSession)
                    if (this.isActive && window.tokenProfile) {
                        window.tokenProfile.setSession(this.storeId);
                    }
                    // Load prompt history from server (for up/down navigation)
                    this.loadPromptHistory();
                }
                // Show appropriate connection message and update typing state
                // Track per-session Claude running state from server
                this.isAgentRunning = msg.agent_running || false;
                // Note: Don't set isReady on reconnect - green dot is only for NEW completed work
                // Only update typing indicator if this is the active session
                if (msg.is_reconnect && msg.agent_running) {
                    this.addSystemLog(S.status.reconnected_running.replace('{cwd}', msg.cwd));
                    // Restore turn start time from server so timer shows real elapsed time
                    if (msg.turn_start) {
                        this._turnStartTime = new Date(msg.turn_start).getTime();
                    }
                    // Show activity strip — compacting or generic working
                    if (msg.is_compacting) {
                        this._setActivity({ active: true, icon: 'compress', label: S.activity.states.compacting });
                    } else {
                        this._setActivity({ active: true, icon: 'sparkle', label: S.activity.states.working });
                    }
                } else if (msg.is_reconnect) {
                    this.addSystemLog(S.status.reconnected.replace('{cwd}', msg.cwd));
                    this._setActivity({ active: false });
                } else {
                    this.addSystemLog(S.status.working_directory.replace('{cwd}', msg.cwd));
                    this._setActivity({ active: false });
                }
                // After reconnect, sync any messages missed during the disconnect gap
                // syncMessages(fullSync=true) fetches last 100 messages, adds new ones,
                // updates incomplete ones, and re-renders if this is the active session
                if (msg.is_reconnect && this.storeId) {
                    this.syncMessages(true).then(({ synced }) => {
                        if (synced > 0) {
                            debug.log(`[Reconnect] Synced ${synced} missed messages`);
                        }
                    }).catch(e => debug.log(`[Reconnect] Sync failed: ${e}`));
                }
                break;

            case 'session_persisted':
                // Session was just persisted to disk after first message.
                // Now safe to save the session_id for URL sharing and reconnects.
                if (msg.session_id) {
                    this.storeId = msg.session_id;
                    // Load stash for this session (if active)
                    if (this.isActive && window.loadStashForSession) {
                        window.loadStashForSession(this.storeId);
                    }
                    // Update token profile with session ID
                    if (this.isActive && window.tokenProfile) {
                        window.tokenProfile.setSession(this.storeId);
                    }
                    app.sessionManager.saveSessions();
                    // Load prompt history (though it's likely empty for new session)
                    this.loadPromptHistory();
                }
                break;

            case 'session_meta_update':
                // Session metadata updated (e.g., name from the summary-fork shadow git)
                if (msg.name) {
                    this.name = msg.name;
                    this.updateTab();
                    app.sessionManager.saveSessions();
                    debug.log('Session name updated:', msg.name);
                }
                break;

            case 'turn_summary':
                // Immediate turn data (files, tools, cost, duration) — arrives before /context
                // Renders partial bar; context_update will upgrade it in-place later
                if (msg.turnNumber) {
                    this._pendingTurnNumber = msg.turnNumber;
                    if (this.isActive) {
                        app.chatCtrl.renderTurnSummaryPartial(msg);
                    } else {
                        // Store for rendering when tab becomes active
                        this._pendingTurnSummary = msg;
                    }
                    // Store as preliminary context message so it survives page reload.
                    // Without this, reloading during the 2-5s context fetch window loses
                    // the bar entirely (turn_summary is transient DOM, not in messages).
                    // context_update will replace this message with full context data.
                    // Push directly (not addMessage) to avoid re-rendering the bar we just rendered.
                    const turnMsg = {
                        role: 'context',
                        _partial: true,  // Flag: no context data yet (renders as partial bar)
                        turnNumber: msg.turnNumber,
                        durationMs: msg.durationMs,
                        costUsd: msg.costUsd,
                        changedFiles: msg.changedFiles,
                        toolsSummary: msg.toolsSummary,
                        fileActions: msg.fileActions,
                        readImages: msg.readImages,
                        cwd: msg.cwd,
                        rateLimited: msg.rateLimited,
                        model: msg.model,
                        dbTurnId: msg.dbTurnId,  // DuckDB turn UUID, used by /api/turns/{id}
                        id: genId(),
                        timestamp: new Date().toISOString(),
                        turnId: this.turnId,
                    };
                    this.messages.push(turnMsg);
                    this.updateSyncTimestamp(turnMsg.timestamp);
                    app.sessionManager.saveSessions();
                    debug.log(`Turn summary T${msg.turnNumber}: ${msg.changedFiles?.length || 0} files, $${msg.costUsd || 0}`);
                }
                break;

            case 'context_update':
                // Accurate token usage from server-side /context command
                // Upgrades existing partial bar (from turn_summary) or creates full bar
                if (msg.contextTokens !== undefined && msg.contextWindow !== undefined) {
                    this.contextTokens = msg.contextTokens;
                    this.contextWindow = msg.contextWindow;
                    // Store full breakdown for popover display
                    this.contextBreakdown = msg.breakdown || null;
                    this.contextMemoryFiles = msg.memoryFiles || null;
                    this.contextUpdatedAt = Date.now();
                    this._pendingTurnNumber = null;
                    this._pendingTurnSummary = null;
                    if (this.isActive) {
                        app.updateStatus();
                    }
                    // Find and replace the preliminary context message (from turn_summary)
                    // or add as new if no preliminary exists
                    const turnNum = msg.turnNumber;
                    let replaced = false;
                    if (turnNum) {
                        for (let i = this.messages.length - 1; i >= 0; i--) {
                            const m = this.messages[i];
                            if (m.role === 'context' && m._partial && m.turnNumber === turnNum) {
                                // Upgrade in-place: preserve id/timestamp, replace data
                                Object.assign(m, {
                                    _partial: undefined,  // Clear partial flag
                                    contextTokens: msg.contextTokens,
                                    contextWindow: msg.contextWindow,
                                    breakdown: msg.breakdown,
                                    memoryFiles: msg.memoryFiles,
                                    cwd: msg.cwd,
                                    model: msg.model ?? m.model,
                                    dbTurnId: msg.dbTurnId ?? m.dbTurnId,
                                });
                                replaced = true;
                                // Re-render this message
                                if (this.isActive) {
                                    app.renderMessage(m);
                                } else {
                                    const sessionId = this.id || this.storeId || this.sessionId;
                                    app.chatCtrl?.invalidateSession(sessionId);
                                }
                                app.sessionManager.saveSessions();
                                break;
                            }
                        }
                    }
                    if (!replaced) {
                        // Sweep any leftover partial for this turn that the in-place
                        // upgrade didn't catch — once this full update lands as its
                        // own message, a same-turn partial can never load.
                        if (turnNum) {
                            const before = this.messages.length;
                            this.messages = this.messages.filter(
                                m => !(m.role === 'context' && m._partial && m.turnNumber === turnNum)
                            );
                            if (this.messages.length !== before && this.isActive) {
                                const sessionId = this.id || this.storeId || this.sessionId;
                                app.chatCtrl?.invalidateSession(sessionId);
                                app.renderMessages();
                            }
                        }
                        this.addMessage({
                            role: 'context',
                            contextTokens: msg.contextTokens,
                            contextWindow: msg.contextWindow,
                            breakdown: msg.breakdown,
                            memoryFiles: msg.memoryFiles,
                            turnNumber: msg.turnNumber,
                            durationMs: msg.durationMs,
                            costUsd: msg.costUsd,
                            changedFiles: msg.changedFiles,
                            toolsSummary: msg.toolsSummary,
                            fileActions: msg.fileActions,
                            readImages: msg.readImages,
                            cwd: msg.cwd,
                            model: msg.model,
                            dbTurnId: msg.dbTurnId,
                        });
                    }
                    debug.log(`Context updated: ${msg.contextTokens} / ${msg.contextWindow}`, msg.breakdown);
                }
                break;

            case 'agent_message':
                // Pass server timestamp for sync deduplication (uses same timestamp as server store)
                this.handleAgentMessage(msg.data, msg.timestamp);
                break;

            case 'session_ended':
                this.addSystemLog(S.status.session_ended.replace('{reason}', msg.reason));
                this.isAgentRunning = false;  // Claude stopped (normal exit or crash)
                this.isReady = false;  // Session ended, not ready
                // Pending permission asks died with the process — expire their
                // cards (before the activity reset below takes over the strip).
                this.expirePendingPermissionCards();
                this._setActivity({ active: false });
                // Move any still-running agents to completed (they won't get result events)
                this._flushStaleAgents();
                break;

            case 'error':
                this.addSystemLog(`Error: ${msg.message}`, 'error');
                // Show all errors in chat so user sees what went wrong
                if (msg.message) {
                    this.addMessage({
                        role: 'error',
                        content: msg.message,
                        source: 'server'
                    });
                }
                // If session not found, clear the storeId to prevent reconnect loops
                if (msg.message && msg.message.includes('Session not found')) {
                    debug.warn('Session not found on server, clearing storeId');
                    this.storeId = null;
                    app.sessionManager.saveSessions();
                }
                break;

            case 'auth_error': {
                // The engine CLI returned an auth failure (expired token /
                // invalid key / 401). Stop the spinner and surface a clickable
                // affordance that drops the user into the engine's own login
                // terminal (frame carries engine label + login_command).
                this.isAgentRunning = false;
                this._setActivity({ active: false });
                this.updateTab();
                this.addSystemLog(`Auth error: ${msg.message || '401'}`, 'error');
                const engine = msg.engine || 'Claude';
                this.addMessage({
                    role: 'auth_error',
                    content: msg.message || S.auth.error_generic.replace('{engine}', engine),
                    engine,
                    loginCommand: msg.login_command || null,
                    source: 'server',
                });
                break;
            }

            case 'stderr':
                debug.warn('stderr:', msg.data);
                // Display stderr in chat as error message
                if (msg.data) {
                    this.addMessage({
                        role: 'error',
                        content: msg.data,
                        source: 'stderr'
                    });
                }
                break;

            case 'status':
                // Status updates (e.g., compacting from stderr detection)
                if (msg.status === 'compacting') {
                    this._compactStartTime = Date.now();
                    this.addSystemLog(msg.message || 'Compacting conversation...');
                    this._setActivity({ active: true, icon: 'compress', label: S.activity.states.compacting });
                }
                break;

            case 'compact_progress':
                // Turn heartbeat (grew out of the compaction-only keepalive).
                // The server pings whenever a turn is active and the wire is
                // otherwise silent — including the post-boundary continuation
                // that used to be 60s of dead air. Its arrival is also a
                // self-heal signal: the server only sends this mid-turn, so a
                // strip stuck on idle re-lights from it.
                if (msg.is_compacting === false) {
                    // Turn is active but not (or no longer) compacting — only
                    // touch the strip if it's idle or stuck on the compacting
                    // label; never clobber a live thinking/tool label.
                    if (!this._lastActivity?.active || this._lastActivity?.icon === 'compress') {
                        this._setActivity({ active: true, icon: 'sparkle', label: S.activity.states.working });
                    }
                } else if (msg.elapsed) {
                    // is_compacting true (or legacy frame without the field)
                    const secs = msg.elapsed;
                    const label = `${S.activity.states.compacting} (${secs}s)`;
                    this._setActivity({ active: true, icon: 'compress', label });
                }
                this.isAgentRunning = true;
                break;

            case 'api_retry_status':
                // Auto-retry status for transient API errors (500, 529, overloaded)
                if (msg.status === 'waiting') {
                    const retryMsg = S.retry.waiting
                        .replace('{delay}', msg.delay)
                        .replace('{retry_num}', msg.retry_num)
                        .replace('{max_retries}', msg.max_retries);
                    this.addSystemLog(retryMsg, 'warn');
                    this._setActivity({
                        active: true, icon: 'refresh',
                        label: S.retry.activity_waiting.replace('{delay}', msg.delay)
                    });
                } else if (msg.status === 'retrying') {
                    const retryMsg = S.retry.retrying
                        .replace('{retry_num}', msg.retry_num)
                        .replace('{max_retries}', msg.max_retries);
                    this.addSystemLog(retryMsg);
                    this._setActivity({
                        active: true, icon: 'sparkle',
                        label: S.retry.activity_retrying
                            .replace('{retry_num}', msg.retry_num)
                            .replace('{max_retries}', msg.max_retries)
                    });
                } else if (msg.status === 'failed') {
                    this.addMessage({
                        role: 'error',
                        content: msg.message || S.retry.exhausted,
                        source: 'api_retry'
                    });
                    this._setActivity({ active: false });
                }
                break;

            case 'interrupted':
                this.addSystemLog(S.status.stopping);
                // Stop retires any pending permission asks (SIGINT path: the
                // process is dying; live-controls path: the driver already
                // denied them) — freeze the cards as expired so they can't
                // be answered into a void.
                this.expirePendingPermissionCards();
                this._setActivity({ active: false });
                break;

            case 'ready':
                this.addSystemLog(S.status.ready);
                this.isAgentRunning = false;
                // Note: Don't set isReady here - only 'result' message triggers green dot
                // This prevents green dot on reconnect to idle sessions
                this.updateTab();
                this._setActivity({ active: false });
                break;

            case 'session_cleared':
                this.addSystemLog(S.status.cleared);
                this._setActivity({ active: false });
                break;

            case 'stopped':
                this.addSystemLog(S.status.stopped);
                // Show visible message in chat
                this.addMessage({ role: 'info', content: S.status.stopped });
                this._setActivity({ active: false });
                break;

            case 'waiting_for_input':
                // Claude auto-stopped to wait for user input (AskUserQuestion/ExitPlanMode)
                this.isAgentRunning = false;
                this._setActivity({ active: false });
                this.updateTab();
                break;

            case 'permission_request':
                // Interactive permission ask (claude-sdk provider) — the process
                // is paused until the user answers via the permission card.
                this.handlePermissionRequest(msg);
                break;

            case 'permission_resolved':
                // Server ack for our permission_response (ok=false → expired)
                this.handlePermissionResolved(msg);
                break;

            case 'user_message_stored':
                // Server sends back promptId and verifiedFiles after storing user message
                this._updateLastUserMessageWithPromptId(msg.promptId, msg.isFavorite, msg.verifiedFiles);
                // Notify uploads widget if this message had images (now persisted to disk)
                if (this._lastSendHadImages && this.storeId) {
                    WidgetBus.emit('uploads:changed', { sessionId: this.storeId });
                    this._lastSendHadImages = false;
                }
                break;

            case 'message_stored': {
                // A server-stored message broadcast to every attached client —
                // peer prompts from another device/tab, server-side info rows
                // (compact boundaries, notices). sid matching makes this
                // idempotent: the originating client's local copy adopts the
                // server identity; other clients append and render.
                const raw = msg.message || {};
                if (raw.sid == null) {
                    raw.sid = raw.id
                        || (msg.line && this.storeId ? `${this.storeId}:${msg.line}` : undefined);
                }
                const stored = app.transformServerMessages([raw], this.storeId)[0];
                if (!stored) break;
                const existing = this.findMatchingMessage(stored);
                if (existing) {
                    if (stored.sid != null && existing.sid == null) {
                        existing.sid = stored.sid;
                    }
                } else {
                    this.addMessage(stored);
                }
                this.updateSyncTimestamp(stored.timestamp);
                break;
            }

            case 'permission_mode_changed': {
                this.permissionMode = msg.mode;
                // `applied` tells the truth about when the mode takes effect:
                // 'live' = the running engine switched in place (SDK provider),
                // 'next_turn' = picked up by the respawn on the next message.
                const modeStr = msg.applied === 'live' ? S.status.permission_mode_live
                    : msg.applied === 'next_turn' ? S.status.permission_mode_next_turn
                    : S.status.permission_mode;
                this.addSystemLog(modeStr.replace('{mode}', msg.mode), 'info');
                this.updateTab();  // Update tab badge
                if (this.isActive) {
                    app.updateInputPlaceholder();  // Update placeholder for mode
                    // Sync permission button with server state
                    if (window.permissionSettings) {
                        window.permissionSettings.currentLevel = msg.mode;
                        window.permissionSettings.updateButtonState();
                    }
                }
                // Typing state will be handled by agent_message when Claude starts responding
                break;
            }
        }

        // Only mark as unread for content messages, not connection/status messages
        // Excludes: connected, session_persisted, pong, interrupted, ready, session_cleared, stopped, status, permission_mode_changed
        const isContentMessage = ['agent_message', 'error', 'stderr', 'permission_request'].includes(msg.type);
        if (app.activeSession !== this && isContentMessage) {
            this.unread = true;
            this.updateTab();
        }
    },
};
