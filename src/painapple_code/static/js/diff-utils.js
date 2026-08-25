/**
 * Smart Diff Utilities
 *
 * Provides human-friendly diff visualization:
 * - Line matching (don't duplicate unchanged lines)
 * - Word-level highlighting for modified lines
 * - Collapsible unchanged sections
 */

/**
 * Compute the longest common subsequence of two arrays
 * Returns indices mapping: [oldIndex, newIndex] pairs for matching lines
 */
function computeLCS(oldLines, newLines) {
    const m = oldLines.length;
    const n = newLines.length;

    // DP table
    const dp = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            if (oldLines[i - 1] === newLines[j - 1]) {
                dp[i][j] = dp[i - 1][j - 1] + 1;
            } else {
                dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
            }
        }
    }

    // Backtrack to find the actual LCS
    const matches = [];
    let i = m, j = n;
    while (i > 0 && j > 0) {
        if (oldLines[i - 1] === newLines[j - 1]) {
            matches.unshift([i - 1, j - 1]);
            i--; j--;
        } else if (dp[i - 1][j] > dp[i][j - 1]) {
            i--;
        } else {
            j--;
        }
    }

    return matches;
}

/**
 * Find word-level differences between two similar lines
 * Returns HTML with highlighted changes
 */
function computeWordDiff(oldLine, newLine, escapeHtml) {
    // Tokenize by word boundaries (keep whitespace as tokens)
    const tokenize = (str) => str.match(/\S+|\s+/g) || [''];

    const oldTokens = tokenize(oldLine);
    const newTokens = tokenize(newLine);

    // Find common prefix
    let prefixLen = 0;
    while (prefixLen < oldTokens.length &&
           prefixLen < newTokens.length &&
           oldTokens[prefixLen] === newTokens[prefixLen]) {
        prefixLen++;
    }

    // Find common suffix (from the remaining tokens)
    let oldSuffixStart = oldTokens.length;
    let newSuffixStart = newTokens.length;
    while (oldSuffixStart > prefixLen &&
           newSuffixStart > prefixLen &&
           oldTokens[oldSuffixStart - 1] === newTokens[newSuffixStart - 1]) {
        oldSuffixStart--;
        newSuffixStart--;
    }

    // Build HTML for old line (removed parts highlighted)
    // Skip wrapping whitespace-only tokens to avoid cluttered highlight boxes
    const buildHtml = (tokens, start, end, highlightClass) => {
        let html = '';
        for (let i = 0; i < tokens.length; i++) {
            const token = escapeHtml(tokens[i]);
            const isWhitespace = /^\s+$/.test(tokens[i]);
            if (i >= start && i < end && !isWhitespace) {
                html += `<span class="${highlightClass}">${token}</span>`;
            } else {
                html += token;
            }
        }
        return html;
    };

    return {
        oldHtml: buildHtml(oldTokens, prefixLen, oldSuffixStart, 'diff-word-removed'),
        newHtml: buildHtml(newTokens, prefixLen, newSuffixStart, 'diff-word-added')
    };
}

/**
 * Check if two lines are "similar enough" to show as modified
 * rather than as separate remove + add
 */
function areSimilarLines(oldLine, newLine) {
    if (!oldLine || !newLine) return false;

    // If one is much longer than the other, not similar
    const lenRatio = Math.min(oldLine.length, newLine.length) /
                     Math.max(oldLine.length, newLine.length);
    if (lenRatio < 0.3) return false;

    // Check common prefix/suffix ratio
    let commonChars = 0;
    const minLen = Math.min(oldLine.length, newLine.length);

    // Count matching prefix
    for (let i = 0; i < minLen && oldLine[i] === newLine[i]; i++) {
        commonChars++;
    }

    // Count matching suffix
    for (let i = 0; i < minLen &&
         oldLine[oldLine.length - 1 - i] === newLine[newLine.length - 1 - i] &&
         commonChars < minLen; i++) {
        commonChars++;
    }

    // Consider similar if >40% characters match in prefix+suffix
    return commonChars / Math.max(oldLine.length, newLine.length) > 0.4;
}

/**
 * Generate a smart unified diff
 *
 * @param {string[]} oldLines - Original lines
 * @param {string[]} newLines - New lines
 * @param {number} startLine - Starting line number in file
 * @param {function} escapeHtml - HTML escaping function
 * @param {object} options - Options for diff generation
 * @returns {object[]} Array of diff entries
 */
function generateSmartDiff(oldLines, newLines, startLine, escapeHtml, options = {}) {
    const { contextLines = 2, collapseThreshold = 4 } = options;

    const matches = computeLCS(oldLines, newLines);
    const result = [];

    let oldIdx = 0;
    let newIdx = 0;
    let matchIdx = 0;

    // Track line numbers (separate for old and new)
    let oldLineNum = startLine;
    let newLineNum = startLine;

    while (oldIdx < oldLines.length || newIdx < newLines.length) {
        // Check if current position is a match
        if (matchIdx < matches.length &&
            matches[matchIdx][0] === oldIdx &&
            matches[matchIdx][1] === newIdx) {
            // This is an unchanged line
            result.push({
                type: 'context',
                oldLineNum: oldLineNum,
                newLineNum: newLineNum,
                content: escapeHtml(oldLines[oldIdx]) || ' '
            });
            oldIdx++; newIdx++; matchIdx++;
            oldLineNum++; newLineNum++;
        } else {
            // Collect consecutive changes until next match
            const nextMatch = matchIdx < matches.length ? matches[matchIdx] : [oldLines.length, newLines.length];

            const removedLines = [];
            const addedLines = [];

            while (oldIdx < nextMatch[0]) {
                removedLines.push({ idx: oldIdx, line: oldLines[oldIdx], lineNum: oldLineNum });
                oldIdx++; oldLineNum++;
            }
            while (newIdx < nextMatch[1]) {
                addedLines.push({ idx: newIdx, line: newLines[newIdx], lineNum: newLineNum });
                newIdx++; newLineNum++;
            }

            // Try to pair similar lines for inline diff
            const paired = [];
            const unpaired = { removed: [...removedLines], added: [...addedLines] };

            // Simple greedy pairing of similar lines
            for (let r = 0; r < unpaired.removed.length; r++) {
                for (let a = 0; a < unpaired.added.length; a++) {
                    if (areSimilarLines(unpaired.removed[r].line, unpaired.added[a].line)) {
                        paired.push({
                            removed: unpaired.removed[r],
                            added: unpaired.added[a]
                        });
                        unpaired.removed.splice(r, 1);
                        unpaired.added.splice(a, 1);
                        r--; // Adjust index after splice
                        break;
                    }
                }
            }

            // Collect all change entries with sort keys
            const changeEntries = [];

            // Unpaired removed lines (use old line num as sort key)
            for (const r of unpaired.removed) {
                changeEntries.push({
                    type: 'removed',
                    oldLineNum: r.lineNum,
                    sortKey: r.lineNum,  // Sort by old position
                    content: escapeHtml(r.line) || ' '
                });
            }

            // Paired (modified) lines with word diff
            for (const p of paired) {
                const wordDiff = computeWordDiff(p.removed.line, p.added.line, escapeHtml);
                changeEntries.push({
                    type: 'modified',
                    oldLineNum: p.removed.lineNum,
                    newLineNum: p.added.lineNum,
                    sortKey: p.added.lineNum,  // Sort by new position
                    oldContent: wordDiff.oldHtml,
                    newContent: wordDiff.newHtml
                });
            }

            // Unpaired added lines
            for (const a of unpaired.added) {
                changeEntries.push({
                    type: 'added',
                    newLineNum: a.lineNum,
                    sortKey: a.lineNum,  // Sort by new position
                    content: escapeHtml(a.line) || ' '
                });
            }

            // Sort all changes by their position and add to result
            changeEntries.sort((a, b) => a.sortKey - b.sortKey);
            for (const entry of changeEntries) {
                delete entry.sortKey;  // Remove temporary sort key
                result.push(entry);
            }
        }
    }

    // Collapse long sequences of context lines
    return collapseContext(result, contextLines, collapseThreshold);
}

/**
 * Collapse long sequences of unchanged context lines
 */
function collapseContext(entries, contextLines, threshold) {
    const result = [];
    let contextRun = [];

    for (const entry of entries) {
        if (entry.type === 'context') {
            contextRun.push(entry);
        } else {
            // Flush context run
            if (contextRun.length > 0) {
                result.push(...collapseRun(contextRun, contextLines, threshold));
                contextRun = [];
            }
            result.push(entry);
        }
    }

    // Flush final context run
    if (contextRun.length > 0) {
        result.push(...collapseRun(contextRun, contextLines, threshold));
    }

    return result;
}

/**
 * Collapse a run of context lines, keeping contextLines at start/end
 */
function collapseRun(run, contextLines, threshold) {
    // Check if this run is at the start or end (no changes around it)
    // For simplicity, if it's a long run, collapse the middle

    if (run.length <= threshold) {
        return run;
    }

    const result = [];

    // Keep first contextLines
    for (let i = 0; i < Math.min(contextLines, run.length); i++) {
        result.push(run[i]);
    }

    // Add collapse marker
    const collapsedCount = run.length - contextLines * 2;
    if (collapsedCount > 0) {
        result.push({
            type: 'collapse',
            count: collapsedCount,
            startLine: run[contextLines].oldLineNum || run[contextLines].newLineNum,
            endLine: run[run.length - contextLines - 1].oldLineNum || run[run.length - contextLines - 1].newLineNum
        });
    }

    // Keep last contextLines
    for (let i = Math.max(contextLines, run.length - contextLines); i < run.length; i++) {
        result.push(run[i]);
    }

    return result;
}

/**
 * Render a single diff entry as a row (no wrapper).
 * `hidden` rows get .diff-row-hidden — shown only when the block is expanded.
 */
function renderDiffRow(entry, hidden = false) {
    const h = hidden ? ' diff-row-hidden' : '';
    switch (entry.type) {
        case 'context':
            return `<div class="diff-line diff-context${h}">
                <span class="diff-line-num">${entry.oldLineNum}</span>
                <span class="diff-prefix"> </span>
                <span class="diff-text">${entry.content}</span>
            </div>`;
        case 'removed':
            return `<div class="diff-line diff-removed${h}">
                <span class="diff-line-num">${entry.oldLineNum}</span>
                <span class="diff-prefix">−</span>
                <span class="diff-text">${entry.content}</span>
            </div>`;
        case 'added':
            return `<div class="diff-line diff-added${h}">
                <span class="diff-line-num">${entry.newLineNum}</span>
                <span class="diff-prefix">+</span>
                <span class="diff-text">${entry.content}</span>
            </div>`;
        case 'modified':
            return `<div class="diff-line diff-removed${h}">
                <span class="diff-line-num">${entry.oldLineNum}</span>
                <span class="diff-prefix">−</span>
                <span class="diff-text">${entry.oldContent}</span>
            </div><div class="diff-line diff-added${h}">
                <span class="diff-line-num">${entry.newLineNum}</span>
                <span class="diff-prefix">+</span>
                <span class="diff-text">${entry.newContent}</span>
            </div>`;
        case 'collapse':
            return `<div class="diff-line diff-collapse${h}" data-start="${entry.startLine}" data-end="${entry.endLine}">
                <span class="diff-line-num">⋯</span>
                <span class="diff-prefix"></span>
                <span class="diff-collapse-text">${entry.count} unchanged lines</span>
            </div>`;
        default:
            return '';
    }
}

/**
 * Render smart diff to HTML.
 *
 * Rows are grouped into hunks so each hunk shares one horizontal scrollbar:
 * - All rows between collapse separators (context and changes alike) → one hunk.
 * - Collapse rows render bare (they have their own click affordance and must
 *   stay full-width, so they can't live inside a scrolling hunk).
 *
 * options.hideAfter: rows past this count get .diff-row-hidden (shown when the
 * enclosing block gains .expanded) — used to keep tall diffs short by default.
 */
function renderSmartDiff(entries, options = {}) {
    const hideAfter = options.hideAfter ?? Infinity;
    let html = '';
    let buf = '';
    let rowCount = 0;

    const flush = () => {
        if (buf) {
            html += `<div class="diff-hunk"><div class="diff-hunk-inner">${buf}</div></div>`;
            buf = '';
        }
    };

    for (const entry of entries) {
        const hidden = rowCount >= hideAfter;
        rowCount += entry.type === 'modified' ? 2 : 1;
        if (entry.type === 'collapse') {
            flush();
            html += renderDiffRow(entry, hidden);
            continue;
        }
        buf += renderDiffRow(entry, hidden);
    }
    flush();

    return html;
}

/**
 * Render a single diff entry as a row of side-by-side grid cells.
 */
function renderSbsRow(entry, hunkIdx) {
    const hunkAttr = entry.type !== 'context' ? ` data-hunk="${hunkIdx}"` : '';
    switch (entry.type) {
        case 'context':
            return `<div class="sbs-linenum sbs-left sbs-context">${entry.oldLineNum}</div>`
                + `<div class="sbs-text sbs-left sbs-context">${entry.content}</div>`
                + `<div class="sbs-gutter"></div>`
                + `<div class="sbs-linenum sbs-right sbs-context">${entry.newLineNum}</div>`
                + `<div class="sbs-text sbs-right sbs-context">${entry.content}</div>`;
        case 'removed':
            return `<div class="sbs-linenum sbs-left sbs-removed"${hunkAttr}>${entry.oldLineNum}</div>`
                + `<div class="sbs-text sbs-left sbs-removed">${entry.content}</div>`
                + `<div class="sbs-gutter"></div>`
                + `<div class="sbs-linenum sbs-right sbs-empty"></div>`
                + `<div class="sbs-text sbs-right sbs-empty"></div>`;
        case 'added':
            return `<div class="sbs-linenum sbs-left sbs-empty"></div>`
                + `<div class="sbs-text sbs-left sbs-empty"></div>`
                + `<div class="sbs-gutter"></div>`
                + `<div class="sbs-linenum sbs-right sbs-added"${hunkAttr}>${entry.newLineNum}</div>`
                + `<div class="sbs-text sbs-right sbs-added">${entry.content}</div>`;
        case 'modified':
            return `<div class="sbs-linenum sbs-left sbs-modified-old"${hunkAttr}>${entry.oldLineNum}</div>`
                + `<div class="sbs-text sbs-left sbs-modified-old">${entry.oldContent}</div>`
                + `<div class="sbs-gutter"></div>`
                + `<div class="sbs-linenum sbs-right sbs-modified-new">${entry.newLineNum}</div>`
                + `<div class="sbs-text sbs-right sbs-modified-new">${entry.newContent}</div>`;
        default:
            return '';
    }
}

/**
 * Render smart diff as a stack of side-by-side hunks.
 *
 * All rows between collapse markers (context and changes alike) share one
 * scroll-container grid, so the whole section scrolls with one horizontal
 * scrollbar. data-hunk indices still advance per change group (not per
 * scroll container) so keyboard hunk navigation is unaffected.
 *
 * @param {object[]} entries - diff entries from generateSmartDiff
 * @param {object} options
 * @param {function} options.collapseLabel - (count) => string for the "N unchanged lines" marker
 */
function renderSideBySideDiff(entries, options = {}) {
    const collapseLabel = options.collapseLabel || ((count) => `${count} unchanged lines`);
    let html = '<div class="sbs-diff-stack">';
    let buf = '';
    let prevType = null;
    let hunkIdx = 0;

    const flush = () => {
        if (buf) {
            html += `<div class="sbs-hunk"><div class="sbs-diff-grid">${buf}</div></div>`;
            buf = '';
        }
    };

    for (const entry of entries) {
        if (entry.type === 'collapse') {
            flush();
            html += `<div class="sbs-collapse" data-start="${entry.startLine}" data-end="${entry.endLine}">`
                + `<span>⋯</span> ${collapseLabel(entry.count)}</div>`;
            hunkIdx++;
            prevType = null;
            continue;
        }

        const thisType = entry.type === 'context' ? 'context' : 'change';
        if (prevType === 'change' && thisType !== 'change') hunkIdx++;
        prevType = thisType;
        buf += renderSbsRow(entry, hunkIdx);
    }
    flush();

    html += '</div>';
    return html;
}

export { generateSmartDiff, renderSmartDiff, renderSideBySideDiff, computeWordDiff, areSimilarLines };
