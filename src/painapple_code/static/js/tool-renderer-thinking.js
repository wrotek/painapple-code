/**
 * Tool Renderer — Thinking-mode methods
 *
 * Compact tool renderers used inside thinking message cards and activity logs.
 * Mixed into ToolRenderer.prototype by tool-renderer.js.
 */

import S from './strings.js';
import { escapeHtml, escapeAttr } from './utils.js';
import { cleanToolError, getLangForExt } from './tool-renderer.js';

export const thinkingMethods = {
    /**
     * Render a compact styled tool block for thinking messages.
     * Each tool type gets a distinct visual treatment.
     * @param {Object} tool - Tool object with toolName, toolInput, toolOutput, toolId, toolCompleted
     * @returns {string} HTML for the thinking tool block
     */
    renderThinkingTool(tool) {
        const { toolName } = tool;

        switch (toolName) {
            case 'Bash':
            case 'Shell':
                return this._renderThinkingBash(tool);
            case 'Read':
                return this._renderThinkingRead(tool);
            case 'Write':
                return this._renderThinkingWrite(tool);
            case 'Edit':
                return this._renderThinkingEdit(tool);
            case 'Grep':
                return this._renderThinkingGrep(tool);
            case 'Glob':
                return this._renderThinkingGlob(tool);
            case 'WebFetch':
            case 'WebSearch':
                return this._renderThinkingWeb(tool);
            case 'Task':
                return this._renderThinkingTask(tool);
            case 'Skill':
                return this._renderThinkingSkill(tool);
            case 'EnterPlanMode':
                return this._renderThinkingPlanMode(tool);
            case 'LSP':
                return this._renderThinkingLSP(tool);
            default:
                return this._renderThinkingDefault(tool);
        }
    },

    /**
     * Render an ultra-compact single-line tool entry for activity log.
     * Shows: icon + description + result summary
     * @param {Object} tool - Tool object
     * @returns {string} HTML for activity log entry
     */
    renderThinkingToolCompact(tool) {
        const { toolName, toolInput, toolOutput, toolCompleted, toolId } = tool;
        const isComplete = toolCompleted || !!toolOutput;
        const output = toolOutput || '';

        let icon = '', desc = '', result = '', colorClass = '';

        switch (toolName) {
            case 'Bash':
            case 'Shell': {
                icon = '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>';
                const cmd = toolInput?.command || '';
                const cmdEscaped = JSON.stringify(cmd).replace(/"/g, '&quot;');
                // Simplify command display
                const cmdShort = cmd.length > 50 ? cmd.slice(0, 47) + '...' : cmd;
                desc = `<code class="ta-bash-cmd" onclick="event.stopPropagation(); navigator.clipboard.writeText(${cmdEscaped}); this.classList.add('copied'); setTimeout(() => this.classList.remove('copied'), 600)" data-tooltip="Click to copy">${escapeHtml(cmdShort)}</code>`;
                // Smart result parsing
                if (output) {
                    result = this._parseBashResult(cmd, output);
                } else if (!isComplete) {
                    result = '<span class="ta-pending">running...</span>';
                }
                break;
            }
            case 'Read': {
                icon = '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>';
                colorClass = 'ta-blue';
                const filePath = toolInput?.file_path || '';
                const filename = filePath.split('/').pop() || '';
                const previewOpts = JSON.stringify({}).replace(/"/g, '&quot;');
                desc = `<span class="ta-file">${escapeHtml(filename)}</span>`;
                if (output) {
                    const lineCount = (output.match(/^\s*\d+(?:→|\t)/gm) || []).length;
                    result = `<span class="ta-result">${lineCount} lines</span>
                        <button class="ta-action" data-file="${escapeAttr(filePath)}" onclick="window.app?.previewFile(this.dataset.file, ${previewOpts})" data-tooltip="Preview">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                        </button>`;
                } else if (!isComplete) {
                    result = '<span class="ta-pending">reading...</span>';
                }
                break;
            }
            case 'Write': {
                icon = '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/>';
                colorClass = 'ta-green';
                const filename = toolInput?.file_path?.split('/').pop() || '';
                const lineCount = (toolInput?.content || '').split('\n').length;
                desc = `<span class="ta-file">${escapeHtml(filename)}</span>`;
                result = isComplete
                    ? `<span class="ta-success">created (${lineCount} lines)</span>`
                    : '<span class="ta-pending">writing...</span>';
                break;
            }
            case 'Grep': {
                icon = '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>';
                colorClass = 'ta-purple';
                const pattern = toolInput?.pattern || '';
                const patternShort = pattern.length > 25 ? pattern.slice(0, 22) + '...' : pattern;
                desc = `<code>/${escapeHtml(patternShort)}/</code>`;
                if (output) {
                    const matches = output.split('\n').filter(l => {
                        const t = l.trim();
                        return t && !/^\[Showing results with pagination/i.test(t);
                    }).length;
                    result = matches > 0
                        ? `<span class="ta-success">${matches} match${matches !== 1 ? 'es' : ''}</span>`
                        : '<span class="ta-muted">no matches</span>';
                } else if (!isComplete) {
                    result = '<span class="ta-pending">searching...</span>';
                }
                break;
            }
            case 'Glob': {
                icon = '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>';
                colorClass = 'ta-yellow';
                const pattern = toolInput?.pattern || '';
                desc = `<code>${escapeHtml(pattern)}</code>`;
                if (output) {
                    const files = output.split('\n').filter(l => l.trim()).length;
                    result = files > 0
                        ? `<span class="ta-success">${files} file${files !== 1 ? 's' : ''}</span>`
                        : '<span class="ta-muted">none found</span>';
                } else if (!isComplete) {
                    result = '<span class="ta-pending">searching...</span>';
                }
                break;
            }
            case 'WebFetch':
            case 'WebSearch': {
                icon = toolName === 'WebSearch'
                    ? '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>'
                    : '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>';
                colorClass = 'ta-cyan';
                const url = toolInput?.url || toolInput?.query || '';
                let display = url;
                if (toolName === 'WebFetch' && url.startsWith('http')) {
                    try { display = new URL(url).hostname; } catch { }
                }
                desc = `<span class="ta-url">${escapeHtml(display.slice(0, 40))}</span>`;
                result = isComplete ? '<span class="ta-success">✓</span>' : '<span class="ta-pending">fetching...</span>';
                break;
            }
            case 'Task': {
                icon = '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>';
                colorClass = 'ta-purple';
                const taskDesc = toolInput?.description || 'task';
                desc = `<span class="ta-desc">${escapeHtml(taskDesc)}</span>`;
                result = isComplete ? '<span class="ta-success">done</span>' : '<span class="ta-pending">running...</span>';
                break;
            }
            case 'Skill': {
                // Lightning bolt icon for skills (zap icon)
                icon = '<path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>';
                colorClass = 'ta-cyan';
                const sn = toolInput?.skill || 'skill';
                desc = `<span class="ta-skill">/${escapeHtml(sn)}</span>`;
                result = isComplete ? '<span class="ta-success">done</span>' : '<span class="ta-pending">running...</span>';
                break;
            }
            case 'LSP': {
                icon = '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>';
                colorClass = 'ta-blue';
                const op = toolInput?.operation || 'query';
                const file = toolInput?.filePath?.split('/').pop() || '';
                desc = `<span class="ta-op">${escapeHtml(op)}</span>${file ? ` <span class="ta-file">${escapeHtml(file)}</span>` : ''}`;
                result = isComplete ? '<span class="ta-success">✓</span>' : '<span class="ta-pending">...</span>';
                break;
            }
            case 'TodoWrite': {
                icon = '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>';
                colorClass = 'ta-green';
                const todos = toolInput?.todos || [];
                const total = todos.length;
                const done = todos.filter(t => t.status === 'completed').length;
                const inProgress = todos.filter(t => t.status === 'in_progress').length;
                // Show current task if one is in progress
                const current = todos.find(t => t.status === 'in_progress');
                if (current?.activeForm) {
                    desc = `<span class="ta-desc">${escapeHtml(current.activeForm)}</span>`;
                } else if (total > 0) {
                    desc = `<span class="ta-desc">${total} task${total !== 1 ? 's' : ''}</span>`;
                } else {
                    desc = '<span class="ta-desc">todos</span>';
                }
                // Show status counts
                const parts = [];
                if (done > 0) parts.push(`${done} done`);
                if (inProgress > 0) parts.push(`${inProgress} active`);
                result = parts.length > 0
                    ? `<span class="ta-result">${parts.join(', ')}</span>`
                    : '<span class="ta-success">✓</span>';
                break;
            }
            case 'AskUserQuestion': {
                icon = '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>';
                colorClass = 'ta-yellow';
                const questions = toolInput?.questions || [];
                if (questions.length > 0 && questions[0].question) {
                    const q = questions[0].question;
                    desc = `<span class="ta-desc">${escapeHtml(q.slice(0, 50))}${q.length > 50 ? '...' : ''}</span>`;
                } else {
                    desc = '<span class="ta-desc">question</span>';
                }
                result = isComplete ? '<span class="ta-success">answered</span>' : '<span class="ta-pending">waiting...</span>';
                break;
            }
            case 'TaskOutput': {
                const tid = toolInput?.task_id || '';
                // Try XML first (shell tasks), then agent stream
                const xmlP = this._parseTaskOutputXml(output);
                if (xmlP.status || xmlP.exit_code) {
                    icon = '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>';
                    colorClass = 'ta-orange';
                    desc = `<span class="ta-desc">${escapeHtml(tid)}</span>`;
                    const ec = xmlP.exit_code;
                    if (xmlP.status === 'completed' && ec === '0') {
                        result = '<span class="ta-success">exit 0</span>';
                    } else if (ec && ec !== '0') {
                        result = `<span class="ta-error">exit ${ec}</span>`;
                    } else {
                        result = `<span class="ta-success">${escapeHtml(xmlP.status || 'done')}</span>`;
                    }
                } else {
                    icon = '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>';
                    colorClass = 'ta-purple';
                    const stream = this._parseAgentStream(output);
                    desc = stream.slug
                        ? `<span class="ta-desc">${escapeHtml(stream.slug)}</span>`
                        : `<span class="ta-desc">${escapeHtml(tid)}</span>`;
                    if (isComplete) {
                        const toolCount = Object.values(stream.toolCounts).reduce((a, b) => a + b, 0);
                        const parts = [];
                        if (stream.texts.length > 0) parts.push('done');
                        if (toolCount > 0) parts.push(`${toolCount} tools`);
                        if (stream.isTruncated) parts.push('truncated');
                        result = parts.length > 0
                            ? `<span class="${stream.isTruncated ? 'ta-muted' : 'ta-success'}">${parts.join(', ')}</span>`
                            : '<span class="ta-success">done</span>';
                    } else {
                        result = '<span class="ta-pending">waiting...</span>';
                    }
                }
                break;
            }
            case 'TaskStop': {
                icon = '<rect x="3" y="3" width="18" height="18" rx="2"/>';
                const stopTid = toolInput?.task_id || '';
                desc = `<span class="ta-desc">${escapeHtml(stopTid)}</span>`;
                if (isComplete) {
                    // Check if "already completed" (not a real stop)
                    const stopClean = cleanToolError(tool.toolError || output || '');
                    const nrm = stopClean.text.match(/not running\s*\(status:\s*(\w+)\)/i);
                    if (nrm && nrm[1].toLowerCase() === 'completed') {
                        colorClass = 'ta-green';
                        result = '<span class="ta-success">already done</span>';
                    } else {
                        colorClass = 'ta-error';
                        result = '<span class="ta-error">stopped</span>';
                    }
                } else {
                    colorClass = 'ta-error';
                    result = '<span class="ta-pending">stopping...</span>';
                }
                break;
            }
            case 'EnterPlanMode': {
                icon = '<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/>';
                colorClass = 'ta-green';
                desc = '<span>Plan Mode</span>';
                result = isComplete ? '<span class="ta-success">active</span>' : '<span class="ta-pending">entering...</span>';
                break;
            }
            case 'NotebookEdit': {
                icon = '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M9 21V9"/>';
                colorClass = 'ta-orange';
                const notebook = toolInput?.notebook_path?.split('/').pop() || '';
                const mode = toolInput?.edit_mode || 'edit';
                desc = `<span class="ta-file">${escapeHtml(notebook)}</span> <span class="ta-op">${mode}</span>`;
                result = isComplete ? '<span class="ta-success">✓</span>' : '<span class="ta-pending">...</span>';
                break;
            }
            default: {
                icon = '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>';
                desc = `<span class="ta-name">${escapeHtml(toolName)}</span>`;
                result = isComplete ? '<span class="ta-success">✓</span>' : '<span class="ta-pending">...</span>';
            }
        }

        return `<div class="ta-item ${colorClass}" id="ta-${toolId}">
            <svg class="ta-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${icon}</svg>
            ${desc}
            ${result}
        </div>`;
    },

    /**
     * Parse Bash output into human-friendly result summary
     */
    /** Bash/Shell - terminal style with command and output preview */
    _renderThinkingBash(tool) {
        // Use the main bash block renderer for consistent styling
        const msg = {
            id: tool.toolId,
            toolInput: tool.toolInput,
            toolOutput: tool.toolOutput,
            toolError: tool.toolError,
            toolCompleted: tool.toolCompleted || !!tool.toolOutput
        };
        return `<div class="thinking-tool" id="thinking-tool-${tool.toolId}">${this.renderBashBlock(msg)}</div>`;
    },

    /** Read - file icon with filename, line range, language, and code preview */
    _renderThinkingRead(tool) {
        const filePath = tool.toolInput?.file_path || '';
        const filename = filePath.split('/').pop();
        const output = tool.toolOutput || '';
        const isComplete = tool.toolCompleted || !!output;

        // Detect language from extension
        const ext = filename.split('.').pop()?.toLowerCase() || '';
        const { hlLang } = getLangForExt(ext, filename);
        const isImage = hlLang === 'image';
        const langDisplay = isImage ? 'image' : (ext || '');

        // Image file — show thumbnail instead of code
        if (isImage) {
            const rawUrl = `/api/file-raw?path=${encodeURIComponent(filePath)}`;
            const statusIcon = isComplete
                ? '<span class="tt-status tt-ok">✓</span>'
                : '<span class="tt-status tt-pending">...</span>';
            return `<div class="thinking-tool tt-read" id="thinking-tool-${tool.toolId}">
            <div class="tt-header">
                <span class="tt-icon tt-icon-purple">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
                        <rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>
                    </svg>
                </span>
                <span class="tt-filename">${escapeHtml(filename)}</span>
                <span class="tt-badge tt-badge-lang">image</span>${statusIcon}
            </div>
            <div class="tt-image-thumb"><img src="${rawUrl}" alt="${escapeHtml(filename)}" loading="lazy" /></div>
        </div>`;
        }

        // Parse lines from output — Claude CLI uses either "  123→content" or "123\tcontent"
        const lines = [];
        let firstLine = null, lastLine = null;
        if (output) {
            const linePattern = /^\s*(\d+)(?:→|\t)\t?(.*)$/gm;
            let match;
            while ((match = linePattern.exec(output)) !== null) {
                const num = parseInt(match[1], 10);
                const content = match[2];
                if (firstLine === null) firstLine = num;
                lastLine = num;
                if (lines.length < 8) { // Show up to 8 lines
                    lines.push({ num, content });
                }
            }
        }

        const lineInfo = firstLine && lastLine
            ? (firstLine === lastLine ? `L${firstLine}` : `L${firstLine}-${lastLine}`)
            : '';

        const langBadge = langDisplay ? `<span class="tt-badge tt-badge-lang">${langDisplay}</span>` : '';
        const lineBadge = lineInfo ? `<span class="tt-badge tt-badge-lines">${lineInfo}</span>` : '';
        const statusIcon = isComplete
            ? '<span class="tt-status tt-ok">✓</span>'
            : '<span class="tt-status tt-pending">...</span>';

        // Build code preview
        let codeHtml = '';
        if (lines.length > 0) {
            const codeLines = lines.map(({ num, content }) => {
                let highlighted = escapeHtml(content);
                if (window.hljs && hlLang !== 'plaintext' && hlLang !== 'image') {
                    try {
                        highlighted = window.hljs.highlight(content || ' ', { language: hlLang, ignoreIllegals: true }).value;
                    } catch { }
                }
                return `<div class="tt-code-line"><span class="tt-line-num">${num}</span><span class="tt-line-content">${highlighted}</span></div>`;
            }).join('');
            const totalLines = lastLine - firstLine + 1;
            const moreLines = totalLines > 8 ? `<div class="tt-more">...${totalLines - 8} more lines</div>` : '';
            codeHtml = `<div class="tt-code">${codeLines}${moreLines}</div>`;
        } else if (!isComplete) {
            codeHtml = '<div class="tt-code tt-running">Reading...</div>';
        }

        return `<div class="thinking-tool tt-read" id="thinking-tool-${tool.toolId}">
            <div class="tt-header">
                <span class="tt-icon tt-icon-blue">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                        <polyline points="14 2 14 8 20 8"/>
                    </svg>
                </span>
                <span class="tt-filename">${escapeHtml(filename)}</span>
                ${lineBadge}${langBadge}${statusIcon}
            </div>
            ${codeHtml}
        </div>`;
    },

    /** Write - new file icon with content preview */
    _renderThinkingWrite(tool) {
        const filePath = tool.toolInput?.file_path || '';
        const filename = filePath.split('/').pop();
        const content = tool.toolInput?.content || '';
        const isComplete = tool.toolCompleted || !!tool.toolOutput;

        // Detect language from extension
        const ext = filename.split('.').pop()?.toLowerCase() || '';
        const { hlLang } = getLangForExt(ext, filename);
        const isImage = hlLang === 'image';

        const statusBadge = isComplete
            ? '<span class="tt-badge tt-badge-success">Created</span>'
            : '<span class="tt-badge tt-badge-pending">Creating...</span>';

        // Image file — show thumbnail
        if (isImage) {
            const rawUrl = `/api/file-raw?path=${encodeURIComponent(filePath)}`;
            return `<div class="thinking-tool tt-write" id="thinking-tool-${tool.toolId}">
            <div class="tt-header">
                <span class="tt-icon tt-icon-purple">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
                        <rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>
                    </svg>
                </span>
                <span class="tt-filename">${escapeHtml(filename)}</span>
                <span class="tt-badge tt-badge-lang">image</span>
                ${statusBadge}
            </div>
            <div class="tt-image-thumb"><img src="${rawUrl}" alt="${escapeHtml(filename)}" loading="lazy" /></div>
        </div>`;
        }

        // Show first 8 lines of content
        const lines = content.split('\n').slice(0, 8);
        const totalLines = content.split('\n').length;
        let codeHtml = '';
        if (lines.length > 0) {
            const codeLines = lines.map((line, idx) => {
                let highlighted = escapeHtml(line);
                if (window.hljs && hlLang !== 'plaintext' && hlLang !== 'image') {
                    try {
                        highlighted = window.hljs.highlight(line || ' ', { language: hlLang, ignoreIllegals: true }).value;
                    } catch { }
                }
                return `<div class="tt-code-line tt-added"><span class="tt-line-num">${idx + 1}</span><span class="tt-line-content">${highlighted}</span></div>`;
            }).join('');
            const moreLines = totalLines > 8 ? `<div class="tt-more">...${totalLines - 8} more lines</div>` : '';
            codeHtml = `<div class="tt-code">${codeLines}${moreLines}</div>`;
        }

        return `<div class="thinking-tool tt-write" id="thinking-tool-${tool.toolId}">
            <div class="tt-header">
                <span class="tt-icon tt-icon-green">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                        <polyline points="14 2 14 8 20 8"/>
                        <line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/>
                    </svg>
                </span>
                <span class="tt-filename">${escapeHtml(filename)}</span>
                <span class="tt-badge tt-badge-muted">${totalLines} lines</span>
                ${statusBadge}
            </div>
            ${codeHtml}
        </div>`;
    },

    /** Edit - pencil icon with diff stats */
    _renderThinkingEdit(tool) {
        const filePath = tool.toolInput?.file_path || '';
        const filename = filePath.split('/').pop();
        const oldStr = tool.toolInput?.old_string || '';
        const newStr = tool.toolInput?.new_string || '';
        const isComplete = tool.toolCompleted || !!tool.toolOutput;

        // Calculate simple diff stats
        const oldLines = oldStr.split('\n').length;
        const newLines = newStr.split('\n').length;
        const added = Math.max(0, newLines - oldLines);
        const removed = Math.max(0, oldLines - newLines);
        const statsBadge = `<span class="tt-badge tt-badge-diff"><span class="tt-plus">+${added}</span> <span class="tt-minus">-${removed}</span></span>`;

        const statusIcon = isComplete
            ? '<span class="tt-status tt-ok">✓</span>'
            : '<span class="tt-status tt-pending">...</span>';

        return `<div class="thinking-tool tt-edit" id="thinking-tool-${tool.toolId}">
            <div class="tt-header">
                <span class="tt-icon tt-icon-orange">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
                        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                    </svg>
                </span>
                <span class="tt-filename">${escapeHtml(filename)}</span>
                ${statsBadge}${statusIcon}
            </div>
        </div>`;
    },

    /** Grep - search icon with pattern, match count, and file list */
    _renderThinkingGrep(tool) {
        const pattern = tool.toolInput?.pattern || '';
        const output = tool.toolOutput || '';
        const isComplete = tool.toolCompleted || !!output;
        const patternPreview = pattern.length > 40 ? pattern.slice(0, 37) + '...' : pattern;

        // Parse output - could be file paths or file:line:content
        // Filter out metadata lines like pagination info
        const lines = output ? output.split('\n').filter(l => {
            const trimmed = l.trim();
            if (!trimmed) return false;
            if (/^\[Showing results with pagination/i.test(trimmed)) return false;
            return true;
        }) : [];
        const matches = lines.length;
        const matchBadge = isComplete
            ? `<span class="tt-badge ${matches > 0 ? 'tt-badge-success' : 'tt-badge-muted'}">${matches} match${matches !== 1 ? 'es' : ''}</span>`
            : '<span class="tt-badge tt-badge-pending">searching...</span>';

        // Build file list preview (show up to 6 results)
        let resultsHtml = '';
        if (lines.length > 0) {
            const previewLines = lines.slice(0, 6).map(line => {
                // Try to parse as file:line:content or just file path
                const match = line.match(/^([^:]+):(\d+):(.*)$/) || line.match(/^([^:]+):(\d+)$/) || [null, line];
                const file = match[1]?.split('/').pop() || line;
                const lineNum = match[2] || '';
                const content = match[3] || '';

                if (content) {
                    return `<div class="tt-result-line"><span class="tt-result-file">${escapeHtml(file)}</span><span class="tt-result-linenum">:${lineNum}</span><span class="tt-result-content">${escapeHtml(content.slice(0, 60))}</span></div>`;
                } else if (lineNum) {
                    return `<div class="tt-result-line"><span class="tt-result-file">${escapeHtml(file)}</span><span class="tt-result-linenum">:${lineNum}</span></div>`;
                } else {
                    return `<div class="tt-result-line"><span class="tt-result-file">${escapeHtml(file)}</span></div>`;
                }
            }).join('');
            const moreCount = lines.length > 6 ? `<div class="tt-more">...${lines.length - 6} more</div>` : '';
            resultsHtml = `<div class="tt-results">${previewLines}${moreCount}</div>`;
        } else if (!isComplete) {
            resultsHtml = `<div class="tt-results tt-running">${S.tool_renderer.status.searching}</div>`;
        }

        return `<div class="thinking-tool tt-grep" id="thinking-tool-${tool.toolId}">
            <div class="tt-header">
                <span class="tt-icon tt-icon-purple">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
                        <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                    </svg>
                </span>
                <code class="tt-pattern">/${escapeHtml(patternPreview)}/</code>
                ${matchBadge}
            </div>
            ${resultsHtml}
        </div>`;
    },

    /** Glob - folder icon with pattern, file count, and file list */
    _renderThinkingGlob(tool) {
        const pattern = tool.toolInput?.pattern || '';
        const basePath = tool.toolInput?.path || '';
        const output = tool.toolOutput || '';
        const isComplete = tool.toolCompleted || !!output;

        // Parse file list
        let files = output ? output.split('\n').filter(l => l.trim()) : [];

        // Convert absolute paths to relative paths
        if (files.length > 0 && files[0].startsWith('/')) {
            let commonPrefix = '';
            if (basePath && basePath.startsWith('/')) {
                commonPrefix = basePath.endsWith('/') ? basePath : basePath + '/';
            } else {
                const firstFile = files[0];
                const lastSlash = firstFile.lastIndexOf('/');
                if (lastSlash > 0) {
                    commonPrefix = firstFile.slice(0, lastSlash + 1);
                    for (const file of files) {
                        while (commonPrefix && !file.startsWith(commonPrefix)) {
                            const prevSlash = commonPrefix.lastIndexOf('/', commonPrefix.length - 2);
                            commonPrefix = prevSlash > 0 ? commonPrefix.slice(0, prevSlash + 1) : '';
                        }
                    }
                }
            }
            if (commonPrefix) {
                files = files.map(f => f.startsWith(commonPrefix) ? f.slice(commonPrefix.length) : f);
            }
        }

        const fileCount = files.length;
        const filesBadge = isComplete
            ? `<span class="tt-badge ${fileCount > 0 ? 'tt-badge-success' : 'tt-badge-muted'}">${fileCount} file${fileCount !== 1 ? 's' : ''}</span>`
            : '<span class="tt-badge tt-badge-pending">searching...</span>';

        // Build file list preview (show up to 6 files)
        let filesHtml = '';
        if (files.length > 0) {
            const fileLines = files.slice(0, 6).map(file => {
                return `<div class="tt-result-line"><span class="tt-result-file">${escapeHtml(file)}</span></div>`;
            }).join('');
            const moreCount = files.length > 6 ? `<div class="tt-more">...${files.length - 6} more</div>` : '';
            filesHtml = `<div class="tt-results">${fileLines}${moreCount}</div>`;
        } else if (!isComplete) {
            filesHtml = `<div class="tt-results tt-running">${S.tool_renderer.status.searching}</div>`;
        }

        return `<div class="thinking-tool tt-glob" id="thinking-tool-${tool.toolId}">
            <div class="tt-header">
                <span class="tt-icon tt-icon-yellow">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
                        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                    </svg>
                </span>
                <code class="tt-pattern">${escapeHtml(pattern)}</code>
                ${filesBadge}
            </div>
            ${filesHtml}
        </div>`;
    },

    /** WebFetch/WebSearch - link icon with domain */
    _renderThinkingWeb(tool) {
        const url = tool.toolInput?.url || tool.toolInput?.query || '';
        const isComplete = tool.toolCompleted || !!tool.toolOutput;
        let display = url;

        // Extract domain for WebFetch
        if (tool.toolName === 'WebFetch' && url.startsWith('http')) {
            try { display = new URL(url).hostname; } catch { }
        } else if (tool.toolName === 'WebSearch') {
            display = `"${url.length > 40 ? url.slice(0, 37) + '...' : url}"`;
        }

        const statusIcon = isComplete
            ? '<span class="tt-status tt-ok">✓</span>'
            : '<span class="tt-status tt-pending">...</span>';

        const icon = tool.toolName === 'WebSearch'
            ? '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>'
            : '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>';

        return `<div class="thinking-tool tt-web" id="thinking-tool-${tool.toolId}">
            <div class="tt-header">
                <span class="tt-icon tt-icon-cyan">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">${icon}</svg>
                </span>
                <span class="tt-url">${escapeHtml(display)}</span>
                ${statusIcon}
            </div>
        </div>`;
    },

    /** Task - agent icon with description */
    _renderThinkingTask(tool) {
        const desc = tool.toolInput?.description || 'Running task...';
        const isComplete = tool.toolCompleted || !!tool.toolOutput;

        const statusBadge = isComplete
            ? '<span class="tt-badge tt-badge-success">Done</span>'
            : '<span class="tt-badge tt-badge-pending">Running...</span>';

        return `<div class="thinking-tool tt-task" id="thinking-tool-${tool.toolId}">
            <div class="tt-header">
                <span class="tt-icon tt-icon-purple">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
                        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
                        <circle cx="9" cy="7" r="4"/>
                        <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
                        <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
                    </svg>
                </span>
                <span class="tt-desc">${escapeHtml(desc)}</span>
                ${statusBadge}
            </div>
        </div>`;
    },

    /** Skill - lightning bolt icon with skill name */
    _renderThinkingSkill(tool) {
        const skillName = tool.toolInput?.skill || 'skill';
        const args = tool.toolInput?.args || '';
        const isComplete = tool.toolCompleted || !!tool.toolOutput;

        const statusBadge = isComplete
            ? '<span class="tt-badge tt-badge-success">Done</span>'
            : '<span class="tt-badge tt-badge-pending">Running...</span>';

        return `<div class="thinking-tool tt-skill" id="thinking-tool-${tool.toolId}">
            <div class="tt-header">
                <span class="tt-icon tt-icon-cyan">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
                        <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
                    </svg>
                </span>
                <span class="tt-skill-name">/${escapeHtml(skillName)}</span>
                ${args ? `<span class="tt-args">${escapeHtml(args)}</span>` : ''}
                ${statusBadge}
            </div>
        </div>`;
    },

    /** EnterPlanMode - clipboard icon */
    _renderThinkingPlanMode(tool) {
        const isComplete = tool.toolCompleted || !!tool.toolOutput;

        const statusBadge = isComplete
            ? '<span class="tt-badge tt-badge-success">Active</span>'
            : '<span class="tt-badge tt-badge-pending">Entering...</span>';

        return `<div class="thinking-tool tt-plan-mode" id="thinking-tool-${tool.toolId}">
            <div class="tt-header">
                <span class="tt-icon tt-icon-green">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
                        <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>
                        <rect x="8" y="2" width="8" height="4" rx="1"/>
                    </svg>
                </span>
                <span class="tt-label">Plan Mode</span>
                ${statusBadge}
            </div>
        </div>`;
    },

    /** LSP - code icon with operation */
    _renderThinkingLSP(tool) {
        const op = tool.toolInput?.operation || 'query';
        const file = tool.toolInput?.filePath?.split('/').pop() || '';
        const isComplete = tool.toolCompleted || !!tool.toolOutput;

        const statusIcon = isComplete
            ? '<span class="tt-status tt-ok">✓</span>'
            : '<span class="tt-status tt-pending">...</span>';

        return `<div class="thinking-tool tt-lsp" id="thinking-tool-${tool.toolId}">
            <div class="tt-header">
                <span class="tt-icon tt-icon-blue">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
                        <polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>
                    </svg>
                </span>
                <span class="tt-op">${escapeHtml(op)}</span>
                ${file ? `<span class="tt-filename">${escapeHtml(file)}</span>` : ''}
                ${statusIcon}
            </div>
        </div>`;
    },

    /** Default fallback for unknown tools */
    _renderThinkingDefault(tool) {
        const isComplete = tool.toolCompleted || !!tool.toolOutput;
        const output = tool.toolOutput || '';

        // Build a meaningful preview from input
        let inputDesc = '';
        if (tool.toolInput) {
            const keys = Object.keys(tool.toolInput);
            if (keys.length > 0) {
                const key = keys[0];
                const val = String(tool.toolInput[key]).slice(0, 50);
                inputDesc = `${key}: ${val}${String(tool.toolInput[key]).length > 50 ? '...' : ''}`;
            }
        }

        const statusIcon = isComplete
            ? '<span class="tt-status tt-ok">✓</span>'
            : '<span class="tt-status tt-pending">...</span>';

        // Show output preview if available
        let outputHtml = '';
        if (output && typeof output === 'string') {
            const lines = output.split('\n').slice(0, 4);
            const preview = lines.join('\n');
            const truncated = output.split('\n').length > 4;
            outputHtml = `<div class="tt-output">${escapeHtml(preview)}${truncated ? '\n...' : ''}</div>`;
        } else if (!isComplete) {
            outputHtml = '<div class="tt-output tt-running">Running...</div>';
        }

        return `<div class="thinking-tool tt-default" id="thinking-tool-${tool.toolId}">
            <div class="tt-header">
                <span class="tt-icon">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
                        <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
                    </svg>
                </span>
                <span class="tt-name">${escapeHtml(tool.toolName)}</span>
                ${inputDesc ? `<span class="tt-input-desc">${escapeHtml(inputDesc)}</span>` : ''}
                ${statusIcon}
            </div>
            ${outputHtml}
        </div>`;
    },
};
