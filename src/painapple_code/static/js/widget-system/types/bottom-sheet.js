/**
 * BottomSheetWidget - Slides up from bottom
 *
 * States: collapsed → half → full
 * Heights configurable via config.heights
 * Touch gestures: drag handle to resize, swipe to snap
 *
 * Enhanced gestures:
 * - Velocity-based swipe detection (fast swipe down = close)
 * - Tap anywhere on header to close (optional)
 * - More forgiving collapse threshold
 */

import { BaseWidget } from '../base-widget.js';

export class BottomSheetWidget extends BaseWidget {
    constructor(id, config) {
        super(id, config);

        // Default heights
        this.heights = config.heights || {
            half: '45vh',
            full: '85vh'
        };

        // Gesture state
        this.dragStartY = 0;
        this.dragStartHeight = 0;

        // Velocity tracking
        this._velocityTracker = {
            points: [],
            maxAge: 100 // ms - only consider recent points for velocity
        };
    }

    init() {
        super.init();
        this.attachGestures();
        this.updateHeight();

        // Create backdrop if configured
        if (this.config.showBackdrop !== false) {
            this._createBackdrop();
        }
    }

    /**
     * Create tappable backdrop element
     */
    _createBackdrop() {
        this._backdrop = document.createElement('div');
        this._backdrop.className = 'widget-bottom-sheet-backdrop';
        this._backdrop.dataset.forWidget = this.id;

        // Tap backdrop to close
        this._backdrop.addEventListener('click', () => {
            this.close();
        });

        // Insert backdrop before the widget container
        this.container.parentNode?.insertBefore(this._backdrop, this.container);
    }

    /**
     * Update backdrop visibility based on state
     */
    _updateBackdrop() {
        if (!this._backdrop) return;

        if (this.state === 'collapsed' || this.state === 'hidden') {
            this._backdrop.classList.remove('visible');
        } else {
            this._backdrop.classList.add('visible');
        }
    }

    /**
     * Track velocity by recording y positions over time
     */
    _trackVelocity(y) {
        const now = Date.now();
        this._velocityTracker.points.push({ y, time: now });

        // Prune old points
        this._velocityTracker.points = this._velocityTracker.points.filter(
            p => now - p.time < this._velocityTracker.maxAge
        );
    }

    /**
     * Calculate current velocity (pixels per ms)
     * Positive = moving down, negative = moving up
     */
    _calculateVelocity() {
        const points = this._velocityTracker.points;
        if (points.length < 2) return 0;

        const first = points[0];
        const last = points[points.length - 1];
        const timeDiff = last.time - first.time;

        if (timeDiff === 0) return 0;
        return (last.y - first.y) / timeDiff;
    }

    /**
     * Attach touch/mouse gestures for dragging
     */
    attachGestures() {
        const handle = this.container.querySelector('.widget-drag-handle');
        const header = this.container.querySelector('.widget-header');

        // Allow dragging from both handle and header
        const dragTargets = [handle, header].filter(Boolean);
        if (dragTargets.length === 0) return;

        const onStart = (e) => {
            // Don't start drag if clicking a button
            if (e.target.closest('button')) return;

            e.preventDefault();
            this.isDragging = true;
            this.dragStartY = e.touches?.[0]?.clientY ?? e.clientY;
            this.dragStartHeight = this.container.offsetHeight;
            this._dragStartTime = Date.now();

            // Reset velocity tracker
            this._velocityTracker.points = [];
            this._trackVelocity(this.dragStartY);

            this.container.classList.add('widget-dragging');
            document.addEventListener('mousemove', onMove, { passive: false });
            document.addEventListener('mouseup', onEnd);
            document.addEventListener('touchmove', onMove, { passive: false });
            document.addEventListener('touchend', onEnd);
            document.addEventListener('touchcancel', onEnd);
        };

        const onMove = (e) => {
            if (!this.isDragging) return;
            e.preventDefault();

            const currentY = e.touches?.[0]?.clientY ?? e.clientY;
            this._trackVelocity(currentY);

            const delta = this.dragStartY - currentY;
            const newHeight = Math.max(0, this.dragStartHeight + delta);

            this.container.style.height = `${newHeight}px`;
            this.container.style.transition = 'none';
        };

        const onEnd = (e) => {
            if (!this.isDragging) return;
            this.isDragging = false;

            const endY = e.changedTouches?.[0]?.clientY ?? e.clientY;
            this._trackVelocity(endY);

            const velocity = this._calculateVelocity();
            const dragDuration = Date.now() - this._dragStartTime;
            const dragDistance = endY - this.dragStartY;

            this.container.classList.remove('widget-dragging');
            this.container.style.transition = '';

            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onEnd);
            document.removeEventListener('touchmove', onMove);
            document.removeEventListener('touchend', onEnd);
            document.removeEventListener('touchcancel', onEnd);

            // Snap to nearest state, considering velocity
            this.snapToNearestState(velocity, dragDistance, dragDuration);
        };

        // Attach to all drag targets
        dragTargets.forEach(target => {
            target.addEventListener('mousedown', onStart);
            target.addEventListener('touchstart', onStart, { passive: false });
        });

        // Store for cleanup
        this._gestureHandlers = { onStart, onMove, onEnd, dragTargets };
    }

    /**
     * Snap to nearest state based on current height and swipe velocity
     *
     * @param {number} velocity - Swipe velocity in px/ms (positive = down, negative = up)
     * @param {number} dragDistance - Total drag distance (positive = down)
     * @param {number} dragDuration - How long the drag lasted in ms
     */
    snapToNearestState(velocity = 0, dragDistance = 0, dragDuration = 0) {
        const height = this.container.offsetHeight;
        const viewportHeight = window.innerHeight;

        // Parse height values
        const halfHeight = this.parseHeight(this.heights.half, viewportHeight);
        const fullHeight = this.parseHeight(this.heights.full, viewportHeight);

        // Velocity thresholds (px/ms)
        const FAST_SWIPE_VELOCITY = 0.5;  // Fast swipe threshold
        const QUICK_SWIPE_VELOCITY = 0.3; // Quick swipe threshold

        // Check for velocity-based dismissal
        // Fast swipe down = close, regardless of position
        if (velocity > FAST_SWIPE_VELOCITY && dragDistance > 30) {
            this.setState('collapsed');
            this.container.style.height = '';
            this.updateHeight();
            return;
        }

        // Quick swipe down when already at half height = close
        if (velocity > QUICK_SWIPE_VELOCITY && dragDistance > 50 && this.state !== 'full') {
            this.setState('collapsed');
            this.container.style.height = '';
            this.updateHeight();
            return;
        }

        // Quick swipe up = expand to full
        if (velocity < -QUICK_SWIPE_VELOCITY && dragDistance < -30) {
            this.setState('full');
            this.container.style.height = '';
            this.updateHeight();
            return;
        }

        // Position-based thresholds (more forgiving than before)
        // Collapse if dragged below 40% of half height (was 30%)
        const collapseThreshold = halfHeight * 0.4;
        // Go full if past 60% between half and full
        const fullThreshold = halfHeight + (fullHeight - halfHeight) * 0.4;

        if (height < collapseThreshold) {
            this.setState('collapsed');
        } else if (height > fullThreshold) {
            this.setState('full');
        } else {
            this.setState('half');
        }

        // Reset inline height (CSS will handle it)
        this.container.style.height = '';
        this.updateHeight();
    }

    /**
     * Parse height value (e.g., '45vh', '300px')
     */
    parseHeight(value, viewportHeight) {
        if (typeof value === 'number') return value;
        if (value.endsWith('vh')) {
            return (parseFloat(value) / 100) * viewportHeight;
        }
        if (value.endsWith('px')) {
            return parseFloat(value);
        }
        if (value.endsWith('%')) {
            return (parseFloat(value) / 100) * viewportHeight;
        }
        return parseFloat(value);
    }

    /**
     * Update container height based on state
     */
    updateHeight() {
        if (!this.container) return;

        if (this.state === 'collapsed') {
            this.container.style.setProperty('--widget-height', '0');
        } else if (this.state === 'half') {
            this.container.style.setProperty('--widget-height', this.heights.half);
        } else if (this.state === 'full') {
            this.container.style.setProperty('--widget-height', this.heights.full);
        }
    }

    setState(newState) {
        super.setState(newState);
        this.updateHeight();
        this._updateBackdrop();
    }

    updateStateClass() {
        super.updateStateClass();
        this.updateHeight();
    }

    destroy() {
        // Clean up gesture handlers
        if (this._gestureHandlers) {
            const { dragTargets, onStart } = this._gestureHandlers;
            dragTargets?.forEach(target => {
                target?.removeEventListener('mousedown', onStart);
                target?.removeEventListener('touchstart', onStart);
            });
        }
        // Clean up backdrop
        this._backdrop?.remove();
        super.destroy();
    }
}
