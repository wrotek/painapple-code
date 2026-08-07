/**
 * Input-resize & autocomplete-trigger mixin — the draggable input-area resize
 * handle, auto-grow sizing, the highlight backdrop sync, and the @-mention /
 * snippet / slash / skill trigger helpers that open the right autocomplete.
 * Extracted from app.js; applied to App.prototype via Object.assign. Uses `this`
 * (App instance) plus the imports below.
 */
import { Storage, escapeHtml, highlightThinkingKeywords, hasThinkingKeywords } from '../utils.js';
import { ShortcutHints } from '../shortcut-hints.js';
import { DraftsPill } from '../drafts-pill.js';
import { isThinkingKeywordsHighlightingEnabled } from '../widgets/config-widget.js';

export const inputResizeMethods = {
    /**
     * Initialize resizable input area.
     * User can drag the handle at the top of the input container to increase min-height.
     */
    initInputResize() {
        const STORAGE_KEY = 'claude-input-min-height';
        const DEFAULT_MIN_HEIGHT = 24;
        const MAX_HEIGHT = 300;

        // Store min-height as instance property for reliable access
        this.inputMinHeight = Storage.get(STORAGE_KEY, DEFAULT_MIN_HEIGHT);

        // Apply saved height
        if (this.inputMinHeight > DEFAULT_MIN_HEIGHT) {
            this.els.messageInput.style.height = `${this.inputMinHeight}px`;
        }

        let isResizing = false;
        let startY = 0;
        let startHeight = 0;

        const startResize = (clientY) => {
            isResizing = true;
            startY = clientY;
            startHeight = this.els.messageInput.offsetHeight;
            this.els.inputContainer.classList.add('resizing');
            document.body.style.cursor = 'ns-resize';
            document.body.style.userSelect = 'none';
        };

        const doResize = (clientY) => {
            if (!isResizing) return;
            const delta = startY - clientY;
            const newHeight = Math.min(MAX_HEIGHT, Math.max(DEFAULT_MIN_HEIGHT, startHeight + delta));
            const prevHeight = this.els.messageInput.offsetHeight;
            this.inputMinHeight = newHeight;
            this.els.messageInput.style.height = `${newHeight}px`;

            // Compensate scroll for height change during drag
            const container = this.els.messagesContainer;
            if (container) {
                const heightDiff = newHeight - prevHeight;
                container.scrollTop += heightDiff;
            }

            // Update CSS variable for floating elements
            this.updateInputAreaHeight();
        };

        const endResize = () => {
            if (!isResizing) return;
            isResizing = false;
            this.els.inputContainer.classList.remove('resizing');
            document.body.style.cursor = '';
            document.body.style.userSelect = '';

            // Save the new min-height
            if (this.inputMinHeight > DEFAULT_MIN_HEIGHT) {
                Storage.set(STORAGE_KEY, this.inputMinHeight);
            } else {
                Storage.remove(STORAGE_KEY);
            }
        };

        // Mouse events
        this.els.inputResizeHandle.addEventListener('mousedown', (e) => {
            e.preventDefault();
            startResize(e.clientY);
        });

        document.addEventListener('mousemove', (e) => {
            if (!isResizing) return;  // Early exit for performance
            doResize(e.clientY);
        });

        document.addEventListener('mouseup', () => {
            endResize();
        });

        // Touch events (iPad)
        this.els.inputResizeHandle.addEventListener('touchstart', (e) => {
            e.preventDefault();
            const touch = e.touches[0];
            startResize(touch.clientY);
        }, { passive: false });

        document.addEventListener('touchmove', (e) => {
            if (!isResizing) return;
            const touch = e.touches[0];
            doResize(touch.clientY);
        }, { passive: true });

        document.addEventListener('touchend', () => {
            endResize();
        });

        // Double-click to reset to default
        this.els.inputResizeHandle.addEventListener('dblclick', () => {
            Storage.remove(STORAGE_KEY);
            this.inputMinHeight = DEFAULT_MIN_HEIGHT;
            this.autoResizeInput();
        });
    },

    /**
     * Auto-resize the message input textarea to fit content,
     * respecting the user's custom min-height preference.
     */
    autoResizeInput() {
        const minHeight = this.inputMinHeight || 24;
        const container = this.getActiveScrollContainer();
        const textarea = this.els.messageInput;
        const inputArea = this.els.inputArea;

        // During tab switch, restoreScrollPosition has already set scroll correctly.
        // Skip scroll manipulation to avoid race conditions.
        const skipScrollAdjust = this._switchingSession;

        // Save scroll position BEFORE any layout changes
        const prevScrollTop = container?.scrollTop || 0;
        const prevInputHeight = textarea.offsetHeight;

        // Check if user is at/near bottom before resize
        const wasAtBottom = container &&
            (container.scrollHeight - container.scrollTop - container.clientHeight < 50);

        // FIX: Lock input area height during measurement to prevent container resize flicker.
        // When we set textarea height='auto', the input area shrinks, messages container expands,
        // and scroll-behavior:smooth causes visible flickering as scroll animates.
        const inputAreaHeight = inputArea?.offsetHeight;
        if (inputArea) {
            inputArea.style.height = `${inputAreaHeight}px`;
        }

        // Calculate new height - temporarily set to auto to measure content
        textarea.style.height = 'auto';
        const contentHeight = textarea.scrollHeight;
        const newHeight = Math.max(minHeight, Math.min(contentHeight, 400));
        textarea.style.height = `${newHeight}px`;

        // Unlock input area - let it size naturally now
        if (inputArea) {
            inputArea.style.height = '';
        }

        // Adjust scroll to compensate for input height change
        // Skip during tab switch to preserve scroll position set by restoreScrollPosition
        const heightDiff = newHeight - prevInputHeight;
        if (container && !skipScrollAdjust) {
            if (heightDiff !== 0) {
                if (wasAtBottom) {
                    // Keep at bottom
                    container.scrollTop = container.scrollHeight;
                } else {
                    // Maintain relative position
                    container.scrollTop = prevScrollTop + heightDiff;
                }
            } else {
                // No height change - restore scroll position in case browser moved it
                // during the temporary height:auto state
                container.scrollTop = prevScrollTop;
            }
        }

        // Update CSS variable for floating elements (e.g., chat navigator)
        this.updateInputAreaHeight();

        // Sync shortcut-hints overlay + drafts pill visibility (empty check
        // covers programmatic value sets)
        ShortcutHints.updateVisibility(textarea.value);
        DraftsPill.updateVisibility(textarea.value);
    },

    /**
     * Update CSS variable --input-area-height for floating elements
     */
    updateInputAreaHeight() {
        const inputArea = this.els.inputArea;
        if (inputArea) {
            const height = inputArea.offsetHeight;
            document.documentElement.style.setProperty('--input-area-height', `${height}px`);
        }
    },

    /**
     * Sync the input highlight backdrop with the textarea content.
     * Shows highlighted thinking keywords (ultrathink, megathink, think hard, etc.)
     */
    syncInputHighlightBackdrop() {
        const textarea = this.els.messageInput;
        const backdrop = document.getElementById('input-highlight-backdrop');
        if (!textarea || !backdrop) return;

        const text = textarea.value;

        // Check if text contains thinking keywords (only if highlighting is enabled)
        if (isThinkingKeywordsHighlightingEnabled() && text && hasThinkingKeywords(text)) {
            // Escape HTML and apply highlighting
            const highlighted = highlightThinkingKeywords(escapeHtml(text));
            backdrop.innerHTML = highlighted;
            textarea.classList.add('has-thinking-keywords');
            // Sync scroll position so backdrop aligns with textarea when scrolled
            backdrop.scrollTop = textarea.scrollTop;
        } else {
            // No keywords or highlighting disabled - clear backdrop and show normal text
            backdrop.innerHTML = '';
            textarea.classList.remove('has-thinking-keywords');
        }
    },

    /**
     * Trigger file mention autocomplete by inserting @ at cursor position.
     * Called from the toolbar @ button, useful for mobile devices.
     */
    triggerFileMention() {
        const input = this.els.messageInput;
        const pos = input.selectionStart;
        const value = input.value;

        // Insert @ at cursor position (with space before if needed)
        const needsSpace = pos > 0 && !/\s/.test(value[pos - 1]);
        const insertText = needsSpace ? ' @' : '@';

        const before = value.slice(0, pos);
        const after = value.slice(pos);
        input.value = before + insertText + after;

        // Move cursor after @
        const newPos = pos + insertText.length;
        input.selectionStart = input.selectionEnd = newPos;
        input.focus();

        // Trigger input event to activate file autocomplete
        input.dispatchEvent(new Event('input', { bubbles: true }));
    },

    /**
     * Trigger snippets autocomplete by inserting # at cursor position.
     * Called from the toolbar # button, useful for mobile devices.
     */
    triggerSnippets() {
        const input = this.els.messageInput;
        const pos = input.selectionStart;
        const value = input.value;

        const needsSpace = pos > 0 && !/\s/.test(value[pos - 1]);
        const insertText = needsSpace ? ' #' : '#';

        const before = value.slice(0, pos);
        const after = value.slice(pos);
        input.value = before + insertText + after;

        const newPos = pos + insertText.length;
        input.selectionStart = input.selectionEnd = newPos;
        input.focus();

        input.dispatchEvent(new Event('input', { bubbles: true }));
    },

    /**
     * Trigger slash command autocomplete by inserting / at cursor position.
     * Called from the toolbar / button, useful for mobile devices.
     */
    triggerSlashCommand() {
        const input = this.els.messageInput;
        const pos = input.selectionStart;
        const value = input.value;

        // Insert / at cursor position (with space before if needed)
        const needsSpace = pos > 0 && !/\s/.test(value[pos - 1]);
        const insertText = needsSpace ? ' /' : '/';

        const before = value.slice(0, pos);
        const after = value.slice(pos);
        input.value = before + insertText + after;

        // Move cursor after /
        const newPos = pos + insertText.length;
        input.selectionStart = input.selectionEnd = newPos;
        input.focus();

        // Trigger input event to activate command autocomplete
        input.dispatchEvent(new Event('input', { bubbles: true }));
    },

    triggerSkills() {
        const input = this.els.messageInput;
        const pos = input.selectionStart;
        const value = input.value;

        const needsSpace = pos > 0 && !/\s/.test(value[pos - 1]);
        const insertText = needsSpace ? ' $' : '$';

        input.value = value.slice(0, pos) + insertText + value.slice(pos);
        const newPos = pos + insertText.length;
        input.selectionStart = input.selectionEnd = newPos;
        input.focus();
        input.dispatchEvent(new Event('input', { bubbles: true }));
    },
};
