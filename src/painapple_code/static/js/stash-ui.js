/**
 * Stash UI Controller
 *
 * Connects the Stash module to the DOM:
 * - Toolbar button with badge
 * - Picker dropdown for reviewing/toggling items
 * - Preview bar above input
 * - Integration with selection handler
 */

import { Stash } from './stash.js';
import { escapeHtml, formatRelativeTime } from './utils.js';
import { editStashById } from './selection/selection-handler.js';
import { ContextMenu } from './context-menu.js';
import S from './strings.js';
import { debug } from './config.js';
import { basename } from './path-utils.js';

// ═══════════════════════════════════════════════════════════════════════════
// DOM ELEMENTS
// ═══════════════════════════════════════════════════════════════════════════

let els = {
    stashBtn: null,
    stashBadge: null,
    picker: null,
    pickerList: null,
    pickerClose: null,
    moveBtn: null,
    clearBtn: null,
    preview: null,
    previewCount: null,
    previewText: null
};

let pickerVisible = false;
let clearArmTimer = null;

// Sent-history section state (in-memory; collapsed by default)
let historyExpanded = false;
let historyClearArmTimer = null;

const NOTE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';

// ═══════════════════════════════════════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Initialize stash UI
 * Call this after DOM is ready
 */
export function initStashUI() {
    // Get DOM elements
    els.stashBtn = document.getElementById('stash-btn');
    els.stashBadge = document.getElementById('stash-badge');
    els.picker = document.getElementById('stash-picker');
    els.pickerList = document.getElementById('stash-picker-list');
    els.pickerClose = document.getElementById('stash-picker-close');
    els.clearBtn = document.getElementById('stash-clear-btn');
    els.preview = document.getElementById('stash-preview');
    els.previewCount = document.getElementById('stash-preview-count');
    els.previewLabel = document.getElementById('stash-preview-label');
    els.previewCheckbox = document.getElementById('stash-preview-checkbox');
    els.previewText = document.getElementById('stash-preview-text');
    els.moveBtn = document.getElementById('stash-move-btn');

    if (!els.stashBtn || !els.picker) {
        console.warn('[StashUI] Required elements not found');
        return;
    }

    // Inject strings into the static picker markup
    const titleEl = els.picker.querySelector('.stash-picker-title');
    if (titleEl) titleEl.textContent = S.ui?.stash?.title || 'Comments Stash';
    if (els.clearBtn) els.clearBtn.textContent = S.ui?.stash?.clear_all || 'Clear All';
    if (els.moveBtn) {
        els.moveBtn.setAttribute('data-tooltip', S.ui?.stash?.move_to_tooltip || 'Move stash items to another session');
        els.moveBtn.innerHTML = `
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12">
                <path d="M5 12h14M12 5l7 7-7 7"/>
            </svg>
            <span>${escapeHtml(S.ui?.stash?.move_to || 'Move to')}…</span>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12">
                <polyline points="6 9 12 15 18 9"/>
            </svg>
        `;
    }

    // Bind events
    els.stashBtn.addEventListener('click', togglePicker);
    els.stashBtn.addEventListener('touchend', (e) => {
        e.preventDefault();
        togglePicker();
    }, { passive: false });

    els.pickerClose?.addEventListener('click', closePicker);
    els.pickerClose?.addEventListener('touchend', (e) => { e.preventDefault(); closePicker(); }, { passive: false });
    els.clearBtn?.addEventListener('click', handleClearAll);
    els.clearBtn?.addEventListener('touchend', (e) => { e.preventDefault(); handleClearAll(); }, { passive: false });
    els.previewText?.addEventListener('click', openPicker);
    els.previewText?.addEventListener('touchend', (e) => { e.preventDefault(); openPicker(); }, { passive: false });

    // Toggle checkbox for pausing stash attachment
    els.previewCheckbox?.addEventListener('change', (e) => {
        Stash.setPaused(!e.target.checked);
    });

    // Picker item clicks (delegation) - both click and touchend for iOS
    els.pickerList?.addEventListener('click', handlePickerClick);
    els.pickerList?.addEventListener('touchend', (e) => {
        // Only handle if not scrolling
        if (e.changedTouches?.length === 1) {
            handlePickerClick(e);
        }
    }, { passive: true });

    // Header move-to button — opens the session menu
    els.moveBtn?.addEventListener('click', handleMoveToClick);

    // Close picker on outside click (clicks in the move-to context menu
    // don't count — the menu lives in <body>, outside the picker DOM)
    document.addEventListener('click', (e) => {
        if (pickerVisible &&
            !els.picker?.contains(e.target) &&
            !els.stashBtn?.contains(e.target) &&
            !els.previewText?.contains(e.target) &&
            !e.target.closest('.context-menu, .context-menu-submenu-items')) {
            closePicker();
        }
    });

    // Escape is handled by app.handleEscape's priority chain via
    // closeStashPickerIfOpen() — the global shortcut handler (capture
    // phase) owns the key, so a local listener would never see it.

    // Subscribe to stash changes
    Stash.subscribe(updateUI);

    debug.log('[StashUI] Initialized');
}

/**
 * Load stash for a session
 * Call when session changes
 */
export function loadStashForSession(sessionId) {
    if (sessionId) {
        Stash.load(sessionId);
    } else {
        Stash.reset();
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// UI UPDATES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Update all UI elements based on stash state
 */
function updateUI() {
    const count = Stash.getCount();
    const enabledCount = Stash.getEnabledCount();
    const isPaused = Stash.isPaused();

    // Badge
    if (els.stashBadge) {
        els.stashBadge.textContent = count > 0 ? count : '';
    }

    // Button state
    if (els.stashBtn) {
        els.stashBtn.classList.toggle('has-items', count > 0);
    }

    // Preview bar
    if (els.preview) {
        els.preview.classList.toggle('visible', enabledCount > 0);
        els.preview.classList.toggle('paused', isPaused);
    }
    if (els.previewCount) {
        els.previewCount.textContent = enabledCount;
    }
    // Update label text based on paused state
    if (els.previewLabel) {
        els.previewLabel.textContent = isPaused
            ? (S.ui?.stash?.preview_paused || 'references (paused)')
            : (S.ui?.stash?.preview || 'references will be attached');
    }
    // Sync checkbox state
    if (els.previewCheckbox) {
        els.previewCheckbox.checked = !isPaused;
    }

    // Picker list + header move button (if visible)
    if (pickerVisible) {
        renderPickerList();
        updateMoveButton();
    }
}

/**
 * Render the picker list items
 */
function renderPickerList() {
    if (!els.pickerList) return;

    const items = Stash.getItems();
    const history = Stash.getHistory();

    let html;
    if (items.length === 0) {
        html = `
            <div class="stash-picker-empty">
                ${escapeHtml(S.ui?.stash?.empty || 'No items in stash.')}<br>
                ${escapeHtml(S.ui?.stash?.empty_hint || 'Select text and tap "Stash" to add references.')}
            </div>
        `;
    } else {
        html = items.map(item => renderStashItem(item)).join('');
    }

    if (history.length > 0) {
        html += renderHistorySection(history);
    }

    els.pickerList.innerHTML = html;
}

/**
 * Render the collapsible sent-history section (items that already rode
 * along with a message — kept for reference instead of deleted).
 */
function renderHistorySection(history) {
    const header = `
        <button class="stash-history-header" data-action="toggle-history">
            <svg class="stash-history-chevron ${historyExpanded ? 'expanded' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="9 18 15 12 9 6"/>
            </svg>
            <span>${escapeHtml(S.ui?.stash?.history_header || 'History')}</span>
            <span class="stash-history-count">${history.length}</span>
        </button>
    `;

    const body = historyExpanded ? `
        <div class="stash-history-list">
            ${history.map(item => renderHistoryItem(item)).join('')}
        </div>
        <button class="stash-history-clear" data-action="clear-history">${escapeHtml(S.ui?.stash?.clear_history || 'Clear History')}</button>
    ` : '';

    return `<div class="stash-history">${header}${body}</div>`;
}

/**
 * Render a single sent-history item — compact row: anchor + sent time,
 * text preview, note. Row click (or the arrow button) jumps to the
 * message it was attached to.
 */
function renderHistoryItem(item) {
    const anchor = formatAnchor(item);
    const fullText = item.selectedText || '';
    const text = fullText.length > 80 ? fullText.slice(0, 80) + '...' : fullText;
    const time = item.sentAt ? formatRelativeTime(item.sentAt) : '';

    const noteHtml = item.note
        ? `<div class="stash-item-note">${NOTE_ICON}<span>${escapeHtml(item.note)}</span></div>`
        : '';

    return `
        <div class="stash-item stash-history-item" data-id="${item.id}" data-tooltip="${escapeHtml(S.ui?.stash?.go_to_message || 'Go to message')}">
            <div class="stash-item-content">
                <div class="stash-item-anchor">${escapeHtml(anchor)}${time ? ` <span class="stash-history-time">· ${escapeHtml(time)}</span>` : ''}</div>
                ${text ? `<div class="stash-item-text">${escapeHtml(text)}</div>` : ''}
                ${noteHtml}
            </div>
            <div class="stash-item-actions">
                <button class="stash-item-open" data-action="go-to-message" data-tooltip="${escapeHtml(S.ui?.stash?.go_to_message || 'Go to message')}">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M5 12h14M12 5l7 7-7 7"/>
                    </svg>
                </button>
                <button class="stash-item-remove" data-action="remove" data-tooltip="${escapeHtml(S.ui?.stash?.remove_tooltip || 'Remove')}">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <line x1="18" y1="6" x2="6" y2="18"/>
                        <line x1="6" y1="6" x2="18" y2="18"/>
                    </svg>
                </button>
            </div>
        </div>
    `;
}

/**
 * Render a single stash item.
 * Reading order mirrors how the reference was made: source anchor,
 * then the quoted selection, then the user's own note below it.
 */
function renderStashItem(item) {
    const disabledClass = item.enabled ? '' : 'disabled';
    const anchor = formatAnchor(item);
    const text = item.selectedText.length > 100
        ? item.selectedText.slice(0, 100) + '...'
        : item.selectedText;

    const checkIcon = item.enabled
        ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>'
        : '';

    // Image-marker items carry no quoted selection — the note is the content
    const textHtml = text
        ? `<div class="stash-item-text">${escapeHtml(text)}</div>`
        : '';

    // Note below the quote, or an add-note affordance if there is none yet
    const noteHtml = item.note
        ? `<div class="stash-item-note" data-action="edit-note" data-tooltip="${escapeHtml(S.ui?.stash?.edit_note_tooltip || 'Edit note')}">${NOTE_ICON}<span>${escapeHtml(item.note)}</span></div>`
        : `<button class="stash-item-add-note" data-action="edit-note">${escapeHtml(S.ui?.stash?.add_note || '+ Add note')}</button>`;

    // File items: open the referenced file in the preview widget
    const openBtn = (item.type === 'file' && item.filePath)
        ? `<button class="stash-item-open" data-action="open-file" data-tooltip="${escapeHtml(S.ui?.stash?.open_in_preview || 'Open in preview')}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                <polyline points="15 3 21 3 21 9"/>
                <line x1="10" y1="14" x2="21" y2="3"/>
            </svg>
        </button>`
        : '';

    return `
        <div class="stash-item ${disabledClass}" data-id="${item.id}">
            <div class="stash-item-check" data-action="toggle" data-tooltip="${escapeHtml(S.ui?.stash?.toggle_tooltip || 'Attach to next message')}">${checkIcon}</div>
            <div class="stash-item-content">
                <div class="stash-item-anchor">${escapeHtml(anchor)}</div>
                ${textHtml}
                ${noteHtml}
            </div>
            <div class="stash-item-actions">
                ${openBtn}
                <button class="stash-item-remove" data-action="remove" data-tooltip="${escapeHtml(S.ui?.stash?.remove_tooltip || 'Remove')}">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <line x1="18" y1="6" x2="6" y2="18"/>
                        <line x1="6" y1="6" x2="18" y2="18"/>
                    </svg>
                </button>
            </div>
        </div>
    `;
}

/**
 * Format anchor display text
 */
function formatAnchor(item) {
    if (item.type === 'file') {
        const fileName = basename(item.filePath) || 'file';
        if (item.startLine == null) {
            // No line numbers (e.g., rendered markdown)
            return fileName;
        }
        if (item.startLine === item.endLine) {
            return `${fileName}:${item.startLine}`;
        }
        return `${fileName}:${item.startLine}-${item.endLine}`;
    }
    // Numbered marker on an annotated screenshot
    if (item.type === 'image') {
        const fileName = basename(item.filePath) || 'image';
        if (item.markerIndex != null) {
            return (S.ui?.stash?.anchor_marker || '{file} · marker {n}')
                .replace('{file}', fileName)
                .replace('{n}', item.markerIndex);
        }
        return fileName;
    }
    // Message reference — the index is best-effort; omit it when unknown
    // rather than showing a puzzling "Message #?"
    if (item.messageIndex) {
        return (S.ui?.stash?.anchor_message_indexed || 'Message #{index}')
            .replace('{index}', item.messageIndex);
    }
    return S.ui?.stash?.anchor_message || 'Message';
}

/**
 * Show the header Move-to button only when there is something to move
 * and somewhere to move it.
 */
function updateMoveButton() {
    if (!els.moveBtn) return;
    els.moveBtn.hidden = Stash.getCount() === 0 || getOtherSessions().length === 0;
}

/**
 * Get other sessions (not the current stash session).
 * Untitled sessions in the same project share a name (the cwd basename),
 * so duplicates get a " · n" suffix to stay distinguishable.
 */
function getOtherSessions() {
    const sm = window.app?.sessionManager;
    if (!sm) return [];

    const currentStoreId = Stash.getSessionId();
    const sessions = sm.sessions
        .filter(s => s.storeId && s.storeId !== currentStoreId)
        .map(s => ({ storeId: s.storeId, name: s.name || basename(s.cwd) || 'Session' }));

    const counts = new Map();
    sessions.forEach(s => counts.set(s.name, (counts.get(s.name) || 0) + 1));
    const seen = new Map();
    sessions.forEach(s => {
        if (counts.get(s.name) > 1) {
            const n = (seen.get(s.name) || 0) + 1;
            seen.set(s.name, n);
            s.label = `${s.name} · ${n}`;
        } else {
            s.label = s.name;
        }
    });
    return sessions;
}

/**
 * Handle click on the move-to button — opens a session picker menu
 */
function handleMoveToClick(e) {
    const btn = e.target.closest('.stash-move-btn');
    if (!btn) return;
    e.stopPropagation();

    const sessions = getOtherSessions();
    if (sessions.length === 0) return;

    const menu = window.app?.contextMenu || (window._stashCtxMenu ||= new ContextMenu());
    const rect = btn.getBoundingClientRect();
    menu.show(rect.left, rect.bottom + 4, sessions.map(s => ({
        label: s.label,
        action: () => moveItemsTo(s.storeId, s.label, btn)
    })));
}

/**
 * Move enabled items to the target session, with button feedback + toast
 */
async function moveItemsTo(targetStoreId, targetName, btn) {
    btn?.classList.add('moving');
    const labelSpan = btn?.querySelector('span');
    if (labelSpan) labelSpan.textContent = S.ui?.stash?.moving || 'Moving…';

    const moved = await Stash.moveToSession(targetStoreId);

    btn?.classList.remove('moving');
    if (labelSpan) labelSpan.textContent = `${S.ui?.stash?.move_to || 'Move to'}…`;

    if (moved > 0) {
        const msg = (S.ui?.stash?.moved_to_session || 'Moved {count} items to {name}')
            .replace('{count}', moved)
            .replace('{name}', targetName);
        showToast(msg);

        // Close picker if all items were moved
        if (Stash.getCount() === 0) {
            closePicker();
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// EVENT HANDLERS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Toggle picker visibility
 */
function togglePicker() {
    if (pickerVisible) {
        closePicker();
    } else {
        openPicker();
    }
}

/**
 * Open the picker
 */
function openPicker() {
    pickerVisible = true;
    els.picker?.classList.add('visible');
    renderPickerList();
    updateMoveButton();
}

/**
 * Close the picker
 */
function closePicker() {
    pickerVisible = false;
    els.picker?.classList.remove('visible');
    disarmClearAll();
}

/**
 * Handle clicks inside picker list
 */
function handlePickerClick(e) {
    // History section header + clear button live outside .stash-item rows.
    // stopPropagation is load-bearing: the re-render detaches the clicked
    // node, so the document outside-click closer would see a target that
    // fails els.picker.contains() and close the whole picker.
    if (e.target.closest('[data-action="toggle-history"]')) {
        e.stopPropagation();
        historyExpanded = !historyExpanded;
        renderPickerList();
        return;
    }
    if (e.target.closest('[data-action="clear-history"]')) {
        e.stopPropagation();
        handleClearHistory(e.target.closest('[data-action="clear-history"]'));
        return;
    }

    const item = e.target.closest('.stash-item');
    if (!item) return;

    const id = item.dataset.id;

    // Check if remove button was clicked
    if (e.target.closest('[data-action="remove"]')) {
        e.stopPropagation();
        Stash.remove(id);
        return;
    }

    // History rows: whole row (and the arrow button) jumps to the message
    if (item.classList.contains('stash-history-item')) {
        e.stopPropagation();
        const hItem = Stash.getHistory().find(i => i.id === id);
        if (hItem) goToMessage(hItem);
        return;
    }

    // Check if open-in-preview was clicked
    if (e.target.closest('[data-action="open-file"]')) {
        e.stopPropagation();
        const stashItem = Stash.getItems().find(i => i.id === id);
        if (stashItem) openItemInPreview(stashItem);
        return;
    }

    // Checkbox toggles whether the item attaches to the next message
    if (e.target.closest('[data-action="toggle"]')) {
        e.stopPropagation();
        Stash.toggle(id);
        return;
    }

    // Anywhere else on the item opens the note editor
    e.stopPropagation();
    closePicker();
    editStashById(id);
}

/**
 * Jump to the message a history item was attached to. Switches session
 * first when it was sent elsewhere (or loads it from the server), then
 * scrolls via chatCtrl.scrollToMessage — sentAt is the exact timestamp
 * of the stored user message.
 */
async function goToMessage(item) {
    closePicker();

    const app = window.app;
    if (!app) return;

    const targetId = item.sentInSessionId;
    if (targetId) {
        const open = app.sessionManager?.sessions?.find(
            s => s.storeId === targetId || s.id === targetId
        );
        if (open) {
            if (app.activeSession !== open) app.switchToSession(open);
        } else if (app.loadSessionFromServer) {
            const loaded = await app.loadSessionFromServer(targetId);
            if (!loaded) return;
        }
    }

    // Brief delay for the session view to render before scrolling.
    // (sentWithMessageId is a client message id, not a promptId — the
    // timestamp exact-match is the reliable lookup here.)
    setTimeout(async () => {
        const found = await app.chatCtrl?.scrollToMessage(item.sentAt, null);
        if (!found) {
            showToast(S.ui?.stash?.message_not_found || "Couldn't locate that message");
        }
    }, 150);
}

/**
 * Two-click confirm for Clear History (same arm pattern as Clear All)
 */
function handleClearHistory(btn) {
    if (!btn) return;

    if (!btn.classList.contains('armed')) {
        btn.classList.add('armed');
        btn.textContent = S.ui?.stash?.clear_confirm || 'Sure?';
        clearTimeout(historyClearArmTimer);
        historyClearArmTimer = setTimeout(() => {
            btn.classList.remove('armed');
            btn.textContent = S.ui?.stash?.clear_history || 'Clear History';
        }, 2500);
        return;
    }

    clearTimeout(historyClearArmTimer);
    historyClearArmTimer = null;
    Stash.clearHistory();
}

/**
 * Open a file-type stash item in the file preview widget, scrolled to the
 * commented lines. Items with line info get the code view's scroll+highlight;
 * older items without lines fall back to flashing the marked block in the
 * rendered view (tagged with data-stash-id by updateStashIndicators).
 */
async function openItemInPreview(item) {
    closePicker();

    const app = window.app;
    if (!app?.previewFile) return;

    if (item.startLine != null) {
        await app.previewFile(item.filePath, {
            start: item.startLine,
            end: item.endLine || item.startLine
        });
        return;
    }

    await app.previewFile(item.filePath);
    flashStashBlock(item.id);
}

/**
 * Scroll the preview's rendered view to the block marked with this stash id
 * and flash it. Retries briefly — the rendered view builds asynchronously.
 * Manual scrollTop math: iOS WKWebView ignores scrollIntoView on overflow
 * containers (same workaround as preview-search).
 */
function flashStashBlock(itemId, attempt = 0) {
    const el = document.querySelector(`.preview-rendered [data-stash-id="${itemId}"]`);
    if (!el) {
        if (attempt < 10) setTimeout(() => flashStashBlock(itemId, attempt + 1), 150);
        return;
    }

    const scroller = el.closest('.preview-body');
    if (scroller) {
        const scrollerRect = scroller.getBoundingClientRect();
        const elRect = el.getBoundingClientRect();
        scroller.scrollTop += elRect.top - scrollerRect.top - (scroller.clientHeight - elRect.height) / 2;
    } else {
        el.scrollIntoView({ block: 'center' });
    }

    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1500);
}

/**
 * Handle clear all button — two-click confirm (first click arms, second
 * commits). window.confirm() silently no-ops in the iPad PWA.
 */
function handleClearAll() {
    if (!els.clearBtn) return;

    if (!els.clearBtn.classList.contains('armed')) {
        els.clearBtn.classList.add('armed');
        els.clearBtn.textContent = S.ui?.stash?.clear_confirm || 'Sure?';
        els.clearBtn.setAttribute('data-tooltip', S.ui?.stash?.clear_all_confirm || 'Remove all items from stash?');
        clearTimeout(clearArmTimer);
        clearArmTimer = setTimeout(disarmClearAll, 2500);
        return;
    }

    disarmClearAll();
    Stash.clear();
    closePicker();
}

/**
 * Revert the Clear All button to its unarmed state
 */
function disarmClearAll() {
    clearTimeout(clearArmTimer);
    clearArmTimer = null;
    if (els.clearBtn?.classList.contains('armed')) {
        els.clearBtn.classList.remove('armed');
        els.clearBtn.textContent = S.ui?.stash?.clear_all || 'Clear All';
        els.clearBtn.removeAttribute('data-tooltip');
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Close the picker if it's open — used by app.handleEscape's priority chain.
 * @returns {boolean} true if the picker was open and got closed
 */
export function closeStashPickerIfOpen() {
    if (!pickerVisible) return false;
    closePicker();
    return true;
}

/**
 * Add an anchor to the stash (called from selection handler)
 * @param {Object} anchor - Selection anchor data
 * @param {string} [note] - Optional user annotation/comment
 */
export function addToStash(anchor, note = '') {
    Stash.add(anchor, note);

    // Show brief feedback
    showToast(note ? S.toast.added_to_stash_note : S.toast.added_to_stash);
}

/**
 * Show a brief toast notification
 */
function showToast(message) {
    // Simple toast - could be enhanced
    const existing = document.querySelector('.stash-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'stash-toast';
    toast.textContent = message;
    toast.style.cssText = `
        position: fixed;
        bottom: 100px;
        left: 50%;
        transform: translateX(-50%);
        background: var(--bg-tertiary);
        color: var(--text-primary);
        padding: 8px 16px;
        border-radius: 8px;
        font-size: 13px;
        z-index: 5000;
        box-shadow: 0 2px 10px rgba(0,0,0,0.3);
        animation: toast-in 0.2s ease;
    `;
    document.body.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transition = 'opacity 0.2s';
        setTimeout(() => toast.remove(), 200);
    }, 1500);
}

// Export Stash for direct access if needed
export { Stash };
