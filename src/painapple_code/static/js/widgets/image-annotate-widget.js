/**
 * ImageAnnotateWidget - Draw on an image before uploading
 *
 * Paint-style editor opened when the user pastes an image (Cmd/Ctrl+V).
 * Tools: numbered comment markers, freehand pen, arrow, rectangle, ellipse,
 * text; color swatches, three stroke sizes, undo/redo. "Attach annotated"
 * exports the canvas as PNG and hands it back; "Attach original" skips
 * editing. Enter accepts (attach annotated); Escape cancels — but once
 * anything has been drawn, Escape/Cancel arm an inline "Discard changes?"
 * confirm and a second press within 4s actually discards.
 *
 * Marker tool (default): click drops a numbered yellow badge and opens a
 * floating comment box. The comment is NOT drawn on the image — onDone
 * receives it as {n, note} so the caller can attach it to the Comments
 * Stash, keeping prose as prompt text while the badge anchors the spot.
 * Committed comments stay visible as a DOM bubble beside the badge
 * (never rasterized into the exported PNG); clicking the bubble or the
 * badge re-opens the comment for editing.
 *
 * Vector model: the base image plus a shapes array, fully redrawn on every
 * change — undo/redo are just stack pops, no pixel snapshots.
 */

import { WidgetManager } from '../widget-system/index.js';
import { isAnnotateOnPasteEnabled, state as configState } from './config/state.js';
import { withChords } from '../shortcuts.js';
import S from '../strings.js';

// ═══════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════

// Server resizes uploads to 1568px anyway — cap the canvas so huge retina
// screenshots don't allocate hundreds of MB of pixel buffers.
const MAX_CANVAS_DIM = 3000;

const state = {
    img: null,          // loaded HTMLImageElement (base picture)
    objectUrl: null,    // blob URL backing img (revoked on close)
    fileName: null,     // original file name, for the exported file
    shapes: [],
    redoStack: [],
    tool: 'marker',     // 'marker' | 'pen' | 'arrow' | 'rect' | 'ellipse' | 'text'
    color: '#ff3b30',
    stroke: 'm',        // 's' | 'm' | 'l'
    callbacks: null,    // {onDone, onSkip, onCancel}
    settled: false,     // a callback has fired — ignore further outcomes
};

const COLORS = ['#ff3b30', '#ffcc00', '#34c759', '#0a84ff', '#ffffff', '#111111'];

let canvas = null;
let ctx2d = null;
let drawing = null;     // in-progress shape during a pointer drag
let markerDrag = null;  // {shape, startX, startY, moved} while dragging a badge
let hoverPt = null;     // cursor position for the marker ghost preview
let _keyHandler = null;
let _discardArmed = false;   // ESC/Cancel while dirty arms a confirm; second one discards
let _discardTimer = null;    // auto-disarm timeout

// ═══════════════════════════════════════════════════════════════════════════
// GEOMETRY / DRAWING
// ═══════════════════════════════════════════════════════════════════════════

/** Scale factor so strokes stay visible on large images. */
function sizeK() {
    return Math.max(1, (canvas?.width || 1000) / 1000);
}

function strokeWidth(choice = state.stroke) {
    const k = sizeK();
    return { s: 2.5, m: 5, l: 9 }[choice] * k;
}

function fontSize(choice = state.stroke) {
    const k = sizeK();
    return Math.round({ s: 18, m: 28, l: 42 }[choice] * k);
}

function markerRadius(choice = state.stroke) {
    const k = sizeK();
    return Math.round({ s: 11, m: 15, l: 21 }[choice] * k);
}

function markerShapes() {
    return state.shapes.filter(s => s.type === 'marker');
}

/** Map a pointer event to canvas-internal coordinates. */
function canvasPoint(e) {
    const r = canvas.getBoundingClientRect();
    return {
        x: (e.clientX - r.left) * canvas.width / r.width,
        y: (e.clientY - r.top) * canvas.height / r.height,
    };
}

function drawShape(s) {
    const c = ctx2d;
    c.strokeStyle = s.color;
    c.fillStyle = s.color;
    c.lineWidth = s.w;
    c.lineCap = 'round';
    c.lineJoin = 'round';

    if (s.type === 'pen') {
        if (s.points.length < 2) {
            c.beginPath();
            c.arc(s.points[0].x, s.points[0].y, s.w / 2, 0, Math.PI * 2);
            c.fill();
            return;
        }
        c.beginPath();
        c.moveTo(s.points[0].x, s.points[0].y);
        for (let i = 1; i < s.points.length; i++) c.lineTo(s.points[i].x, s.points[i].y);
        c.stroke();
    } else if (s.type === 'rect') {
        c.strokeRect(Math.min(s.x1, s.x2), Math.min(s.y1, s.y2),
            Math.abs(s.x2 - s.x1), Math.abs(s.y2 - s.y1));
    } else if (s.type === 'ellipse') {
        c.beginPath();
        c.ellipse((s.x1 + s.x2) / 2, (s.y1 + s.y2) / 2,
            Math.abs(s.x2 - s.x1) / 2, Math.abs(s.y2 - s.y1) / 2, 0, 0, Math.PI * 2);
        c.stroke();
    } else if (s.type === 'arrow') {
        const angle = Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
        const head = Math.max(12, s.w * 3.5);
        // Stop the shaft short of the tip so it doesn't poke through the head
        const shaftX = s.x2 - head * 0.6 * Math.cos(angle);
        const shaftY = s.y2 - head * 0.6 * Math.sin(angle);
        c.beginPath();
        c.moveTo(s.x1, s.y1);
        c.lineTo(shaftX, shaftY);
        c.stroke();
        c.beginPath();
        c.moveTo(s.x2, s.y2);
        c.lineTo(s.x2 - head * Math.cos(angle - Math.PI / 7), s.y2 - head * Math.sin(angle - Math.PI / 7));
        c.lineTo(s.x2 - head * Math.cos(angle + Math.PI / 7), s.y2 - head * Math.sin(angle + Math.PI / 7));
        c.closePath();
        c.fill();
    } else if (s.type === 'text') {
        c.font = `600 ${s.size}px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`;
        c.textBaseline = 'top';
        c.shadowColor = 'rgba(0, 0, 0, 0.55)';
        c.shadowBlur = Math.max(2, s.size / 8);
        c.fillText(s.text, s.x, s.y);
        c.shadowColor = 'transparent';
        c.shadowBlur = 0;
    } else if (s.type === 'marker') {
        // Numbered comment badge — fixed yellow so markers read as one
        // family regardless of the drawing color
        c.beginPath();
        c.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        c.fillStyle = '#ffcc00';
        c.shadowColor = 'rgba(0, 0, 0, 0.45)';
        c.shadowBlur = Math.max(3, s.r * 0.4);
        c.fill();
        c.shadowColor = 'transparent';
        c.shadowBlur = 0;
        c.lineWidth = Math.max(1.5, s.r * 0.11);
        c.strokeStyle = 'rgba(0, 0, 0, 0.55)';
        c.stroke();
        c.fillStyle = '#111111';
        c.font = `700 ${Math.round(s.r * 1.2)}px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`;
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.fillText(String(s.n), s.x, s.y + s.r * 0.06);
        c.textAlign = 'start';
        c.textBaseline = 'alphabetic';
    }
}

/** Translucent preview of the next badge, following the cursor. */
function drawGhostMarker(pt) {
    const c = ctx2d;
    c.save();
    c.globalAlpha = 0.5;
    drawShape({ type: 'marker', x: pt.x, y: pt.y, r: markerRadius(), n: markerShapes().length + 1 });
    c.restore();
}

function redraw() {
    if (!ctx2d || !state.img) return;
    ctx2d.clearRect(0, 0, canvas.width, canvas.height);
    ctx2d.drawImage(state.img, 0, 0, canvas.width, canvas.height);
    for (const s of state.shapes) drawShape(s);
    if (drawing) drawShape(drawing);
    syncMarkerNotes();
    // Ghost of the next marker under the cursor — never while dragging,
    // editing a comment, or hovering an existing badge (that click edits)
    if (state.tool === 'marker' && hoverPt && !drawing && !markerDrag && !_markerEditing) {
        const overBadge = markerShapes().some(m =>
            Math.hypot(hoverPt.x - m.x, hoverPt.y - m.y) <= m.r * 1.3);
        if (!overBadge) drawGhostMarker(hoverPt);
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// POINTER INPUT
// ═══════════════════════════════════════════════════════════════════════════

function onPointerDown(e) {
    if (e.button !== undefined && e.button !== 0) return;
    disarmDiscard();   // drawing again cancels a pending discard confirm
    commitTextInput();
    commitMarkerInput();

    const pt = canvasPoint(e);
    if (state.tool === 'marker') {
        // Same focus-steal cancel as the text tool — the comment input must
        // survive the trusted click's default focus change
        e.preventDefault();
        const hit = [...markerShapes()].reverse().find(m =>
            Math.hypot(pt.x - m.x, pt.y - m.y) <= m.r * 1.3);
        if (hit) {
            // Begin a potential drag; a click (no movement) opens the comment
            // box on pointerup, a drag repositions the badge instead
            markerDrag = { shape: hit, startX: pt.x, startY: pt.y, moved: false };
            try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
            return;
        }
        const marker = {
            type: 'marker',
            x: pt.x,
            y: pt.y,
            r: markerRadius(),
            n: markerShapes().length + 1,
            note: '',
        };
        state.shapes.push(marker);
        state.redoStack = [];
        hoverPt = null;   // the badge now sits here; drop the ghost
        redraw();
        updateToolbar();
        openMarkerInput(marker, true);
        return;
    }
    if (state.tool === 'text') {
        // Cancel the click's default focus change — it lands right after we
        // focus the floating input and would blur-commit it empty (real
        // clicks only; synthetic test events have no default actions)
        e.preventDefault();
        openTextInput(pt);
        return;
    }

    e.preventDefault();
    // Capture can throw if the pointer is already gone (or synthetic in tests)
    try { canvas.setPointerCapture(e.pointerId); } catch { /* draw uncaptured */ }
    const w = strokeWidth();
    drawing = state.tool === 'pen'
        ? { type: 'pen', points: [pt], color: state.color, w }
        : { type: state.tool, x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y, color: state.color, w };
    redraw();
}

function onPointerMove(e) {
    if (markerDrag) {
        e.preventDefault();
        const pt = canvasPoint(e);
        if (!markerDrag.moved
            && Math.hypot(pt.x - markerDrag.startX, pt.y - markerDrag.startY) > 3) {
            markerDrag.moved = true;
        }
        if (markerDrag.moved) {
            markerDrag.shape.x = Math.max(0, Math.min(canvas.width, pt.x));
            markerDrag.shape.y = Math.max(0, Math.min(canvas.height, pt.y));
            redraw();
        }
        return;
    }
    // Marker ghost preview — track the cursor when nothing is in progress
    if (state.tool === 'marker' && !drawing) {
        hoverPt = canvasPoint(e);
        redraw();
        return;
    }
    if (!drawing) return;
    e.preventDefault();
    const pt = canvasPoint(e);
    if (drawing.type === 'pen') {
        const last = drawing.points[drawing.points.length - 1];
        if (Math.hypot(pt.x - last.x, pt.y - last.y) > 1.5) drawing.points.push(pt);
    } else {
        drawing.x2 = pt.x;
        drawing.y2 = pt.y;
    }
    redraw();
}

function onPointerLeave() {
    if (hoverPt) { hoverPt = null; redraw(); }
}

function onPointerUp(e) {
    if (markerDrag) {
        const { shape, moved } = markerDrag;
        markerDrag = null;
        try { canvas.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
        if (moved) redraw();          // repositioned — note preserved
        else openMarkerInput(shape, false);   // a plain click edits the comment
        return;
    }
    if (!drawing) return;
    // Discard zero-size accidental taps for shape tools (pen keeps its dot)
    const degenerate = drawing.type !== 'pen'
        && Math.hypot(drawing.x2 - drawing.x1, drawing.y2 - drawing.y1) < 3;
    if (!degenerate) {
        state.shapes.push(drawing);
        state.redoStack = [];
    }
    drawing = null;
    redraw();
    updateToolbar();
}

// ═══════════════════════════════════════════════════════════════════════════
// TEXT TOOL
// ═══════════════════════════════════════════════════════════════════════════

function currentTextInput() {
    return document.querySelector('#widget-image-annotate .ia-text-input');
}

/** Commit the floating text input (if any) as a text shape. */
function commitTextInput() {
    const input = currentTextInput();
    // The closing guard breaks blur re-entrancy: input.remove() fires blur,
    // whose handler calls commit again while the node is still attached —
    // without the guard that double-commits the shape and the second
    // remove() throws NotFoundError
    if (!input || input.dataset.closing) return;
    input.dataset.closing = '1';
    const text = input.value.trim();
    if (text) {
        state.shapes.push({
            type: 'text',
            x: parseFloat(input.dataset.x),
            y: parseFloat(input.dataset.y),
            text,
            color: input.dataset.color,
            size: parseFloat(input.dataset.size),
        });
        state.redoStack = [];
    }
    input.remove();
    redraw();
    updateToolbar();
}

function cancelTextInput() {
    const input = currentTextInput();
    if (!input || input.dataset.closing) return;
    input.dataset.closing = '1';
    input.remove();
}

function openTextInput(pt) {
    const wrap = canvas.closest('.ia-canvas-wrap');
    const r = canvas.getBoundingClientRect();
    const wr = wrap.getBoundingClientRect();
    const scale = r.width / canvas.width;
    const size = fontSize();

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'ia-text-input';
    // Claim Enter/Escape so the app's global Escape shortcut doesn't close
    // the whole editor out from under the input (shortcuts.js honors this)
    input.dataset.shortcutsDisabled = 'enter,escape';
    input.placeholder = S.widgets.image_annotate.text_placeholder;
    input.style.left = `${r.left - wr.left + pt.x * scale}px`;
    input.style.top = `${r.top - wr.top + pt.y * scale}px`;
    input.style.fontSize = `${Math.max(12, size * scale)}px`;
    input.style.color = state.color;
    input.dataset.x = pt.x;
    input.dataset.y = pt.y;
    input.dataset.color = state.color;
    input.dataset.size = size;

    input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') commitTextInput();
        else if (e.key === 'Escape') cancelTextInput();
    });
    input.addEventListener('blur', () => commitTextInput());

    wrap.appendChild(input);
    input.focus();
}

// ═══════════════════════════════════════════════════════════════════════════
// MARKER TOOL — numbered badges whose comments go to the stash, not the image
// ═══════════════════════════════════════════════════════════════════════════

let _markerEditing = null;   // {shape, isNew} while the comment box is open
let _markerIdSeq = 0;        // stable DOM keys for the comment bubbles

function currentMarkerInput() {
    return document.querySelector('#widget-image-annotate .ia-marker-input');
}

/** Place a floating element beside a badge; flip left when it would overflow. */
function positionBesideMarker(el, shape, wrap) {
    const r = canvas.getBoundingClientRect();
    const wr = wrap.getBoundingClientRect();
    const scale = r.width / canvas.width;
    const bx = r.left - wr.left + shape.x * scale;
    const by = r.top - wr.top + shape.y * scale;
    const pad = shape.r * scale + 8;
    if (bx + pad + 240 > wr.width) {
        el.style.left = 'auto';
        el.style.right = `${wr.width - bx + pad}px`;
    } else {
        el.style.right = 'auto';
        el.style.left = `${bx + pad}px`;
    }
    el.style.top = `${by}px`;
    el.style.transform = 'translateY(-50%)';
}

/**
 * Keep a read-only comment bubble beside every badge that has a note, so
 * committed comments stay visible and clickable (click re-opens the edit
 * box). DOM overlay only — never rasterized into the exported PNG. Runs on
 * every redraw; nodes are keyed by a per-shape id and updated in place.
 */
function syncMarkerNotes() {
    const wrap = canvas?.closest('.ia-canvas-wrap');
    if (!wrap) return;
    const live = new Set();
    for (const m of markerShapes()) {
        // No bubble while empty or while its edit box replaces it
        if (!m.note || _markerEditing?.shape === m) continue;
        if (!m.id) m.id = String(++_markerIdSeq);
        live.add(m.id);
        let el = wrap.querySelector(`.ia-marker-note[data-marker-id="${m.id}"]`);
        if (!el) {
            el = document.createElement('div');
            el.className = 'ia-marker-note';
            el.dataset.markerId = m.id;
            el.setAttribute('data-tooltip', S.widgets.image_annotate.marker_note_edit);
            // Keep focus where it is so a peer comment box's blur→commit
            // runs before our click (same trick as the delete button)
            el.addEventListener('pointerdown', (e) => e.preventDefault());
            el.addEventListener('mousedown', (e) => e.preventDefault());
            el.addEventListener('click', (e) => {
                e.stopPropagation();
                openMarkerInput(m, false);
            });
            wrap.appendChild(el);
        }
        if (el.textContent !== m.note) el.textContent = m.note;
        positionBesideMarker(el, m, wrap);
    }
    wrap.querySelectorAll('.ia-marker-note').forEach(el => {
        if (!live.has(el.dataset.markerId)) el.remove();
    });
}

/** Remove the whole comment box (input + delete button), not just the input. */
function removeMarkerBox(input) {
    (input.closest('.ia-marker-box') || input).remove();
}

/** Renumber remaining markers so badges always read 1, 2, 3… with no gaps. */
function renumberMarkers() {
    markerShapes().forEach((m, i) => { m.n = i + 1; });
}

/** Save the open comment box (if any) onto its marker shape. */
function commitMarkerInput() {
    const input = currentMarkerInput();
    // Same blur re-entrancy guard as commitTextInput
    if (!input || input.dataset.closing) return;
    input.dataset.closing = '1';
    if (_markerEditing) _markerEditing.shape.note = input.value.trim();
    _markerEditing = null;
    removeMarkerBox(input);
    syncMarkerNotes();   // the committed comment reappears as a bubble
}

/** Close the comment box; a brand-new marker with no comment is removed. */
function cancelMarkerInput() {
    const input = currentMarkerInput();
    if (!input || input.dataset.closing) return;
    input.dataset.closing = '1';
    if (_markerEditing?.isNew && !_markerEditing.shape.note) {
        const idx = state.shapes.indexOf(_markerEditing.shape);
        if (idx !== -1) state.shapes.splice(idx, 1);
        renumberMarkers();
        redraw();
        updateToolbar();
    }
    _markerEditing = null;
    removeMarkerBox(input);
    syncMarkerNotes();   // an untouched existing note gets its bubble back
}

/** Delete the marker whose comment box is open, then renumber + redraw. */
function deleteMarkerInput() {
    const input = currentMarkerInput();
    if (!input || input.dataset.closing) return;
    input.dataset.closing = '1';
    if (_markerEditing) {
        const idx = state.shapes.indexOf(_markerEditing.shape);
        if (idx !== -1) state.shapes.splice(idx, 1);
        renumberMarkers();
        redraw();
        updateToolbar();
    }
    _markerEditing = null;
    removeMarkerBox(input);
    syncMarkerNotes();
}

function openMarkerInput(shape, isNew) {
    commitMarkerInput();
    _markerEditing = { shape, isNew };
    syncMarkerNotes();   // hide this marker's bubble — the edit box replaces it

    const wrap = canvas.closest('.ia-canvas-wrap');
    const box = document.createElement('div');
    box.className = 'ia-marker-box';

    // Textarea, not <input> — longer descriptions are normal here since the
    // comment travels as prompt text. Enter commits, Shift+Enter adds a line.
    const input = document.createElement('textarea');
    input.rows = 1;
    input.className = 'ia-marker-input';
    // Claim Enter/Escape from the app's global shortcut handler (see above)
    input.dataset.shortcutsDisabled = 'enter,escape';
    input.placeholder = S.widgets.image_annotate.marker_placeholder.replace('{n}', shape.n);
    input.value = shape.note || '';
    // Auto-grow with content up to the CSS max-height, then scroll
    const autogrow = () => {
        input.style.height = 'auto';
        input.style.height = `${Math.min(input.scrollHeight, 132)}px`;
    };
    input.addEventListener('input', autogrow);

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'ia-marker-delete';
    del.innerHTML = TRASH_ICON;
    del.setAttribute('data-tooltip', S.widgets.image_annotate.marker_delete);
    del.setAttribute('aria-label', S.widgets.image_annotate.marker_delete);
    // Keep focus on the input so its blur→commit doesn't fire before the click
    del.addEventListener('pointerdown', (e) => e.preventDefault());
    del.addEventListener('mousedown', (e) => e.preventDefault());
    del.addEventListener('click', (e) => { e.stopPropagation(); deleteMarkerInput(); });

    box.appendChild(input);
    box.appendChild(del);

    // Sit beside the badge; flip to the left when it would overflow
    positionBesideMarker(box, shape, wrap);

    input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();   // don't insert a newline into the dying textarea
            commitMarkerInput();
        } else if (e.key === 'Escape') cancelMarkerInput();
    });
    input.addEventListener('blur', () => commitMarkerInput());

    wrap.appendChild(box);
    autogrow();   // size to any existing note (needs the DOM for scrollHeight)
    input.focus();
    // Caret at the end — re-editing usually means appending
    input.setSelectionRange(input.value.length, input.value.length);
}

/** Markers that carry a comment, for the onDone callback. */
function collectMarkers() {
    return markerShapes()
        .filter(m => m.note)
        .map(m => ({ n: m.n, note: m.note }));
}

// ═══════════════════════════════════════════════════════════════════════════
// UNDO / REDO
// ═══════════════════════════════════════════════════════════════════════════

function undoOp() {
    if (!state.shapes.length) return;
    state.redoStack.push(state.shapes.pop());
    redraw();
    updateToolbar();
}

function redoOp() {
    if (!state.redoStack.length) return;
    state.shapes.push(state.redoStack.pop());
    redraw();
    updateToolbar();
}

// ═══════════════════════════════════════════════════════════════════════════
// OUTCOMES
// ═══════════════════════════════════════════════════════════════════════════

/** Fire one of onSkip/onCancel exactly once and close. */
function settle(kind) {
    if (state.settled) return;
    state.settled = true;
    const cbs = state.callbacks || {};
    if (kind === 'skip') cbs.onSkip?.();
    else cbs.onCancel?.();
    WidgetManager.close('image-annotate');
}

/** True once the user has drawn/placed anything — closing would lose work. */
function isDirty() {
    return state.shapes.length > 0;
}

/** Clear the armed-discard confirmation and restore the Cancel button label. */
function disarmDiscard() {
    if (_discardTimer) { clearTimeout(_discardTimer); _discardTimer = null; }
    if (!_discardArmed) return;
    _discardArmed = false;
    const btn = document.querySelector('#widget-image-annotate .ia-cancel');
    if (btn) { btn.classList.remove('armed'); btn.textContent = S.widgets.image_annotate.cancel; }
}

/**
 * Cancel intent from ESC or the Cancel button. Clean (no drawings) → discard
 * immediately. Dirty → first press arms an inline "Discard changes?" confirm
 * (window.confirm() silently no-ops in the iPad PWA — use the two-step
 * armed-button pattern instead); a second press within the window discards.
 */
function requestCancel() {
    if (!isDirty()) { settle('cancel'); return; }
    if (_discardArmed) { disarmDiscard(); settle('cancel'); return; }
    _discardArmed = true;
    const btn = document.querySelector('#widget-image-annotate .ia-cancel');
    if (btn) { btn.classList.add('armed'); btn.textContent = S.widgets.image_annotate.confirm_discard; }
    _discardTimer = setTimeout(disarmDiscard, 4000);
}

/** Export the annotated canvas as PNG, fire onDone, close. */
function finishDone() {
    if (state.settled) return;
    commitTextInput();
    commitMarkerInput();
    state.settled = true;
    drawing = null;
    markerDrag = null;
    hoverPt = null;   // never burn the ghost preview into the exported PNG
    redraw();
    const cbs = state.callbacks || {};
    const markers = collectMarkers();
    canvas.toBlob((blob) => {
        if (blob) cbs.onDone?.(blob, markers);
        else cbs.onSkip?.();  // export failed — fall back to the original
        WidgetManager.close('image-annotate');
    }, 'image/png');
}

// ═══════════════════════════════════════════════════════════════════════════
// KEYBOARD
// ═══════════════════════════════════════════════════════════════════════════

function attachKeyboard() {
    detachKeyboard();
    _keyHandler = (e) => {
        if (!WidgetManager.isOpen('image-annotate')) return;
        const inText = e.target.classList?.contains('ia-text-input');
        const inMarker = e.target.classList?.contains('ia-marker-input');
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            if (inText) cancelTextInput();
            else if (inMarker) cancelMarkerInput();
            else requestCancel();
            return;
        }
        if (inText || inMarker) return;
        const mod = e.metaKey || e.ctrlKey;
        if (mod && e.key.toLowerCase() === 'z') {
            e.preventDefault();
            e.stopPropagation();
            if (e.shiftKey) redoOp(); else undoOp();
        } else if (e.key === 'Enter') {
            // Plain Enter accepts (attach annotated) — Cmd/Ctrl+Enter too.
            // The floating text/marker inputs claim Enter themselves and
            // stopPropagation, so this only fires with no input focused.
            e.preventDefault();
            e.stopPropagation();
            finishDone();
        }
    };
    // Capture phase so app-level shortcuts don't fire while the editor is up
    document.addEventListener('keydown', _keyHandler, true);
}

function detachKeyboard() {
    if (_keyHandler) {
        document.removeEventListener('keydown', _keyHandler, true);
        _keyHandler = null;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// TOOLBAR
// ═══════════════════════════════════════════════════════════════════════════

const TOOL_ICONS = {
    marker: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M10 9.5l2.5-2v9"/></svg>',
    pen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>',
    arrow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="19" x2="19" y2="5"/><polyline points="9 5 19 5 19 15"/></svg>',
    rect: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="6" width="16" height="12" rx="1"/></svg>',
    ellipse: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="12" rx="8" ry="6"/></svg>',
    text: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="5 7 5 4 19 4 19 7"/><line x1="12" y1="4" x2="12" y2="20"/><line x1="9" y1="20" x2="15" y2="20"/></svg>',
};

// Not a tool — used inside the marker comment box's delete button
const TRASH_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>';

const UNDO_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-15-6.7L3 13"/></svg>';
const REDO_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0 1 15-6.7L21 13"/></svg>';

function toolbarHtml() {
    const T = S.widgets.image_annotate;
    const toolTips = { marker: T.tool_marker, pen: T.tool_pen, arrow: T.tool_arrow, rect: T.tool_rect, ellipse: T.tool_ellipse, text: T.tool_text };
    const tools = Object.keys(TOOL_ICONS).map(t =>
        `<button class="ia-tool-btn" data-tool="${t}" data-tooltip="${toolTips[t]}">${TOOL_ICONS[t]}</button>`
    ).join('');
    const colors = COLORS.map(c =>
        `<button class="ia-color-btn" data-color="${c}" style="--ia-swatch: ${c}" data-tooltip="${T.color}"></button>`
    ).join('');
    const strokeTips = { s: T.stroke_small, m: T.stroke_medium, l: T.stroke_large };
    const strokes = ['s', 'm', 'l'].map(w =>
        `<button class="ia-stroke-btn" data-stroke="${w}" data-tooltip="${strokeTips[w]}"><span class="ia-stroke-dot ia-stroke-${w}"></span></button>`
    ).join('');

    return `
        <div class="ia-toolbar">
            <div class="ia-tool-group">${tools}</div>
            <span class="ia-sep"></span>
            <div class="ia-tool-group">${colors}</div>
            <span class="ia-sep"></span>
            <div class="ia-tool-group">${strokes}</div>
            <span class="ia-sep"></span>
            <div class="ia-tool-group">
                <button class="ia-tool-btn ia-undo" data-tooltip="${withChords(T.undo)}">${UNDO_ICON}</button>
                <button class="ia-tool-btn ia-redo" data-tooltip="${withChords(T.redo)}">${REDO_ICON}</button>
            </div>
            <span class="ia-spacer"></span>
            <label class="ia-paste-toggle" data-tooltip="${T.paste_toggle_tip}">
                <input type="checkbox" class="ia-paste-cb"${isAnnotateOnPasteEnabled() ? ' checked' : ''}>
                <span>${T.paste_toggle}</span>
            </label>
            <div class="ia-tool-group ia-actions">
                <button class="ia-btn ia-cancel">${T.cancel}</button>
                <button class="ia-btn ia-skip">${T.skip}</button>
                <button class="ia-btn ia-btn-primary ia-done">${T.done}</button>
            </div>
        </div>
    `;
}

function updateToolbar() {
    const root = document.querySelector('#widget-image-annotate .image-annotate-modal');
    if (!root) return;
    root.querySelectorAll('.ia-tool-btn[data-tool]').forEach(b =>
        b.classList.toggle('active', b.dataset.tool === state.tool));
    root.querySelectorAll('.ia-color-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.color === state.color));
    root.querySelectorAll('.ia-stroke-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.stroke === state.stroke));
    const undoBtn = root.querySelector('.ia-undo');
    const redoBtn = root.querySelector('.ia-redo');
    if (undoBtn) undoBtn.disabled = state.shapes.length === 0;
    if (redoBtn) redoBtn.disabled = state.redoStack.length === 0;
}

// ═══════════════════════════════════════════════════════════════════════════
// WIDGET REGISTRATION
// ═══════════════════════════════════════════════════════════════════════════

export function registerImageAnnotateWidget() {
    WidgetManager.register('image-annotate', {
        title: S.widgets.titles.image_annotate,
        icon: 'image',
        type: 'modal',
        hideHeader: true,
        closeOnBackdrop: false,   // a stray click must not discard drawings
        closeOnEscape: false,     // own Escape handling (text input vs cancel)
        maxWidth: '96vw',
        maxHeight: '96vh',
        scope: 'global',
        sessionAware: false,
        hiddenInPicker: true,

        onClose() {
            // Closed without an explicit outcome (safety net) → cancel
            if (!state.settled) {
                state.settled = true;
                state.callbacks?.onCancel?.();
            }
            cancelTextInput();
            _markerEditing = null;
            const mi = currentMarkerInput();
            if (mi) removeMarkerBox(mi);
            if (_discardTimer) { clearTimeout(_discardTimer); _discardTimer = null; }
            _discardArmed = false;
            detachKeyboard();
            drawing = null;
            markerDrag = null;
            hoverPt = null;
            if (state.objectUrl) {
                URL.revokeObjectURL(state.objectUrl);
                state.objectUrl = null;
            }
            // Return focus to the chat input so typing can resume immediately.
            window.app?.focusInput?.();
        },

        render(container) {
            if (!state.img) return;

            container.innerHTML = `
                <div class="image-annotate-modal">
                    ${toolbarHtml()}
                    <div class="ia-canvas-wrap">
                        <canvas class="ia-canvas"></canvas>
                    </div>
                </div>
            `;

            canvas = container.querySelector('.ia-canvas');
            const scale = Math.min(1, MAX_CANVAS_DIM / Math.max(state.img.naturalWidth, state.img.naturalHeight));
            canvas.width = Math.max(1, Math.round(state.img.naturalWidth * scale));
            canvas.height = Math.max(1, Math.round(state.img.naturalHeight * scale));
            ctx2d = canvas.getContext('2d');

            canvas.addEventListener('pointerdown', onPointerDown);
            canvas.addEventListener('pointermove', onPointerMove);
            canvas.addEventListener('pointerup', onPointerUp);
            canvas.addEventListener('pointercancel', onPointerUp);
            canvas.addEventListener('pointerleave', onPointerLeave);
            // Canceling pointerdown should suppress mousedown's focus-steal per
            // spec, but not every browser links them — block it directly too so
            // the text tool's floating input keeps focus
            canvas.addEventListener('mousedown', (e) => e.preventDefault());

            const root = container.querySelector('.image-annotate-modal');
            root.querySelector('.ia-toolbar').addEventListener('click', (e) => {
                const btn = e.target.closest('button');
                if (!btn) return;
                // Any action other than confirming the discard resumes editing
                if (!btn.classList.contains('ia-cancel')) disarmDiscard();
                if (btn.dataset.tool) { state.tool = btn.dataset.tool; hoverPt = null; redraw(); }
                else if (btn.dataset.color) state.color = btn.dataset.color;
                else if (btn.dataset.stroke) state.stroke = btn.dataset.stroke;
                else if (btn.classList.contains('ia-undo')) return undoOp();
                else if (btn.classList.contains('ia-redo')) return redoOp();
                else if (btn.classList.contains('ia-cancel')) return requestCancel();
                else if (btn.classList.contains('ia-skip')) return settle('skip');
                else if (btn.classList.contains('ia-done')) return finishDone();
                updateToolbar();
            });

            // Persist the "open editor on paste" setting straight from the toolbar
            root.querySelector('.ia-paste-cb')?.addEventListener('change', (e) => {
                configState.setAnnotateOnPaste(e.target.checked);
            });

            redraw();
            updateToolbar();
        }
    });
}

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Open the annotation editor for an image blob/file.
 *
 * @param {Blob|File} blob - The image to annotate
 * @param {Object} callbacks
 * @param {Function} callbacks.onDone - (pngBlob, markers) → user finished
 *     annotating; markers is [{n, note}] for badges with a comment, meant
 *     for the Comments Stash
 * @param {Function} callbacks.onSkip - () → attach the original untouched
 * @param {Function} callbacks.onCancel - () → discard entirely
 */
export async function openImageAnnotator(blob, callbacks = {}) {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    try {
        await new Promise((resolve, reject) => {
            img.onload = resolve;
            img.onerror = reject;
            img.src = url;
        });
    } catch {
        // Undecodable image — let the normal upload path deal with it
        URL.revokeObjectURL(url);
        callbacks.onSkip?.();
        return;
    }

    state.img = img;
    state.objectUrl = url;
    state.fileName = blob.name || null;
    state.shapes = [];
    state.redoStack = [];
    state.callbacks = callbacks;
    state.settled = false;
    _markerEditing = null;
    markerDrag = null;
    hoverPt = null;
    _discardArmed = false;
    if (_discardTimer) { clearTimeout(_discardTimer); _discardTimer = null; }

    WidgetManager.open('image-annotate');
    // render() only runs on first creation — force a rebuild for this image
    WidgetManager.update('image-annotate');
    attachKeyboard();
}

export function isImageAnnotatorOpen() {
    return WidgetManager.isOpen('image-annotate');
}

/**
 * Handle ESC while the annotator is open. The app's global shortcut handler
 * claims Escape (stopImmediatePropagation) before this widget's own capture
 * listener can run, so app.handleEscape() routes here to keep the
 * dirty-aware discard confirm working. Cancels an open text/marker input
 * first; otherwise runs the armed-cancel. Returns true if it handled the key.
 */
export function handleAnnotatorEscape() {
    if (!isImageAnnotatorOpen()) return false;
    const el = document.activeElement;
    if (el?.classList?.contains('ia-text-input')) { cancelTextInput(); return true; }
    if (el?.classList?.contains('ia-marker-input')) { cancelMarkerInput(); return true; }
    requestCancel();
    return true;
}

export const ImageAnnotateWidget = {
    open: openImageAnnotator,
    isOpen: isImageAnnotatorOpen,
};
