/**
 * Terminal state — TerminalState class plus the registries that hold
 * per-session and per-tab instances. Every other terminal sub-module
 * reads/writes through this module so there is one canonical home for
 * the lifecycle of a TerminalState (create → reset → destroy).
 *
 * Why separate from terminal-widget.js: state survives widget transforms
 * (top-sheet → floating → tab) and across page lifecycle. Keeping it
 * isolated makes the dependency graph acyclic — connection.js, init.js,
 * render.js all import from here, but state.js imports nothing from
 * sibling modules.
 */

import { CONFIG } from '../../config.js';
import { WidgetManager } from '../../widget-system/index.js';

class TerminalState {
    constructor() {
        this.terminal = null;
        this.fitAddon = null;
        this.filePathProvider = null; // Link provider for file paths
        this.ws = null;
        this.connected = false;
        this.reconnectTimer = null;
        this.sessionId = null;
        this.cwd = null;
        this.liveCwd = null; // Shell's live cwd (/proc-based) — resolution only, never the WS session key
        this.status = 'disconnected'; // 'connecting', 'connected', 'disconnected', 'error', 'exited'
        this.initialized = false;
        this._isTab = false; // true for tab terminals, false for session (floating) terminals

        // DOM references (updated on render)
        this.terminalContainer = null;
        this.loadingEl = null;
        this.statusEl = null;

        // ResizeObserver for detecting container size changes
        this.resizeObserver = null;

        // Keyboard bar instance (touch devices only)
        this.keyboardBar = null;

        // Bracketed paste mode: tracked from shell's \e[?2004h / \e[?2004l output
        this.bracketedPasteMode = false;

        // Touch gestures handler (swipe→arrows, double-tap→Tab)
        this.touchGestures = null;

        // Timestamp of last server message (any kind, incl. 5s heartbeat).
        // Used on reopen to detect half-dead WebSockets after iPad PWA suspend
        // — readyState can stay OPEN long after TCP has gone silent.
        this.lastMessageAt = 0;
    }

    reset() {
        // Disconnect and cleanup
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.ws) {
            this.ws.onclose = null;
            this.ws.close();
            this.ws = null;
        }
        if (this.terminal) {
            this.terminal.dispose();
            this.terminal = null;
        }
        // Disconnect ResizeObserver to avoid memory leaks
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
            this.resizeObserver = null;
        }
        this.fitAddon = null;
        this.filePathProvider = null;
        this.connected = false;
        this.status = 'disconnected';
        this.initialized = false;
        this._initializing = false;
        this.lastMessageAt = 0;
        if (this.touchGestures) {
            this.touchGestures.detach();
            this.touchGestures = null;
        }
        if (this.keyboardBar) {
            this.keyboardBar.resetModifiers();
        }
    }
}

export { TerminalState };

// ─────────────────────────────────────────────────────────────────────
// Per-session terminal states (replaces singleton floatingState)
// ─────────────────────────────────────────────────────────────────────

export const sessionStates = new Map();

export function getSessionState(sessionId) {
    if (!sessionId) sessionId = WidgetManager.currentSessionId;
    if (!sessionStates.has(sessionId)) sessionStates.set(sessionId, new TerminalState());
    return sessionStates.get(sessionId);
}

export function destroySessionState(sessionId) {
    const st = sessionStates.get(sessionId);
    if (st) {
        // Kill the server-side PTY so it doesn't outlive the chat session
        // that owned it. Without this, every closed session leaves an
        // orphaned shell process that piles up on the bridge.
        if (st.sessionId) {
            fetch(`${CONFIG.API_BASE}/api/terminal/${encodeURIComponent(st.sessionId)}`, {
                method: 'DELETE'
            }).catch(() => {});
        }
        st.reset();
        sessionStates.delete(sessionId);
    }
}

// ─────────────────────────────────────────────────────────────────────
// Per-tab terminal states (multiple terminal tabs - global, not session-scoped)
// ─────────────────────────────────────────────────────────────────────

export const tabStates = new Map();

let _terminalTabCounter = 1;

export function nextTabNumber() {
    return _terminalTabCounter++;
}

/**
 * Get or create a tab state for the given tabId
 * @param {string} tabId - The widget tab ID
 * @param {string|null} cwd - Working directory
 * @param {string|null} sessionId - Optional session ID (for reconnecting to existing PTY)
 */
export function getOrCreateTabState(tabId, cwd = null, sessionId = null) {
    if (!tabStates.has(tabId)) {
        const newState = new TerminalState();
        newState._isTab = true;
        newState.cwd = cwd;
        // Use provided sessionId (for reconnection) or generate new one
        newState.sessionId = sessionId || `tab:${tabId}:${Date.now()}`;
        tabStates.set(tabId, newState);
    }
    return tabStates.get(tabId);
}

/**
 * Clean up and remove a tab state
 */
export function removeTabState(tabId) {
    const state = tabStates.get(tabId);
    if (state) {
        // Kill the server-side PTY so the shell process doesn't survive
        // the tab being closed.
        if (state.sessionId) {
            fetch(`${CONFIG.API_BASE}/api/terminal/${encodeURIComponent(state.sessionId)}`, {
                method: 'DELETE'
            }).catch(() => {});
        }
        state.reset();
        tabStates.delete(tabId);
    }
}

// ─────────────────────────────────────────────────────────────────────
// Last-focused tracking — paste action routing needs to know which
// terminal the user most recently interacted with so Cmd+V goes to the
// right one when multiple terminals are open across session/tabs.
// ─────────────────────────────────────────────────────────────────────

const RECENT_FOCUS_MS = 5000;

let _lastFocusedTerminalState = null;
let _lastFocusedTerminalTime = 0;

export function setLastFocused(state) {
    _lastFocusedTerminalState = state;
    _lastFocusedTerminalTime = Date.now();
}

/**
 * Returns the last-focused terminal state if it was focused within the
 * recency window AND its WebSocket is still open. Otherwise null.
 */
export function lastFocusedIfRecent() {
    if (_lastFocusedTerminalState?.ws?.readyState === WebSocket.OPEN &&
        (Date.now() - _lastFocusedTerminalTime) < RECENT_FOCUS_MS) {
        return _lastFocusedTerminalState;
    }
    return null;
}

// ─────────────────────────────────────────────────────────────────────
// Resize helper — small enough that putting it next to the state it
// operates on is cleaner than a dedicated module.
// ─────────────────────────────────────────────────────────────────────

export function fitTerminal(targetState) {
    if (targetState.fitAddon && targetState.terminal) {
        try {
            targetState.fitAddon.fit();
        } catch (e) {
            // Ignore fit errors during transitions
        }
    }
}
