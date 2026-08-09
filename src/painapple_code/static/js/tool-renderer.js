/**
 * Tool Renderer Module
 * Renders tool blocks (Bash, Read, Edit, Write, etc.) with specialized displays
 */

import S from './strings.js';
import { $, escapeHtml, escapeAttr, sanitizeSvg, parseTaskUsage, formatTokensBadge, formatDuration } from './utils.js';
import { CONFIG } from './config.js';
import { generateSmartDiff, renderSmartDiff } from './diff-utils.js';
// URL patterns always needed, path pattern for client-side scanning in colorized output
import { buildUrlPattern, buildPathPattern, buildStandalonePattern, isValidStandaloneFile, cleanUrlTrailingPunct, parseLineInfo } from './linkify-utils.js';
import { parseBackgroundTaskOutput, bgTaskTracker } from './background-tasks.js';
import { getToolCollapseMode, getToolCategory } from './widgets/config-widget.js';
import { blockMethods } from './tool-renderer-blocks.js';
import { thinkingMethods } from './tool-renderer-thinking.js';
import { basename } from './path-utils.js';

/**
 * Clean tool_use_error XML wrappers from error/output text.
 * Claude CLI wraps sibling errors as <tool_use_error>message</tool_use_error>.
 * Returns {text, isSiblingError} — isSiblingError is true when another parallel tool failed.
 */
export function cleanToolError(text) {
    if (!text) return { text: '', isSiblingError: false };
    if (typeof text !== 'string') text = (typeof text === 'object' && text !== null) ? JSON.stringify(text, null, 2) : String(text);
    const match = text.match(/<tool_use_error>([\s\S]*?)<\/tool_use_error>/);
    if (match) {
        const inner = match[1].trim();
        const isSiblingError = inner.toLowerCase().includes('sibling tool call errored');
        return { text: inner, isSiblingError };
    }
    return { text, isSiblingError: false };
}

// ANSI color code to CSS class mapping
const ANSI_COLORS = {
    '30': 'ansi-black', '31': 'ansi-red', '32': 'ansi-green', '33': 'ansi-yellow',
    '34': 'ansi-blue', '35': 'ansi-magenta', '36': 'ansi-cyan', '37': 'ansi-white',
    '90': 'ansi-bright-black', '91': 'ansi-bright-red', '92': 'ansi-bright-green',
    '93': 'ansi-bright-yellow', '94': 'ansi-bright-blue', '95': 'ansi-bright-magenta',
    '96': 'ansi-bright-cyan', '97': 'ansi-bright-white'
};

// File extension → highlight.js language mapping (shared across all tool renderers)
const LANG_MAP = {
    js: 'javascript', ts: 'typescript', jsx: 'javascript', tsx: 'typescript',
    py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
    c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp', cs: 'csharp',
    php: 'php', swift: 'swift', kt: 'kotlin', scala: 'scala',
    html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml',
    css: 'css', scss: 'scss', less: 'less', sass: 'sass',
    json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'ini', ini: 'ini',
    md: 'markdown', sql: 'sql', sh: 'bash', bash: 'bash', zsh: 'bash',
    dockerfile: 'dockerfile', makefile: 'makefile',
    excalidraw: 'json',
    // Image formats — not highlight.js languages, but used for display detection
    png: 'image', jpg: 'image', jpeg: 'image', gif: 'image',
    webp: 'image', ico: 'image', bmp: 'image', tiff: 'image',
    heic: 'image', avif: 'image'
};

// Display overrides: when the hljs lang name isn't what users expect to see
const LANG_DISPLAY_OVERRIDE = { excalidraw: 'excalidraw' };

// Compound extension overrides (checked by filename, not just ext)
const COMPOUND_EXT_OVERRIDE = {
    '.vl.json': { hlLang: 'json', displayLang: 'chart' },
};

export function getLangForExt(ext, filename) {
    // Check compound extensions first (e.g., .vl.json → chart)
    if (filename) {
        const lower = filename.toLowerCase();
        for (const [compound, result] of Object.entries(COMPOUND_EXT_OVERRIDE)) {
            if (lower.endsWith(compound)) return result;
        }
    }
    let hlLang = LANG_MAP[ext] || 'plaintext';
    // Fall back to plaintext for languages not in the hljs bundle (e.g. scala, sass)
    if (hlLang !== 'plaintext' && hlLang !== 'image' && window.hljs && !window.hljs.getLanguage(hlLang)) {
        hlLang = 'plaintext';
    }
    const displayLang = LANG_DISPLAY_OVERRIDE[ext] || (LANG_MAP[ext] || 'plaintext');
    return { hlLang, displayLang };
}

/**
 * Convert ANSI escape codes to HTML spans
 */
export function ansiToHtml(text) {
    if (!text || !text.includes('\x1b[')) return null; // No ANSI codes

    let result = '';
    let currentClasses = [];
    let i = 0;

    while (i < text.length) {
        // Check for ANSI escape sequence
        if (text[i] === '\x1b' && text[i + 1] === '[') {
            const endIdx = text.indexOf('m', i);
            if (endIdx !== -1) {
                const codes = text.slice(i + 2, endIdx).split(';');

                // Close current span if any
                if (currentClasses.length > 0) {
                    result += '</span>';
                    currentClasses = [];
                }

                // Process codes
                for (const code of codes) {
                    if (code === '0' || code === '') {
                        // Reset
                        currentClasses = [];
                    } else if (code === '1') {
                        currentClasses.push('ansi-bold');
                    } else if (code === '3') {
                        currentClasses.push('ansi-italic');
                    } else if (code === '4') {
                        currentClasses.push('ansi-underline');
                    } else if (ANSI_COLORS[code]) {
                        currentClasses.push(ANSI_COLORS[code]);
                    }
                }

                // Open new span if we have classes
                if (currentClasses.length > 0) {
                    result += `<span class="${currentClasses.join(' ')}">`;
                }

                i = endIdx + 1;
                continue;
            }
        }

        // Escape HTML special chars
        const char = text[i];
        if (char === '<') result += '&lt;';
        else if (char === '>') result += '&gt;';
        else if (char === '&') result += '&amp;';
        else result += char;
        i++;
    }

    // Close any remaining span
    if (currentClasses.length > 0) {
        result += '</span>';
    }

    return result;
}

/**
 * Apply pattern-based colorization to bash output
 */
export function colorizeBashLine(line, escapedLine) {
    // Git diff patterns
    if (/^\+(?!\+\+)/.test(line)) {
        return `<span class="bash-diff-add">${escapedLine}</span>`;
    }
    if (/^-(?!--)/.test(line)) {
        return `<span class="bash-diff-del">${escapedLine}</span>`;
    }
    if (/^@@\s/.test(line)) {
        return `<span class="bash-diff-hunk">${escapedLine}</span>`;
    }

    // Git status patterns
    if (/^\s*M\s+/.test(line) || /^\s*modified:\s+/i.test(line)) {
        return `<span class="bash-git-modified">${escapedLine}</span>`;
    }
    if (/^\s*A\s+/.test(line) || /^\s*new file:\s+/i.test(line)) {
        return `<span class="bash-git-added">${escapedLine}</span>`;
    }
    if (/^\s*D\s+/.test(line) || /^\s*deleted:\s+/i.test(line)) {
        return `<span class="bash-git-deleted">${escapedLine}</span>`;
    }
    if (/^\?\?\s+/.test(line)) {
        return `<span class="bash-git-untracked">${escapedLine}</span>`;
    }

    // Error patterns
    if (/\b(error|Error|ERROR|fatal|FATAL|fail|FAIL|failed|FAILED)\b/.test(line)) {
        return `<span class="bash-error-line">${escapedLine}</span>`;
    }

    // Warning patterns
    if (/\b(warning|Warning|WARNING|warn|WARN)\b/.test(line)) {
        return `<span class="bash-warn-line">${escapedLine}</span>`;
    }

    // Success patterns
    if (/\b(success|Success|SUCCESS|passed|PASSED|ok|OK|done|Done|DONE)\b/.test(line)) {
        return `<span class="bash-success-line">${escapedLine}</span>`;
    }

    return escapedLine;
}

/**
 * ToolRenderer - Renders tool use blocks with specialized formatting
 */
export class ToolRenderer {
    /**
     * @param {Object} options - Configuration
     * @param {number} options.maxOutputLength - Max output chars before truncation
     */
    constructor(options = {}) {
        this.maxOutputLength = options.maxOutputLength || CONFIG.MAX_OUTPUT_LENGTH || 3000;
    }

    /**
     * Generate gutter icon HTML for tool collapse
     * @private
     */
    _getGutterIconHtml(toolId) {
        return `
            <button class="tool-gutter-icon" onclick="event.stopPropagation(); app.toggleNormalToolCollapse('${toolId}')" data-tooltip="Collapse/expand this tool">
                <svg class="gutter-collapse-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
                    <path d="M19 9l-7 7-7-7"/>
                </svg>
                <svg class="gutter-expand-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
                    <path d="M9 5l7 7-7 7"/>
                </svg>
            </button>
        `;
    }

    /**
     * Wrap tool HTML with a container that has gutter icon
     * @private
     */
    _wrapWithGutter(toolHtml, toolId, { collapseMode = 'compact', noGutterIcon = false } = {}) {
        const gutterIcon = noGutterIcon ? '' : this._getGutterIconHtml(toolId);
        const collapsedClass = collapseMode === 'collapsed' ? ' tool-collapsed' : '';
        return `<div class="tool-block-wrapper${collapsedClass}" data-tool-id="${toolId}">${gutterIcon}${toolHtml}</div>`;
    }

    /**
     * Render a tool block for a message
     */
    renderToolBlock(msg, { isThinking = false, isAgent = false } = {}) {
        const toolId = `tool-${msg.id}`;
        const toolType = getToolCategory(msg.toolName);
        const context = isAgent ? 'agent' : isThinking ? 'thinking' : 'normal';
        const mode = getToolCollapseMode(context, toolType);
        const defaultExpanded = mode === 'expanded';
        const gutterOpts = { collapseMode: mode };
        let html;

        // Special rendering for Edit tool - show colorized diff
        if (msg.toolName === 'Edit' && msg.toolInput) {
            // Check for sibling tool error
            const editCleaned = cleanToolError(msg.toolOutput || msg.toolError || '');
            if (editCleaned.isSiblingError) {
                const fileName = (msg.toolInput.file_path || '').split('/').pop();
                html = this._renderSiblingErrorBlock(msg, 'edit', escapeHtml(fileName));
                return this._wrapWithGutter(html, toolId, gutterOpts);
            }
            const diffHtml = this.renderEditDiff(msg.toolInput, msg.toolOutput, msg.toolId, msg.startLine);
            if (diffHtml) {
                const hasOutput = msg.toolOutput || msg.toolError;
                const isCompleted = msg.toolCompleted || hasOutput;
                const cleanedEditErr = cleanToolError(msg.toolError);
                const statusClass = msg.toolError ? 'edit-status-error' : (isCompleted ? 'edit-status-success' : 'edit-status-pending');
                const statusText = msg.toolError ? 'Failed' : (isCompleted ? 'Applied' : 'Applying...');

                html = `<div class="tool-block edit-tool-block" id="${toolId}">
${diffHtml}
<div class="edit-status ${statusClass}">${statusText}${msg.toolError ? ': ' + escapeHtml(cleanedEditErr.text) : ''}</div>
</div>`;
                return this._wrapWithGutter(html, toolId, gutterOpts);
            }
        }

        // Special rendering for TodoWrite tool - show nice todo list
        if (msg.toolName === 'TodoWrite' && msg.toolInput?.todos) {
            html = this.renderTodoBlock(msg);
            return this._wrapWithGutter(html, toolId, gutterOpts);
        }

        // Special rendering for Read tool with image files - add View button
        if (msg.toolName === 'Read' && msg.toolInput?.file_path) {
            const filePath = msg.toolInput.file_path;
            const isImage = /\.(png|jpg|jpeg|gif|webp|svg|bmp|ico)$/i.test(filePath);
            if (isImage) {
                html = this.renderReadImageBlock(msg);
                return this._wrapWithGutter(html, toolId, gutterOpts);
            }
            // Non-image Read tool - always use styled block (handles loading state too)
            html = this.renderReadBlock(msg, { defaultExpanded });
            return this._wrapWithGutter(html, toolId, gutterOpts);
        }

        // Specialized compact rendering for common tools
        if ((msg.toolName === 'Bash' || msg.toolName === 'Shell') && msg.toolInput?.command) {
            html = this.renderBashBlock(msg, { defaultExpanded });
            return this._wrapWithGutter(html, toolId, gutterOpts);
        }
        if (msg.toolName === 'Grep' && msg.toolInput?.pattern) {
            html = this.renderGrepBlock(msg, { defaultExpanded });
            return this._wrapWithGutter(html, toolId, gutterOpts);
        }
        if (msg.toolName === 'Glob' && msg.toolInput?.pattern) {
            html = this.renderGlobBlock(msg, { defaultExpanded });
            return this._wrapWithGutter(html, toolId, gutterOpts);
        }
        if (msg.toolName === 'Write' && msg.toolInput?.file_path) {
            html = this.renderWriteBlock(msg, { defaultExpanded });
            return this._wrapWithGutter(html, toolId, gutterOpts);
        }
        if (msg.toolName === 'WebFetch' || msg.toolName === 'WebSearch') {
            html = this.renderWebFetchBlock(msg, { defaultExpanded });
            return this._wrapWithGutter(html, toolId, gutterOpts);
        }

        // Special rendering for Task (agent) tool - show grouped style
        // No gutter icon on Task block itself; sub-agent tools get their own gutter icons
        if (msg.toolName === 'Task') {
            html = this.renderTaskBlock(msg);
            return this._wrapWithGutter(html, toolId, { collapseMode: mode, noGutterIcon: true });
        }

        // Compact rendering for Skill tool
        if (msg.toolName === 'Skill') {
            html = this.renderSkillBlock(msg);
            return this._wrapWithGutter(html, toolId, gutterOpts);
        }

        // Compact rendering for TaskOutput tool
        if (msg.toolName === 'TaskOutput') {
            html = this.renderTaskOutputBlock(msg);
            return this._wrapWithGutter(html, toolId, gutterOpts);
        }

        // Compact rendering for TaskStop tool
        if (msg.toolName === 'TaskStop') {
            html = this.renderTaskStopBlock(msg);
            return this._wrapWithGutter(html, toolId, gutterOpts);
        }

        // Compact rendering for EnterPlanMode
        if (msg.toolName === 'EnterPlanMode') {
            html = this.renderEnterPlanBlock(msg);
            return this._wrapWithGutter(html, toolId, gutterOpts);
        }

        // Compact rendering for AskUserQuestion (safety net — normally rendered as interactive form)
        if (msg.toolName === 'AskUserQuestion') {
            const questions = msg.toolInput?.questions || [];
            const label = questions.length === 1
                ? escapeHtml(questions[0].question || 'Question')
                : `${questions.length} questions`;
            html = `<div class="tool-block compact-tool-block" id="${toolId}">
<div class="tool-header compact-header"><span class="tool-name compact-tool-name">
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
AskUserQuestion<span class="tool-header-path">${label}</span></span></div></div>`;
            return this._wrapWithGutter(html, toolId, gutterOpts);
        }

        // Compact rendering for ExitPlanMode (safety net — normally rendered as plan approval card)
        if (msg.toolName === 'ExitPlanMode') {
            html = `<div class="tool-block compact-tool-block" id="${toolId}">
<div class="tool-header compact-header"><span class="tool-name compact-tool-name">
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
ExitPlanMode<span class="tool-header-path">Plan ready for approval</span></span></div></div>`;
            return this._wrapWithGutter(html, toolId, gutterOpts);
        }

        // Default tool block rendering
        const inputDisplay = this.formatToolInput(msg.toolName, msg.toolInput);
        const hasOutput = msg.toolOutput || msg.toolError;
        const isCompleted = msg.toolCompleted || hasOutput;
        const defaultCleaned = cleanToolError(msg.toolOutput || msg.toolError || '');
        const outputContent = hasOutput
            ? (defaultCleaned.isSiblingError
                ? `<span class="bash-sibling-label">${S.tool_renderer.status.skipped}</span> a parallel tool call failed`
                : this.linkifyToolOutput(escapeHtml(this.truncateOutput(defaultCleaned.text)), msg.fileLinks))
            : (isCompleted ? S.tool_renderer.badges.done : '');
        const outputClass = `tool-output${msg.toolError ? ' error' : ''}${(msg.toolOutput?.length || 0) > this.maxOutputLength ? ' truncated' : ''}`;

        // Get compact header preview for all tools
        const headerPreview = this.getToolHeaderPreview(msg.toolName, msg.toolInput);

        // Add buttons for file-related tools (Read, Write, Edit)
        const hasFilePath = msg.toolInput?.file_path;
        const isFileViewable = (msg.toolName === 'Read' || msg.toolName === 'Write' || msg.toolName === 'Edit') && hasFilePath;
        // Model-controlled path: stash quote-safe in data-file and read it back
        // via this.dataset.file at click time (never interpolated into the JS
        // string), so a path with `"`/`'` can't break out. Same pattern as fileLink().
        const filePathAttr = hasFilePath ? escapeAttr(msg.toolInput.file_path) : '';

        // "Open in Editor" button - opens file in editor tab
        const editorButton = isFileViewable
            ? `<button class="tool-action-btn" data-file="${filePathAttr}" onclick="event.stopPropagation(); window.app?.openFileInEditor(this.dataset.file)" data-tooltip="Open in editor">
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 9.5-9.5z"/></svg>
</button>`
            : '';

        // "View" button - opens file preview widget
        const viewButton = isFileViewable
            ? `<button class="tool-action-btn" data-file="${filePathAttr}" onclick="event.stopPropagation(); window.app?.previewFile(this.dataset.file)" data-tooltip="Preview file">
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
</button>`
            : '';

        html = `<div class="tool-block" id="${toolId}">
<div class="tool-header" onclick="app.toggleTool('${msg.id}')">
<span class="tool-name">
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
${escapeHtml(msg.toolName)}${headerPreview ? `<span class="tool-header-path">${headerPreview}</span>` : ''}
</span>
<div class="tool-actions">
${editorButton}${viewButton}<button class="tool-action-btn" onclick="event.stopPropagation(); app.copyToolOutput('${msg.id}')" data-tooltip="Copy">
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
</button>
</div>
</div>
<div class="tool-content">
<div class="tool-input">
${inputDisplay}
</div>
${isCompleted ? `<div class="${outputClass}">${outputContent}</div>` : '<div class="tool-output" style="color: var(--text-muted)">Running...</div>'}
</div>
</div>`;
        return this._wrapWithGutter(html, toolId, gutterOpts);
    }

    /**
     * Get a compact preview string for the tool header
     */
    getToolHeaderPreview(toolName, input) {
        if (!input) return '';

        let preview = '';
        switch (toolName) {
            case 'Bash':
            case 'Shell':
                preview = input.command || '';
                break;
            case 'Read':
                // Show just filename
                preview = basename(input.file_path) || '';
                break;
            case 'Write':
                preview = basename(input.file_path) || '';
                break;
            case 'Grep':
                preview = `/${input.pattern || ''}/`;
                break;
            case 'Glob':
                preview = input.pattern || '';
                break;
            case 'WebFetch':
                // Show domain only
                try {
                    preview = new URL(input.url).hostname;
                } catch { preview = input.url || ''; }
                break;
            case 'Task':
                preview = input.description || '';
                break;
            case 'Skill':
                preview = input.skill || '';
                break;
            default:
                // Try common field names
                preview = input.description || input.command || input.path || basename(input.file_path) || '';
        }

        // Truncate and escape
        if (preview.length > 50) {
            preview = preview.substring(0, 47) + '...';
        }
        return escapeHtml(preview);
    }

    /**
     * Generate a clickable filename link for tool headers.
     * Returns an <a> with file-path-link class so the context menu system picks it up.
     * @param {string} fullPath - Full file path
     * @param {string} displayName - Display text (usually just filename)
     * @param {string} extraClass - Additional CSS class (e.g., 'read-filename')
     */
    fileLink(fullPath, displayName, extraClass = '') {
        // SECURITY: fullPath is model-controlled (e.g. a Write/Edit target shown
        // on the permission-approval card). Keep it out of inline JS entirely —
        // stash it in a quote-escaped data-file attribute and read it back via
        // this.dataset.file at click time, so a path containing `"`/`'` can't
        // break out of the attribute or the onclick handler. escapeAttr covers
        // quotes; escapeHtml only covers & < >.
        const attrPath = escapeAttr(fullPath);
        const classes = `file-path-link${extraClass ? ' ' + extraClass : ''}`;
        return `<a href="#" class="${classes}" data-file="${attrPath}" data-tooltip="${attrPath}" onclick="event.preventDefault(); event.stopPropagation(); window.app?.previewFile(this.dataset.file)">${escapeHtml(displayName)}</a>`;
    }

    /**
     * Format tool input for display
     */
    formatToolInput(toolName, input) {
        if (!input) return '';

        if ((toolName === 'Bash' || toolName === 'Shell') && input.command) {
            return `<code>$ ${escapeHtml(input.command)}</code>`;
        }
        if (toolName === 'Read' && input.file_path) {
            return `<code>${escapeHtml(input.file_path)}</code>`;
        }
        if (toolName === 'Grep' && input.pattern) {
            return `<code>/${escapeHtml(input.pattern)}/</code>`;
        }
        if (toolName === 'Glob' && input.pattern) {
            return `<code>${escapeHtml(input.pattern)}</code>`;
        }
        if (toolName === 'Write' && input.file_path) {
            return `<code>${escapeHtml(input.file_path)}</code>`;
        }
        if (toolName === 'Edit' && input.file_path) {
            return `<code>${escapeHtml(input.file_path)}</code>`;
        }

        return this._renderInputTable(input);
    }

    /**
     * Render a tool input object as a key→value table.
     * Top-level keys are rows; nested objects/arrays are JSON-stringified inline.
     */
    _renderInputTable(input) {
        if (typeof input !== 'object' || Array.isArray(input)) {
            return `<pre>${escapeHtml(JSON.stringify(input, null, 2))}</pre>`;
        }
        const keys = Object.keys(input);
        if (keys.length === 0) return '';

        const rows = keys.map(key => {
            const value = input[key];
            let cellHtml;
            if (value === null) {
                cellHtml = '<span class="tool-input-null">null</span>';
            } else if (typeof value === 'string') {
                cellHtml = escapeHtml(value);
            } else if (typeof value === 'number' || typeof value === 'boolean') {
                cellHtml = `<span class="tool-input-scalar">${escapeHtml(String(value))}</span>`;
            } else {
                cellHtml = `<code class="tool-input-nested">${escapeHtml(JSON.stringify(value))}</code>`;
            }
            return `<tr><th class="tool-input-key">${escapeHtml(key)}</th><td class="tool-input-value">${cellHtml}</td></tr>`;
        }).join('');

        return `<table class="tool-input-table">${rows}</table>`;
    }

    /**
     * Format tool input for thinking message (compact display)
     */
    formatThinkingToolInput(toolName, input) {
        if (!input) return '';

        if ((toolName === 'Bash' || toolName === 'Shell') && input.command) {
            return `<code>$ ${escapeHtml(input.command.slice(0, 60))}${input.command.length > 60 ? '...' : ''}</code>`;
        }
        if (toolName === 'Read' && input.file_path) {
            return `<code>${escapeHtml(basename(input.file_path))}</code>`;
        }
        if (toolName === 'Write' && input.file_path) {
            return `<code>${escapeHtml(basename(input.file_path))}</code>`;
        }
        if (toolName === 'Edit' && input.file_path) {
            return `<code>${escapeHtml(basename(input.file_path))}</code>`;
        }
        if (toolName === 'Grep' && input.pattern) {
            return `<code>/${escapeHtml(input.pattern.slice(0, 30))}${input.pattern.length > 30 ? '...' : ''}/</code>`;
        }
        if (toolName === 'Glob' && input.pattern) {
            return `<code>${escapeHtml(input.pattern)}</code>`;
        }
        if (toolName === 'Task') {
            return `<span class="thinking-tool-desc">${escapeHtml(input.description || '')}</span>`;
        }

        // For other tools, show first key-value pair
        const keys = Object.keys(input);
        if (keys.length > 0) {
            const key = keys[0];
            const val = String(input[key]).slice(0, 40);
            return `<span class="thinking-tool-param">${key}: ${escapeHtml(val)}${String(input[key]).length > 40 ? '...' : ''}</span>`;
        }

        return '';
    }

    /**
     * Linkify file paths and URLs in tool output (already HTML-escaped text).
     * Supports two modes:
     * 1. Position-based: Uses server-provided positions (fileLinks array)
     * 2. Client-scan: Scans text for paths and verifies against a map (verifiedFiles object)
     * @param {string} text - The HTML-escaped tool output text
     * @param {Array|null} fileLinks - Server-provided file links [{path, resolved, start, end, line_info}]
     * @param {Object|null} verifiedFiles - Map of {path: resolvedPath} for client-side scanning
     */
    linkifyToolOutput(text, fileLinks = null, verifiedFiles = null) {
        const replacements = []; // [{start, end, html}]

        // 1. Find URLs (scanned client-side, no server verification needed)
        const urlPattern = buildUrlPattern();
        let match;
        while ((match = urlPattern.exec(text)) !== null) {
            let url = match[0];
            const cleaned = cleanUrlTrailingPunct(url);
            url = cleaned.url;
            const end = match.index + url.length;

            replacements.push({
                start: match.index,
                end: end,
                // href quote-safe; text escaped. (The URL regex already
                // constrains the scheme to http/https.)
                html: `<a href="${escapeAttr(url)}" class="external-link" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`
            });
        }

        // 2a. Add file links using server-provided positions (when available)
        if (fileLinks && Array.isArray(fileLinks)) {
            for (const link of fileLinks) {
                const { path, resolved, start, end, line_info } = link;

                // Check for overlap with URL replacements
                const overlaps = replacements.some(r =>
                    (start < r.end && end > r.start)
                );
                if (overlaps) continue;

                const fullDisplay = line_info ? path + line_info : path;
                // Preview path (resolved || path) is read at click time from
                // this.dataset — never interpolated into the JS string.
                const resolvedAttr = resolved ? ` data-resolved="${escapeAttr(resolved)}"` : '';

                // Parse line info into options for preview
                const lineOpts = parseLineInfo(line_info);
                const optsJson = lineOpts ? JSON.stringify(lineOpts).replace(/"/g, '&quot;') : '';
                const optsAttr = optsJson ? ` data-line-opts="${optsJson}"` : '';

                replacements.push({
                    start,
                    end,
                    html: `<a href="#" class="file-path-link" data-file="${escapeAttr(path)}"${resolvedAttr} data-tooltip="${escapeAttr(resolved || path)}"${optsAttr} onclick="event.preventDefault(); const opts = this.dataset.lineOpts ? JSON.parse(this.dataset.lineOpts) : {}; window.app?.openFileLink(this.dataset.resolved || this.dataset.file, opts, event)">${escapeHtml(fullDisplay)}</a>`
                });
            }
        }

        // 2b. Client-side path scanning (for colorized output where positions don't work)
        if (verifiedFiles && Object.keys(verifiedFiles).length > 0) {
            // Helper to add a verified path replacement
            const addPathReplacement = (matchObj, path, lineInfo, fullMatch) => {
                const resolvedPath = verifiedFiles[path];
                if (!resolvedPath) return;

                // Check for overlap with existing replacements
                const overlaps = replacements.some(r =>
                    (matchObj.index < r.end && matchObj.index + fullMatch.length > r.start)
                );
                if (overlaps) return;

                const fullDisplay = lineInfo ? path + lineInfo : path;

                const lineOpts = parseLineInfo(lineInfo);
                const optsJson = lineOpts ? JSON.stringify(lineOpts).replace(/"/g, '&quot;') : '';
                const optsAttr = optsJson ? ` data-line-opts="${optsJson}"` : '';

                replacements.push({
                    start: matchObj.index,
                    end: matchObj.index + fullMatch.length,
                    html: `<a href="#" class="file-path-link" data-file="${escapeAttr(path)}" data-resolved="${escapeAttr(resolvedPath)}" data-tooltip="${escapeAttr(resolvedPath)}"${optsAttr} onclick="event.preventDefault(); const opts = this.dataset.lineOpts ? JSON.parse(this.dataset.lineOpts) : {}; window.app?.openFileLink(this.dataset.resolved || this.dataset.file, opts, event)">${escapeHtml(fullDisplay)}</a>`
                });
            };

            // Scan for paths with directories (e.g., static/js/app.js)
            const pathPattern = buildPathPattern();
            while ((match = pathPattern.exec(text)) !== null) {
                const path = match[1];
                const lineInfo = match[2] || '';

                if (!path.includes('/')) continue;
                if (/^\d+\.\d+/.test(path)) continue;
                if (/^\d+\/\d+/.test(path)) continue;

                addPathReplacement(match, path, lineInfo, match[0]);
            }

            // Scan for standalone filenames (e.g., CLAUDE.md, server.py)
            const standalonePattern = buildStandalonePattern();
            while ((match = standalonePattern.exec(text)) !== null) {
                const filename = match[1];
                const lineInfo = match[2] || '';

                if (!isValidStandaloneFile(filename, text.slice(Math.max(0, match.index - 20), match.index))) continue;

                addPathReplacement(match, filename, lineInfo, match[0]);
            }
        }

        // 3. Sort by position (descending) and apply replacements
        replacements.sort((a, b) => b.start - a.start);
        for (const r of replacements) {
            text = text.slice(0, r.start) + r.html + text.slice(r.end);
        }

        return text;
    }

    /**
     * Render a colorized diff for Edit tool operations.
     * Shows removed lines in red, added lines in green, with stats and file link.
     * @param {object} input - Tool input with file_path, old_string, new_string
     * @param {string} toolOutput - Tool output for line number parsing
     * @param {string} [toolId] - Tool ID for linking to Changes panel
     */
    parseEditLineNumber(toolOutput, newString) {
        if (!toolOutput || !newString) return null;

        // Extract "NUMBER<delim>content" pairs — Claude CLI uses either → (older) or \t (current)
        const linePattern = /^\s*(\d+)(?:→|\t)(.*)$/gm;
        const firstNewLine = newString.split('\n')[0];

        let match;
        while ((match = linePattern.exec(toolOutput)) !== null) {
            const lineNum = parseInt(match[1], 10);
            const content = match[2];
            // Check if this line matches first line of new_string (trim to handle padding)
            if (content.trim() === firstNewLine.trim()) {
                return lineNum;
            }
        }

        return null; // Unknown — caller hides line numbers rather than faking 1-based ones
    }

    /**
     * Render a Read tool block for image files with inline preview
     */
    _renderSiblingErrorBlock(msg, toolType, label) {
        const icons = {
            grep: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
            glob: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
            read: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>',
            write: '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/>',
            edit: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>',
        };
        const icon = icons[toolType] || icons.read;
        return `<div class="tool-block ${toolType}-block sibling-error" id="tool-${msg.id}">
<div class="${toolType}-header">
    <svg class="${toolType}-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">${icon}</svg>
    <code class="${toolType}-pattern">${label}</code>
    <span class="sibling-error-badge">Skipped</span>
</div>
<div class="sibling-error-msg">A parallel tool call failed</div>
</div>`;
    }

    /**
     * Render a compact Bash/Shell tool block
     * Design: Clickable command copies, expandable for long/multiline commands
     */
    _parseTaskOutputXml(text) {
        if (!text) return {};
        const result = {};
        const tagRegex = /<(\w+)>([\s\S]*?)<\/\1>/g;
        let match;
        while ((match = tagRegex.exec(text)) !== null) {
            result[match[1]] = match[2].trim();
        }
        return result;
    }

    /**
     * Parse agent streaming JSONL output into useful components.
     * Extracts slug, text responses, tool counts, and token usage.
     */
    _parseAgentStream(rawOutput) {
        const result = {
            slug: '',
            texts: [],
            toolCounts: {},
            totalInputTokens: 0,
            totalOutputTokens: 0,
            isTruncated: false,
            truncatedPath: '',
        };

        if (!rawOutput) return result;

        // Check for truncation marker at start
        const truncMatch = rawOutput.match(/^\[Truncated\.\s*Full output:\s*(.+?)\]/);
        if (truncMatch) {
            result.isTruncated = true;
            result.truncatedPath = truncMatch[1];
            rawOutput = rawOutput.slice(truncMatch[0].length);
        }

        const lines = rawOutput.split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('{')) continue;

            try {
                const obj = JSON.parse(trimmed);

                // Extract slug from first occurrence
                if (obj.slug && !result.slug) {
                    result.slug = obj.slug;
                }

                // Parse assistant messages for text and tool_use
                if (obj.message?.role === 'assistant' && obj.message?.content) {
                    for (const block of obj.message.content) {
                        if (block.type === 'text' && block.text) {
                            result.texts.push(block.text);
                        }
                        if (block.type === 'tool_use' && block.name) {
                            result.toolCounts[block.name] = (result.toolCounts[block.name] || 0) + 1;
                        }
                    }
                }

                // Accumulate token usage
                if (obj.message?.usage) {
                    const u = obj.message.usage;
                    result.totalOutputTokens += u.output_tokens || 0;
                    result.totalInputTokens += (u.input_tokens || 0) +
                        (u.cache_read_input_tokens || 0) +
                        (u.cache_creation_input_tokens || 0);
                }
            } catch {
                // Malformed JSON line (possibly truncated mid-stream), skip
            }
        }

        return result;
    }

    _parseTaskOutputWithUsage(toolOutput) {
        const raw = this._parseTaskOutput(toolOutput);
        return parseTaskUsage(raw);
    }

    /**
     * Parse Task toolOutput to extract text content
     * Output format is usually: [{"type":"text","text":"..."}]
     */
    _parseTaskOutput(toolOutput) {
        if (!toolOutput) return '';

        try {
            let parsed = toolOutput;
            if (typeof toolOutput === 'string') {
                if (toolOutput.startsWith('[')) {
                    parsed = JSON.parse(toolOutput);
                } else {
                    return toolOutput;
                }
            }

            if (Array.isArray(parsed)) {
                return parsed
                    .filter(block => block.type === 'text' && block.text)
                    .map(block => block.text)
                    .join('\n\n');
            }

            if (parsed && typeof parsed === 'object' && parsed.text) {
                return parsed.text;
            }

            return typeof toolOutput === 'string' ? toolOutput : JSON.stringify(toolOutput);
        } catch (e) {
            return typeof toolOutput === 'string' ? toolOutput : JSON.stringify(toolOutput);
        }
    }

    /**
     * Strip markdown syntax for clean preview text
     */
    _stripMarkdownForPreview(text) {
        if (!text) return '';
        return text
            .replace(/^#{1,6}\s+/gm, '')
            .replace(/\*\*([^*]+)\*\*/g, '$1')
            .replace(/\*([^*]+)\*/g, '$1')
            .replace(/__([^_]+)__/g, '$1')
            .replace(/_([^_]+)_/g, '$1')
            .replace(/`([^`]+)`/g, '$1')
            .replace(/^>\s*/gm, '')
            .replace(/^[-*+]\s+/gm, '')
            .replace(/^\d+\.\s+/gm, '')
            .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
            .replace(/\s+/g, ' ')
            .trim();
    }

    /**
     * Render markdown content safely
     */
    _renderMarkdownSafe(content) {
        if (!content) return '';
        // Try to use app's markdown renderer if available
        if (window.app?.markdown) {
            return window.app.markdown.render(content);
        }
        // Fallback: escape and preserve whitespace
        return `<pre style="white-space: pre-wrap;">${escapeHtml(content)}</pre>`;
    }

    /**
     * Update a Task block result while preserving nested children
     * Called when Task completes to show response without losing nested tools
     */
    _updateTaskBlockResult(taskBlock, msg) {
        const isError = !!msg.toolError;
        const isCompleted = msg.toolCompleted || msg.toolOutput || isError;

        // Remove live progress indicator (replaced by final result)
        const progressEl = taskBlock.querySelector('.task-progress');
        if (progressEl) progressEl.remove();

        // Update data-complete attribute
        taskBlock.setAttribute('data-complete', isCompleted ? 'true' : 'false');

        // Update status badge
        const badge = taskBlock.querySelector('.task-block-badge');
        if (badge) {
            if (isError) {
                badge.className = 'task-block-badge task-block-badge-error';
                badge.textContent = S.tool_renderer.badges.failed;
            } else if (isCompleted) {
                badge.className = 'task-block-badge task-block-badge-success';
                badge.textContent = S.tool_renderer.badges.done;
            }
        }

        // Parse agent response and usage data
        const { text: agentResponse, usage } = this._parseTaskOutputWithUsage(msg.toolOutput);

        // Inject usage badges into header
        if (usage) {
            const header = taskBlock.querySelector('.task-block-header');
            if (header) {
                header.querySelectorAll('.task-block-tokens, .task-block-duration').forEach(el => el.remove());
                const statusBadge = taskBlock.querySelector('.task-block-badge');
                const tokText = formatTokensBadge(usage.totalTokens);
                const durText = formatDuration(usage.durationMs);
                const insertBefore = (el) => { if (statusBadge) statusBadge.before(el); else header.appendChild(el); };
                if (durText) {
                    const durEl = document.createElement('span');
                    durEl.className = 'task-block-duration';
                    durEl.textContent = durText;
                    insertBefore(durEl);
                }
                if (tokText) {
                    const tokEl = document.createElement('span');
                    tokEl.className = 'task-block-tokens';
                    tokEl.textContent = tokText;
                    insertBefore(tokEl);
                }
            }
        }

        // Update or create preview
        let preview = taskBlock.querySelector('.task-block-preview');
        if (isCompleted && agentResponse && !isError) {
            const strippedResponse = this._stripMarkdownForPreview(agentResponse);
            const previewText = strippedResponse.slice(0, 150).trim();

            if (!preview) {
                const header = taskBlock.querySelector('.task-block-header');
                preview = document.createElement('div');
                preview.className = 'task-block-preview';
                header.after(preview);
            }
            preview.textContent = previewText + (strippedResponse.length > 150 ? '...' : '');
        }

        // Update or create error display
        let errorEl = taskBlock.querySelector('.task-block-error');
        if (isError && msg.toolError) {
            if (!errorEl) {
                const header = taskBlock.querySelector('.task-block-header');
                errorEl = document.createElement('div');
                errorEl.className = 'task-block-error';
                // Insert after header (or after preview if it exists)
                const insertAfter = preview || header;
                insertAfter.after(errorEl);
            }
            errorEl.textContent = msg.toolError;
        } else if (errorEl) {
            errorEl.remove();
        }

        // Update or create full response in body (preserving children)
        let body = taskBlock.querySelector('.task-block-body');
        if (!body) {
            body = document.createElement('div');
            body.className = 'task-block-body';
            taskBlock.appendChild(body);
        }

        let responseContainer = body.querySelector('.task-block-response');
        if (isCompleted && agentResponse) {
            if (!responseContainer) {
                responseContainer = document.createElement('div');
                responseContainer.className = 'task-block-response';
                // Insert at beginning of body (before children)
                body.insertBefore(responseContainer, body.firstChild);
            }
            responseContainer.innerHTML = this._renderMarkdownSafe(agentResponse);
        }

        // Add expand chevron if there's expandable content and it doesn't exist
        const hasExpandableContent = agentResponse || isError || body.querySelector('.task-block-children');
        const header = taskBlock.querySelector('.task-block-header');
        let expandChevron = header?.querySelector('.task-block-expand');
        if (hasExpandableContent && header && !expandChevron) {
            const chevron = document.createElement('span');
            chevron.className = 'task-block-expand';
            chevron.textContent = '›';
            header.appendChild(chevron);
        }
    }

    /**
     * Update a Task block with live progress from task_progress events.
     * Shows current activity, tool count, and duration between header and body.
     */
    updateTaskProgress(taskBlock, progress) {
        // Don't update completed tasks
        if (taskBlock.getAttribute('data-complete') === 'true') return;

        let el = taskBlock.querySelector('.task-progress');
        if (!el) {
            el = document.createElement('div');
            el.className = 'task-progress';
            const header = taskBlock.querySelector('.task-block-header');
            if (header) header.after(el);
            else return;
        }

        // Tool icon based on last tool name
        const toolIcons = {
            Read: 'file', Edit: 'pencil', Write: 'pencil', Bash: 'terminal',
            Grep: 'search', Glob: 'search', WebFetch: 'globe', WebSearch: 'globe',
        };
        const iconName = toolIcons[progress.lastToolName] || 'sparkle';

        const toolsBadge = S.agent_progress.tools_badge.replace('{count}', progress.toolCount);
        const durBadge = formatDuration(progress.durationMs);

        const stalledClass = progress.stalled ? ' task-progress-stalled' : '';
        const stalledText = progress.stalled
            ? `<span class="task-progress-stall-warn">${S.agent_progress.stalled.replace('{duration}', this._formatStallDuration(progress.lastUpdate))}</span>`
            : '';

        el.className = `task-progress${stalledClass}`;
        el.innerHTML = `<span class="task-progress-pulse"></span>`
            + `<span class="task-progress-desc">${escapeHtml(progress.description)}</span>`
            + `<span class="task-progress-badge">${toolsBadge}</span>`
            + (durBadge ? `<span class="task-progress-badge">${durBadge}</span>` : '')
            + stalledText;

        // Also update the header badge to show "Running" with tool count
        const badge = taskBlock.querySelector('.task-block-badge');
        if (badge && badge.classList.contains('task-block-badge-pending')) {
            badge.textContent = progress.stalled ? 'Stalled' : 'Running...';
            if (progress.stalled) {
                badge.className = 'task-block-badge task-block-badge-warn';
            }
        }

        // Update usage badges in header (live tokens + duration)
        const header = taskBlock.querySelector('.task-block-header');
        if (header) {
            header.querySelectorAll('.task-block-tokens, .task-block-duration').forEach(e => e.remove());
            const statusBadge = taskBlock.querySelector('.task-block-badge');
            const insertBefore = (node) => { if (statusBadge) statusBadge.before(node); else header.appendChild(node); };

            if (durBadge) {
                const durEl = document.createElement('span');
                durEl.className = 'task-block-duration';
                durEl.textContent = durBadge;
                insertBefore(durEl);
            }
            const tokText = formatTokensBadge(progress.totalTokens);
            if (tokText) {
                const tokEl = document.createElement('span');
                tokEl.className = 'task-block-tokens';
                tokEl.textContent = tokText;
                insertBefore(tokEl);
            }
        }
    }

    _formatStallDuration(lastUpdate) {
        const elapsed = Math.floor((Date.now() - lastUpdate) / 1000);
        if (elapsed < 60) return `${elapsed}s`;
        return `${Math.floor(elapsed / 60)}m`;
    }

    /**
     * Parse Read tool output to extract line numbers and content
     * Format: "  123→\tcontent" or "  123→content"
     */
    parseReadOutput(output) {
        const lines = [];
        let isTruncated = false;
        let firstLine = null;
        let lastLine = null;

        if (!output) return { lines, isTruncated, firstLine, lastLine };

        // Check for truncation markers
        if (output.includes('(truncated') || output.includes('...truncated')) {
            isTruncated = true;
        }

        // Parse lines: Claude CLI uses either "  NUMBER→CONTENT" (older) or "NUMBER\tCONTENT" (current)
        const linePattern = /^\s*(\d+)(?:→|\t)(.*)$/gm;
        let match;
        while ((match = linePattern.exec(output)) !== null) {
            const num = parseInt(match[1], 10);
            const content = match[2].replace(/^\t/, ''); // Remove leading tab (arrow-format may have → then tab)
            lines.push({ num, content });

            if (firstLine === null || num < firstLine) firstLine = num;
            if (lastLine === null || num > lastLine) lastLine = num;
        }

        return { lines, isTruncated, firstLine, lastLine };
    }

    /**
     * Render a nice todo list for TodoWrite tool
     */
    truncateOutput(text, maxLen = this.maxOutputLength) {
        // Handle non-string outputs (e.g., image arrays from screenshots)
        if (Array.isArray(text)) {
            // Check if it's image content
            const hasImage = text.some(item => item?.type === 'image');
            if (hasImage) {
                return '[Image content]';
            }
            // Otherwise stringify
            text = JSON.stringify(text);
        } else if (typeof text === 'object' && text !== null) {
            text = JSON.stringify(text);
        }

        const trimmed = (text || '').trim();
        if (trimmed.length > maxLen) {
            return trimmed.slice(0, maxLen);
        }
        return trimmed;
    }

    /**
     * Update an existing tool result in the DOM
     * @returns {boolean} true if element was found and updated, false otherwise
     */
    updateToolResult(msg) {
        const toolBlock = $(`#tool-${msg.id}`);
        if (!toolBlock) {
            console.warn(`[ToolRenderer] Tool block not found: #tool-${msg.id} (${msg.toolName})`);
            return false;
        }

        // Detect context for collapse mode (normal/thinking/agent)
        const isThinking = !!toolBlock.closest('.thinking-tool-card');
        const isAgent = !!toolBlock.closest('.task-block-children');
        const context = isAgent ? 'agent' : isThinking ? 'thinking' : 'normal';
        const toolType = msg?.toolName ? getToolCategory(msg.toolName) : 'execute';
        const mode = getToolCollapseMode(context, toolType);
        const expandOpts = { defaultExpanded: mode === 'expanded' };

        // Handle Bash/Shell blocks - re-render completely since structure changes
        if (toolBlock.classList.contains('bash-block')) {
            const newHtml = this.renderBashBlock(msg, expandOpts);
            toolBlock.outerHTML = newHtml;
            // Start tracking if this is a background task
            const newEl = $(`#tool-${msg.id}`);
            if (newEl?.dataset?.taskId) {
                bgTaskTracker.track(newEl.dataset.taskId, msg.toolInput?.command);
            }
            return true;
        }

        // Handle Read blocks - re-render completely
        if (toolBlock.classList.contains('read-block')) {
            const newHtml = this.renderReadBlock(msg, expandOpts);
            toolBlock.outerHTML = newHtml;
            const newEl = $(`#tool-${msg.id}`);
            if (newEl) this.processReadExcalidraw(newEl);
            return true;
        }

        // Handle Grep blocks - re-render completely
        if (toolBlock.classList.contains('grep-block')) {
            const newHtml = this.renderGrepBlock(msg, expandOpts);
            toolBlock.outerHTML = newHtml;
            return true;
        }

        // Handle Glob blocks - re-render completely
        if (toolBlock.classList.contains('glob-block')) {
            const newHtml = this.renderGlobBlock(msg, expandOpts);
            toolBlock.outerHTML = newHtml;
            return true;
        }

        // Handle Write blocks - re-render completely
        if (toolBlock.classList.contains('write-block')) {
            const newHtml = this.renderWriteBlock(msg, expandOpts);
            toolBlock.outerHTML = newHtml;
            // Process chart/excalidraw rendering after DOM replacement
            const newEl = $(`#tool-${msg.id}`);
            if (newEl) { this.processWriteCharts(newEl); this.processWriteExcalidraw(newEl); }
            return true;
        }

        // Handle WebFetch/WebSearch blocks - re-render completely
        if (toolBlock.classList.contains('webfetch-block')) {
            const newHtml = this.renderWebFetchBlock(msg, expandOpts);
            toolBlock.outerHTML = newHtml;
            return true;
        }

        // Handle EnterPlanMode blocks - re-render completely
        if (toolBlock.classList.contains('plan-mode-block')) {
            toolBlock.outerHTML = this.renderEnterPlanBlock(msg);
            return true;
        }

        // Handle Task blocks - update in place to preserve children
        if (toolBlock.classList.contains('task-block')) {
            this._updateTaskBlockResult(toolBlock, msg);
            return true;
        }

        // Handle Skill blocks - re-render completely
        if (toolBlock.classList.contains('skill-block')) {
            toolBlock.outerHTML = this.renderSkillBlock(msg);
            return true;
        }

        // Handle TaskStop blocks - re-render (check before .tob since tob-stop also has .tob)
        if (toolBlock.classList.contains('tob-stop')) {
            toolBlock.outerHTML = this.renderTaskStopBlock(msg);
            return true;
        }

        // Handle TaskOutput blocks - re-render completely
        if (toolBlock.classList.contains('tob')) {
            toolBlock.outerHTML = this.renderTaskOutputBlock(msg);
            return true;
        }

        // Handle Edit tool diff blocks - re-render completely for correct line numbers
        if (toolBlock.classList.contains('edit-tool-block')) {
            const diffHtml = this.renderEditDiff(msg.toolInput, msg.toolOutput, msg.toolId, msg.startLine);
            if (diffHtml) {
                const statusClass = msg.toolError ? 'edit-status-error' : 'edit-status-success';
                const statusText = msg.toolError ? 'Failed: ' + escapeHtml(msg.toolError) : 'Applied';
                toolBlock.innerHTML = `${diffHtml}\n<div class="edit-status ${statusClass}">${statusText}</div>`;
            } else if (msg.toolError) {
                const editStatus = toolBlock.querySelector('.edit-status');
                if (editStatus) {
                    editStatus.className = 'edit-status edit-status-error';
                    editStatus.textContent = 'Failed: ' + msg.toolError;
                }
            }
            return true;
        }

        // Handle regular tool blocks
        const outputEl = toolBlock.querySelector('.tool-output');
        if (outputEl) {
            outputEl.className = `tool-output ${msg.toolError ? 'error' : ''}`;
            outputEl.textContent = this.truncateOutput(msg.toolOutput || msg.toolError || S.tool_renderer.badges.done);
        }
        return true;
    }

    /**
     * Process chart rendering in Write tool blocks
     * Finds .write-chart-pending elements, fetches SVG from API, replaces loading state
     */
    processWriteCharts(container) {
        if (!container) return;
        const pending = container.querySelectorAll('.write-chart-pending');
        if (pending.length === 0) return;

        pending.forEach(el => {
            el.classList.remove('write-chart-pending');

            const encoded = el.dataset.chartJson;
            if (!encoded) return;

            let jsonText;
            try {
                jsonText = decodeURIComponent(escape(atob(encoded)));
            } catch {
                el.innerHTML = `<div class="chart-inline-error">${S.tool_renderer.errors.decode_chart}</div>`;
                return;
            }

            if (window.INSTANCE_CONFIG?.renderers_enabled !== true) {
                el.innerHTML = `<div class="chart-inline-error">${S.tool_renderer.errors.chart_disabled}</div>`;
                return;
            }

            fetch('/api/chart/render', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: jsonText,
            })
            .then(resp => {
                if (!resp.ok) throw new Error(`Render failed: ${resp.status}`);
                return resp.text();
            })
            .then(svg => {
                el.innerHTML = `<div class="chart-inline-rendered"><div class="chart-inline-svg">${sanitizeSvg(svg)}</div></div>`;
            })
            .catch(err => {
                console.error('Write chart render error:', err);
                el.innerHTML = `<div class="chart-inline-error"><span>Chart render error: ${escapeHtml(err.message)}</span></div>`;
            });
        });
    }

    /**
     * Post-DOM rendering for excalidraw Write blocks — sends JSON to /api/excalidraw/render
     */
    processWriteExcalidraw(container) {
        if (!container) return;
        const pending = container.querySelectorAll('.write-excalidraw-pending');
        if (pending.length === 0) return;

        pending.forEach(el => {
            el.classList.remove('write-excalidraw-pending');

            const encoded = el.dataset.excalidrawJson;
            if (!encoded) return;

            let jsonText;
            try {
                jsonText = decodeURIComponent(escape(atob(encoded)));
            } catch {
                el.innerHTML = `<div class="excalidraw-inline-error">${S.tool_renderer.errors.decode_diagram}</div>`;
                return;
            }

            if (window.INSTANCE_CONFIG?.renderers_enabled !== true) {
                el.innerHTML = `<div class="excalidraw-inline-error">${S.tool_renderer.errors.diagram_disabled}</div>`;
                return;
            }

            fetch('/api/excalidraw/render?dark=true', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: jsonText,
            })
            .then(resp => {
                if (!resp.ok) throw new Error(`Render failed: ${resp.status}`);
                return resp.text();
            })
            .then(svg => {
                const fp = el.closest('.write-excalidraw')?.dataset?.filePath || '';
                el.innerHTML = `<div class="excalidraw-inline-rendered"><div class="excalidraw-inline-svg excalidraw-clickable" data-file="${escapeAttr(fp)}" onclick="window.app?.previewFile(this.dataset.file)">${sanitizeSvg(svg)}</div></div>`;
            })
            .catch(err => {
                console.error('Write excalidraw render error:', err);
                el.innerHTML = `<div class="excalidraw-inline-error"><span>Diagram render error: ${escapeHtml(err.message)}</span></div>`;
            });
        });
    }

    /**
     * Post-DOM rendering for excalidraw Read blocks — fetches SVG from /api/file-raw
     */
    processReadExcalidraw(container) {
        if (!container) return;
        const targets = container.querySelectorAll('.read-excalidraw-loading');
        if (targets.length === 0) return;

        targets.forEach(loading => {
            const svgDiv = loading.nextElementSibling;
            if (!svgDiv?.dataset?.src) return;

            if (window.INSTANCE_CONFIG?.renderers_enabled !== true) {
                loading.innerHTML = `<div class="excalidraw-inline-error">${S.tool_renderer.errors.diagram_disabled}</div>`;
                return;
            }

            fetch(svgDiv.dataset.src)
            .then(resp => {
                if (!resp.ok) throw new Error(`Render failed: ${resp.status}`);
                return resp.text();
            })
            .then(svg => {
                const fp = svgDiv.closest('.read-excalidraw')?.dataset?.filePath || '';
                svgDiv.innerHTML = `<div class="excalidraw-inline-svg excalidraw-clickable" data-file="${escapeAttr(fp)}" onclick="window.app?.previewFile(this.dataset.file)">${sanitizeSvg(svg)}</div>`;
                svgDiv.style.display = '';
                loading.remove();
            })
            .catch(err => {
                console.error('Read excalidraw render error:', err);
                loading.innerHTML = `<div class="excalidraw-inline-error"><span>Diagram render error: ${escapeHtml(err.message)}</span></div>`;
            });
        });
    }

    /**
     * Toggle tool block collapsed state
     */
    toggleTool(msgId) {
        const toolBlock = $(`#tool-${msgId}`)?.querySelector('.tool-block') || $(`#tool-${msgId}`);
        if (toolBlock) {
            toolBlock.classList.toggle('collapsed');
        }
    }

    /**
     * Render tool output with expansion handling
     */
    renderToolOutput(content, isCompleted = false, threshold = 5) {
        if (!content) return isCompleted ? S.tool_renderer.badges.done : '';

        const lines = content.split('\n');
        if (lines.length <= threshold) {
            return escapeHtml(content);
        }

        // Show first few lines with expand option
        const preview = lines.slice(0, threshold).join('\n');
        return `<div class="tool-output-preview">${escapeHtml(preview)}</div>
<div class="tool-output-full hidden">${escapeHtml(content)}</div>
<button class="tool-output-expand" onclick="this.previousElementSibling.classList.toggle('hidden'); this.previousElementSibling.previousElementSibling.classList.toggle('hidden'); this.textContent = this.textContent === 'Show more' ? 'Show less' : 'Show more'">Show more</button>`;
    }

    /**
     * Render a compact styled tool block for thinking messages.
     * Each tool type gets a distinct visual treatment.
     * @param {Object} tool - Tool object with toolName, toolInput, toolOutput, toolId, toolCompleted
     * @returns {string} HTML for the thinking tool block
     */
    _parseBashResult(cmd, output) {
        const lines = output.split('\n').filter(l => l.trim());

        // ls command - show file count or file names
        if (cmd.match(/^ls\b/)) {
            if (lines.length <= 3) {
                // Few files - show names
                const names = lines.map(l => l.split(/\s+/).pop()).filter(Boolean);
                return `<span class="ta-result">${names.join(', ')}</span>`;
            }
            return `<span class="ta-result">${lines.length} items</span>`;
        }

        // git status - summarize
        if (cmd.match(/^git\s+status/)) {
            const modified = (output.match(/modified:/g) || []).length;
            const added = (output.match(/new file:/g) || []).length;
            const deleted = (output.match(/deleted:/g) || []).length;
            if (modified + added + deleted === 0) {
                return '<span class="ta-muted">clean</span>';
            }
            const parts = [];
            if (modified) parts.push(`${modified} modified`);
            if (added) parts.push(`${added} new`);
            if (deleted) parts.push(`${deleted} deleted`);
            return `<span class="ta-result">${parts.join(', ')}</span>`;
        }

        // git diff --stat
        if (cmd.match(/^git\s+diff/)) {
            const statMatch = output.match(/(\d+) files? changed/);
            if (statMatch) {
                return `<span class="ta-result">${statMatch[0]}</span>`;
            }
        }

        // Default: line count
        return `<span class="ta-result">${lines.length} line${lines.length !== 1 ? 's' : ''}</span>`;
    }

    /** Bash/Shell - terminal style with command and output preview */
}


// Mix block-mode and thinking-mode methods into ToolRenderer.prototype.
Object.assign(ToolRenderer.prototype, blockMethods, thinkingMethods);
