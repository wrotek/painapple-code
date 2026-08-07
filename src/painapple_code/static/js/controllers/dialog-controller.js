/**
 * DialogController - Handles modals, dialogs, and confirmations
 *
 * Manages: help modal, save-as dialog, directory creation dialog
 */

import { CONFIG } from '../config.js';
import { extractApiError } from '../utils.js';

export class DialogController {
    constructor(ctx) {
        this.ctx = ctx;
        this._saveAsTab = null;
        this.pendingCwd = null;
    }

    // ═══════════════════════════════════════════════════════════════
    // HELP MODAL
    // ═══════════════════════════════════════════════════════════════

    showHelp() {
        // Render dynamic help content from shortcut registry
        if (this.ctx.els.modalBody && this.ctx.shortcutManager) {
            this.ctx.els.modalBody.innerHTML = this.ctx.shortcutManager.renderHelp();
        }
        this.ctx.els.modalOverlay.classList.add('visible');
    }

    hideModal() {
        this.ctx.els.modalOverlay.classList.remove('visible');
    }


    // ═══════════════════════════════════════════════════════════════
    // CONFIRM DIALOG (for creating new directories)
    // ═══════════════════════════════════════════════════════════════

    showConfirmDialog(path) {
        this.ctx.els.confirmPath.textContent = path;
        this.ctx.els.confirmDialog.classList.add('visible');
        // Focus the create button so Enter works
        this.ctx.els.confirmCreate.focus();
        this.pendingCwd = path;
    }

    hideConfirmDialog() {
        this.ctx.els.confirmDialog.classList.remove('visible');
        this.pendingCwd = null;
    }

    async createDirectoryAndConnect() {
        if (!this.pendingCwd) return;

        try {
            const response = await fetch(
                `${CONFIG.API_BASE}/api/mkdir`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path: this.pendingCwd }),
                }
            );
            const data = await response.json();

            if (response.ok) {
                this.hideConfirmDialog();
                // Use the resolved path from the server (expands ~ and resolves)
                const resolvedPath = data.path || this.pendingCwd;

                // Emit event for app to handle the connection
                this.ctx.emit('directoryCreated', {
                    path: resolvedPath,
                    originalPath: this.pendingCwd
                });
            } else {
                this.ctx.session?.addSystemLog(
                    `Failed to create directory: ${extractApiError(data, `HTTP ${response.status}`)}`);
                this.hideConfirmDialog();
            }
        } catch (error) {
            console.error('Error creating directory:', error);
            this.ctx.session?.addSystemLog(`Failed to create directory: ${error.message}`);
            this.hideConfirmDialog();
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // SETTINGS DIALOG
    // ═══════════════════════════════════════════════════════════════

    showSettings() {
        // Emit event for config panel to show
        this.ctx.emit('showSettings');
    }

    // ═══════════════════════════════════════════════════════════════
    // GENERIC PROMPT DIALOG
    // ═══════════════════════════════════════════════════════════════

    /**
     * Show a themed input prompt dialog
     * @param {Object} options - Prompt options
     * @param {string} options.title - Dialog title
     * @param {string} options.label - Input label
     * @param {string} options.value - Initial value
     * @param {string} options.placeholder - Input placeholder
     * @param {string} options.confirmText - Confirm button text (default: "OK")
     * @param {string} options.cancelText - Cancel button text (default: "Cancel")
     * @returns {Promise<string|null>} - Input value or null if cancelled
     */
    showPrompt(options = {}) {
        return new Promise((resolve) => {
            const {
                title = 'Input',
                label = '',
                value = '',
                placeholder = '',
                confirmText = 'OK',
                cancelText = 'Cancel'
            } = options;

            // Create overlay
            const overlay = document.createElement('div');
            overlay.className = 'prompt-dialog-overlay';

            // Create dialog
            const dialog = document.createElement('div');
            dialog.className = 'prompt-dialog';
            dialog.innerHTML = `
                <div class="prompt-dialog-title">${this._escapeHtml(title)}</div>
                ${label ? `<label class="prompt-dialog-label">${this._escapeHtml(label)}</label>` : ''}
                <input type="text" class="prompt-dialog-input"
                       value="${this._escapeHtml(value)}"
                       placeholder="${this._escapeHtml(placeholder)}"
                       autocomplete="off">
                <div class="prompt-dialog-buttons">
                    <button class="prompt-dialog-btn cancel">${this._escapeHtml(cancelText)}</button>
                    <button class="prompt-dialog-btn confirm">${this._escapeHtml(confirmText)}</button>
                </div>
            `;

            overlay.appendChild(dialog);
            document.body.appendChild(overlay);

            const input = dialog.querySelector('.prompt-dialog-input');
            const confirmBtn = dialog.querySelector('.prompt-dialog-btn.confirm');
            const cancelBtn = dialog.querySelector('.prompt-dialog-btn.cancel');

            const cleanup = (result) => {
                overlay.remove();
                resolve(result);
            };

            // Focus and select input
            requestAnimationFrame(() => {
                input.focus();
                input.select();
            });

            // Event handlers
            confirmBtn.addEventListener('click', () => cleanup(input.value));
            cancelBtn.addEventListener('click', () => cleanup(null));

            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    cleanup(input.value);
                } else if (e.key === 'Escape') {
                    e.preventDefault();
                    cleanup(null);
                }
            });

            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) cleanup(null);
            });
        });
    }

    /**
     * Simple HTML escape helper
     */
    _escapeHtml(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }
}
