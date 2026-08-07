/**
 * Chat Navigator Module
 * Navigate between user messages in the chat history
 *
 * Features:
 * - Jump to previous/next user message with Cmd+Up/Cmd+Down
 * - Floating navigation UI with position indicator
 * - Brief highlight animation when jumping to a message
 * - Integration with lazy-loading: triggers history load when reaching top
 */

import { IS_MAC } from './shortcuts.js';

export class ChatNavigator {
    /**
     * @param {Object} elements - DOM elements
     * @param {HTMLElement} elements.messagesContainer - The scrollable messages container
     * @param {HTMLElement} elements.messages - The messages list element
     * @param {Object} callbacks - Callbacks
     * @param {Function} callbacks.getSession - Returns active session
     * @param {Function} callbacks.onLoadMore - Called when user navigates past loaded messages
     */
    constructor(elements, callbacks = {}) {
        this.els = elements;
        this.getSession = callbacks.getSession || (() => null);
        this.onLoadMore = callbacks.onLoadMore || (() => {});

        // Current navigation index (-1 = not navigating / at bottom)
        this.currentIndex = -1;

        // Loading state (prevents rapid repeated loads)
        this._isLoadingMore = false;

        // Track last navigation to detect "stuck" state
        // (when position calc oscillates between two visible messages)
        this._lastNavTarget = -1;
        this._lastNavTime = 0;

        // Scroll target (retargetable for per-tab scroll)
        this._scrollTarget = elements.messagesContainer;
        this._boundScrollHandler = () => this._updateNavUI();

        // Create the floating navigation UI
        this._createNavUI();

        // Update UI when messages change
        this._setupObserver();
    }

    /**
     * Get all user message elements in the current chat
     * With container pool, only query the ACTIVE (visible) session container
     */
    getUserMessages() {
        if (!this.els.messages) return [];

        // With container pool: find the visible .session-messages container
        const activeContainer = this.els.messages.querySelector('.session-messages[style*="display: block"]') ||
                               this.els.messages.querySelector('.session-messages:not([style*="display: none"])');

        if (activeContainer) {
            return Array.from(activeContainer.querySelectorAll('.message.user'));
        }

        // Fallback: query #messages directly (legacy mode or welcome screen)
        return Array.from(this.els.messages.querySelectorAll(':scope > .message.user'));
    }

    /**
     * Check if there are more messages to load from the server
     */
    hasMoreHistory() {
        const session = this.getSession();
        return session?.hasMoreMessages || false;
    }

    /**
     * Get total user prompt count from the session (server-side truth).
     * Falls back to counting user messages in session.messages array
     * (handles localStorage restore before server sync).
     */
    getServerPromptCount() {
        const session = this.getSession();
        if (!session) return 0;
        if (session.totalUserPromptCount > 0) return session.totalUserPromptCount;
        // Fallback: count from in-memory messages (covers pre-existing localStorage sessions)
        if (session.messages?.length > 0) {
            return session.messages.filter(m => m.role === 'user').length;
        }
        return 0;
    }

    /**
     * Get the current position info
     */
    getPositionInfo() {
        const messages = this.getUserMessages();
        const loadedTotal = messages.length;
        const hasMore = this.hasMoreHistory();
        const serverTotal = this.getServerPromptCount();
        const container = this._scrollTarget || this.els.messagesContainer;

        if (loadedTotal === 0) {
            return {
                current: 0,
                total: serverTotal,  // Use server-side count even when DOM has 0
                loadedTotal: 0,
                serverTotal,
                hasPrev: hasMore || serverTotal > 0,
                hasNext: false,
                hasMore,
                isAtBottom: true,
                isScrolledAway: false
            };
        }

        // Check if we're "at bottom" (scrolled past the last user message)
        const scrollBottom = container.scrollTop + container.clientHeight;
        const isNearBottom = container.scrollHeight - scrollBottom < 100; // Within 100px of bottom

        // Check if last user message is above the viewport
        const lastMsg = messages[messages.length - 1];
        const lastMsgRect = lastMsg.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();
        const lastMsgAboveView = lastMsgRect.bottom < containerRect.top + containerRect.height * 0.3;

        const isAtBottom = isNearBottom || lastMsgAboveView;

        // Check if first user message is below the viewport (scrolled away from start)
        const firstMsg = messages[0];
        const firstMsgRect = firstMsg.getBoundingClientRect();
        const isScrolledAway = firstMsgRect.top < containerRect.top - 100; // First msg is above viewport

        // Find which message is currently most visible
        const containerCenter = containerRect.top + containerRect.height / 2;

        let closestIndex = -1;
        let closestDistance = Infinity;

        messages.forEach((msg, idx) => {
            const rect = msg.getBoundingClientRect();
            const msgCenter = rect.top + rect.height / 2;
            const distance = Math.abs(msgCenter - containerCenter);

            // Only consider messages that are at least partially visible
            if (rect.bottom > containerRect.top && rect.top < containerRect.bottom) {
                if (distance < closestDistance) {
                    closestDistance = distance;
                    closestIndex = idx;
                }
            }
        });

        // If no visible message, find the closest one to scroll position
        if (closestIndex === -1) {
            const scrollTop = container.scrollTop;
            messages.forEach((msg, idx) => {
                const msgTop = msg.offsetTop;
                const distance = Math.abs(msgTop - scrollTop);
                if (distance < closestDistance) {
                    closestDistance = distance;
                    closestIndex = idx;
                }
            });
        }

        const current = closestIndex >= 0 ? closestIndex + 1 : loadedTotal;

        return {
            current,
            total: loadedTotal, // Loaded count for position display
            loadedTotal,
            serverTotal,
            hasPrev: current > 1 || hasMore || isAtBottom, // Can go prev if more loaded OR at bottom
            hasNext: current < loadedTotal || !isAtBottom, // Can go next if not at last OR not at bottom
            hasMore,
            isAtBottom,
            isScrolledAway
        };
    }

    /**
     * Navigate to the previous user message
     */
    goToPrevious() {
        const messages = this.getUserMessages();
        const info = this.getPositionInfo();

        // If at first loaded message but there's more history, trigger load
        if (info.current <= 1 && info.hasMore && !info.isAtBottom) {
            this._triggerLoadMore();
            this._lastNavTarget = -1;
            return true; // Indicate we're handling it
        }

        if (messages.length === 0) return false;
        if (!info.hasPrev) return false;

        const now = Date.now();
        let targetIndex;

        // When at bottom, go to last message first (not second-to-last)
        if (info.isAtBottom && info.current === info.total) {
            targetIndex = messages.length - 1; // Go to last message
        } else {
            targetIndex = info.current - 2; // -1 for 0-based, -1 for previous
        }

        // Detect "stuck" navigation - targeting same message twice within 2 seconds
        if (targetIndex === this._lastNavTarget && now - this._lastNavTime < 2000) {
            // Skip to the message before the stuck one
            const skipTarget = targetIndex - 1;
            if (skipTarget >= 0) {
                this._lastNavTarget = skipTarget;
                this._lastNavTime = now;
                this._scrollToMessage(messages[skipTarget]);
                this._updateNavUI();
                return true;
            }
        }

        if (targetIndex >= 0 && targetIndex < messages.length) {
            this._lastNavTarget = targetIndex;
            this._lastNavTime = now;
            this._scrollToMessage(messages[targetIndex]);
            this._updateNavUI();
            return true;
        }
        return false;
    }

    /**
     * Navigate to the next user message
     * When at the last message, jump to bottom (like "Jump to latest")
     */
    goToNext() {
        const messages = this.getUserMessages();

        // With no DOM user messages, still jump to bottom (jump-to-latest)
        if (messages.length === 0) {
            this._scrollToBottom();
            return true;
        }

        const info = this.getPositionInfo();

        // At last message (or beyond) - jump to bottom
        if (!info.hasNext || info.current >= info.total) {
            this._scrollToBottom();
            this._lastNavTarget = -1;
            return true;
        }

        const targetIndex = info.current; // current is 1-based, so this gives us next
        const now = Date.now();

        // Detect "stuck" navigation - targeting same message twice within 2 seconds
        // This happens when 2 user messages are both visible and position calc oscillates
        if (targetIndex === this._lastNavTarget && now - this._lastNavTime < 2000) {
            // Break out by going to bottom (or next message if not at end)
            if (targetIndex >= messages.length - 1) {
                this._scrollToBottom();
                this._lastNavTarget = -1;
                return true;
            }
            // Skip to the message after the stuck one
            const skipTarget = targetIndex + 1;
            if (skipTarget < messages.length) {
                this._lastNavTarget = skipTarget;
                this._lastNavTime = now;
                this._scrollToMessage(messages[skipTarget]);
                this._updateNavUI();
                return true;
            }
        }

        if (targetIndex >= 0 && targetIndex < messages.length) {
            this._lastNavTarget = targetIndex;
            this._lastNavTime = now;
            this._scrollToMessage(messages[targetIndex]);
            this._updateNavUI();
            return true;
        }
        return false;
    }

    /**
     * Scroll to the bottom of the chat (like "Jump to latest")
     */
    _scrollToBottom() {
        const container = this._scrollTarget || this.els.messagesContainer;
        container.scrollTo({
            top: container.scrollHeight,
            behavior: 'smooth'
        });
        this._updateNavUI();
    }

    /**
     * Trigger loading more history
     */
    _triggerLoadMore() {
        if (this._isLoadingMore) return;

        this._isLoadingMore = true;
        this._showLoadingState();

        // Call the callback to load more
        this.onLoadMore();

        // Reset loading state after a delay (the observer will update UI when messages arrive)
        setTimeout(() => {
            this._isLoadingMore = false;
            this._updateNavUI();
        }, 2000);
    }

    /**
     * Show loading state on the prev button
     */
    _showLoadingState() {
        const prevBtn = this.navUI.querySelector('.chat-nav-prev');
        prevBtn.classList.add('loading');
    }

    /**
     * Scroll to a specific message with highlight animation
     */
    _scrollToMessage(msgElement) {
        if (!msgElement) return;

        const container = this._scrollTarget || this.els.messagesContainer;

        // Calculate scroll position to center the message (or put it near top)
        const msgOffsetTop = msgElement.offsetTop;
        const targetScroll = msgOffsetTop - 60; // 60px from top for header visibility

        container.scrollTo({
            top: Math.max(0, targetScroll),
            behavior: 'smooth'
        });

        // Add highlight animation
        msgElement.classList.add('nav-highlight');
        setTimeout(() => {
            msgElement.classList.remove('nav-highlight');
        }, 1000);
    }

    /**
     * Create the floating navigation UI
     */
    _createNavUI() {
        // Create nav container
        this.navUI = document.createElement('div');
        this.navUI.className = 'chat-nav';
        this.navUI.innerHTML = `
            <button class="chat-nav-btn chat-nav-prev" data-tooltip="Previous message (${this._getModKey()}+↑)">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                    <polyline points="18 15 12 9 6 15"/>
                </svg>
            </button>
            <span class="chat-nav-pos">
                <span class="chat-nav-current">1</span>
                <span class="chat-nav-sep">/</span>
                <span class="chat-nav-total">1</span>
                <span class="chat-nav-more"></span>
            </span>
            <button class="chat-nav-btn chat-nav-next" data-tooltip="Next message (${this._getModKey()}+↓)">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                    <polyline points="6 9 12 15 18 9"/>
                </svg>
            </button>
        `;

        // Add event listeners (prevent keyboard popup on mobile)
        this.navUI.querySelector('.chat-nav-prev').addEventListener('click', (e) => {
            e.preventDefault();
            document.activeElement?.blur();
            this.goToPrevious();
        });

        this.navUI.querySelector('.chat-nav-next').addEventListener('click', (e) => {
            e.preventDefault();
            document.activeElement?.blur();
            this.goToNext();
        });

        // Insert into DOM — use the non-scrolling #messages-container parent.
        // The navUI is position:fixed so it doesn't need to be inside the scroll target.
        // Placing it inside a -webkit-overflow-scrolling:touch container traps it on iOS.
        this.els.messagesContainer.appendChild(this.navUI);

        // Make draggable (position indicator is the handle)
        this._initDrag();

        // Load saved position
        this._loadPosition();

        // Update on scroll (using stored bound handler for retargeting)
        (this._scrollTarget || this.els.messagesContainer).addEventListener('scroll', this._boundScrollHandler, { passive: true });

        // Initial update
        this._updateNavUI();
    }

    /**
     * Initialize drag functionality
     * Uses the position indicator as the drag handle
     */
    _initDrag() {
        const handle = this.navUI.querySelector('.chat-nav-pos');
        // Movement (px) the pointer must travel before a press becomes a drag.
        // Below this, a press is treated as a plain click and the widget stays put.
        const DRAG_THRESHOLD = 4;
        let dragPending = false;   // pointer is down on the handle, may become a drag
        let isDragging = false;    // threshold passed, actively dragging
        let startX, startY;
        let startLeft, startTop;

        const beginPending = (clientX, clientY) => {
            dragPending = true;
            isDragging = false;
            // getBoundingClientRect() reports the border-box position.
            const rect = this.navUI.getBoundingClientRect();
            startX = clientX;
            startY = clientY;
            startLeft = rect.left;
            startTop = rect.top;
        };

        const doDrag = (clientX, clientY) => {
            if (!dragPending) return;
            const dx = clientX - startX;
            const dy = clientY - startY;

            // Don't engage a drag until the pointer moves past the threshold,
            // so a plain click never nudges the widget.
            if (!isDragging) {
                if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
                isDragging = true;
                this.navUI.classList.add('dragging');
                document.body.style.userSelect = 'none';
                // Prevent chat from scrolling while dragging
                (this._scrollTarget || this.els.messagesContainer).style.overflow = 'hidden';
            }

            let newLeft = startLeft + dx;
            let newTop = startTop + dy;

            // Constrain to viewport
            const rect = this.navUI.getBoundingClientRect();
            const maxLeft = window.innerWidth - rect.width - 10;
            const maxTop = window.innerHeight - rect.height - 10;
            newLeft = Math.max(10, Math.min(maxLeft, newLeft));
            newTop = Math.max(10, Math.min(maxTop, newTop));

            // Apply position (switch from right/bottom to left/top)
            this._applyPosition(newLeft, newTop);
        };

        const endDrag = () => {
            if (!dragPending) return;
            const wasDragging = isDragging;
            dragPending = false;
            isDragging = false;
            if (!wasDragging) return; // plain click — nothing moved, nothing to save
            this.navUI.classList.remove('dragging');
            document.body.style.userSelect = '';
            // Re-enable scroll on messages container
            (this._scrollTarget || this.els.messagesContainer).style.overflow = '';
            this._savePosition();
        };

        // Mouse events
        handle.addEventListener('mousedown', (e) => {
            e.preventDefault();
            beginPending(e.clientX, e.clientY);
        });
        document.addEventListener('mousemove', (e) => doDrag(e.clientX, e.clientY));
        document.addEventListener('mouseup', endDrag);

        // Touch events
        handle.addEventListener('touchstart', (e) => {
            const touch = e.touches[0];
            beginPending(touch.clientX, touch.clientY);
        }, { passive: true });
        document.addEventListener('touchmove', (e) => {
            if (!dragPending) return;
            const touch = e.touches[0];
            doDrag(touch.clientX, touch.clientY);
        }, { passive: true });
        document.addEventListener('touchend', endDrag);

        // Double-click to reset position
        handle.addEventListener('dblclick', () => this._resetPosition());
    }

    /**
     * Position the widget from border-box coordinates (as reported by
     * getBoundingClientRect / saved position), compensating for the
     * container's margin. On a position:fixed element, left/top address the
     * margin edge, so a negative margin (see .chat-nav margin: -6px) would
     * otherwise shift the box up-left when switching from right/bottom anchoring.
     */
    _applyPosition(borderLeft, borderTop) {
        const cs = getComputedStyle(this.navUI);
        const ml = parseFloat(cs.marginLeft) || 0;
        const mt = parseFloat(cs.marginTop) || 0;
        this.navUI.style.left = `${borderLeft - ml}px`;
        this.navUI.style.top = `${borderTop - mt}px`;
        this.navUI.style.right = 'auto';
        this.navUI.style.bottom = 'auto';
    }

    /**
     * Save current position to localStorage
     */
    _savePosition() {
        const rect = this.navUI.getBoundingClientRect();
        localStorage.setItem('chat-nav-position', JSON.stringify({
            left: rect.left,
            top: rect.top
        }));
        this._hasCustomPosition = true;
    }

    /**
     * Load saved position from localStorage
     */
    _loadPosition() {
        const saved = localStorage.getItem('chat-nav-position');
        if (saved) {
            try {
                const pos = JSON.parse(saved);
                // Validate position is within current viewport
                if (pos.left >= 0 && pos.left < window.innerWidth - 50 &&
                    pos.top >= 0 && pos.top < window.innerHeight - 50) {
                    this._applyPosition(pos.left, pos.top);
                    this._hasCustomPosition = true;
                }
            } catch (e) {
                // Invalid saved position, use default
            }
        }
    }

    /**
     * Reset position to default (bottom-right)
     */
    _resetPosition() {
        localStorage.removeItem('chat-nav-position');
        this.navUI.style.left = '';
        this.navUI.style.top = '';
        this.navUI.style.right = '';
        this.navUI.style.bottom = '';
        this._hasCustomPosition = false;
    }

    /**
     * Get the platform-specific modifier key name
     */
    _getModKey() {
        return IS_MAC ? '⌘' : 'Ctrl';
    }

    /**
     * Update the navigation UI state
     */
    _updateNavUI() {
        const info = this.getPositionInfo();

        // Show/hide nav:
        // - Show if server knows about any user prompts (even if not in DOM)
        // - Show if >1 loaded message OR there's more history to load
        // - Also show with 1 message if user scrolled away from it
        const serverTotal = info.serverTotal || 0;
        const shouldShow = serverTotal >= 1 || info.loadedTotal >= 2 || info.hasMore ||
            (info.loadedTotal === 1 && info.isScrolledAway);

        if (!shouldShow) {
            this.navUI.classList.add('hidden');
            return;
        }

        this.navUI.classList.remove('hidden');

        // Use server total when available and larger than loaded count
        const displayTotal = Math.max(info.total, serverTotal);
        // Current position: use loaded position, offset by unloaded count
        const unloadedCount = Math.max(0, serverTotal - info.loadedTotal);
        const displayCurrent = info.current > 0 ? info.current + unloadedCount : (displayTotal > 0 ? displayTotal : 0);

        // Update position text
        this.navUI.querySelector('.chat-nav-current').textContent = displayCurrent;
        this.navUI.querySelector('.chat-nav-total').textContent = displayTotal;

        // Show "+" indicator if there are more messages to load
        const moreIndicator = this.navUI.querySelector('.chat-nav-more');
        moreIndicator.textContent = info.hasMore ? '+' : '';

        // Update button states
        const prevBtn = this.navUI.querySelector('.chat-nav-prev');
        const nextBtn = this.navUI.querySelector('.chat-nav-next');

        // At bottom: add class for CSS indicator inside down button
        const isAtBottom = info.isAtBottom && info.current === info.total;
        this.navUI.classList.toggle('at-bottom', isAtBottom);
        nextBtn.classList.toggle('at-bottom', isAtBottom);

        // Button states:
        // - Prev: enabled if there's previous messages, more history, OR at bottom (to jump to last msg)
        // - Next: enabled if there's next messages OR at bottom (to jump to latest)
        const prevEnabled = info.hasPrev;
        const nextEnabled = info.hasNext || isAtBottom; // Always enabled at bottom for "jump to latest"

        prevBtn.disabled = !prevEnabled;
        nextBtn.disabled = !nextEnabled;

        prevBtn.classList.toggle('disabled', !prevEnabled);
        nextBtn.classList.toggle('disabled', !nextEnabled);

        // Clear loading state if not actively loading
        if (!this._isLoadingMore) {
            prevBtn.classList.remove('loading');
        }
    }

    /**
     * Setup mutation observer to update UI when messages change.
     * Observes the active session container only (not the entire #messages parent)
     * to avoid firing on hidden/background containers.
     */
    _setupObserver() {
        if (!this.els.messages) return;

        this.observer = new MutationObserver(() => {
            // Debounce updates
            clearTimeout(this._updateTimeout);
            this._updateTimeout = setTimeout(() => {
                this._updateNavUI();
            }, 100);
        });

        // Start observing the scroll target (active container) or fallback to #messages
        this._observeTarget(this._scrollTarget || this.els.messages);
    }

    /**
     * Retarget the MutationObserver to a specific container.
     * Called on session switch to avoid observing hidden containers.
     * @param {HTMLElement} target
     * @private
     */
    _observeTarget(target) {
        if (!this.observer) return;
        this.observer.disconnect();
        this._observedTarget = target;
        this.observer.observe(target, {
            childList: true,
            subtree: true
        });
    }

    /**
     * Retarget to a new scroll container (per-tab scroll architecture).
     * Moves the scroll listener, MutationObserver, and updates scroll target.
     * @param {HTMLElement} newContainer - The new scrollable element
     */
    setScrollContainer(newContainer) {
        if (newContainer === this._scrollTarget) return;

        const oldTarget = this._scrollTarget || this.els.messagesContainer;

        // Move scroll listener to new container
        oldTarget.removeEventListener('scroll', this._boundScrollHandler);
        newContainer.addEventListener('scroll', this._boundScrollHandler, { passive: true });

        // NavUI stays in #messages-container (non-scrolling parent) — it's position:fixed

        this._scrollTarget = newContainer;

        // Retarget MutationObserver to new active container only
        // (avoids firing on hidden/background session containers)
        this._observeTarget(newContainer);

        this._updateNavUI();
    }

    /**
     * Force refresh the navigator UI
     * Call this when switching sessions
     */
    refresh() {
        this._lastNavTarget = -1;
        this._updateNavUI();
    }

    /**
     * Cleanup
     */
    destroy() {
        if (this.observer) {
            this.observer.disconnect();
        }
        if (this.navUI && this.navUI.parentNode) {
            this.navUI.parentNode.removeChild(this.navUI);
        }
    }
}
