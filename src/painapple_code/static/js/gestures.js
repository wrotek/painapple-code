/**
 * Gesture Handler for Tab Navigation
 *
 * Intercepts two-finger trackpad swipes and touch gestures
 * to enable tab switching instead of browser back/forward navigation.
 *
 * Works best in PWA standalone mode where browser navigation is disabled.
 */

/**
 * GestureManager - Handles swipe gestures for tab navigation
 */
export class GestureManager {
    constructor(app) {
        this.app = app;

        // Wheel gesture state (trackpad two-finger swipe)
        this.wheelAccumulator = 0;
        this.wheelTimeout = null;
        this.wheelCooldown = false;

        // Touch gesture state
        this.touchStartX = 0;
        this.touchStartY = 0;
        this.touchStartTime = 0;
        this.touchCooldown = false;
        this.isSwiping = false;
        this.swipeIndicator = null;

        // Configuration
        this.config = {
            // Wheel settings
            wheelThreshold: 120,        // Accumulated deltaX to trigger (px)
            wheelResetDelay: 150,       // Reset accumulator after this delay (ms)
            wheelCooldownTime: 400,     // Cooldown between triggers (ms)

            // Touch settings
            touchThreshold: 130,        // Minimum swipe distance (px) - ~17% of iPad portrait
            touchMaxTime: 500,          // Maximum swipe duration (ms)
            touchAngleThreshold: 2.0,   // Horizontal must be 2x vertical
            touchCooldownTime: 400,     // Cooldown between triggers (ms)

            // Edge swipe detection (for non-PWA mode)
            edgeZone: 30,               // Edge zone width (px)
        };

        this.init();
    }

    init() {
        // Wheel events for trackpad
        document.addEventListener('wheel', (e) => this.handleWheel(e), { passive: false });

        // Touch events for mobile/tablet
        // Using passive: false to allow preventDefault() for blocking browser back/forward gestures
        // This is necessary because iOS Safari interprets edge swipes as navigation
        document.addEventListener('touchstart', (e) => this.handleTouchStart(e), { passive: false });
        document.addEventListener('touchmove', (e) => this.handleTouchMove(e), { passive: false });
        document.addEventListener('touchend', (e) => this.handleTouchEnd(e), { passive: false });
        document.addEventListener('touchcancel', (e) => this.handleTouchCancel(e), { passive: true });

        // Create swipe indicator element
        this.createSwipeIndicator();

        // History API trap (fallback for any navigation that slips through)
        this.setupHistoryTrap();
    }

    /**
     * Handle wheel events (trackpad two-finger swipe)
     */
    handleWheel(e) {
        // Skip if in terminal (has its own scrolling)
        const inTerminal = e.target.closest('.terminal-container, .xterm');

        // Skip if inside a floating widget (widgets contain their own scroll)
        const inWidget = e.target.closest('.widget-floating');

        // Skip if target has horizontal scroll
        const hasScroll = this.hasHorizontalScroll(e.target);

        // Check for any horizontal component (even small)
        // iPadOS trackpad back/forward gesture starts with small deltaX values
        const hasHorizontalComponent = Math.abs(e.deltaX) > 0;
        // Only treat horizontal as the *primary* axis when it dominates.
        // Many mice/trackpads emit a tiny incidental deltaX on a pure vertical
        // scroll — blocking the whole event on that would kill chat scroll on
        // any message that has no horizontally-scrolling descendant (the
        // ancestor check above only saves us when a <pre> or table is nearby).
        // iPadOS back/forward edge swipes are intrinsically horizontal, so
        // they still satisfy |deltaX| > |deltaY| and remain blocked.
        const isHorizontalDominant = Math.abs(e.deltaX) > Math.abs(e.deltaY);

        // Prevent browser back/forward only for primarily-horizontal wheel
        // movement (except in terminal, horizontally scrollable areas, or
        // floating widgets). Must happen early before the browser can
        // interpret it as navigation.
        if (hasHorizontalComponent && isHorizontalDominant && !inTerminal && !hasScroll && !inWidget) {
            e.preventDefault();
        }

        // Only care about significant horizontal movement for tab switching
        const isHorizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY) && Math.abs(e.deltaX) > 5;

        // Now apply filtering for tab switch logic
        if (this.wheelCooldown) return;
        if (inTerminal) return;
        if (inWidget) return;
        if (hasScroll) return;
        if (!isHorizontal) return;

        // Accumulate horizontal movement
        this.wheelAccumulator += e.deltaX;

        // Clear existing timeout
        if (this.wheelTimeout) {
            clearTimeout(this.wheelTimeout);
        }

        // Check if threshold exceeded
        if (Math.abs(this.wheelAccumulator) >= this.config.wheelThreshold) {
            const direction = this.wheelAccumulator > 0 ? 1 : -1;  // 1 = next, -1 = prev
            this.triggerTabSwitch(direction, 'wheel');

            // Reset and set cooldown
            this.wheelAccumulator = 0;
            this.wheelCooldown = true;
            setTimeout(() => {
                this.wheelCooldown = false;
            }, this.config.wheelCooldownTime);
        }

        // Reset accumulator after delay (gesture ended)
        this.wheelTimeout = setTimeout(() => {
            this.wheelAccumulator = 0;
        }, this.config.wheelResetDelay);
    }

    /**
     * Handle touch start
     */
    handleTouchStart(e) {
        if (e.touches.length !== 1) return;  // Single finger only

        // Skip if starting inside a floating overlay (widget, modal, dialog)
        if (this.isInsideOverlay(e.target)) return;

        this.touchStartX = e.touches[0].clientX;
        this.touchStartY = e.touches[0].clientY;
        this.touchStartTime = Date.now();
    }

    /**
     * Handle touch end
     */
    handleTouchEnd(e) {
        // Skip if cooldown active
        if (this.touchCooldown) return;

        // Skip if no start recorded
        if (!this.touchStartTime) return;

        const touch = e.changedTouches[0];
        const deltaX = touch.clientX - this.touchStartX;
        const deltaY = touch.clientY - this.touchStartY;
        const deltaTime = Date.now() - this.touchStartTime;

        // Reset start
        this.touchStartTime = 0;

        // Skip if too slow
        if (deltaTime > this.config.touchMaxTime) return;

        // Skip if not enough horizontal movement
        if (Math.abs(deltaX) < this.config.touchThreshold) return;

        // Skip if not primarily horizontal
        if (Math.abs(deltaX) < Math.abs(deltaY) * this.config.touchAngleThreshold) return;

        // Skip if in terminal
        if (e.target.closest('.terminal-container, .xterm')) return;

        // Skip if target has horizontal scroll
        if (this.hasHorizontalScroll(e.target)) return;

        // Skip if text is being selected (user is dragging to select, not swiping)
        const selection = window.getSelection();
        if (selection && selection.toString().trim().length > 0) {
            return;
        }

        // Determine direction: swipe left (deltaX < 0) = next, swipe right (deltaX > 0) = prev
        const direction = deltaX < 0 ? 1 : -1;

        // Prevent synthetic click from this touch sequence (stops iOS keyboard popup)
        e.preventDefault();

        // Flash indicator to show threshold was reached
        this.flashIndicator(direction);

        this.triggerTabSwitch(direction, 'touch');

        // Set cooldown
        this.touchCooldown = true;
        setTimeout(() => {
            this.touchCooldown = false;
        }, this.config.touchCooldownTime);

        // Reset swipe state
        this.isSwiping = false;
        this.hideIndicator();
    }

    /**
     * Handle touch cancel (e.g., interrupted by system gesture)
     */
    handleTouchCancel(e) {
        this.touchStartTime = 0;
        this.isSwiping = false;
        this.hideIndicator();
    }

    /**
     * Handle touch move - track swipe progress for visual feedback
     * Also prevents browser back/forward gestures when horizontal swipe detected
     */
    handleTouchMove(e) {
        // Skip if no start recorded or cooldown active
        if (!this.touchStartTime || this.touchCooldown) return;
        if (e.touches.length !== 1) return;

        const touch = e.touches[0];
        const deltaX = touch.clientX - this.touchStartX;
        const deltaY = touch.clientY - this.touchStartY;
        const deltaTime = Date.now() - this.touchStartTime;

        // Skip if too slow already
        if (deltaTime > this.config.touchMaxTime) {
            this.hideIndicator();
            return;
        }

        // Check if this looks like a horizontal swipe
        const absX = Math.abs(deltaX);
        const absY = Math.abs(deltaY);

        // Require some minimum movement before showing indicator
        if (absX < 20) {
            if (this.isSwiping) {
                this.hideIndicator();
                this.isSwiping = false;
            }
            return;
        }

        // Must be primarily horizontal
        if (absX < absY * this.config.touchAngleThreshold) {
            if (this.isSwiping) {
                this.hideIndicator();
                this.isSwiping = false;
            }
            return;
        }

        // Skip if in terminal or scrollable area
        if (e.target.closest('.terminal-container, .xterm')) return;
        if (this.hasHorizontalScroll(e.target)) return;

        // PREVENT browser back/forward navigation for horizontal swipes
        // This is critical for iOS Safari which interprets edge swipes as navigation
        e.preventDefault();

        // We're swiping! Show indicator
        this.isSwiping = true;
        const progress = Math.min(absX / this.config.touchThreshold, 1);
        const direction = deltaX < 0 ? 1 : -1;  // 1 = next (swipe left), -1 = prev (swipe right)
        this.updateIndicator(progress, direction);
    }

    /**
     * Create the swipe indicator element
     */
    createSwipeIndicator() {
        this.swipeIndicator = document.createElement('div');
        this.swipeIndicator.className = 'swipe-indicator';
        this.swipeIndicator.innerHTML = `
            <div class="swipe-indicator-bar"></div>
            <div class="swipe-indicator-label"></div>
        `;
        document.body.appendChild(this.swipeIndicator);
    }

    /**
     * Update indicator progress and direction
     * @param {number} progress - 0 to 1
     * @param {number} direction - 1 for next, -1 for prev
     */
    updateIndicator(progress, direction) {
        if (!this.swipeIndicator) return;

        const bar = this.swipeIndicator.querySelector('.swipe-indicator-bar');
        const label = this.swipeIndicator.querySelector('.swipe-indicator-label');

        // Show indicator
        this.swipeIndicator.classList.add('visible');

        // Set direction class
        this.swipeIndicator.classList.toggle('direction-next', direction === 1);
        this.swipeIndicator.classList.toggle('direction-prev', direction === -1);

        // Update progress (bar width)
        const percent = Math.round(progress * 100);
        bar.style.width = `${percent}%`;

        // Threshold reached state
        const thresholdReached = progress >= 1;
        this.swipeIndicator.classList.toggle('threshold-reached', thresholdReached);

        // Update label
        if (thresholdReached) {
            label.textContent = direction === 1 ? 'Next tab →' : '← Prev tab';
        } else {
            label.textContent = `${percent}%`;
        }
    }

    /**
     * Flash indicator to confirm tab switch
     */
    flashIndicator(direction) {
        if (!this.swipeIndicator) return;

        this.swipeIndicator.classList.add('visible', 'flash');
        this.swipeIndicator.classList.toggle('direction-next', direction === 1);
        this.swipeIndicator.classList.toggle('direction-prev', direction === -1);

        const bar = this.swipeIndicator.querySelector('.swipe-indicator-bar');
        bar.style.width = '100%';

        const label = this.swipeIndicator.querySelector('.swipe-indicator-label');
        label.textContent = direction === 1 ? 'Next tab →' : '← Prev tab';

        // Remove flash after animation
        setTimeout(() => {
            this.swipeIndicator.classList.remove('flash');
            this.hideIndicator();
        }, 300);
    }

    /**
     * Hide the indicator
     */
    hideIndicator() {
        if (!this.swipeIndicator) return;
        this.swipeIndicator.classList.remove('visible', 'threshold-reached', 'direction-next', 'direction-prev');

        const bar = this.swipeIndicator.querySelector('.swipe-indicator-bar');
        if (bar) bar.style.width = '0%';
    }

    /**
     * Check if element is inside a floating overlay (widget, modal, dialog)
     * These should not trigger swipe-to-switch-tab gestures
     */
    isInsideOverlay(element) {
        // Selectors for floating UI elements that should block swipe gestures
        const overlaySelectors = [
            '.widget',              // All widgets (floating, bottom-sheet, modal, sidebar)
            '.modal',               // Legacy modals
            '#modal-overlay',       // Modal overlay
            '.prompt-dialog',       // Prompt dialogs
            '.prompt-dialog-overlay',
            '.context-menu',        // Context menus
            '.tabs-overview-dropdown', // Tab overview dropdown
        ];

        return element.closest(overlaySelectors.join(', ')) !== null;
    }

    /**
     * Check if element or ancestors have horizontal scroll
     */
    hasHorizontalScroll(element) {
        let el = element;
        while (el && el !== document.body) {
            if (el.scrollWidth > el.clientWidth) {
                const style = window.getComputedStyle(el);
                const overflow = style.overflowX;
                if (overflow === 'auto' || overflow === 'scroll') {
                    return true;
                }
            }
            el = el.parentElement;
        }
        return false;
    }

    /**
     * Trigger tab switch
     */
    triggerTabSwitch(direction, source) {
        // direction: 1 = next, -1 = prev
        if (typeof this.app?.cycleTab === 'function') {
            // Temporarily suppress focus on the message input to prevent
            // iOS keyboard popup during gesture-based tab switch.
            // Covers ALL focus paths (click handlers, reconnect, rAF callbacks).
            const input = this.app.els?.messageInput;
            if (input && !input._originalFocus) {
                input._originalFocus = input.focus;
                input.focus = () => {};
                setTimeout(() => {
                    if (input._originalFocus) {
                        input.focus = input._originalFocus;
                        delete input._originalFocus;
                    }
                }, 300);
            }

            this.app.cycleTab(direction);
        }
    }

    /**
     * Setup History API trap to catch any navigation that slips through
     */
    setupHistoryTrap() {
        // Push initial state so there's something to "go back to"
        history.pushState({ gesture: true }, '', location.href);

        // Catch popstate (back/forward navigation)
        window.addEventListener('popstate', (e) => {
            // Re-push to prevent actual navigation
            history.pushState({ gesture: true }, '', location.href);

            // Note: We don't trigger tab switch here because we don't know
            // the direction of the navigation attempt. The wheel/touch handlers
            // should catch the gesture before it becomes a popstate.
        });
    }

    /**
     * Check if running in PWA standalone mode
     */
    isPWAStandalone() {
        return window.matchMedia('(display-mode: standalone)').matches ||
               window.navigator.standalone === true;
    }
}
