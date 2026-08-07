/**
 * SidebarWidget - Slides in from left or right edge
 *
 * States: collapsed → open
 * Width configurable, resizable edge
 */

import { BaseWidget } from '../base-widget.js';

export class SidebarWidget extends BaseWidget {
    constructor(id, config) {
        super(id, config);

        // Sidebar position (left or right)
        this.side = config.type === 'sidebar-right' ? 'right' : 'left';

        // Width settings
        this.width = config.width || '280px';
        this.minWidth = config.minWidth || '200px';
        this.maxWidth = config.maxWidth || '50vw';

        // Overlay mode vs push mode
        this.overlay = config.overlay ?? true;

        // Resize state
        this.isResizing = false;
        this.resizeStartX = 0;
        this.resizeStartWidth = 0;
    }

    init() {
        super.init();

        // Add side class
        this.container.classList.add(`widget-sidebar-${this.side}`);

        // Create resize handle
        if (this.config.resizable !== false) {
            this.createResizeHandle();
        }

        this.updateWidth();
    }

    /**
     * Create resize handle on the edge
     */
    createResizeHandle() {
        const handle = document.createElement('div');
        handle.className = `widget-resize-handle widget-resize-${this.side === 'left' ? 'right' : 'left'}`;

        const onStart = (e) => {
            e.preventDefault();
            this.isResizing = true;
            this.resizeStartX = e.touches?.[0]?.clientX ?? e.clientX;
            this.resizeStartWidth = this.container.offsetWidth;

            this.container.classList.add('widget-resizing');
            document.addEventListener('mousemove', onMove, { passive: false });
            document.addEventListener('mouseup', onEnd);
            document.addEventListener('touchmove', onMove, { passive: false });
            document.addEventListener('touchend', onEnd);
            document.addEventListener('touchcancel', onEnd);
        };

        const onMove = (e) => {
            if (!this.isResizing) return;
            e.preventDefault();

            const currentX = e.touches?.[0]?.clientX ?? e.clientX;
            const delta = this.side === 'left'
                ? currentX - this.resizeStartX
                : this.resizeStartX - currentX;

            const newWidth = Math.max(
                this.parseWidth(this.minWidth),
                Math.min(
                    this.parseWidth(this.maxWidth),
                    this.resizeStartWidth + delta
                )
            );

            this.container.style.width = `${newWidth}px`;
            this.container.style.transition = 'none';
        };

        const onEnd = () => {
            if (!this.isResizing) return;
            this.isResizing = false;

            this.container.classList.remove('widget-resizing');
            this.container.style.transition = '';

            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onEnd);
            document.removeEventListener('touchmove', onMove);
            document.removeEventListener('touchend', onEnd);
            document.removeEventListener('touchcancel', onEnd);

            // Save new width
            this.width = `${this.container.offsetWidth}px`;
            this.config.onResize?.(this.getDimensions());
        };

        handle.addEventListener('mousedown', onStart);
        handle.addEventListener('touchstart', onStart, { passive: false });

        this.container.appendChild(handle);
        this._resizeHandler = { handle, onStart };
    }

    /**
     * Parse width value
     */
    parseWidth(value) {
        if (typeof value === 'number') return value;
        if (value.endsWith('vw')) {
            return (parseFloat(value) / 100) * window.innerWidth;
        }
        if (value.endsWith('px')) {
            return parseFloat(value);
        }
        if (value.endsWith('%')) {
            return (parseFloat(value) / 100) * window.innerWidth;
        }
        return parseFloat(value);
    }

    /**
     * Update container width
     */
    updateWidth() {
        if (!this.container) return;
        this.container.style.setProperty('--widget-width', this.width);
    }

    open() {
        this.setState('open');
    }

    close() {
        this.setState('collapsed');
    }

    setState(newState) {
        super.setState(newState);
        this.updateWidth();
    }

    destroy() {
        if (this._resizeHandler) {
            const { handle, onStart } = this._resizeHandler;
            handle?.removeEventListener('mousedown', onStart);
            handle?.removeEventListener('touchstart', onStart);
        }
        super.destroy();
    }
}
