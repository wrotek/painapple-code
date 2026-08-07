/**
 * Session message-write mixin — methods that append/update entries on
 * `this.messages` and notify the renderer + persistence. Includes the user-
 * visible adders (addMessage, addSystemLog, addToolUse, addToolResult,
 * addThinkingMessage, addToolToThinkingMessage, updateThinkingToolResult)
 * plus the late-arrival promptId update for stored user messages.
 *
 * All methods use `this` (Session instance state) and are applied to
 * Session.prototype via Object.assign in session.js.
 */

import { genId } from '../utils.js';

const getApp = () => window.app;

export const messageWriteMethods = {
    addMessage(msg) {
        const app = getApp();
        // For user messages: always use client timestamp (will closely match server's utcnow())
        // For context messages: use current time (context_update arrives seconds after
        //   _currentServerTimestamp was set, so using it would create stale timestamps
        //   that mismatch with server-stored context messages during sync)
        // For other messages (assistant, tool, thinking): use server timestamp if available
        const timestamp = (msg.role === 'user' || msg.role === 'context')
            ? new Date().toISOString()
            : (this._currentServerTimestamp || new Date().toISOString());
        const stored = {
            ...msg,
            id: genId(),
            timestamp: timestamp,
            turnId: this.turnId
        };
        this.messages.push(stored);
        this.lastActivity = timestamp;
        if (msg.role === 'user') {
            this.totalUserPromptCount = (this.totalUserPromptCount || 0) + 1;
        }
        this.updateSyncTimestamp(timestamp);  // Track for background sync

        if (app.activeSession === this) {
            // Render immediately (if page is hidden, iOS may throttle this,
            // but visibilitychange handler will re-render when app returns)
            app.renderMessage(this.messages[this.messages.length - 1]);
        } else {
            // Session is not active - invalidate cached container so it re-renders on next switch
            const sessionId = this.id || this.storeId || this.sessionId;
            app.chatCtrl?.invalidateSession(sessionId);
        }

        // Persist to localStorage
        app.sessionManager.saveSessions();

        // Return the stored message (with id + timestamp) so callers can
        // reference it — e.g. stash mark-sent records the message it rode with
        return stored;
    },

    /**
     * Update the last user message with promptId from server
     * Called when server responds with user_message_stored event
     * @param {string} promptId - The prompt ID (sessionId:lineNumber)
     * @param {boolean} isFavorite - Whether the prompt is favorited
     * @param {Object} [verifiedFiles] - Map of {filename: resolvedPath} for linkification
     */
    _updateLastUserMessageWithPromptId(promptId, isFavorite = false, verifiedFiles = null) {
        // Find the last user message that doesn't have a promptId
        for (let i = this.messages.length - 1; i >= 0; i--) {
            const msg = this.messages[i];
            if (msg.role === 'user' && !msg.promptId) {
                msg.promptId = promptId;
                // promptId ("{session}:{line}") doubles as the server identity
                // api_logs derives for id-less stored messages — adopting it as
                // sid makes the sender's local copy exactly matchable on sync.
                if (msg.sid == null) msg.sid = promptId;
                msg.isFavorite = isFavorite;
                const app = getApp();
                if (app?.chatCtrl) {
                    app.chatCtrl.updateMessageFavoriteState(msg.id, promptId, isFavorite);
                    // Re-render message content if verifiedFiles arrived for linkification
                    if (verifiedFiles && Object.keys(verifiedFiles).length > 0) {
                        msg.verifiedFiles = verifiedFiles;
                        app.chatCtrl.updateMessageContent(msg);
                    }
                }
                app?.sessionManager.saveSessions();
                break;
            }
        }
    },

    /**
     * Add a system log entry (connection status, lifecycle events, errors)
     * These are stored per-session and displayed in log explorer's System tab
     */
    addSystemLog(text, type = 'info') {
        const entry = {
            id: genId(),
            timestamp: new Date().toISOString(),
            text,
            type  // 'info', 'error', 'warning', 'success'
        };
        this.systemLogs.push(entry);
        // Keep last 100 entries to prevent memory bloat
        if (this.systemLogs.length > 100) {
            this.systemLogs.shift();
        }
        // Notify log explorer if open
        const app = getApp();
        if (app) {
            app.onSystemLogAdded?.(this, entry);
        }
    },

    addToolUse(block, parentTaskId = null) {
        this.addMessage({
            role: 'tool',
            toolType: 'use',
            toolName: block.name,
            toolId: block.id,
            toolInput: block.input,
            parentTaskId  // For sub-agent tool nesting (links child tools to parent Task)
        });
    },

    addToolResult(result) {
        const app = getApp();

        // Match by tool_use_id if available, otherwise fall back to last tool
        let toolMsg;
        if (result.tool_use_id) {
            toolMsg = [...this.messages].reverse().find(
                m => m.role === 'tool' && m.toolType === 'use' && m.toolId === result.tool_use_id
            );
        }
        if (!toolMsg) {
            // Fallback: find last tool that doesn't have output yet
            toolMsg = [...this.messages].reverse().find(
                m => m.role === 'tool' && m.toolType === 'use' && !m.toolCompleted
            );
        }

        if (toolMsg) {
            toolMsg.toolOutput = result.stdout || result.content || '';
            // Stringify object/array content (e.g. ToolSearch returns objects)
            if (typeof toolMsg.toolOutput === 'object' && toolMsg.toolOutput !== null) {
                toolMsg.toolOutput = Array.isArray(toolMsg.toolOutput)
                    ? toolMsg.toolOutput.map(b => (typeof b === 'object' && b.text) ? b.text : JSON.stringify(b)).join('\n')
                    : JSON.stringify(toolMsg.toolOutput, null, 2);
            }
            toolMsg.toolError = result.stderr || '';
            toolMsg.toolCompleted = true;
            toolMsg.verifiedFiles = result.verifiedFiles || null;  // Backwards compat
            toolMsg.fileLinks = result.fileLinks || null;  // Server-provided positions
            toolMsg.startLine = result.startLine || null;  // Server-parsed line number for Edit tools
            if (app.activeSession === this) {
                app.updateToolResult(toolMsg);
            }
            // Persist updated tool result
            app.sessionManager.saveSessions();

            // Agent completion tracking (toast + cleanup)
            if (toolMsg.toolId && this._agentProgress.has(toolMsg.toolId)) {
                this._onAgentCompleted(toolMsg.toolId, toolMsg.toolInput?.description || '');
            }
        }
    },

    // Add a thinking message (collapsible in chat, persists across reload)
    addThinkingMessage(thinkingContent) {
        const app = getApp();
        // Use server timestamp if available (from handleAgentMessage), else generate client timestamp
        const timestamp = this._currentServerTimestamp || new Date().toISOString();
        const msg = {
            role: 'thinking',
            content: thinkingContent,
            tools: [],  // Tools used during this thinking block
            id: genId(),
            timestamp: timestamp,
            turnId: this.turnId
        };
        this.messages.push(msg);
        this.lastActivity = timestamp;
        this.updateSyncTimestamp(timestamp);  // Track for background sync

        if (app.activeSession === this) {
            app.renderMessage(msg);
        }

        app.sessionManager.saveSessions();
        return msg;
    },

    // Add a tool to the current thinking message
    addToolToThinkingMessage(block, parentTaskId = null) {
        const app = getApp();
        const thinkingMsg = this.messages.find(m => m.id === this.currentThinkingMsgId);

        if (thinkingMsg) {
            // Check for duplicate toolId (prevents double-adding same tool)
            if (thinkingMsg.tools.some(t => t.toolId === block.id)) {
                return; // Already have this tool
            }

            thinkingMsg.tools.push({
                toolName: block.name,
                toolId: block.id,
                toolInput: block.input,
                toolOutput: null,
                toolCompleted: false,
                parentTaskId  // Server-provided parent Task ID for nesting
            });

            // Update the rendered message if visible
            if (app.activeSession === this) {
                app.updateThinkingMessageTool(thinkingMsg, block, parentTaskId);
            }

            app.sessionManager.saveSessions();
        }
    },

    // Update a tool result inside a thinking message
    updateThinkingToolResult(toolId, content, verifiedFiles = null, fileLinks = null, childToolIds = null, startLine = null) {
        const app = getApp();

        // Find the thinking message containing this tool
        for (const msg of this.messages) {
            if (msg.role === 'thinking' && msg.tools) {
                const tool = msg.tools.find(t => t.toolId === toolId);
                if (tool) {
                    tool.toolOutput = content;
                    tool.toolCompleted = true;
                    tool.verifiedFiles = verifiedFiles;  // Backwards compat
                    tool.fileLinks = fileLinks;  // Server-provided positions
                    if (startLine) {
                        tool.startLine = startLine;  // Server-parsed line number for Edit tools
                    }
                    if (childToolIds) {
                        tool.childToolIds = childToolIds;  // For Task sub-agent grouping
                    }

                    if (app.activeSession === this) {
                        app.updateThinkingMessageToolResult(msg, toolId, content, childToolIds);
                    }

                    app.sessionManager.saveSessions();

                    return;
                }
            }
        }
    },
};
