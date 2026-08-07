/**
 * Session sync mixin — server-backed message fetching.
 *   - syncMessages: pull missed messages after reconnect or background-tab
 *     return; reconciles with local via findMatchingMessage / isMoreComplete.
 *   - loadOlderMessages: lazy-load older history during infinite scroll.
 *   - loadPromptHistory: pull user prompts (most recent 50) for up/down
 *     navigation in the input box.
 *
 * All three use `this.storeId` and `app.transformServerMessages` to convert
 * server JSONL → client format. Applied to Session.prototype via
 * Object.assign in session.js.
 */

import { CONFIG, debug } from '../config.js';
import { genId } from '../utils.js';

const getApp = () => window.app;

export const syncMethods = {
    // Mirror session-level context stats from the newest context message.
    // Turn-summary bars render straight from messages, but the bottom status
    // bar reads session.contextTokens — which only the live context_update
    // WS message sets. When a turn's context_update was missed (page closed,
    // WS down, other device) the synced messages carry the fresh numbers;
    // adopt them so the status bar matches the last turn bar.
    adoptContextFromMessages() {
        for (let i = this.messages.length - 1; i >= 0; i--) {
            const m = this.messages[i];
            if (m.role !== 'context' || m._partial || !m.contextTokens || !m.contextWindow) continue;
            if (m.contextTokens !== this.contextTokens || m.contextWindow !== this.contextWindow) {
                this.contextTokens = m.contextTokens;
                this.contextWindow = m.contextWindow;
                this.contextBreakdown = m.breakdown || null;
                this.contextMemoryFiles = m.memoryFiles || null;
                const ts = Date.parse(m.timestamp);
                this.contextUpdatedAt = Number.isNaN(ts) ? Date.now() : ts;
                if (this.isActive) getApp()?.updateStatus();
            }
            return;
        }
    },

    // Defensive un-stick: if the transcript proves the turn is over (the newest
    // user/result-class message is a result), a still-lit activity strip is
    // stale — the WS frame that would have cleared it was lost. Sync runs over
    // HTTP, so this recovers even while the WebSocket is half-dead. The inverse
    // is never touched: a user message newer than every result means a turn is
    // (or may be) in flight, and live frames own the strip.
    reconcileActivityFromMessages() {
        if (!this._lastActivity?.active) return;
        // Fresh turns belong to live frames — only act on a strip that's been
        // lit for 2+ minutes (past any clock-skew ambiguity between the local
        // user-message timestamp and server-stored rows).
        if (this._turnStartTime && Date.now() - this._turnStartTime < 120_000) return;
        let verdict = null;  // newest decisive role seen, scanning backwards
        for (let i = this.messages.length - 1; i >= 0; i--) {
            const role = this.messages[i].role;
            if (role === 'user' || role === 'result') { verdict = role; break; }
        }
        if (verdict === 'result') {
            debug.log('[Sync] Newest decisive message is a result — clearing stale activity strip');
            this._setActivity({ active: false });
            this.isAgentRunning = false;
        }
    },

    // Sync messages from server (called when app returns from background)
    // fullSync=true updates existing AND adds genuinely new messages (but not re-adding trimmed ones)
    async syncMessages(fullSync = false) {
        const app = getApp();
        // Don't sync while loading from server (race condition) or already syncing
        if (!this.storeId || this.isSyncing || this.isLoadingFromServer) {
            return { synced: 0, error: null };
        }

        this.isSyncing = true;
        try {
            // For full sync: fetch last N to update incomplete tool outputs (sort=desc)
            // For incremental: fetch new messages since last sync (sort=asc)
            const since = fullSync ? '' : (this.lastSyncTimestamp || '');
            const limit = fullSync ? 100 : 100;  // Reasonable limit for both cases
            const sort = fullSync ? 'desc' : 'asc';
            const url = `${CONFIG.API_BASE}/api/sessions/${this.storeId}/logs/messages?since=${encodeURIComponent(since)}&sort=${sort}&limit=${limit}`;

            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const data = await response.json();
            if (!data.messages || data.messages.length === 0) {
                return { synced: 0, error: null };
            }

            // Transform server messages to client format
            const newMessages = app.transformServerMessages(data.messages, this.storeId);
            let addedCount = 0;
            let updatedCount = 0;

            // For fullSync: determine boundaries to decide what to add
            // - Messages NEWER than our newest → add (genuinely new from server)
            // - Messages OLDER than our oldest → don't add (they were trimmed)
            let newestLocalTimestamp = null;
            let oldestLocalTimestamp = null;
            if (fullSync && this.messages.length > 0) {
                const timestamps = this.messages
                    .map(m => m.timestamp)
                    .filter(t => t)
                    .sort();
                if (timestamps.length > 0) {
                    oldestLocalTimestamp = timestamps[0];
                    newestLocalTimestamp = timestamps[timestamps.length - 1];
                }
            }

            for (const msg of newMessages) {
                const existing = this.findMatchingMessage(msg);
                if (existing) {
                    // Adopt server identity onto the local (live-rendered) copy so
                    // every future match/dedup is exact instead of heuristic.
                    if (msg.sid != null && existing.sid == null) {
                        existing.sid = msg.sid;
                    }
                    // Message exists - check if server has more complete data
                    if (this.isMoreComplete(msg, existing)) {
                        // Update existing message with server data (preserve local id).
                        // Clear _truncated: the server never stores that key, so a
                        // plain merge would leave it set and re-trigger this merge
                        // on every future sync.
                        const localId = existing.id;
                        Object.assign(existing, msg, { id: localId, _truncated: undefined });
                        updatedCount++;
                    }
                } else if (fullSync) {
                    // Full sync: add anything missing that isn't in the trimmed region.
                    // Trimming only ever removes the OLDEST messages, so "older than our
                    // oldest local" = deliberately trimmed → don't re-add. Anything at or
                    // after that boundary that we don't have was genuinely missed — e.g.
                    // a prompt sent from another device mid-history while this tab was
                    // detached. (The old rule — add only if NEWER than our newest —
                    // silently dropped exactly those gap messages forever.)
                    // Exception: context messages (turn summary bars) are small metadata
                    // that may not be in localStorage yet — always add them if missing.
                    const msgTime = msg.timestamp;
                    const inTrimmedRegion = oldestLocalTimestamp && msgTime && msgTime < oldestLocalTimestamp;
                    if (!inTrimmedRegion || msg.role === 'context') {
                        this.messages.push({
                            ...msg,
                            id: msg.id || genId(),
                            timestamp: msg.timestamp || new Date().toISOString()
                        });
                        addedCount++;
                        debug.log(`[Sync] Added missing message from fullSync:`, msg.role);
                    }
                    // else: message is older than our oldest - it was trimmed, don't re-add
                } else {
                    // Incremental sync: add all new messages
                    this.messages.push({
                        ...msg,
                        id: msg.id || genId(),
                        timestamp: msg.timestamp || new Date().toISOString()
                    });
                    addedCount++;
                }
                // Update sync timestamp for both fullSync and incremental
                // This ensures future incremental syncs know where to start
                this.updateSyncTimestamp(msg.timestamp);
            }

            if (addedCount > 0 || updatedCount > 0) {
                // Sort and deduplicate messages
                // Handles race conditions and slight timestamp variations
                this.sortMessagesByTimestamp();
                this.deduplicateMessages();
                this.adoptContextFromMessages();
                this.reconcileActivityFromMessages();

                this.lastActivity = new Date().toISOString();
                app.sessionManager.saveSessions();

                // If this is the active session, re-render all messages
                if (this.isActive) {
                    // Capture the live scroll offset before invalidating (mirrors the
                    // visibilitychange handler): keeps an at-bottom reader at the
                    // bottom and a scrolled-up reader in place through the re-render.
                    const scrollEl = app.getActiveScrollContainer?.();
                    if (scrollEl && scrollEl.clientHeight > 0) {
                        const atBottom = (scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight) <= 100;
                        this.scrollPosition = atBottom ? null : scrollEl.scrollTop;
                        this.isUserScrolledUp = !atBottom;
                    }
                    // Invalidate container pool to force full re-render (not use cached stale DOM)
                    const sessionId = this.id || this.storeId || this.sessionId;
                    app.chatCtrl?.invalidateSession(sessionId);
                    app.renderMessages();
                    app.scrollToBottom();
                }

                debug.log(`[Sync] ${this.name}: Added ${addedCount}, updated ${updatedCount} messages`);
            }

            return { synced: addedCount + updatedCount, error: null };
        } catch (error) {
            console.error(`[Sync] ${this.name}: Failed -`, error);
            return { synced: 0, error: error.message };
        } finally {
            this.isSyncing = false;
        }
    },

    // Load older messages (for infinite scroll / lazy loading)
    async loadOlderMessages(limit = 50) {
        const app = getApp();
        if (!this.storeId || this.isLoadingMore || !this.hasMoreMessages) {
            return { loaded: 0, error: null };
        }

        this.isLoadingMore = true;
        try {
            // Calculate offset: we want messages older than what we have
            // Using sort=desc, offset = current message count fetches the next batch
            const offset = this.messages.length;
            const url = `${CONFIG.API_BASE}/api/sessions/${this.storeId}/logs/messages?sort=desc&offset=${offset}&limit=${limit}`;

            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const data = await response.json();
            this.totalMessageCount = data.total;
            this.hasMoreMessages = data.has_more;

            if (!data.messages || data.messages.length === 0) {
                this.hasMoreMessages = false;
                return { loaded: 0, error: null };
            }

            // Transform server messages to client format
            const olderMessages = app.transformServerMessages(data.messages, this.storeId);

            // Reverse so oldest is first (for prepending in correct order)
            olderMessages.reverse();

            // Prepend to message array
            this.messages.unshift(...olderMessages);

            // Ensure messages are sorted (handles edge cases with concurrent sync)
            this.sortMessagesByTimestamp();
            this.deduplicateMessages();

            debug.log(`[LazyLoad] ${this.name}: Loaded ${olderMessages.length} older messages (total: ${this.messages.length}/${this.totalMessageCount})`);

            return { loaded: olderMessages.length, error: null };
        } catch (error) {
            console.error(`[LazyLoad] ${this.name}: Failed -`, error);
            return { loaded: 0, error: error.message };
        } finally {
            this.isLoadingMore = false;
        }
    },

    /**
     * Load prompt history from server (user messages for up/down navigation)
     * Called on session connect/reconnect to restore history across page refreshes
     */
    async loadPromptHistory() {
        if (!this.storeId || this.promptHistoryLoaded) {
            return;
        }

        try {
            // Fetch user messages only, most recent first, limit to 50
            const url = `${CONFIG.API_BASE}/api/sessions/${this.storeId}/logs/messages?role=user&sort=desc&limit=50`;
            const response = await fetch(url);

            if (response.status === 404) {
                // Session store gone server-side — nothing to load
                debug.log(`[PromptHistory] ${this.name}: No server-side store (404)`);
                this.promptHistoryLoaded = true;
                return;
            }
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const data = await response.json();
            if (data.messages && data.messages.length > 0) {
                // Extract just the content strings (most recent first)
                this.promptHistory = data.messages
                    .map(msg => msg.content)
                    .filter(content => content && typeof content === 'string' && content.trim());

                debug.log(`[PromptHistory] ${this.name}: Loaded ${this.promptHistory.length} prompts from server`);
            }

            this.promptHistoryLoaded = true;
        } catch (error) {
            console.error(`[PromptHistory] ${this.name}: Failed to load -`, error);
            // Don't block on error - just use empty history
            this.promptHistoryLoaded = true;
        }
    },
};
