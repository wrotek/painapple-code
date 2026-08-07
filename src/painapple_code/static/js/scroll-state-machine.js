/**
 * Scroll State Machine
 *
 * Replaces boolean flags with explicit state transitions to prevent race conditions.
 * All scroll operations go through this state machine.
 */

export const ScrollState = {
    IDLE: 'idle',
    SWITCHING: 'switching',       // Tab/session switch in progress
    RESTORING: 'restoring',       // Restoring saved scroll position
    AUTO_SCROLLING: 'auto',       // Auto-scrolling to new content
    USER_SCROLLING: 'user',       // User is manually scrolling
    LOADING_MORE: 'loading'       // Loading older messages
};

// Valid state transitions
const TRANSITIONS = {
    [ScrollState.IDLE]: [
        ScrollState.SWITCHING,
        ScrollState.AUTO_SCROLLING,
        ScrollState.USER_SCROLLING,
        ScrollState.LOADING_MORE
    ],
    [ScrollState.SWITCHING]: [
        ScrollState.RESTORING,
        ScrollState.IDLE
    ],
    [ScrollState.RESTORING]: [
        ScrollState.IDLE
    ],
    [ScrollState.AUTO_SCROLLING]: [
        ScrollState.IDLE,
        ScrollState.USER_SCROLLING  // User can interrupt auto-scroll
    ],
    [ScrollState.USER_SCROLLING]: [
        ScrollState.IDLE,
        ScrollState.AUTO_SCROLLING,  // Can auto-scroll when user scrolls back to bottom
        ScrollState.LOADING_MORE     // Scrolling to top triggers load-more
    ],
    [ScrollState.LOADING_MORE]: [
        ScrollState.IDLE
    ]
};

/**
 * ScrollStateMachine - Manages scroll state transitions
 */
export class ScrollStateMachine {
    constructor() {
        this.state = ScrollState.IDLE;
        this._pendingScrollRaf = null;
        this._savedPosition = null;
        this._lastStreamScroll = 0;  // Throttle streaming scrolls
        this._listeners = [];
    }

    /**
     * Get current state
     */
    getState() {
        return this.state;
    }

    /**
     * Check if a transition is valid
     */
    canTransition(newState) {
        const allowed = TRANSITIONS[this.state];
        return allowed?.includes(newState) ?? false;
    }

    /**
     * Transition to a new state
     * @param {string} newState - Target state
     * @param {Object} context - Optional context for logging
     * @returns {boolean} True if transition succeeded
     */
    transition(newState, context = {}) {
        if (!this.canTransition(newState)) {
            console.warn(`[ScrollState] Invalid transition: ${this.state} -> ${newState}`, context);
            return false;
        }

        const oldState = this.state;
        this.state = newState;

        // Debug logging (can be disabled in production)
        if (window.DEBUG_SCROLL) {
            console.debug(`[ScrollState] ${oldState} -> ${newState}`, context);
        }

        // Notify listeners
        this._listeners.forEach(fn => fn(oldState, newState, context));

        return true;
    }

    /**
     * Force transition (bypass validation - use sparingly for recovery)
     */
    forceTransition(newState, reason = 'forced') {
        const oldState = this.state;
        this.state = newState;
        console.warn(`[ScrollState] Force: ${oldState} -> ${newState} (${reason})`);
        this._listeners.forEach(fn => fn(oldState, newState, { forced: true, reason }));
    }

    /**
     * Add state change listener
     */
    onStateChange(fn) {
        this._listeners.push(fn);
        return () => {
            this._listeners = this._listeners.filter(f => f !== fn);
        };
    }

    // ─────────────────────────────────────────────────────────────────
    // State Queries
    // ─────────────────────────────────────────────────────────────────

    /**
     * Can we auto-scroll to new content?
     * Only when idle or already auto-scrolling
     */
    canAutoScroll() {
        return this.state === ScrollState.IDLE ||
               this.state === ScrollState.AUTO_SCROLLING;
    }

    /**
     * Can we auto-scroll during streaming?
     * Throttled to prevent excessive scrolls
     */
    canAutoScrollStreaming(throttleMs = 100) {
        if (!this.canAutoScroll()) return false;

        const now = Date.now();
        if (now - this._lastStreamScroll < throttleMs) {
            return false;
        }
        this._lastStreamScroll = now;
        return true;
    }

    /**
     * Can the user scroll normally?
     * Blocked during switch/restore to prevent interference
     */
    canUserScroll() {
        return this.state !== ScrollState.SWITCHING &&
               this.state !== ScrollState.RESTORING;
    }

    /**
     * Is a session switch in progress?
     */
    isSwitching() {
        return this.state === ScrollState.SWITCHING ||
               this.state === ScrollState.RESTORING;
    }

    /**
     * Is the user manually scrolled up?
     */
    isUserScrolledUp() {
        return this.state === ScrollState.USER_SCROLLING;
    }

    // ─────────────────────────────────────────────────────────────────
    // Scroll Operations
    // ─────────────────────────────────────────────────────────────────

    /**
     * Schedule a scroll operation with coalescing
     * Cancels any pending scroll and schedules new one
     * @param {HTMLElement} container - Scroll container
     * @param {number} position - Target scrollTop
     * @param {Function} callback - Called after scroll completes
     */
    scheduleScroll(container, position, callback = null) {
        // Cancel any pending scroll - coalesce to single operation
        if (this._pendingScrollRaf) {
            cancelAnimationFrame(this._pendingScrollRaf);
        }

        this._pendingScrollRaf = requestAnimationFrame(() => {
            this._pendingScrollRaf = null;

            // Actually perform the scroll
            container.scrollTop = position;

            // If we were restoring, transition back to IDLE
            if (this.state === ScrollState.RESTORING) {
                this.transition(ScrollState.IDLE, { position });
            }

            callback?.();
        });
    }

    /**
     * Scroll to bottom with state management
     * @param {HTMLElement} container
     * @param {Object} options
     */
    scrollToBottom(container, options = {}) {
        const { force = false, streaming = false } = options;

        // Check if we can scroll
        if (!force) {
            if (streaming) {
                if (!this.canAutoScrollStreaming()) return false;
            } else {
                if (!this.canAutoScroll()) return false;
            }
        }

        // Transition to auto-scrolling state
        if (this.state === ScrollState.IDLE) {
            this.transition(ScrollState.AUTO_SCROLLING);
        }

        this.scheduleScroll(container, container.scrollHeight, () => {
            // Return to IDLE after auto-scroll completes
            if (this.state === ScrollState.AUTO_SCROLLING) {
                this.transition(ScrollState.IDLE);
            }
        });

        return true;
    }

    /**
     * Save current scroll position
     */
    savePosition(container) {
        this._savedPosition = container.scrollTop;
    }

    /**
     * Restore saved scroll position
     */
    restorePosition(container) {
        if (this._savedPosition === null) {
            // No saved position - scroll to bottom
            this.scrollToBottom(container, { force: true });
            return;
        }

        this.transition(ScrollState.RESTORING, { position: this._savedPosition });
        this.scheduleScroll(container, this._savedPosition);
    }

    /**
     * Clear saved position
     */
    clearSavedPosition() {
        this._savedPosition = null;
    }

    // ─────────────────────────────────────────────────────────────────
    // Session Switch Helpers
    // ─────────────────────────────────────────────────────────────────

    /**
     * Begin session switch
     * Call this before switching sessions
     */
    beginSwitch() {
        // Force to IDLE first if in invalid state
        if (!this.canTransition(ScrollState.SWITCHING)) {
            this.forceTransition(ScrollState.IDLE, 'pre-switch reset');
        }
        return this.transition(ScrollState.SWITCHING, { reason: 'session switch' });
    }

    /**
     * End session switch
     * Call this after session switch completes
     */
    endSwitch() {
        // Clear any pending scrolls from previous session
        if (this._pendingScrollRaf) {
            cancelAnimationFrame(this._pendingScrollRaf);
            this._pendingScrollRaf = null;
        }

        // Transition back to IDLE
        if (this.state === ScrollState.SWITCHING) {
            this.transition(ScrollState.IDLE, { reason: 'switch complete' });
        } else if (this.state === ScrollState.RESTORING) {
            // Let restore complete naturally
        } else {
            // Force to IDLE if in unexpected state
            this.forceTransition(ScrollState.IDLE, 'post-switch cleanup');
        }
    }

    // ─────────────────────────────────────────────────────────────────
    // User Scroll Tracking
    // ─────────────────────────────────────────────────────────────────

    /**
     * Called when user starts manual scroll
     */
    userScrollStart() {
        if (this.canUserScroll() && this.state !== ScrollState.USER_SCROLLING) {
            this.transition(ScrollState.USER_SCROLLING);
        }
    }

    /**
     * Called when user scrolls back to bottom
     */
    userScrolledToBottom() {
        if (this.state === ScrollState.USER_SCROLLING) {
            this.transition(ScrollState.IDLE, { reason: 'scrolled to bottom' });
        }
    }

    /**
     * Begin loading more (older) messages
     */
    beginLoadMore() {
        if (this.state === ScrollState.USER_SCROLLING || this.state === ScrollState.IDLE) {
            return this.transition(ScrollState.LOADING_MORE);
        }
        return false;
    }

    /**
     * End loading more
     */
    endLoadMore() {
        if (this.state === ScrollState.LOADING_MORE) {
            this.transition(ScrollState.IDLE);
        }
    }

    // ─────────────────────────────────────────────────────────────────
    // Debug
    // ─────────────────────────────────────────────────────────────────

    /**
     * Get state for debugging
     */
    toJSON() {
        return {
            state: this.state,
            savedPosition: this._savedPosition,
            hasPendingScroll: !!this._pendingScrollRaf
        };
    }
}

// Singleton instance for easy import
export const scrollStateMachine = new ScrollStateMachine();
