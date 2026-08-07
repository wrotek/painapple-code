/**
 * TopSheetWidget - Slides down from top
 *
 * States: collapsed → half → full
 * Heights configurable via config.heights
 * Touch gestures: drag handle to resize, swipe to snap
 *
 * Use this instead of bottom-sheet when keyboard would conflict (e.g., iOS comment input)
 */

import { BaseWidget } from '../base-widget.js';

export class TopSheetWidget extends BaseWidget {
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
    }

    init() {
        super.init();

        // Move drag handle from header to bottom of widget container
        const handle = this.container.querySelector('.widget-drag-handle');
        if (handle) {
            handle.remove();
            this.container.appendChild(handle);
        }

        this.attachGestures();
        this.updateHeight();
    }

    /**
     * Attach touch/mouse gestures for dragging
     */
    attachGestures() {
        // Drag from the bottom handle only (moved outside header in init)
        const handle = this.container.querySelector('.widget-drag-handle');
        if (!handle) return;
        const dragTargets = [handle];

        const onStart = (e) => {
            // Don't start drag if clicking a button
            if (e.target.closest('button')) return;

            e.preventDefault();
            this.isDragging = true;
            this.dragStartY = e.touches?.[0]?.clientY ?? e.clientY;
            this.dragStartHeight = this.container.offsetHeight;

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
            // Drag DOWN to expand (positive delta = increase height)
            const delta = currentY - this.dragStartY;
            const newHeight = Math.max(0, this.dragStartHeight + delta);

            this.container.style.height = `${newHeight}px`;
            this.container.style.transition = 'none';
        };

        const onEnd = () => {
            if (!this.isDragging) return;
            this.isDragging = false;

            this.container.classList.remove('widget-dragging');
            this.container.style.transition = '';

            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onEnd);
            document.removeEventListener('touchmove', onMove);
            document.removeEventListener('touchend', onEnd);
            document.removeEventListener('touchcancel', onEnd);

            // Snap to nearest state
            this.snapToNearestState();
        };

        // Double-tap/double-click on handle closes the widget
        let lastTapTime = 0;
        const onDoubleTap = (e) => {
            const now = Date.now();
            if (now - lastTapTime < 350) {
                e.preventDefault();
                this.setState('collapsed');
                this.container.style.height = '';
            }
            lastTapTime = now;
        };

        // Attach to all drag targets
        dragTargets.forEach(target => {
            target.addEventListener('mousedown', onStart);
            target.addEventListener('touchstart', onStart, { passive: false });
            target.addEventListener('dblclick', onDoubleTap);
            target.addEventListener('touchend', onDoubleTap);
        });

        // Store for cleanup
        this._gestureHandlers = { onStart, onMove, onEnd, onDoubleTap, dragTargets };
    }

    /**
     * Snap or keep free-form height after drag ends.
     * Only snaps to "collapsed" when below threshold; otherwise keeps
     * the exact pixel height the user dragged to (like legacy terminal.js).
     */
    snapToNearestState() {
        const height = this.container.offsetHeight;
        const viewportHeight = window.innerHeight;
        const halfHeight = this.parseHeight(this.heights.half, viewportHeight);
        const collapseThreshold = halfHeight * 0.3;

        if (height < collapseThreshold) {
            // Snap to close
            this.container.style.height = '';
            this.setState('collapsed');
        } else {
            // Free-form: keep the dragged pixel height
            const px = `${height}px`;
            // Set state for CSS class (visibility/shadow) but preserve height
            const logicalState = height > viewportHeight * 0.6 ? 'full' : 'half';
            super.setState(logicalState);   // skip our override that calls updateHeight
            this.container.style.setProperty('--widget-height', px);
            this.updateStateClass();
        }
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
    }

    updateStateClass() {
        super.updateStateClass();
        this.updateHeight();
    }

    destroy() {
        // Clean up gesture handlers
        if (this._gestureHandlers) {
            const { dragTargets, onStart, onDoubleTap } = this._gestureHandlers;
            dragTargets?.forEach(target => {
                target?.removeEventListener('mousedown', onStart);
                target?.removeEventListener('touchstart', onStart);
                target?.removeEventListener('dblclick', onDoubleTap);
                target?.removeEventListener('touchend', onDoubleTap);
            });
        }
        super.destroy();
    }
}
