/**
 * Session Container Pool
 *
 * Manages per-session DOM containers for instant tab switching.
 * Each container is independently scrollable — the browser natively
 * preserves scrollTop on display:none elements, so no manual
 * save/restore is needed.
 *
 * Performance: O(1) tab switch instead of O(n) where n = message count
 */

import { debug } from './config.js';

const MAX_CACHED = 5;  // Maximum number of cached containers (LRU eviction)

/**
 * SessionContainerPool - Manages DOM containers for sessions
 */
export class SessionContainerPool {
    /**
     * @param {HTMLElement} parentEl - Parent element to append containers to
     * @param {Object} options
     * @param {Function} options.onBeforeEvict - Called before LRU eviction: (sessionId, scrollTop) => void
     */
    constructor(parentEl, options = {}) {
        this.parent = parentEl;
        this.containers = new Map();  // sessionId -> ContainerEntry
        this.activeId = null;
        this.onBeforeEvict = options.onBeforeEvict || null;

        // Debug mode
        this.debug = false;

        // Strip any non-pool children from the parent so acquire()'s insertBefore
        // doesn't stack session containers on top of stale DOM left by other paths.
        this._clearStaticContent();
    }

    /**
     * Remove any non-session-messages children from the parent. Defensive — the
     * normal flow never puts foreign content in #messages, but hot-reloads or
     * future regressions could.
     * @private
     */
    _clearStaticContent() {
        const toRemove = [];
        for (const child of this.parent.children) {
            if (!child.classList.contains('session-messages')) {
                toRemove.push(child);
            }
        }
        for (const el of toRemove) {
            el.remove();
            this._log('Removed static element:', el.id || el.className);
        }
    }

    /**
     * Get or create a container for a session
     * @param {string} sessionId - Session identifier
     * @returns {HTMLElement} The container element
     */
    acquire(sessionId) {
        let entry = this.containers.get(sessionId);

        if (!entry) {
            // Create new container
            const el = document.createElement('div');
            el.className = 'session-messages';
            el.id = `session-messages-${sessionId}`;
            el.dataset.sessionId = sessionId;
            el.style.display = 'none';

            // Insert at beginning of parent (before other children)
            if (this.parent.firstChild) {
                this.parent.insertBefore(el, this.parent.firstChild);
            } else {
                this.parent.appendChild(el);
            }

            entry = {
                el,
                sessionId,
                lastAccess: Date.now(),
                rendered: false,
                messageCount: 0
            };
            this.containers.set(sessionId, entry);

            this._log('Created container for', sessionId);

            // LRU eviction if needed
            this._evictIfNeeded();
        }

        entry.lastAccess = Date.now();
        return entry.el;
    }

    /**
     * Get existing container without creating
     * @param {string} sessionId
     * @returns {HTMLElement|null}
     */
    get(sessionId) {
        return this.containers.get(sessionId)?.el || null;
    }

    /**
     * Check if a container exists for a session
     * @param {string} sessionId
     * @returns {boolean}
     */
    has(sessionId) {
        return this.containers.has(sessionId);
    }

    /**
     * Switch the visible container (O(1) operation)
     * Browser natively preserves scrollTop on display:none elements —
     * no manual save/restore needed.
     * @param {string} sessionId - Session to activate
     * @returns {boolean} True if switch happened
     */
    activate(sessionId) {
        // Hide current active container
        if (this.activeId && this.activeId !== sessionId) {
            const currentEntry = this.containers.get(this.activeId);
            if (currentEntry) {
                // Capture scroll state NOW, while the container still has a
                // layout box — a display:none element always reads scrollTop 0,
                // so this is the only moment the real offset is observable.
                this._saveScrollState(currentEntry);
                currentEntry.el.style.display = 'none';
            }
        }

        // Show new container
        const entry = this.containers.get(sessionId);
        if (entry) {
            entry.el.style.display = 'flex';
            entry.lastAccess = Date.now();
            this.activeId = sessionId;
            return true;
        }

        this.activeId = sessionId;
        return false;
    }

    /**
     * Get the active container element (the current scroll target)
     * @returns {HTMLElement|null}
     */
    getActiveContainer() {
        if (!this.activeId) return null;
        return this.containers.get(this.activeId)?.el || null;
    }

    /**
     * Check if session needs initial render
     * @param {string} sessionId
     * @returns {boolean}
     */
    needsRender(sessionId) {
        const entry = this.containers.get(sessionId);
        return !entry || !entry.rendered;
    }

    /**
     * Mark session as rendered
     * @param {string} sessionId
     * @param {number} messageCount - Number of messages rendered
     */
    markRendered(sessionId, messageCount = 0) {
        const entry = this.containers.get(sessionId);
        if (entry) {
            entry.rendered = true;
            entry.messageCount = messageCount;
            this._log('Marked rendered', sessionId, 'messages:', messageCount);
        }
    }

    /**
     * Invalidate container (force re-render on next activate)
     * @param {string} sessionId
     */
    invalidate(sessionId) {
        const entry = this.containers.get(sessionId);
        if (entry) {
            entry.rendered = false;
            this._log('Invalidated', sessionId);
        }
    }

    /**
     * Update message count without full invalidation
     * @param {string} sessionId
     * @param {number} count
     */
    updateMessageCount(sessionId, count) {
        const entry = this.containers.get(sessionId);
        if (entry) {
            entry.messageCount = count;
        }
    }

    /**
     * Release a session's container entirely
     * @param {string} sessionId
     */
    release(sessionId) {
        const entry = this.containers.get(sessionId);
        if (entry) {
            entry.el.remove();
            this.containers.delete(sessionId);
            this._log('Released', sessionId);
        }

        if (this.activeId === sessionId) {
            this.activeId = null;
        }
    }

    /**
     * Hide all containers (keep them cached for O(1) switching)
     * Used when showing welcome screen
     */
    hideAll() {
        for (const [id, entry] of this.containers) {
            // Only the visible container has a readable scrollTop — capture it
            // before hiding (hidden ones keep their previously saved state).
            if (id === this.activeId) {
                this._saveScrollState(entry);
            }
            entry.el.style.display = 'none';
        }
        this.activeId = null;
        this._log('Hid all containers');
    }

    /**
     * Clear all containers
     */
    clear() {
        for (const [id, entry] of this.containers) {
            entry.el.remove();
        }
        this.containers.clear();
        this.activeId = null;
        this._log('Cleared all containers');
    }

    /**
     * Get statistics about the pool
     */
    getStats() {
        const stats = {
            count: this.containers.size,
            activeId: this.activeId,
            maxCached: MAX_CACHED,
            sessions: []
        };

        for (const [id, entry] of this.containers) {
            stats.sessions.push({
                id: id.substring(0, 8) + '...',
                rendered: entry.rendered,
                messageCount: entry.messageCount,
                lastAccess: new Date(entry.lastAccess).toISOString()
            });
        }

        return stats;
    }

    // ─────────────────────────────────────────────────────────────────
    // Private Methods
    // ─────────────────────────────────────────────────────────────────

    /**
     * Save a container's scroll state onto its pool entry.
     * Must be called while the container is still visible — a display:none
     * element has no layout box, so scrollTop/scrollHeight all read 0.
     * @private
     */
    _saveScrollState(entry) {
        const el = entry.el;
        if (!el.clientHeight) return;  // No layout (already hidden) — keep previous state
        entry.savedScrollTop = el.scrollTop;
        entry.savedAtBottom = (el.scrollHeight - el.scrollTop - el.clientHeight) <= 100;
    }

    /**
     * LRU eviction when pool exceeds MAX_CACHED
     * Calls onBeforeEvict callback to let app save scroll position
     * @private
     */
    _evictIfNeeded() {
        if (this.containers.size <= MAX_CACHED) return;

        // Find oldest non-active container
        let oldest = null;
        let oldestTime = Infinity;

        for (const [id, entry] of this.containers) {
            if (id === this.activeId) continue;

            if (entry.lastAccess < oldestTime) {
                oldest = id;
                oldestTime = entry.lastAccess;
            }
        }

        if (oldest) {
            // Notify before eviction so app can save scroll position.
            // NEVER read entry.el.scrollTop here: evicted containers are always
            // display:none (the active one is skipped above) and a hidden element
            // reads scrollTop 0 — which used to poison session.scrollPosition
            // with 0 and pin the session to the TOP on every later restore.
            // Use the offset captured when the container was last hidden;
            // null = "was at bottom" (or never measured) → restore to bottom.
            const entry = this.containers.get(oldest);
            if (this.onBeforeEvict && entry) {
                const scrollTop = (entry.savedAtBottom || entry.savedScrollTop == null)
                    ? null
                    : entry.savedScrollTop;
                this.onBeforeEvict(oldest, scrollTop);
            }

            this._log('LRU evicting', oldest);
            this.release(oldest);
        }
    }

    /**
     * Debug logging
     * @private
     */
    _log(...args) {
        if (this.debug || window.DEBUG_CONTAINER_POOL) {
            debug.log('[ContainerPool]', ...args);
        }
    }
}

// ─────────────────────────────────────────────────────────────────
// Integration Helper
// ─────────────────────────────────────────────────────────────────

/**
 * Create a pool attached to the messages container
 * @param {HTMLElement} messagesContainer - The #messages element
 * @param {Object} options - Pool options (e.g., onBeforeEvict callback)
 * @returns {SessionContainerPool}
 */
export function createContainerPool(messagesContainer, options = {}) {
    return new SessionContainerPool(messagesContainer, options);
}

/**
 * Check if container pool should be used
 * @returns {boolean}
 */
export function useContainerPool() {
    try {
        return localStorage.getItem('disable-container-pool') !== 'true';
    } catch {
        return true;
    }
}
