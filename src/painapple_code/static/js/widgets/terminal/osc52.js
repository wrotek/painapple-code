/**
 * OSC 52 clipboard support for the terminal widget.
 *
 * OSC 52 (`ESC ] 52 ; Ps ; Pt ST`) is how a program running *inside* the
 * terminal asks the emulator to put something on the system clipboard. It
 * is what makes `y` in vim's visual mode reach the real clipboard even over
 * SSH or inside tmux, with no `+clipboard` vim build and no X11 forwarding
 * (see the vim-oscyank plugin, or Neovim 0.10+ which speaks it natively).
 * tmux additionally needs `set -g set-clipboard on` to pass it through.
 *
 * Three deliberate restrictions:
 *
 *   1. WRITE ONLY. `Pt = "?"` is the *read* form — it asks the terminal to
 *      send the clipboard back to the program. We consume that request and
 *      answer nothing. Honouring it would hand the user's clipboard to
 *      whatever is running in the terminal, including a process on a remote
 *      host they don't control. This is exactly what iTerm2's "Applications
 *      in terminal may access clipboard" preference guards.
 *   2. ALWAYS ANNOUNCED. A silent clipboard overwrite is an attack — swap
 *      the deploy command the user just copied for something else and wait.
 *      So every accepted write toasts. The toast is the security boundary,
 *      not decoration; don't make it conditional on anything.
 *   3. OFF BY DEFAULT (WP-13). A fresh profile must not be clipboard-
 *      writable by anything that can print to the terminal — output from a
 *      local command or a remote SSH host could replace what the user just
 *      copied. The user opts in once via Settings → Terminal ("Terminal
 *      apps may write to clipboard"); a blocked attempt toasts, so the
 *      setting is discoverable at exactly the moment it's wanted.
 *
 * Chunking is not our problem: xterm's OSC parser is stateful across
 * `write()` calls, so the handler only fires once the whole payload has
 * arrived, however the backend's 4 KB PTY reads happened to split it. The
 * base64 body is ASCII, so the server's `decode('utf-8', errors='replace')`
 * can't corrupt it either.
 *
 * Scrollback replay IS a problem, and is handled server-side — see
 * `_OSC52_RE` in routes/api_terminal.py for why.
 *
 * Known limitation: on iPad Safari (and the PWA) a program-initiated write
 * has no user gesture behind it, so `navigator.clipboard.writeText()` may
 * reject and the `execCommand` fallback is refused too. That is a WebKit
 * policy we can't work around from here — the failure is reported honestly
 * via toast rather than pretending it worked.
 */

import { debug } from '../../config.js';
import { showToast } from '../../context-menu.js';
import S from '../../strings.js';
import { copyToClipboard } from './gestures.js';

const CONFIG_STORAGE_KEY = 'claude-code-user-config';

// Reject absurd payloads well before xterm's own 10 MB PAYLOAD_LIMIT. A
// legitimate yank is kilobytes; anything at this scale is a runaway process
// or someone `cat`ing a binary.
const MAX_BASE64_LENGTH = 2_000_000;

// A file full of OSC 52 sequences would otherwise mean one clipboard write
// and one toast per sequence. Coalesce instead: keep the newest payload and
// flush once things go quiet. Last-write-wins is also the semantically
// correct outcome, and 150ms is imperceptible for an interactive yank.
const COALESCE_MS = 150;

let _pendingText = null;
let _flushTimer = null;

/**
 * Whether programs may write to the clipboard. Requires an explicit
 * opt-in (`=== true`): absent, malformed or unreadable config all mean
 * OFF — this gate must fail closed, see restriction 3 above. Read
 * straight from localStorage rather than through config/state.js — that
 * module pulls in status-bar.js, and the terminal tree has no business
 * importing that. Same lightweight-consumer pattern as shortcut-hints.js.
 * @returns {boolean} default false
 */
export function isTerminalClipboardWriteEnabled() {
    try {
        const raw = localStorage.getItem(CONFIG_STORAGE_KEY);
        if (!raw) return false;
        return (JSON.parse(raw) || {}).terminalClipboardWrite === true;
    } catch (e) {
        return false;
    }
}

/**
 * Does this Ps selection parameter mean "the clipboard"?
 * Ps is a set of targets: c=clipboard, p=primary, q=secondary, s=select,
 * 0-7=cut buffers. A browser has exactly one clipboard, so any of the named
 * selections maps onto it. Empty Ps means the spec default (`s0`), which is
 * what tools that omit it intend as "the clipboard". Pure cut-buffer writes
 * are ignored — they're X11 scratch storage, not the clipboard.
 */
function targetsClipboard(ps) {
    if (ps === '') return true;
    return /[cpqs]/.test(ps);
}

/**
 * Decode an OSC 52 base64 payload as UTF-8.
 * `atob()` alone yields a binary string, which mangles any non-ASCII text —
 * it has to go through TextDecoder to come back as the characters the
 * program actually yanked.
 * @returns {string|null} null if the payload isn't valid base64
 */
function decodeBase64Utf8(b64) {
    try {
        const binary = atob(b64);
        const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
        return new TextDecoder('utf-8').decode(bytes);
    } catch (e) {
        return null;
    }
}

function queueWrite(text) {
    _pendingText = text;
    if (_flushTimer) return;
    _flushTimer = setTimeout(() => {
        _flushTimer = null;
        const pending = _pendingText;
        _pendingText = null;
        flushWrite(pending);
    }, COALESCE_MS);
}

async function flushWrite(text) {
    const ok = await copyToClipboard(text);
    if (ok) {
        // Count code points, not `text.length` — that's UTF-16 code units, so
        // an emoji would be announced as 2 "chars".
        showToast(S.toast.terminal_clipboard_written.replace('{n}', [...text].length));
    } else {
        // Most likely iPad/WebKit refusing a write with no user gesture.
        showToast(S.toast.terminal_clipboard_failed, 3000);
    }
}

/**
 * Handle one OSC 52 payload. The string is everything after `ESC ] 52 ;`,
 * i.e. `Ps ; Pt` — xterm hands it over fully reassembled.
 */
function handleOsc52(payload) {
    const sep = payload.indexOf(';');
    if (sep === -1) return;

    const ps = payload.slice(0, sep);
    const pt = payload.slice(sep + 1);

    if (!targetsClipboard(ps)) return;

    if (pt === '?') {
        // The read form. Consumed and refused — see the header comment.
        debug.log('[Terminal] OSC 52 clipboard read request refused');
        return;
    }

    if (!isTerminalClipboardWriteEnabled()) {
        // Worth a toast: otherwise `y` in vim silently does nothing and the
        // user has no way to connect that to a setting they once turned off.
        showToast(S.toast.terminal_clipboard_blocked, 3000);
        return;
    }

    const b64 = pt.replace(/\s+/g, '');
    if (b64.length > MAX_BASE64_LENGTH) {
        debug.log(`[Terminal] OSC 52 payload too large (${b64.length} b64 chars), ignored`);
        showToast(S.toast.terminal_clipboard_too_large, 3000);
        return;
    }

    // An empty payload is a legitimate "clear the clipboard" request.
    const text = b64 === '' ? '' : decodeBase64Utf8(b64);
    if (text === null) {
        debug.log('[Terminal] OSC 52 payload was not valid base64, ignored');
        return;
    }

    queueWrite(text);
}

/**
 * Register the OSC 52 handler on a terminal instance.
 *
 * Call this ONCE, at construction. The xterm `Terminal` outlives WebSocket
 * reconnects and the floating→tab transfer (which moves the same instance
 * and only re-binds onData/onResize/key handlers), so re-registering on
 * either would double-fire the handler.
 *
 * @param {object} targetState terminal state object, with `.terminal` set
 * @returns {object|null} the xterm IDisposable, or null if unsupported
 */
export function registerOsc52Handler(targetState) {
    const parser = targetState.terminal?.parser;
    if (!parser?.registerOscHandler) {
        debug.log('[Terminal] xterm build has no registerOscHandler; OSC 52 unavailable');
        return null;
    }

    const disposable = parser.registerOscHandler(52, (payload) => {
        try {
            handleOsc52(payload);
        } catch (err) {
            console.warn('[Terminal] OSC 52 handling failed:', err);
        }
        // Always claim the sequence: whether we acted on it or refused it,
        // it must not fall through and get rendered as text.
        return true;
    });

    targetState.osc52Disposable = disposable;
    return disposable;
}
