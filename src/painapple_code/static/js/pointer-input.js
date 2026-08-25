/**
 * Pointer modality — is a real cursor driving the UI right now?
 *
 * CSS cannot answer this on iPadOS. `(hover: none) and (pointer: coarse)`
 * matches whether the user is prodding the glass with a finger or sweeping a
 * Magic Keyboard trackpad cursor: the query describes the device's WEAKEST
 * input, not the one in use. Only runtime pointer events disambiguate — a
 * trackpad reports `pointerType: 'mouse'`, a finger reports `'touch'`.
 *
 * Owns `body.fine-pointer` so CSS can re-enable cursor-only affordances that
 * must stay off for taps (see the shortcut-hint rows in 40-input.css).
 *
 * Deliberately NOT context-menu.js's `lastInputWasTouch()`, for two reasons:
 *   - That tracker defaults to 'mouse'. Here that would arm clickable rows
 *     before the first touch ever lands, which is the accidental-tap hazard
 *     the gate exists to prevent. This one starts unarmed on coarse devices.
 *   - It listens only to `pointerdown`. A click's target is resolved from its
 *     pointerdown/pointerup targets, so flipping a class at pointerdown is
 *     already too late — the press lands on whatever sat underneath. Tracking
 *     `pointermove` arms on hover, before any button goes down.
 */

const COARSE_QUERY = '(hover: none) and (pointer: coarse)';

// Unarmed wherever the device CAN be finger-driven. A desktop with a real
// mouse matches nothing here and is armed from the first paint.
let fine = !(typeof matchMedia === 'function' && matchMedia(COARSE_QUERY).matches);

function apply() {
    document.body?.classList.toggle('fine-pointer', fine);
}

function note(pointerType) {
    if (!pointerType) return;
    // 'pen' counts as coarse: an Apple Pencil tap carries the same
    // fire-whatever-is-under-the-tip risk a fingertip does.
    const next = pointerType === 'mouse';
    if (next === fine) return;
    fine = next;
    apply();
}

if (typeof document !== 'undefined') {
    // capture+passive: never interferes with anything downstream, and the
    // pointermove flood costs one string compare that early-returns.
    for (const type of ['pointermove', 'pointerdown', 'pointerover']) {
        document.addEventListener(type, (e) => note(e.pointerType), { capture: true, passive: true });
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', apply);
    } else {
        apply();
    }
}

/** True when a real cursor (mouse/trackpad) drove the most recent input. */
export function hasFinePointer() {
    return fine;
}
