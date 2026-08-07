/**
 * Session message-store mixin — pure read/dedup operations on
 * `this.messages`. Includes the dedup signature, the sync matcher
 * (findMatchingMessage / hasMessage), the "server is more complete than
 * local" comparator, sort + dedupe, and the lastSyncTimestamp tracker.
 *
 * No side effects beyond mutating `this.messages` / `this.lastSyncTimestamp`
 * — no DOM, no WebSocket, no app-bus. Applied to Session.prototype via
 * Object.assign in session.js.
 */

export const messageStoreMethods = {
    // Update the last sync timestamp (called when messages are received)
    updateSyncTimestamp(timestamp) {
        if (timestamp && (!this.lastSyncTimestamp || timestamp > this.lastSyncTimestamp)) {
            this.lastSyncTimestamp = timestamp;
        }
    },

    // Generate a signature for message deduplication
    // For user messages, strips "[X images/files attached]" suffix to normalize old/new formats
    messageSignature(msg) {
        if (msg.role === 'user') {
            let content = msg.content || '';
            // Strip old-format attachment suffix for consistent comparison
            // Pattern: \n[optional files, ]N image(s) attached]
            content = content.replace(/\n\[(\d+ files?, )?(\d+) images? attached\]$/, '');
            return content.substring(0, 100);
        }
        if (msg.role === 'assistant') return msg.content?.substring(0, 100) || '';
        if (msg.role === 'tool') return msg.toolId || msg.tool_id || '';
        if (msg.role === 'thinking') return msg.content?.substring(0, 100) || '';
        // Info/error rows (compact boundaries, server notices): content-based,
        // so live-rendered and synced copies can fuzzy-match when one side
        // lacks a server id. Without this they signature to '' and only ever
        // matched on exact timestamp — which client vs server clocks never share.
        if (msg.role === 'info' || msg.role === 'error') return msg.content?.substring(0, 100) || '';
        if (msg.role === 'result') return String(msg.cost_usd || msg.costUsd || 0);
        // Context messages: use turnNumber + contextTokens as signature
        // (timestamps differ between client/server due to async context fetch)
        if (msg.role === 'context') return `T${msg.turnNumber || 0}:${msg.contextTokens || 0}`;
        return '';
    },

    // Find existing message that matches (for sync updates)
    // For user/assistant: match by content + time window (30s)
    // For context: match by turnNumber (same tokens = same bar, regardless of timestamp)
    // For other types: match by exact timestamp + signature
    findMatchingMessage(msg) {
        // Server identity fast-path: `sid` is the stable server-side id
        // (explicit stored id, or "{session}:{line}" derived by api_logs /
        // carried by user_message_stored as promptId). Two messages with the
        // same sid ARE the same message; two with different sids are NEVER
        // the same, no matter how identical the content — this is what lets
        // two literal "/compact" prompts 21s apart both exist.
        if (msg.sid != null) {
            const bySid = this.messages.find(m => m.sid === msg.sid);
            if (bySid) return bySid;
        }

        const sig = this.messageSignature(msg);
        const msgTime = msg.timestamp ? new Date(msg.timestamp).getTime() : 0;

        return this.messages.find(existing => {
            // Distinct server identities can't be the same message — don't let
            // content+time heuristics merge them.
            if (msg.sid != null && existing.sid != null && existing.sid !== msg.sid) {
                return false;
            }
            if (existing.role !== msg.role) {
                // Cross-role matching: server stores as 'tool' but client stores as custom roles
                if (msg.role === 'tool') {
                    const tn = msg.toolName || msg.tool_name;
                    if (tn === 'AskUserQuestion' && existing.role === 'question') {
                        return existing.toolId === (msg.toolId || msg.tool_id);
                    }
                    if (tn === 'ExitPlanMode' && existing.role === 'plan_approval') {
                        return existing.toolId === (msg.toolId || msg.tool_id);
                    }
                }
                return false;
            }

            // For user/assistant messages, use time window matching
            if (msg.role === 'user' || msg.role === 'assistant') {
                if (this.messageSignature(existing) !== sig) return false;
                const existingTime = existing.timestamp ? new Date(existing.timestamp).getTime() : 0;
                return Math.abs(msgTime - existingTime) < 30000;  // 30 second window
            }

            // Context messages: match by turnNumber within time window.
            // Client uses client-time, server uses server-time (2-5s apart due to async context fetch).
            // Also match partial (from turn_summary) against full (from server/context_update).
            if (msg.role === 'context') {
                const sameTurn = existing.turnNumber && msg.turnNumber && existing.turnNumber === msg.turnNumber;
                if (!sameTurn) return false;
                const existingTime = existing.timestamp ? new Date(existing.timestamp).getTime() : 0;
                return Math.abs(msgTime - existingTime) < 15000;  // 15 second window for context
            }

            // For tool/result/thinking, use exact timestamp + signature
            if (this.messageSignature(existing) !== sig) return false;
            return existing.timestamp === msg.timestamp;
        });
    },

    // Check if a message already exists in this session
    hasMessage(msg) {
        return !!this.findMatchingMessage(msg);
    },

    // Check if server message has more complete data than local
    // (e.g., thinking tools with outputs vs empty outputs)
    isMoreComplete(serverMsg, localMsg) {
        // Local message was truncated for localStorage — server has the full content.
        // Set in toJSON() when any field exceeds its storage limit.
        if (localMsg._truncated) return true;
        // For thinking messages, check if server has tool outputs that local lacks
        if (serverMsg.role === 'thinking') {
            const serverTools = serverMsg.tools || [];
            const localTools = localMsg.tools || [];
            // Server has tools with outputs, local has empty outputs
            for (let i = 0; i < serverTools.length && i < localTools.length; i++) {
                if (serverTools[i].toolOutput && !localTools[i].toolOutput) {
                    return true;
                }
            }
            // Server has more tools
            if (serverTools.length > localTools.length) {
                return true;
            }
        }
        // For tool messages, check if server has output that local lacks
        if (serverMsg.role === 'tool') {
            if (serverMsg.toolOutput && !localMsg.toolOutput) {
                return true;
            }
        }
        // Context messages: server version with contextTokens is more complete than
        // partial (from turn_summary, no contextTokens)
        if (serverMsg.role === 'context') {
            if (serverMsg.contextTokens && (!localMsg.contextTokens || localMsg._partial)) {
                return true;
            }
        }
        return false;
    },

    // Sort messages by timestamp to maintain chronological order
    sortMessagesByTimestamp() {
        this.messages.sort((a, b) => {
            const ta = a.timestamp || '';
            const tb = b.timestamp || '';
            return ta.localeCompare(tb);
        });
    },

    // Deduplicate messages (keep first occurrence based on signature)
    // For user/assistant: dedupe by content + time window (same message within 30s = duplicate)
    // For tool/result/thinking: use role + timestamp + signature for precision
    deduplicateMessages() {
        // Pre-pass 0: self-heal partial flags. A sync merge (Object.assign with a
        // server message) can land full context data on a message without
        // clearing _partial — the server never stores that key. Full data wins.
        for (const msg of this.messages) {
            if (msg.role === 'context' && msg._partial && msg.contextTokens) {
                msg._partial = undefined;
            }
        }

        // Pre-pass: remove partial context messages if a full version exists for same turn
        // (partial from turn_summary, full from context_update or server sync).
        // Partial-vs-full ignores the time window: a partial with a full sibling is
        // stale at any distance (its context_update only ever comes once, right after
        // the turn — a delayed /context probe or buffered iPad WS delivery can exceed
        // any fixed window, and a cross-epoch leftover partial can never load either).
        // Full-vs-full keeps the 15s window (turn numbers restart after compaction,
        // so distant same-number full bars are legitimately different turns).
        const removeIndices = new Set();
        for (let i = 0; i < this.messages.length; i++) {
            const msg = this.messages[i];
            if (msg.role !== 'context' || !msg.turnNumber || removeIndices.has(i)) continue;
            const msgTime = msg.timestamp ? new Date(msg.timestamp).getTime() : 0;
            const hasFull = !!msg.contextTokens && !msg._partial;
            // Look ahead for duplicates of same turnNumber
            for (let j = i + 1; j < this.messages.length; j++) {
                const other = this.messages[j];
                if (other.role !== 'context' || other.turnNumber !== msg.turnNumber || removeIndices.has(j)) continue;
                const otherFull = !!other.contextTokens && !other._partial;
                if (hasFull && otherFull) {
                    const otherTime = other.timestamp ? new Date(other.timestamp).getTime() : 0;
                    if (Math.abs(otherTime - msgTime) > 15000) continue;  // Different epoch
                    removeIndices.add(j);  // Duplicate full — keep first
                } else if (otherFull && !hasFull) {
                    removeIndices.add(i);  // Remove partial (this), keep later full (other)
                    break;  // i is gone; stop scanning against it
                } else {
                    // other is a partial that sorts AFTER msg. If msg is a full for
                    // the same turn within the window, other is a leftover duplicate.
                    // A distant later partial may be a fresh pending bar from a new
                    // epoch (turn numbers restart) — leave it to its own upgrade.
                    const otherTime = other.timestamp ? new Date(other.timestamp).getTime() : 0;
                    if (Math.abs(otherTime - msgTime) <= 15000) {
                        removeIndices.add(j);  // Remove duplicate/leftover partial (other)
                    }
                }
            }
        }
        if (removeIndices.size > 0) {
            this.messages = this.messages.filter((_, i) => !removeIndices.has(i));
        }

        const seen = new Set();
        // Track content-based messages: "role:contentKey" -> earliest timestamp
        const seenByContent = new Map();

        this.messages = this.messages.filter(msg => {
            // Server identity first: same sid = duplicate, different sid = distinct.
            // Bypasses every content/time heuristic below — identical prompts sent
            // seconds apart stay, live+synced copies of one row collapse.
            if (msg.sid != null) {
                const sidKey = `sid:${msg.sid}`;
                if (seen.has(sidKey)) return false;
                seen.add(sidKey);
                // Still register the content signature so a no-sid localStorage
                // straggler of this same message (pre-upgrade copy) collapses
                // onto us in the content pass below. Registration only — sid
                // copies are never REJECTED by content, so identical prompts
                // with distinct sids all survive.
                if (msg.role === 'user' || msg.role === 'assistant') {
                    const contentKey = `${msg.role}:${this.messageSignature(msg)}`;
                    const msgTime = msg.timestamp ? new Date(msg.timestamp).getTime() : 0;
                    const existing = seenByContent.get(contentKey);
                    if (existing === undefined || msgTime < existing) {
                        seenByContent.set(contentKey, msgTime);
                    }
                }
                return true;
            }

            // For user/assistant messages, dedupe by content within a time window
            // This catches duplicates from localStorage vs server with slightly different timestamps
            if (msg.role === 'user' || msg.role === 'assistant') {
                const contentKey = `${msg.role}:${this.messageSignature(msg)}`;
                const msgTime = msg.timestamp ? new Date(msg.timestamp).getTime() : 0;

                if (seenByContent.has(contentKey)) {
                    const existingTime = seenByContent.get(contentKey);
                    // If same content within 30 seconds, treat as duplicate
                    if (Math.abs(msgTime - existingTime) < 30000) {
                        return false;
                    }
                }
                // Track this message (keep earliest timestamp for comparison)
                const existing = seenByContent.get(contentKey);
                if (!existing || msgTime < existing) {
                    seenByContent.set(contentKey, msgTime);
                }
                return true;
            }

            // For tool/result/thinking messages, use full key with timestamp
            const key = `${msg.role}:${msg.timestamp}:${this.messageSignature(msg)}`;
            if (seen.has(key)) {
                return false;
            }
            seen.add(key);
            return true;
        });
    },
};
