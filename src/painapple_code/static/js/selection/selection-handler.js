/**
 * Text Selection Handler for Comments Stash + Discussion
 *
 * Public API and orchestrator for the selection system. Container
 * registry, selection-mode lifecycle (init/destroy/exit), single- and
 * multi-select handling for tap-to-select bubbles, and the stash-bubble
 * indicator pass live here. UI components moved to siblings:
 *
 *   - state.js          shared state object + constants + late imports
 *   - action-bar.js     resizable floating action bar (init/show/hide + handlers)
 *
 * Public surface this file owns / re-exports (importers in app.js,
 * stash-ui.js, preview-events.js, selection/index.js):
 *   registerSelectionContainer, unregisterSelectionContainer,
 *   isSelectionModeActive, getSelectionState, restoreSelectionState,
 *   exitSelectionMode, initSelectionHandler, editStashById,
 *   destroySelectionHandler, updateStashIndicators.
 */

import { Stash } from '../stash.js';
import S from '../strings.js';
import { state, CONFIG, debugLog, getParentChain, ensureImports } from './state.js';
import {
    initActionBar,
    showActionBar,
    hideActionBar,
    updateActionBarQuote,
    clearSelectionAndHide,
    setStashButtonLabel,
} from './action-bar.js';

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Register a container for text selection handling
 *
 * @param {string} id - Unique identifier for this container
 * @param {HTMLElement|string} container - The DOM element or CSS selector to monitor
 * @param {object} config - Configuration
 * @param {function} config.buildAnchor - Function to build anchor data from selection
 */
export function registerSelectionContainer(id, container, config) {
    if (!container || !config.buildAnchor) {
        debugLog(`Register FAILED - invalid container or config for "${id}"`);
        return;
    }

    // Store both element reference AND selector for fallback
    // This handles cases where DOM element is replaced by re-renders
    const selector = typeof container === 'string' ? container : null;
    const element = typeof container === 'string' ? document.querySelector(container) : container;

    state.containers.set(id, {
        container: element,
        selector: selector || guessSelector(id, element),
        config
    });

    debugLog(`Registered container: "${id}" (total: ${state.containers.size})`);
}

/**
 * Guess a selector for a container based on its id and element
 */
function guessSelector(id, element) {
    // Map known container IDs to selectors
    const selectorMap = {
        'file-preview-rendered': '.preview-rendered',
        'chat-messages': '#messages'
    };
    return selectorMap[id] || null;
}

/**
 * Get the current container element, using stored reference or querying selector
 * Returns the container that is visible and in the DOM
 */
function getContainer(entry) {
    // First try the stored element reference - but only if it's visible
    if (entry.container && document.body.contains(entry.container)) {
        // Check if element is visible (not in a hidden/destroyed widget)
        if (entry.container.offsetParent !== null || entry.container.closest('.widget-active, .active')) {
            return entry.container;
        }
    }
    // Fallback to selector query
    if (entry.selector) {
        return document.querySelector(entry.selector);
    }
    return null;
}

/**
 * Get ALL matching containers for a selector (for checking multiple instances)
 */
function getAllContainers(entry) {
    const containers = [];

    // Include stored reference if still valid and visible
    if (entry.container && document.body.contains(entry.container)) {
        if (entry.container.offsetParent !== null || entry.container.closest('.widget-active, .active')) {
            containers.push(entry.container);
        }
    }

    // Also query all matching selectors
    if (entry.selector) {
        document.querySelectorAll(entry.selector).forEach(el => {
            if (!containers.includes(el)) {
                containers.push(el);
            }
        });
    }

    return containers;
}

/**
 * Known container selectors for auto-discovery
 * These are checked when an element isn't found in registered containers
 */
const KNOWN_CONTAINERS = {
    'file-preview-rendered': {
        selector: '.preview-rendered',
        buildAnchor: (range, text) => ({
            type: 'file',
            filePath: findFilePathForPreview(),
            selectedText: text
        })
    },
    'chat-messages': {
        selector: '#messages',
        buildAnchor: (range, text) => {
            // Find the closest message element
            const ancestor = range.commonAncestorContainer;
            const ancestorEl = ancestor?.nodeType === Node.TEXT_NODE ? ancestor.parentElement : ancestor;
            const messageEl = ancestorEl?.closest?.('.message');
            const messagesContainer = document.getElementById('messages');

            return {
                type: 'message',
                messageId: messageEl?.dataset?.msgId || null,
                messageIndex: messageEl && messagesContainer
                    ? Array.from(messagesContainer.children).indexOf(messageEl) + 1
                    : null,
                selectedText: text
            };
        }
    }
};

/**
 * Find file path from the file preview widget state
 */
function findFilePathForPreview() {
    // Preferred: the rendered view carries the real absolute path
    // (stamped by preview-events setupTextSelection)
    const rendered = document.querySelector('.preview-rendered[data-file-path]');
    if (rendered?.dataset.filePath) {
        return rendered.dataset.filePath;
    }
    // Try to get path from widget header or data attribute
    const widget = document.querySelector('.file-preview-widget');
    const header = widget?.closest('.widget')?.querySelector('.widget-title');
    if (header?.textContent) {
        return header.textContent.trim();
    }
    // Fallback - return generic
    return 'file-preview';
}

/**
 * Try to find a container for an element using known selectors
 * This handles cases where containers weren't registered (e.g., after page refresh)
 * @param {Node} nodeOrElement - The commonAncestorContainer from the range
 * @param {Range} range - Optional range for Safari fallback check
 */
function findContainerByKnownSelectors(nodeOrElement, range = null) {
    // Handle text nodes (from range.commonAncestorContainer)
    const element = nodeOrElement?.nodeType === Node.TEXT_NODE
        ? nodeOrElement.parentElement
        : nodeOrElement;

    if (!element) return null;

    for (const [id, info] of Object.entries(KNOWN_CONTAINERS)) {
        const container = document.querySelector(info.selector);
        if (!container) continue;

        // Primary check
        if (container.contains(element)) {
            debugLog(`Auto-discovered container "${id}" via selector`);
            return { id, container, config: { buildAnchor: info.buildAnchor } };
        }

        // Safari fallback: check start/end nodes
        if (range) {
            const startInside = container.contains(range.startContainer);
            const endInside = container.contains(range.endContainer);
            if (startInside && endInside) {
                debugLog(`Auto-discovered container "${id}" via start/end fallback`);
                return { id, container, config: { buildAnchor: info.buildAnchor } };
            }
        }
    }
    return null;
}

/**
 * Unregister a container
 */
export function unregisterSelectionContainer(id) {
    state.containers.delete(id);
}

/**
 * Check if selection mode (action bar) is currently active
 * @returns {boolean}
 */
export function isSelectionModeActive() {
    return state.actionBarActive;
}

/**
 * Get current selection state for saving (serializable, no DOM refs)
 * @returns {Object|null} Selection state or null if not active
 */
export function getSelectionState() {
    if (!state.actionBarActive && state.selections.length === 0) {
        return null;
    }

    return {
        actionBarActive: state.actionBarActive,
        multiSelectMode: state.multiSelectMode,
        inputText: state.selectionInput?.value || '',
        // Store serializable selection data (no DOM refs)
        selections: state.selections.map(s => ({
            text: s.text,
            anchorData: s.anchorData
        })),
        currentSelection: state.currentSelection ? {
            text: state.currentSelection.text,
            anchorData: state.currentSelection.anchorData
        } : null
    };
}

/**
 * Restore selection state (from saved state)
 * @param {Object} savedState - State from getSelectionState()
 */
export function restoreSelectionState(savedState) {
    if (!savedState || !savedState.actionBarActive) {
        return;
    }

    // Ensure action bar elements are initialized
    initActionBar();

    // Restore selections (without DOM refs - just data)
    state.selections = savedState.selections.map(s => ({
        text: s.text,
        anchorData: s.anchorData,
        element: null,  // No DOM ref
        range: null     // No range
    }));

    state.currentSelection = savedState.currentSelection ? {
        text: savedState.currentSelection.text,
        anchorData: savedState.currentSelection.anchorData,
        range: null
    } : null;

    // Restore multi-select mode
    state.multiSelectMode = savedState.multiSelectMode;
    state.multiSelectBtn?.classList.toggle('active', state.multiSelectMode);

    // Show action bar (class on body since selection-bar is outside #input-container)
    document.body.classList.add('selection-mode');
    state.actionBarActive = true;

    // Restore input text
    if (state.selectionInput) {
        state.selectionInput.value = savedState.inputText || '';
    }

    // Update quote display
    updateActionBarQuote();

    debugLog('Selection mode restored', { selections: state.selections.length });
}

/**
 * Exit selection mode (hide action bar, popup, clear selections)
 * Call this when switching tabs or otherwise leaving the current context
 * @returns {Object|null} Saved state for restoration, or null if not active
 */
export function exitSelectionMode() {
    // Save state before clearing (for tab restore)
    const savedState = getSelectionState();

    // Blur any focused element inside selection-bar BEFORE hiding to prevent stuck focus
    // (hidden elements with focus cause :focus-within to stay active but cursor invisible)
    const selectionBar = document.getElementById('selection-bar');
    if (selectionBar && document.activeElement && selectionBar.contains(document.activeElement)) {
        document.activeElement.blur();
    }

    // Hide action bar (class on body since selection-bar is outside #input-container)
    document.body.classList.remove('selection-mode');
    state.actionBarActive = false;

    // Reset multi-select mode and selections
    state.multiSelectMode = false;
    state.selections = [];
    state.multiSelectBtn?.classList.remove('active');

    // Clear text selection
    window.getSelection()?.removeAllRanges();
    state.currentSelection = null;

    // Clear any selected-for-comment highlights
    document.querySelectorAll('.selected-for-comment').forEach(el => {
        el.classList.remove('selected-for-comment');
    });

    // Focus the chat input
    const chatInput = document.getElementById('message-input');
    if (chatInput) {
        void chatInput.offsetHeight;
        chatInput.focus();
    }

    debugLog('Selection mode exited');

    return savedState;
}

// ═══════════════════════════════════════════════════════════════════════════
// STASH INDICATORS - Purple bubbles for stashed elements
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Scan DOM and mark [data-selectable] elements that have matching stash items.
 * Called on stash change (subscribe) and after messages render.
 */
/**
 * The bubble element belonging to a selectable. Table rows keep theirs inside
 * their last cell (tagged data-stash-cell by the renderer) — never look it up
 * via `td:last-child`, the file previewer appends a trash button after the
 * cells, which makes the row's last *child* a <button>.
 */
function bubbleFor(el) {
    return el.querySelector(':scope > .stash-bubble') ||
           el.querySelector(':scope > [data-stash-cell] > .stash-bubble');
}

function updateStashIndicators() {
    const defaultTip = S?.ui?.stash?.bubble_tooltip || 'Click to add comment';
    const existingTip = S?.ui?.stash?.bubble_tooltip_existing || 'Click to edit comment';

    // Clear all existing indicators (and revert bubble tooltips to default)
    document.querySelectorAll('.has-stash').forEach(el => {
        el.classList.remove('has-stash');
        delete el.dataset.stashId;
        const bubble = bubbleFor(el);
        if (bubble) bubble.setAttribute('data-tooltip', defaultTip);
    });

    const items = Stash.getItems();
    if (!items || items.length === 0) return;

    // Message-type items → chat messages container
    const messageItems = items.filter(i => i.type === 'message');
    const messagesContainer = document.getElementById('messages');
    if (messageItems.length > 0 && messagesContainer) {
        for (const item of messageItems) {
            // Scope search to specific message if messageId is available
            let scope = messagesContainer;
            if (item.messageId) {
                const msgEl = document.getElementById('msg-' + item.messageId);
                if (msgEl) scope = msgEl;
            }
            markMatchingSelectables(scope, item, existingTip);
        }
    }

    // File-type items → preview rendered views showing that file
    // (preview-events stamps data-file-path on .preview-rendered at render)
    const fileItems = items.filter(i => i.type === 'file' && i.filePath);
    if (fileItems.length > 0) {
        document.querySelectorAll('.preview-rendered[data-file-path]').forEach(scope => {
            for (const item of fileItems) {
                if (item.filePath === scope.dataset.filePath) {
                    markMatchingSelectables(scope, item, existingTip);
                }
            }
        });
    }

    debugLog('Stash indicators updated', { messages: messageItems.length, files: fileItems.length });
}

/**
 * Mark [data-selectable] elements inside scope whose text matches the stash
 * item. Shared by the chat-message and file-preview indicator passes.
 */
function markMatchingSelectables(scope, item, existingTip) {
    const itemText = item.selectedText?.trim();
    if (!itemText) return;

    const selectables = scope.querySelectorAll('[data-selectable]');
    for (const el of selectables) {
        // Same derivation as capture time (table rows → " | " joined cells)
        const elText = selectableText(el);
        // Exact match, or element text is contained in multi-select combined text
        if (elText === itemText || (item.multiSelect && itemText.includes(elText))) {
            el.classList.add('has-stash');
            el.dataset.stashId = item.id;
            const bubble = bubbleFor(el);
            if (bubble) bubble.setAttribute('data-tooltip', existingTip);
        }
    }
}

/**
 * Initialize the selection handler (call once on app start)
 */
export function initSelectionHandler() {
    debugLog('Initializing selection handler...');
    debugLog(`Touch device: ${'ontouchstart' in window}`);

    // Global keydown handler
    document.addEventListener('keydown', handleKeyDown);

    // Tap-to-select handler for bubble icons on selectable elements
    document.addEventListener('click', handleSelectableIconClick);
    document.addEventListener('touchend', handleSelectableIconTap, { passive: false });

    // Preload imports for discussion widget and stash-ui
    ensureImports();

    // Subscribe to stash changes for bubble indicators
    // (Stash is available immediately via static import — same module instance as stash-ui.js)
    Stash.subscribe(() => updateStashIndicators());
    updateStashIndicators();
    debugLog('Subscribed to stash changes for bubble indicators');

    debugLog('Selection handler initialized (iOS/touch compatible)');
}

/**
 * Handle Escape — run the full clearSelectionAndHide cleanup.
 */
function handleKeyDown(e) {
    if (e.key === 'Escape' && state.actionBarActive) {
        clearSelectionAndHide();
    }
}

/**
 * Handle click on selectable element icon (desktop)
 */
function handleSelectableIconClick(e) {
    // Skip Debug Logs entirely - let it handle its own clicks
    if (e.target.closest?.('.debug-logs, .debug-entries, .debug-widget')) {
        return;
    }

    // Skip clicks on file links - let their onclick handler fire
    if (e.target.closest('.file-path-link')) {
        return;
    }

    const selectable = e.target.closest('[data-selectable]');
    if (!selectable) return;

    // If the click landed directly on the real bubble element, it's
    // unambiguously an icon click — bypass the geometric icon-zone gate.
    // For a wrapped sentence <span> the inline bubble sits at the end of a
    // short final line, well left of the span's union rect.right, so the
    // rect.right-30 gate below would wrongly reject it (this is exactly the
    // case handleSelectableIconTap already special-cases for touch).
    const onBubble = !!e.target.closest('.stash-bubble');

    if (!onBubble) {
        // Check if click is in the icon area (right 30px of element)
        const rect = selectable.getBoundingClientRect();
        const clickX = e.clientX;

        // Only trigger if clicked in the icon zone (right edge)
        if (clickX < rect.right - 30) return;
    }

    e.preventDefault();
    e.stopPropagation();

    // If this element has a stash comment, open editor with existing note
    if (selectable.classList.contains('has-stash') && selectable.dataset.stashId) {
        openStashEditor(selectable);
        return;
    }

    selectElementContent(selectable);
}

/**
 * Handle touch on selectable element icon (iOS/touch)
 */
function handleSelectableIconTap(e) {
    const touch = e.changedTouches?.[0];
    if (!touch) return;

    const target = document.elementFromPoint(touch.clientX, touch.clientY);

    // Skip Debug Logs entirely - let it handle its own clicks
    if (target?.closest?.('.debug-logs, .debug-entries, .debug-widget')) {
        return;
    }

    // Skip taps on file links - let their onclick handler fire
    if (target?.closest('.file-path-link')) {
        return;
    }

    const selectable = target?.closest('[data-selectable]');
    if (!selectable) return;

    // Tapping the real bubble element directly is unambiguous — skip the
    // per-line geometry checks below (mirrors handleSelectableIconClick).
    const onBubble = !!target?.closest('.stash-bubble');

    // Check if tap is in the icon area
    const rect = selectable.getBoundingClientRect();

    // For inline sentence spans, check if tap is near the end of the LAST line of text
    if (onBubble) {
        // fall through to selection/edit below
    } else if (selectable.tagName === 'SPAN' && selectable.dataset.selectable === 'sentence') {
        // For wrapped text, getBoundingClientRect gives the bounding box of ALL lines,
        // but the icon appears after the LAST character. We need to find the last line's end.
        const range = document.createRange();
        range.selectNodeContents(selectable);

        // Get all client rects - one per line for wrapped text
        const rects = range.getClientRects();
        if (rects.length === 0) return;

        // The last rect is the last line of text - icon appears after it
        const lastLineRect = rects[rects.length - 1];

        // Check if tap is on the same line (similar Y) and after the text
        const tapY = touch.clientY;
        const lineTop = lastLineRect.top;
        const lineBottom = lastLineRect.bottom;
        const isOnLastLine = tapY >= lineTop - 10 && tapY <= lineBottom + 10;
        const isAfterText = touch.clientX > lastLineRect.right - 5;

        // Also allow tapping anywhere on single-line short sentences
        const isSingleLine = rects.length === 1;
        const isNearEnd = isSingleLine && touch.clientX > lastLineRect.right - 30;

        if (!isAfterText && !isNearEnd) return;
        if (!isOnLastLine && !isSingleLine) return;
    } else {
        // Block elements - icon is at right edge
        if (touch.clientX < rect.right - 35) return;
    }

    e.preventDefault();
    e.stopPropagation();

    // If this element has a stash comment, open editor with existing note
    if (selectable.classList.contains('has-stash') && selectable.dataset.stashId) {
        openStashEditor(selectable);
        return;
    }

    selectElementContent(selectable);
}

/**
 * Open the action bar editor pre-filled with an existing stash item's note.
 * Used when clicking a bubble that already has a stash comment — replaces the old popover.
 */
function openStashEditor(selectable) {
    const stashId = selectable.dataset.stashId;
    const items = Stash.getItems();
    const item = items.find(i => i.id === stashId);
    if (!item) return;

    // Track that we're editing an existing stash
    state.editingStashId = stashId;

    // Open the normal editor flow
    selectElementContent(selectable);

    // Pre-fill input with existing note after the action bar renders
    setTimeout(() => applyEditingUI(item), 60);
}

/**
 * Open the action bar editor for an existing stash item by ID (no DOM bubble needed).
 * Rebuilds selection state from the stored item itself — used by the stash picker so
 * the user gets the same editor UI regardless of whether the source bubble is rendered.
 */
export function editStashById(stashId) {
    const items = Stash.getItems();
    const item = items.find(i => i.id === stashId);
    if (!item) return false;

    state.editingStashId = stashId;

    state.currentSelection = {
        text: item.selectedText || '',
        range: null,
        anchorData: {
            type: item.type,
            filePath: item.filePath,
            startLine: item.startLine,
            endLine: item.endLine,
            messageId: item.messageId,
            messageIndex: item.messageIndex,
            multiSelect: item.multiSelect,
            selectionCount: item.selectionCount
        }
    };

    initActionBar();
    showActionBar(item.selectedText || '', true);

    setTimeout(() => applyEditingUI(item), 60);
    return true;
}

/**
 * Apply the "editing existing stash" affordances: pre-fill note input, relabel Stash → Update.
 */
function applyEditingUI(item) {
    if (state.selectionInput) {
        state.selectionInput.value = item.note || '';
    }
    setStashButtonLabel(S.selection.action_update, S.selection.tooltip_update);
}

/**
 * True for a selectable table body row.
 */
function isTableRow(el) {
    return el?.tagName === 'TR' && el.dataset.selectable === 'table-row';
}

/**
 * Cell texts of a table row, in order.
 */
export function tableRowCells(tr) {
    return Array.from(tr.cells).map(td => td.textContent.trim());
}

/**
 * Canonical text for a selectable element. Table rows join their cells with
 * " | ". MUST stay the single source of truth: this exact string is what gets
 * stored as item.selectedText and what markMatchingSelectables() re-derives to
 * re-attach the purple bubble, so any divergence silently breaks "edit comment".
 */
function selectableText(el) {
    return isTableRow(el) ? tableRowCells(el).join(' | ') : el.textContent.trim();
}

/**
 * Column headers for a table row's own table, so a stashed row can be rendered
 * with its header context instead of a bare "cell | cell | cell" string.
 * Reads the nearest <thead> row; falls back to any TH-only row.
 */
export function tableHeadersFor(tr) {
    const table = tr.closest('table');
    if (!table) return [];
    const headRow = table.querySelector('thead tr:last-of-type') ||
                    Array.from(table.rows).find(r => r.cells.length &&
                        Array.from(r.cells).every(c => c.tagName === 'TH'));
    if (!headRow) return [];
    return Array.from(headRow.cells).map(th => th.textContent.trim());
}

/**
 * Select element content via icon tap - bypasses native selection entirely.
 * Sets text directly in our action bar without triggering iOS selection quirks.
 * Supports multi-select mode: when enabled, clicking toggles elements on/off.
 */
function selectElementContent(element) {
    // Add visual feedback
    element.classList.add('select-icon-active');
    setTimeout(() => element.classList.remove('select-icon-active'), 200);

    // Get the text content (table rows join cells with " | " for readability)
    const text = selectableText(element);
    if (!text || text.length < CONFIG.minSelectionLength) {
        debugLog('Element text too short');
        return;
    }

    // Find which registered container this element belongs to
    let containerConfig = null;
    let containerId = null;

    debugLog('Looking for container', {
        elementTag: element.tagName,
        elementClass: element.className,
        containersCount: state.containers.size
    });

    for (const [id, entry] of state.containers) {
        // Get ALL matching containers (handles widget transforms where new DOM is created)
        const containers = getAllContainers(entry);
        if (containers.length === 0) {
            debugLog(`Container "${id}" - not found (stale reference, no selector)`);
            continue;
        }

        // Check each container to find the one that contains the element
        for (const container of containers) {
            const containsElement = container.contains(element);
            debugLog(`Container "${id}"`, {
                containsElement,
                containerClass: container.className,
                containerCount: containers.length
            });
            if (containsElement) {
                containerConfig = entry.config;
                containerId = id;
                break;
            }
        }
        if (containerConfig) break;
    }

    if (!containerConfig) {
        // Try auto-discovery for known containers that weren't registered
        const discovered = findContainerByKnownSelectors(element);
        if (discovered) {
            containerConfig = discovered.config;
            containerId = discovered.id;
            debugLog(`Using auto-discovered container: ${containerId}`);
        } else {
            debugLog('Element not in registered container - element parent chain:',
                getParentChain(element));
            return;
        }
    }

    // Build anchor data using the container's buildAnchor function
    const range = document.createRange();
    range.selectNodeContents(element);
    const anchorData = containerConfig.buildAnchor(range, text);

    // Table rows carry their column headers + raw cells so the prompt can show
    // the row as a real markdown table ("| # | Concern | Affects |") instead of
    // a context-free "1 | Project owner is not… | serp-data-platform" string.
    if (isTableRow(element) && anchorData) {
        const headers = tableHeadersFor(element);
        if (headers.length) anchorData.tableHeaders = headers;
        anchorData.tableCells = tableRowCells(element);
    }

    // Multi-select mode handling
    if (state.multiSelectMode) {
        // Check if this element is already in selections
        const existingIndex = state.selections.findIndex(s => s.element === element);

        if (existingIndex >= 0) {
            // Already selected - remove it
            state.selections.splice(existingIndex, 1);
            element.classList.remove('selected-for-comment');
            debugLog('Removed from multi-select', { count: state.selections.length });
        } else {
            // Not selected - add it
            state.selections.push({ text, element, anchorData, range });
            element.classList.add('selected-for-comment');
            debugLog('Added to multi-select', { count: state.selections.length, text: text.slice(0, 30) });
        }

        // Update current selection to be the most recent (for single-action fallback)
        if (state.selections.length > 0) {
            const latest = state.selections[state.selections.length - 1];
            state.currentSelection = {
                text: latest.text,
                range: latest.range,
                anchorData: latest.anchorData
            };
        } else {
            state.currentSelection = null;
        }

        // Update UI
        updateActionBarQuote();

        // If no selections left, hide the action bar
        if (state.selections.length === 0) {
            hideActionBar();
        }
    } else {
        // Single-select mode: toggle behavior
        // If clicking the same element that's already selected and action bar is showing, close it
        const isAlreadySelected = state.selections.length === 1 &&
                                  state.selections[0].element === element &&
                                  state.actionBarActive;

        if (isAlreadySelected) {
            // Toggle off - clear selection and hide action bar
            debugLog('Toggle off - same element clicked again');
            clearSelectionAndHide();
            return;
        }

        // Clear previous and select new
        document.querySelectorAll('.selected-for-comment').forEach(el => {
            el.classList.remove('selected-for-comment');
        });
        element.classList.add('selected-for-comment');

        // Clear multi-select array and add current
        state.selections = [{ text, element, anchorData, range }];

        // Store selection data (bypassing native selection)
        state.currentSelection = {
            text,
            range,
            anchorData
        };

        debugLog('Selected element via icon tap', { text: text.slice(0, 50), containerId });

        // Show action bar for both touch and desktop (unified UX)
        // Focus input since selection is complete (icon tap = instant selection)
        initActionBar();
        showActionBar(text, true);
    }
}

/**
 * Clean up all handlers
 */
export function destroySelectionHandler() {
    document.removeEventListener('keydown', handleKeyDown);
    document.removeEventListener('click', handleSelectableIconClick);
    document.removeEventListener('touchend', handleSelectableIconTap);

    state.containers.clear();

    // Clear any highlights
    document.querySelectorAll('.selected-for-comment').forEach(el => {
        el.classList.remove('selected-for-comment');
    });
    document.querySelectorAll('.has-stash').forEach(el => {
        el.classList.remove('has-stash');
        delete el.dataset.stashId;
    });
}

/**
 * Re-scan DOM for stash indicators (call after new messages render)
 */
export { updateStashIndicators };
