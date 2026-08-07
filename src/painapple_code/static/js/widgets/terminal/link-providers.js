/**
 * xterm.js link providers — URL detection (handling wrapped lines) and
 * file-path detection (with on-click resolution via /api/find-file).
 * Plus the lazy `loadXterm()` loader for the vendored xterm bundle.
 *
 * Both providers are pure xterm-addon classes — they don't reach back
 * into TerminalState. init.js wires them onto the terminal instance and
 * hands the file provider a `getCwd` closure (plus an optional
 * `getLiveCwd` refresher — see makeLiveCwdRefresher) so it stays in
 * sync when the session's CWD changes.
 *
 * Resolution is context-aware: bare filenames are resolved with the
 * shell's live cwd and with directory hints scraped from the terminal
 * lines above the click (e.g. the `ll docs-ai/readme/` command that
 * produced a bare-filename listing) — see collectDirHints().
 */

import { CONFIG } from '../../config.js';
import { showToast } from '../../context-menu.js';
import { openExternal } from '../../utils.js';
import {
    buildPathPattern,
    buildStandalonePattern,
    buildUrlPattern,
    parseLineInfo,
    isValidStandaloneFile,
    cleanUrlTrailingPunct
} from '../../linkify-utils.js';
import { isContinuationRow } from './wrap-utils.js';

// ─────────────────────────────────────────────────────────────────────
// xterm.js Loading
// ─────────────────────────────────────────────────────────────────────

export async function loadXterm() {
    // Check if already loaded
    if (window.Terminal && window.FitAddon) {
        return;
    }

    // Load CSS
    if (!document.querySelector('link[href*="xterm.css"]')) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = '/static/vendor/xterm.css';
        document.head.appendChild(link);
    }

    // Load xterm.js
    if (!window.Terminal) {
        await loadScript('/static/vendor/xterm.js');
    }

    // Load fit addon
    if (!window.FitAddon) {
        await loadScript('/static/vendor/xterm-addon-fit.js');
    }
}

function loadScript(src) {
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = src;
        script.onload = resolve;
        script.onerror = reject;
        document.head.appendChild(script);
    });
}

/**
 * Build a refresher that fetches the shell's live cwd for a terminal
 * state (/api/terminal-cwd reads /proc/<pid>/cwd, so it tracks the
 * user's `cd`s). The result is cached on `state.liveCwd` — deliberately
 * NOT written to `state.cwd`: the WS session key is derived from cwd,
 * so mutating it would re-key the PTY on reconnect instead of
 * reattaching to the running shell.
 */
export function makeLiveCwdRefresher(state) {
    return async () => {
        if (!state.sessionId) return null;
        try {
            const url = `${CONFIG.API_BASE}/api/terminal-cwd?session=${encodeURIComponent(state.sessionId)}`;
            const response = await fetch(url);
            if (!response.ok) return null;
            const data = await response.json();
            if (data.cwd) state.liveCwd = data.cwd;
            return data.cwd || null;
        } catch (_) {
            return null;
        }
    };
}

// ─────────────────────────────────────────────────────────────────────
// URL Link Provider — handles URLs that span wrapped terminal lines
// ─────────────────────────────────────────────────────────────────────

/**
 * Custom link provider for URLs that span wrapped terminal lines.
 * Replaces WebLinksAddon which only detects URLs within a single line.
 *
 * Row-continuation detection is shared with the copy paths — see
 * wrap-utils.js `isContinuationRow()` for the three wrapping scenarios
 * (terminal isWrapped, OSC 8 id spanning the boundary, shell-input
 * full-width heuristic).
 */
export class UrlLinkProvider {
    constructor(terminal) {
        this.terminal = terminal;
    }

    provideLinks(lineNumber, callback) {
        const buffer = this.terminal.buffer.active;
        const line = buffer.getLine(lineNumber - 1);
        if (!line) {
            callback(undefined);
            return;
        }

        const lineTexts = [];
        const lineNumbers = [];
        let currentLineNum = lineNumber;

        // Walk back to find the start of the logical line sequence.
        // (isContinuationRow takes 0-based row indices; lineNumber is 1-based.)
        while (currentLineNum > 1 && isContinuationRow(this.terminal, currentLineNum - 1)) {
            currentLineNum--;
        }

        // Collect all lines in this logical line sequence (always from start)
        let currentLine = buffer.getLine(currentLineNum - 1);
        while (currentLine) {
            let text = currentLine.translateToString(false);
            const joinsNext = isContinuationRow(this.terminal, currentLineNum);
            const nextLine = joinsNext ? buffer.getLine(currentLineNum) : null;
            if (nextLine && !nextLine.isWrapped) {
                // TUI-emitted continuation (OSC 8 / heuristic join): the row
                // may be shorter than the terminal width, and untrimmed text
                // pads it with blank cells — which would inject spaces into
                // the joined URL. Strip the padding; a URL never ends in
                // whitespace, so nothing legitimate is lost.
                text = text.replace(/\s+$/, '');
            }
            lineTexts.push(text);
            lineNumbers.push(currentLineNum);

            if (nextLine) {
                currentLineNum++;
                currentLine = nextLine;
            } else {
                break;
            }
        }

        const fullText = lineTexts.join('');
        if (!fullText.trim()) {
            callback(undefined);
            return;
        }

        // Convert character offset in combined text to multi-line range
        const offsetToRange = (startOffset, length) => {
            const endOffset = startOffset + length;
            let charCount = 0;
            let startLine = lineNumbers[0], startCol = startOffset + 1;
            for (let i = 0; i < lineTexts.length; i++) {
                const lineLen = lineTexts[i].length;
                if (charCount + lineLen > startOffset) {
                    startLine = lineNumbers[i];
                    startCol = (startOffset - charCount) + 1;
                    break;
                }
                charCount += lineLen;
            }
            charCount = 0;
            let endLine = lineNumbers[lineNumbers.length - 1], endCol = endOffset;
            for (let i = 0; i < lineTexts.length; i++) {
                const lineLen = lineTexts[i].length;
                if (charCount + lineLen >= endOffset) {
                    endLine = lineNumbers[i];
                    endCol = (endOffset - charCount);
                    break;
                }
                charCount += lineLen;
            }
            return { start: { x: startCol, y: startLine }, end: { x: endCol, y: endLine } };
        };

        const links = [];
        const urlPattern = buildUrlPattern();
        let match;
        while ((match = urlPattern.exec(fullText)) !== null) {
            const { url } = cleanUrlTrailingPunct(match[0]);
            links.push({
                range: offsetToRange(match.index, url.length),
                text: url,
                activate: (event, linkText) => {
                    if (event.button === 2) return;
                    // Anchor-click, not window.open — the latter silently
                    // no-ops in the iPad standalone PWA (see openExternal)
                    openExternal(url);
                }
            });
        }

        callback(links.length > 0 ? links : undefined);
    }
}

// ─────────────────────────────────────────────────────────────────────
// File Path Link Provider
// ─────────────────────────────────────────────────────────────────────

/**
 * Custom link provider for file paths in terminal output.
 * Uses xterm.js's ILinkProvider interface to detect and handle file path clicks.
 *
 * Detection happens on-demand (when xterm needs links for a line).
 * Verification happens on-click (to avoid performance overhead).
 */
export class FilePathLinkProvider {
    constructor(terminal, getCwd, getLiveCwd = null) {
        this.terminal = terminal;
        this.getCwd = getCwd; // Function to get current CWD (may change)
        this.getLiveCwd = getLiveCwd; // Optional async refresher for the shell's live cwd
        this.pathCache = new Map(); // Cache verified paths: path -> resolved
    }

    /**
     * Called by xterm.js when it needs links for a buffer line.
     * @param {number} lineNumber - 1-based line number in buffer
     * @param {function} callback - Callback with array of links or undefined
     */
    provideLinks(lineNumber, callback) {
        const buffer = this.terminal.buffer.active;
        // xterm passes 1-based line numbers; buffer.getLine() uses 0-based
        const line = buffer.getLine(lineNumber - 1);
        if (!line) {
            callback(undefined);
            return;
        }

        // Get terminal width for wrapped line handling

        // Collect the full sequence of wrapped lines starting from this line
        // A line is "wrapped" if the next line has isWrapped=true
        // NOTE: lineNumber/currentLineNum stay 1-based (for xterm range y-coordinates)
        const lineTexts = [];
        const lineNumbers = [];
        let currentLineNum = lineNumber;
        let currentLine = line;

        // First, check if this line is a continuation (isWrapped) - if so, find the start
        while (currentLineNum > 1) {
            const checkLine = buffer.getLine(currentLineNum - 1);
            if (checkLine && checkLine.isWrapped) {
                currentLineNum--;
            } else {
                break;
            }
        }

        // Now collect all lines in this wrapped sequence
        const startLineNum = currentLineNum;
        currentLine = buffer.getLine(currentLineNum - 1);

        while (currentLine) {
            lineTexts.push(currentLine.translateToString(false)); // false = don't trim right
            lineNumbers.push(currentLineNum);

            // Check if next line continues the wrap (0-based: currentLineNum+1-1 = currentLineNum)
            const nextLine = buffer.getLine(currentLineNum);
            if (nextLine && nextLine.isWrapped) {
                currentLineNum++;
                currentLine = nextLine;
            } else {
                break;
            }
        }

        // Only return links when called for the START of a wrapped sequence
        // This prevents duplicate link detection for continuation lines
        if (lineNumber !== startLineNum) {
            callback(undefined);
            return;
        }

        // Combine all wrapped lines into single text
        const fullText = lineTexts.join('');
        if (!fullText.trim()) {
            callback(undefined);
            return;
        }

        const links = [];
        const seenRanges = new Set(); // Avoid duplicate links at same position

        /**
         * Convert a character offset in the combined text to multi-line range
         */
        const offsetToRange = (startOffset, length) => {
            const endOffset = startOffset + length;

            // Find start line and column
            let charCount = 0;
            let startLine = lineNumbers[0];
            let startCol = startOffset + 1; // 1-based

            for (let i = 0; i < lineTexts.length; i++) {
                const lineLen = lineTexts[i].length;
                if (charCount + lineLen > startOffset) {
                    startLine = lineNumbers[i];
                    startCol = (startOffset - charCount) + 1;
                    break;
                }
                charCount += lineLen;
            }

            // Find end line and column (endOffset is exclusive, xterm end.x is inclusive)
            charCount = 0;
            let endLine = lineNumbers[lineNumbers.length - 1];
            let endCol = endOffset;

            for (let i = 0; i < lineTexts.length; i++) {
                const lineLen = lineTexts[i].length;
                if (charCount + lineLen >= endOffset) {
                    endLine = lineNumbers[i];
                    endCol = (endOffset - charCount);
                    break;
                }
                charCount += lineLen;
            }

            return {
                start: { x: startCol, y: startLine },
                end: { x: endCol, y: endLine }
            };
        };

        // Match paths with directories (e.g., src/app.js, ./config.yaml)
        const pathPattern = buildPathPattern();
        let match;
        while ((match = pathPattern.exec(fullText)) !== null) {
            const path = match[1];
            const lineInfo = match[2] || '';
            const fullMatch = match[0];

            // Skip invalid patterns
            if (!path.includes('/')) continue;
            if (/^\d+\.\d+/.test(path)) continue; // Version numbers
            if (/^\d+\/\d+/.test(path)) continue; // Fractions like 1/2

            const rangeKey = `${match.index}-${match.index + fullMatch.length}`;
            if (seenRanges.has(rangeKey)) continue;
            seenRanges.add(rangeKey);

            const range = offsetToRange(match.index, fullMatch.length);
            links.push({
                range,
                text: fullMatch,
                activate: (event, linkText) => this.handleClick(path, lineInfo, event, range.start.y)
            });
        }

        // Match standalone filenames (e.g., server.py, CLAUDE.md)
        const standalonePattern = buildStandalonePattern();
        while ((match = standalonePattern.exec(fullText)) !== null) {
            const filename = match[1];
            const lineInfo = match[2] || '';
            const fullMatch = match[0];

            // Get preceding text for context validation
            const precedingText = fullText.slice(Math.max(0, match.index - 20), match.index);

            // Validate the match
            if (!isValidStandaloneFile(filename, precedingText)) {
                continue;
            }

            const rangeKey = `${match.index}-${match.index + fullMatch.length}`;
            if (seenRanges.has(rangeKey)) continue;
            seenRanges.add(rangeKey);

            const range = offsetToRange(match.index, fullMatch.length);
            links.push({
                range,
                text: fullMatch,
                activate: (event, linkText) => this.handleClick(filename, lineInfo, event, range.start.y)
            });
        }

        callback(links.length > 0 ? links : undefined);
    }

    /**
     * Scan the terminal lines above a link for directory context — e.g.
     * the `ll docs-ai/readme/` command whose output is a bare-filename
     * listing, or an earlier `cd some/dir`. Returns candidate directories
     * (nearest line first, deduped, capped) that the server tries before
     * falling back to a project-wide search.
     *
     * @param {number} startLine - 1-based buffer line the link starts on
     * @returns {string[]} directory hints, most relevant first
     */
    collectDirHints(startLine, maxLines = 200, maxHints = 8) {
        const buffer = this.terminal?.buffer?.active;
        if (!buffer || !startLine) return [];

        const hints = [];
        const seen = new Set();
        const add = (dir) => {
            dir = dir.replace(/^\.\//, '').replace(/\/+$/, '');
            if (!dir || dir === '.' || dir === '..' || dir === '~') return;
            if (seen.has(dir)) return;
            seen.add(dir);
            hints.push(dir);
        };

        const pattern = buildPathPattern();
        const lowest = Math.max(1, startLine - maxLines);
        for (let y = startLine; y >= lowest && hints.length < maxHints; y--) {
            const text = buffer.getLine(y - 1)?.translateToString(true);
            if (!text || !text.includes('/')) continue;

            pattern.lastIndex = 0;
            let match;
            while ((match = pattern.exec(text)) !== null && hints.length < maxHints) {
                const token = match[1];
                if (!token.includes('/')) continue;
                if (token.endsWith('/')) {
                    add(token); // explicit directory (trailing slash)
                } else {
                    const parent = token.slice(0, token.lastIndexOf('/'));
                    if (parent) add(parent); // parent dir of a path-like token
                    add(token); // token itself may be a dir (`ls docs-ai/readme`)
                }
            }
        }
        return hints;
    }

    /**
     * Resolve a path string via /api/find-file, passing any context
     * hints along. Returns { path, isDir } with the resolved absolute
     * path, or null if not found / on error. Absolute and ~ paths go
     * through the server too so they get verified and classified as
     * file vs directory. Result is cached per (cwd, path, hints).
     */
    async resolveFullPath(path, cwd, hints = []) {
        if (!path) return null;
        const isAbsolute = path.startsWith('/') || path.startsWith('~');
        if (!cwd && !isAbsolute) return null;

        const cacheKey = `${cwd}:${path}:${hints.join('|')}`;
        let resolved = this.pathCache.get(cacheKey);
        if (resolved !== undefined) return resolved;

        try {
            const params = new URLSearchParams({ name: path });
            if (cwd) params.set('cwd', cwd);
            for (const h of hints) params.append('hint', h);
            const response = await fetch(`${CONFIG.API_BASE}/api/find-file?${params}`);
            const data = await response.json();
            resolved = (data.found && data.path)
                ? { path: data.path, isDir: !!data.is_dir }
                : null;
        } catch (err) {
            console.error('Failed to resolve file path:', err);
            resolved = null;
        }
        this.pathCache.set(cacheKey, resolved);
        return resolved;
    }

    /**
     * Handle click on a file path link.
     * Refreshes the shell's live cwd, gathers directory hints from the
     * surrounding terminal lines, verifies the path via the server API,
     * then opens preview — or the file explorer when the path is a
     * directory.
     */
    async handleClick(path, lineInfo, event, lineY = null) {
        // Don't open preview on right-click (context menu handles it)
        if (event && event.button === 2) return;

        let cwd = this.getCwd();
        if (this.getLiveCwd) {
            const live = await this.getLiveCwd();
            if (live) cwd = live;
        }
        const isAbsolute = path.startsWith('/') || path.startsWith('~');
        if (!cwd && !isAbsolute) {
            showToast('No working directory set', 'warning');
            return;
        }

        try {
            const hints = lineY ? this.collectDirHints(lineY) : [];
            const resolved = await this.resolveFullPath(path, cwd, hints);
            if (resolved) {
                // Directories open in the file explorer, not the preview
                if (resolved.isDir) {
                    window.FileExplorerWidget?.navigateTo?.(resolved.path);
                    return;
                }

                // Parse line info for preview options
                const opts = parseLineInfo(lineInfo) || {};

                // Ctrl/Cmd+click opens in editor, normal click opens preview
                if (event.metaKey || event.ctrlKey) {
                    window.app?.openFileInEditor?.(resolved.path);
                } else {
                    window.app?.previewFile?.(resolved.path, opts);
                }
            } else {
                showToast(`File not found: ${path}`, 'error');
            }
        } catch (err) {
            console.error('Failed to verify file path:', err);
            showToast(`Error verifying path: ${path}`, 'error');
        }
    }

    /**
     * Clear the path cache (e.g., when CWD changes)
     */
    clearCache() {
        this.pathCache.clear();
    }
}
