/**
 * Terminal widget rendering — paints the body shell (`.terminal-widget-body`
 * + xterm mount + loading indicator), mounts the keyboard bar on touch
 * devices, attaches touch gestures to the xterm area, sets up a
 * ResizeObserver that debounces fitTerminal() calls during window
 * resize, and re-parents the existing xterm DOM into the new container
 * when the widget transforms (top-sheet → floating → tab) so its
 * scrollback survives intact.
 */

import { KeyboardBar } from '../../keyboard-bar.js';
import { fitTerminal } from './state.js';
import { TerminalTouchGestures } from './gestures.js';

export function renderContent(container, targetState) {
    container.innerHTML = `
        <div class="terminal-widget-body">
            <div class="keyboard-bar-mount"></div>
            <div class="terminal-widget-xterm"></div>
            <div class="terminal-widget-loading">Connecting...</div>
        </div>
    `;

    // Store references in the appropriate state
    targetState.terminalContainer = container.querySelector('.terminal-widget-xterm');
    targetState.loadingEl = container.querySelector('.terminal-widget-loading');

    // Mount keyboard bar (touch devices only)
    const kbMount = container.querySelector('.keyboard-bar-mount');
    if (kbMount) {
        const refocus = () => { targetState.terminal?.focus(); };
        const kb = new KeyboardBar((key, modifiers) => {
            if (!targetState.ws || targetState.ws.readyState !== WebSocket.OPEN) return;

            const keyMap = {
                'Escape': '\x1b',
                'Tab': '\t',
                'ArrowUp': '\x1b[A',
                'ArrowDown': '\x1b[B',
                'ArrowRight': '\x1b[C',
                'ArrowLeft': '\x1b[D',
                'Home': '\x1b[H',
                'End': '\x1b[F',
                'Backspace': '\x7f',
            };

            let data = keyMap[key] || key;

            // Arrow keys with modifiers use CSI parameter encoding
            if ((modifiers.ctrl || modifiers.alt) &&
                ['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(key)) {
                const mod = 1 + (modifiers.alt ? 2 : 0) + (modifiers.ctrl ? 4 : 0);
                const suffix = { ArrowUp: 'A', ArrowDown: 'B', ArrowRight: 'C', ArrowLeft: 'D' };
                data = `\x1b[1;${mod}${suffix[key]}`;
            } else if (modifiers.ctrl && data.length === 1) {
                const code = data.toLowerCase().charCodeAt(0);
                if (code >= 97 && code <= 122) {
                    data = String.fromCharCode(code - 96);
                }
            } else if (modifiers.alt && !modifiers.ctrl) {
                data = '\x1b' + data;
            }

            targetState.ws.send(data);
        }, refocus, {
            onPaste: async () => {
                try {
                    const text = await navigator.clipboard.readText();
                    if (text && targetState.ws?.readyState === WebSocket.OPEN) {
                        if (targetState.bracketedPasteMode) {
                            targetState.ws.send('\x1b[200~' + text + '\x1b[201~');
                        } else {
                            targetState.ws.send(text);
                        }
                    }
                } catch (err) {
                    console.warn('[Terminal] Keyboard bar paste failed:', err);
                }
            }
        });

        const barEl = kb.render();
        if (barEl) {
            kbMount.replaceWith(barEl);
            targetState.keyboardBar = kb;
        } else {
            kbMount.remove();
        }
    }

    // Attach touch gestures (swipe→arrows, double-tap→Tab) on touch devices
    if (!targetState.touchGestures) {
        const gestures = new TerminalTouchGestures(() => targetState.ws, () => targetState.keyboardBar);
        const xtermArea = container.querySelector('.terminal-widget-xterm');
        if (xtermArea) {
            gestures.attach(xtermArea);
            targetState.touchGestures = gestures;
        }
    }

    // Add click handler to focus terminal when widget body is clicked
    const body = container.querySelector('.terminal-widget-body');
    if (body) {
        body.addEventListener('click', () => {
            if (targetState.terminal) {
                targetState.terminal.focus();
            }
        });
        // Also handle mousedown for immediate focus
        body.addEventListener('mousedown', (e) => {
            // Don't prevent default - let xterm handle selection
            if (targetState.terminal) {
                targetState.terminal.focus();
            }
        });
    }

    // ResizeObserver to detect container size changes (floating window resize, snap, maximize, …)
    // ensures xterm.js fitAddon.fit() runs whenever container dimensions change.
    if (targetState.terminalContainer) {
        // Cleanup previous observer if any
        if (targetState.resizeObserver) {
            targetState.resizeObserver.disconnect();
        }

        // Debounce fitTerminal calls during resize for performance
        let resizeTimeout = null;
        targetState.resizeObserver = new ResizeObserver((entries) => {
            // Clear any pending timeout
            if (resizeTimeout) {
                clearTimeout(resizeTimeout);
            }
            // Debounce: wait 16ms (roughly one frame) before fitting
            resizeTimeout = setTimeout(() => {
                fitTerminal(targetState);
            }, 16);
        });

        targetState.resizeObserver.observe(targetState.terminalContainer);
    }

    // If terminal already exists, move its DOM to the new container
    // (don't call terminal.open() again — it creates duplicate .xterm elements)
    if (targetState.terminal && targetState.terminalContainer) {
        const xtermEl = targetState.terminal.element;
        if (xtermEl) {
            targetState.terminalContainer.appendChild(xtermEl);
        }
        setTimeout(() => {
            fitTerminal(targetState);
            if (targetState.terminal) {
                targetState.terminal.focus();
            }
        }, 50);
        if (targetState.loadingEl) {
            targetState.loadingEl.hidden = targetState.connected;
        }
    }
}
