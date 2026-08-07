/**
 * Snippets Widget
 *
 * Manage user-defined text snippets that get inserted via `#` in chat.
 */

import S from '../strings.js';
import { escapeHtml, appConfirm } from '../utils.js';
import { WidgetManager } from '../widget-system/index.js';
import { loadSnippets, saveSnippets } from '../snippets-autocomplete.js';
import { debug } from '../config.js';

const state = {
    container: null,
    search: '',
};

const EYE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

function filteredSnippets() {
    const all = loadSnippets();
    const q = state.search.trim().toLowerCase();
    if (!q) return all;
    return all.filter(s => {
        if (s.name?.toLowerCase().includes(q)) return true;
        if (s.text?.toLowerCase().includes(q)) return true;
        return false;
    });
}

function renderShell() {
    if (!state.container) return;
    const c = state.container;
    c.classList.add('snw');

    const all = loadSnippets();
    const filtered = filteredSnippets();
    const hasAny = all.length > 0;
    const hasMatches = filtered.length > 0;

    c.innerHTML = `
        <div class="snw-toolbar">
            <div class="snw-search-wrap">
                <svg class="snw-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="11" cy="11" r="8"/>
                    <line x1="21" y1="21" x2="16.65" y2="16.65"/>
                </svg>
                <input class="snw-search" type="text" placeholder="Filter snippets…"
                       value="${escapeHtml(state.search)}" autocomplete="off" spellcheck="false">
                ${state.search ? '<button class="snw-search-clear" data-tooltip="Clear filter" aria-label="Clear filter"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>' : ''}
            </div>
            <button class="snw-new-btn" id="snw-new-btn">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                    <path d="M12 5v14M5 12h14"/>
                </svg>
                <span>New snippet</span>
            </button>
        </div>
        <div class="snw-body">
            ${!hasAny ? renderEmptyState()
              : !hasMatches ? renderNoMatches()
              : renderList(filtered, all)}
        </div>
        <div class="snw-footer">
            Type <code>#</code> in chat to insert.
        </div>
    `;

    attachToolbarHandlers();
    attachListHandlers();
}

function renderEmptyState() {
    return `
        <div class="snw-empty">
            <svg class="snw-empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <polyline points="16 18 22 12 16 6"/>
                <polyline points="8 6 2 12 8 18"/>
            </svg>
            <h3 class="snw-empty-title">No snippets yet</h3>
            <p class="snw-empty-hint">Save reusable text you can drop into chat with <code>#</code>.</p>
            <button class="snw-empty-cta" id="snw-empty-cta">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                    <path d="M12 5v14M5 12h14"/>
                </svg>
                Create your first snippet
            </button>
        </div>
    `;
}

function renderNoMatches() {
    return `
        <div class="snw-empty snw-empty--small">
            <p class="snw-empty-hint">No snippets match <strong>"${escapeHtml(state.search)}"</strong>.</p>
        </div>
    `;
}

function renderList(filtered, all) {
    const eyeSt = S.agents_widget.suggest_toggle;
    return `<ul class="snw-list">${filtered.map(snippet => {
        const realIndex = all.indexOf(snippet);
        const previewText = snippet.text && snippet.text !== snippet.name ? snippet.text : '';
        const hidden = !!snippet.hidden;
        const eyeBtn = `<button class="snw-act snw-act-eye${hidden ? ' is-hidden' : ''}" type="button" data-tooltip="${escapeHtml(hidden ? eyeSt.show_tooltip : eyeSt.hide_tooltip)}" aria-label="${escapeHtml(hidden ? eyeSt.show_label : eyeSt.hide_label)}">${hidden ? EYE_OFF_ICON : EYE_ICON}</button>`;
        return `
            <li class="snw-item${hidden ? ' snw-item--hidden' : ''}" data-index="${realIndex}" draggable="true">
                <span class="snw-drag" data-tooltip="Drag to reorder" aria-label="Drag to reorder">
                    <svg viewBox="0 0 24 24" fill="currentColor">
                        <circle cx="9" cy="6" r="1.5"/>
                        <circle cx="15" cy="6" r="1.5"/>
                        <circle cx="9" cy="12" r="1.5"/>
                        <circle cx="15" cy="12" r="1.5"/>
                        <circle cx="9" cy="18" r="1.5"/>
                        <circle cx="15" cy="18" r="1.5"/>
                    </svg>
                </span>
                <div class="snw-item-main">
                    <div class="snw-item-head">
                        <span class="snw-item-name">${escapeHtml(snippet.name)}</span>
                        <span class="snw-item-trigger">#${escapeHtml(snippet.name)}</span>
                    </div>
                    ${previewText ? `<p class="snw-item-text">${escapeHtml(previewText)}</p>` : ''}
                </div>
                ${eyeBtn}
                <div class="snw-item-actions">
                    <button class="snw-act snw-act-insert" data-tooltip="Insert into chat" aria-label="Insert">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <rect x="9" y="9" width="13" height="13" rx="2"/>
                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                        </svg>
                    </button>
                    <button class="snw-act snw-act-send" data-tooltip="Send now" aria-label="Send">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <line x1="22" y1="2" x2="11" y2="13"/>
                            <polygon points="22 2 15 22 11 13 2 9 22 2"/>
                        </svg>
                    </button>
                    <button class="snw-act snw-act-edit" data-tooltip="Edit" aria-label="Edit">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                        </svg>
                    </button>
                    <button class="snw-act snw-act-del" data-tooltip="Delete" aria-label="Delete">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                        </svg>
                    </button>
                </div>
            </li>
        `;
    }).join('')}</ul>`;
}

function attachToolbarHandlers() {
    const c = state.container;
    if (!c) return;

    const search = c.querySelector('.snw-search');
    if (search) {
        const wasFocused = document.activeElement === search;
        search.addEventListener('input', (e) => {
            state.search = e.target.value;
            rerenderBody();
        });
        if (wasFocused) {
            const len = search.value.length;
            search.focus();
            search.setSelectionRange(len, len);
        }
    }

    c.querySelector('.snw-search-clear')?.addEventListener('click', () => {
        state.search = '';
        renderShell();
        c.querySelector('.snw-search')?.focus();
    });

    c.querySelector('#snw-new-btn')?.addEventListener('click', () => showSnippetEditor(-1));
    c.querySelector('#snw-empty-cta')?.addEventListener('click', () => showSnippetEditor(-1));
}

function rerenderBody() {
    const c = state.container;
    if (!c) return;
    const body = c.querySelector('.snw-body');
    if (!body) return renderShell();
    const all = loadSnippets();
    const filtered = filteredSnippets();
    body.innerHTML = !all.length ? renderEmptyState()
                   : !filtered.length ? renderNoMatches()
                   : renderList(filtered, all);
    // Re-attach button handlers within the body (search/new stay attached on toolbar)
    c.querySelector('#snw-empty-cta')?.addEventListener('click', () => showSnippetEditor(-1));
    attachListHandlers();
}

/**
 * Toggle whether a snippet is suggested in the `#` autocomplete. The hidden
 * flag lives on the snippet itself (round-tripped through the server-backed
 * snippets list); when truthy, getAllItems() filters this snippet out.
 */
function toggleSnippetSuggest(idx) {
    const snippets = loadSnippets();
    const snippet = snippets[idx];
    if (!snippet) return;
    const willHide = !snippet.hidden;
    snippets[idx] = { ...snippet, hidden: willHide };
    saveSnippets(snippets);

    const t = S.agents_widget.toast;
    window.app?.showToast?.(
        (willHide ? t.hidden_from_suggest : t.shown_in_suggest).replace('{name}', snippet.name)
    );
    rerenderBody();
}

function attachListHandlers() {
    const c = state.container;
    if (!c) return;
    const list = c.querySelector('.snw-list');
    if (!list) return;

    list.querySelectorAll('.snw-act-insert').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const idx = parseInt(btn.closest('.snw-item').dataset.index, 10);
            const snippet = loadSnippets()[idx];
            if (snippet) insertItemText(snippetText(snippet), false);
        });
    });

    list.querySelectorAll('.snw-act-send').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const idx = parseInt(btn.closest('.snw-item').dataset.index, 10);
            const snippet = loadSnippets()[idx];
            if (snippet) insertItemText(snippetText(snippet), true);
        });
    });

    list.querySelectorAll('.snw-act-edit').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const idx = parseInt(btn.closest('.snw-item').dataset.index, 10);
            showSnippetEditor(idx);
        });
    });

    list.querySelectorAll('.snw-act-del').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const idx = parseInt(btn.closest('.snw-item').dataset.index, 10);
            if (await appConfirm(S.settings.snippets_editor.delete_confirm, { confirmLabel: 'Delete', danger: true })) {
                const next = loadSnippets();
                next.splice(idx, 1);
                saveSnippets(next);
                rerenderBody();
            }
        });
    });

    list.querySelectorAll('.snw-act-eye').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const idx = parseInt(btn.closest('.snw-item').dataset.index, 10);
            toggleSnippetSuggest(idx);
        });
    });

    list.querySelectorAll('.snw-item').forEach(item => {
        item.addEventListener('click', (e) => {
            // Drag handle and action buttons stop propagation themselves;
            // any click that reaches the item should open the editor.
            if (e.target.closest('.snw-act, .snw-drag')) return;
            const idx = parseInt(item.dataset.index, 10);
            showSnippetEditor(idx);
        });
    });

    setupDragAndDrop(list);
}

function snippetText(snippet) {
    return snippet.text || snippet.name;
}

function insertItemText(text, shouldSend) {
    const input = document.getElementById('message-input');
    if (!input) return;
    const cur = input.value;
    const sep = cur && !cur.endsWith(' ') && !cur.endsWith('\n') ? ' ' : '';
    input.value = cur + sep + text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
    WidgetManager.close('snippets');
    if (shouldSend) {
        setTimeout(() => window.app?.sendMessage?.(), 50);
    }
}

function setupDragAndDrop(list) {
    let draggedItem = null;
    let draggedIndex = -1;
    let dragStartedFromHandle = false;

    list.querySelectorAll('.snw-item').forEach(item => {
        const handle = item.querySelector('.snw-drag');

        if (handle) {
            handle.addEventListener('mousedown', () => { dragStartedFromHandle = true; });
            handle.addEventListener('mouseup', () => { dragStartedFromHandle = false; });
        }

        item.addEventListener('dragstart', (e) => {
            if (!dragStartedFromHandle) { e.preventDefault(); return; }
            dragStartedFromHandle = false;
            draggedItem = item;
            draggedIndex = parseInt(item.dataset.index, 10);
            item.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', item.dataset.index);
        });

        item.addEventListener('dragend', () => {
            item.classList.remove('dragging');
            list.querySelectorAll('.snw-item').forEach(i => {
                i.classList.remove('drag-over-top', 'drag-over-bottom');
            });
            draggedItem = null;
            draggedIndex = -1;
        });

        item.addEventListener('dragover', (e) => {
            e.preventDefault();
            if (!draggedItem || draggedItem === item) return;
            const rect = item.getBoundingClientRect();
            const midY = rect.top + rect.height / 2;
            item.classList.remove('drag-over-top', 'drag-over-bottom');
            item.classList.add(e.clientY < midY ? 'drag-over-top' : 'drag-over-bottom');
        });

        item.addEventListener('dragleave', () => {
            item.classList.remove('drag-over-top', 'drag-over-bottom');
        });

        item.addEventListener('drop', (e) => {
            e.preventDefault();
            if (!draggedItem || draggedItem === item) return;
            const targetIndex = parseInt(item.dataset.index, 10);
            const rect = item.getBoundingClientRect();
            const midY = rect.top + rect.height / 2;
            const insertAfter = e.clientY >= midY;
            reorder(draggedIndex, targetIndex, insertAfter);
        });
    });
}

function reorder(fromIndex, toIndex, insertAfter) {
    const snippets = loadSnippets();
    const [item] = snippets.splice(fromIndex, 1);
    let newIndex = toIndex;
    if (fromIndex < toIndex) {
        newIndex = insertAfter ? toIndex : toIndex - 1;
    } else {
        newIndex = insertAfter ? toIndex + 1 : toIndex;
    }
    snippets.splice(newIndex, 0, item);
    saveSnippets(snippets);
    rerenderBody();
}

function showSnippetEditor(editIndex) {
    const snippets = loadSnippets();
    const existing = editIndex >= 0 ? snippets[editIndex] : null;
    const isEdit = editIndex >= 0;

    const overlay = document.createElement('div');
    overlay.className = 'config-modal-overlay';
    overlay.innerHTML = `
        <div class="config-modal">
            <h3>${isEdit ? S.settings.snippets_editor.edit_title : S.settings.snippets_editor.add_title}</h3>
            <div class="config-modal-form">
                <div class="config-modal-field">
                    <label for="snippet-name">${S.settings.snippets_editor.name_label}</label>
                    <input type="text" id="snippet-name" placeholder="${S.settings.snippets_editor.name_placeholder}" value="${escapeHtml(existing?.name || '')}">
                </div>
                <div class="config-modal-field">
                    <label for="snippet-text">Text to insert (optional, defaults to name)</label>
                    <textarea id="snippet-text" rows="4" placeholder="${S.settings.snippets_editor.text_placeholder}">${escapeHtml(existing?.text || '')}</textarea>
                </div>
            </div>
            <div class="config-modal-buttons">
                <button class="config-modal-cancel">Cancel</button>
                <button class="config-modal-save">${isEdit ? S.common.save : S.settings.snippets_editor.add_title}</button>
            </div>
        </div>
    `;

    // Append to body, not the widget container — the widget's transform creates
    // a containing block for fixed-positioning, which would trap the modal inside.
    document.body.appendChild(overlay);

    const nameInput = overlay.querySelector('#snippet-name');
    const textInput = overlay.querySelector('#snippet-text');
    const cancelBtn = overlay.querySelector('.config-modal-cancel');
    const saveBtn = overlay.querySelector('.config-modal-save');

    setTimeout(() => nameInput.focus(), 50);

    cancelBtn.addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) overlay.remove();
    });

    saveBtn.addEventListener('click', () => {
        const name = nameInput.value.trim();
        const text = textInput.value.trim();
        if (!name) { nameInput.focus(); return; }
        const newSnippet = {
            name,
            text: text || name,
            desc: text && text !== name ? text.slice(0, 60) : ''
        };
        // Preserve the hidden-from-# flag across edits (it lives on the snippet,
        // not in the editor form).
        if (isEdit && existing?.hidden) newSnippet.hidden = true;
        if (isEdit) snippets[editIndex] = newSnippet;
        else snippets.push(newSnippet);
        saveSnippets(snippets);
        overlay.remove();
        rerenderBody();
    });

    nameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); textInput.focus(); }
    });
    textInput.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); saveBtn.click(); }
    });
}

export function registerSnippetsWidget() {
    WidgetManager.register('snippets', {
        title: S.widgets.titles.snippets,
        icon: 'code',
        type: 'floating',
        scope: 'global',
        defaultWidth: 620,
        defaultHeight: 540,

        render(container) {
            state.container = container;
            renderShell();
        },

        onOpen() {
            requestAnimationFrame(() => {
                state.container?.querySelector('.snw-search')?.focus();
            });
        },

        onClose() {
            state.container = null;
            state.search = '';
        },
    });

    debug.log('[SnippetsWidget] registered');
}

export const SnippetsWidget = {
    open: () => WidgetManager.open('snippets'),
    close: () => WidgetManager.close('snippets'),
    toggle: () => WidgetManager.toggle('snippets'),
};
