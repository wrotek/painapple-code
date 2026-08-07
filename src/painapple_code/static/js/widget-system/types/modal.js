/**
 * ModalWidget - Centered overlay with backdrop
 *
 * States: hidden → visible
 * Blocks interaction with content behind
 * Closes on backdrop click and Escape key
 */

import { BaseWidget } from '../base-widget.js';

export class ModalWidget extends BaseWidget {
    constructor(id, config) {
        super(id, config);

        // Modal options
        this.closeOnBackdrop = config.closeOnBackdrop !== false;
        this.closeOnEscape = config.closeOnEscape !== false;
        this.centered = config.centered !== false;

        // Size
        this.width = config.width || 'auto';
        this.maxWidth = config.maxWidth || '90vw';
        this.maxHeight = config.maxHeight || '90vh';

        // Backdrop element
        this.backdropEl = null;
    }

    init() {
        // Create backdrop first
        this.createBackdrop();

        super.init();

        // Modal-specific classes
        this.container.classList.add('widget-modal-dialog');

        // Apply size
        this.updateSize();

        // Attach keyboard handler
        this.attachKeyboardHandler();
    }

    /**
     * Create backdrop element
     */
    createBackdrop() {
        this.backdropEl = document.createElement('div');
        this.backdropEl.className = 'widget-modal-backdrop';
        this.backdropEl.dataset.widgetId = this.id;

        if (this.closeOnBackdrop) {
            this.backdropEl.addEventListener('click', () => this.close());
        }

        document.body.appendChild(this.backdropEl);
    }

    /**
     * Attach escape key handler
     */
    attachKeyboardHandler() {
        if (!this.closeOnEscape) return;

        const handler = (e) => {
            if (e.key === 'Escape' && this.isVisible) {
                e.preventDefault();
                e.stopPropagation();
                this.close();
            }
        };

        document.addEventListener('keydown', handler);
        this._escHandler = handler;
    }

    /**
     * Update modal size
     */
    updateSize() {
        if (!this.container) return;
        this.container.style.setProperty('--widget-width', this.width);
        this.container.style.setProperty('--widget-max-width', this.maxWidth);
        this.container.style.setProperty('--widget-max-height', this.maxHeight);
    }

    setState(newState) {
        super.setState(newState);

        // Update backdrop visibility
        if (this.backdropEl) {
            this.backdropEl.classList.toggle('widget-modal-backdrop-visible', this.isVisible);
        }

        // Prevent body scroll when modal is open
        document.body.classList.toggle('widget-modal-open', this.isVisible);

        // Focus trap when visible
        if (this.isVisible) {
            this.trapFocus();
        }
    }

    /**
     * Trap focus within modal
     */
    trapFocus() {
        // Find first focusable element
        const focusable = this.container.querySelectorAll(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );

        if (focusable.length > 0) {
            focusable[0].focus();
        }
    }

    open() {
        this.setState('visible');
    }

    close() {
        this.setState('hidden');
    }

    destroy() {
        // Remove escape handler
        if (this._escHandler) {
            document.removeEventListener('keydown', this._escHandler);
        }

        // Remove backdrop
        this.backdropEl?.remove();
        this.backdropEl = null;

        // Remove body class
        document.body.classList.remove('widget-modal-open');

        super.destroy();
    }

    // Modal cannot transform to other types
    canTransformTo() {
        return false;
    }
}
