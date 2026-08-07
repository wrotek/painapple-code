/**
 * KeyboardBar - Terminal keyboard accessory bar for touch devices
 *
 * Embedded inside the terminal widget body (not floating).
 * Provides Esc, Tab, Ctrl, Alt, arrows, and special characters
 * missing from iOS/Android software keyboards.
 *
 * Design:
 * - All buttons use pointerdown + preventDefault to keep xterm focused
 * - Modifiers have two modes:
 *   - Single tap = oneshot (clears after next key)
 *   - Double tap = locked (stays active until tapped again, like caps lock)
 * - Keys sent via callback (WebSocket to PTY), not synthetic events
 * - Exposes hasActiveModifiers()/consumeModifiers() for xterm onData integration
 */

import { DeviceManager } from './widget-system/device-manager.js';
import { HAS_PHYSICAL_KEYBOARD } from './config.js';

const KEYS = [
    { label: 'Esc',  key: 'Escape' },
    { label: 'Tab',  key: 'Tab' },
    { label: 'Ctrl', modifier: 'ctrl', longPressOptions: [
        { label: 'C', key: 'c', desc: 'Interrupt' },
        { label: 'D', key: 'd', desc: 'EOF' },
        { label: 'Z', key: 'z', desc: 'Suspend' },
        { label: 'L', key: 'l', desc: 'Clear' },
        { label: 'A', key: 'a', desc: 'Home' },
        { label: 'E', key: 'e', desc: 'End' },
    ]},
    { label: 'Alt',  modifier: 'alt', longPressOptions: [
        { label: 'D', key: 'd', desc: 'Del word' },
        { label: 'B', key: 'b', desc: 'Back word' },
        { label: 'F', key: 'f', desc: 'Fwd word' },
    ]},
    { type: 'sep' },
    { label: '\u2191', key: 'ArrowUp',    css: 'arrow' },
    { label: '\u2193', key: 'ArrowDown',  css: 'arrow' },
    { label: '\u2190', key: 'ArrowLeft',  css: 'arrow', longPressOptions: [
        { label: 'Alt\u2190', key: 'ArrowLeft', mod: 'alt', desc: 'Back word' },
        { label: 'Ctrl\u2190', key: 'ArrowLeft', mod: 'ctrl', desc: 'Back word' },
    ]},
    { label: '\u2192', key: 'ArrowRight', css: 'arrow', longPressOptions: [
        { label: 'Alt\u2192', key: 'ArrowRight', mod: 'alt', desc: 'Fwd word' },
        { label: 'Ctrl\u2192', key: 'ArrowRight', mod: 'ctrl', desc: 'Fwd word' },
    ]},
    { type: 'sep' },
    { label: '|',  char: '|' },
    { label: '~',  char: '~' },
    { label: '/',  char: '/' },
    { label: '-',  char: '-' },
    { label: '\u232B', key: 'Backspace', css: 'wide' },
    { type: 'sep' },
    { label: '\u{1F4CB}', action: 'paste', css: 'wide', title: 'Paste' },
];

const DOUBLE_TAP_MS = 350;
const LONG_PRESS_MS = 400;
const LONG_PRESS_MOVE_THRESHOLD = 10; // px — cancel if finger moves before timer

export class KeyboardBar {
    /**
     * @param {(key: string, modifiers: {ctrl: boolean, alt: boolean}) => void} sendKeyCallback
     * @param {() => void} [refocusCallback] - Called after every press to refocus terminal
     * @param {object} [options]
     * @param {() => Promise<void>} [options.onPaste] - Called when paste button is pressed
     */
    constructor(sendKeyCallback, refocusCallback, options = {}) {
        this.sendKey = sendKeyCallback;
        this.refocus = refocusCallback || (() => {});
        this._onPaste = options.onPaste || null;
        // Modifier state: 'off' | 'oneshot' | 'locked'
        this._modState = { ctrl: 'off', alt: 'off' };
        this._lastModTap = { ctrl: 0, alt: 0 };
        this.el = null;
        this._modifierButtons = new Map();
        // Long-press state
        this._lpTimer = null;
        this._lpPopup = null;
        this._lpHighlightIdx = -1;
        this._lpDef = null;
        this._lpBtn = null;
        this._lpStartX = 0;
        this._lpStartY = 0;
        this._lpPointerId = null;
        this._boundLpMove = null;
        this._boundLpUp = null;
        this._boundLpCancel = null;
        this._boundDismissTap = null;
    }

    /** Are any modifiers currently active (oneshot or locked)? */
    hasActiveModifiers() {
        return this._modState.ctrl !== 'off' || this._modState.alt !== 'off';
    }

    /** Reset all modifiers to off and dismiss any open popup */
    resetModifiers() {
        this._modState.ctrl = 'off';
        this._modState.alt = 'off';
        this._updateModButton('ctrl');
        this._updateModButton('alt');
        this._cancelLongPress();
        this._dismissPopup();
    }

    /** Get current modifier state and consume oneshot modifiers */
    consumeModifiers() {
        const mods = {
            ctrl: this._modState.ctrl !== 'off',
            alt: this._modState.alt !== 'off',
        };
        // Clear oneshot modifiers (locked ones stay)
        for (const name of ['ctrl', 'alt']) {
            if (this._modState[name] === 'oneshot') {
                this._modState[name] = 'off';
                this._updateModButton(name);
            }
        }
        return mods;
    }

    /**
     * Create and return the DOM element.
     * Returns null on non-touch devices.
     */
    render() {
        if (!DeviceManager.isTouchDevice() || HAS_PHYSICAL_KEYBOARD) return null;

        this.el = document.createElement('div');
        this.el.className = 'keyboard-bar';

        const keys = document.createElement('div');
        keys.className = 'keyboard-bar-keys';

        for (const def of KEYS) {
            if (def.type === 'sep') {
                const sep = document.createElement('div');
                sep.className = 'keyboard-bar-sep';
                keys.appendChild(sep);
                continue;
            }

            const btn = document.createElement('button');
            btn.className = 'keyboard-bar-key';
            btn.textContent = def.label;
            btn.tabIndex = -1;

            if (def.css) btn.classList.add(def.css);
            if (def.modifier) btn.classList.add('modifier');
            if (def.title) btn.setAttribute('data-tooltip', def.title);
            if (def.longPressOptions?.length) btn.classList.add('has-longpress');

            btn.addEventListener('pointerdown', (e) => {
                e.preventDefault();
                if (def.longPressOptions?.length) {
                    this._startLongPress(def, btn, e);
                } else {
                    this._handlePress(def, btn);
                }
            });

            if (def.modifier) {
                this._modifierButtons.set(def.modifier, btn);
            }

            keys.appendChild(btn);
        }

        this.el.appendChild(keys);
        return this.el;
    }

    _handlePress(def, btn) {
        if (def.modifier) {
            this._handleModifierTap(def.modifier);
            this.refocus();
            return;
        }

        // Visual press feedback
        btn.classList.add('pressed');
        setTimeout(() => btn.classList.remove('pressed'), 80);

        // Special actions (paste)
        if (def.action === 'paste' && this._onPaste) {
            this._onPaste();
            this.refocus();
            return;
        }

        // Determine what to send
        const key = def.key || def.char;
        const mods = this.consumeModifiers();
        this.sendKey(key, mods);
        this.refocus();
    }

    _handleModifierTap(name) {
        const now = Date.now();
        const timeSinceLast = now - this._lastModTap[name];
        this._lastModTap[name] = now;

        const current = this._modState[name];

        if (current === 'locked') {
            // Tap while locked → turn off
            this._modState[name] = 'off';
        } else if (current === 'oneshot' && timeSinceLast < DOUBLE_TAP_MS) {
            // Double-tap → lock
            this._modState[name] = 'locked';
        } else if (current === 'oneshot') {
            // Single tap while oneshot → turn off
            this._modState[name] = 'off';
        } else {
            // Off → oneshot
            this._modState[name] = 'oneshot';
        }

        this._updateModButton(name);
    }

    _updateModButton(name) {
        const btn = this._modifierButtons.get(name);
        if (!btn) return;
        const state = this._modState[name];
        btn.classList.toggle('active', state !== 'off');
        btn.classList.toggle('locked', state === 'locked');
    }

    // ── Long-press popup ──────────────────────────────────

    _startLongPress(def, btn, e) {
        this._lpDef = def;
        this._lpBtn = btn;
        this._lpStartX = e.clientX;
        this._lpStartY = e.clientY;
        this._lpPointerId = e.pointerId;
        this._lpHighlightIdx = -1;

        // Capture pointer so move/up/cancel always come to this button
        btn.setPointerCapture(e.pointerId);

        this._boundLpMove = (ev) => this._onLpMove(ev);
        this._boundLpUp = (ev) => this._onLpUp(ev);
        this._boundLpCancel = (ev) => this._onLpCancel(ev);
        btn.addEventListener('pointermove', this._boundLpMove);
        btn.addEventListener('pointerup', this._boundLpUp);
        btn.addEventListener('pointercancel', this._boundLpCancel);

        this._lpTimer = setTimeout(() => {
            this._lpTimer = null;
            this._showPopup(def, btn);
        }, LONG_PRESS_MS);
    }

    _onLpMove(e) {
        if (this._lpTimer) {
            // Popup not shown yet — cancel if finger moved too far (scrolling)
            const dx = e.clientX - this._lpStartX;
            const dy = e.clientY - this._lpStartY;
            if (dx * dx + dy * dy > LONG_PRESS_MOVE_THRESHOLD * LONG_PRESS_MOVE_THRESHOLD) {
                this._cancelLongPress();
                // Let the normal tap happen on pointerup
            }
            return;
        }
        if (!this._lpPopup) return;

        // Hit-test popup options
        const options = this._lpPopup.querySelectorAll('.kb-lp-option');
        let found = -1;
        for (let i = 0; i < options.length; i++) {
            const r = options[i].getBoundingClientRect();
            if (e.clientX >= r.left && e.clientX <= r.right &&
                e.clientY >= r.top && e.clientY <= r.bottom) {
                found = i;
                break;
            }
        }
        if (found !== this._lpHighlightIdx) {
            options.forEach((opt, i) => opt.classList.toggle('highlighted', i === found));
            this._lpHighlightIdx = found;
        }
    }

    _onLpUp(e) {
        const def = this._lpDef;
        const btn = this._lpBtn;

        if (this._lpTimer) {
            // Released before long-press threshold — normal tap
            this._cancelLongPress();
            this._cleanupLpListeners();
            this._handlePress(def, btn);
            return;
        }

        if (this._lpPopup && this._lpHighlightIdx >= 0) {
            // Slid onto an option — send it immediately
            this._selectOption(def, this._lpHighlightIdx);
            if (this._isModifierLocked(def)) {
                // Locked modifier — keep popup open, flash the selection
                this._flashOption(this._lpHighlightIdx);
                this._cleanupLpListeners();
                this._lpBtn = btn;
                this._enterTapMode(def);
            } else {
                this._dismissPopup();
                this._cleanupLpListeners();
            }
            this.refocus();
            return;
        }

        // Released without selecting — keep popup open for tap selection
        // Save refs before cleanup nulls them
        const savedDef = def;
        const savedBtn = btn;
        const popup = this._lpPopup;
        this._cleanupLpListeners();
        if (popup) {
            this._lpBtn = savedBtn; // restore so _dismissPopup can remove longpress-active
            this._enterTapMode(savedDef);
        }
    }

    _onLpCancel(_e) {
        this._cancelLongPress();
        this._dismissPopup();
        this._cleanupLpListeners();
    }

    _cancelLongPress() {
        if (this._lpTimer) {
            clearTimeout(this._lpTimer);
            this._lpTimer = null;
        }
    }

    _selectOption(def, index) {
        const option = def.longPressOptions[index];
        const mods = { ctrl: false, alt: false };
        if (option.mod) {
            mods[option.mod] = true;
        } else if (def.modifier) {
            mods[def.modifier] = true;
        }
        this.sendKey(option.key, mods);
    }

    /** Check if the key's modifier is in locked (double-tap) state */
    _isModifierLocked(def) {
        return def.modifier && this._modState[def.modifier] === 'locked';
    }

    /** Brief highlight flash on a popup option to confirm selection */
    _flashOption(index) {
        if (!this._lpPopup) return;
        const options = this._lpPopup.querySelectorAll('.kb-lp-option');
        const opt = options[index];
        if (!opt) return;
        opt.classList.add('highlighted');
        setTimeout(() => opt.classList.remove('highlighted'), 150);
    }

    /** Transition popup to tap-to-select mode after finger is lifted */
    _enterTapMode(def) {
        const popup = this._lpPopup;
        if (!popup || !def) return;

        // Enable direct touch/click on popup options
        popup.style.pointerEvents = 'auto';

        const locked = this._isModifierLocked(def);

        const options = popup.querySelectorAll('.kb-lp-option');
        options.forEach((opt, i) => {
            opt.addEventListener('pointerdown', (e) => {
                e.preventDefault();
                e.stopPropagation();
                opt.classList.add('highlighted');
            });
            opt.addEventListener('pointerup', (e) => {
                e.stopPropagation();
                this._selectOption(def, i);
                if (locked) {
                    // Keep popup open for rapid-fire shortcuts
                    this._flashOption(i);
                } else {
                    this._dismissPopup();
                }
                this.refocus();
            });
        });

        // Dismiss on tap outside popup (works for both locked and unlocked)
        this._boundDismissTap = (e) => {
            if (!this._lpPopup?.contains(e.target)) {
                this._dismissPopup();
                this.refocus();
            }
        };
        // Use setTimeout so the current pointerup doesn't immediately trigger it
        setTimeout(() => {
            // Persistent listener when locked (need to dismiss on outside tap repeatedly)
            document.addEventListener('pointerdown', this._boundDismissTap, locked ? undefined : { once: true });
        }, 0);
    }

    _showPopup(def, btn) {
        // Haptic feedback
        navigator.vibrate?.(10);

        const popup = document.createElement('div');
        popup.className = 'kb-longpress-popup';

        for (const opt of def.longPressOptions) {
            const el = document.createElement('div');
            el.className = 'kb-lp-option';
            el.innerHTML = `<span class="kb-lp-label">${opt.label}</span>`
                + `<span class="kb-lp-desc">${opt.desc}</span>`;
            popup.appendChild(el);
        }

        document.body.appendChild(popup);

        // Position above the button
        const btnRect = btn.getBoundingClientRect();
        const popRect = popup.getBoundingClientRect();
        let left = btnRect.left + btnRect.width / 2 - popRect.width / 2;
        let top = btnRect.top - popRect.height - 8;

        // Clamp to viewport
        left = Math.max(4, Math.min(left, window.innerWidth - popRect.width - 4));
        top = Math.max(4, top);

        popup.style.left = `${left}px`;
        popup.style.top = `${top}px`;

        // Position the notch to point at the button center
        const btnCenterX = btnRect.left + btnRect.width / 2;
        const notchLeft = btnCenterX - left;
        popup.style.setProperty('--notch-left', `${notchLeft}px`);

        this._lpPopup = popup;

        // Add visual feedback to source button
        btn.classList.add('longpress-active');
    }

    _dismissPopup() {
        if (this._lpPopup) {
            this._lpPopup.remove();
            this._lpPopup = null;
        }
        this._lpHighlightIdx = -1;
        if (this._lpBtn) {
            this._lpBtn.classList.remove('longpress-active');
        }
        if (this._boundDismissTap) {
            document.removeEventListener('pointerdown', this._boundDismissTap);
            this._boundDismissTap = null;
        }
    }

    _cleanupLpListeners() {
        const btn = this._lpBtn;
        if (btn && this._boundLpMove) {
            btn.removeEventListener('pointermove', this._boundLpMove);
            btn.removeEventListener('pointerup', this._boundLpUp);
            btn.removeEventListener('pointercancel', this._boundLpCancel);
            if (this._lpPointerId != null) {
                try { btn.releasePointerCapture(this._lpPointerId); } catch (_) {}
            }
        }
        this._boundLpMove = null;
        this._boundLpUp = null;
        this._boundLpCancel = null;
        this._lpDef = null;
        this._lpBtn = null;
        this._lpPointerId = null;
    }

    destroy() {
        this._cancelLongPress();
        this._dismissPopup();
        this._cleanupLpListeners();
        if (this.el) {
            this.el.remove();
            this.el = null;
        }
        this._modifierButtons.clear();
    }
}
