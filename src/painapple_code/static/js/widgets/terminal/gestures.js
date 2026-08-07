/**
 * Touch gestures for the terminal widget — virtual joystick + double-tap
 * for Tab. Plus the small clipboard/selection helpers that init.js needs
 * for its Cmd+C and context-menu hooks.
 *
 * The joystick activates after ACTIVATION_PX of swipe travel, drawing a
 * virtual d-pad anchored at the original touch point. While held,
 * the active direction auto-repeats every REPEAT_MS. A double-tap with
 * no movement sends Tab.
 *
 * No imports from sibling sub-modules except the leaf `wrap-utils.js`
 * (which itself imports nothing) — both `TerminalTouchGestures` and the
 * helpers are otherwise pure utilities that consume callbacks/instances
 * passed in by init.js.
 */

import { debug } from '../../config.js';
import { isContinuationRow } from './wrap-utils.js';

/**
 * Get terminal selection text without artificial newlines from soft-wraps.
 * xterm's getSelection() inserts \n at every line boundary, even for
 * lines that are only wrapped due to terminal width. This reconstructs
 * the selection using the shared continuation test in wrap-utils.js
 * (isWrapped, OSC 8 boundary id, full-width heuristic).
 */
export function getUnwrappedTerminalSelection(terminal) {
    if (!terminal) return '';

    // Try xterm's internal selection first (tracks mouse-initiated selections).
    // NOTE: xterm@5 returns {start: {x, y}, end: {x, y}} — the pre-vendoring
    // code read .column/.row (the xterm@4 shape), which made this whole
    // branch silently dead: the loop bounds were undefined, so every copy
    // fell through to raw getSelection() and kept its hard-wrap newlines.
    const sel = terminal.getSelectionPosition();
    if (sel) {
        const buffer = terminal.buffer.active;
        const startRow = sel.start.y, startCol = sel.start.x;
        const endRow = sel.end.y, endCol = sel.end.x;
        const lines = [];
        for (let y = startRow; y <= endRow; y++) {
            const bufLine = buffer.getLine(y);
            if (!bufLine) continue;
            let text = bufLine.translateToString(true);
            if (y === startRow && y === endRow) {
                text = bufLine.translateToString(false).substring(startCol, endCol);
            } else if (y === startRow) {
                text = bufLine.translateToString(false).substring(startCol);
            } else if (y === endRow) {
                // Trailing padding cells past the content aren't part of the
                // selection's text (xterm's native getSelection right-trims
                // rows the same way).
                text = bufLine.translateToString(false).substring(0, endCol).replace(/\s+$/, '');
            }
            if (lines.length > 0 && isContinuationRow(terminal, y)) {
                if (!bufLine.isWrapped) {
                    // TUI-emitted continuation (OSC 8 / heuristic): the
                    // previous row may carry trailing padding cells — strip
                    // them so the join doesn't inject spaces mid-content.
                    lines[lines.length - 1] = lines[lines.length - 1].replace(/\s+$/, '');
                }
                lines[lines.length - 1] += text;
                continue;
            }
            lines.push(text);
        }
        const result = lines.join('\n');
        if (result) return result;
    }

    // xterm.getSelection() (simpler API, no unwrapping)
    const xtermSel = terminal.getSelection();
    if (xtermSel) return xtermSel;

    // Fallback: native browser selection (iPad selects text via OS, not xterm)
    const nativeSel = window.getSelection();
    return nativeSel ? nativeSel.toString() : '';
}

/**
 * Copy text to clipboard with execCommand fallback for iPad Safari PWA,
 * where navigator.clipboard.writeText() rejects outside a user gesture.
 *
 * Reports honestly: execCommand *returns false* rather than throwing when
 * the browser refuses, so the return value has to be checked, not just the
 * exception. OSC 52 writes rely on this to avoid claiming success on iPad
 * when nothing actually reached the clipboard.
 *
 * @returns {Promise<boolean>} whether the text really landed on the clipboard
 */
export async function copyToClipboard(text) {
    try {
        await navigator.clipboard.writeText(text);
        debug.log('[Terminal] Clipboard write OK');
        return true;
    } catch (err) {
        console.warn('[Terminal] Clipboard API failed, using execCommand fallback:', err);
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        let ok = false;
        try {
            ok = document.execCommand('copy');
        } catch (err2) {
            console.error('[Terminal] execCommand copy fallback failed:', err2);
        } finally {
            document.body.removeChild(ta);
        }
        return ok;
    }
}

const DIR_ESCAPE = {
    up:    '\x1b[A',
    down:  '\x1b[B',
    right: '\x1b[C',
    left:  '\x1b[D',
};

export class TerminalTouchGestures {
    /**
     * @param {() => WebSocket|null} getWs - Returns the active WebSocket
     * @param {() => KeyboardBar|null} getKb - Returns the keyboard bar (for modifiers)
     */
    constructor(getWs, getKb) {
        this._getWs = getWs;
        this._getKb = getKb;
        this._el = null;

        // Touch tracking
        this._startX = 0;
        this._startY = 0;
        this._tracking = false;
        this._swiped = false;
        this._activeDir = null;
        this._repeatTimer = null;

        // Double-tap state
        this._lastTapTime = 0;
        this._lastTapX = 0;
        this._lastTapY = 0;

        // Config (all tweakable)
        this.ACTIVATION_PX = 20;      // Movement before joystick appears
        this.REPEAT_MS = 600;         // Auto-repeat interval while holding
        this.REPEAT_INITIAL_MS = 600; // Delay before first repeat
        this.DTAP_MAX_MS = 300;       // Max gap between taps for double-tap
        this.DTAP_MAX_MOVE = 20;      // Max distance between taps (px)

        // Joystick DOM (created once, reused)
        this._joystick = this._createJoystick();
        this._joystickVisible = false;

        // Bound handlers
        this._onStart = this._handleStart.bind(this);
        this._onMove = this._handleMove.bind(this);
        this._onEnd = this._handleEnd.bind(this);
    }

    // ── DOM ──────────────────────────────────────────────────────────

    _createJoystick() {
        const el = document.createElement('div');
        el.className = 'terminal-joystick';
        el.innerHTML =
            '<div class="tj-arrow" data-dir="up">↑</div>' +
            '<div class="tj-row">' +
                '<div class="tj-arrow" data-dir="left">←</div>' +
                '<div class="tj-center"></div>' +
                '<div class="tj-arrow" data-dir="right">→</div>' +
            '</div>' +
            '<div class="tj-arrow" data-dir="down">↓</div>';
        return el;
    }

    _showJoystick(x, y) {
        if (this._joystickVisible) return;
        // Clamp so the ~120×120 pad stays within viewport
        const pad = 65;
        const cx = Math.max(pad, Math.min(x, window.innerWidth - pad));
        const cy = Math.max(pad, Math.min(y, window.innerHeight - pad));
        this._joystick.style.left = `${cx}px`;
        this._joystick.style.top = `${cy}px`;
        document.body.appendChild(this._joystick);
        // Force reflow then animate in
        this._joystick.offsetHeight; // eslint-disable-line no-unused-expressions
        this._joystick.classList.add('visible');
        this._joystickVisible = true;
    }

    _hideJoystick() {
        if (!this._joystickVisible) return;
        this._joystick.classList.remove('visible');
        this._joystickVisible = false;
        setTimeout(() => {
            if (!this._joystickVisible && this._joystick.parentNode) {
                this._joystick.parentNode.removeChild(this._joystick);
            }
        }, 150);
    }

    _highlightDir(dir) {
        for (const arrow of this._joystick.querySelectorAll('.tj-arrow')) {
            arrow.classList.toggle('active', arrow.dataset.dir === dir);
        }
    }

    // ── Attach / Detach ─────────────────────────────────────────────

    attach(el) {
        this._el = el;
        el.addEventListener('touchstart', this._onStart, { passive: true });
        el.addEventListener('touchmove', this._onMove, { passive: false });
        el.addEventListener('touchend', this._onEnd, { passive: false });
        el.addEventListener('touchcancel', this._onEnd, { passive: true });
    }

    detach() {
        if (!this._el) return;
        this._stopRepeat();
        this._hideJoystick();
        this._el.removeEventListener('touchstart', this._onStart);
        this._el.removeEventListener('touchmove', this._onMove);
        this._el.removeEventListener('touchend', this._onEnd);
        this._el.removeEventListener('touchcancel', this._onEnd);
        this._el = null;
    }

    // ── Helpers ──────────────────────────────────────────────────────

    _send(data) {
        const ws = this._getWs();
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(data);
        }
    }

    _getDirection(dx, dy) {
        const ax = Math.abs(dx);
        const ay = Math.abs(dy);
        if (ax < this.ACTIVATION_PX && ay < this.ACTIVATION_PX) return null;
        if (ax > ay) return dx > 0 ? 'right' : 'left';
        return dy > 0 ? 'down' : 'up';
    }

    /** Build arrow escape sequence, consuming keyboard bar modifiers if active */
    _buildArrowData(dir) {
        let data = DIR_ESCAPE[dir];
        const kb = this._getKb?.();
        if (kb?.hasActiveModifiers()) {
            const mods = kb.consumeModifiers();
            if (mods.ctrl || mods.alt) {
                // xterm modifier param: 1 + (alt?2:0) + (ctrl?4:0)
                const mod = 1 + (mods.alt ? 2 : 0) + (mods.ctrl ? 4 : 0);
                const suffix = { up: 'A', down: 'B', right: 'C', left: 'D' };
                data = `\x1b[1;${mod}${suffix[dir]}`;
            }
        }
        return data;
    }

    _startRepeat(dir) {
        this._stopRepeat();
        this._activeDir = dir;
        this._send(this._buildArrowData(dir));
        this._highlightDir(dir);
        // First repeat after initial delay, then every REPEAT_MS
        const loop = () => {
            this._repeatTimer = setTimeout(() => {
                if (this._activeDir) {
                    this._send(this._buildArrowData(this._activeDir));
                    loop();
                }
            }, this.REPEAT_MS);
        };
        this._repeatTimer = setTimeout(() => {
            if (this._activeDir) {
                this._send(this._buildArrowData(this._activeDir));
                loop();
            }
        }, this.REPEAT_INITIAL_MS);
    }

    _stopRepeat() {
        if (this._repeatTimer != null) {
            clearTimeout(this._repeatTimer);
            this._repeatTimer = null;
        }
        this._activeDir = null;
    }

    // ── Touch handlers ──────────────────────────────────────────────

    _handleStart(e) {
        if (e.touches.length !== 1) return;
        const t = e.touches[0];
        this._startX = t.clientX;
        this._startY = t.clientY;
        this._tracking = true;
        this._swiped = false;
    }

    _handleMove(e) {
        if (!this._tracking || e.touches.length !== 1) return;

        const t = e.touches[0];
        const dx = t.clientX - this._startX;
        const dy = t.clientY - this._startY;
        const dir = this._getDirection(dx, dy);

        if (dir) {
            e.preventDefault(); // block xterm scroll while joystick is active
            if (!this._joystickVisible) {
                this._showJoystick(this._startX, this._startY);
                this._startRepeat(dir);
            } else if (dir !== this._activeDir) {
                // Direction changed — restart repeat
                this._startRepeat(dir);
            }
            this._swiped = true;
        }
    }

    _handleEnd(e) {
        const touch = e.changedTouches?.[0];
        const now = Date.now();

        if (this._joystickVisible) {
            this._stopRepeat();
            this._hideJoystick();
            e.preventDefault?.();
        }
        this._tracking = false;

        // Double-tap detection (only if we didn't activate joystick)
        if (!this._swiped && touch) {
            const tapDist = Math.hypot(
                touch.clientX - this._lastTapX,
                touch.clientY - this._lastTapY
            );
            const tapGap = now - this._lastTapTime;

            if (tapGap < this.DTAP_MAX_MS && tapDist < this.DTAP_MAX_MOVE) {
                this._send('\t');
                e.preventDefault?.();
                this._lastTapTime = 0; // prevent triple-tap
            } else {
                this._lastTapTime = now;
                this._lastTapX = touch.clientX;
                this._lastTapY = touch.clientY;
            }
        }
    }
}
