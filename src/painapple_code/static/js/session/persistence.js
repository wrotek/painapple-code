/**
 * Session persistence mixin — serialize the session for localStorage.
 * Trims to the last N messages (default 30) and truncates oversized
 * tool/thinking/assistant content with a `_truncated: true` marker so
 * `isMoreComplete` can later pull the full version back from the server.
 *
 * Pure-ish — only reads `this.*`, no side effects. Applied to
 * Session.prototype via Object.assign in session.js.
 */

export const persistenceMethods = {
    /**
     * Serialize session for localStorage
     * @param {number} messageLimit - Max messages to store (default 30, reduced on quota pressure)
     */
    toJSON(messageLimit = 30) {
        // Truncate large outputs to avoid localStorage overflow.
        // Messages truncated here get `_truncated: true` so syncMessages() can detect
        // them via isMoreComplete() and pull the full version back from the server.
        const TOOL_OUTPUT_LIMIT = 8000;
        const TOOL_INPUT_LIMIT = 8000;
        const THINKING_CONTENT_LIMIT = 8000;
        const ASSISTANT_CONTENT_LIMIT = 15000;
        const USER_CONTENT_LIMIT = 15000;

        const truncateOutput = (str, maxLen = TOOL_OUTPUT_LIMIT) => {
            if (!str || str.length <= maxLen) return str;
            return str.slice(0, maxLen) + '\n...(truncated for storage)';
        };

        // Truncate oversized string fields inside a toolInput object
        // (Write file content, Edit old/new_string, …). Returns
        // [input, wasTruncated]; input is untouched when nothing exceeds.
        const truncateToolInput = (input) => {
            if (!input || typeof input !== 'object') return [input, false];
            let truncated = false;
            const out = { ...input };
            for (const [key, val] of Object.entries(out)) {
                if (typeof val === 'string' && val.length > TOOL_INPUT_LIMIT) {
                    out[key] = truncateOutput(val, TOOL_INPUT_LIMIT);
                    truncated = true;
                }
            }
            return [truncated ? out : input, truncated];
        };

        // Store only the last N messages - full history loads from server on scroll
        const storedMessages = this.messages.slice(-messageLimit).map(msg => {
            if (msg.role === 'tool') {
                const [toolInput, inputTruncated] = truncateToolInput(msg.toolInput);
                const wasTruncated = inputTruncated ||
                                     (msg.toolOutput && msg.toolOutput.length > TOOL_OUTPUT_LIMIT) ||
                                     (msg.toolError && msg.toolError.length > TOOL_OUTPUT_LIMIT);
                return {
                    ...msg,
                    toolInput,
                    toolOutput: truncateOutput(msg.toolOutput),
                    toolError: truncateOutput(msg.toolError),
                    ...(wasTruncated ? { _truncated: true } : {})
                };
            }
            if (msg.role === 'thinking') {
                // Truncate thinking content and nested tool inputs/outputs
                const contentTruncated = msg.content && msg.content.length > THINKING_CONTENT_LIMIT;
                let anyToolTruncated = false;
                const tools = (msg.tools || []).map(tool => {
                    const [toolInput, inputTruncated] = truncateToolInput(tool.toolInput);
                    if (inputTruncated ||
                        (tool.toolOutput && tool.toolOutput.length > TOOL_OUTPUT_LIMIT)) {
                        anyToolTruncated = true;
                    }
                    return {
                        ...tool,
                        toolInput,
                        toolOutput: truncateOutput(tool.toolOutput)
                    };
                });
                const wasTruncated = contentTruncated || anyToolTruncated;
                return {
                    ...msg,
                    content: truncateOutput(msg.content, THINKING_CONTENT_LIMIT),
                    tools,
                    ...(wasTruncated ? { _truncated: true } : {})
                };
            }
            if (msg.role === 'assistant' && msg.content?.length > ASSISTANT_CONTENT_LIMIT) {
                return {
                    ...msg,
                    content: msg.content.slice(0, ASSISTANT_CONTENT_LIMIT) + '\n...(truncated for storage)',
                    _truncated: true
                };
            }
            if (msg.role === 'user') {
                // Never persist raw base64 image payloads. `images` carries the
                // full upload objects (preview data-URL + API image block) and is
                // never read after send; data-URI `imageThumbnails` are the
                // full-size image re-encoded, not thumbnails. A couple of
                // screenshots in the 30-message window blows the ~5MB quota on
                // their own. The server owns the originals — sync restores
                // lightweight /uploads/ URL thumbnails via _truncated +
                // isMoreComplete().
                const dataUriThumbs = (msg.imageThumbnails || [])
                    .some(src => typeof src === 'string' && src.startsWith('data:'));
                const contentTruncated = msg.content && msg.content.length > USER_CONTENT_LIMIT;
                if (!msg.images && !dataUriThumbs && !contentTruncated) return msg;

                const slim = { ...msg };
                delete slim.images;
                if (dataUriThumbs) {
                    const urlThumbs = msg.imageThumbnails
                        .filter(src => typeof src === 'string' && !src.startsWith('data:'));
                    slim.imageThumbnails = urlThumbs.length > 0 ? urlThumbs : undefined;
                }
                if (contentTruncated) {
                    slim.content = truncateOutput(msg.content, USER_CONTENT_LIMIT);
                }
                slim._truncated = true;
                return slim;
            }
            return msg;
        });

        return {
            id: this.id,
            name: this.name,
            cwd: this.cwd,
            createdAt: this.createdAt,
            lastActivity: this.lastActivity,
            totalCost: this.totalCost,
            wasConnected: this.wasConnected,
            model: this.model,
            providerSessionId: this.providerSessionId,  // For resuming Claude conversations
            storeId: this.storeId,  // Server-side session ID for URL sharing
            slashCommands: this.slashCommands,  // Claude slash commands for autocomplete
            // Token usage tracking
            contextTokens: this.contextTokens,
            contextWindow: this.contextWindow,
            contextBreakdown: this.contextBreakdown,
            contextMemoryFiles: this.contextMemoryFiles,
            contextUpdatedAt: this.contextUpdatedAt,
            totalInputTokens: this.totalInputTokens,
            totalOutputTokens: this.totalOutputTokens,
            // Sync state
            lastSyncTimestamp: this.lastSyncTimestamp,
            // Permission mode (plan, default, etc.)
            permissionMode: this.permissionMode || undefined,
            // Provider identity (server-authoritative; re-confirmed on reconnect)
            provider: this.provider || undefined,
            providerDisplayName: this.providerDisplayName || undefined,
            providerCaps: this.providerCaps || undefined,
            providerLocked: this.providerLocked || undefined,
            // Picker choice not yet bound (tab saved before first connect)
            pendingProvider: this.pendingProvider || undefined,
            // Per-session pref caches — restored so the first paint after a
            // reload shows this session's model/permission/effort/account
            // without waiting for the managers' confirm fetches.
            preferredModel: this.preferredModel || undefined,
            permissionLevel: this.permissionLevel || undefined,
            effortLevel: this.effortLevel || undefined,
            tokenProfileName: this.tokenProfileName || undefined,
            // Lazy loading state
            hasMoreMessages: this.hasMoreMessages,
            totalMessageCount: this.totalMessageCount,
            totalUserPromptCount: this.totalUserPromptCount,
            messages: storedMessages,
            // Pending upload metadata (lightweight references for restore after refresh)
            pendingUploadImages: this.pendingImages.some(img => img.storedName)
                ? this.pendingImages
                    .filter(img => img.storedName)
                    .map(img => ({ storedName: img.storedName, mediaType: img.mediaType }))
                : undefined,
            pendingUploadFiles: this.pendingFiles.length > 0
                ? this.pendingFiles.map(f => ({
                    name: f.name, path: f.path, size: f.size, originalName: f.originalName,
                }))
                : undefined,
        };
    },
};
