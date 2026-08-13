/**
 * Stash Module - Universal context collector
 *
 * Collects code references from various sources (file preview, chat messages, etc.)
 * and attaches them as context to chat prompts.
 *
 * Per-session storage on server, syncs across devices.
 */

import { CONFIG } from './config.js';
import { genId } from './utils.js';

// ═══════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════

const state = {
    sessionId: null,
    items: [],          // Array of stash items
    loading: false,
    error: null,
    paused: false       // When true, items won't be attached to prompts
};

// Track paused state per session (persists across session switches)
const pausedBySession = new Map();

// Sent-history cap (mirrors SessionStore.STASH_HISTORY_LIMIT server-side)
const HISTORY_LIMIT = 50;

// Event listeners for UI updates
const listeners = new Set();

// ═══════════════════════════════════════════════════════════════════════════
// DATA MODEL
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Create a new stash item
 * @param {Object} anchor - Selection anchor data
 * @returns {Object} Stash item
 */
function createItem(anchor) {
    return {
        id: genId(),
        type: anchor.type || 'message',  // 'file' | 'message' | 'image'

        // File reference (image items reuse filePath for the upload name)
        filePath: anchor.filePath || null,
        startLine: anchor.startLine || null,
        endLine: anchor.endLine || null,

        // Message reference
        messageId: anchor.messageId || null,
        messageIndex: anchor.messageIndex || null,

        // Image marker reference — numbered badge drawn by the annotate editor
        markerIndex: anchor.markerIndex || null,

        // Table-row reference — column headers + cells, so the prompt can show
        // the row with its header context instead of a bare " | "-joined string
        tableHeaders: anchor.tableHeaders || null,
        tableRows: anchor.tableRows ||
                   (anchor.tableCells ? [anchor.tableCells] : null),

        // Content
        selectedText: anchor.selectedText || '',
        note: '',           // Optional user annotation
        enabled: true,      // Include in prompt by default

        // Multi-select info
        multiSelect: anchor.multiSelect || false,
        selectionCount: anchor.selectionCount || 1,

        // Metadata
        addedAt: new Date().toISOString()
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// API
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Load stash for a session from server
 */
async function load(sessionId) {
    if (!sessionId) return;

    state.sessionId = sessionId;
    state.loading = true;
    // Restore paused state for this session (default to false if not set)
    state.paused = pausedBySession.get(sessionId) || false;
    notify();

    try {
        const response = await fetch(`${CONFIG.API_BASE}/api/session/${sessionId}/stash`);
        if (!response.ok) {
            if (response.status === 404) {
                // No stash yet, that's fine
                state.items = [];
            } else {
                throw new Error(`Failed to load stash: ${response.status}`);
            }
        } else {
            const data = await response.json();
            state.items = data.items || [];
        }
        state.error = null;
    } catch (err) {
        console.error('[Stash] Load error:', err);
        state.error = err.message;
        state.items = [];
    } finally {
        state.loading = false;
        notify();
    }
}

/**
 * Add item to stash
 * @param {Object} anchor - Selection anchor data
 * @param {string} [note] - Optional user annotation
 * @returns {Object} Created item
 */
async function add(anchor, note = '') {
    const item = createItem(anchor);
    if (note) {
        item.note = note;
    }

    // Add locally immediately for responsive UI
    state.items.unshift(item);
    notify();

    // Sync to server
    if (state.sessionId) {
        try {
            const response = await fetch(`${CONFIG.API_BASE}/api/session/${state.sessionId}/stash`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(item)
            });

            if (!response.ok) {
                console.error('[Stash] Failed to sync add:', response.status);
            }
        } catch (err) {
            console.error('[Stash] Sync error:', err);
        }
    }

    return item;
}

/**
 * Remove item from stash
 * @param {string} itemId - Item ID to remove
 */
async function remove(itemId) {
    const index = state.items.findIndex(i => i.id === itemId);
    if (index === -1) return;

    // Remove locally
    state.items.splice(index, 1);
    notify();

    // Sync to server
    if (state.sessionId) {
        try {
            await fetch(`${CONFIG.API_BASE}/api/session/${state.sessionId}/stash/${itemId}`, {
                method: 'DELETE'
            });
        } catch (err) {
            console.error('[Stash] Delete sync error:', err);
        }
    }
}

/**
 * Toggle item enabled state
 * @param {string} itemId - Item ID
 */
async function toggle(itemId) {
    const item = state.items.find(i => i.id === itemId);
    if (!item) return;

    item.enabled = !item.enabled;
    notify();

    // Sync to server
    if (state.sessionId) {
        try {
            await fetch(`${CONFIG.API_BASE}/api/session/${state.sessionId}/stash/${itemId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: item.enabled })
            });
        } catch (err) {
            console.error('[Stash] Toggle sync error:', err);
        }
    }
}

/**
 * Update item note
 * @param {string} itemId - Item ID
 * @param {string} note - New note text
 */
async function updateNote(itemId, note) {
    const item = state.items.find(i => i.id === itemId);
    if (!item) return;

    item.note = note;
    notify();

    // Sync to server
    if (state.sessionId) {
        try {
            await fetch(`${CONFIG.API_BASE}/api/session/${state.sessionId}/stash/${itemId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ note })
            });
        } catch (err) {
            console.error('[Stash] Note sync error:', err);
        }
    }
}

/**
 * Clear all pending items from stash (sent history is kept)
 */
async function clear() {
    state.items = state.items.filter(i => i.status === 'sent');
    notify();

    // Sync to server
    if (state.sessionId) {
        try {
            await fetch(`${CONFIG.API_BASE}/api/session/${state.sessionId}/stash?scope=pending`, {
                method: 'DELETE'
            });
        } catch (err) {
            console.error('[Stash] Clear sync error:', err);
        }
    }
}

/**
 * Clear sent history (pending items are kept)
 */
async function clearHistory() {
    state.items = state.items.filter(i => i.status !== 'sent');
    notify();

    if (state.sessionId) {
        try {
            await fetch(`${CONFIG.API_BASE}/api/session/${state.sessionId}/stash?scope=history`, {
                method: 'DELETE'
            });
        } catch (err) {
            console.error('[Stash] Clear history sync error:', err);
        }
    }
}

/**
 * Mark items as sent — they move to history instead of being deleted.
 * Called from the send path with the user message they were attached to.
 * @param {string[]} itemIds - Ids of the items that were attached
 * @param {Object} meta - { messageId, sentAt, sessionId }
 */
async function markSent(itemIds, meta = {}) {
    if (!itemIds || itemIds.length === 0) return;

    const ids = new Set(itemIds);
    const sentAt = meta.sentAt || new Date().toISOString();
    for (const item of state.items) {
        if (ids.has(item.id)) {
            item.status = 'sent';
            item.enabled = false;
            item.sentAt = sentAt;
            item.sentWithMessageId = meta.messageId || null;
            item.sentInSessionId = meta.sessionId || null;
        }
    }

    // Mirror the server-side history cap locally (oldest sentAt dropped)
    const sent = state.items.filter(i => i.status === 'sent');
    if (sent.length > HISTORY_LIMIT) {
        sent.sort((a, b) => (b.sentAt || '').localeCompare(a.sentAt || ''));
        const keep = new Set(sent.slice(0, HISTORY_LIMIT).map(i => i.id));
        state.items = state.items.filter(i => i.status !== 'sent' || keep.has(i.id));
    }
    notify();

    if (state.sessionId) {
        try {
            await fetch(`${CONFIG.API_BASE}/api/session/${state.sessionId}/stash/mark-sent`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    item_ids: itemIds,
                    message_id: meta.messageId || null,
                    sent_at: sentAt,
                    sent_session_id: meta.sessionId || null,
                }),
            });
        } catch (err) {
            console.error('[Stash] Mark-sent sync error:', err);
        }
    }
}

/**
 * Re-arm previously sent items so they ride along with the next message.
 *
 * Restores the ORIGINAL items by id rather than rebuilding them from a
 * message's stored `stashRefs`: those are display copies with `selectedText`
 * truncated to 300 chars, so reconstructing from them would silently attach a
 * clipped snippet. Items that have aged out of the sent-history cap (or belong
 * to another session) are reported back as missing instead of being faked —
 * the caller tells the user rather than quietly attaching less than they asked
 * for.
 *
 * Items already pending are re-enabled but not double-counted as restored.
 *
 * @param {string[]} itemIds
 * @returns {Promise<{restored: number, missing: number}>}
 */
async function reattach(itemIds) {
    if (!itemIds || itemIds.length === 0) return { restored: 0, missing: 0 };

    const wanted = new Set(itemIds);
    const touched = [];
    let restored = 0;
    for (const item of state.items) {
        if (!wanted.has(item.id)) continue;
        if (item.status === 'sent') restored++;
        item.status = null;
        item.enabled = true;
        item.sentAt = null;
        item.sentWithMessageId = null;
        item.sentInSessionId = null;
        touched.push(item.id);
    }

    const missing = itemIds.length - touched.length;
    if (touched.length === 0) return { restored: 0, missing };
    notify();

    if (state.sessionId) {
        const body = JSON.stringify({
            status: null,
            enabled: true,
            sentAt: null,
            sentWithMessageId: null,
            sentInSessionId: null,
        });
        await Promise.all(touched.map(id =>
            fetch(`${CONFIG.API_BASE}/api/session/${state.sessionId}/stash/${id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body,
            }).catch(err => console.error('[Stash] Re-attach sync error:', err))
        ));
    }

    return { restored, missing };
}

/**
 * Which of these ids are still in this session's stash AND would actually
 * change state if re-armed. An item already pending and enabled is a no-op, so
 * it is excluded — that is what lets the caller hide a "Re-attach" affordance
 * once there is nothing left for it to do.
 *
 * @param {string[]} itemIds
 * @returns {string[]}
 */
function restorableIds(itemIds) {
    if (!itemIds || itemIds.length === 0) return [];
    const byId = new Map(state.items.map(i => [i.id, i]));
    return itemIds.filter(id => {
        const item = byId.get(id);
        return item ? !(isPending(item) && item.enabled) : false;
    });
}

/**
 * Move all enabled items to another session's stash
 * @param {string} targetSessionId - Session ID to move items to
 * @returns {number} Number of items moved
 */
async function moveToSession(targetSessionId) {
    if (!targetSessionId || targetSessionId === state.sessionId) return 0;

    const enabled = getEnabled();
    if (enabled.length === 0) return 0;

    // POST each item to the target session
    let moved = 0;
    for (const item of enabled) {
        try {
            const response = await fetch(`${CONFIG.API_BASE}/api/session/${targetSessionId}/stash`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(item)
            });
            if (response.ok) moved++;
        } catch (err) {
            console.error('[Stash] Move error:', err);
        }
    }

    // Remove moved items from current session
    if (moved > 0) {
        const enabledIds = new Set(enabled.map(i => i.id));
        state.items = state.items.filter(i => !enabledIds.has(i.id));
        notify();

        // Sync removal to server
        if (state.sessionId) {
            try {
                // If all pending items moved, clear pending in one call
                // (scope=pending keeps sent history); otherwise delete individually
                if (getItems().length === 0) {
                    await fetch(`${CONFIG.API_BASE}/api/session/${state.sessionId}/stash?scope=pending`, {
                        method: 'DELETE'
                    });
                } else {
                    for (const id of enabledIds) {
                        await fetch(`${CONFIG.API_BASE}/api/session/${state.sessionId}/stash/${id}`, {
                            method: 'DELETE'
                        });
                    }
                }
            } catch (err) {
                console.error('[Stash] Cleanup error:', err);
            }
        }
    }

    return moved;
}

/**
 * Get current session ID
 * @returns {string|null}
 */
function getSessionId() {
    return state.sessionId;
}

/**
 * Reset stash state (on session change)
 */
function reset() {
    // Save paused state for this session before clearing
    if (state.sessionId) {
        pausedBySession.set(state.sessionId, state.paused);
    }
    state.sessionId = null;
    state.items = [];
    state.loading = false;
    state.error = null;
    state.paused = false;
    notify();
}

/**
 * Set paused state (items won't be attached to prompts when paused)
 * @param {boolean} paused - Whether to pause
 */
function setPaused(paused) {
    state.paused = paused;
    // Remember for this session
    if (state.sessionId) {
        pausedBySession.set(state.sessionId, paused);
    }
    notify();
}

/**
 * Check if stash is paused
 * @returns {boolean}
 */
function isPaused() {
    return state.paused;
}

// ═══════════════════════════════════════════════════════════════════════════
// GETTERS
// ═══════════════════════════════════════════════════════════════════════════

/** True for items still awaiting attachment (not yet sent) */
function isPending(item) {
    return item.status !== 'sent';
}

/**
 * Get pending stash items (sent history excluded — see getHistory)
 */
function getItems() {
    return state.items.filter(isPending);
}

/**
 * Get sent history items, newest first
 */
function getHistory() {
    return state.items
        .filter(i => i.status === 'sent')
        .sort((a, b) => (b.sentAt || '').localeCompare(a.sentAt || ''));
}

/**
 * Get enabled (pending) items only
 */
function getEnabled() {
    return state.items.filter(i => isPending(i) && i.enabled);
}

/**
 * Get count of pending items
 */
function getCount() {
    return getItems().length;
}

/**
 * Get count of sent history items
 */
function getHistoryCount() {
    return state.items.filter(i => i.status === 'sent').length;
}

/**
 * Get count of enabled items
 */
function getEnabledCount() {
    return getEnabled().length;
}

/**
 * Check if stash has any pending items
 */
function hasItems() {
    return state.items.some(isPending);
}

/**
 * Check if stash has enabled items
 */
function hasEnabled() {
    return getEnabled().length > 0;
}

// ═══════════════════════════════════════════════════════════════════════════
// PROMPT FORMATTING
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Format enabled stash items as context prefix for prompt
 * @returns {string} Formatted context block, or empty string if paused or no enabled items
 */
function formatForPrompt() {
    // Return empty if stash is paused
    if (state.paused) return '';

    const enabled = getEnabled();
    if (enabled.length === 0) return '';

    const blocks = enabled.map(item => formatItem(item));

    // Image-marker comments point at numbered badges drawn on an attached
    // screenshot, so the lead-in must say so instead of "code sections"
    const allMarkers = enabled.every(item => item.type === 'image');
    const intro = allMarkers
        ? "I'm referencing the numbered markers drawn on the attached screenshot:"
        : "I'm referencing these code sections:";

    return `${intro}

${blocks.join('\n\n')}

---

`;
}

/**
 * Rebuild a stashed table row (or rows) as a real markdown table so the model
 * sees which column each cell belongs to. Returns null when the item isn't a
 * table-row reference, in which case the caller falls back to raw text.
 */
function formatTableBody(item) {
    const headers = item.tableHeaders;
    const rows = item.tableRows;
    if (!Array.isArray(headers) || !headers.length) return null;
    if (!Array.isArray(rows) || !rows.length) return null;

    // Cells are plain text: escape pipes and flatten newlines so the
    // reconstructed table stays a valid single-line-per-row table.
    const cell = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').trim();
    const line = (cells) => `| ${cells.map(cell).join(' | ')} |`;

    const out = [line(headers), `| ${headers.map(() => '---').join(' | ')} |`];
    for (const row of rows) {
        if (!Array.isArray(row)) continue;
        // Pad/trim to the header width so the table can't come out ragged
        const padded = headers.map((_, i) => row[i] ?? '');
        out.push(line(padded));
    }
    return out.join('\n');
}

/**
 * Format a single stash item
 */
function formatItem(item) {
    const tableBody = formatTableBody(item);

    if (item.type === 'file') {
        const relativePath = item.filePath?.replace(/^\/home\/[^/]+\//, '~/') || 'file';

        // Format header with optional line range
        let header;
        if (item.startLine != null) {
            const lineRange = item.startLine === item.endLine
                ? `${item.startLine}`
                : `${item.startLine}-${item.endLine}`;
            header = `**${relativePath}:${lineRange}**`;
        } else {
            // No line numbers (e.g., rendered markdown)
            header = `**${relativePath}**`;
        }

        // Detect language for code block
        const ext = item.filePath?.split('.').pop() || '';
        const lang = getLanguage(ext);

        let block = header;
        if (item.note) {
            block += `\n_${item.note}_`;
        }
        block += `\n\`\`\`${tableBody ? 'markdown' : lang}\n${tableBody || item.selectedText}\n\`\`\``;

        return block;
    } else if (item.type === 'image') {
        // Numbered marker on an annotated screenshot — the badge is burned
        // into the image, the comment travels here as prompt text
        const name = item.filePath || 'attached image';
        const header = item.markerIndex != null
            ? `**Marker ${item.markerIndex} on ${name}:**`
            : `**${name}:**`;
        const body = item.note || item.selectedText || '';
        const quoted = body.split('\n').map(l => `> ${l}`).join('\n');
        return `${header}\n${quoted}`;
    } else {
        // Message reference — omit the index when unknown
        let block = item.messageIndex ? `**Message #${item.messageIndex}:**` : '**Message:**';
        if (item.note) {
            block += `\n_${item.note}_`;
        }
        // Table rows keep their header context; everything else is quoted text
        if (tableBody) {
            block += `\n\`\`\`markdown\n${tableBody}\n\`\`\``;
        } else {
            const quoted = item.selectedText.split('\n').map(l => `> ${l}`).join('\n');
            block += `\n${quoted}`;
        }

        return block;
    }
}

/**
 * Map file extension to language for code blocks
 */
function getLanguage(ext) {
    const map = {
        js: 'javascript',
        ts: 'typescript',
        jsx: 'jsx',
        tsx: 'tsx',
        py: 'python',
        rb: 'ruby',
        go: 'go',
        rs: 'rust',
        java: 'java',
        c: 'c',
        cpp: 'cpp',
        h: 'c',
        hpp: 'cpp',
        cs: 'csharp',
        php: 'php',
        swift: 'swift',
        kt: 'kotlin',
        scala: 'scala',
        sh: 'bash',
        bash: 'bash',
        zsh: 'bash',
        sql: 'sql',
        html: 'html',
        css: 'css',
        scss: 'scss',
        less: 'less',
        json: 'json',
        yaml: 'yaml',
        yml: 'yaml',
        xml: 'xml',
        md: 'markdown',
        dockerfile: 'dockerfile',
        makefile: 'makefile'
    };
    return map[ext.toLowerCase()] || '';
}

// ═══════════════════════════════════════════════════════════════════════════
// EVENT SYSTEM
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Subscribe to stash changes
 * @param {Function} callback - Called when stash changes
 * @returns {Function} Unsubscribe function
 */
function subscribe(callback) {
    listeners.add(callback);
    return () => listeners.delete(callback);
}

/**
 * Notify all listeners of state change
 */
function notify() {
    listeners.forEach(fn => {
        try {
            fn(state);
        } catch (err) {
            console.error('[Stash] Listener error:', err);
        }
    });
}

// ═══════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════

export const Stash = {
    // Actions
    load,
    add,
    remove,
    toggle,
    updateNote,
    clear,
    clearHistory,
    markSent,
    reattach,
    restorableIds,
    reset,
    setPaused,
    moveToSession,

    // Getters
    getItems,
    getHistory,
    getEnabled,
    getCount,
    getHistoryCount,
    getEnabledCount,
    hasItems,
    hasEnabled,
    isPaused,
    getSessionId,

    // Prompt integration
    formatForPrompt,

    // Events
    subscribe
};
