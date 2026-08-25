/**
 * Inline edit for rendered markdown
 *
 * Click on any rendered block (paragraph, heading, list item, blockquote)
 * to edit its raw markdown source inline. Press Enter to save, Escape to cancel.
 */

import { state, fns, activateStateInstance } from './preview-state.js';
import { showToast } from './preview-utils.js';
import { appConfirm } from '../utils.js';
import { CONFIG } from '../config.js';
import S from '../strings.js';

let currentEdit = null;
let discardConfirmOpen = false;

// ─── Per-instance state resolution ──────────────────────────────────────
// The preview has one PreviewState per widget tab / per session (see
// preview-state.js), but this module used to keep the edit-mode flag in a
// module-level boolean — so a floating preview and a tab preview shared one
// flag, and whichever instance toggled last won. Symptoms: pencil not
// highlighting, Esc reporting "edit mode off" while the visible pane stayed
// active, `e` acting on a hidden instance. The flag now lives on PreviewState
// (state.inlineEdit); each rendered instance stamps its state onto its
// `.file-preview-widget` host so callers holding only a DOM node (Esc handler,
// keyboard shortcut) can resolve the right instance.

/** Normalize any preview-related element to its `.file-preview-widget` host. */
function hostOf(el) {
    if (!el) return null;
    if (el.classList?.contains('file-preview-widget')) return el;
    return el.querySelector?.('.file-preview-widget')
        || el.closest?.('.file-preview-widget')
        || el;
}

/** Resolve the PreviewState instance owning `el`; falls back to the active state. */
function stateFor(el) {
    return hostOf(el)?._previewState || state;
}

const TRASH_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';

const RESTORE_SVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>';

/**
 * POST new file content, throwing the server's own reason on failure.
 * ("Path not allowed" / "Permission denied" / "HTTP 500" beats a bare
 * "Save failed" that hides why the write was rejected.)
 */
async function writeSource(content) {
    const resp = await fetch(`${CONFIG.API_BASE}/api/file/write`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: state.currentPath, content })
    });
    if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        throw new Error(data.detail || `HTTP ${resp.status}`);
    }
    return await resp.json().catch(() => ({}));
}

/** "Save failed — Path not allowed" */
function saveFailedMsg(err, base) {
    const label = base || S.preview?.inline_edit_save_failed || 'Save failed';
    const reason = err?.message && err.message !== 'Save failed' ? err.message : '';
    return reason ? `${label} — ${reason}` : label;
}

// Optional `el`: resolve the instance owning that element (event handlers);
// without it, reports the ACTIVE instance (render-time callers, where the
// module state pointer is guaranteed correct).
export function isInlineEditActive(el) { return !!stateFor(el).inlineEdit; }

// True while a block's textarea is open — used by the file-change poll to avoid
// a rerenderContent() that would wipe the in-progress edit (and its keystrokes).
export function isInlineEditInProgress() { return !!currentEdit; }

export function toggleInlineEdit(container) {
    const host = hostOf(container);
    const s = host?._previewState || state;
    // The user is engaging with THIS instance — make it the active one, so the
    // downstream machinery keyed on the module state pointer (rerenderContent,
    // save paths) targets the pane the user is actually looking at.
    activateStateInstance(s);
    s.inlineEdit = !s.inlineEdit;
    const active = s.inlineEdit;
    const scope = host || container;
    const rendered = scope?.querySelector('.preview-rendered');
    if (rendered) {
        rendered.classList.toggle('inline-edit-mode', active);
    }
    const btn = scope?.querySelector('.inline-edit-toggle');
    if (btn) {
        btn.classList.toggle('active', active);
        btn.setAttribute('data-tooltip', active
            ? (S.preview?.inline_edit_disable || 'Disable inline editing')
            : (S.preview?.inline_edit_enable || 'Click to edit'));
    }
    // Cancel any in-progress edit when toggling THIS instance off
    if (!active && currentEdit && (!scope || scope.contains(currentEdit.element))) {
        cancelEdit();
    }
    return active;
}

export function setInlineEdit(val) {
    state.inlineEdit = val;
}

/**
 * Setup inline edit click handlers on rendered markdown container
 */
export function setupInlineEdit(container) {
    // Setup runs during render, when the module state pointer IS this
    // instance's state (render() calls activateState first). Capture it and
    // stamp it on the host so later interactions resolve the right instance.
    const s = state;
    const host = hostOf(container);
    if (host) host._previewState = s;

    const rendered = container.querySelector('.preview-rendered');
    if (!rendered) return;

    // Restore mode class if re-rendered while this instance is active
    if (s.inlineEdit) {
        rendered.classList.add('inline-edit-mode');
    }

    // Attach trash button to each selectable (hidden via CSS; shown on hover in edit mode)
    addTrashButtons(rendered);

    rendered.addEventListener('click', (e) => {
        if (!s.inlineEdit) return;
        // Clicked into this instance — the pointer-keyed machinery follows.
        activateStateInstance(s);

        // Trash click → delete block directly (no edit step)
        const trashBtn = e.target.closest('.inline-edit-trash-btn');
        if (trashBtn) {
            e.preventDefault();
            e.stopPropagation();
            const block = trashBtn.closest('[data-selectable]');
            if (!block) return;
            // If editing another block, ignore. If editing this block, cancel first.
            if (currentEdit && currentEdit.element !== block) return;
            if (currentEdit && currentEdit.element === block) cancelEdit();
            deleteBlockByElement(block);
            return;
        }

        if (currentEdit) return;

        // Find the closest selectable element. Skip nested ones — outer wins,
        // so there are no edits-inside-edits.
        const target = e.target.closest('[data-selectable]:not(.inline-edit-nested)');
        if (!target) return;
        if (target.classList.contains('inline-edit-placeholder')) return;
        if (target.querySelector('.inline-edit-textarea')) return;

        e.preventDefault();
        e.stopPropagation();

        const visualOffset = getClickTextOffset(target, e.clientX, e.clientY);
        startEdit(target, rendered, visualOffset);
    });

    // Toggle button
    const toggleBtn = container.querySelector('.inline-edit-toggle');
    if (toggleBtn) {
        toggleBtn.addEventListener('click', (e) => {
            e.preventDefault();
            toggleInlineEdit(container);
        });
    }
}

function addTrashButtons(rendered) {
    const selectables = rendered.querySelectorAll('[data-selectable]');
    selectables.forEach(el => {
        if (el.classList.contains('inline-edit-placeholder')) return;
        // Suppress nested selectables: if any ancestor inside `rendered` also has
        // [data-selectable], this one is inert (no trash, no hover outline). The
        // outer block is the edit target.
        if (hasSelectableAncestor(el, rendered)) {
            el.classList.add('inline-edit-nested');
            return;
        }
        el.classList.remove('inline-edit-nested');
        if (el.querySelector(':scope > .inline-edit-trash-btn')) return;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'inline-edit-trash-btn';
        btn.setAttribute('data-tooltip', S.preview?.inline_edit_delete_tooltip || 'Delete this block');
        btn.setAttribute('contenteditable', 'false');
        btn.innerHTML = TRASH_SVG;
        // mousedown preventDefault keeps textarea focus intact while editing
        btn.addEventListener('mousedown', (e) => e.preventDefault());
        el.appendChild(btn);
    });
}

function hasSelectableAncestor(el, root) {
    let cur = el.parentElement;
    while (cur && cur !== root) {
        if (cur.hasAttribute('data-selectable')) return true;
        cur = cur.parentElement;
    }
    return false;
}

// ─── Edit lifecycle ────────────────────────────────────────────────────

function startEdit(element, _rendered, visualOffset = null) {
    const renderedText = element.textContent.trim();
    if (!renderedText) return;

    // DOM source indexes refer to the content at render time. If deletes are
    // pending (no re-render since), use the saved base. Otherwise state.content.
    const base = state._deleteBase || state.content;

    // Prefer source map attributes injected during rendering
    let sourceInfo = null;
    const srcStart = element.getAttribute('data-source-start');
    const srcEnd = element.getAttribute('data-source-end');
    if (srcStart != null && srcEnd != null && base) {
        const startIdx = parseInt(srcStart, 10);
        const endIdx = parseInt(srcEnd, 10);
        const raw = base.substring(startIdx, endIdx);
        // Trim trailing newline from raw token (marked includes it) for cleaner editing
        const trimmed = raw.replace(/\n+$/, '');
        sourceInfo = { raw: trimmed, startIdx, endIdx: startIdx + trimmed.length };
    }

    // Fallback to fuzzy text matching when source map is unavailable
    if (!sourceInfo) {
        sourceInfo = findSourceMarkdown(base, renderedText, element);
    }

    if (!sourceInfo) {
        showToast(S.preview?.inline_edit_not_found || 'Could not locate in source');
        return;
    }

    const { raw, startIdx, endIdx } = sourceInfo;

    // Store original state
    const originalHtml = element.innerHTML;
    element.classList.add('inline-editing');

    // Create textarea with raw markdown
    const textarea = document.createElement('textarea');
    textarea.className = 'inline-edit-textarea';
    // rows defaults to 2, and autoResize measures scrollHeight after setting
    // height:auto — i.e. against the intrinsic 2-row box — so without this every
    // single-line block grew by a full line on entering edit (a heading by its own
    // larger line-height). rows=1 makes the floor one line; scrollHeight still
    // reports the true height for anything taller.
    textarea.rows = 1;
    // Block only the keys the textarea handles itself (Enter/Escape/Tab) —
    // global shortcuts like Ctrl+/ (focus chat input) must still fire.
    textarea.dataset.shortcutsDisabled = 'enter,escape,tab';
    textarea.value = raw;
    textarea.spellcheck = true;

    // Preserve the hover trash button (added by addTrashButtons) across content swap
    const savedTrash = element.querySelector(':scope > .inline-edit-trash-btn');

    // Replace content
    element.textContent = '';
    if (savedTrash) element.appendChild(savedTrash);
    element.appendChild(textarea);

    // Auto-size
    autoResize(textarea);
    textarea.focus();

    // Place cursor where the user clicked (approximate — skips markdown syntax
    // like `**` and leading `# `/`- `). Falls back to end of text.
    const cursorPos = visualOffset != null
        ? mapVisualToSource(textarea.value, visualOffset)
        : textarea.value.length;
    textarea.selectionStart = textarea.selectionEnd = cursorPos;

    currentEdit = { element, textarea, originalHtml, raw, startIdx, endIdx };

    textarea.addEventListener('input', () => autoResize(textarea));

    // Use capture phase to intercept before the global shortcut system
    // (shortcuts.js registers on document with capture: true)
    textarea.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            e.stopPropagation();
            commitEdit();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            // Don't silently drop the user's work — only auto-close when clean.
            if (textarea.value !== currentEdit.raw) {
                const msg = S.preview?.inline_edit_discard_confirm || 'Discard unsaved changes?';
                discardConfirmOpen = true;
                appConfirm(msg, { confirmLabel: 'Discard', danger: true }).then(ok => {
                    discardConfirmOpen = false;
                    if (ok) cancelEdit();
                    else textarea.focus();
                });
                return;
            }
            cancelEdit();
        } else if (e.key === 'Tab' && !e.shiftKey) {
            e.preventDefault();
            e.stopPropagation();
            const { selectionStart: start, selectionEnd: end, value } = textarea;
            textarea.value = value.slice(0, start) + '\t' + value.slice(end);
            textarea.selectionStart = textarea.selectionEnd = start + 1;
            autoResize(textarea);
        }
    }, true);

    // iOS/WebKit can fire a spurious blur immediately after a programmatic
    // focus() made inside a click handler. Left unguarded, that blur runs the
    // commit/cancel path below and — since nothing's been typed yet — instantly
    // cancelEdit()s, so the block flashes into a textarea and snaps straight
    // back to rendered ("jumps for a second and back to normal"). Ignore blurs
    // until the focus has settled; if one slips through early, reclaim focus
    // instead of tearing the edit down.
    let blurArmed = false;
    setTimeout(() => { blurArmed = true; }, 250);

    // Clicking outside: commit if user made changes, cancel if untouched.
    // Delay lets Enter/click-handlers run first; commit-on-blur avoids losing work.
    textarea.addEventListener('blur', () => {
        if (!blurArmed) {
            // Focus bounce right after open — keep the just-opened edit alive.
            if (currentEdit?.textarea === textarea && !discardConfirmOpen) {
                textarea.focus();
            }
            return;
        }
        setTimeout(() => {
            // Focus moved to the discard-confirm dialog, not away from the edit
            if (discardConfirmOpen) return;
            if (currentEdit?.textarea !== textarea) return;
            if (textarea.value !== currentEdit.raw) {
                commitEdit();
            } else {
                cancelEdit();
            }
        }, 200);
    });
}

function autoResize(textarea) {
    textarea.style.height = 'auto';
    textarea.style.height = textarea.scrollHeight + 'px';
}

function cancelEdit() {
    if (!currentEdit) return;
    const { element, originalHtml } = currentEdit;
    element.innerHTML = originalHtml;
    element.classList.remove('inline-editing');
    currentEdit = null;
}

async function commitEdit() {
    if (!currentEdit) return;
    const { textarea, raw, startIdx, endIdx } = currentEdit;
    const newRaw = textarea.value;

    if (newRaw === raw) {
        cancelEdit();
        return;
    }

    // startIdx/endIdx are into the base (pre-delete content, same indexes as DOM attrs).
    // When deletes are pending, we splice into the base then reapply pending deletes to get
    // the save content.
    const base = state._deleteBase || state.content;
    if (!base) {
        cancelEdit();
        return;
    }

    const newBase = base.substring(0, startIdx) + newRaw + base.substring(endIdx);
    const deletes = state._deletes || [];
    const newSaveContent = deletes.length ? buildContentWithDeletes(newBase, deletes) : newBase;

    try {
        await writeSource(newSaveContent);

        state.content = newSaveContent;
        if (state._deleteBase) state._deleteBase = newBase;
        currentEdit = null;

        // Re-render wipes pending-delete placeholders (by design: a save action finalizes them)
        fns.rerenderContent();
        showToast(S.toast?.file_saved || 'Saved');
    } catch (err) {
        console.error('[InlineEdit] Save failed:', err);
        showToast(saveFailedMsg(err));
        cancelEdit();
    }
}

// ─── Delete + restore (in-place placeholder) ────────────────────────────

async function deleteBlockByElement(element) {
    const srcStart = element.getAttribute('data-source-start');
    const srcEnd = element.getAttribute('data-source-end');
    if (srcStart == null || srcEnd == null) {
        showToast(S.preview?.inline_edit_not_found || 'Could not locate in source');
        return;
    }

    // On first delete of this session, snapshot state.content as the base.
    // All data-source-start/end refer to this base.
    if (!state._deleteBase) {
        state._deleteBase = state.content;
        state._deletes = [];
    }
    const base = state._deleteBase;

    const origStart = parseInt(srcStart, 10);
    let origEnd = parseInt(srcEnd, 10);
    if (base[origEnd] === '\n') origEnd++;

    // Build placeholder matching the original tag so we stay valid in its container
    const placeholder = document.createElement(element.tagName);
    placeholder.className = 'inline-edit-placeholder';
    const labelText = S.preview?.inline_edit_deleted || 'Block deleted';
    const restoreLabel = S.preview?.inline_edit_restore || 'Restore';
    placeholder.innerHTML =
        '<span class="inline-edit-placeholder-label">' + labelText + '</span>' +
        '<button type="button" class="inline-edit-restore-btn">' +
        RESTORE_SVG +
        '<span>' + restoreLabel + '</span>' +
        '</button>';

    const record = { origStart, origEnd, placeholder, originalEl: element };

    placeholder.querySelector('.inline-edit-restore-btn').addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        restoreDeletedBlock(record);
    });

    state._deletes.push(record);
    element.parentNode.replaceChild(placeholder, element);

    const newContent = buildContentWithDeletes(base, state._deletes);

    try {
        const result = await writeSource(newContent);
        state.content = newContent;
        // Update mtime so preview-poll's silentReload doesn't trigger and wipe placeholders
        if (result.mtime) state.mtime = result.mtime;
    } catch (err) {
        // Revert: swap original element back, drop the record
        if (placeholder.parentNode) {
            placeholder.parentNode.replaceChild(element, placeholder);
        }
        state._deletes = state._deletes.filter(d => d !== record);
        if (state._deletes.length === 0) {
            delete state._deleteBase;
            state._deletes = null;
        }
        console.error('[InlineEdit] Delete failed:', err);
        showToast(saveFailedMsg(err, S.preview?.inline_edit_delete_failed || 'Delete failed'));
    }
}

async function restoreDeletedBlock(record) {
    const base = state._deleteBase;
    if (!base) return;

    const remaining = (state._deletes || []).filter(d => d !== record);
    const newContent = buildContentWithDeletes(base, remaining);

    try {
        const result = await writeSource(newContent);

        state.content = newContent;
        state._deletes = remaining;
        if (result.mtime) state.mtime = result.mtime;

        // Swap placeholder back with the original element
        if (record.placeholder.parentNode) {
            record.placeholder.parentNode.replaceChild(record.originalEl, record.placeholder);
        }

        if (remaining.length === 0) {
            delete state._deleteBase;
            state._deletes = null;
        }

        showToast(S.preview?.inline_edit_restored || 'Block restored');
    } catch (err) {
        console.error('[InlineEdit] Restore failed:', err);
        showToast(saveFailedMsg(err, S.preview?.inline_edit_restore_failed || 'Restore failed'));
    }
}

/**
 * Rebuild content by removing all pending-delete ranges from the base.
 * Splices from highest origStart to lowest so earlier indexes stay valid.
 */
function buildContentWithDeletes(base, deletes) {
    const sorted = [...deletes].sort((a, b) => b.origStart - a.origStart);
    let content = base;
    for (const d of sorted) {
        content = content.substring(0, d.origStart) + content.substring(d.origEnd);
    }
    return content;
}

/**
 * Called from rerenderContent to discard pending-delete state — placeholders
 * are gone from the DOM after a re-render, so the tracker is no longer useful.
 */
export function resetDeleteSession() {
    if (state._deleteBase) delete state._deleteBase;
    if (state._deletes) state._deletes = null;
}

// ─── Source mapping ────────────────────────────────────────────────────

/**
 * Find the raw markdown source that corresponds to the rendered text.
 * Returns { raw, startIdx, endIdx } where raw is the source markdown
 * and startIdx/endIdx are byte offsets into the full source string.
 */
function findSourceMarkdown(source, renderedText, element) {
    if (!source || !renderedText) return null;

    const tag = element.tagName?.toLowerCase();
    const selType = element.getAttribute('data-selectable');

    // Strategy 1: Heading — find `#{1,6} text` line
    if (selType === 'heading' || /^h[1-6]$/.test(tag)) {
        const headingMatch = findHeadingSource(source, renderedText);
        if (headingMatch) return headingMatch;
    }

    // Strategy 2: List item — find `- text` or `* text` or `1. text` line
    if (selType === 'bullet' || tag === 'li') {
        const listMatch = findListItemSource(source, renderedText);
        if (listMatch) return listMatch;
    }

    // Strategy 3: Blockquote — find `> text` line
    if (selType === 'quote' || tag === 'blockquote') {
        const quoteMatch = findBlockquoteSource(source, renderedText);
        if (quoteMatch) return quoteMatch;
    }

    // Strategy 4: Direct text match (paragraphs, sentences)
    const directMatch = findDirectTextMatch(source, renderedText);
    if (directMatch) return directMatch;

    // Strategy 5: Fuzzy line match — strip markdown and compare
    const fuzzyMatch = findFuzzyLineMatch(source, renderedText);
    if (fuzzyMatch) return fuzzyMatch;

    return null;
}

function findHeadingSource(source, text) {
    // Match heading lines: # Title, ## Title, etc.
    const regex = new RegExp(`^(#{1,6}\\s+)${escapeRegex(text)}\\s*$`, 'm');
    const match = source.match(regex);
    if (match) {
        const startIdx = match.index;
        const endIdx = startIdx + match[0].length;
        return { raw: match[0], startIdx, endIdx };
    }
    return null;
}

function findListItemSource(source, text) {
    // Match list items: - text, * text, + text, 1. text
    const regex = new RegExp(`^(\\s*(?:[-*+]|\\d+\\.)\\s+)${escapeRegex(text)}\\s*$`, 'm');
    const match = source.match(regex);
    if (match) {
        const startIdx = match.index;
        const endIdx = startIdx + match[0].length;
        return { raw: match[0], startIdx, endIdx };
    }

    // Fallback: try matching just the text content within a list item line
    const lines = source.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const listMatch = line.match(/^(\s*(?:[-*+]|\d+\.)\s+)/);
        if (listMatch && stripInlineMarkdown(line.slice(listMatch[1].length)).trim() === text) {
            const startIdx = getLineOffset(source, i);
            const endIdx = startIdx + line.length;
            return { raw: line, startIdx, endIdx };
        }
    }
    return null;
}

function findBlockquoteSource(source, text) {
    // Blockquotes can span multiple lines, each starting with >
    const lines = source.split('\n');
    for (let i = 0; i < lines.length; i++) {
        if (!lines[i].match(/^>\s*/)) continue;

        // Collect contiguous blockquote lines
        let end = i;
        while (end < lines.length && lines[end].match(/^>\s*/)) end++;

        const quoteLines = lines.slice(i, end);
        const quoteText = quoteLines.map(l => l.replace(/^>\s*/, '')).join(' ').trim();

        if (quoteText === text || stripInlineMarkdown(quoteText) === text) {
            const block = quoteLines.join('\n');
            const startIdx = getLineOffset(source, i);
            const endIdx = startIdx + block.length;
            return { raw: block, startIdx, endIdx };
        }
    }
    return null;
}

function findDirectTextMatch(source, text) {
    // Try to find the text directly in the source
    const idx = source.indexOf(text);
    if (idx !== -1) {
        // Expand to full line(s) — don't cut mid-line
        const before = source.lastIndexOf('\n', idx - 1);
        const after = source.indexOf('\n', idx + text.length);
        const startIdx = before === -1 ? 0 : before + 1;
        const endIdx = after === -1 ? source.length : after;
        const raw = source.substring(startIdx, endIdx);
        return { raw, startIdx, endIdx };
    }
    return null;
}

function findFuzzyLineMatch(source, text) {
    const lines = source.split('\n');

    // Single line match: strip markdown from line and compare
    for (let i = 0; i < lines.length; i++) {
        const stripped = stripInlineMarkdown(
            lines[i].replace(/^#{1,6}\s+/, '')
                     .replace(/^\s*(?:[-*+]|\d+\.)\s+/, '')
                     .replace(/^>\s*/, '')
        ).trim();

        if (stripped === text) {
            const startIdx = getLineOffset(source, i);
            const endIdx = startIdx + lines[i].length;
            return { raw: lines[i], startIdx, endIdx };
        }
    }

    // Multi-line paragraph: consecutive non-empty, non-special lines
    for (let i = 0; i < lines.length; i++) {
        if (isSpecialLine(lines[i]) || !lines[i].trim()) continue;

        let end = i;
        while (end < lines.length && lines[end].trim() && !isSpecialLine(lines[end])) end++;

        const paraLines = lines.slice(i, end);
        const paraText = paraLines.map(l => stripInlineMarkdown(l).trim()).join(' ');

        if (paraText === text) {
            const block = paraLines.join('\n');
            const startIdx = getLineOffset(source, i);
            const endIdx = startIdx + block.length;
            return { raw: block, startIdx, endIdx };
        }
    }

    return null;
}

// ─── Helpers ───────────────────────────────────────────────────────────

/**
 * Get the text offset within `element` at the given viewport coordinates.
 * Returns the number of characters from the start of the element's text to
 * the click point, or null if it can't be determined.
 */
function getClickTextOffset(element, x, y) {
    let range = null;
    try {
        if (document.caretRangeFromPoint) {
            range = document.caretRangeFromPoint(x, y);  // Chrome/Safari/iOS
        } else if (document.caretPositionFromPoint) {
            const pos = document.caretPositionFromPoint(x, y);  // Firefox
            if (pos) {
                range = document.createRange();
                range.setStart(pos.offsetNode, pos.offset);
                range.collapse(true);
            }
        }
    } catch (_) {
        return null;
    }
    if (!range || !element.contains(range.startContainer)) return null;
    const preRange = document.createRange();
    preRange.selectNodeContents(element);
    preRange.setEnd(range.startContainer, range.startOffset);
    return preRange.toString().length;
}

/**
 * Map a visual text offset (in the rendered DOM) to an offset in the raw
 * markdown source. Heuristic — skips inline emphasis markers and the leading
 * line marker on the first line. Good enough for paragraphs, headings, and
 * simple list items; degrades gracefully for complex inline markdown.
 */
function mapVisualToSource(source, visualOffset) {
    let srcIdx = 0;
    const leadMatch = source.match(/^(\s*(?:#{1,6}\s+|[-*+]\s+|\d+\.\s+|>\s+))/);
    if (leadMatch) srcIdx = leadMatch[0].length;
    if (visualOffset <= 0) return srcIdx;

    let visIdx = 0;
    while (srcIdx < source.length && visIdx < visualOffset) {
        const c = source[srcIdx];
        if (c === '*' || c === '_' || c === '`' || c === '~') {
            srcIdx++;
            continue;
        }
        if (c === '[') {
            srcIdx++;
            continue;
        }
        if (c === ']' && source[srcIdx + 1] === '(') {
            const close = source.indexOf(')', srcIdx + 2);
            if (close !== -1) {
                srcIdx = close + 1;
                continue;
            }
        }
        srcIdx++;
        visIdx++;
    }
    return srcIdx;
}

function getLineOffset(source, lineIndex) {
    let offset = 0;
    const lines = source.split('\n');
    for (let i = 0; i < lineIndex && i < lines.length; i++) {
        offset += lines[i].length + 1; // +1 for \n
    }
    return offset;
}

function isSpecialLine(line) {
    return /^(#{1,6}\s|[-*+]\s|\d+\.\s|>\s|```|---|\*\*\*|___|\|)/.test(line.trim());
}

function stripInlineMarkdown(text) {
    return text
        .replace(/\*\*\*(.*?)\*\*\*/g, '$1')  // bold+italic
        .replace(/\*\*(.*?)\*\*/g, '$1')       // bold
        .replace(/\*(.*?)\*/g, '$1')           // italic
        .replace(/~~(.*?)~~/g, '$1')           // strikethrough
        .replace(/`(.*?)`/g, '$1')             // inline code
        .replace(/\[(.*?)\]\(.*?\)/g, '$1');   // links
}

function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── Clickable checkboxes ──────────────────────────────────────────────

/**
 * Setup clickable checkboxes in rendered markdown.
 * marked.js renders `- [ ]` / `- [x]` as <input type="checkbox" disabled>.
 * We enable them and toggle the source on click.
 */
export function setupCheckboxes(container) {
    const rendered = container.querySelector('.preview-rendered');
    if (!rendered) return;

    // Enable all task list checkboxes (marked renders them disabled)
    rendered.querySelectorAll('input[type="checkbox"][disabled]').forEach(cb => {
        cb.disabled = false;
        cb.classList.add('md-task-checkbox');
    });

    // Delegate click handling. Re-point the active state to this instance
    // first — toggleCheckboxInSource reads state.content/currentPath.
    const s = state;
    rendered.addEventListener('change', (e) => {
        const cb = e.target;
        if (!cb.classList.contains('md-task-checkbox')) return;
        activateStateInstance(s);
        toggleCheckboxInSource(cb);
    });
}

async function toggleCheckboxInSource(checkbox) {
    const source = state.content;
    if (!source || !state.currentPath) return;

    const li = checkbox.closest('li');
    if (!li) return;

    const isNowChecked = checkbox.checked;
    const oldMark = isNowChecked ? '[ ]' : '[x]';
    const newMark = isNowChecked ? '[x]' : '[ ]';

    let newSource;

    // Strategy 1: Use source map attributes (precise byte range)
    const srcStart = li.getAttribute('data-source-start');
    const srcEnd = li.getAttribute('data-source-end');
    if (srcStart != null && srcEnd != null) {
        const start = parseInt(srcStart, 10);
        const end = parseInt(srcEnd, 10);
        const liRaw = source.substring(start, end);
        const replaced = liRaw.replace(oldMark, newMark);
        if (replaced === liRaw) {
            checkbox.checked = !isNowChecked;
            return;
        }
        newSource = source.substring(0, start) + replaced + source.substring(end);
    } else {
        // Strategy 2: Fuzzy text matching fallback
        const taskText = li.textContent.trim();
        const lines = source.split('\n');
        let matchIdx = -1;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const taskMatch = line.match(/^(\s*(?:[-*+]|\d+\.)\s+)\[([ xX])\]\s*/);
            if (!taskMatch) continue;
            const lineText = line.slice(taskMatch.index + taskMatch[0].length).trim();
            const strippedLineText = stripInlineMarkdown(lineText);
            if (taskText === lineText || taskText === strippedLineText ||
                taskText.startsWith(lineText) || taskText.startsWith(strippedLineText)) {
                const currentMark = taskMatch[2];
                const wasChecked = currentMark === 'x' || currentMark === 'X';
                if (wasChecked !== isNowChecked) {
                    matchIdx = i;
                    break;
                }
            }
        }
        if (matchIdx === -1) {
            checkbox.checked = !isNowChecked;
            return;
        }
        lines[matchIdx] = lines[matchIdx].replace(oldMark, newMark);
        newSource = lines.join('\n');
    }

    // Save
    try {
        await writeSource(newSource);
        state.content = newSource;
    } catch (err) {
        console.error('[InlineEdit] Checkbox save failed:', err);
        // Revert on failure
        checkbox.checked = !isNowChecked;
        showToast(saveFailedMsg(err));
    }
}
