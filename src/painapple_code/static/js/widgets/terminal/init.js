/**
 * Terminal initialization — `initTerminal(targetState)` is the heavy
 * one-time setup that creates the xterm Terminal instance, attaches the
 * fit/link addons, wires native paste + selection-aware Cmd+C, attaches
 * right-click context menus and iOS touch handling for file/URL links
 * (tap opens the link, long-press shows the context menu), binds the
 * keyboard-bar modifier interception, and finally calls `connect()` to
 * open the WebSocket.
 *
 * Re-entrant: subsequent calls just verify the existing WebSocket is
 * alive (using the lastMessageAt staleness check) and reconnect if needed,
 * without recreating the xterm instance — this is what lets a Terminal
 * survive widget transforms (top-sheet → floating → tab) and tab focus.
 */

import { debug } from '../../config.js';
import { fileDownloadAction, getDownloadLabel, showToast } from '../../context-menu.js';
import S from '../../strings.js';
import { openExternal } from '../../utils.js';
import {
    fitTerminal,
    setLastFocused,
} from './state.js';
import {
    copyToClipboard,
    getUnwrappedTerminalSelection,
} from './gestures.js';
import {
    FilePathLinkProvider,
    UrlLinkProvider,
    loadXterm,
    makeLiveCwdRefresher,
} from './link-providers.js';
import { connect } from './connection.js';
import { registerOsc52Handler } from './osc52.js';
import { isContinuationRow, oscUriAt } from './wrap-utils.js';
import { isAbsolutePath, joinPath } from '../../path-utils.js';

// Tap-vs-scroll disambiguation for terminal link taps (mirrors
// chat-controller.js bindTapHandler): a touch that moves beyond this many
// px before lifting is a scroll/swipe, not a tap.
const TAP_MOVE_THRESHOLD = 10;
// Touch held this long opens the context menu (the touch equivalent of
// right-click); a shorter, stationary touch on a link activates it.
const LONG_PRESS_MS = 400;

export async function initTerminal(targetState) {
    if (targetState.terminal) {
        // Already initialized — verify the WebSocket is alive before reusing it.
        // Server heartbeats every 5s, so >8s without any message means the pipe
        // is half-dead (iPad PWA suspend, Wi-Fi blip). readyState can stay OPEN
        // long after TCP has gone silent, so we also check message freshness.
        const wsOpen = targetState.ws && targetState.ws.readyState === WebSocket.OPEN;
        const wsStale = targetState.lastMessageAt > 0
            && (Date.now() - targetState.lastMessageAt) > 8000;
        if (!targetState.connected || !wsOpen || wsStale) {
            connect(targetState);
        }
        targetState.terminal.focus();
        return;
    }

    // Prevent concurrent initTerminal calls (race between render() and onOpen()
    // during widget creation — both fire before the async loadXterm() completes)
    if (targetState._initializing) return;
    targetState._initializing = true;

    if (targetState.loadingEl) {
        targetState.loadingEl.hidden = false;
    }

    try {
        await loadXterm();

        // Create terminal instance (use scaled font size from app)
        const fontScale = window.app?.fontScale ?? 1;
        targetState.terminal = new Terminal({
            cursorBlink: false,
            cursorStyle: 'bar',
            fontSize: Math.round(13 * fontScale),
            fontFamily: "'SF Mono', Menlo, Monaco, 'Courier New', monospace",
            theme: {
                background: '#1a1a2e',
                foreground: '#e0e0e0',
                cursor: '#3b82f6',
                cursorAccent: '#1a1a2e',
                selectionBackground: 'rgba(59, 130, 246, 0.3)',
                black: '#1a1a2e',
                red: '#ef4444',
                green: '#22c55e',
                yellow: '#eab308',
                blue: '#3b82f6',
                magenta: '#a855f7',
                cyan: '#06b6d4',
                white: '#e0e0e0',
                brightBlack: '#6b7280',
                brightRed: '#f87171',
                brightGreen: '#4ade80',
                brightYellow: '#facc15',
                brightBlue: '#60a5fa',
                brightMagenta: '#c084fc',
                brightCyan: '#22d3ee',
                brightWhite: '#ffffff',
            },
            scrollback: 5000,
            allowProposedApi: true,
            // OSC 8 hyperlinks: TUIs (e.g. the Claude CLI's /login screen)
            // emit the FULL url as link metadata on every visual fragment.
            // With a linkHandler set, xterm's built-in OscLinkProvider makes
            // those fragments hoverable/clickable with the exact uri — no
            // wrap stitching involved.
            linkHandler: {
                activate: (event, uri) => {
                    if (event.button === 2) return; // right-click → context menu
                    openExternal(uri);
                },
            },
        });

        // Load and attach fit addon
        targetState.fitAddon = new FitAddon.FitAddon();
        targetState.terminal.loadAddon(targetState.fitAddon);

        // OSC 52 — lets programs inside the terminal (vim's `y`, tmux) write
        // to the system clipboard. Registered here, at construction, and only
        // here: the Terminal instance survives WebSocket reconnects and the
        // floating→tab transfer, so registering anywhere on those paths would
        // double-fire the handler.
        registerOsc52Handler(targetState);

        // Register URL link provider (handles multi-line wrapped URLs)
        const urlLinkProvider = new UrlLinkProvider(targetState.terminal);
        targetState.terminal.registerLinkProvider(urlLinkProvider);
        targetState.urlLinkProvider = urlLinkProvider;

        // Register file path link provider for clickable file paths.
        // Live cwd (/proc-based, tracks the user's `cd`s) is preferred over
        // the spawn cwd for resolving relative paths.
        const refreshLiveCwd = makeLiveCwdRefresher(targetState);
        const filePathProvider = new FilePathLinkProvider(
            targetState.terminal,
            () => targetState.liveCwd || targetState.cwd,
            refreshLiveCwd
        );
        targetState.terminal.registerLinkProvider(filePathProvider);
        targetState.filePathProvider = filePathProvider;

        // Open terminal in container
        if (targetState.terminalContainer) {
            targetState.terminal.open(targetState.terminalContainer);
            fitTerminal(targetState);

            // Track focus for paste action routing
            targetState.terminal.textarea?.addEventListener('focus', () => {
                setLastFocused(targetState);
            });

            // Handle paste via native event (avoids macOS clipboard permission popup).
            // stopImmediatePropagation prevents xterm's own paste handler from also
            // sending the text through onData, which would cause double paste.
            targetState.terminal.textarea?.addEventListener('paste', (e) => {
                e.preventDefault();
                e.stopImmediatePropagation();
                const text = e.clipboardData?.getData('text');
                if (text && targetState.ws?.readyState === WebSocket.OPEN) {
                    if (targetState.bracketedPasteMode) {
                        targetState.ws.send('\x1b[200~' + text + '\x1b[201~');
                    } else {
                        targetState.ws.send(text);
                    }
                }
            }, true);

            // ── Helpers for terminal link context menus ──

            /**
             * Get buffer cell coordinates from client (mouse/touch) coordinates.
             * Returns { col (1-based), bufferLine (1-based) } or null.
             */
            const getCellAt = (clientX, clientY) => {
                const terminal = targetState.terminal;
                const screen = targetState.terminalContainer?.querySelector('.xterm-screen');
                if (!terminal || !screen) return null;

                const rect = screen.getBoundingClientRect();
                const cellWidth = rect.width / terminal.cols;
                const cellHeight = rect.height / terminal.rows;
                const col = Math.floor((clientX - rect.left) / cellWidth) + 1;
                const viewportRow = Math.floor((clientY - rect.top) / cellHeight);
                const bufferLine = viewportRow + terminal.buffer.active.viewportY + 1;
                return { col, bufferLine };
            };

            /**
             * Find a file path link at the given buffer position.
             * Returns { type: 'file', text, path, fullPath, cwd, bufferLine } or null.
             */
            const findFileLink = (col, bufferLine) => {
                if (!targetState.filePathProvider) return null;

                let detectedLinks = null;
                targetState.filePathProvider.provideLinks(bufferLine, (links) => {
                    detectedLinks = links;
                });
                if (!detectedLinks) return null;

                const clickedLink = detectedLinks.find(link => {
                    const r = link.range;
                    if (bufferLine < r.start.y || bufferLine > r.end.y) return false;
                    if (bufferLine === r.start.y && col < r.start.x) return false;
                    if (bufferLine === r.end.y && col > r.end.x) return false;
                    return true;
                });
                if (!clickedLink) return null;

                const linkText = clickedLink.text;
                const pathMatch = linkText.match(/^(.+?)(?::\d|#L\d)/);
                const path = pathMatch ? pathMatch[1] : linkText;
                const cwd = targetState.liveCwd || targetState.cwd || '';
                const fullPath = (isAbsolutePath(path) || path.startsWith('~')) ? path : joinPath(cwd, path);
                return { type: 'file', text: linkText, path, fullPath, cwd, bufferLine: clickedLink.range?.start?.y || bufferLine };
            };

            /**
             * Find a URL at the given buffer position (handles wrapped lines).
             * Returns { type: 'url', url } or null.
             */
            const findUrlLink = (col, bufferLine) => {
                // OSC 8 hyperlink at the cell? The emitting program gave us
                // the exact full uri — no stitching needed, resize-proof.
                const oscUri = oscUriAt(targetState.terminal, col - 1, bufferLine - 1);
                if (oscUri && /^https?:/i.test(oscUri)) {
                    return { type: 'url', url: oscUri };
                }

                const provider = targetState.urlLinkProvider;
                if (!provider) return null;

                // provideLinks expects the start line of a logical sequence.
                // Walk back using the same shared continuation test the
                // provider uses (isContinuationRow takes 0-based rows).
                const buffer = targetState.terminal?.buffer?.active;
                if (!buffer) return null;
                let startLine = bufferLine;
                while (startLine > 1 && isContinuationRow(targetState.terminal, startLine - 1)) {
                    startLine--;
                }

                let detectedLinks = null;
                targetState.urlLinkProvider.provideLinks(startLine, (links) => {
                    detectedLinks = links;
                });
                if (!detectedLinks) return null;

                const clickedLink = detectedLinks.find(link => {
                    const r = link.range;
                    if (bufferLine < r.start.y || bufferLine > r.end.y) return false;
                    if (bufferLine === r.start.y && col < r.start.x) return false;
                    if (bufferLine === r.end.y && col > r.end.x) return false;
                    return true;
                });
                return clickedLink ? { type: 'url', url: clickedLink.text } : null;
            };

            /**
             * Find any link (file or URL) at client coordinates.
             * URLs take priority (more specific — require https:// prefix).
             */
            const findLinkAt = (clientX, clientY) => {
                const cell = getCellAt(clientX, clientY);
                if (!cell) return null;
                return findUrlLink(cell.col, cell.bufferLine)
                    || findFileLink(cell.col, cell.bufferLine);
            };

            /** Copy text to clipboard with toast notification. */
            const copyToClip = async (text) => {
                try {
                    await navigator.clipboard.writeText(text);
                    showToast('Copied');
                } catch (_) {}
            };

            /**
             * Show the appropriate context menu for a detected link.
             */
            const showTerminalLinkMenu = async (link, x, y) => {
                const ctx = window.app?.contextMenu;
                if (!ctx) return;

                if (link.type === 'url') {
                    ctx.show(x, y, [
                        { label: S.context_menus.link.copy_url, action: () => copyToClip(link.url) },
                        { type: 'separator' },
                        { label: S.context_menus.link.open_new_tab, action: () => openExternal(link.url) },
                    ]);
                } else {
                    // File path link — resolve against live context before showing
                    // the menu: refresh the shell's real cwd (tracks `cd`s), then
                    // let the server try directory hints scraped from the lines
                    // above the link (e.g. the `ll docs-ai/readme/` command that
                    // produced a bare-filename listing) before any project-wide
                    // search.
                    const { path } = link;
                    const cwd = (await refreshLiveCwd()) || link.cwd;
                    let fullPath = (isAbsolutePath(path) || path.startsWith('~'))
                        ? path : joinPath(cwd, path);
                    let isDir = false;
                    if (targetState.filePathProvider) {
                        const hints = targetState.filePathProvider.collectDirHints(link.bufferLine);
                        const resolved = await targetState.filePathProvider.resolveFullPath(path, cwd, hints);
                        if (resolved) {
                            fullPath = resolved.path;
                            isDir = resolved.isDir;
                        }
                    }
                    if (isDir) {
                        ctx.show(x, y, [
                            { label: S.context_menus.file.copy_path, action: () => copyToClip(path) },
                            { label: S.context_menus.file.copy_full_path, action: () => copyToClip(fullPath) },
                            { type: 'separator' },
                            { label: S.context_menus.file.open_explorer, action: () => window.FileExplorerWidget?.navigateTo?.(fullPath) },
                        ]);
                        return;
                    }
                    ctx.show(x, y, [
                        { label: S.context_menus.file.copy_path, action: () => copyToClip(path) },
                        { label: S.context_menus.file.copy_full_path, action: () => copyToClip(fullPath) },
                        { type: 'separator' },
                        { label: S.context_menus.file.preview, action: () => window.app?.previewFile?.(fullPath) },
                        { label: S.context_menus.file.open_editor, action: () => window.app?.openFileInEditor?.(fullPath) },
                        { type: 'separator' },
                        {
                            label: S.context_menus.file.show_history,
                            action: () => {
                                const relativePath = fullPath.startsWith(cwd + '/')
                                    ? fullPath.slice(cwd.length + 1) : path;
                                window.app?.showFileHistory?.(relativePath, cwd);
                            }
                        },
                        {
                            label: getDownloadLabel(),
                            action: () => fileDownloadAction(fullPath)
                        }
                    ]);
                }
            };

            /** Show a basic Copy/Paste context menu (non-link areas). */
            const showTerminalCopyPasteMenu = (x, y, state) => {
                const ctx = window.app?.contextMenu;
                if (!ctx) return;
                const items = [];
                const sel = getUnwrappedTerminalSelection(state.terminal);
                if (sel) {
                    items.push({ label: S.context_menus.terminal.copy, action: () => {
                        copyToClipboard(sel);
                        state.terminal?.clearSelection();
                    }});
                }
                items.push({ label: S.context_menus.terminal.paste, action: async () => {
                    try {
                        const text = await navigator.clipboard.readText();
                        if (text && state.ws?.readyState === WebSocket.OPEN) {
                            if (state.bracketedPasteMode) {
                                state.ws.send('\x1b[200~' + text + '\x1b[201~');
                            } else {
                                state.ws.send(text);
                            }
                        }
                    } catch (err) {
                        console.warn('[Terminal] Paste failed:', err);
                    }
                    state.terminal?.focus();
                }});
                ctx.show(x, y, items);
            };

            // ── Right-click context menu for links in terminal ──

            targetState.terminalContainer.addEventListener('contextmenu', (e) => {
                // Always suppress native menu — CSS -webkit-touch-callout:none blocks it on iOS anyway
                e.preventDefault();
                e.stopPropagation();
                const link = findLinkAt(e.clientX, e.clientY);
                if (link) {
                    showTerminalLinkMenu(link, e.clientX, e.clientY);
                } else {
                    // No link — show Copy/Paste menu
                    showTerminalCopyPasteMenu(e.clientX, e.clientY, targetState);
                }
            });

            // ── iOS touch handling for links (contextmenu doesn't fire on iOS touch) ──
            // xterm renders canvas cells (no real <a> anchors), and its
            // Linkifier2 click activation needs a mouse hover that touch never
            // produces — so both paths here bypass it via findLinkAt():
            //   • plain tap on a link → open it directly (same end behavior
            //     as tapping an <a target="_blank"> in chat)
            //   • long-press → options context menu (copy / open / history…)
            {
                let lpTimer = null;
                let lpClickBlocker = null;
                let touchStartX = 0;
                let touchStartY = 0;
                let touchMoved = false;

                const cancelLpTimer = () => {
                    if (lpTimer) {
                        clearTimeout(lpTimer);
                        lpTimer = null;
                    }
                };

                const removeLpBlocker = () => {
                    if (lpClickBlocker) {
                        document.removeEventListener('click', lpClickBlocker, { capture: true });
                        lpClickBlocker = null;
                    }
                };

                /**
                 * Activate a link directly (tap path). URLs mirror
                 * UrlLinkProvider.activate; file paths reuse the provider's
                 * click handler (live-cwd refresh + dir hints + resolution).
                 */
                const activateLink = (link, event) => {
                    if (link.type === 'url') {
                        openExternal(link.url);
                    } else if (targetState.filePathProvider) {
                        const lineInfo = link.text.startsWith(link.path)
                            ? link.text.slice(link.path.length) : '';
                        targetState.filePathProvider.handleClick(
                            link.path, lineInfo, event, link.bufferLine);
                    }
                };

                targetState.terminalContainer.addEventListener('touchstart', (e) => {
                    if (e.touches.length !== 1) {
                        // Second finger down — pinch/scroll, not a tap or long-press
                        cancelLpTimer();
                        touchMoved = true;
                        return;
                    }
                    removeLpBlocker();

                    const touch = e.touches[0];
                    const x = touch.clientX;
                    const y = touch.clientY;
                    touchStartX = x;
                    touchStartY = y;
                    touchMoved = false;

                    lpTimer = setTimeout(() => {
                        lpTimer = null;

                        const link = findLinkAt(x, y);
                        if (link) {
                            // Block the synthetic click that iOS fires after touchend
                            // (only needed for links to prevent accidental navigation)
                            lpClickBlocker = (evt) => {
                                evt.preventDefault();
                                evt.stopPropagation();
                                evt.stopImmediatePropagation();
                            };
                            document.addEventListener('click', lpClickBlocker, { capture: true });
                            showTerminalLinkMenu(link, x, y);
                        } else {
                            // No link — show Copy/Paste menu (no click blocker needed)
                            showTerminalCopyPasteMenu(x, y, targetState);
                        }
                    }, LONG_PRESS_MS);
                }, { passive: true });

                targetState.terminalContainer.addEventListener('touchend', (e) => {
                    const tapPending = lpTimer !== null; // long-press never fired
                    cancelLpTimer();

                    if (lpClickBlocker) {
                        e.preventDefault();
                        e.stopPropagation();
                        // Remove after iOS synthetic click window
                        setTimeout(removeLpBlocker, 400);
                        return;
                    }

                    // Plain tap (stationary, shorter than a long-press): open the
                    // link under the finger. With a context menu open, the tap
                    // just dismisses the menu (same guard as chat's bindTapHandler).
                    if (tapPending && !touchMoved && !window.app?.contextMenu?.visible) {
                        const touch = e.changedTouches[0];
                        const link = touch && findLinkAt(touch.clientX, touch.clientY);
                        if (link) {
                            // Suppress the synthetic click so xterm doesn't also
                            // process it (focus/keyboard flash, mouse-mode reporting)
                            e.preventDefault();
                            activateLink(link, e);
                        }
                    }
                }, { passive: false });

                targetState.terminalContainer.addEventListener('touchmove', (e) => {
                    if (touchMoved) return;
                    const touch = e.touches[0];
                    if (!touch) return;
                    if (Math.abs(touch.clientX - touchStartX) > TAP_MOVE_THRESHOLD ||
                        Math.abs(touch.clientY - touchStartY) > TAP_MOVE_THRESHOLD) {
                        touchMoved = true;
                        cancelLpTimer();
                    }
                }, { passive: true });

                targetState.terminalContainer.addEventListener('touchcancel', () => {
                    // OS stole the gesture (edge swipe, notification pull) —
                    // don't let the pending long-press fire with no finger down
                    cancelLpTimer();
                    touchMoved = true;
                }, { passive: true });
            }
        }

        // Handle terminal input (intercept for keyboard bar modifiers)
        targetState.terminal.onData(data => {
            if (targetState.ws && targetState.ws.readyState === WebSocket.OPEN) {
                // If keyboard bar has active modifiers, apply them to typed characters
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

        // Handle resize
        targetState.terminal.onResize(({ rows, cols }) => {
            if (targetState.ws && targetState.ws.readyState === WebSocket.OPEN) {
                targetState.ws.send(JSON.stringify({ type: 'resize', rows, cols }));
            }
        });

        // Instance-level key handler (survives DOM container re-renders unlike DOM listeners)
        // Must preventDefault() to stop browser native events from also firing (causes double paste etc.)
        targetState.terminal.attachCustomKeyEventHandler((e) => {
            if (e.type !== 'keydown') return true;

            // Virtual modifier keys from keyboard bar (Ctrl/Alt)
            // Intercept here (before xterm processes) so iOS keyboard input gets modified
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

            // Cmd+C (Mac/iPad) → copy selection to clipboard (unwrapped)
            if (key === 'c' && e.metaKey && !e.ctrlKey) {
                const selection = getUnwrappedTerminalSelection(targetState.terminal);
                debug.log('[Terminal] Cmd+C handler: selection =', JSON.stringify(selection?.substring(0, 80)));
                if (selection) {
                    e.preventDefault();
                    copyToClipboard(selection);
                }
                return false;
            }

            // Ctrl+C → send SIGINT explicitly (xterm.js unreliable on iPad)
            if (key === 'c' && e.ctrlKey && !e.metaKey) {
                e.preventDefault();
                if (targetState.ws && targetState.ws.readyState === WebSocket.OPEN) {
                    targetState.ws.send('\x03');
                }
                return false;
            }

            // Cmd+V (Mac/iPad) → let browser fire native 'paste' event
            // (handled by paste listener below — avoids macOS clipboard permission popup)
            if (key === 'v' && e.metaKey && !e.ctrlKey) {
                return false;
            }

            // Cmd+N / Ctrl+N → let bubble to shortcut handler (new draft)
            if (key === 'n' && (e.metaKey || e.ctrlKey)) {
                return false;
            }

            // Cmd+/ / Ctrl+/ → let bubble to shortcut handler (focus chat input)
            if (key === '/' && (e.metaKey || e.ctrlKey)) {
                return false;
            }

            return true;
        });

        // Connect to backend
        connect(targetState);
        targetState.initialized = true;
        targetState._initializing = false;

        // Focus tab terminals now that xterm is ready. On first creation,
        // switchToWidgetTab's 50ms focus fires before xterm loads from CDN,
        // so this is the earliest reliable point to focus.
        // Only for tab terminals — floating terminals shouldn't steal focus.
        if (targetState._isTab) {
            requestAnimationFrame(() => targetState.terminal?.focus());
        }

    } catch (err) {
        targetState._initializing = false;
        console.error('Failed to initialize terminal:', err);
        if (targetState.loadingEl) {
            targetState.loadingEl.textContent = `Error: ${err.message}`;
        }
    }
}
