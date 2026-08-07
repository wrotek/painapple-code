/**
 * Shared wrap-continuation detection for the terminal widget.
 *
 * One question, answered in one place: "is buffer row N a continuation
 * of row N-1?" — used by UrlLinkProvider (link stitching), init.js
 * (findUrlLink walk-back for the context menu) and
 * getUnwrappedTerminalSelection (copy without artificial newlines).
 * Before 2026-08 each of those re-implemented the test independently
 * and they drifted; keep them on this single implementation.
 *
 * Three producers of wrapped rows, three signals:
 *
 * 1. `isWrapped` — the terminal itself wrapped a long line. Reliable,
 *    survives resize (xterm reflows these rows).
 * 2. OSC 8 hyperlink id spanning the row boundary — TUIs (Ink/React,
 *    e.g. the Claude CLI's /login screen) pre-wrap their output with
 *    hard newlines, so isWrapped is false, but they tag every fragment
 *    of the same link with one OSC 8 id carrying the FULL url. Ids ride
 *    on cells, so this survives resize — unlike the width heuristic.
 * 3. Full-width heuristic — shells (fish/bash/zsh) manage their own
 *    line editor: previous row fills the terminal width AND this row
 *    starts with non-whitespace. Width-dependent: breaks after resize,
 *    which is why it's the last resort.
 *
 * OSC 8 access notes: `IBufferLine.getCell()` returns a CellData whose
 * `.extended.urlId` is real but not in the public typings, and the id →
 * uri lookup lives on `terminal._core._oscLinkService`. Both are stable
 * in the vendored xterm@5 bundle (property names are not mangled);
 * everything here is optional-chained so an xterm upgrade degrades to
 * the isWrapped + heuristic paths instead of throwing.
 *
 * This module is a LEAF — no sibling imports — so gestures.js can use
 * it without breaking its no-sibling-imports rule (circular-dep guard).
 */

/** OSC 8 hyperlink id at a cell (0-based col), or 0 if none. */
export function oscUrlIdAt(line, x) {
    try {
        const cell = line?.getCell?.(x);
        return (cell && cell.extended?.urlId) || 0;
    } catch (_) {
        return 0;
    }
}

/** OSC 8 id of the last content cell in a line, or 0. */
export function lastOscUrlId(line) {
    if (!line) return 0;
    try {
        for (let x = line.length - 1; x >= 0; x--) {
            const cell = line.getCell?.(x);
            if (!cell) return 0;
            if (cell.getChars() !== '' && cell.getChars() !== ' ') {
                return cell.extended?.urlId || 0;
            }
        }
    } catch (_) { /* fall through */ }
    return 0;
}

/** Resolve an OSC 8 id to its full URI via xterm internals, or null. */
export function oscUriForId(terminal, urlId) {
    if (!urlId) return null;
    try {
        return terminal?._core?._oscLinkService?.getLinkData?.(urlId)?.uri || null;
    } catch (_) {
        return null;
    }
}

/**
 * Full URI of the OSC 8 hyperlink covering a cell (0-based col/row in
 * buffer coordinates), or null. This is the exact string the emitting
 * program provided — no stitching, no heuristics.
 */
export function oscUriAt(terminal, col, row) {
    const line = terminal?.buffer?.active?.getLine(row);
    return oscUriForId(terminal, oscUrlIdAt(line, col));
}

/**
 * Is buffer row `rowIdx` (0-based) a continuation of row `rowIdx - 1`?
 * See module docstring for the three signals, in priority order.
 */
export function isContinuationRow(terminal, rowIdx) {
    const buffer = terminal?.buffer?.active;
    if (!buffer || rowIdx <= 0) return false;
    const line = buffer.getLine(rowIdx);
    if (!line) return false;
    if (line.isWrapped) return true;
    const prev = buffer.getLine(rowIdx - 1);
    if (!prev) return false;

    // OSC 8: same hyperlink id on both sides of the boundary.
    const prevId = lastOscUrlId(prev);
    if (prevId && prevId === oscUrlIdAt(line, 0)) return true;

    // Full-width heuristic (shell input wrapping).
    const prevText = prev.translateToString(true); // trimmed — actual content length
    return prevText.length >= terminal.cols && /^\S/.test(line.translateToString(false));
}
