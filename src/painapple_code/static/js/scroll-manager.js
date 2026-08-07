/**
 * Scroll Manager Module
 * Manages scroll position, "new messages" indicator, and lazy loading trigger
 * Implements Slack-style scroll behavior
 *
 * Uses ScrollStateMachine for race-free state management:
 * - No more boolean flag races during tab switches
 * - Coalesced scroll operations via requestAnimationFrame
 * - Explicit state transitions prevent invalid operations
 */

import { ScrollStateMachine, ScrollState } from './scroll-state-machine.js';

/**
 * ScrollManager - Handle scroll position and new messages indicator
 */
export class ScrollManager {
    /**
     * @param {HTMLElement} container - The scrollable messages container
     * @param {Object} options - Configuration options
     * @param {number} options.scrollThreshold - Pixels from bottom to consider "at bottom" (default: 100)
     * @param {number} options.topThreshold - Pixels from top to trigger load more (default: 100)
     * @param {Object} callbacks - Callback functions
     * @param {Function} callbacks.onScrollTop - Called when user scrolls near top (for lazy loading)
     * @param {Function} callbacks.getSession - Returns current session (for scroll position persistence)
     */
    constructor(container, options = {}, callbacks = {}) {
        this.container = container;

        // Configuration
        this.scrollThreshold = options.scrollThreshold || 100;
        this.topThreshold = options.topThreshold || 100;

        // Callbacks
        this.onScrollTop = callbacks.onScrollTop || (() => {});
        this.getSession = callbacks.getSession || (() => null);

        // State machine for scroll operations (replaces boolean flags)
        this._stateMachine = new ScrollStateMachine();

        // Legacy compatibility: expose isUserScrolledUp as getter
        // Actual state tracked via state machine
        this._isUserScrolledUp = false;

        this.newMessageCount = 0;
        this._lastScrollTopCall = 0;  // Throttle for onScrollTop
        this._rafId = null;  // RAF throttling for scroll

        // PERF: Cache container rect to avoid repeated layout queries
        this._containerRect = null;
        this._containerRectTime = 0;

        // Bind scroll event with RAF throttling for performance
        this._scrollHandler = () => {
            // Cancel any pending RAF - only process latest scroll position
            if (this._rafId) return;
            this._rafId = requestAnimationFrame(() => {
                this._rafId = null;
                this._handleScroll();
            });
        };
        this.container.addEventListener('scroll', this._scrollHandler);

        // Hold auto-scroll while a real mouse/trackpad pointer rests on a
        // link in the transcript — streaming updates otherwise yank the link
        // out from under the cursor mid-click. Tracked via pointer events
        // gated on pointerType 'mouse' (NOT a CSS :hover probe: iOS taps
        // leave sticky :hover on links, which would wedge auto-scroll off
        // after every tapped link on touch devices).
        this._hoveredLink = null;
        document.addEventListener('pointerover', (e) => {
            if (e.pointerType !== 'mouse') return;
            this._hoveredLink = e.target.closest?.('a') || null;
        });
        document.addEventListener('pointerout', (e) => {
            if (e.pointerType !== 'mouse') return;
            // Pointer left the window — no pointerover follows to clear it
            if (!e.relatedTarget) this._hoveredLink = null;
        });
    }

    /**
     * Is the mouse pointer currently on a link inside the transcript?
     * isConnected guards against streaming re-renders replacing the node
     * without a pointer boundary event firing.
     */
    _isPointerOnLink() {
        const link = this._hoveredLink;
        return !!(link && link.isConnected && this.container.contains(link));
    }

    // Legacy getter for backwards compatibility
    get isUserScrolledUp() {
        return this._isUserScrolledUp;
    }

    set isUserScrolledUp(value) {
        this._isUserScrolledUp = value;
        // Sync with state machine
        if (value && this._stateMachine.getState() === ScrollState.IDLE) {
            this._stateMachine.transition(ScrollState.USER_SCROLLING);
        } else if (!value && this._stateMachine.getState() === ScrollState.USER_SCROLLING) {
            this._stateMachine.transition(ScrollState.IDLE);
        }
    }

    /**
     * Handle scroll events
     */
    _handleScroll() {
        // Skip during tab/session switch (use state machine)
        if (this._stateMachine.isSwitching()) {
            return;
        }

        const wasScrolledUp = this._isUserScrolledUp;
        this._isUserScrolledUp = !this.isNearBottom();

        // User scrolled back to bottom - clear indicator and update state machine
        if (wasScrolledUp && !this._isUserScrolledUp) {
            this.clearIndicator();
            this._stateMachine.userScrolledToBottom();
        } else if (!wasScrolledUp && this._isUserScrolledUp) {
            // User just scrolled up - update state machine
            this._stateMachine.userScrollStart();
        }

        // Update button visibility
        this._updateButton();

        // Update question indicator on scroll (check if question is now visible)
        if (this._pendingQuestion) {
            this.updateQuestionIndicator(this._pendingQuestion);
        }

        // Lazy loading: check if scrolled near top (throttled to prevent spam)
        if (this._isNearTop()) {
            const now = Date.now();
            // Throttle: only call once per 500ms
            if (now - this._lastScrollTopCall > 500) {
                this._lastScrollTopCall = now;
                this.onScrollTop();
            }
        }
    }

    /**
     * Check if user is scrolled near the bottom
     */
    isNearBottom() {
        const distanceFromBottom = this.container.scrollHeight - this.container.scrollTop - this.container.clientHeight;
        return distanceFromBottom <= this.scrollThreshold;
    }

    /**
     * Check if user has scrolled near the top
     * Note: On iOS Safari, scrollTop can be negative due to rubber-band effect
     */
    _isNearTop() {
        // Ignore negative scrollTop (iOS rubber-band effect)
        const scrollTop = Math.max(0, this.container.scrollTop);
        return scrollTop < this.topThreshold;
    }

    /**
     * Update the floating "new messages" / "scroll to bottom" button
     */
    _updateButton() {
        // PERF: Use cached button reference instead of querying every scroll
        let btn = this._newMessagesBtn;

        // Show button whenever user is scrolled up
        if (this.isUserScrolledUp) {
            if (!btn) {
                btn = document.createElement('button');
                btn.className = 'new-messages-btn';
                btn.addEventListener('click', () => this.scrollToBottomForce());
                this.container.appendChild(btn);
                this._newMessagesBtn = btn;  // Cache reference
            }

            if (this.newMessageCount > 0) {
                // New messages - highlight style
                const plural = this.newMessageCount === 1 ? '' : 's';
                btn.innerHTML = `
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M12 19V5M5 12l7 7 7-7"/>
                    </svg>
                    ${this.newMessageCount} new message${plural}
                `;
                btn.classList.remove('subtle');
            } else {
                // No new messages - subtle style
                btn.innerHTML = `
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M12 19V5M5 12l7 7 7-7"/>
                    </svg>
                    Jump to latest
                `;
                btn.classList.add('subtle');
            }
            btn.classList.add('visible');
        } else if (btn) {
            btn.classList.remove('visible');
        }
    }

    // ─────────────────────────────────────────────────────────────────
    // Public API
    // ─────────────────────────────────────────────────────────────────

    /**
     * Set session switching flag (to pause scroll handling)
     * Uses state machine for proper state transitions
     */
    setSwitching(switching) {
        if (switching) {
            this._stateMachine.beginSwitch();
        } else {
            this._stateMachine.endSwitch();
        }
    }

    /**
     * Retarget to a new scroll container (per-tab scroll architecture).
     * Moves the scroll listener and floating elements to the new container.
     * @param {HTMLElement} newContainer - The new scrollable element
     * @param {Object} [options]
     * @param {boolean} [options.skipInitState] - Skip initState() when restoring
     *   scroll state externally (e.g., O(1) tab switch where session.isUserScrolledUp is used)
     */
    setContainer(newContainer, options = {}) {
        if (newContainer === this.container) return;

        // Move event listener
        this.container.removeEventListener('scroll', this._scrollHandler);
        newContainer.addEventListener('scroll', this._scrollHandler);

        // Move floating elements (new-messages button, question indicator)
        if (this._newMessagesBtn?.parentNode) {
            this._newMessagesBtn.remove();
            newContainer.appendChild(this._newMessagesBtn);
        }
        if (this._questionIndicator?.parentNode) {
            this._questionIndicator.remove();
            newContainer.appendChild(this._questionIndicator);
        }

        this.container = newContainer;
        this._containerRect = null;  // Invalidate cached rect

        if (!options.skipInitState) {
            this.initState();
        }
    }

    /**
     * Soft scroll to bottom - only scrolls if user is already near bottom
     * Does NOT track new messages (use trackNewMessage for that)
     * Uses state machine to prevent races
     */
    scrollToBottom() {
        // Pointer is aiming at a link — don't move it (checked before the
        // state machine so the streaming throttle stamp isn't consumed)
        if (this._isPointerOnLink()) {
            return;
        }
        // Use state machine to check if we can auto-scroll
        if (!this._stateMachine.canAutoScroll()) {
            return;
        }
        // If user is scrolled up, don't auto-scroll
        if (this._isUserScrolledUp) {
            return;
        }

        // Use state machine's coalesced scroll
        this._stateMachine.scrollToBottom(this.container);
    }

    /**
     * Soft scroll during streaming - throttled to prevent excessive scrolls
     */
    scrollToBottomStreaming() {
        if (this._isPointerOnLink()) {
            return;
        }
        if (!this._stateMachine.canAutoScrollStreaming(100)) {
            return;
        }
        if (this._isUserScrolledUp) {
            return;
        }

        this._stateMachine.scrollToBottom(this.container, { streaming: true });
    }

    /**
     * Track that a new meaningful message arrived (for the indicator)
     * Only call this for actual assistant responses, not tool updates or typing
     */
    trackNewMessage() {
        if (this.isUserScrolledUp) {
            this.newMessageCount++;
            this._updateButton();
        }
    }

    /**
     * Force scroll to bottom - always scrolls (user action)
     * Used when user clicks "new messages" button or sends a message
     * @param {Object} options
     * @param {boolean} options.respectLinkHover - UI-initiated force scrolls
     *   (activity strip growth) pass this so they can't yank a link out from
     *   under the pointer; genuine user actions omit it and always scroll.
     */
    scrollToBottomForce(options = {}) {
        if (options.respectLinkHover && this._isPointerOnLink()) {
            return;
        }
        this.clearIndicator();
        this._isUserScrolledUp = false;

        // Reset state machine to IDLE
        if (this._stateMachine.getState() === ScrollState.USER_SCROLLING) {
            this._stateMachine.transition(ScrollState.IDLE);
        }

        // Clear saved scroll position on session
        const session = this.getSession();
        if (session) {
            session.scrollPosition = null;
            session.isUserScrolledUp = false;
        }

        // Use state machine's forced scroll
        this._stateMachine.scrollToBottom(this.container, { force: true });
    }

    /**
     * Clear the new messages counter and remove the button
     */
    clearIndicator() {
        this.newMessageCount = 0;
        // PERF: Use cached reference instead of querying
        const btn = this._newMessagesBtn;
        if (btn) {
            btn.remove();
            this._newMessagesBtn = null;  // Clear cache
        }
    }

    /**
     * Initialize scroll state based on current position
     * Call after rendering messages
     */
    initState() {
        this._isUserScrolledUp = !this.isNearBottom();
        // Sync with state machine
        if (this._isUserScrolledUp) {
            this._stateMachine.forceTransition(ScrollState.USER_SCROLLING, 'initState');
        } else {
            this._stateMachine.forceTransition(ScrollState.IDLE, 'initState');
        }
    }

    /**
     * Get current scroll position for persistence
     */
    getScrollPosition() {
        return this.container.scrollTop;
    }

    /**
     * Restore scroll position using state machine
     */
    setScrollPosition(position) {
        this._stateMachine.savePosition(this.container);
        this._stateMachine.scheduleScroll(this.container, position);
    }

    /**
     * Scroll to absolute bottom (for restoring at-bottom state)
     */
    scrollToMax() {
        this._stateMachine.scrollToBottom(this.container, { force: true });
    }

    /**
     * Get state machine state (for debugging)
     */
    getState() {
        return this._stateMachine.toJSON();
    }

    // ─────────────────────────────────────────────────────────────────
    // Question Indicator
    // ─────────────────────────────────────────────────────────────────

    /**
     * Update the floating question indicator
     * Shows when there's a pending question that's not visible in viewport
     * @param {Object|null} questionMsg - The pending question message, or null if none
     */
    updateQuestionIndicator(questionMsg) {
        // Store for scroll handler
        this._pendingQuestion = questionMsg;

        // PERF: Use cached indicator reference instead of querying
        let indicator = this._questionIndicator;

        // No question or question is answered - hide indicator
        if (!questionMsg || questionMsg.answered) {
            this._pendingQuestion = null;
            if (indicator) indicator.classList.remove('visible');
            return;
        }

        // Check if question element is in viewport
        const questionEl = document.getElementById(`msg-${questionMsg.id}`);
        if (questionEl && this._isElementInViewport(questionEl)) {
            if (indicator) indicator.classList.remove('visible');
            return;
        }

        // Question exists but not visible - show indicator
        if (!indicator) {
            indicator = document.createElement('div');
            indicator.className = 'question-indicator';
            indicator.addEventListener('click', () => this._scrollToQuestion(questionMsg));
            this.container.appendChild(indicator);
            this._questionIndicator = indicator;  // Cache reference
        }

        // Build badge previews from question entries
        const entries = questionMsg.entries || [{
            questions: questionMsg.questions || []
        }];

        // Collect all question headers/badges
        const badges = [];
        entries.forEach(entry => {
            (Array.isArray(entry.questions) ? entry.questions : []).forEach(q => {
                if (q.header) badges.push(q.header);
            });
        });

        // Limit to first 4 badges
        const displayBadges = badges.slice(0, 4);
        const moreBadges = badges.length > 4 ? badges.length - 4 : 0;

        const badgesHtml = displayBadges.map(b =>
            `<span class="qi-badge">${this._escapeHtml(b)}</span>`
        ).join('') + (moreBadges > 0 ? `<span class="qi-more">+${moreBadges}</span>` : '');

        indicator.innerHTML = `
            <div class="qi-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="12" cy="12" r="10"/>
                    <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/>
                    <line x1="12" y1="17" x2="12.01" y2="17"/>
                </svg>
            </div>
            <div class="qi-content">
                <div class="qi-title">Claude is asking</div>
                <div class="qi-badges">${badgesHtml}</div>
            </div>
            <div class="qi-arrow">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M12 19V5M5 12l7-7 7 7"/>
                </svg>
            </div>
        `;

        indicator.classList.add('visible');
    }

    /**
     * Get cached container bounding rect (expires after 100ms)
     * PERF: Avoids repeated getBoundingClientRect calls during scroll
     */
    _getContainerRect() {
        const now = Date.now();
        if (!this._containerRect || now - this._containerRectTime > 100) {
            this._containerRect = this.container.getBoundingClientRect();
            this._containerRectTime = now;
        }
        return this._containerRect;
    }

    /**
     * Check if an element is visible in the viewport
     */
    _isElementInViewport(el) {
        const rect = el.getBoundingClientRect();
        const containerRect = this._getContainerRect();

        // Check if element is within container's visible area
        return rect.top < containerRect.bottom && rect.bottom > containerRect.top;
    }

    /**
     * Scroll to the question element
     */
    _scrollToQuestion(questionMsg) {
        const questionEl = document.getElementById(`msg-${questionMsg.id}`);
        if (questionEl) {
            questionEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
            // Brief highlight effect
            questionEl.classList.add('highlight-pulse');
            setTimeout(() => questionEl.classList.remove('highlight-pulse'), 1500);
        }
        // Hide indicator (use cached reference)
        if (this._questionIndicator) {
            this._questionIndicator.classList.remove('visible');
        }
    }

    /**
     * Simple HTML escape (PERF: use string replacement instead of DOM)
     */
    _escapeHtml(str) {
        return str
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }
}
