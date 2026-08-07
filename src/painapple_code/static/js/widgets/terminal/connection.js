/**
 * Terminal WebSocket lifecycle — opens the `/ws/terminal` connection,
 * handles JSON control messages (connected/pong/heartbeat/exit) vs raw
 * PTY output, and auto-reconnects after drops. Also owns the explicit
 * `killTerminal` API used by the header action.
 *
 * The module-level `activeState` tracks which terminal is currently
 * connecting so that `handleJsonMessage` can default to it when called
 * from contexts that don't carry an explicit reference.
 */

import { CONFIG, debug } from '../../config.js';
import { WidgetManager } from '../../widget-system/index.js';
import { fitTerminal, tabStates } from './state.js';

// Track which state is currently active (for message handlers that don't have direct ref)
let activeState = null;

export function connect(targetState) {
    // Set active state for message handlers
    activeState = targetState;

    // Cancel any pending reconnect timer
    if (targetState.reconnectTimer) {
        clearTimeout(targetState.reconnectTimer);
        targetState.reconnectTimer = null;
    }

    // Clear stale buffer immediately so old content doesn't flash
    // before the server sends fresh scrollback on reconnect
    if (targetState.terminal) {
        targetState.terminal.clear();
        targetState.terminal.reset();
    }

    // Close existing WebSocket if any
    if (targetState.ws) {
        targetState.ws.onclose = null;
        targetState.ws.close();
    }

    // Use CWD as terminal session key
    const cwd = targetState.cwd || window.app?.activeSession?.cwd;

    if (!targetState._isTab) {
        // Session (floating) terminal
        // Check for forced session ID (e.g., attaching to orphaned terminal)
        if (targetState.forceSessionId) {
            targetState.sessionId = targetState.forceSessionId;
            targetState.forceSessionId = null;  // Clear after use
        } else {
            // Use widget-session-scoped ID to avoid PTY sharing between sessions
            const widgetSessionId = WidgetManager.currentSessionId || 'default';
            targetState.sessionId = cwd ? `session:${widgetSessionId}:${cwd}` : `session:${widgetSessionId}`;
        }
    } else {
        // Tab terminal - uses unique session ID per tab (already set in getOrCreateTabState)
        // Keep existing sessionId if set, otherwise generate new one
        if (!targetState.sessionId) {
            targetState.sessionId = `tab:${Date.now()}`;
        }
    }

    // Build WebSocket URL
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    let wsUrl = `${protocol}//${host}/ws/terminal?session=${encodeURIComponent(targetState.sessionId)}`;

    if (cwd) {
        wsUrl += `&cwd=${encodeURIComponent(cwd)}`;
    }

    targetState.ws = new WebSocket(wsUrl);
    updateStatus('connecting', targetState);

    targetState.ws.onopen = () => {
        debug.log('Terminal WebSocket connected');
    };

    targetState.ws.onmessage = (event) => {
        targetState.lastMessageAt = Date.now();
        const data = event.data;

        // Check if it's a WebSocket control message (JSON with known type)
        if (data.startsWith('{')) {
            try {
                const msg = JSON.parse(data);
                // Only intercept known WebSocket control messages
                const knownTypes = ['connected', 'pong', 'heartbeat', 'exit'];
                if (msg.type && knownTypes.includes(msg.type)) {
                    handleJsonMessage(msg, targetState);
                    return;
                }
                // Unknown JSON - fall through to write to terminal
            } catch (e) {
                // Not valid JSON, treat as terminal output
            }
        }

        // Raw terminal output (including unknown JSON)
        if (targetState.terminal) {
            if (targetState.loadingEl) {
                targetState.loadingEl.hidden = true;
            }
            // Track bracketed paste mode from shell's DECSET/DECRST sequences
            if (data.includes('\x1b[?2004h')) targetState.bracketedPasteMode = true;
            if (data.includes('\x1b[?2004l')) targetState.bracketedPasteMode = false;
            targetState.terminal.write(data);
        }
    };

    targetState.ws.onclose = (event) => {
        debug.log('Terminal WebSocket closed:', event.code, event.reason);
        targetState.connected = false;
        updateStatus('disconnected', targetState);

        // Auto-reconnect for both session (floating) and tab terminals
        if (!targetState.reconnectTimer) {
            const shouldReconnect = !targetState._isTab
                ? WidgetManager.get('terminal')?.isVisible
                : true; // Tab terminals always try to reconnect

            if (shouldReconnect) {
                debug.log('Scheduling terminal reconnect in 3s...');
                targetState.reconnectTimer = setTimeout(() => {
                    targetState.reconnectTimer = null;
                    // For session terminals, check if still visible
                    if (!targetState._isTab) {
                        const w = WidgetManager.get('terminal');
                        if (w?.isVisible) {
                            connect(targetState);
                        }
                    } else {
                        // For tab terminals, always reconnect
                        connect(targetState);
                    }
                }, 3000);
            }
        }
    };

    targetState.ws.onerror = (error) => {
        console.warn('Terminal WebSocket error (connection lost):', error);
        updateStatus('error', targetState);
    };
}

export function handleJsonMessage(msg, targetState = activeState) {
    switch (msg.type) {
        case 'connected':
            targetState.connected = true;
            if (targetState.loadingEl) {
                targetState.loadingEl.hidden = true;
            }
            updateStatus('connected', targetState);
            // Clear terminal buffer for fresh start
            if (targetState.terminal) {
                targetState.terminal.clear();
                targetState.terminal.reset();
            }
            // Send initial resize
            setTimeout(() => {
                fitTerminal(targetState);
                if (targetState.terminal && targetState.ws && targetState.ws.readyState === WebSocket.OPEN) {
                    const { rows, cols } = targetState.terminal;
                    targetState.ws.send(JSON.stringify({ type: 'resize', rows, cols }));
                }
            }, 100);
            // One-shot initial command (e.g. `claude auth login\n` for /login flow).
            // Delay slightly so the shell has rendered its prompt before we type.
            if (targetState.pendingInitialCommand && targetState.ws?.readyState === WebSocket.OPEN) {
                const cmd = targetState.pendingInitialCommand;
                targetState.pendingInitialCommand = null;  // consume once
                setTimeout(() => {
                    if (targetState.ws?.readyState === WebSocket.OPEN) {
                        targetState.ws.send(cmd);
                    }
                }, 300);
            }
            // Focus terminal only if visible (collapsed floating terminals
            // restored from localStorage shouldn't steal focus from active tabs)
            if (targetState.terminal) {
                const container = targetState.terminalContainer?.closest('.widget-tab-content, .widget');
                const isVisible = container?.classList.contains('active') ||
                    container?.classList.contains('widget-visible');
                if (isVisible) {
                    targetState.terminal.focus();
                }
            }
            break;

        case 'pong':
            // Heartbeat response (client-initiated)
            break;

        case 'heartbeat':
            // Server-initiated heartbeat - connection is alive
            debug.log('Terminal heartbeat received');
            break;

        case 'exit':
            targetState.connected = false;
            updateStatus('exited', targetState);
            // Cancel any pending reconnect
            if (targetState.reconnectTimer) {
                clearTimeout(targetState.reconnectTimer);
                targetState.reconnectTimer = null;
            }
            // Close WebSocket cleanly
            if (targetState.ws) {
                targetState.ws.onclose = null;
                targetState.ws.close();
                targetState.ws = null;
            }
            // Auto-close after brief delay
            if (!targetState._isTab) {
                setTimeout(() => {
                    WidgetManager.close('terminal');
                }, 500);
            } else {
                // Find and close the tab that owns this state
                setTimeout(() => {
                    for (const [tabId, state] of tabStates) {
                        if (state === targetState) {
                            // Request app to close this tab
                            window.app?.closeWidgetTab(tabId);
                            break;
                        }
                    }
                }, 500);
            }
            break;
    }
}

export function updateStatus(status, targetState) {
    targetState.status = status;

    const widget = WidgetManager.get('terminal');
    if (!widget) return;

    // Update summary in header
    const statusText = {
        connecting: 'Connecting...',
        connected: '',
        disconnected: 'Disconnected',
        error: 'Error',
        exited: 'Exited',
    }[status] || '';

    widget.setSummary(statusText);

    // Update status element if present
    if (targetState.statusEl) {
        targetState.statusEl.textContent = statusText;
        targetState.statusEl.className = `terminal-widget-status status-${status}`;
    }
}

export async function killTerminal(targetState) {
    if (!targetState.sessionId) return;

    try {
        const response = await fetch(`${CONFIG.API_BASE}/api/terminal/${encodeURIComponent(targetState.sessionId)}`, {
            method: 'DELETE'
        });

        if (response.ok) {
            if (targetState.terminal) {
                targetState.terminal.write('\r\n\x1b[31m[Terminal killed]\x1b[0m\r\n');
            }
            if (targetState.keyboardBar) {
                targetState.keyboardBar.resetModifiers();
            }
            // Reconnect will create a new terminal
            if (targetState.ws) {
                targetState.ws.close();
            }
        }
    } catch (err) {
        console.error('Failed to kill terminal:', err);
    }
}
