/**
 * Tool Renderer — Block-mode methods
 *
 * Full tool-block renderers (Bash, Read, Edit, Write, Grep, Glob, WebFetch, Task,
 * Skill, TaskOutput, TaskStop, EnterPlanMode, Todo) and their helpers.
 * Mixed into ToolRenderer.prototype by tool-renderer.js.
 */

import S from './strings.js';
import { escapeHtml, escapeAttr, b64Attr, parseTaskUsage, formatTokensBadge, formatDuration } from './utils.js';
import { generateSmartDiff, renderSmartDiff } from './diff-utils.js';
import { parseBackgroundTaskOutput } from './background-tasks.js';
import { cleanToolError, ansiToHtml, colorizeBashLine, getLangForExt } from './tool-renderer.js';
import { MarkdownRenderer } from './components.js';
import { basename, isAbsolutePath } from './path-utils.js';

/**
 * Line-wrap toggle button for monospace tool previews (Read / Write blocks).
 * Shares the single chat-wide wrap preference with the markdown code blocks —
 * the `.wrap-toggle` marker is caught by the document-level delegate in
 * components.js, which flips `.wrapped` on every wrappable block at once.
 * `actionClass` is the block's own button class so it inherits sibling styling.
 */
function wrapToggleBtn(actionClass) {
    const active = MarkdownRenderer.getCodeWrapPref();
    return `<button class="${actionClass} wrap-toggle${active ? ' active' : ''}" data-tooltip="${S.code_block.toggle_wrap}" aria-pressed="${active}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M3 12h15a3 3 0 1 1 0 6h-4"/><polyline points="16 16 14 18 16 20"/><path d="M3 18h7"/></svg>
        </button>`;
}

export const blockMethods = {
    /**
     * Render a colorized diff for Edit tool operations.
     * Shows removed lines in red, added lines in green, with stats and file link.
     * @param {object} input - Tool input with file_path, old_string, new_string
     * @param {string} toolOutput - Tool output for line number parsing
     * @param {string} [toolId] - Tool ID for linking to Changes panel
     */
    renderEditDiff(input, toolOutput, toolId = null, serverStartLine = null) {
        const { file_path, old_string, new_string } = input;
        if (!file_path || old_string === undefined || new_string === undefined) {
            return null; // Fall back to default rendering
        }

        const filename = basename(file_path);
        const oldLines = old_string.split('\n');
        const newLines = new_string.split('\n');

        // Use server-provided startLine (from structuredPatch) or fallback to client-side
        // parsing. Both can fail (pending edit, failed edit, output without a snippet) —
        // then we render without line numbers rather than numbering from 1.
        const startLine = serverStartLine || this.parseEditLineNumber(toolOutput, new_string);
        const lineNumsKnown = !!startLine;

        // Generate smart diff with line matching and word-level highlighting
        const diffEntries = generateSmartDiff(oldLines, newLines, startLine || 1, escapeHtml, {
            contextLines: 2,      // Show 2 lines of context around changes
            collapseThreshold: 5  // Collapse runs of 5+ unchanged lines
        });

        // Collapse tall diffs to the first rows, like Write/Read blocks
        const MAX_VISIBLE_ROWS = 10;
        const totalRows = diffEntries.reduce((n, e) => n + (e.type === 'modified' ? 2 : 1), 0);
        const needsExpand = totalRows > MAX_VISIBLE_ROWS;
        const hiddenRows = needsExpand ? totalRows - MAX_VISIBLE_ROWS : 0;
        const diffLines = renderSmartDiff(diffEntries, { hideAfter: needsExpand ? MAX_VISIBLE_ROWS : Infinity });
        const expandBtn = needsExpand
            ? `<button class="diff-expand-btn" data-act="toggle-expand" data-block=".edit-diff" data-more-label="▼ ${hiddenRows} more lines">▼ ${hiddenRows} more lines</button>`
            : '';

        // Calculate stats from actual diff entries (not raw line counts)
        // - 'added': lines that exist only in new_string
        // - 'removed': lines that exist only in old_string
        // - 'modified': lines that changed (counts as both +1 and -1)
        const addedCount = diffEntries.filter(e => e.type === 'added').length;
        const removedCount = diffEntries.filter(e => e.type === 'removed').length;
        const modifiedCount = diffEntries.filter(e => e.type === 'modified').length;
        const statsText = `<span class="diff-stat-added">+${addedCount + modifiedCount}</span> <span class="diff-stat-removed">-${removedCount + modifiedCount}</span>`;

        // Calculate line range for preview highlighting (only when the position is real)
        const previewOpts = lineNumsKnown
            ? JSON.stringify({ start: startLine, end: startLine + newLines.length - 1 })
            : '{}';

        // Cache edit data for side-by-side viewer (avoids large strings in onclick)
        const sbsCacheId = window.DiffViewerWidget?.cacheEditData?.(file_path, old_string, new_string, startLine || 1) || '';

        return `<div class="edit-diff${lineNumsKnown ? '' : ' line-nums-unknown'}${MarkdownRenderer.getCodeWrapPref() ? ' wrapped' : ''}">
<div class="edit-diff-header">
    <svg class="edit-diff-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
    </svg>
    ${this.fileLink(file_path, filename, 'edit-diff-path')}
    <span class="edit-diff-stats">${statsText}</span>
    <div class="edit-actions">
        ${wrapToggleBtn('edit-action')}
        <button class="edit-action" data-act="preview-file" data-file="${escapeAttr(file_path)}" data-preview-opts="${escapeAttr(previewOpts)}" data-tooltip="Preview">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
        </button>
        <button class="edit-action" data-act="open-in-editor" data-file="${escapeAttr(file_path)}" data-tooltip="Open in editor">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
        </button>
        ${sbsCacheId ? `<button class="edit-action" data-act="open-diff-cache" data-cache-id="${escapeAttr(sbsCacheId)}" data-tooltip="Side-by-side">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="8" height="18" rx="1"/><rect x="13" y="3" width="8" height="18" rx="1"/></svg>
        </button>` : ''}
    </div>
</div>
<div class="edit-diff-content">${diffLines}</div>
${expandBtn}
</div>`;
    },

    /**
     * Parse line number from Edit tool output.
     * Claude returns format like: "  1234→    content here" or "1234\tcontent here"
     */
    /**
     * Render a Read tool block for image files with inline preview
     */
    renderReadImageBlock(msg) {
        const filePath = msg.toolInput?.file_path || '';
        const filename = basename(filePath) || '(unknown)';
        const hasOutput = msg.toolOutput || msg.toolError;
        const isCompleted = msg.toolCompleted || hasOutput;
        const imgUrl = `/api/file-raw?path=${encodeURIComponent(filePath)}`;

        if (!isCompleted) {
            return `<div class="tool-block read-block read-image" id="tool-${msg.id}">
<div class="read-header">
    <svg class="read-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
    ${this.fileLink(filePath, filename, 'read-filename')}
    <span class="read-status-loading">reading...</span>
</div>
</div>`;
        }

        return `<div class="tool-block read-block read-image" id="tool-${msg.id}">
<div class="read-header">
    <svg class="read-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
    ${this.fileLink(filePath, filename, 'read-filename')}
    <span class="read-lang">image</span>
    <div class="read-actions">
        <button class="read-action" data-act="preview-file" data-file="${escapeAttr(filePath)}" data-tooltip="Preview">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
        </button>
    </div>
</div>
<div class="read-content read-image-content">
    <img src="${imgUrl}" alt="${escapeHtml(filename)}" loading="lazy" />
</div>
</div>`;
    },

    /**
     * Render a Read tool block for code/text files with syntax highlighting
     */
    renderReadBlock(msg, { defaultExpanded = false } = {}) {
        const filePath = msg.toolInput?.file_path || '';
        const filename = basename(filePath) || '(unknown)';
        const hasOutput = msg.toolOutput || msg.toolError;
        const isCompleted = msg.toolCompleted || hasOutput;

        // Check for sibling tool error
        const readCleaned = cleanToolError(msg.toolOutput || msg.toolError || '');
        if (readCleaned.isSiblingError) {
            return this._renderSiblingErrorBlock(msg, 'read', escapeHtml(filename));
        }

        // Detect language from file extension
        const ext = filename.split('.').pop()?.toLowerCase() || '';
        const { hlLang, displayLang } = getLangForExt(ext, filename);
        const isImage = hlLang === 'image';
        const lowerFn = filename.toLowerCase();
        const isExcalidraw = lowerFn.endsWith('.excalidraw') || lowerFn.endsWith('.excalidraw.md');

        // Image icon SVG
        const iconSvg = isImage
            ? '<svg class="read-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>'
            : '<svg class="read-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';

        // Loading state
        if (!isCompleted) {
            return `<div class="tool-block read-block read-loading" id="tool-${msg.id}">
<div class="read-header">
    ${iconSvg}
    ${this.fileLink(filePath, filename, 'read-filename')}
    <span class="read-status-loading">reading...</span>
</div>
</div>`;
        }

        // Image file — show inline thumbnail instead of code lines
        if (isImage) {
            const rawUrl = `/api/file-raw?path=${encodeURIComponent(filePath)}`;
            return `<div class="tool-block read-block read-image" id="tool-${msg.id}">
<div class="read-header">
    ${iconSvg}
    ${this.fileLink(filePath, filename, 'read-filename')}
    <span class="read-lang">${displayLang}</span>
    <div class="read-actions">
        <button class="read-action" data-act="preview-file" data-file="${escapeAttr(filePath)}" data-tooltip="Preview">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
        </button>
    </div>
</div>
<div class="read-content read-image-content">
    <img src="${rawUrl}" alt="${escapeHtml(filename)}" loading="lazy" />
</div>
</div>`;
        }

        // Excalidraw file — show rendered SVG thumbnail via /api/file-raw
        if (isExcalidraw) {
            const rawUrl = `/api/file-raw?path=${encodeURIComponent(filePath)}&dark=true`;
            return `<div class="tool-block read-block read-excalidraw" id="tool-${msg.id}" data-file-path="${escapeAttr(filePath)}">
<div class="read-header">
    ${iconSvg}
    ${this.fileLink(filePath, filename, 'read-filename')}
    <span class="read-lang">excalidraw</span>
    <div class="read-actions">
        <button class="read-action" data-act="preview-file" data-file="${escapeAttr(filePath)}" data-tooltip="Preview">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
        </button>
    </div>
</div>
<div class="read-content read-excalidraw-content">
    <div class="read-excalidraw-loading">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
        </svg>
        Rendering diagram...
    </div>
    <div class="read-excalidraw-svg" data-src="${rawUrl}" style="display:none"></div>
</div>
</div>`;
        }

        // Parse the Read output to extract lines
        const { lines, isTruncated, firstLine, lastLine } = this.parseReadOutput(msg.toolOutput || '');

        // Compact line range display
        let lineRange = '';
        const totalLines = lines.length;
        if (firstLine && lastLine) {
            lineRange = firstLine === lastLine ? `:${firstLine}` : `:${firstLine}-${lastLine}`;
        }

        // Max 8 lines shown by default, rest collapsed
        const MAX_VISIBLE = 8;
        const needsExpand = totalLines > MAX_VISIBLE;
        const hiddenCount = totalLines - MAX_VISIBLE;

        // Build code content with syntax highlighting
        const codeLines = lines.map(({ num, content }, idx) => {
            let highlighted;
            if (window.hljs && hlLang !== 'plaintext') {
                try {
                    highlighted = window.hljs.highlight(content || ' ', { language: hlLang, ignoreIllegals: true }).value;
                } catch {
                    highlighted = escapeHtml(content);
                }
            } else {
                highlighted = escapeHtml(content);
            }
            const hidden = needsExpand && idx >= MAX_VISIBLE ? ' read-line-hidden' : '';
            return `<div class="read-line${hidden}" data-line="${num}"><span class="read-line-num">${num}</span><span class="read-line-content">${highlighted}</span></div>`;
        }).join('');

        // Build preview options for line range
        const previewOpts = firstLine && lastLine && firstLine !== lastLine
            ? JSON.stringify({ start: firstLine, end: lastLine })
            : firstLine ? JSON.stringify({ line: firstLine }) : '{}';

        // Expand button if needed
        const expandBtn = needsExpand
            ? `<button class="read-expand-btn" data-act="toggle-expand" data-block=".read-block" data-more-label="▼ ${hiddenCount} more lines">${defaultExpanded ? '▲ Collapse' : `▼ ${hiddenCount} more lines`}</button>`
            : '';

        const expandedClass = defaultExpanded ? ' expanded' : '';
        const wrappedClass = MarkdownRenderer.getCodeWrapPref() ? ' wrapped' : '';
        return `<div class="tool-block read-block${expandedClass}${wrappedClass}" id="tool-${msg.id}">
<div class="read-header">
    ${iconSvg}
    ${this.fileLink(filePath, filename, 'read-filename')}
    <span class="read-line-info">${lineRange}</span>
    <span class="read-line-count">${totalLines}</span>
    <span class="read-lang">${displayLang}</span>
    <div class="read-actions">
        <button class="read-action" data-act="preview-file" data-file="${escapeAttr(filePath)}" data-preview-opts="${escapeAttr(previewOpts)}" data-tooltip="Preview">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
        </button>
        <button class="read-action" data-act="open-in-editor" data-file="${escapeAttr(filePath)}" data-tooltip="Open in editor">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
        </button>
        ${wrapToggleBtn('read-action')}
        <button class="read-action" data-act="copy-b64" data-copy="${b64Attr(lines.map(l => l.content).join('\n'))}" data-tooltip="Copy">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        </button>
    </div>
</div>
<div class="read-content">
    <pre class="read-code" data-language="${hlLang}"><code class="language-${hlLang}">${codeLines}</code></pre>
    ${expandBtn}
</div>
</div>`;
    },

    /**
     * Render a compact Bash/Shell tool block
     * Design: Clickable command copies, expandable for long/multiline commands
     */
    renderBashBlock(msg, { defaultExpanded = false } = {}) {
        const command = msg.toolInput.command || '';
        const output = typeof msg.toolOutput === 'string' ? msg.toolOutput : (msg.toolOutput != null ? String(msg.toolOutput) : '');
        const hasOutput = msg.toolOutput || msg.toolError;
        const isCompleted = msg.toolCompleted || hasOutput;

        // Clean tool_use_error XML from both error and output fields
        const cleanedError = cleanToolError(msg.toolError);
        const cleanedOutput = cleanToolError(output);
        const isError = !!msg.toolError || cleanedOutput.isSiblingError;
        const siblingError = cleanedError.isSiblingError || cleanedOutput.isSiblingError;

        // Detect background task
        const bgTask = parseBackgroundTaskOutput(output);
        if (bgTask || msg.toolInput?.run_in_background) {
            return this.renderBackgroundTaskCard(msg, bgTask);
        }

        // Check if command needs expansion (long or multiline)
        const isMultiline = command.includes('\n');
        const isLongCommand = command.length > 60 || isMultiline;

        // Command and output are model/tool text and go into a `data-` attribute
        // as base64, NOT interpolated into the handler.
        //
        // This previously used JSON.stringify(x).replace(/"/g, '&quot;') and was
        // an XSS: that replace maps the JSON string's own delimiters AND any
        // literal `&quot;` in the payload to the same sequence, and the HTML
        // parser decodes every `&quot;` back to `"` before the JS is compiled —
        // so a payload containing `&quot;` closed the string early and the rest
        // ran as script. Tool *output* reaches this path, so a `cat` of an
        // attacker-controlled file was enough. Base64's alphabet has no quote,
        // `&` or `<`, so it cannot break out of an attribute at all.
        const cmdEncoded = b64Attr(command);
        const outputEncoded = b64Attr(output);

        // Parse output lines
        const outputLines = output.split('\n');
        const totalLines = outputLines.length;
        const MAX_VISIBLE = 8;
        const needsExpand = totalLines > MAX_VISIBLE;
        const hiddenCount = totalLines - MAX_VISIBLE;

        // Check if output has ANSI codes
        const hasAnsi = output.includes('\x1b[');

        // Build verifiedFiles map from fileLinks for client-side scanning
        // (server positions don't work after colorization adds <span> tags)
        const verifiedFiles = {};
        if (msg.fileLinks && Array.isArray(msg.fileLinks)) {
            for (const link of msg.fileLinks) {
                if (link.path && link.resolved) {
                    verifiedFiles[link.path] = link.resolved;
                }
            }
        }
        // Fallback: use message-level verifiedFiles when fileLinks is absent
        // (e.g., messages loaded from server API where fileLinks isn't persisted)
        if (Object.keys(verifiedFiles).length === 0 && msg.verifiedFiles) {
            Object.assign(verifiedFiles, msg.verifiedFiles);
        }

        // Build output with line hiding and colorization
        // Track position in original output to adjust fileLinks per-line
        let outputPos = 0;
        const outputHtml = outputLines.map((line, idx) => {
            const hidden = needsExpand && idx >= MAX_VISIBLE ? ' bash-line-hidden' : '';
            const lineStart = outputPos;
            const lineEnd = outputPos + line.length;
            outputPos = lineEnd + 1; // +1 for newline

            let lineHtml;
            if (hasAnsi) {
                // Convert ANSI codes to HTML
                lineHtml = ansiToHtml(line) || escapeHtml(line);
            } else {
                // Apply pattern-based colorization
                const escaped = escapeHtml(line);
                lineHtml = colorizeBashLine(line, escaped);
            }

            // Apply URL and file path linkification
            // Use client-side scanning with verifiedFiles (position-based doesn't work after colorization)
            lineHtml = this.linkifyToolOutput(lineHtml, null, verifiedFiles);

            return `<div class="bash-line${hidden}">${lineHtml}</div>`;
        }).join('');

        const expandBtn = needsExpand
            ? `<button class="bash-expand-btn" data-act="toggle-expand" data-block=".bash-block" data-more-label="▼ ${hiddenCount} more lines">${defaultExpanded ? '▲ Collapse' : `▼ ${hiddenCount} more lines`}</button>`
            : '';

        // Copy command button (inside command wrapper, shows on hover)
        const copyCmdBtn = `<button class="bash-copy-cmd" data-act="copy-b64" data-copy="${cmdEncoded}" data-label-sel=".copy-label" data-tooltip="Copy command">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            <span class="copy-label">Copy</span>
        </button>`;

        // Copy output button (inside output area with label)
        const copyOutputBtn = `<button class="bash-copy-output" data-act="copy-b64" data-copy="${outputEncoded}" data-label-sel="span">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            <span>Copy output</span>
        </button>`;

        // Loading state
        if (!isCompleted) {
            return `<div class="tool-block bash-block bash-loading${isLongCommand ? ' has-long-cmd' : ''}" id="tool-${msg.id}">
<div class="bash-header">
    <div class="bash-cmd-wrapper"${isLongCommand ? ` data-act="toggle-class" data-block=".bash-block" data-cls="cmd-expanded"` : ''}>
        <code class="bash-cmd">${escapeHtml(command)}</code>
        ${copyCmdBtn}
    </div>
    <span class="bash-status-loading">${S.tool_renderer.status.running}</span>
</div>
</div>`;
        }

        const expandedClass = defaultExpanded ? ' expanded' : '';
        return `<div class="tool-block bash-block${isError ? ' bash-error' : ''}${isLongCommand ? ' has-long-cmd' : ''}${expandedClass}" id="tool-${msg.id}">
<div class="bash-header">
    <div class="bash-cmd-wrapper"${isLongCommand ? ` data-act="toggle-class" data-block=".bash-block" data-cls="cmd-expanded"` : ''}>
        <code class="bash-cmd">${escapeHtml(command)}</code>
        ${copyCmdBtn}
    </div>
    ${totalLines > 0 ? `<span class="bash-line-count">${totalLines}</span>` : ''}
</div>
${siblingError
    ? `<div class="bash-output bash-output-sibling-error"><span class="bash-sibling-label">${S.tool_renderer.status.skipped}</span> a parallel tool call failed</div>`
    : (output || isError ? `<div class="bash-output${isError ? ' bash-output-error' : ''}">${copyOutputBtn}${isError ? escapeHtml(cleanedError.text) : outputHtml}${expandBtn}</div>` : '')}
</div>`;
    },

    /**
     * Render a compact WebFetch/WebSearch tool block.
     * Header: icon + domain/query + prompt preview + copy button
     * Body: markdown-rendered response content
     */
    renderWebFetchBlock(msg, { defaultExpanded = false } = {}) {
        const isSearch = msg.toolName === 'WebSearch';
        const input = msg.toolInput || {};
        const output = typeof msg.toolOutput === 'string' ? msg.toolOutput : (msg.toolOutput != null ? String(msg.toolOutput) : '');
        const hasOutput = msg.toolOutput || msg.toolError;
        const isCompleted = msg.toolCompleted || hasOutput;

        // Clean tool errors
        const cleanedError = cleanToolError(msg.toolError);
        const cleanedOutput = cleanToolError(output);
        const isError = !!msg.toolError || cleanedOutput.isSiblingError;
        const siblingError = cleanedError.isSiblingError || cleanedOutput.isSiblingError;

        // Extract display info
        let domain = '';
        let fullUrl = '';
        if (isSearch) {
            domain = input.query || '';
            if (domain.length > 60) domain = domain.slice(0, 57) + '...';
        } else {
            fullUrl = input.url || '';
            try { domain = new URL(fullUrl).hostname; } catch { domain = fullUrl; }
        }

        // Prompt preview (truncated)
        const prompt = input.prompt || '';
        const promptPreview = prompt.length > 80 ? prompt.slice(0, 77) + '...' : prompt;

        // Icons
        const iconSvg = isSearch
            ? '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>'
            : '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>';

        // Copy output button
        // Base64 into a data- attribute, never interpolated into the handler
        // (this is WebFetch/WebSearch output — remote, attacker-influenced).
        const outputEncoded = b64Attr(output);
        const copyOutputBtn = output ? `<button class="bash-copy-output" data-act="copy-b64" data-copy="${outputEncoded}" data-label-sel="span">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            <span>Copy</span>
        </button>` : '';

        // Loading state
        if (!isCompleted) {
            return `<div class="tool-block webfetch-block webfetch-loading" id="tool-${msg.id}">
<div class="webfetch-header">
    <span class="webfetch-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">${iconSvg}</svg>
    </span>
    <span class="webfetch-domain">${escapeHtml(domain)}</span>
    ${promptPreview ? `<span class="webfetch-prompt">${escapeHtml(promptPreview)}</span>` : ''}
    <span class="webfetch-status-loading">${isSearch ? 'Searching...' : 'Fetching...'}</span>
</div>
</div>`;
        }

        // Parse output lines early (needed for both body and header line count)
        const outputLines = output ? output.split('\n') : [];
        const totalLines = outputLines.length;

        // Build output content
        let outputHtml = '';
        if (siblingError) {
            outputHtml = `<div class="webfetch-output"><span class="bash-sibling-label">${S.tool_renderer.status.skipped}</span> a parallel tool call failed</div>`;
        } else if (isError) {
            outputHtml = `<div class="webfetch-output webfetch-output-error">${escapeHtml(cleanedError.text)}</div>`;
        } else if (output) {
            const MAX_VISIBLE = 12;
            const needsExpand = totalLines > MAX_VISIBLE;
            const hiddenCount = totalLines - MAX_VISIBLE;

            const linesHtml = outputLines.map((line, idx) => {
                const hidden = needsExpand && idx >= MAX_VISIBLE ? ' webfetch-line-hidden' : '';
                const escaped = escapeHtml(line);
                // Linkify URLs in output
                const linkified = this.linkifyToolOutput(escaped, null, {});
                return `<div class="webfetch-line${hidden}">${linkified}</div>`;
            }).join('');

            const expandBtn = needsExpand
                ? `<button class="webfetch-expand-btn" data-act="toggle-expand" data-block=".webfetch-block" data-more-label="▼ ${hiddenCount} more lines">${defaultExpanded ? '▲ Collapse' : `▼ ${hiddenCount} more lines`}</button>`
                : '';

            outputHtml = `<div class="webfetch-output">${copyOutputBtn}${linesHtml}${expandBtn}</div>`;
        }

        // Domain display - clickable link for WebFetch, plain text for WebSearch
        const domainDisplay = isSearch
            ? `<span class="webfetch-domain">${escapeHtml(domain)}</span>`
            : `<a class="webfetch-domain" href="${escapeAttr(MarkdownRenderer.sanitizeHref(fullUrl))}" target="_blank" rel="noopener">${escapeHtml(domain)}</a>`;

        const expandedClass = defaultExpanded ? ' expanded' : '';
        return `<div class="tool-block webfetch-block${isSearch ? ' websearch-block' : ''}${isError ? ' webfetch-error' : ''}${expandedClass}" id="tool-${msg.id}">
<div class="webfetch-header">
    <span class="webfetch-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">${iconSvg}</svg>
    </span>
    ${domainDisplay}
    ${promptPreview ? `<span class="webfetch-prompt">${escapeHtml(promptPreview)}</span>` : ''}
    ${totalLines > 0 ? `<span class="webfetch-line-count">${totalLines}</span>` : ''}
</div>
${outputHtml}
</div>`;
    },

    /**
     * Render a background task inline card with live output preview.
     * Replaces the default "Command running in background..." text.
     */
    renderBackgroundTaskCard(msg, bgTask) {
        const command = msg.toolInput?.command || '';
        const taskId = bgTask?.taskId || '';
        const isLongCommand = command.length > 60 || command.includes('\n');

        // Display command compactly (last segment after &&)
        const cmdDisplay = command.includes('&&')
            ? command.split('&&').pop().trim()
            : command;

        return `<div class="tool-block bash-block bg-task-card${isLongCommand ? ' has-long-cmd' : ''}" id="tool-${msg.id}" data-task-id="${escapeHtml(taskId)}">
<div class="bash-header bg-task-header">
    <span class="bg-task-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
            <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
        </svg>
    </span>
    <div class="bash-cmd-wrapper"${isLongCommand ? ` data-act="toggle-class" data-block=".bg-task-card" data-cls="cmd-expanded"` : ''}>
        <code class="bash-cmd">${escapeHtml(cmdDisplay)}</code>
    </div>
    <span class="bg-task-badge bg-task-badge-running" id="bg-task-${escapeHtml(taskId)}-badge">
        <span class="bg-task-pulse"></span>
        Running
    </span>
</div>
<div class="bg-task-output" id="bg-task-${escapeHtml(taskId)}-output">
    <div class="bg-task-loading">Waiting for output...</div>
</div>
<div class="bg-task-actions">
    <span class="bg-task-id" data-tooltip="Task ID">${escapeHtml(taskId)}</span>
    <button class="bg-task-btn" data-act="open-bg-task" data-task-id="${escapeAttr(taskId)}">
        View Full Output
    </button>
</div>
</div>`;
    },

    /**
     * Render a compact Grep tool block
     */
    renderGrepBlock(msg, { defaultExpanded = false } = {}) {
        const pattern = msg.toolInput.pattern || '';
        const path = msg.toolInput.path || '.';
        const output = typeof msg.toolOutput === 'string' ? msg.toolOutput : (msg.toolOutput != null ? String(msg.toolOutput) : '');
        const hasOutput = msg.toolOutput || msg.toolError;
        const isCompleted = msg.toolCompleted || hasOutput;

        // Check for sibling tool error
        const grepCleaned = cleanToolError(output || msg.toolError || '');
        if (grepCleaned.isSiblingError) {
            return this._renderSiblingErrorBlock(msg, 'grep', `/${escapeHtml(pattern.length > 40 ? pattern.slice(0, 37) + '...' : pattern)}/`);
        }

        // Build verifiedFiles map from fileLinks for click handling
        const verifiedFiles = {};
        if (msg.fileLinks && Array.isArray(msg.fileLinks)) {
            for (const link of msg.fileLinks) {
                if (link.path && link.resolved) {
                    verifiedFiles[link.path] = link.resolved;
                }
            }
        }
        if (Object.keys(verifiedFiles).length === 0 && msg.verifiedFiles) {
            Object.assign(verifiedFiles, msg.verifiedFiles);
        }

        // Helper to make a file path clickable
        const makeFileLink = (filePath, displayName, lineNum = null) => {
            const resolvedPath = verifiedFiles[filePath] || filePath;
            // Path rides in a data- attribute and is read back via dataset —
            // never interpolated into the handler. The old
            // `resolvedPath.replace(/'/g, "\\'")` escaped ONLY apostrophes, so a
            // filename containing `"` terminated the inline handler attribute
            // itself and could inject siblings (and a trailing `\` defeated
            // the escape). Mirrors the reference impl in tool-renderer.js.
            const lineOpts = lineNum ? JSON.stringify({ scrollToLine: lineNum, flash: true }) : '{}';
            return `<a href="#" class="file-path-link" data-act="open-file-link" data-file="${escapeAttr(resolvedPath)}" data-line-opts="${escapeAttr(lineOpts)}" data-tooltip="${escapeHtml(resolvedPath)}">${escapeHtml(displayName)}</a>`;
        };

        // Parse grep results - filter out summary/metadata lines
        const results = output.split('\n').filter(l => {
            const trimmed = l.trim();
            if (!trimmed) return false;
            // Filter out summary lines
            if (/^Found \d+ files?$/i.test(trimmed)) return false;
            if (/^No matches found$/i.test(trimmed)) return false;
            // Filter out pagination metadata from Claude's Grep tool
            if (/^\[Showing results with pagination/i.test(trimmed)) return false;
            return true;
        });
        const totalMatches = results.length;
        const MAX_VISIBLE = 10;
        const needsExpand = totalMatches > MAX_VISIBLE;
        const hiddenCount = totalMatches - MAX_VISIBLE;

        // Build results list with file links
        const resultsHtml = results.map((line, idx) => {
            const hidden = needsExpand && idx >= MAX_VISIBLE ? ' grep-result-hidden' : '';

            // Try to extract file:line:content format (standard grep -n output)
            const fileLineMatch = line.match(/^([^:]+):(\d+):(.*)$/);
            if (fileLineMatch) {
                const [, file, lineNum, content] = fileLineMatch;
                const displayName = basename(file);
                return `<div class="grep-result${hidden}">
                    <span class="grep-file">${makeFileLink(file, displayName, parseInt(lineNum))}</span>
                    <span class="grep-linenum">:${lineNum}</span>
                    <span class="grep-content">${escapeHtml(content.slice(0, 80))}</span>
                </div>`;
            }

            // Try file:line-content format (context lines from -A/-B/-C)
            const fileContextMatch = line.match(/^([^:]+):(\d+)-(.*)$/);
            if (fileContextMatch) {
                const [, file, lineNum, content] = fileContextMatch;
                const displayName = basename(file);
                return `<div class="grep-result grep-context${hidden}">
                    <span class="grep-file">${makeFileLink(file, displayName, parseInt(lineNum))}</span>
                    <span class="grep-linenum">:${lineNum}</span>
                    <span class="grep-content">${escapeHtml(content.slice(0, 80))}</span>
                </div>`;
            }

            // Try linenum: content format (match line in content mode)
            const lineNumMatch = line.match(/^(\d+):(.*)$/);
            if (lineNumMatch) {
                const [, lineNum, content] = lineNumMatch;
                return `<div class="grep-result${hidden}">
                    <span class="grep-linenum">${lineNum}:</span>
                    <span class="grep-content">${escapeHtml(content.slice(0, 100))}</span>
                </div>`;
            }

            // Try linenum- content format (context line in content mode)
            const contextMatch = line.match(/^(\d+)-(.*)$/);
            if (contextMatch) {
                const [, lineNum, content] = contextMatch;
                return `<div class="grep-result grep-context${hidden}">
                    <span class="grep-linenum">${lineNum}-</span>
                    <span class="grep-content">${escapeHtml(content.slice(0, 100))}</span>
                </div>`;
            }

            // Just a file path (files_with_matches mode) - make clickable
            if (line.includes('/') || line.match(/\.\w+$/)) {
                const resolvedPath = verifiedFiles[line];
                if (resolvedPath) {
                    return `<div class="grep-result${hidden}"><span class="grep-content">${makeFileLink(line, line)}</span></div>`;
                }
            }

            // Plain text - wrap in content span for consistent styling
            return `<div class="grep-result${hidden}"><span class="grep-content">${escapeHtml(line)}</span></div>`;
        }).join('');

        const expandBtn = needsExpand
            ? `<button class="grep-expand-btn" data-act="toggle-expand" data-block=".grep-block" data-more-label="▼ ${hiddenCount} more">${defaultExpanded ? '▲ Collapse' : `▼ ${hiddenCount} more`}</button>`
            : '';

        // Loading state
        if (!isCompleted) {
            return `<div class="tool-block grep-block grep-loading" id="tool-${msg.id}">
<div class="grep-header">
    <svg class="grep-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
        <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
    </svg>
    <code class="grep-pattern">/${escapeHtml(pattern)}/</code>
    <span class="grep-status-loading">searching...</span>
</div>
</div>`;
        }

        const expandedClass = defaultExpanded ? ' expanded' : '';
        return `<div class="tool-block grep-block${expandedClass}" id="tool-${msg.id}">
<div class="grep-header">
    <svg class="grep-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
        <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
    </svg>
    <code class="grep-pattern">/${escapeHtml(pattern.length > 40 ? pattern.slice(0, 37) + '...' : pattern)}/</code>
    <span class="grep-match-count">${totalMatches} match${totalMatches !== 1 ? 'es' : ''}</span>
    <div class="grep-actions">
        <button class="grep-action" data-act="copy-b64" data-copy="${b64Attr(results.join('\n'))}" data-tooltip="Copy results">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        </button>
    </div>
</div>
${totalMatches > 0 ? `<div class="grep-results">${resultsHtml}${expandBtn}</div>` : `<div class="grep-empty">${S.tool_renderer.empty.no_matches}</div>`}
</div>`;
    },

    /**
     * Render a compact Glob tool block
     */
    renderGlobBlock(msg, { defaultExpanded = false } = {}) {
        const pattern = msg.toolInput.pattern || '';
        const basePath = msg.toolInput.path || '';
        const output = typeof msg.toolOutput === 'string' ? msg.toolOutput : (msg.toolOutput != null ? String(msg.toolOutput) : '');
        const hasOutput = msg.toolOutput || msg.toolError;
        const isCompleted = msg.toolCompleted || hasOutput;

        // Check for sibling tool error
        const globCleaned = cleanToolError(output || msg.toolError || '');
        if (globCleaned.isSiblingError) {
            return this._renderSiblingErrorBlock(msg, 'glob', escapeHtml(pattern.length > 50 ? pattern.slice(0, 47) + '...' : pattern));
        }

        // Parse file list - keep original paths for linking
        const originalFiles = output.split('\n').filter(l => l.trim());

        // Build verifiedFiles map from fileLinks for click handling
        const verifiedFiles = {};
        if (msg.fileLinks && Array.isArray(msg.fileLinks)) {
            for (const link of msg.fileLinks) {
                if (link.path && link.resolved) {
                    verifiedFiles[link.path] = link.resolved;
                }
            }
        }
        if (Object.keys(verifiedFiles).length === 0 && msg.verifiedFiles) {
            Object.assign(verifiedFiles, msg.verifiedFiles);
        }

        // Convert absolute paths to relative paths for display
        let files = [...originalFiles];
        let commonPrefix = '';
        if (files.length > 0 && isAbsolutePath(files[0])) {
            // Use basePath if it's absolute
            if (basePath && isAbsolutePath(basePath)) {
                commonPrefix = basePath.endsWith('/') ? basePath : basePath + '/';
            } else {
                // Find common directory prefix among all files
                const firstFile = files[0];
                const lastSlash = firstFile.lastIndexOf('/');
                if (lastSlash > 0) {
                    // Start with first file's directory as potential prefix
                    commonPrefix = firstFile.slice(0, lastSlash + 1);
                    // Find shortest common prefix
                    for (const file of files) {
                        while (commonPrefix && !file.startsWith(commonPrefix)) {
                            const prevSlash = commonPrefix.lastIndexOf('/', commonPrefix.length - 2);
                            commonPrefix = prevSlash > 0 ? commonPrefix.slice(0, prevSlash + 1) : '';
                        }
                    }
                }
            }

            // Strip the common prefix for display
            if (commonPrefix) {
                files = files.map(f => f.startsWith(commonPrefix) ? f.slice(commonPrefix.length) : f);
            }
        }

        const totalFiles = files.length;
        const MAX_VISIBLE = 12;
        const needsExpand = totalFiles > MAX_VISIBLE;
        const hiddenCount = totalFiles - MAX_VISIBLE;

        // Build file list with clickable links
        const filesHtml = files.map((displayFile, idx) => {
            const hidden = needsExpand && idx >= MAX_VISIBLE ? ' glob-file-hidden' : '';
            const isDir = displayFile.endsWith('/');
            const originalPath = originalFiles[idx];
            const resolvedPath = verifiedFiles[originalPath] || originalPath;

            // Make files clickable (not directories)
            if (!isDir && resolvedPath) {
                // Path via dataset, not interpolated into the handler — see the
                // note on makeFileLink above for what the old escape missed.
                return `<div class="glob-file${hidden}"><a href="#" class="file-path-link" data-act="open-file-link" data-file="${escapeAttr(resolvedPath)}" data-tooltip="${escapeHtml(resolvedPath)}">${escapeHtml(displayFile)}</a></div>`;
            }
            return `<div class="glob-file${hidden}${isDir ? ' glob-dir' : ''}">${escapeHtml(displayFile)}</div>`;
        }).join('');

        const expandBtn = needsExpand
            ? `<button class="glob-expand-btn" data-act="toggle-expand" data-block=".glob-block" data-more-label="▼ ${hiddenCount} more">${defaultExpanded ? '▲ Collapse' : `▼ ${hiddenCount} more`}</button>`
            : '';

        // Loading state
        if (!isCompleted) {
            return `<div class="tool-block glob-block glob-loading" id="tool-${msg.id}">
<div class="glob-header">
    <svg class="glob-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
    </svg>
    <code class="glob-pattern">${escapeHtml(pattern)}</code>
    <span class="glob-status-loading">searching...</span>
</div>
</div>`;
        }

        const expandedClass = defaultExpanded ? ' expanded' : '';
        return `<div class="tool-block glob-block${expandedClass}" id="tool-${msg.id}">
<div class="glob-header">
    <svg class="glob-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
    </svg>
    <code class="glob-pattern">${escapeHtml(pattern.length > 50 ? pattern.slice(0, 47) + '...' : pattern)}</code>
    <span class="glob-file-count">${totalFiles} file${totalFiles !== 1 ? 's' : ''}</span>
    <div class="glob-actions">
        <button class="glob-action" data-act="copy-b64" data-copy="${b64Attr(files.join('\n'))}" data-tooltip="Copy file list">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        </button>
    </div>
</div>
${totalFiles > 0 ? `<div class="glob-files">${filesHtml}${expandBtn}</div>` : `<div class="glob-empty">${S.tool_renderer.empty.no_files}</div>`}
</div>`;
    },

    /**
     * Render a compact Write tool block
     * Shows filename, line count, and status with preview/open actions
     */
    renderWriteBlock(msg, { defaultExpanded = false } = {}) {
        const filePath = msg.toolInput?.file_path || '';
        const filename = basename(filePath) || '(unknown)';
        const content = msg.toolInput.content || '';
        const hasOutput = msg.toolOutput || msg.toolError;
        const isCompleted = msg.toolCompleted || hasOutput;

        // Check for sibling tool error
        const writeCleaned = cleanToolError(msg.toolOutput || msg.toolError || '');
        if (writeCleaned.isSiblingError) {
            return this._renderSiblingErrorBlock(msg, 'write', escapeHtml(filename));
        }
        const isError = !!msg.toolError;

        // Detect language from file extension
        const ext = filename.split('.').pop()?.toLowerCase() || '';
        const { hlLang, displayLang } = getLangForExt(ext, filename);
        const isImage = hlLang === 'image';

        // Check if this is a Vega-Lite chart file or excalidraw diagram
        const isChart = filename.toLowerCase().endsWith('.vl.json');
        const lowerName = filename.toLowerCase();
        const isExcalidraw = lowerName.endsWith('.excalidraw') || lowerName.endsWith('.excalidraw.md');

        // Image/write icon SVG
        const iconSvg = isImage
            ? '<svg class="write-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>'
            : '<svg class="write-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/></svg>';

        // Status indicator
        const statusClass = isError ? 'write-status-error' : (isCompleted ? 'write-status-success' : 'write-status-pending');
        const statusText = isError ? 'Failed' : (isCompleted ? 'Created' : 'Writing...');

        // Loading state
        if (!isCompleted && !content) {
            return `<div class="tool-block write-block write-loading" id="tool-${msg.id}">
<div class="write-header">
    ${iconSvg}
    ${this.fileLink(filePath, filename, 'write-filename')}
    <span class="write-status-loading">writing...</span>
</div>
</div>`;
        }

        // Image file — show inline thumbnail instead of code lines
        if (isImage) {
            const rawUrl = `/api/file-raw?path=${encodeURIComponent(filePath)}`;
            return `<div class="tool-block write-block write-image${isError ? ' write-error' : ''}" id="tool-${msg.id}">
<div class="write-header">
    ${iconSvg}
    ${this.fileLink(filePath, filename, 'write-filename')}
    <span class="write-lang">${displayLang}</span>
    <span class="write-status ${statusClass}">${statusText}</span>
    <div class="write-actions">
        <button class="write-action" data-act="preview-file" data-file="${escapeAttr(filePath)}" data-tooltip="Preview">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
        </button>
    </div>
</div>
<div class="write-content write-image-content">
    <img src="${rawUrl}" alt="${escapeHtml(filename)}" loading="lazy" />
</div>
</div>`;
        }

        // Chart rendering for .vl.json files — show rendered SVG instead of raw JSON
        if (isChart && content) {
            const encoded = btoa(unescape(encodeURIComponent(content)));
            return `<div class="tool-block write-block write-chart" id="tool-${msg.id}">
<div class="write-header">
    <svg class="write-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/>
    </svg>
    ${this.fileLink(filePath, filename, 'write-filename')}
    <span class="write-lang">${displayLang}</span>
    <span class="write-status ${statusClass}">${statusText}</span>
    <div class="write-actions">
        <button class="write-action" data-act="preview-file" data-file="${escapeAttr(filePath)}" data-tooltip="Preview">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
        </button>
        <button class="write-action write-chart-toggle-json" data-act="toggle-json-view" data-block=".write-chart" data-cls="show-json" data-on-label="Show chart" data-off-label="Show JSON" data-tooltip="Show JSON">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
        </button>
        <button class="write-action" data-act="copy-b64" data-copy="${encoded}" data-tooltip="Copy JSON">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        </button>
    </div>
</div>
<div class="write-content write-chart-pending" data-chart-json="${encoded}">
    <div class="chart-inline-loading">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 20V10M6 20V4M18 20v-4"/>
        </svg>
        Rendering chart...
    </div>
</div>
<div class="write-content write-chart-json" style="display:none">
    <pre class="write-code" data-language="json"><code class="language-json">${window.hljs ? window.hljs.highlight(content, { language: 'json', ignoreIllegals: true }).value : escapeHtml(content)}</code></pre>
</div>
</div>`;
        }

        // Excalidraw rendering — show rendered SVG instead of raw JSON
        if (isExcalidraw && content) {
            const encoded = btoa(unescape(encodeURIComponent(content)));
            return `<div class="tool-block write-block write-excalidraw" id="tool-${msg.id}" data-file-path="${escapeAttr(filePath)}">
<div class="write-header">
    <svg class="write-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/>
    </svg>
    ${this.fileLink(filePath, filename, 'write-filename')}
    <span class="write-lang">${displayLang}</span>
    <span class="write-status ${statusClass}">${statusText}</span>
    <div class="write-actions">
        <button class="write-action" data-act="preview-file" data-file="${escapeAttr(filePath)}" data-tooltip="Preview">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
        </button>
        <button class="write-action write-excalidraw-toggle-json" data-act="toggle-json-view" data-block=".write-excalidraw" data-cls="show-json" data-on-label="Show diagram" data-off-label="Show JSON" data-tooltip="Show JSON">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
        </button>
        <button class="write-action" data-act="copy-b64" data-copy="${encoded}" data-tooltip="Copy JSON">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        </button>
    </div>
</div>
<div class="write-content write-excalidraw-pending" data-excalidraw-json="${encoded}">
    <div class="excalidraw-inline-loading">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
        </svg>
        Rendering diagram...
    </div>
</div>
<div class="write-content write-excalidraw-json" style="display:none">
    <pre class="write-code" data-language="json"><code class="language-json">${window.hljs ? window.hljs.highlight(content, { language: 'json', ignoreIllegals: true }).value : escapeHtml(content)}</code></pre>
</div>
</div>`;
        }

        // Count lines
        const lines = content.split('\n');
        const totalLines = lines.length;

        // Max 8 lines shown by default
        const MAX_VISIBLE = 8;
        const needsExpand = totalLines > MAX_VISIBLE;
        const hiddenCount = totalLines - MAX_VISIBLE;

        // Build code content with syntax highlighting
        const codeLines = lines.map((lineContent, idx) => {
            let highlighted;
            if (window.hljs && hlLang !== 'plaintext') {
                try {
                    highlighted = window.hljs.highlight(lineContent || ' ', { language: hlLang, ignoreIllegals: true }).value;
                } catch {
                    highlighted = escapeHtml(lineContent);
                }
            } else {
                highlighted = escapeHtml(lineContent);
            }
            const hidden = needsExpand && idx >= MAX_VISIBLE ? ' write-line-hidden' : '';
            return `<div class="write-line${hidden}" data-line="${idx + 1}"><span class="write-line-num">${idx + 1}</span><span class="write-line-content">${highlighted}</span></div>`;
        }).join('');

        // Expand button if needed
        const expandBtn = needsExpand
            ? `<button class="write-expand-btn" data-act="toggle-expand" data-block=".write-block" data-more-label="▼ ${hiddenCount} more lines">${defaultExpanded ? '▲ Collapse' : `▼ ${hiddenCount} more lines`}</button>`
            : '';

        const expandedClass = defaultExpanded ? ' expanded' : '';
        const wrappedClass = MarkdownRenderer.getCodeWrapPref() ? ' wrapped' : '';
        return `<div class="tool-block write-block${isError ? ' write-error' : ''}${expandedClass}${wrappedClass}" id="tool-${msg.id}">
<div class="write-header">
    ${iconSvg}
    ${this.fileLink(filePath, filename, 'write-filename')}
    <span class="write-line-count">${totalLines}</span>
    <span class="write-lang">${displayLang}</span>
    <span class="write-status ${statusClass}">${statusText}</span>
    <div class="write-actions">
        <button class="write-action" data-act="preview-file" data-file="${escapeAttr(filePath)}" data-tooltip="Preview">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
        </button>
        <button class="write-action" data-act="open-in-editor" data-file="${escapeAttr(filePath)}" data-tooltip="Open in editor">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
        </button>
        ${wrapToggleBtn('write-action')}
        <button class="write-action" data-act="copy-b64" data-copy="${b64Attr(content)}" data-tooltip="Copy">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        </button>
    </div>
</div>
<div class="write-content">
    <pre class="write-code" data-language="${hlLang}"><code class="language-${hlLang}">${codeLines}</code></pre>
    ${expandBtn}
</div>
</div>`;
    },

    /**
     * Render a Task (agent) tool block with grouped style
     * Similar to ThinkingController's _renderTaskGroup but for standalone tool blocks
     */
    renderTaskBlock(msg) {
        const desc = msg.toolInput?.description || 'Running task...';
        const subagentType = msg.toolInput?.subagent_type || '';
        const hasOutput = msg.toolOutput || msg.toolError;
        const isCompleted = msg.toolCompleted || hasOutput;
        const isError = !!msg.toolError;

        // Status badge
        let statusBadge;
        if (isError) {
            statusBadge = '<span class="task-block-badge task-block-badge-error">Failed</span>';
        } else if (isCompleted) {
            statusBadge = '<span class="task-block-badge task-block-badge-success">Done</span>';
        } else {
            statusBadge = '<span class="task-block-badge task-block-badge-pending">Running...</span>';
        }

        // Parse agent response from toolOutput
        const { text: agentResponse, usage } = this._parseTaskOutputWithUsage(msg.toolOutput);

        // Usage badges (tokens + duration)
        let usageBadges = '';
        if (usage) {
            const tokBadge = formatTokensBadge(usage.totalTokens);
            const durBadge = formatDuration(usage.durationMs);
            if (tokBadge) usageBadges += `<span class="task-block-tokens">${tokBadge}</span>`;
            if (durBadge) usageBadges += `<span class="task-block-duration">${durBadge}</span>`;
        }

        // Preview for collapsed state (first ~150 chars, markdown stripped)
        let outputPreview = '';
        if (isCompleted && agentResponse && !isError) {
            const strippedResponse = this._stripMarkdownForPreview(agentResponse);
            const preview = strippedResponse.slice(0, 150).trim();
            if (preview) {
                outputPreview = `<div class="task-block-preview">${escapeHtml(preview)}${strippedResponse.length > 150 ? '...' : ''}</div>`;
            }
        }

        // Full response for expanded state (rendered with markdown)
        let fullResponse = '';
        if (isCompleted && agentResponse) {
            const renderedContent = this._renderMarkdownSafe(agentResponse);
            fullResponse = `<div class="task-block-response">${renderedContent}</div>`;
        }

        // Error display
        let errorHtml = '';
        if (isError && msg.toolError) {
            errorHtml = `<div class="task-block-error">${escapeHtml(msg.toolError)}</div>`;
        }

        const hasExpandableContent = agentResponse || isError;

        return `<div class="tool-block task-block" id="tool-${msg.id}" data-complete="${isCompleted}" data-tool-use-id="${msg.toolId || ''}">
<div class="task-block-header" data-act="toggle-task-block" data-id="${escapeAttr(msg.id)}">
    <span class="task-block-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
            <circle cx="9" cy="7" r="4"/>
            <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
            <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
        </svg>
    </span>
    <span class="task-block-label">Task</span>
    <span class="task-block-desc">${escapeHtml(desc)}</span>
    ${subagentType ? `<span class="task-block-type">${escapeHtml(subagentType)}</span>` : ''}
    ${usageBadges}
    ${statusBadge}
    ${hasExpandableContent ? '<span class="task-block-expand">›</span>' : ''}
</div>
${outputPreview}
${errorHtml}
<div class="task-block-body">
    ${fullResponse}
</div>
</div>`;
    },

    renderSkillBlock(msg) {
        const skillName = msg.toolInput?.skill || 'skill';
        const args = msg.toolInput?.args || '';
        const hasOutput = msg.toolOutput || msg.toolError;
        const isCompleted = msg.toolCompleted || hasOutput;
        const isError = !!msg.toolError;

        // Status badge
        let statusBadge;
        if (isError) {
            statusBadge = '<span class="skill-block-badge skill-block-badge-error">Failed</span>';
        } else if (isCompleted) {
            statusBadge = '<span class="skill-block-badge skill-block-badge-success">Done</span>';
        } else {
            statusBadge = '<span class="skill-block-badge skill-block-badge-pending">Running...</span>';
        }

        // Output for expanded state
        const outputText = msg.toolOutput || msg.toolError || '';
        const hasExpandableContent = !!outputText;

        // Preview for collapsed state
        let outputPreview = '';
        if (isCompleted && outputText && !isError) {
            const preview = outputText.slice(0, 150).trim();
            if (preview) {
                outputPreview = `<div class="skill-block-preview">${escapeHtml(preview)}${outputText.length > 150 ? '...' : ''}</div>`;
            }
        }

        // Error display
        let errorHtml = '';
        if (isError && msg.toolError) {
            errorHtml = `<div class="skill-block-error">${escapeHtml(msg.toolError)}</div>`;
        }

        // Full output for expanded state
        let fullOutput = '';
        if (isCompleted && outputText) {
            fullOutput = `<div class="skill-block-response"><pre>${escapeHtml(outputText)}</pre></div>`;
        }

        return `<div class="tool-block skill-block" id="tool-${msg.id}">
<div class="skill-block-header" data-act="toggle-skill-block" data-id="${escapeAttr(msg.id)}">
    <span class="skill-block-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
            <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
        </svg>
    </span>
    <span class="skill-block-label">Skill</span>
    <span class="skill-block-name">/${escapeHtml(skillName)}</span>
    ${args ? `<span class="skill-block-args">${escapeHtml(args.length > 60 ? args.slice(0, 57) + '...' : args)}</span>` : ''}
    ${statusBadge}
    ${hasExpandableContent ? '<span class="skill-block-expand">›</span>' : ''}
</div>
${outputPreview}
${errorHtml}
<div class="skill-block-body">
    ${fullOutput}
</div>
</div>`;
    },

    /**
     * Parse XML-like tags from TaskOutput result (shell/bash tasks).
     * Format: <tag>value</tag> with <output>...</output> containing the actual log.
     */
    /**
     * Parse agent streaming JSONL output into useful components.
     * Extracts slug, text responses, tool counts, and token usage.
     */
    renderTaskOutputBlock(msg) {
        const taskId = msg.toolInput?.task_id || '';
        const hasOutput = msg.toolOutput || msg.toolError;
        const isCompleted = msg.toolCompleted || hasOutput;
        const isError = !!msg.toolError;

        // Try XML parsing first (shell/bash tasks)
        const xmlParsed = this._parseTaskOutputXml(msg.toolOutput || '');
        if (xmlParsed.status || xmlParsed.exit_code) {
            return this._renderShellTaskOutput(msg, taskId, xmlParsed, isCompleted, isError);
        }

        // Parse as agent stream (JSONL from background agents)
        const stream = this._parseAgentStream(msg.toolOutput || '');
        return this._renderAgentTaskOutput(msg, taskId, stream, isCompleted, isError);
    },

    /** Render shell/bash task output (XML structured) */
    _renderShellTaskOutput(msg, taskId, xml, isCompleted, isError) {
        const exitCode = xml.exit_code;
        const taskType = xml.task_type || '';
        const taskLog = xml.output || '';
        const status = xml.status || '';
        const isSuccess = status === 'completed' && exitCode === '0';
        const isFailed = isError || status === 'failed' || (exitCode && exitCode !== '0');
        const isRunning = status === 'running' || status === 'pending' || status === 'started';

        let statusBadge;
        if (isFailed) {
            statusBadge = `<span class="tob-badge tob-badge-error">exit ${escapeHtml(exitCode || '?')}</span>`;
        } else if (isSuccess) {
            statusBadge = '<span class="tob-badge tob-badge-success">exit 0</span>';
        } else if (isRunning) {
            statusBadge = `<span class="tob-badge tob-badge-pending">${escapeHtml(status)}</span>`;
        } else if (status) {
            statusBadge = `<span class="tob-badge tob-badge-success">${escapeHtml(status)}</span>`;
        } else {
            statusBadge = '<span class="tob-badge tob-badge-pending">Waiting...</span>';
        }

        const typeBadge = taskType ? `<span class="tob-type">${escapeHtml(taskType)}</span>` : '';

        // Preview: first log line, or "running" notice
        let outputPreview = '';
        if (taskLog) {
            const firstLine = taskLog.split('\n').find(l => l.trim()) || '';
            const preview = firstLine.slice(0, 120).trim();
            if (preview) {
                outputPreview = `<div class="tob-preview">${escapeHtml(preview)}${taskLog.split('\n').length > 1 ? '...' : ''}</div>`;
            }
        } else if (isRunning) {
            outputPreview = '<div class="tob-preview tob-preview-muted">Task is running...</div>';
        } else if (isSuccess || isFailed) {
            outputPreview = `<div class="tob-preview tob-preview-muted">${S.tool_renderer.empty.no_output}</div>`;
        }

        let errorHtml = '';
        if (isError && msg.toolError) {
            errorHtml = `<div class="tob-error">${escapeHtml(msg.toolError)}</div>`;
        }

        const hasExpandableContent = !!taskLog || isError;

        return `<div class="tool-block tob tob-shell" id="tool-${msg.id}">
<div class="tob-header" data-act="toggle-task-output-block" data-id="${escapeAttr(msg.id)}">
    <span class="tob-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
            <polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>
        </svg>
    </span>
    <span class="tob-label">Task Result</span>
    ${taskId ? `<span class="tob-task-id">${escapeHtml(taskId)}</span>` : ''}
    ${typeBadge}
    ${statusBadge}
    ${hasExpandableContent ? '<span class="tob-expand">›</span>' : ''}
</div>
${outputPreview}
${errorHtml}
<div class="tob-body">
    ${taskLog ? `<div class="tob-log"><pre>${escapeHtml(taskLog)}</pre></div>` : ''}
</div>
</div>`;
    },

    /** Render agent task output (JSONL stream from background agents) */
    _renderAgentTaskOutput(msg, taskId, stream, isCompleted, isError) {
        const { slug, texts, toolCounts, totalInputTokens, totalOutputTokens, isTruncated, truncatedPath } = stream;
        const totalTokens = totalInputTokens + totalOutputTokens;

        // Extract task ID from truncated path: /tmp/claude-{uid}/{slug}/tasks/{taskId}.output
        let truncatedTaskId = '';
        if (truncatedPath) {
            const m = truncatedPath.match(/\/tasks\/([a-f0-9]+)\.output$/);
            if (m) truncatedTaskId = m[1];
        }

        // Combine all agent text responses
        const agentResponse = texts.join('\n\n');

        // Status badge
        let statusBadge;
        if (isError) {
            statusBadge = '<span class="tob-badge tob-badge-error">Failed</span>';
        } else if (isTruncated && !agentResponse) {
            statusBadge = '<span class="tob-badge tob-badge-warn">Truncated</span>';
        } else if (isCompleted) {
            statusBadge = '<span class="tob-badge tob-badge-success">Done</span>';
        } else {
            statusBadge = '<span class="tob-badge tob-badge-pending">Waiting...</span>';
        }

        // Preview from agent response (stripped markdown, 150 chars)
        let outputPreview = '';
        if (agentResponse) {
            const stripped = this._stripMarkdownForPreview(agentResponse);
            const preview = stripped.slice(0, 150).trim();
            if (preview) {
                outputPreview = `<div class="tob-preview">${escapeHtml(preview)}${stripped.length > 150 ? '...' : ''}</div>`;
            }
        } else if (isTruncated) {
            // Truncated output — show clean message, never raw JSON
            outputPreview = '<div class="tob-preview tob-preview-muted">Output truncated</div>';
        } else if (!isCompleted) {
            outputPreview = '<div class="tob-preview tob-preview-muted">Waiting for agent result...</div>';
        } else {
            // Completed but no parseable text
            const raw = (msg.toolOutput || '').trim();
            if (!raw) {
                outputPreview = `<div class="tob-preview tob-preview-muted">${S.tool_renderer.empty.no_response}</div>`;
            } else if (raw.startsWith('{') || raw.startsWith('[')) {
                // JSON-ish content that didn't parse into text blocks
                outputPreview = '<div class="tob-preview tob-preview-muted">Agent output (no text summary)</div>';
            } else {
                const preview = raw.slice(0, 150);
                outputPreview = `<div class="tob-preview tob-preview-muted">${escapeHtml(preview)}${raw.length > 150 ? '...' : ''}</div>`;
            }
        }

        // Truncation warning bar with "View Full Output" button
        let truncatedHtml = '';
        if (isTruncated) {
            const viewBtn = truncatedTaskId
                ? ` <button class="tob-view-full-btn" data-act="open-bg-task" data-task-id="${escapeAttr(truncatedTaskId)}" data-tooltip="Open in Background Tasks widget">${S.tool_renderer.buttons.view_full}</button>`
                : '';
            truncatedHtml = `<div class="tob-truncated">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
    <span>Output truncated${truncatedPath ? ` — <code>${escapeHtml(truncatedPath)}</code>` : ''}</span>
    ${viewBtn}
</div>`;
        }

        // Error display
        let errorHtml = '';
        if (isError && msg.toolError) {
            errorHtml = `<div class="tob-error">${escapeHtml(msg.toolError)}</div>`;
        }

        // Full response for expanded state (markdown rendered)
        let fullResponse = '';
        if (agentResponse) {
            const renderedContent = this._renderMarkdownSafe(agentResponse);
            fullResponse = `<div class="tob-response">${renderedContent}</div>`;
        }

        // Tool activity footer
        let footerHtml = '';
        const toolEntries = Object.entries(toolCounts);
        if (toolEntries.length > 0 || totalTokens > 0) {
            const pills = toolEntries
                .sort((a, b) => b[1] - a[1])
                .map(([name, count]) => `<span class="tob-tool-pill">${escapeHtml(name)} ×${count}</span>`)
                .join('');
            const tokensBadge = totalTokens > 0 ? `<span class="tob-tokens">${formatTokensBadge(totalTokens)}</span>` : '';
            footerHtml = `<div class="tob-footer">${pills}${tokensBadge}</div>`;
        }

        const hasExpandableContent = !!agentResponse || !!truncatedHtml || isError;

        // Icon: agent/users icon (matches Task block)
        return `<div class="tool-block tob tob-agent" id="tool-${msg.id}">
<div class="tob-header" data-act="toggle-task-output-block" data-id="${escapeAttr(msg.id)}">
    <span class="tob-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>
        </svg>
    </span>
    <span class="tob-label">Agent Result</span>
    ${slug ? `<span class="tob-slug">${escapeHtml(slug)}</span>` : (taskId ? `<span class="tob-task-id">${escapeHtml(taskId)}</span>` : '')}
    ${statusBadge}
    ${hasExpandableContent ? '<span class="tob-expand">›</span>' : ''}
</div>
${outputPreview}
${errorHtml}
<div class="tob-body">
    ${truncatedHtml}
    ${fullResponse}
    ${footerHtml}
</div>
</div>`;
    },

    renderTaskStopBlock(msg) {
        const taskId = msg.toolInput?.task_id || '';
        const hasOutput = msg.toolOutput || msg.toolError;
        const isCompleted = msg.toolCompleted || hasOutput;

        // Clean XML wrapper from error text — check both toolError and toolOutput
        // (error tool_results from Claude put the XML in toolOutput via block.content)
        const cleanedFromError = cleanToolError(msg.toolError || '');
        const cleanedFromOutput = cleanToolError(msg.toolOutput || '');
        const hasXmlError = cleanedFromError.text !== (msg.toolError || '').trim()
            || cleanedFromOutput.text !== (msg.toolOutput || '').trim();
        const isError = !!msg.toolError || hasXmlError;
        const errorText = cleanedFromError.text || cleanedFromOutput.text;

        // Detect "not running (status: X)" — task was already done/stopped
        let notRunningStatus = '';
        if (errorText) {
            const nrMatch = errorText.match(/not running\s*\(status:\s*(\w+)\)/i);
            if (nrMatch) notRunningStatus = nrMatch[1].toLowerCase();
        }
        const isAlreadyDone = notRunningStatus === 'completed';
        const isAlreadyStopped = notRunningStatus === 'stopped';
        const isNotRunning = !!notRunningStatus;

        // Parse JSON output: {"message":"...", "task_id":"...", "task_type":"...", "command":"..."}
        let parsed = {};
        if (msg.toolOutput && !isNotRunning) {
            try { parsed = JSON.parse(msg.toolOutput); } catch { }
        }
        const message = parsed.message || '';
        const taskType = parsed.task_type || '';
        const command = parsed.command || '';

        let statusBadge;
        if (isNotRunning && isAlreadyDone) {
            statusBadge = '<span class="tob-badge tob-badge-success">Already Completed</span>';
        } else if (isNotRunning && isAlreadyStopped) {
            statusBadge = '<span class="tob-badge tob-badge-stopped">Already Stopped</span>';
        } else if (isNotRunning) {
            statusBadge = `<span class="tob-badge tob-badge-warn">${escapeHtml(notRunningStatus)}</span>`;
        } else if (isError) {
            statusBadge = '<span class="tob-badge tob-badge-error">Failed</span>';
        } else if (isCompleted) {
            statusBadge = '<span class="tob-badge tob-badge-stopped">Stopped</span>';
        } else {
            statusBadge = '<span class="tob-badge tob-badge-pending">Stopping...</span>';
        }

        const typeBadge = taskType ? `<span class="tob-type">${escapeHtml(taskType)}</span>` : '';

        // Show the command that was stopped as preview
        let previewHtml = '';
        if (command) {
            const cmdShort = command.length > 100 ? command.slice(0, 97) + '...' : command;
            previewHtml = `<div class="tob-preview" style="font-family: var(--font-mono);">${escapeHtml(cmdShort)}</div>`;
        } else if (message && !isError) {
            previewHtml = `<div class="tob-preview">${escapeHtml(message.slice(0, 120))}</div>`;
        }

        let errorHtml = '';
        if (isError) {
            if (isNotRunning) {
                // Friendly message for "not running" cases (not a real error)
                const friendlyMsg = isAlreadyDone
                    ? 'Task had already completed before stop was requested'
                    : isAlreadyStopped
                    ? 'Task had already been stopped'
                    : `Task was not running (status: ${escapeHtml(notRunningStatus)})`;
                errorHtml = `<div class="tob-preview tob-preview-muted">${friendlyMsg}</div>`;
            } else {
                // Genuine error — show cleaned text (no XML tags)
                errorHtml = `<div class="tob-error">${escapeHtml(errorText)}</div>`;
            }
        }

        // Use neutral border for "already completed" (not red)
        const stopClass = isAlreadyDone ? 'tob-stop tob-stop-neutral' : 'tob-stop';

        return `<div class="tool-block tob ${stopClass}" id="tool-${msg.id}">
<div class="tob-header">
    <span class="tob-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
            <rect x="3" y="3" width="18" height="18" rx="2"/>
        </svg>
    </span>
    <span class="tob-label">Task Stopped</span>
    ${taskId ? `<span class="tob-task-id">${escapeHtml(taskId)}</span>` : ''}
    ${typeBadge}
    ${statusBadge}
</div>
${previewHtml}
${errorHtml}
</div>`;
    },

    /**
     * Render EnterPlanMode as a compact single-line block.
     */
    renderEnterPlanBlock(msg) {
        const hasOutput = msg.toolOutput || msg.toolError;
        const isCompleted = msg.toolCompleted || hasOutput;

        const statusBadge = isCompleted
            ? '<span class="plan-mode-badge plan-mode-badge-active">Active</span>'
            : '<span class="plan-mode-badge plan-mode-badge-pending">Entering...</span>';

        return `<div class="tool-block plan-mode-block" id="tool-${msg.id}">
<div class="plan-mode-header">
    <span class="plan-mode-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
            <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>
            <rect x="8" y="2" width="8" height="4" rx="1"/>
        </svg>
    </span>
    <span class="plan-mode-label">Plan Mode</span>
    ${statusBadge}
</div>
</div>`;
    },

    /**
     * Parse Task toolOutput to extract text content
     * Output format is usually: [{"type":"text","text":"..."}]
     */
    /**
     * Strip markdown syntax for clean preview text
     */
    /**
     * Update a Task block result while preserving nested children
     * Called when Task completes to show response without losing nested tools
     */
    /**
     * Update a Task block with live progress from task_progress events.
     * Shows current activity, tool count, and duration between header and body.
     */
    /**
     * Parse Read tool output to extract line numbers and content
     * Format: "  123→\tcontent" or "  123→content"
     */
    /**
     * Render a nice todo list for TodoWrite tool
     */
    renderTodoBlock(msg) {
        let input = msg.toolInput || {};
        if (typeof input === 'string') {
            try { input = JSON.parse(input); } catch { input = {}; }
        }
        const todos = Array.isArray(input.todos) ? input.todos : [];

        // Count by status
        const completed = todos.filter(t => t.status === 'completed').length;
        const inProgress = todos.filter(t => t.status === 'in_progress').length;
        const pending = todos.filter(t => t.status === 'pending').length;

        // Build todo items HTML
        const todoItems = todos.map(todo => {
            const status = todo.status || 'pending';
            const statusClass = `todo-${status.replace('_', '-')}`;
            let statusIcon;
            if (status === 'completed') {
                statusIcon = `<svg class="todo-icon completed" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                    <polyline points="22 4 12 14.01 9 11.01"/>
                </svg>`;
            } else if (status === 'in_progress') {
                statusIcon = `<svg class="todo-icon in-progress" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="12" cy="12" r="10"/>
                    <polyline points="12 6 12 12 16 14"/>
                </svg>`;
            } else {
                statusIcon = `<svg class="todo-icon pending" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="12" cy="12" r="10"/>
                </svg>`;
            }

            return `<div class="todo-item ${statusClass}">
                ${statusIcon}
                <span class="todo-content">${escapeHtml(todo.content || '')}</span>
            </div>`;
        }).join('');

        // Summary line
        const summaryParts = [];
        if (completed > 0) summaryParts.push(`${completed} done`);
        if (inProgress > 0) summaryParts.push(`${inProgress} active`);
        if (pending > 0) summaryParts.push(`${pending} pending`);
        const summary = summaryParts.join(' · ') || 'No tasks';

        return `<div class="tool-block todo-block" id="tool-${msg.id}">
<div class="todo-header">
    <span class="todo-title">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M9 11l3 3L22 4"/>
            <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
        </svg>
        Tasks
    </span>
    <span class="todo-summary">${summary}</span>
</div>
<div class="todo-list">${todoItems}</div>
</div>`;
    },
};
