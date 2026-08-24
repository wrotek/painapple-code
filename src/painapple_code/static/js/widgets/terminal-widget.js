/**
 * Terminal Widget — interactive terminal with xterm.js, mounted via the
 * widget system. Top-sheet on phone/tablet, floating on desktop, and
 * promotable to a tab. Provides a quick-access PTY for the project's
 * CWD, persistent sessions keyed by `(widget session, cwd)`, and a
 * separate per-tab state for the multi-terminal tab strip.
 *
 * This file is the orchestrator: it composes the sub-modules under
 * `widgets/terminal/` and exposes the public surface (`registerTerminalWidget`
 * and the `TerminalWidget` namespace consumed by app.js, tab-controller,
 * orphan-terminals, quick-actions, and the Settings widget). All heavy
 * logic — state, gestures, link providers, init, connection, render,
 * size — lives in dedicated modules so this file stays focused on
 * widget configuration, lifecycle hooks, and the float→tab transfer.
 */

import { debug } from '../config.js';
import { ContextMenu } from '../context-menu.js';
import S from '../strings.js';
import { WidgetManager } from '../widget-system/index.js';

import {
    destroySessionState,
    fitTerminal,
    getOrCreateTabState,
    getSessionState,
    lastFocusedIfRecent,
    nextTabNumber,
    removeTabState,
    sessionStates,
    tabStates,
} from './terminal/state.js';
import {
    copyToClipboard,
    getUnwrappedTerminalSelection,
} from './terminal/gestures.js';
import { FilePathLinkProvider, makeLiveCwdRefresher } from './terminal/link-providers.js';
import {
    connect,
    handleJsonMessage,
    killTerminal,
    updateStatus,
} from './terminal/connection.js';
import { initTerminal } from './terminal/init.js';
import { renderContent } from './terminal/render.js';
import {
    DEFAULT_TERMINAL_HEIGHT,
    DEFAULT_TERMINAL_WIDTH,
    getConfiguredSize,
    resetConfiguredSize,
    setConfiguredSize,
} from './terminal/size.js';

// ─────────────────────────────────────────────────────────────────────
// Header context menu (reuses shared ContextMenu from context-menu.js)
// ─────────────────────────────────────────────────────────────────────

let headerContextMenu = null;

function showTerminalHeaderMenu(x, y, widget) {
    if (!headerContextMenu) headerContextMenu = new ContextMenu();

    const dims = widget.getDimensions();
    const configured = getConfiguredSize();
    const isSameSize = dims.width === configured.width && dims.height === configured.height;

    headerContextMenu.show(x, y, [
        {
            label: `Save current size as default (${dims.width}×${dims.height})`,
            disabled: isSameSize,
            action: () => {
                setConfiguredSize(dims.width, dims.height);
                widget._defaultSize = { width: dims.width, height: dims.height };
            }
        },
        {
            label: `Restore default (${configured.width}×${configured.height})`,
            disabled: isSameSize,
            action: () => {
                widget.size = { ...configured };
                widget.position = {
                    x: Math.round((window.innerWidth - configured.width) / 2),
                    y: Math.round((window.innerHeight - configured.height) / 2)
                };
                widget.constrainPosition();
                widget.updatePosition();
                widget.updateSize();
                widget.config.onResize?.();
            }
        }
    ]);
}

// ─────────────────────────────────────────────────────────────────────
// Widget Registration
// ─────────────────────────────────────────────────────────────────────

export function registerTerminalWidget() {
    const configured = getConfiguredSize();

    WidgetManager.register('terminal', {
        type: 'top-sheet',
        title: S.widgets.titles.terminal,
        icon: 'terminal',
        shortcut: 'Ctrl+`',

        // Device-specific types
        deviceTypes: {
            default: 'top-sheet',
            phone: 'top-sheet',
            tablet: 'top-sheet',
            desktop: 'floating'
        },

        // Heights for top-sheet
        heights: {
            half: '30vh',
            full: '50vh'
        },

        // Floating window size — double-click header to restore to configured size
        size: { width: configured.width, height: configured.height },
        minSize: { width: 400, height: 200 },

        // Allow transform to these types (including tab via widget system)
        allowedTypes: ['top-sheet', 'floating', 'tab'],

        // Custom header actions
        headerActions: [
            {
                icon: 'plus',
                title: S.widgets.header_actions.new_terminal_tab,
                onClick: () => window.app?.tabCtrl?.openTerminalWidgetTab()
            },
            {
                icon: 'kill',
                title: S.widgets.header_actions.kill_terminal,
                onClick: () => killTerminal(getSessionState())
            }
        ],

        // Render function - uses appropriate state based on context
        render: (container, ctx) => {
            let targetState;

            if (ctx.isTab && ctx.tabId) {
                // Widget tab render - get or create state for this specific tab
                // Pass sessionId from ctx for reconnecting to existing PTY on page reload
                targetState = getOrCreateTabState(ctx.tabId, ctx.cwd, ctx.terminalSessionId);

                // One-shot command to type after the PTY connects (e.g. `/login` flow).
                // Only set on first render — cleared after send so reconnects don't replay.
                if (ctx.initialCommand && !targetState.terminal) {
                    targetState.pendingInitialCommand = ctx.initialCommand;
                }

                // Check if this is a promotion from floating (transfer flag set)
                const sourceState = getSessionState();
                if (ctx.transferFromFloating && sourceState.terminal && !targetState.terminal) {
                    transferFloatingToTab(sourceState, targetState);
                }
            } else {
                // Session (floating) terminal - get per-session state
                targetState = getSessionState(ctx.sessionId);
            }

            // Update CWD from context
            const newCwd = ctx.cwd || window.app?.activeSession?.cwd;
            if (newCwd !== targetState.cwd) {
                targetState.cwd = newCwd;
                // If terminal exists and CWD changed, reconnect
                if (targetState.initialized && targetState.connected) {
                    connect(targetState);
                }
            }

            renderContent(container, targetState);

            // Initialize terminal if it doesn't exist yet (new session or new tab)
            // No CWD guard — backend falls back to agents.default_cwd when no CWD is sent
            if (!targetState.terminal) {
                initTerminal(targetState);
            }

            // Keyboard handlers (Ctrl+C, Cmd+C, Cmd+V) are attached to the Terminal instance
            // via attachCustomKeyEventHandler in initTerminal(), so they survive container re-renders
        },

        // Open handler - initialize session's terminal
        onOpen: () => {
            const sState = getSessionState();

            // Get CWD from active session (may be empty on welcome screen — that's OK,
            // backend falls back to agents.default_cwd)
            if (!sState.cwd) {
                sState.cwd = window.app?.activeSession?.cwd || null;
            }

            // Blur any active terminal tab to release keyboard capture
            if (window.app?.terminalTabManager?.activeTabId) {
                const activeTab = window.app.terminalTabManager.tabs.find(
                    t => t.id === window.app.terminalTabManager.activeTabId
                );
                if (activeTab?.terminal) {
                    activeTab.terminal.blur();
                }
            }
            // Also blur all widget tab terminals
            for (const [, tabState] of tabStates) {
                if (tabState.terminal) {
                    tabState.terminal.blur();
                }
            }

            // Initialize this session's terminal
            initTerminal(sState);

            // Ensure widget container has pointer-events (belt and suspenders)
            const widget = WidgetManager.get('terminal');
            if (widget?.container) {
                widget.container.style.pointerEvents = 'auto';
            }

            // Attach header context menu (once)
            if (widget?.headerEl && !widget.headerEl._termCtxMenu) {
                widget.headerEl._termCtxMenu = true;
                widget.headerEl.addEventListener('contextmenu', (e) => {
                    e.preventDefault();
                    showTerminalHeaderMenu(e.clientX, e.clientY, widget);
                });
            }

            // Hide connection bar when terminal is open (saves space, especially on iPad)
            const connBar = document.getElementById('connection-bar');
            if (connBar) {
                connBar.classList.add('hidden-by-terminal');
            }

            // Focus terminal after animation settles so iOS keyboard
            // viewport shift doesn't race with top-sheet slide-in
            setTimeout(() => {
                if (sState.terminal) {
                    sState.terminal.focus();
                }
            }, 350);
        },

        // Close handler - focus chat input
        onClose: () => {
            // Reset keyboard bar modifiers (unlock Ctrl/Alt, dismiss popups)
            const sState = getSessionState();
            if (sState.keyboardBar) {
                sState.keyboardBar.resetModifiers();
            }

            // Clear inline pointer-events (set in onOpen) to let CSS handle visibility
            const widget = WidgetManager.get('terminal');
            if (widget?.container) {
                widget.container.style.pointerEvents = '';
            }

            // Restore connection bar ONLY if no terminal tab is open
            // (when transferring floating→tab, the tab is pushed before close() fires)
            const hasTerminalTab = window.app?.tabCtrl?.widgetTabs?.some(t => t.isTerminal);
            if (!hasTerminalTab) {
                const connBar = document.getElementById('connection-bar');
                if (connBar) {
                    connBar.classList.remove('hidden-by-terminal');
                }
            }

            const chatInput = document.getElementById('message-input');
            if (chatInput) {
                setTimeout(() => chatInput.focus(), 100);
            }
        },

        // Resize handler - refit session's terminal
        onResize: () => {
            const sState = getSessionState();
            setTimeout(() => fitTerminal(sState), 50);
        },

        // Transform handler - refit after transform
        onTransform: (fromType, toType) => {
            const sState = getSessionState();
            setTimeout(() => {
                fitTerminal(sState);
                if (sState.terminal) {
                    sState.terminal.focus();
                }
            }, 100);
        },

        // Session change handler - switch terminal to new session's state
        onSessionChange: (sessionId) => {
            const sState = getSessionState(sessionId);
            const newCwd = WidgetManager.currentCwd || window.app?.activeSession?.cwd;
            if (newCwd && newCwd !== sState.cwd) {
                // Clear path cache when CWD changes
                if (sState.filePathProvider) {
                    sState.filePathProvider.clearCache();
                }
                sState.cwd = newCwd;
                // Reconnect if widget is visible and terminal is initialized
                const widget = WidgetManager.get('terminal');
                if (widget?.isVisible && sState.initialized) {
                    connect(sState);
                }
            }
        },

        // CWD change handler - update terminal when project directory changes
        onCwdChange: (cwd) => {
            const sState = getSessionState();
            if (cwd && cwd !== sState.cwd) {
                // Clear path cache when CWD changes
                if (sState.filePathProvider) {
                    sState.filePathProvider.clearCache();
                }
                sState.cwd = cwd;
                // Reconnect if widget is visible and terminal is initialized
                const widget = WidgetManager.get('terminal');
                if (widget?.isVisible && sState.initialized) {
                    connect(sState);
                }
            }
        },

        // Cleanup when session is closed
        onDestroy: (sessionId) => {
            destroySessionState(sessionId);
        }
    });
}

/**
 * Transfer a live xterm/WebSocket from the session's floating terminal
 * to a tab terminal. This is what powers "Open in Tab" — the user
 * promotes the floating widget without losing scrollback or the running
 * shell. We move the references over, then rebind every handler that
 * captured the source state in its closure (onData/onResize/keyboard
 * handler/WebSocket callbacks) to point at the new target state.
 */
function transferFloatingToTab(sourceState, targetState) {
    targetState.terminal = sourceState.terminal;
    targetState.fitAddon = sourceState.fitAddon;
    targetState.ws = sourceState.ws;
    targetState.connected = sourceState.connected;
    targetState.initialized = sourceState.initialized;
    targetState.cwd = sourceState.cwd;
    targetState.liveCwd = sourceState.liveCwd;
    targetState.sessionId = sourceState.sessionId;
    targetState.status = sourceState.status;

    // Create new file path provider for this tab (getCwd closure must reference targetState)
    const newFilePathProvider = new FilePathLinkProvider(
        targetState.terminal,
        () => targetState.liveCwd || targetState.cwd,
        makeLiveCwdRefresher(targetState)
    );
    targetState.terminal.registerLinkProvider(newFilePathProvider);
    targetState.filePathProvider = newFilePathProvider;

    // Clear source session state (don't dispose - tab owns it now)
    sourceState.terminal = null;
    sourceState.fitAddon = null;
    sourceState.filePathProvider = null;
    sourceState.ws = null;
    sourceState.connected = false;
    sourceState.initialized = false;
    sourceState.sessionId = null;

    // IMPORTANT: Rebind ALL handlers to use targetState (the new tab).
    // The original handlers captured sourceState in their closure.
    // Old onData/onResize still fire but sourceState.ws is null so they're no-ops.

    // Rebind terminal input with keyboard bar modifier support
    targetState.terminal.onData(data => {
        if (targetState.ws && targetState.ws.readyState === WebSocket.OPEN) {
            if (targetState.keyboardBar?.hasActiveModifiers()) {
                const mods = targetState.keyboardBar.consumeModifiers();
                let modified = data;
                if (mods.ctrl && data.length === 1) {
                    const code = data.toLowerCase().charCodeAt(0);
                    if (code >= 97 && code <= 122) {
                        modified = String.fromCharCode(code - 96);
                    }
                } else if (mods.alt) {
                    modified = '\x1b' + data;
                }
                targetState.ws.send(modified);
            } else {
                targetState.ws.send(data);
            }
        }
    });
    targetState.terminal.onResize(({ rows, cols }) => {
        if (targetState.ws && targetState.ws.readyState === WebSocket.OPEN) {
            targetState.ws.send(JSON.stringify({ type: 'resize', rows, cols }));
        }
    });

    // Rebind attachCustomKeyEventHandler to reference targetState's keyboard bar
    targetState.terminal.attachCustomKeyEventHandler((e) => {
        if (e.type !== 'keydown') return true;

        // Virtual modifier keys from keyboard bar
        if (targetState.keyboardBar?.hasActiveModifiers()) {
            const ch = e.key;
            if (ch.length === 1) {
                e.preventDefault();
                const mods = targetState.keyboardBar.consumeModifiers();
                let data = ch;
                if (mods.ctrl) {
                    const code = ch.toLowerCase().charCodeAt(0);
                    if (code >= 97 && code <= 122) {
                        data = String.fromCharCode(code - 96);
                    }
                }
                if (mods.alt) {
                    data = '\x1b' + data;
                }
                if (targetState.ws?.readyState === WebSocket.OPEN) {
                    targetState.ws.send(data);
                }
                return false;
            }
        }

        const key = e.key.toLowerCase();
        if (e.shiftKey || e.altKey) return true;

        if (key === 'c' && e.metaKey && !e.ctrlKey) {
            const selection = getUnwrappedTerminalSelection(targetState.terminal);
            debug.log('[Terminal/Tab] Cmd+C handler: selection =', JSON.stringify(selection?.substring(0, 80)));
            if (selection) {
                e.preventDefault();
                copyToClipboard(selection);
            }
            return false;
        }

        if (key === 'c' && e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            if (targetState.ws?.readyState === WebSocket.OPEN) {
                targetState.ws.send('\x03');
            }
            return false;
        }

        if (key === 'v' && e.metaKey && !e.ctrlKey) {
            e.preventDefault();
            navigator.clipboard.readText().then(text => {
                if (text && targetState.ws?.readyState === WebSocket.OPEN) {
                    if (targetState.bracketedPasteMode) {
                        targetState.ws.send('\x1b[200~' + text + '\x1b[201~');
                    } else {
                        targetState.ws.send(text);
                    }
                }
            }).catch(() => {});
            return false;
        }

        // Cmd+N / Ctrl+N → let bubble to shortcut handler (new draft)
        if (key === 'n' && (e.metaKey || e.ctrlKey)) {
            return false;
        }

        return true;
    });

    // CRITICAL: Rebind WebSocket handlers to use targetState
    targetState.ws.onmessage = (event) => {
        targetState.lastMessageAt = Date.now();
        const data = event.data;
        if (data.startsWith('{')) {
            try {
                const msg = JSON.parse(data);
                handleJsonMessage(msg, targetState);
                return;
            } catch (e) {}
        }
        if (targetState.terminal) {
            if (targetState.loadingEl) {
                targetState.loadingEl.hidden = true;
            }
            // Track bracketed paste mode from shell output
            if (data.includes('\x1b[?2004h')) targetState.bracketedPasteMode = true;
            if (data.includes('\x1b[?2004l')) targetState.bracketedPasteMode = false;
            targetState.terminal.write(data);
        }
    };
    targetState.ws.onclose = (event) => {
        debug.log('Terminal WebSocket closed:', event.code, event.reason);
        targetState.connected = false;
        updateStatus('disconnected', targetState);
    };
    targetState.ws.onerror = (error) => {
        console.warn('Terminal WebSocket error (connection lost):', error);
        updateStatus('error', targetState);
    };
}

// ─────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────

export const TerminalWidget = {
    /**
     * Write text to current session's terminal
     */
    write(text) {
        const sState = getSessionState();
        if (sState.terminal) {
            sState.terminal.write(text);
        }
    },

    /**
     * Send key to current session's terminal (for keyboard bar)
     */
    sendKey(key, modifiers = {}) {
        const sState = getSessionState();
        if (!sState.ws || sState.ws.readyState !== WebSocket.OPEN) return;

        const keyMap = {
            'Escape': '\x1b',
            'Tab': '\t',
            'ArrowUp': '\x1b[A',
            'ArrowDown': '\x1b[B',
            'ArrowRight': '\x1b[C',
            'ArrowLeft': '\x1b[D',
            'Home': '\x1b[H',
            'End': '\x1b[F',
            'PageUp': '\x1b[5~',
            'PageDown': '\x1b[6~',
            'Delete': '\x1b[3~',
            'Backspace': '\x7f',
        };

        let data = keyMap[key] || key;

        // Apply modifiers
        if (modifiers.ctrl && data.length === 1) {
            const code = data.toLowerCase().charCodeAt(0);
            if (code >= 97 && code <= 122) {
                data = String.fromCharCode(code - 96);
            }
        }

        sState.ws.send(data);
    },

    /**
     * Clear current session's terminal
     */
    clear() {
        const sState = getSessionState();
        if (sState.terminal) {
            sState.terminal.clear();
        }
    },

    /**
     * Focus current session's terminal
     */
    focus() {
        const sState = getSessionState();
        if (sState.terminal) {
            sState.terminal.focus();
        }
    },

    /**
     * Paste text from clipboard into the active terminal.
     * Returns true if paste was handled, false if no terminal available.
     */
    async paste() {
        // Find the right terminal state: last focused, or active tab, or session floating
        let target = lastFocusedIfRecent();
        if (!target) {
            // Check active widget tab
            const activeTabId = window.app?.tabCtrl?.activeWidgetTabId;
            if (activeTabId) {
                const tabState = tabStates.get(activeTabId);
                if (tabState?.ws?.readyState === WebSocket.OPEN) {
                    target = tabState;
                }
            }
        }
        if (!target) {
            // Fall back to session floating terminal
            const sState = getSessionState();
            if (sState.ws?.readyState === WebSocket.OPEN) {
                target = sState;
            }
        }
        if (!target) return false;

        try {
            const text = await navigator.clipboard.readText();
            if (!text) return false;
            if (target.bracketedPasteMode) {
                target.ws.send('\x1b[200~' + text + '\x1b[201~');
            } else {
                target.ws.send(text);
            }
            target.terminal?.focus();
            return true;
        } catch {
            return false;
        }
    },

    /**
     * Returns true if a terminal was recently focused (for paste routing)
     */
    isRecentlyFocused() {
        if (lastFocusedIfRecent()) return true;
        // Also check if active tab is a terminal
        const activeTabId = window.app?.tabCtrl?.activeWidgetTabId;
        if (activeTabId) {
            const tab = window.app?.tabCtrl?.widgetTabs?.find(t => t.id === activeTabId);
            if (tab && (tab.widgetId === 'terminal' || tab.isTerminal)) {
                const tabState = tabStates.get(activeTabId);
                if (tabState?.ws?.readyState === WebSocket.OPEN) return true;
            }
        }
        return false;
    },

    /**
     * Set font size (updates all session terminals and tab terminals)
     */
    setFontSize(fontSize) {
        for (const [, sState] of sessionStates) {
            if (sState.terminal) {
                sState.terminal.options.fontSize = fontSize;
                fitTerminal(sState);
            }
        }
        // Update all tab terminals
        for (const [, tabState] of tabStates) {
            if (tabState.terminal) {
                tabState.terminal.options.fontSize = fontSize;
                fitTerminal(tabState);
            }
        }
    },

    /**
     * Fit terminal to container
     */
    fit: () => {
        // Fit current session's terminal
        const sState = getSessionState();
        fitTerminal(sState);
        // Fit all tab terminals
        for (const [, tabState] of tabStates) {
            fitTerminal(tabState);
        }
    },

    /**
     * Get current state (for debugging)
     */
    getState: () => {
        const sessions = {};
        for (const [sid, sState] of sessionStates) {
            sessions[sid] = {
                connected: sState.connected,
                status: sState.status,
                cwd: sState.cwd,
                sessionId: sState.sessionId,
                initialized: sState.initialized,
            };
        }
        const tabs = {};
        for (const [tabId, tabState] of tabStates) {
            tabs[tabId] = {
                connected: tabState.connected,
                status: tabState.status,
                cwd: tabState.cwd,
                sessionId: tabState.sessionId,
                initialized: tabState.initialized,
            };
        }
        return {
            sessions,
            sessionCount: sessionStates.size,
            tabs,
            tabCount: tabStates.size
        };
    },

    /**
     * Check if current session's terminal is connected
     */
    isConnected: () => getSessionState().connected,

    /**
     * Get WebSocket (for keyboard bar routing - prefers current session, falls back to first tab with connection)
     */
    getWebSocket: () => {
        const sState = getSessionState();
        if (sState.ws) return sState.ws;
        for (const [, tabState] of tabStates) {
            if (tabState.ws) return tabState.ws;
        }
        return null;
    },

    /**
     * Get session terminal state (for advanced use)
     * @param {string} [sessionId] - Session ID (defaults to current)
     */
    getSessionTerminalState: (sessionId) => getSessionState(sessionId),

    /**
     * Get tab terminal state by ID (for advanced use)
     */
    getTabState: (tabId) => tabId ? tabStates.get(tabId) : null,

    /**
     * Remove and cleanup a tab terminal state
     */
    removeTabState: (tabId) => removeTabState(tabId),

    /**
     * Get all tab IDs
     */
    getTabIds: () => Array.from(tabStates.keys()),

    /**
     * Get next terminal tab number for naming (Terminal 1, Terminal 2, etc.)
     */
    getNextTabNumber: () => nextTabNumber(),

    /**
     * Check if transfer from current session's terminal is available
     */
    hasFloatingTerminal: () => !!getSessionState().terminal,

    /**
     * Get configured terminal size (for config panel)
     */
    getConfiguredSize,

    /**
     * Set configured terminal size
     */
    setConfiguredSize,

    /**
     * Reset configured terminal size to defaults
     */
    resetConfiguredSize,

    /** Default dimensions */
    DEFAULT_WIDTH: DEFAULT_TERMINAL_WIDTH,
    DEFAULT_HEIGHT: DEFAULT_TERMINAL_HEIGHT,

    /**
     * Attach terminal to a specific PTY session (e.g., orphaned PTY)
     * Opens the terminal widget and connects with the given sessionId
     * @param {string} ptySessionId - The terminal session ID to attach to
     * @param {string} cwd - Working directory (optional)
     */
    attachToSession(ptySessionId, cwd = null) {
        const sState = getSessionState();
        // Set forced session ID (will be used by connect instead of generating new one)
        sState.forceSessionId = ptySessionId;
        if (cwd) {
            sState.cwd = cwd;
        }

        // Open the terminal widget using WidgetManager API
        WidgetManager.open('terminal');

        // If already initialized, reconnect with new session
        // (if not initialized, the render function will call connect with forceSessionId)
        if (sState.initialized) {
            connect(sState);
        }
    },

    /**
     * Destroy state for a session
     */
    destroySessionState,
};
