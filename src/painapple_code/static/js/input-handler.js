/**
 * Input Handler Module
 * Manages message input, history navigation, drafts, and autocomplete integration
 */

import { Storage, escapeHtml, escapeAttr } from './utils.js';
import { CONFIG } from './config.js';
import { Stash } from './stash.js';
import { ShortcutHints } from './shortcut-hints.js';
import { DraftsPill } from './drafts-pill.js';
import { showToast } from './context-menu.js';
import { renderStashRefs } from './stash-refs-view.js';
import S from './strings.js';

// Auto-sync of in-progress input to a server-side draft (/api/drafts):
// idle time before the input is mirrored, and the minimum length before a
// draft is created at all (below it, throwaway fragments like "ok" would
// pollute the Drafts list; the localStorage auto-draft still covers them)
const AUTO_DRAFT_SYNC_MS = 2500;
const AUTO_DRAFT_MIN_CHARS = 12;

// Cap on session.promptHistory (oldest entries fall off the end)
const PROMPT_HISTORY_LIMIT = 50;

// A prompt-history entry is `{ text, stashRefs }` — the typed text plus the
// compact stash references that rode along with it, so recall can tell the
// user what was actually sent. Entries with empty text are legitimate: a
// stash-only send is a real prompt with no words in it. Plain strings are
// still accepted on read (older in-memory sessions, forks made before the
// object shape landed) so navigation never breaks on a legacy array.
export function historyEntryText(entry) {
    return typeof entry === 'string' ? entry : (entry?.text ?? '');
}

export function historyEntryRefs(entry) {
    const refs = typeof entry === 'string' ? null : entry?.stashRefs;
    return Array.isArray(refs) && refs.length > 0 ? refs : null;
}

// Tab-cycle: order matches the input toolbar (#, /, @, $).
// Tab in the input rotates through these trigger pickers without pre-selecting
// any entry, so the user can browse what each picker offers and arrow-down to commit.
const TAB_CYCLE_TRIGGERS = [
    { char: '#', popup: 'snippets', btnId: 'snippets-btn' },
    { char: '/', popup: 'slash',     btnId: 'slash-cmd-btn' },
    { char: '@', popup: 'file',      btnId: 'file-mention-btn' },
    { char: '$', popup: 'skills',    btnId: 'skills-btn' },
];

/**
 * InputHandler - Manage message input with history and drafts
 */
export class InputHandler {
    /**
     * @param {Object} elements - DOM elements
     * @param {HTMLTextAreaElement} elements.messageInput - The message input
     * @param {HTMLButtonElement} elements.sendBtn - Send button
     * @param {HTMLButtonElement} elements.followupBtn - Follow-up button (visible while working; mirrors send disabled state)
     * @param {Object} options - Configuration
     * @param {boolean} options.hasPhysicalKeyboard - Whether device has keyboard
     * @param {Object} callbacks - Callbacks
     * @param {Function} callbacks.getSession - Returns active session
     * @param {Function} callbacks.getAutocomplete - Returns autocomplete instance
     * @param {Function} callbacks.getFileAutocomplete - Returns file autocomplete instance
     * @param {Function} callbacks.getSnippetsAutocomplete - Returns snippets autocomplete instance
     * @param {Function} callbacks.getSkillsAutocomplete - Returns skills autocomplete instance ($ trigger)
     * @param {Function} callbacks.getPendingImages - Returns pending images array
     * @param {Function} callbacks.onSendMessage - Called to send a message
     * @param {Function} callbacks.onSlashCommand - Called for slash commands
     * @param {Function} callbacks.onBangCommand - Called for bang commands
     * @param {Function} callbacks.onConnect - Called to connect session
     * @param {Function} callbacks.onAutoResize - Called to resize input
     * @param {Function} callbacks.onUpdateSendButton - Called to update send button state
     * @param {Function} callbacks.onPreviewFile - Called to preview a file (Cmd+Enter)
     */
    constructor(elements, options = {}, callbacks = {}) {
        this.els = elements;
        this.hasPhysicalKeyboard = options.hasPhysicalKeyboard ?? true;

        // Callbacks
        this.getSession = callbacks.getSession || (() => null);
        this.getAutocomplete = callbacks.getAutocomplete || (() => null);
        this.getFileAutocomplete = callbacks.getFileAutocomplete || (() => null);
        this.getSnippetsAutocomplete = callbacks.getSnippetsAutocomplete || (() => null);
        this.getSkillsAutocomplete = callbacks.getSkillsAutocomplete || (() => null);
        this.getCwd = callbacks.getCwd || (() => window.app?.activeSession?.cwd || null);
        this.getPendingImages = callbacks.getPendingImages || (() => []);
        this.onSendMessage = callbacks.onSendMessage || (() => {});
        this.onSlashCommand = callbacks.onSlashCommand || (() => {});
        this.onBangCommand = callbacks.onBangCommand || (() => {});
        this.onPlanComposeChange = callbacks.onPlanComposeChange || (() => {});
        this.onConnect = callbacks.onConnect || (() => {});
        this.onAutoResize = callbacks.onAutoResize || (() => {});
        this.onUpdateSendButton = callbacks.onUpdateSendButton || (() => {});
        this.onPreviewFile = callbacks.onPreviewFile || (() => {});
        this.onSendInNewSession = callbacks.onSendInNewSession || (() => {});
        this.isWelcomeMode = callbacks.isWelcomeMode || (() => false);

        // State
        this.historyIndex = -1;
        this.historyDraft = '';

        // Input mode: null, 'shell' (! bang commands), or 'plan' (/plan prompt)
        this.inputMode = null;

        // Id of the server-side draft mirroring the current input — set by
        // the auto-sync once it creates one, or by Prompt Explorer → Drafts
        // → Use. Sending consumes (deletes) it; clearing the input abandons
        // it (draft survives, unlinked).
        this.pendingDraftId = null;

        // Auto-sync state (see _syncDraftToServer): debounce timer,
        // single-flight promise, re-run flag, and a consume epoch that
        // invalidates in-flight creates when the input gets sent meanwhile
        this._draftSyncTimer = null;
        this._draftSyncInflight = null;
        this._draftSyncQueued = false;
        this._draftConsumeEpoch = 0;

        // Debounce timers for autocompletes
        this._fileDebounceTimer = null;
        this._snippetsDebounceTimer = null;
        this._skillsDebounceTimer = null;

        // Tab-cycle state: { trigger, insertStart, insertEnd } or null
        this._tabCycle = null;

        // Bind event listeners
        this._bindEvents();
    }

    /**
     * Bind input event listeners
     */
    _bindEvents() {
        this.els.messageInput.addEventListener('input', (e) => this._onInputChange(e));
        this.els.messageInput.addEventListener('keydown', (e) => this._onInputKeydown(e));
        // Seed hint/pill visibility on init (empty textarea → show hints)
        ShortcutHints.updateVisibility(this.els.messageInput.value);
        DraftsPill.updateVisibility(this.els.messageInput.value);
    }

    /**
     * Handle input changes
     */
    _onInputChange(e) {
        let value = e.target.value;
        const cursorPos = this.els.messageInput.selectionStart;

        // Sync hint overlay + drafts pill visibility (hidden with any content)
        ShortcutHints.updateVisibility(value);
        DraftsPill.updateVisibility(value);

        // Input mode detection: shell (!) and plan (/plan )
        const wasMode = this.inputMode;
        if (value.startsWith('!')) {
            this.inputMode = 'shell';
            value = value.slice(1);
            this.els.messageInput.value = value;
            this.els.messageInput.selectionStart = Math.max(0, cursorPos - 1);
            this.els.messageInput.selectionEnd = Math.max(0, cursorPos - 1);
        } else if (!this.inputMode && value.startsWith('/plan ')) {
            this.inputMode = 'plan';
            value = value.slice(6); // strip '/plan '
            this.els.messageInput.value = value;
            const newCursor = Math.max(0, cursorPos - 6);
            this.els.messageInput.selectionStart = newCursor;
            this.els.messageInput.selectionEnd = newCursor;
        }

        // Mode exit is intentionally Backspace-on-empty-only (handled in
        // _onInputKeydown). Don't auto-exit just because the value happens to
        // be empty here — Cmd+A→Backspace would clear the value via the input
        // event, and auto-exiting would yank the user out of plan/shell mode
        // after a single edit. The user must press Backspace on already-empty
        // input to exit deliberately.

        // Notify on entering/leaving the /plan compose box so the permission UI
        // can flip to plan (and back). The subprocess restart is deferred to send.
        this._notifyPlanComposeChange(wasMode);

        // Apply mode classes and placeholder
        this._applyInputMode();

        // Exit history mode on any text change (user is editing)
        if (this.historyIndex !== -1) {
            this.historyIndex = -1;
            this.historyDraft = '';
            this._renderHistoryRefsHint(null);
        }

        // Enable/disable send button (considers images too)
        this.onUpdateSendButton();

        // Save draft to localStorage (survives page refresh)
        // Don't save bare prefix — mode with no content is not a useful draft
        const draft = this._encodeDraftText();
        this.saveDraft(draft);

        // Mirror the input to a server-side draft (debounced upsert) so
        // typed-but-unsent prompts survive tab loss and are browsable in
        // Prompt Explorer → Drafts from any device
        if (draft.trim()) this._scheduleDraftSync();
        else this._cancelDraftSyncTimer();

        // Emptying the input abandons the linked draft — it survives
        // server-side (browsable in Drafts), but a later, unrelated send
        // must not consume (delete) it. clearDraft() above already dropped
        // the persisted link.
        if (this.pendingDraftId && !value.trim()) {
            this.pendingDraftId = null;
        }

        // Autocomplete for slash and bang commands
        // Slash only triggers at the very start of input (no mid-text).
        // Use the `$` picker for inserting skills mid-prompt.
        const autocomplete = this.getAutocomplete();
        if (autocomplete) {
            if (value.startsWith('/') && !this.inputMode) {
                autocomplete.show('slash', value.slice(1), 0);
            } else if (this.inputMode === 'shell') {
                autocomplete.show('bang', value, 0);
            } else {
                autocomplete.hide();
            }
        }

        // File autocomplete on @
        this._handleFileAutocomplete(value, cursorPos);

        // Favorites autocomplete on #
        this._handleSnippetsAutocomplete(value, cursorPos);

        // Skills autocomplete on $
        this._handleSkillsAutocomplete(value, cursorPos);
    }

    /**
     * Handle $ skills autocomplete trigger
     */
    _handleSkillsAutocomplete(value, cursorPos) {
        const skillsAutocomplete = this.getSkillsAutocomplete();
        if (!skillsAutocomplete) return;

        const beforeCursor = value.slice(0, cursorPos);
        const triggerMatch = beforeCursor.match(/(?:^|[\s])\$([^\s$]*)$/);

        if (triggerMatch) {
            const query = triggerMatch[1];
            const triggerIndex = cursorPos - query.length - 1;
            clearTimeout(this._skillsDebounceTimer);
            this._skillsDebounceTimer = setTimeout(() => {
                skillsAutocomplete.show(query, triggerIndex, this.getCwd());
            }, query ? 50 : 0);
        } else {
            skillsAutocomplete.hide();
        }
    }

    /**
     * Handle @ file autocomplete trigger
     */
    _handleFileAutocomplete(value, cursorPos) {
        const fileAutocomplete = this.getFileAutocomplete();
        if (!fileAutocomplete) return;

        // Look for @ before cursor
        const beforeCursor = value.slice(0, cursorPos);

        // Find the last @ that could be a trigger
        // Valid trigger: @ at start, or @ after whitespace
        // Invalid: email-like patterns (user@example)
        const atMatch = beforeCursor.match(/(?:^|[\s])@([^\s@]*)$/);

        if (atMatch) {
            const query = atMatch[1];
            const atIndex = beforeCursor.lastIndexOf('@');

            // Don't trigger if it looks like an email (has text before @)
            if (atIndex > 0) {
                const charBefore = beforeCursor[atIndex - 1];
                if (charBefore && !/\s/.test(charBefore)) {
                    // Check if this looks like an email
                    const wordBefore = beforeCursor.slice(0, atIndex).match(/\S+$/);
                    if (wordBefore && /^[a-zA-Z0-9._-]+$/.test(wordBefore[0])) {
                        fileAutocomplete.hide();
                        return;
                    }
                }
            }

            // Debounce for performance
            clearTimeout(this._fileDebounceTimer);
            this._fileDebounceTimer = setTimeout(() => {
                fileAutocomplete.show(query, atIndex);
            }, query ? 100 : 0);  // Immediate for empty query, debounced for typing
        } else {
            fileAutocomplete.hide();
        }
    }

    /**
     * Handle # snippets autocomplete trigger
     */
    _handleSnippetsAutocomplete(value, cursorPos) {
        const snippetsAutocomplete = this.getSnippetsAutocomplete();
        if (!snippetsAutocomplete) return;

        const beforeCursor = value.slice(0, cursorPos);
        const hashMatch = beforeCursor.match(/(?:^|[\s])#([^\s#]*)$/);

        if (hashMatch) {
            const query = hashMatch[1];
            const hashIndex = beforeCursor.lastIndexOf('#');

            if (hashIndex === 0 || (hashIndex > 0 && /\s/.test(beforeCursor[hashIndex - 1]))) {
                clearTimeout(this._snippetsDebounceTimer);
                this._snippetsDebounceTimer = setTimeout(() => {
                    snippetsAutocomplete.show(query, hashIndex);
                }, query ? 50 : 0);
            } else {
                snippetsAutocomplete.hide();
            }
        } else {
            snippetsAutocomplete.hide();
        }
    }

    /**
     * Handle keydown events
     */
    _onInputKeydown(e) {
        const autocomplete = this.getAutocomplete();
        const fileAutocomplete = this.getFileAutocomplete();
        const snippetsAutocomplete = this.getSnippetsAutocomplete();
        const skillsAutocomplete = this.getSkillsAutocomplete();

        // Tab-cycle lifecycle: Esc cancels (removes inserted char + hides popup);
        // any non-navigation key exits the cycle visually but leaves the inserted
        // char in place so the user can keep using it as a real trigger.
        if (this._tabCycle) {
            if (e.key === 'Escape') {
                e.preventDefault();
                this._cancelTabCycle();
                return;
            }
            const cycleNavKeys = ['Tab', 'Shift', 'ArrowUp', 'ArrowDown'];
            if (!cycleNavKeys.includes(e.key)) {
                this._exitTabCycle();
                // fall through — let the key be processed normally
            }
        }

        // File autocomplete navigation (takes priority)
        if (fileAutocomplete?.visible) {
            if (e.key === 'ArrowUp') {
                e.preventDefault();
                fileAutocomplete.moveSelection(-1);
                return;
            }
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                fileAutocomplete.moveSelection(1);
                return;
            }
            if (e.key === 'Tab' && fileAutocomplete.hasSelection()) {
                e.preventDefault();
                fileAutocomplete.select();
                if (this._tabCycle) this._exitTabCycle();
                return;
            }
            // Alt+Enter or Cmd/Ctrl+Enter: Preview file instead of inserting
            if (e.key === 'Enter' && (e.altKey || e.metaKey || e.ctrlKey) && fileAutocomplete.hasSelection()) {
                e.preventDefault();
                const path = fileAutocomplete.getSelectedPath();
                if (path) {
                    fileAutocomplete.hide();
                    this.onPreviewFile(path);
                }
                return;
            }
            // Regular Enter: Insert file path
            if (e.key === 'Enter' && fileAutocomplete.hasSelection()) {
                e.preventDefault();
                fileAutocomplete.select();
                return;
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                fileAutocomplete.hide();
                return;
            }
        }

        // Skills autocomplete navigation ($ trigger)
        if (skillsAutocomplete?.visible) {
            if (e.key === 'ArrowUp') {
                e.preventDefault();
                skillsAutocomplete.moveSelection(-1);
                return;
            }
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                skillsAutocomplete.moveSelection(1);
                return;
            }
            if (e.key === 'Tab' || e.key === 'Enter') {
                if (skillsAutocomplete.hasSelection()) {
                    e.preventDefault();
                    skillsAutocomplete.select();
                    if (this._tabCycle) this._exitTabCycle();
                    return;
                }
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                skillsAutocomplete.hide();
                return;
            }
        }

        // Snippets autocomplete navigation
        if (snippetsAutocomplete?.visible) {
            if (e.key === 'ArrowUp') {
                e.preventDefault();
                snippetsAutocomplete.moveSelection(-1);
                return;
            }
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                snippetsAutocomplete.moveSelection(1);
                return;
            }
            // Ctrl+Enter or Cmd+Enter: Select and send immediately
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                if (snippetsAutocomplete.hasSelection()) {
                    e.preventDefault();
                    snippetsAutocomplete.selectAndSend();
                    return;
                }
            }
            // Alt+Enter: Insert just the name (short form)
            if (e.key === 'Enter' && e.altKey) {
                if (snippetsAutocomplete.hasSelection()) {
                    e.preventDefault();
                    snippetsAutocomplete.select(undefined, { short: true });
                    return;
                }
            }
            if (e.key === 'Tab' || e.key === 'Enter') {
                if (snippetsAutocomplete.hasSelection()) {
                    e.preventDefault();
                    snippetsAutocomplete.select();
                    if (this._tabCycle) this._exitTabCycle();
                    return;
                }
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                snippetsAutocomplete.hide();
                return;
            }
        }

        // Slash/bang command autocomplete navigation
        if (autocomplete?.visible) {
            if (e.key === 'ArrowUp') {
                e.preventDefault();
                autocomplete.moveSelection(-1);
                return;
            }
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                autocomplete.moveSelection(1);
                return;
            }
            if (e.key === 'Tab' && autocomplete.hasSelection()) {
                e.preventDefault();
                autocomplete.select();
                if (this._tabCycle) this._exitTabCycle();
                return;
            }
            if (e.key === 'Enter' && autocomplete.hasSelection()) {
                e.preventDefault();
                autocomplete.select();
                return;
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                autocomplete.hide();
                return;
            }
        }

        // Tab cycle through trigger pickers (#, /, @, $) — advances when no popup
        // consumed the Tab above. Suppresses the browser's default focus traversal,
        // which otherwise jumps to the nearest <select> outside the input.
        if (e.key === 'Tab') {
            e.preventDefault();
            this._advanceTabCycle(e.shiftKey ? -1 : 1);
            return;
        }

        // Input history navigation (fish-shell style)
        // Up arrow: go back in history (when input empty OR already browsing)
        if (e.key === 'ArrowUp' && !autocomplete?.visible) {
            const history = this.getHistory();
            if (history.length === 0) return;

            // Can enter history mode if: empty input OR already in history mode
            const isEmpty = this.els.messageInput.value.trim() === '';
            if (!isEmpty && this.historyIndex === -1) return;

            e.preventDefault();

            if (this.historyIndex === -1) {
                // Entering history mode - save current text as draft (with prefix if in input mode)
                this.historyDraft = this._prependModePrefix(this.els.messageInput.value);
                this.historyIndex = 0;
            } else if (this.historyIndex < history.length - 1) {
                // Go further back
                this.historyIndex++;
            } else {
                return; // Already at oldest
            }

            const entry = history[this.historyIndex];
            this.els.messageInput.value = historyEntryText(entry);
            this._updateInputAfterHistoryNav(entry);
            return;
        }

        // Down arrow: go forward in history (only when browsing)
        if (e.key === 'ArrowDown' && !autocomplete?.visible && this.historyIndex !== -1) {
            e.preventDefault();

            let entry = null;
            if (this.historyIndex > 0) {
                // Go forward in history
                this.historyIndex--;
                const history = this.getHistory();
                entry = history[this.historyIndex];
                this.els.messageInput.value = historyEntryText(entry);
            } else {
                // Restore draft and exit history mode
                this.els.messageInput.value = this.historyDraft;
                this.historyIndex = -1;
                this.historyDraft = '';
            }

            this._updateInputAfterHistoryNav(entry);
            return;
        }

        // Exit history mode on cursor movement (user wants to edit)
        if (this.historyIndex !== -1 &&
            ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
            this.historyIndex = -1;
            this.historyDraft = '';
            this._renderHistoryRefsHint(null);
            // Don't prevent default - let the cursor move
        }

        // Backspace on empty in input mode exits the mode
        if (e.key === 'Backspace' && this.inputMode && !this.els.messageInput.value) {
            e.preventDefault();
            this._exitInputMode();
            return;
        }

        // Ctrl+Shift+Enter / Cmd+Shift+Enter: Send in new session
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && e.shiftKey) {
            e.preventDefault();
            const value = this.els.messageInput.value.trim();
            if (!value) return;
            this.els.messageInput.value = '';
            this.onAutoResize();
            this.els.sendBtn.disabled = true;
            if (this.els.followupBtn) this.els.followupBtn.disabled = true;
            this.clearDraft();
            this._consumePendingDraft();
            this.historyIndex = -1;
            this.historyDraft = '';
            this._renderHistoryRefsHint(null);
            this.onSendInNewSession(value);
            return;
        }

        // Send behavior varies by device:
        // - iPhone (touch): Cmd+Enter sends, Enter adds newline
        // - iPad/Desktop (keyboard): Enter sends, Shift+Enter adds newline
        // - Welcome screen: Shift+Enter also sends but inverts action (no newlines needed)
        const isWelcome = this.isWelcomeMode();
        const shouldSend = e.key === 'Enter' && (
            (e.ctrlKey || e.metaKey) ||  // Cmd/Ctrl+Enter always sends
            (this.hasPhysicalKeyboard && !e.shiftKey) ||  // Enter sends on keyboard devices
            (this.hasPhysicalKeyboard && e.shiftKey && isWelcome)  // Shift+Enter on welcome = invert
        );

        if (shouldSend) {
            e.preventDefault();
            // If disconnected and a project (cwd) is set, connect instead
            const session = this.getSession();
            if (session?.status !== 'connected') {
                if (this.getCwd()) {
                    this.onConnect();
                    return;
                }
            }
            this.handleInput({ shiftKey: e.shiftKey });
        }
        // Otherwise: Enter adds newline (default behavior on iPhone, or Shift+Enter on keyboard devices)
    }

    /**
     * Update input field state after history navigation
     */
    _updateInputAfterHistoryNav(entry = null) {
        // Surface the stash references this prompt was sent with. Recall is
        // deliberately display-only — re-arming items that were already sent
        // (and may since have been edited or removed) would be worse than the
        // ambiguity this hint exists to remove.
        this._renderHistoryRefsHint(entry);

        // Check if navigated to a prefixed command — apply input mode
        const wasMode = this.inputMode;
        const val = this.els.messageInput.value;
        if (val.startsWith('!')) {
            this.inputMode = 'shell';
            this.els.messageInput.value = val.slice(1);
        } else if (val.startsWith('/plan ')) {
            this.inputMode = 'plan';
            this.els.messageInput.value = val.slice(6);
        } else {
            this.inputMode = null;
        }
        this._applyInputMode();
        this._notifyPlanComposeChange(wasMode);
        // Move cursor to end
        const len = this.els.messageInput.value.length;
        this.els.messageInput.selectionStart = len;
        this.els.messageInput.selectionEnd = len;
        this.onAutoResize();
    }

    /**
     * Render (or hide) the "sent with N references" hint under the input.
     * Pass null to hide — every exit from history mode does.
     */
    _renderHistoryRefsHint(entry) {
        const el = this.els.historyRefsHint;
        if (!el) return;

        const refs = historyEntryRefs(entry);
        if (!refs) {
            el.classList.remove('visible');
            el.innerHTML = '';
            return;
        }

        // A stash-only send recalls as an empty input — that is the case this
        // hint exists for, so it gets its own wording rather than looking like
        // the recall silently failed.
        const isEmpty = historyEntryText(entry).trim() === '';
        const strings = S.ui.stash;
        const key = isEmpty
            ? (refs.length === 1 ? 'recall_hint_empty_one' : 'recall_hint_empty_many')
            : (refs.length === 1 ? 'recall_hint_one' : 'recall_hint_many');

        // Same block the sent-message bubble draws, from the same refs — the
        // count alone left the user knowing a prompt had references without
        // being able to see which. Expanded when there is nothing else to look
        // at (no typed text) or when there is only one; collapsed otherwise so
        // a large stash cannot shove the input off screen.
        // Re-attach is offered only for refs whose ORIGINAL stash items are
        // still around and not already armed. Rebuilding them from the refs
        // themselves would be a trap: `selectedText` is truncated to 300 chars
        // for display, so a rebuilt item would quietly send a clipped snippet.
        const ids = refs.map(r => r.id).filter(Boolean);
        const restorable = Stash.restorableIds(ids);
        const actionHtml = restorable.length > 0
            ? `<button type="button" class="history-refs-reattach" data-action="reattach"
                       data-tooltip="${escapeAttr(strings.reattach_tooltip)}">${escapeHtml(strings.reattach)}</button>`
            : '';

        el.innerHTML = renderStashRefs(refs, {
            label: strings[key].replace('{count}', refs.length),
            open: isEmpty || refs.length === 1,
        }) + actionHtml;
        el.dataset.tooltip = strings.recall_hint_tooltip;
        el.classList.add('visible');

        el.querySelector('[data-action="reattach"]')
            ?.addEventListener('click', (e) => this._reattachRecalledRefs(e, ids, entry));
    }

    /**
     * Re-arm the stash items a recalled prompt was sent with.
     * @private
     */
    async _reattachRecalledRefs(e, ids, entry) {
        e.preventDefault();
        e.stopPropagation();

        const strings = S.ui.stash;
        const { restored, missing } = await Stash.reattach(ids);

        if (restored === 0 && missing > 0) {
            showToast(strings.reattach_none);
        } else {
            const parts = [
                (restored === 1 ? strings.reattached_one : strings.reattached_many)
                    .replace('{count}', restored),
            ];
            if (missing > 0) {
                parts.push(
                    (missing === 1 ? strings.reattach_missing_one : strings.reattach_missing_many)
                        .replace('{count}', missing)
                );
            }
            showToast(parts.join(' · '));
        }

        // Re-render: the button drops out now that the items are armed, and
        // the stash preview bar above the input picks them up on its own.
        this._renderHistoryRefsHint(entry);
        this.els.messageInput.focus();
    }

    /**
     * Fire onPlanComposeChange when this.inputMode transitions into/out of
     * 'plan'. Call after any direct mutation of this.inputMode.
     */
    _notifyPlanComposeChange(wasMode) {
        if (wasMode !== 'plan' && this.inputMode === 'plan') {
            this.onPlanComposeChange(true);
        } else if (wasMode === 'plan' && this.inputMode !== 'plan') {
            this.onPlanComposeChange(false);
        }
    }

    /**
     * Get the prefix string for the current input mode
     */
    _getModePrefix() {
        if (this.inputMode === 'shell') return '!';
        if (this.inputMode === 'plan') return '/plan ';
        return '';
    }

    /**
     * Prepend the current mode's prefix to a value
     */
    _prependModePrefix(value) {
        const prefix = this._getModePrefix();
        return prefix && value ? prefix + value : value;
    }

    /**
     * Apply input mode CSS class and placeholder
     */
    _applyInputMode() {
        const container = this.els.messageInput.closest('#input-container');
        if (container) {
            container.classList.toggle('shell-mode', this.inputMode === 'shell');
            container.classList.toggle('plan-input-mode', this.inputMode === 'plan');
        }
        this.els.messageInput.placeholder = this.inputMode === 'shell' ? 'command...'
            : this.inputMode === 'plan' ? 'Describe what to plan...'
            : S.ui.input.placeholder;
        // Suppress hint overlay + drafts pill in shell/plan modes
        ShortcutHints.setMode(this.inputMode);
        DraftsPill.setMode(this.inputMode);
    }

    /**
     * Exit input mode, restoring the prefix to the input
     */
    _exitInputMode() {
        if (!this.inputMode) return;
        const wasMode = this.inputMode;
        const prefix = this._getModePrefix();
        this.inputMode = null;
        this._applyInputMode();
        this._notifyPlanComposeChange(wasMode);
        // Hide autocomplete (recent commands popup)
        const autocomplete = this.getAutocomplete();
        if (autocomplete) autocomplete.hide();
        // Prepend prefix back so user sees what they had
        const current = this.els.messageInput.value;
        if (current) {
            this.els.messageInput.value = prefix + current;
        }
        this.onAutoResize();
    }

    // ─────────────────────────────────────────────────────────────────
    // Tab-cycle through trigger pickers
    // ─────────────────────────────────────────────────────────────────

    _advanceTabCycle(dir) {
        let nextIdx;
        if (!this._tabCycle) {
            nextIdx = dir > 0 ? 0 : TAB_CYCLE_TRIGGERS.length - 1;
        } else {
            const curIdx = TAB_CYCLE_TRIGGERS.findIndex(t => t.char === this._tabCycle.trigger);
            nextIdx = (curIdx + dir + TAB_CYCLE_TRIGGERS.length) % TAB_CYCLE_TRIGGERS.length;
        }

        // Clear any stale no-preselect flags from prior advance steps
        // (rapid Tab presses can queue async show()s on multiple popups)
        for (const t of TAB_CYCLE_TRIGGERS) {
            const a = this._getAutocompleteForPopup(t.popup);
            if (a) a.noPreselectOnce = false;
        }

        // Remove the previously-inserted trigger before inserting the next
        if (this._tabCycle) this._removeTabCycleInsertion();

        const next = TAB_CYCLE_TRIGGERS[nextIdx];
        const input = this.els.messageInput;
        const pos = input.selectionStart;
        const value = input.value;
        const needsSpace = pos > 0 && !/\s/.test(value[pos - 1]);
        const insertText = needsSpace ? ' ' + next.char : next.char;

        input.value = value.slice(0, pos) + insertText + value.slice(pos);
        const newCursor = pos + insertText.length;
        input.selectionStart = input.selectionEnd = newCursor;

        this._tabCycle = {
            trigger: next.char,
            insertStart: pos,
            insertEnd: newCursor,
        };

        // Tell the popup to skip preselection on this show()
        const ac = this._getAutocompleteForPopup(next.popup);
        if (ac) ac.noPreselectOnce = true;

        this._highlightTabCycleBtn(next.btnId);

        // Fire input event so the existing autocomplete plumbing shows the popup
        input.dispatchEvent(new Event('input', { bubbles: true }));
        this.onAutoResize();

        // Async autocompletes may resolve after the input event — re-apply
        // the no-selection state once they do.
        queueMicrotask(() => this._enforceTabCycleDeselect(next.popup));
        setTimeout(() => this._enforceTabCycleDeselect(next.popup), 120);
    }

    _enforceTabCycleDeselect(popup) {
        if (!this._tabCycle || this._tabCycle.trigger !== TAB_CYCLE_TRIGGERS.find(t => t.popup === popup)?.char) return;
        const ac = this._getAutocompleteForPopup(popup);
        if (ac && ac.visible && ac.selectedIndex !== -1) {
            ac.selectedIndex = -1;
            if (typeof ac.render === 'function') ac.render();
        }
    }

    _getAutocompleteForPopup(popup) {
        switch (popup) {
            case 'snippets': return this.getSnippetsAutocomplete();
            case 'slash':     return this.getAutocomplete();
            case 'file':      return this.getFileAutocomplete();
            case 'skills':    return this.getSkillsAutocomplete();
        }
        return null;
    }

    _removeTabCycleInsertion() {
        if (!this._tabCycle) return;
        const input = this.els.messageInput;
        const value = input.value;
        const { insertStart, insertEnd } = this._tabCycle;
        if (insertEnd > value.length) return;  // user edited; bail out safely
        input.value = value.slice(0, insertStart) + value.slice(insertEnd);
        input.selectionStart = input.selectionEnd = insertStart;
    }

    _cancelTabCycle() {
        this._removeTabCycleInsertion();
        this.getAutocomplete()?.hide();
        this.getFileAutocomplete()?.hide();
        this.getSnippetsAutocomplete()?.hide();
        this.getSkillsAutocomplete()?.hide();
        this._exitTabCycle();
        this.onAutoResize();
    }

    _exitTabCycle() {
        // Clear any pending no-preselect flag so non-cycle uses behave normally
        for (const t of TAB_CYCLE_TRIGGERS) {
            const a = this._getAutocompleteForPopup(t.popup);
            if (a) a.noPreselectOnce = false;
        }
        this._clearTabCycleHighlights();
        this._tabCycle = null;
    }

    /** Public: is a Tab-cycle currently in progress? */
    isTabCycleActive() {
        return !!this._tabCycle;
    }

    /** Public: cancel the Tab-cycle (called by the global Esc handler). */
    cancelTabCycle() {
        this._cancelTabCycle();
    }

    _highlightTabCycleBtn(btnId) {
        this._clearTabCycleHighlights();
        const btn = document.getElementById(btnId);
        if (btn) btn.classList.add('tab-cycle-active');
    }

    _clearTabCycleHighlights() {
        for (const t of TAB_CYCLE_TRIGGERS) {
            const btn = document.getElementById(t.btnId);
            if (btn) btn.classList.remove('tab-cycle-active');
        }
    }

    // ─────────────────────────────────────────────────────────────────
    // Public API
    // ─────────────────────────────────────────────────────────────────

    /**
     * Process input and send message or command
     * @param {Object} options - Options
     * @param {boolean} options.shiftKey - Whether Shift was held (for welcome screen invert)
     */
    handleInput(options = {}) {
        let value = this.els.messageInput.value.trim();
        const images = this.getPendingImages();
        const hasImages = images.length > 0;
        const hasStash = Stash.hasEnabled();

        // In input mode, prepend prefix back for dispatch. Plan mode dispatches
        // even when empty — a bare /plan just switches to plan permission.
        if (this.inputMode === 'plan') {
            value = this._getModePrefix() + value;
        } else if (this.inputMode && value) {
            value = this._getModePrefix() + value;
        }

        // Need either text, images, or stash items to send
        if (!value && !hasImages && !hasStash) return;

        const autocomplete = this.getAutocomplete();
        autocomplete?.hide();

        // Reset history navigation state
        this.historyIndex = -1;
        this.historyDraft = '';
        this._renderHistoryRefsHint(null);

        // Exit input mode on send
        this.inputMode = null;
        this._applyInputMode();

        // Add all input to session history (slash commands, bang commands, messages)
        if (value) {
            this.addToHistory(value);
        }

        // Parse command (only if no images - images go with regular messages)
        if (value.startsWith('/') && !hasImages) {
            this.onSlashCommand(value);
        } else if (value.startsWith('!') && !hasImages) {
            this.onBangCommand(value);
        } else {
            this.onSendMessage(value, { shiftKey: options.shiftKey || false });
        }

        this.els.messageInput.value = '';
        this.onAutoResize();
        this.els.sendBtn.disabled = true;
        if (this.els.followupBtn) this.els.followupBtn.disabled = true;

        // Clear saved draft after sending
        this.clearDraft();
        // Sending a loaded saved-draft consumes it (server-side delete)
        this._consumePendingDraft();
    }

    /**
     * Get user message history (most recent first)
     * Returns per-session history (in-memory) for up/down navigation
     */
    getHistory() {
        const session = this.getSession();
        return session?.promptHistory || [];
    }

    /**
     * Add a message to session history (in-memory) for up/down navigation.
     *
     * @param {string} content - the text the user typed (may be empty)
     * @param {Array|null} stashRefs - compact stash references sent with it
     */
    addToHistory(content, stashRefs = null) {
        const session = this.getSession();
        if (!session) return;

        const text = content || '';
        const refs = Array.isArray(stashRefs) && stashRefs.length > 0 ? stashRefs : null;
        // Neither words nor references — nothing was sent, nothing to recall
        if (!text.trim() && !refs) return;

        // Dedup on the typed text, so re-sending the same prompt moves it to
        // the front instead of stacking (and so the enriched write from the
        // send path replaces the bare one written on keypress). Empty-text
        // entries are exempt: two stash-only sends carry different references
        // and are genuinely different prompts — collapsing them would hide one.
        if (text.trim()) {
            session.promptHistory = session.promptHistory.filter(
                h => historyEntryText(h) !== text
            );
        }
        session.promptHistory.unshift({ text, stashRefs: refs });
        if (session.promptHistory.length > PROMPT_HISTORY_LIMIT) {
            session.promptHistory.length = PROMPT_HISTORY_LIMIT;
        }
    }

    /**
     * Get draft storage key. Prefer storeId (server-side, stable across
     * SessionManager.reconcileWithServer rebuilds) over client-side id, which
     * is regenerated when reconcile constructs fresh Session stubs.
     */
    getDraftKey() {
        const session = this.getSession();
        const key = session?.storeId || session?.id || 'default';
        return `claude-draft:${key}`;
    }

    /**
     * Storage key for the id of the server-side draft mirroring this
     * session's input (written by the auto-sync). Persisting it means a
     * refresh keeps updating the same draft instead of duplicating it.
     */
    getDraftLinkKey() {
        const session = this.getSession();
        const key = session?.storeId || session?.id || 'default';
        return `claude-draft-link:${key}`;
    }

    /**
     * Save draft
     */
    saveDraft(text) {
        if (!text || !text.trim()) {
            this.clearDraft();
            return;
        }
        Storage.set(this.getDraftKey(), text);
    }

    /**
     * Load draft
     */
    loadDraft() {
        return Storage.get(this.getDraftKey(), '');
    }

    /**
     * Clear draft (text + the link to its server-side mirror)
     */
    clearDraft() {
        Storage.remove(this.getDraftKey());
        Storage.remove(this.getDraftLinkKey());
    }

    /**
     * Restore draft to input
     */
    restoreDraft() {
        // Session switch/startup: a pending auto-sync belongs to the previous
        // session's input — cancel it (its localStorage draft keeps the tail)
        this._cancelDraftSyncTimer();
        const draft = this.loadDraft();
        // Re-link the server-side draft mirroring this session's input (see
        // _syncDraftToServer) so edits keep updating it and sending consumes
        // it — instead of duplicating a draft after every refresh/switch
        this.pendingDraftId = draft ? (Storage.get(this.getDraftLinkKey(), null) || null) : null;
        if (draft) {
            // Detect mode from saved draft prefix
            if (draft.startsWith('!')) {
                this.inputMode = 'shell';
                this.els.messageInput.value = draft.slice(1);
            } else if (draft.startsWith('/plan ')) {
                this.inputMode = 'plan';
                this.els.messageInput.value = draft.slice(6);
            } else {
                this.els.messageInput.value = draft;
            }
            this._applyInputMode();
            this.onAutoResize();
            this.onUpdateSendButton();
        }
    }

    /**
     * Reset history navigation state
     */
    resetHistoryState() {
        this.historyIndex = -1;
        this.historyDraft = '';
        this._renderHistoryRefsHint(null);
    }

    // ─────────────────────────────────────────────────────────────────
    // Saved drafts (server-side, cross-session — /api/drafts)
    // ─────────────────────────────────────────────────────────────────

    /**
     * Current input encoded with its mode prefix — the canonical draft text
     * (same scheme for the localStorage auto-draft and server-side drafts).
     * A bare prefix with no content encodes to '' (not a useful draft).
     */
    _encodeDraftText() {
        const raw = this.els.messageInput.value;
        return this.inputMode === 'shell' && raw ? '!' + raw
             : this.inputMode === 'plan' && raw ? '/plan ' + raw
             : !this.inputMode ? raw : '';
    }

    /**
     * Debounced trigger for the auto-sync (called on every input change).
     */
    _scheduleDraftSync() {
        if (this._draftSyncTimer) clearTimeout(this._draftSyncTimer);
        this._draftSyncTimer = setTimeout(() => {
            this._draftSyncTimer = null;
            this._syncDraftToServer();
        }, AUTO_DRAFT_SYNC_MS);
    }

    _cancelDraftSyncTimer() {
        if (this._draftSyncTimer) {
            clearTimeout(this._draftSyncTimer);
            this._draftSyncTimer = null;
        }
    }

    /**
     * Auto-bank the in-progress input as a server-side draft: create one
     * once the text passes AUTO_DRAFT_MIN_CHARS, then keep updating that
     * same draft (linked via pendingDraftId + persisted link key). Sending
     * consumes it; clearing the input abandons it into the Drafts list.
     * Single-flight: a tick that fires mid-request re-runs afterwards.
     */
    _syncDraftToServer() {
        if (this._draftSyncInflight) {
            this._draftSyncQueued = true;
            return;
        }

        const text = this._encodeDraftText();
        if (!text.trim()) return;
        const idAtStart = this.pendingDraftId;
        if (!idAtStart && text.trim().length < AUTO_DRAFT_MIN_CHARS) return;

        const keyAtStart = this.getDraftKey();
        const linkKeyAtStart = this.getDraftLinkKey();
        const epochAtStart = this._draftConsumeEpoch;
        const session = this.getSession();
        const headers = { 'Content-Type': 'application/json' };
        const body = JSON.stringify({
            text,
            cwd: this.getCwd(),
            session_id: session?.storeId || session?.id || null,
        });

        this._draftSyncInflight = (async () => {
            try {
                if (idAtStart) {
                    const res = await fetch(`${CONFIG.API_BASE}/api/drafts/${encodeURIComponent(idAtStart)}`, {
                        method: 'PUT', headers, body,
                    });
                    if (res.ok) return;
                    if (res.status !== 404) throw new Error(`HTTP ${res.status}`);
                    // 404 → deleted elsewhere (Drafts tab, other device);
                    // fall through and recreate
                }

                // Input got sent while we waited — nothing left to bank
                if (this._draftConsumeEpoch !== epochAtStart) return;

                const res = await fetch(`${CONFIG.API_BASE}/api/drafts`, { method: 'POST', headers, body });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const created = (await res.json())?.draft;
                if (!created?.id) return;

                if (this._draftConsumeEpoch !== epochAtStart) {
                    // Sent while the create was in flight — the fresh draft is
                    // a ghost of a sent message, delete it right back
                    fetch(`${CONFIG.API_BASE}/api/drafts/${encodeURIComponent(created.id)}`, { method: 'DELETE' })
                        .catch(() => {});
                    return;
                }

                // Persist the link against the input this text belonged to,
                // so a refresh (or returning to that session) resumes
                // updating this draft instead of duplicating it
                Storage.set(linkKeyAtStart, created.id);
                if (this.getDraftKey() === keyAtStart && this.els.messageInput.value.trim()) {
                    this.pendingDraftId = created.id;
                }
                // else: session switched / input emptied meanwhile → the
                // draft stays as an unlinked "abandoned" entry in the list
                window.dispatchEvent(new CustomEvent('drafts-changed'));
            } catch (err) {
                console.warn('Draft auto-sync failed:', err);
            } finally {
                this._draftSyncInflight = null;
                if (this._draftSyncQueued) {
                    this._draftSyncQueued = false;
                    this._scheduleDraftSync();
                }
            }
        })();
    }

    /**
     * Bank the current input as a server-side draft (retrieve via Prompt
     * Explorer → Drafts, from any session). Clears the input on success.
     * If the auto-sync already mirrors this input, that draft is finalized
     * in place — no duplicate.
     */
    async saveAsDraft() {
        // Encode active input mode as a prefix (same scheme as the auto-draft)
        const text = this._encodeDraftText();
        if (!text.trim()) return;

        // Don't race the auto-sync: cancel the debounce and wait out any
        // in-flight upsert so the explicit save reuses its draft id
        this._cancelDraftSyncTimer();
        if (this._draftSyncInflight) {
            try { await this._draftSyncInflight; } catch { /* already logged */ }
        }

        const session = this.getSession();
        const headers = { 'Content-Type': 'application/json' };
        const body = JSON.stringify({
            text,
            cwd: this.getCwd(),
            session_id: session?.storeId || session?.id || null,
        });

        try {
            let saved = false;
            if (this.pendingDraftId) {
                const res = await fetch(`${CONFIG.API_BASE}/api/drafts/${encodeURIComponent(this.pendingDraftId)}`, {
                    method: 'PUT', headers, body,
                });
                if (res.ok) saved = true;
                else if (res.status !== 404) throw new Error(`HTTP ${res.status}`);
            }
            if (!saved) {
                const res = await fetch(`${CONFIG.API_BASE}/api/drafts`, { method: 'POST', headers, body });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
            }

            // Prompt is banked — clear input, mode, and the auto-draft
            this.els.messageInput.value = '';
            this.inputMode = null;
            this._applyInputMode();
            this.pendingDraftId = null;
            this.clearDraft();
            this.onAutoResize();
            this.onUpdateSendButton();
            ShortcutHints.updateVisibility('');
            DraftsPill.updateVisibility('');
            window.dispatchEvent(new CustomEvent('drafts-changed'));
            showToast(S.toast.draft_saved);
        } catch (err) {
            console.error('Failed to save draft:', err);
            showToast(S.toast.draft_save_failed);
        }
    }

    /**
     * Load a saved draft into the input (replaces current content) and
     * remember its id so sending consumes it.
     * @param {Object} draft - {id, text, ...} from /api/drafts
     */
    insertSavedDraft(draft) {
        const text = draft?.text || '';

        // Mode prefixes are encoded in the text (same scheme as auto-draft)
        if (text.startsWith('!')) {
            this.inputMode = 'shell';
            this.els.messageInput.value = text.slice(1);
        } else if (text.startsWith('/plan ')) {
            this.inputMode = 'plan';
            this.els.messageInput.value = text.slice(6);
        } else {
            this.inputMode = null;
            this.els.messageInput.value = text;
        }
        this._applyInputMode();
        this.onAutoResize();
        this.onUpdateSendButton();
        ShortcutHints.updateVisibility(this.els.messageInput.value);

        // Keep the per-session auto-draft (and its persisted link) in sync
        // so a refresh preserves the loaded text and keeps updating the
        // same server-side draft
        this.saveDraft(text);
        this.pendingDraftId = draft?.id || null;
        if (draft?.id) Storage.set(this.getDraftLinkKey(), draft.id);
        DraftsPill.updateVisibility(this.els.messageInput.value);
        this.els.messageInput.focus();
    }

    /**
     * Drop the link between the input and its server-side draft (e.g. the
     * draft was deleted from the Drafts tab) without touching the input.
     * The next auto-sync tick then creates a fresh draft if warranted.
     */
    unlinkSavedDraft() {
        this.pendingDraftId = null;
        Storage.remove(this.getDraftLinkKey());
    }

    /**
     * Delete the draft mirroring the input after it was sent (fire-and-forget).
     * @private
     */
    _consumePendingDraft() {
        // Bump the epoch first: an auto-sync create may be in flight, and
        // the epoch tells it the input was sent — the just-created draft is
        // then a ghost of a sent message and gets deleted instead of linked
        this._draftConsumeEpoch++;
        this._cancelDraftSyncTimer();
        const id = this.pendingDraftId;
        this.pendingDraftId = null;
        if (!id) return;
        fetch(`${CONFIG.API_BASE}/api/drafts/${encodeURIComponent(id)}`, { method: 'DELETE' })
            .then(() => window.dispatchEvent(new CustomEvent('drafts-changed')))
            .catch(err => console.error('Failed to consume sent draft:', err));
    }
}
