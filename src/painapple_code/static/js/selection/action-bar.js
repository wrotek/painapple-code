/**
 * "Selection Action Bar" — the floating, resizable panel that appears when
 * text is selected (chat messages or file preview). Contains a quote
 * preview, a question/note input, and Discuss / Add-to-Stash / Copy /
 * Close buttons. Supports drag + resize + multi-select mode for
 * tap-to-select bubbles. Used on both touch and desktop.
 *
 * Cross-section dependencies:
 *   - imports `state`, constants, debug, late imports from state.js
 *   - the orchestrator (selection-handler.js) imports `clearSelectionAndHide`
 *     from here to centralise "exit selection mode" cleanup.
 */

import { state, CONFIG, lateImports, ensureImports, debugLog } from './state.js';
import { Stash } from '../stash.js';
import S from '../strings.js';

// localStorage key for the quote block's expand/collapse preference
const QUOTE_EXPANDED_KEY = 'selection-quote-expanded';

// Bump when the panel's layout/spacing changes enough that a size saved by
// the previous version should be thrown away instead of pinning the old box.
const SIZE_SCHEMA_VERSION = 2;

/**
 * Initialize action bar element references
 * IMPORTANT: We use specific selectors via #input-area to avoid matching
 * fake elements inside #messages that were rendered from Claude's markdown output
 * (when Claude discusses this codebase's HTML in thinking blocks)
 */
export function initActionBar() {
    if (state.inputContainer) return; // Already initialized

    // Use scoped selector to get the REAL input-container, not one rendered in messages
    state.inputContainer = document.querySelector('#input-area #input-container');

    // Selection bar is now a direct child of body (outside #input-area for z-index stacking)
    // Use body > #selection-bar to avoid matching any rendered in markdown
    const selectionBar = document.querySelector('body > #selection-bar');
    state.quoteElement = selectionBar?.querySelector('#selection-quote');
    state.quoteWrap = selectionBar?.querySelector('#selection-quote-wrap');
    state.quoteToggle = selectionBar?.querySelector('#selection-quote-toggle');
    state.selectionInput = selectionBar?.querySelector('#selection-input');
    state.discussBtn = selectionBar?.querySelector('#selection-discuss-btn');
    state.stashBtn = selectionBar?.querySelector('#selection-stash-btn');
    state.closeBtn = selectionBar?.querySelector('#selection-close');

    if (!state.inputContainer || !state.quoteElement) {
        debugLog('Action bar elements not found in DOM', {
            inputContainer: !!state.inputContainer,
            selectionBar: !!selectionBar,
            quoteElement: !!state.quoteElement
        });
        return;
    }

    // Wire up button handlers (both click and touchend for iOS reliability)
    state.discussBtn?.addEventListener('click', handleActionBarDiscuss);
    state.discussBtn?.addEventListener('touchend', handleActionBarDiscuss, { passive: false });
    state.stashBtn?.addEventListener('click', handleActionBarStash);
    state.stashBtn?.addEventListener('touchend', handleActionBarStash, { passive: false });
    state.closeBtn?.addEventListener('click', handleActionBarClose);
    state.closeBtn?.addEventListener('touchend', handleActionBarClose, { passive: false });
    state.quoteToggle?.addEventListener('click', handleQuoteToggle);
    state.quoteToggle?.addEventListener('touchend', handleQuoteToggle, { passive: false });
    // The clipped text itself is the bigger target — same toggle
    state.quoteElement?.addEventListener('click', (e) => {
        if (state.quoteWrap?.classList.contains('has-overflow')) handleQuoteToggle(e);
    });

    // Restore the user's last expand/collapse preference for the quote block
    try {
        state.quoteExpanded = localStorage.getItem(QUOTE_EXPANDED_KEY) === '1';
    } catch (e) { /* ignore */ }

    // Wire up input keyboard handlers
    state.selectionInput?.addEventListener('keydown', handleActionBarInputKeydown);

    // Route pasted images to the main chat uploader (same behavior as pasting in message input).
    // Stash auto-attaches to the next send, so the image ends up on the same message.
    state.selectionInput?.addEventListener('paste', (e) => {
        const items = e.clipboardData?.items;
        if (!items) return;
        const images = [];
        for (const item of items) {
            if (item.type.startsWith('image/')) {
                const file = item.getAsFile();
                if (file) images.push(file);
            }
        }
        if (images.length > 0) {
            e.preventDefault();
            window.app?.uploadManager?.handleImages(images);
        }
    });

    // Wire up drag and resize handles for floating panel
    const dragHandle = selectionBar?.querySelector('#selection-bar-drag');
    const resizeHandle = selectionBar?.querySelector('#selection-bar-resize');
    if (selectionBar) {
        if (dragHandle) initSelectionBarDrag(dragHandle, selectionBar);
        if (resizeHandle) initSelectionBarResize(resizeHandle, selectionBar);
    }

    debugLog('Action bar initialized');
}

/**
 * Initialize drag functionality for the floating selection bar
 */
function initSelectionBarDrag(dragHandle, selectionBar) {
    let isDragging = false;
    let startX, startY, startLeft, startTop;

    const onMouseDown = (e) => {
        // Only primary button
        if (e.button !== 0) return;
        e.preventDefault();
        startDrag(e.clientX, e.clientY);
    };

    const onTouchStart = (e) => {
        if (e.touches.length !== 1) return;
        e.preventDefault();
        const touch = e.touches[0];
        startDrag(touch.clientX, touch.clientY);
    };

    const startDrag = (x, y) => {
        isDragging = true;
        startX = x;
        startY = y;

        // Get current position (works with both left/top and right/bottom)
        const rect = selectionBar.getBoundingClientRect();
        startLeft = rect.left;
        startTop = rect.top;

        // Switch to left/top positioning for consistent behavior
        selectionBar.style.left = `${startLeft}px`;
        selectionBar.style.top = `${startTop}px`;
        selectionBar.style.right = 'auto';
        selectionBar.style.bottom = 'auto';

        selectionBar.classList.add('dragging');
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
        document.addEventListener('touchmove', onTouchMove, { passive: false });
        document.addEventListener('touchend', onTouchEnd);
    };

    const onMouseMove = (e) => {
        if (!isDragging) return;
        moveTo(e.clientX, e.clientY);
    };

    const onTouchMove = (e) => {
        if (!isDragging || e.touches.length !== 1) return;
        e.preventDefault();
        const touch = e.touches[0];
        moveTo(touch.clientX, touch.clientY);
    };

    const moveTo = (x, y) => {
        const deltaX = x - startX;
        const deltaY = y - startY;

        let newLeft = startLeft + deltaX;
        let newTop = startTop + deltaY;

        // Constrain to viewport
        const rect = selectionBar.getBoundingClientRect();
        const maxLeft = window.innerWidth - rect.width - 8;
        const maxTop = window.innerHeight - rect.height - 8;

        newLeft = Math.max(8, Math.min(newLeft, maxLeft));
        newTop = Math.max(8, Math.min(newTop, maxTop));

        selectionBar.style.left = `${newLeft}px`;
        selectionBar.style.top = `${newTop}px`;
    };

    const onMouseUp = () => {
        stopDrag();
    };

    const onTouchEnd = () => {
        stopDrag();
    };

    const stopDrag = () => {
        if (!isDragging) return;
        isDragging = false;
        selectionBar.classList.remove('dragging');
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        document.removeEventListener('touchmove', onTouchMove);
        document.removeEventListener('touchend', onTouchEnd);

        // Save position to localStorage (using left/top)
        const rect = selectionBar.getBoundingClientRect();
        const saved = JSON.parse(localStorage.getItem('selection-bar-position') || '{}');
        saved.left = rect.left;
        saved.top = rect.top;
        localStorage.setItem('selection-bar-position', JSON.stringify(saved));
    };

    // Restore saved position (convert to left/top if needed)
    try {
        const saved = JSON.parse(localStorage.getItem('selection-bar-position'));
        if (saved?.left !== undefined && saved?.top !== undefined) {
            selectionBar.style.left = `${saved.left}px`;
            selectionBar.style.top = `${saved.top}px`;
            selectionBar.style.right = 'auto';
            selectionBar.style.bottom = 'auto';
        }
    } catch (e) { /* ignore */ }

    dragHandle.addEventListener('mousedown', onMouseDown);
    dragHandle.addEventListener('touchstart', onTouchStart, { passive: false });
}

/**
 * Initialize resize functionality for the floating selection bar
 */
function initSelectionBarResize(resizeHandle, selectionBar) {
    let isResizing = false;
    let startX, startY, startWidth, startHeight, startLeft, startTop;

    const onMouseDown = (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        startResize(e.clientX, e.clientY);
    };

    const onTouchStart = (e) => {
        if (e.touches.length !== 1) return;
        e.preventDefault();
        e.stopPropagation();
        const touch = e.touches[0];
        startResize(touch.clientX, touch.clientY);
    };

    const startResize = (x, y) => {
        isResizing = true;
        startX = x;
        startY = y;

        const rect = selectionBar.getBoundingClientRect();
        startWidth = rect.width;
        startHeight = rect.height;
        startLeft = rect.left;
        startTop = rect.top;

        // Switch from right/bottom positioning to left/top so resize anchors top-left
        selectionBar.style.left = `${startLeft}px`;
        selectionBar.style.top = `${startTop}px`;
        selectionBar.style.right = 'auto';
        selectionBar.style.bottom = 'auto';

        selectionBar.classList.add('resizing');
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
        document.addEventListener('touchmove', onTouchMove, { passive: false });
        document.addEventListener('touchend', onTouchEnd);
    };

    const onMouseMove = (e) => {
        if (!isResizing) return;
        resizeTo(e.clientX, e.clientY);
    };

    const onTouchMove = (e) => {
        if (!isResizing || e.touches.length !== 1) return;
        e.preventDefault();
        const touch = e.touches[0];
        resizeTo(touch.clientX, touch.clientY);
    };

    const resizeTo = (x, y) => {
        // With left/top positioning, resize naturally grows right/down
        const deltaX = x - startX;
        const deltaY = y - startY;

        let newWidth = startWidth + deltaX;
        let newHeight = startHeight + deltaY;

        // Constraints
        newWidth = Math.max(240, Math.min(newWidth, window.innerWidth - startLeft - 16));
        newHeight = Math.max(120, Math.min(newHeight, window.innerHeight - startTop - 16));

        selectionBar.style.width = `${newWidth}px`;
        selectionBar.style.height = `${newHeight}px`;
    };

    const onMouseUp = () => stopResize();
    const onTouchEnd = () => stopResize();

    const stopResize = () => {
        if (!isResizing) return;
        isResizing = false;
        selectionBar.classList.remove('resizing');
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        document.removeEventListener('touchmove', onTouchMove);
        document.removeEventListener('touchend', onTouchEnd);

        // A narrower/wider panel re-wraps the quote — re-check the clamp
        refreshQuoteOverflow();

        // Save size and position to localStorage
        const rect = selectionBar.getBoundingClientRect();
        const saved = JSON.parse(localStorage.getItem('selection-bar-position') || '{}');
        saved.v = SIZE_SCHEMA_VERSION;
        saved.width = rect.width;
        saved.height = rect.height;
        saved.left = rect.left;
        saved.top = rect.top;
        localStorage.setItem('selection-bar-position', JSON.stringify(saved));
    };

    // Double-tap/click the drag strip → drop the saved size, snap back to the
    // panel's natural (compact) height. Without this, one old resize pins the
    // panel forever and every later layout tightening looks like a no-op.
    const resetSize = (e) => {
        e.preventDefault();
        selectionBar.style.width = '';
        selectionBar.style.height = '';
        try {
            const saved = JSON.parse(localStorage.getItem('selection-bar-position') || '{}');
            delete saved.width;
            delete saved.height;
            localStorage.setItem('selection-bar-position', JSON.stringify(saved));
        } catch (err) { /* ignore */ }
        refreshQuoteOverflow();
        debugLog('Selection panel size reset');
    };
    selectionBar.querySelector('#selection-bar-drag')?.addEventListener('dblclick', resetSize);

    // Restore saved size (position is restored by initSelectionBarDrag).
    // Sizes saved by an older layout are DISCARDED — a stale height would
    // silently cancel out any spacing changes shipped since.
    try {
        const saved = JSON.parse(localStorage.getItem('selection-bar-position'));
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const sizeIsCurrent = saved?.v === SIZE_SCHEMA_VERSION;
        if (saved && !sizeIsCurrent && (saved.width || saved.height)) {
            delete saved.width;
            delete saved.height;
            saved.v = SIZE_SCHEMA_VERSION;
            localStorage.setItem('selection-bar-position', JSON.stringify(saved));
            debugLog('Dropped selection panel size from an older layout');
        }
        if (sizeIsCurrent && saved?.width) {
            selectionBar.style.width = `${Math.min(saved.width, vw - 16)}px`;
        }
        if (sizeIsCurrent && saved?.height) {
            selectionBar.style.height = `${Math.min(saved.height, vh - 16)}px`;
        }
        // Also restore left/top position if available
        if (saved?.left !== undefined && saved?.top !== undefined) {
            const w = Math.min(saved.width || 320, vw - 16);
            const left = Math.max(8, Math.min(saved.left, vw - w - 8));
            const top = Math.max(8, Math.min(saved.top, vh - 120));
            selectionBar.style.left = `${left}px`;
            selectionBar.style.top = `${top}px`;
            selectionBar.style.right = 'auto';
            selectionBar.style.bottom = 'auto';
        }
    } catch (e) { /* ignore */ }

    resizeHandle.addEventListener('mousedown', onMouseDown);
    resizeHandle.addEventListener('touchstart', onTouchStart, { passive: false });
}

/**
 * Show the selection action bar (replaces input area)
 * If already showing, just updates the quote (doesn't clear input)
 * @param {string} text - Selected text
 * @param {boolean} focusInput - Whether to focus input (true for icon tap, false for native selection)
 */
export function showActionBar(text, focusInput = false) {
    initActionBar();
    if (!state.inputContainer || !state.quoteElement) return;

    const isUpdate = state.actionBarActive;

    // Update quote preview
    updateActionBarQuote();

    // Only clear input on initial show, not updates
    if (!isUpdate && state.selectionInput) {
        state.selectionInput.value = '';
    }

    // Enter selection mode (class on body since selection-bar is outside #input-container)
    document.body.classList.add('selection-mode');
    state.actionBarActive = true;

    // Auto-focus input when explicitly requested (icon/bubble tap)
    // For native selection, focus happens on mouseup via separate handler
    if (focusInput && state.selectionInput) {
        setTimeout(() => state.selectionInput?.focus(), 50);
    }

    // Debug: verify CSS is being applied
    const selectionBar = document.getElementById('selection-bar');

    debugLog(isUpdate ? 'Action bar updated' : 'Action bar shown', {
        selectionBarFound: !!selectionBar,
        hasSelectionMode: document.body.classList.contains('selection-mode')
    });
}

/**
 * Update the action bar quote display
 * Handles both single selection and multi-select modes.
 *
 * The FULL selection text always lands in the DOM — no JS truncation. The
 * quote block clamps to 2 lines via CSS and offers "Show full text" when it
 * overflows, so nothing is ever unreachable.
 */
export function updateActionBarQuote() {
    if (!state.quoteElement) return;

    let displayText = '';
    let count = 0;

    if (state.multiSelectMode && state.selections.length > 0) {
        // Multi-select mode: numbered list, one selection per line
        count = state.selections.length;
        displayText = count > 1
            ? state.selections.map((s, i) => `${i + 1}. ${s.text}`).join('\n')
            : state.selections[0].text;
    } else if (state.currentSelection) {
        displayText = state.currentSelection.text;
    }

    state.quoteElement.textContent = displayText;
    applyQuoteExpanded();
    refreshQuoteOverflow();
}

/**
 * Sync the expanded/collapsed class + toggle label from state.
 */
function applyQuoteExpanded() {
    if (!state.quoteWrap) return;
    state.quoteWrap.classList.toggle('expanded', !!state.quoteExpanded);
    if (state.quoteToggle) {
        state.quoteToggle.dataset.tooltip = state.quoteExpanded
            ? S.selection.show_less
            : S.selection.show_more;
    }
}

/**
 * Show the toggle only when the text is taller than the collapsed clamp.
 * `scrollHeight` is the full content height in BOTH states (the clamp uses
 * overflow:hidden, the expanded box overflow:auto), so one measurement works
 * either way — no need to un-expand to probe.
 */
function refreshQuoteOverflow() {
    if (!state.quoteWrap || !state.quoteElement) return;
    requestAnimationFrame(() => {
        if (!state.quoteWrap || !state.quoteElement) return;
        const el = state.quoteElement;
        const cs = getComputedStyle(el);
        const lineHeight = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.45 || 18;
        const padding = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
        const contentHeight = el.scrollHeight - padding;
        state.quoteWrap.classList.toggle(
            'has-overflow',
            contentHeight > lineHeight * CONFIG.quoteClampLines + 1
        );
    });
}

/**
 * Relabel the Stash button (Stash ⇄ Update) without nuking its icon/kbd hint.
 * Only the label span's text changes — the SVG and the ⏎ hint stay put.
 */
export function setStashButtonLabel(label, tooltip) {
    if (!state.stashBtn) return;
    const labelEl = state.stashBtn.querySelector('.selection-action-label');
    if (labelEl) labelEl.textContent = label;
    if (tooltip) state.stashBtn.dataset.tooltip = tooltip;
}

/**
 * Expand / collapse the quote block (preference persists).
 */
function handleQuoteToggle(e) {
    e.preventDefault();
    e.stopPropagation();
    state.quoteExpanded = !state.quoteExpanded;
    try {
        localStorage.setItem(QUOTE_EXPANDED_KEY, state.quoteExpanded ? '1' : '0');
    } catch (err) { /* ignore */ }
    applyQuoteExpanded();
    refreshQuoteOverflow();
    debugLog(`Quote ${state.quoteExpanded ? 'expanded' : 'collapsed'}`);
}

/**
 * Hide the selection action bar
 */
export function hideActionBar() {
    if (!state.inputContainer) return;

    // Blur any focused element inside selection-bar BEFORE hiding to prevent stuck focus
    // (hidden elements with focus cause :focus-within to stay active but cursor invisible)
    const selectionBar = document.getElementById('selection-bar');
    if (selectionBar && document.activeElement && selectionBar.contains(document.activeElement)) {
        document.activeElement.blur();
    }

    document.body.classList.remove('selection-mode');
    state.actionBarActive = false;

    // Reset multi-select mode and selections
    state.multiSelectMode = false;
    state.selections = [];

    // Focus the chat input after closing action bar
    // Force a reflow before focusing so the element is visible
    const chatInput = document.getElementById('message-input');
    if (chatInput) {
        // Force reflow to ensure display:none is removed
        void chatInput.offsetHeight;
        chatInput.focus();
        debugLog('Chat input focused', { activeElement: document.activeElement?.id });
    }

    debugLog('Action bar hidden');
}

/**
 * Handle Discuss button click in action bar - starts thread immediately
 */
async function handleActionBarDiscuss(e) {
    e.preventDefault();
    e.stopPropagation();
    debugLog('Action bar: Discuss clicked');
    await submitActionBarComment('discuss');
}

/**
 * Handle Stash button click in action bar - adds to stash with optional note
 */
async function handleActionBarStash(e) {
    e.preventDefault();
    e.stopPropagation();
    debugLog('Action bar: Stash clicked');

    // Check if we have any selections
    const hasMultipleSelections = state.multiSelectMode && state.selections.length > 1;
    const hasSelection = state.currentSelection || state.selections.length > 0;

    if (!hasSelection) {
        debugLog('No selection data for stash');
        return;
    }

    // IMPORTANT: Capture selection data BEFORE any async operations!
    // During await, event handlers can fire and clear/modify state.currentSelection.
    // This was causing Enter key to fail while mouse click worked - the dynamic import
    // gave the event loop time to process selection change events.
    const note = state.selectionInput?.value?.trim() || '';
    let anchor;

    if (hasMultipleSelections) {
        // Multi-select: combine all selections into anchor
        const combinedText = state.selections.map(s => s.text).join('\n\n');
        anchor = { ...state.selections[0].anchorData };
        anchor.selectedText = combinedText;
        anchor.multiSelect = true;
        anchor.selectionCount = state.selections.length;
        anchor.selections = state.selections.map(s => ({
            text: s.text,
            type: s.anchorData.type || 'message'
        }));
        // All-table-row multi-select from one table → keep every row's cells so
        // formatItem can emit a single table with the shared header row.
        const rowCells = state.selections.map(s => s.anchorData?.tableCells);
        const headerKey = JSON.stringify(anchor.tableHeaders || null);
        const sameTable = anchor.tableHeaders?.length &&
            rowCells.every(c => Array.isArray(c)) &&
            state.selections.every(s => JSON.stringify(s.anchorData?.tableHeaders || null) === headerKey);
        if (sameTable) {
            anchor.tableRows = rowCells;
            delete anchor.tableCells;
        } else {
            // Mixed selection — a header row would misrepresent it
            delete anchor.tableHeaders;
            delete anchor.tableCells;
        }

        // File selections: span the enclosing line range across all blocks
        // (anchor spread above only carries the first block's lines)
        if (anchor.type === 'file') {
            const lined = state.selections
                .map(s => s.anchorData)
                .filter(a => a.type === 'file' && a.startLine != null && a.filePath === anchor.filePath);
            if (lined.length === state.selections.length) {
                anchor.startLine = Math.min(...lined.map(a => a.startLine));
                anchor.endLine = Math.max(...lined.map(a => a.endLine || a.startLine));
            } else {
                anchor.startLine = null;
                anchor.endLine = null;
            }
        }
        debugLog('Multi-select anchor for stash', { count: state.selections.length });
    } else {
        // Single selection - verify state.currentSelection exists
        if (!state.currentSelection) {
            debugLog('No current selection data');
            return;
        }
        anchor = { ...state.currentSelection.anchorData };
        anchor.selectedText = state.currentSelection.text;
    }

    try {
        // Ensure stash import is loaded (dynamic import happens here)
        await ensureImports();

        if (!lateImports.stashAdd) {
            console.error('[SelectionHandler] Stash function not available');
            return;
        }

        // If editing existing stash: empty note = remove, otherwise update
        if (state.editingStashId) {
            Stash.remove(state.editingStashId);
            if (!note) {
                debugLog('Removed stash item (note cleared)', { oldId: state.editingStashId });
                state.editingStashId = null;
                clearSelectionAndHide();
                return;
            }
            debugLog('Removed old stash item for update', { oldId: state.editingStashId });
            state.editingStashId = null;
        }

        // Add to stash with optional note (using pre-captured data)
        lateImports.stashAdd(anchor, note);
        debugLog('Added to stash successfully', { hasNote: !!note });

        clearSelectionAndHide();
    } catch (err) {
        console.error('[SelectionHandler] Error adding to stash:', err);
        debugLog('Stash error', err.message);
    }
}

/**
 * Handle input keydown in action bar
 * - Enter: Always Stash (add to stash with optional note)
 * - Ctrl+Enter: Discuss (start discussion thread)
 * - Escape: Close
 */
function handleActionBarInputKeydown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) {
            // Ctrl+Enter: Discuss
            submitActionBarComment('discuss');
        } else {
            // Plain Enter: Always Stash (with optional note from input)
            handleActionBarStash(e);
        }
    } else if (e.key === 'Escape') {
        clearSelectionAndHide();
    }
}

/**
 * Submit comment from action bar for Discuss mode
 * Handles both single-select and multi-select modes
 */
async function submitActionBarComment(mode) {
    // Only 'discuss' mode uses this function now (stash is handled by handleActionBarStash)
    if (mode !== 'discuss') {
        debugLog('submitActionBarComment: mode not discuss, ignoring');
        return;
    }

    // Check if we have any selections
    const hasMultipleSelections = state.multiSelectMode && state.selections.length > 1;
    const hasSelection = state.currentSelection || state.selections.length > 0;

    if (!hasSelection) {
        debugLog('No selection data');
        return;
    }

    const question = state.selectionInput?.value?.trim();
    if (!question) {
        debugLog('No question entered');
        state.selectionInput?.focus();
        return;
    }

    // IMPORTANT: Capture selection data BEFORE any async operations!
    // During await, event handlers can fire and clear/modify state.currentSelection.
    let anchor;

    if (hasMultipleSelections) {
        // Multi-select: combine all selections into anchor
        const combinedText = state.selections.map(s => s.text).join('\n\n');
        anchor = { ...state.selections[0].anchorData };
        anchor.selectedText = combinedText;
        anchor.multiSelect = true;
        anchor.selectionCount = state.selections.length;
        anchor.selections = state.selections.map(s => ({
            text: s.text,
            type: s.anchorData.type || 'message'
        }));
        debugLog('Multi-select anchor built', { count: state.selections.length });
    } else {
        // Single selection - verify state.currentSelection exists
        if (!state.currentSelection) {
            debugLog('No current selection data');
            return;
        }
        anchor = { ...state.currentSelection.anchorData };
        anchor.selectedText = state.currentSelection.text;
    }

    debugLog(`Submitting discuss: multiSelect=${hasMultipleSelections}, count=${state.selections.length}`);

    try {
        // Ensure imports are loaded (dynamic import happens here)
        await ensureImports();

        if (!lateImports.startThread) {
            console.error('[SelectionHandler] startThread function not available');
            return;
        }

        // Check if session is ready (startThread requires activeSession.storeId)
        const storeId = window.app?.activeSession?.storeId;
        if (!storeId) {
            // Show error to user via input placeholder
            if (state.selectionInput) {
                state.selectionInput.placeholder = 'Session not ready. Please wait...';
                state.selectionInput.classList.add('error');
                setTimeout(() => {
                    state.selectionInput.placeholder = 'Ask about this selection...';
                    state.selectionInput.classList.remove('error');
                }, 3000);
            }
            return;
        }

        // Start thread using pre-captured anchor data
        await lateImports.startThread(anchor, question);
        clearSelectionAndHide();
    } catch (err) {
        console.error('[SelectionHandler] Error submitting:', err);
        debugLog('Submit error', err.message);
    }
}

/**
 * Handle Close button click in action bar
 */
export function handleActionBarClose(e) {
    e.preventDefault();
    e.stopPropagation();

    debugLog('Action bar: Close clicked');
    clearSelectionAndHide();
}

/**
 * Clear selection and hide action bar.
 *
 * Centralised "exit selection mode" cleanup — hides the action bar, clears
 * the native text selection, resets editing state, and removes any
 * `.selected-for-comment` highlights. The orchestrator (selection-handler.js)
 * imports this for the Escape / toggle-off paths.
 */
export function clearSelectionAndHide() {
    window.getSelection()?.removeAllRanges();
    state.currentSelection = null;
    // Reset editing state and restore button text
    if (state.editingStashId) {
        state.editingStashId = null;
        setStashButtonLabel(S.selection.action_stash, S.selection.tooltip_stash);
    }
    hideActionBar();
    // Clear any selected-for-comment highlights
    document.querySelectorAll('.selected-for-comment').forEach(el => {
        el.classList.remove('selected-for-comment');
    });
}
