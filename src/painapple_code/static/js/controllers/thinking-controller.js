/**
 * ThinkingController - Handles rendering of Claude's thinking blocks
 *
 * DESIGN (2025-12-29):
 * - Each thinking step shown inline with its tools
 * - Reasoning text is collapsed (one-line preview), expandable on click
 * - Tools are ALWAYS visible right after their reasoning step
 * - Preserves chronological order: thought1 + tools1, thought2 + tools2, etc.
 */

import { $, escapeHtml, parseTaskUsage, formatTokensBadge, formatDuration } from '../utils.js';
import { getToolCollapseMode, getToolCategory } from '../widgets/config-widget.js';

export class ThinkingController {
    constructor(ctx) {
        this.ctx = ctx;
    }

    // ═══════════════════════════════════════════════════════════════
    // THINKING MESSAGE RENDERING
    // ═══════════════════════════════════════════════════════════════

    /**
     * Render a thinking message with automatic grouping
     * Each thinking message becomes a step with its tools
     */
    renderThinkingMessageWithGrouping(msg) {
        const messages = this.ctx.getMessageContainer();
        const lastChild = messages.lastElementChild;

        // If last element is a thinking section from the SAME turn, add to it
        // (never group across turn boundaries - see commit 06a62c8 for precedent)
        if (lastChild?.classList.contains('thinking') &&
            lastChild.querySelector('.thinking-section') &&
            lastChild.dataset.turnId == msg.turnId) {
            this.addStepToSection(lastChild, msg);
            return;
        }

        // Otherwise create new thinking section
        const div = document.createElement('div');
        div.className = 'message thinking';
        div.id = `msg-${msg.id}`;
        div.dataset.turnId = msg.turnId;
        div.innerHTML = this._renderSection([msg]);
        messages.appendChild(div);

        // Check for gutter space after DOM is updated
        requestAnimationFrame(() => {
            const section = div.querySelector('.thinking-section');
            if (section) this.checkGutterSpace(section);
        });
    }

    /**
     * Add a new step to an existing thinking section
     */
    addStepToSection(sectionElement, msg) {
        const section = sectionElement.querySelector('.thinking-section');
        if (!section) return;

        // Prevent duplicate steps
        if (section.querySelector(`.thinking-step[data-msg-id="${msg.id}"]`)) {
            return;
        }

        const existingSteps = section.querySelectorAll('.thinking-step');
        const stepNum = existingSteps.length + 1;
        const sectionId = section.id;

        const stepHtml = this._renderStep(msg, stepNum, sectionId);
        section.insertAdjacentHTML('beforeend', stepHtml);

        // Check gutter space (may not have been checked if this is first tool)
        requestAnimationFrame(() => this.checkGutterSpace(section));
    }

    /**
     * Render a complete thinking section
     */
    _renderSection(thinkingMsgs) {
        const sectionId = `thinking-section-${thinkingMsgs[0].id}`;

        const stepsHtml = thinkingMsgs.map((msg, idx) => {
            return this._renderStep(msg, idx + 1, sectionId);
        }).join('');

        // Only show collapse button if there are any tools
        // Button at START of section so sticky-top works when scrolling down
        // Double chevrons indicate "collapse ALL" vs single chevron for individual tools
        const hasTools = thinkingMsgs.some(msg => msg.tools && msg.tools.length > 0);
        const collapseBtn = hasTools ? `
            <button class="thinking-collapse-tools-btn" onclick="app.toggleThinkingTools('${sectionId}')" data-tooltip="Collapse/expand all tool outputs">
                <svg class="collapse-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="14" height="14">
                    <path d="M7 13l5 5 5-5M7 6l5 5 5-5"/>
                </svg>
                <svg class="expand-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="14" height="14">
                    <path d="M13 7l5 5-5 5M6 7l5 5-5 5"/>
                </svg>
            </button>
        ` : '';

        return `<div class="thinking-section" id="${sectionId}">${collapseBtn}${stepsHtml}</div>`;
    }

    /**
     * Render a single step: collapsed reasoning + visible tools
     * Text is truncated by default, shows full markdown when expanded
     */
    _renderStep(msg, stepNum, sectionId) {
        const content = (msg.content || '').trim();
        const hasContent = content.length > 0;

        // Render tools for this step (always visible)
        const toolsHtml = this._renderStepTools(msg.tools || []);

        // Preview text (plain, truncated, markdown stripped) - shown when collapsed
        const strippedContent = this._stripMarkdownSyntax(content);
        const previewText = strippedContent.slice(0, 200);
        const previewHtml = hasContent
            ? `<span class="thinking-step-preview">${escapeHtml(previewText)}${strippedContent.length > 200 ? '...' : ''}</span>`
            : '';

        // Full content with markdown - shown when expanded
        const fullContentHtml = hasContent
            ? `<div class="thinking-step-content">${this._renderMarkdown(content)}</div>`
            : '';

        return `
            <div class="thinking-step" data-step="${stepNum}" data-msg-id="${msg.id}">
                <div class="thinking-step-header" onclick="app.toggleThinkingStep('${sectionId}', ${stepNum})">
                    ${previewHtml}
                    ${hasContent ? '<span class="thinking-step-expand">›</span>' : ''}
                </div>
                ${fullContentHtml}
                <div class="thinking-step-tools">
                    ${toolsHtml}
                </div>
            </div>
        `;
    }

    /**
     * Render markdown content using the app's markdown renderer
     */
    _renderMarkdown(content) {
        if (!content) return '';
        if (this.ctx.markdown) {
            return this.ctx.markdown.render(content);
        }
        // Fallback: escape HTML and preserve whitespace
        return `<pre style="white-space: pre-wrap;">${escapeHtml(content)}</pre>`;
    }

    /**
     * Strip markdown syntax for clean preview text
     * Safe approach: just removes syntax markers, doesn't render
     */
    _stripMarkdownSyntax(text) {
        if (!text) return '';
        return text
            // Remove heading markers (# ## ### etc)
            .replace(/^#{1,6}\s+/gm, '')
            // Remove bold/italic markers
            .replace(/\*\*([^*]+)\*\*/g, '$1')
            .replace(/\*([^*]+)\*/g, '$1')
            .replace(/__([^_]+)__/g, '$1')
            // Only match _italic_ at word boundaries (not mid-word like ai_overview)
            .replace(/(^|\s)_([^\s_]+)_(\s|$)/g, '$1$2$3')
            // Remove inline code backticks
            .replace(/`([^`]+)`/g, '$1')
            // Remove blockquote markers
            .replace(/^>\s*/gm, '')
            // Remove list markers
            .replace(/^[-*+]\s+/gm, '')
            .replace(/^\d+\.\s+/gm, '')
            // Remove link syntax [text](url) -> text
            .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
            // Collapse multiple spaces/newlines into single space
            .replace(/\s+/g, ' ')
            .trim();
    }

    /**
     * Render tools for a step (always visible)
     * Groups sub-agent tools under their parent Task tool
     */
    _renderStepTools(tools) {
        if (!tools || tools.length === 0) return '';

        // Group tools: Tasks capture subsequent tools until completed
        const groups = this._groupToolsByTask(tools);

        return groups.map(group => {
            if (group.type === 'task') {
                return this._renderTaskGroup(group);
            } else {
                return this._renderSingleTool(group.tool);
            }
        }).filter(Boolean).join('');
    }

    /**
     * Group tools by Task ownership
     * Task tools capture all subsequent tools until we hit another Task tool
     * (regardless of completion status - completion only affects the badge)
     */
    _groupToolsByTask(tools) {
        const groups = [];
        let currentTaskGroup = null;

        for (const tool of tools) {
            if (tool.toolName === 'Task') {
                // Close any previous task group
                if (currentTaskGroup) {
                    groups.push(currentTaskGroup);
                }
                // Start new task group
                currentTaskGroup = {
                    type: 'task',
                    task: tool,
                    children: []
                };
            } else if (currentTaskGroup) {
                // Add to current task group (all tools after Task belong to it)
                currentTaskGroup.children.push(tool);
            } else {
                // Independent tool (before any Task)
                groups.push({ type: 'tool', tool });
            }
        }

        // Don't forget the last group
        if (currentTaskGroup) {
            groups.push(currentTaskGroup);
        }

        return groups;
    }

    /**
     * Render a single tool (non-Task)
     */
    _renderSingleTool(tool) {
        const toolType = getToolCategory(tool.toolName);
        const mode = getToolCollapseMode('thinking', toolType);
        const expandOpts = { defaultExpanded: mode === 'expanded' };
        const msg = {
            id: tool.toolId,
            toolInput: tool.toolInput,
            toolOutput: tool.toolOutput,
            toolError: tool.toolError,
            toolCompleted: tool.toolCompleted || !!tool.toolOutput
        };

        let html = '';
        // Read/Write/Edit need file_path. If missing (truncated input, partial
        // streaming state, malformed log), fall through to the compact renderer
        // — its renderThinkingToolCompact path already handles missing inputs.
        const hasFilePath = !!tool.toolInput?.file_path;
        switch (tool.toolName) {
            case 'Edit':
                html = hasFilePath
                    ? this.ctx.toolRenderer.renderEditDiff(tool.toolInput, tool.toolOutput, tool.toolId, tool.startLine)
                    : this.ctx.toolRenderer.renderThinkingToolCompact(tool);
                break;
            case 'Write':
                html = hasFilePath
                    ? this.ctx.toolRenderer.renderWriteBlock(msg, expandOpts)
                    : this.ctx.toolRenderer.renderThinkingToolCompact(tool);
                break;
            case 'Read':
                html = hasFilePath
                    ? this.ctx.toolRenderer.renderReadBlock(msg, expandOpts)
                    : this.ctx.toolRenderer.renderThinkingToolCompact(tool);
                break;
            case 'Grep':
                html = this.ctx.toolRenderer.renderGrepBlock(msg, expandOpts);
                break;
            case 'Glob':
                html = this.ctx.toolRenderer.renderGlobBlock(msg, expandOpts);
                break;
            case 'Bash':
            case 'Shell':
                html = this.ctx.toolRenderer.renderBashBlock(msg, expandOpts);
                break;
            case 'TodoWrite':
                msg.toolName = 'TodoWrite';
                html = this.ctx.toolRenderer.renderTodoBlock(msg);
                break;
            default:
                html = this.ctx.toolRenderer.renderThinkingToolCompact(tool);
        }

        if (!html) return '';

        // Gutter icon for per-tool collapse (positioned in right margin via CSS)
        const gutterIcon = `
            <button class="tool-gutter-icon" onclick="event.stopPropagation(); app.toggleToolCollapse('${tool.toolId}')" data-tooltip="Collapse/expand this tool">
                <svg class="gutter-collapse-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
                    <path d="M19 9l-7 7-7-7"/>
                </svg>
                <svg class="gutter-expand-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
                    <path d="M9 5l7 7-7 7"/>
                </svg>
            </button>
        `;

        const collapsedClass = mode === 'collapsed' ? ' tool-collapsed' : '';
        return `<div class="thinking-tool-card${collapsedClass}" data-tool-id="${tool.toolId}">${gutterIcon}${html}</div>`;
    }

    /**
     * Render a Task group with collapsible children
     */
    _renderTaskGroup(group) {
        const { task, children } = group;
        const isComplete = task.toolCompleted || !!task.toolOutput;
        const desc = task.toolInput?.description || 'Running task...';
        const subagentType = task.toolInput?.subagent_type || '';

        // Status badge
        const statusBadge = isComplete
            ? '<span class="task-group-badge task-group-badge-success">Done</span>'
            : '<span class="task-group-badge task-group-badge-pending">Running...</span>';

        // Count badge for children
        const childCount = children.length;
        const countBadge = childCount > 0
            ? `<span class="task-group-count">${childCount} tool${childCount !== 1 ? 's' : ''}</span>`
            : '';

        // Render children (collapsed by default)
        const childrenHtml = children.length > 0
            ? children.map(child => this._renderSingleTool(child)).join('')
            : '';

        // Parse agent response from toolOutput
        const { text: agentResponse, usage } = this._parseTaskOutputWithUsage(task.toolOutput);

        // Usage badges (tokens + duration)
        let usageBadges = '';
        if (usage) {
            const tokBadge = formatTokensBadge(usage.totalTokens);
            const durBadge = formatDuration(usage.durationMs);
            if (tokBadge) usageBadges += `<span class="task-group-tokens">${tokBadge}</span>`;
            if (durBadge) usageBadges += `<span class="task-group-duration">${durBadge}</span>`;
        }

        // Preview for collapsed state (first ~150 chars, markdown stripped)
        let outputPreview = '';
        if (isComplete && agentResponse) {
            const strippedResponse = this._stripMarkdownSyntax(agentResponse);
            const preview = strippedResponse.slice(0, 150).trim();
            if (preview) {
                outputPreview = `<div class="task-group-preview">${escapeHtml(preview)}${strippedResponse.length > 150 ? '...' : ''}</div>`;
            }
        }

        // Full response for expanded state (rendered with markdown)
        let fullResponse = '';
        if (isComplete && agentResponse) {
            fullResponse = `<div class="task-group-response">${this._renderMarkdown(agentResponse)}</div>`;
        }

        // Show expand chevron if there are children OR a response to show
        const hasExpandableContent = childCount > 0 || agentResponse;

        return `
            <div class="task-group" data-task-id="${task.toolId}" data-complete="${isComplete}">
                <div class="task-group-header" onclick="app.toggleTaskGroup('${task.toolId}')">
                    <span class="task-group-icon">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
                            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
                            <circle cx="9" cy="7" r="4"/>
                            <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
                            <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
                        </svg>
                    </span>
                    <span class="task-group-label">Task</span>
                    <span class="task-group-desc">${escapeHtml(desc)}</span>
                    ${subagentType ? `<span class="task-group-type">${escapeHtml(subagentType)}</span>` : ''}
                    ${countBadge}
                    ${usageBadges}
                    ${statusBadge}
                    ${hasExpandableContent ? '<span class="task-group-expand">›</span>' : ''}
                </div>
                ${outputPreview}
                <div class="task-group-body">
                    ${fullResponse}
                    ${childrenHtml ? `<div class="task-group-children">${childrenHtml}</div>` : ''}
                </div>
            </div>
        `;
    }

    /**
     * Parse Task toolOutput to extract text content
     * Output format is usually: [{"type":"text","text":"..."}]
     */
    _parseTaskOutputWithUsage(toolOutput) {
        const raw = this._parseTaskOutput(toolOutput);
        return parseTaskUsage(raw);
    }

    _parseTaskOutput(toolOutput) {
        if (!toolOutput) return '';

        try {
            // If it's a string that looks like JSON array, parse it
            let parsed = toolOutput;
            if (typeof toolOutput === 'string') {
                if (toolOutput.startsWith('[')) {
                    parsed = JSON.parse(toolOutput);
                } else {
                    // Plain string, return as-is
                    return toolOutput;
                }
            }

            // Extract text from content blocks
            if (Array.isArray(parsed)) {
                return parsed
                    .filter(block => block.type === 'text' && block.text)
                    .map(block => block.text)
                    .join('\n\n');
            }

            // Object with text property
            if (parsed && typeof parsed === 'object' && parsed.text) {
                return parsed.text;
            }

            // Fallback: stringify if we couldn't parse
            return typeof toolOutput === 'string' ? toolOutput : JSON.stringify(toolOutput);
        } catch (e) {
            // JSON parse failed, return as-is
            return typeof toolOutput === 'string' ? toolOutput : JSON.stringify(toolOutput);
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // TOGGLE FUNCTIONS
    // ═══════════════════════════════════════════════════════════════

    toggleThinkingStep(sectionId, stepNum) {
        const section = $(`#${sectionId}`);
        if (!section) return;

        const step = section.querySelector(`.thinking-step[data-step="${stepNum}"]`);
        if (step) {
            step.classList.toggle('expanded');
        }
    }

    /**
     * Toggle all tool outputs in a thinking section (collapse/expand)
     * Also syncs individual tool card states so their icons update correctly
     */
    toggleThinkingTools(sectionId) {
        const section = $(`#${sectionId}`);
        if (!section) return;

        const isCollapsing = !section.classList.contains('tools-collapsed');
        section.classList.toggle('tools-collapsed');

        // Sync all individual tool cards to match the section state
        // This ensures per-tool icons show correct expand/collapse state
        const toolCards = section.querySelectorAll('.thinking-tool-card');
        toolCards.forEach(card => {
            if (isCollapsing) {
                card.classList.add('tool-collapsed');
            } else {
                card.classList.remove('tool-collapsed');
            }
        });

        // After collapsing, scroll to bring the section into view
        // But only if it's not already visible (avoid jarring jumps)
        if (isCollapsing) {
            requestAnimationFrame(() => {
                const message = section.closest('.message');
                if (message) {
                    const container = document.getElementById('messages-container');
                    if (container) {
                        const msgRect = message.getBoundingClientRect();
                        const containerRect = container.getBoundingClientRect();
                        // Only scroll if message top is above visible area
                        if (msgRect.top < containerRect.top) {
                            message.scrollIntoView({ behavior: 'smooth', block: 'start' });
                        }
                    }
                }
            });
        }
    }

    /**
     * Toggle a single tool's collapse state
     */
    toggleToolCollapse(toolId) {
        const toolCard = document.querySelector(`.thinking-tool-card[data-tool-id="${toolId}"]`);
        if (toolCard) {
            toolCard.classList.toggle('tool-collapsed');
        }
    }

    /**
     * Check if there's margin space for gutter icons
     * Called after render and on resize
     */
    checkGutterSpace(section) {
        const messageEl = section.closest('.message');
        if (!messageEl) return;

        // Use the scrolling container, not the inner messages div
        // #messages-container has padding and may have extra space on the right
        const container = document.getElementById('messages-container');
        if (!container) return;

        const messageRect = messageEl.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();

        // Right space: distance from message edge to container edge
        // Subtract ~20px for scrollbar buffer
        const rightSpace = containerRect.right - messageRect.right - 20;

        if (rightSpace >= 40) {
            section.classList.add('has-gutter-space');
        } else {
            section.classList.remove('has-gutter-space');
        }
    }

    /**
     * Check gutter space for all visible thinking sections
     * Called on window resize
     */
    checkAllGutterSpace() {
        document.querySelectorAll('.thinking-section').forEach(section => {
            this.checkGutterSpace(section);
        });
    }

    // Legacy compatibility
    toggleThinking(id) {
        const step = document.querySelector(`.thinking-step[data-msg-id="${id}"]`);
        if (step) step.classList.toggle('expanded');
    }

    toggleThinkingGroup(groupId) {
        // No-op - groups are always visible now
    }

    toggleThinkingThoughts(sectionId) {
        // No-op - thoughts are always visible now
    }

    toggleThought(thoughtId) {
        const step = document.querySelector(`.thinking-step[data-msg-id="${thoughtId}"]`);
        if (step) step.classList.toggle('expanded');
    }

    // ═══════════════════════════════════════════════════════════════
    // LIVE UPDATES (tool results streaming in)
    // ═══════════════════════════════════════════════════════════════

    /**
     * Add a tool to a thinking message (live update)
     * @param {Object} msg - The thinking message
     * @param {Object} block - The tool_use block
     * @param {string|null} parentTaskId - Server-provided parent Task ID for nesting
     */
    updateThinkingMessageTool(msg, block, parentTaskId = null) {
        const step = document.querySelector(`.thinking-step[data-msg-id="${msg.id}"]`);
        if (!step) return;

        const toolsContainer = step.querySelector('.thinking-step-tools');
        if (!toolsContainer) return;

        // Check if tool already exists
        if (toolsContainer.querySelector(`[data-tool-id="${block.id}"]`)) return;

        const tool = {
            toolName: block.name,
            toolInput: block.input,
            toolId: block.id,
            toolCompleted: false,
            toolOutput: null,
            parentTaskId
        };

        if (block.name === 'Task') {
            // Render new Task group
            const taskHtml = this._renderTaskGroup({
                task: tool,
                children: []
            });
            toolsContainer.insertAdjacentHTML('beforeend', taskHtml);
        } else if (parentTaskId) {
            // Server told us the parent - nest inside that Task group
            this._nestToolInTaskGroup(toolsContainer, parentTaskId, tool);
        } else {
            // No parent info - check for single active Task (fallback heuristic)
            const incompleteTasks = toolsContainer.querySelectorAll(
                '.task-group:not([data-complete="true"])'
            );

            if (incompleteTasks.length === 1) {
                // Single active Task - safe to nest
                this._nestToolInTaskGroup(
                    toolsContainer,
                    incompleteTasks[0].dataset.taskId,
                    tool
                );
            } else {
                // Multiple or no Tasks - render flat (safe fallback)
                const toolHtml = this._renderSingleTool(tool);
                if (toolHtml) {
                    toolsContainer.insertAdjacentHTML('beforeend', toolHtml);
                }
            }
        }

        // Ensure collapse button exists now that we have a tool
        this._ensureCollapseButton(step);
    }

    /**
     * Ensure the collapse button exists in the thinking section
     * Called when tools are added live (after initial render)
     */
    _ensureCollapseButton(step) {
        const section = step.closest('.thinking-section');
        if (!section) return;

        // Check for gutter space (may have tools now)
        this.checkGutterSpace(section);

        // Already has button
        if (section.querySelector('.thinking-collapse-tools-btn')) return;

        // Insert at START for sticky-top to work when scrolling down
        // Double chevrons indicate "collapse ALL"
        const sectionId = section.id;
        const btnHtml = `
            <button class="thinking-collapse-tools-btn" onclick="app.toggleThinkingTools('${sectionId}')" data-tooltip="Collapse/expand all tool outputs">
                <svg class="collapse-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="14" height="14">
                    <path d="M7 13l5 5 5-5M7 6l5 5 5-5"/>
                </svg>
                <svg class="expand-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="14" height="14">
                    <path d="M13 7l5 5-5 5M6 7l5 5-5 5"/>
                </svg>
            </button>
        `;
        section.insertAdjacentHTML('afterbegin', btnHtml);
    }

    /**
     * Nest a tool inside a Task group
     */
    _nestToolInTaskGroup(container, taskId, tool) {
        const taskGroup = container.querySelector(`.task-group[data-task-id="${taskId}"]`);
        if (!taskGroup) {
            // Task group not found - render flat as fallback
            console.warn(`[ThinkingController] Task group not found for ${taskId}, rendering flat`);
            const toolHtml = this._renderSingleTool(tool);
            if (toolHtml) {
                container.insertAdjacentHTML('beforeend', toolHtml);
            }
            return;
        }

        // Get or create children container
        let childrenContainer = taskGroup.querySelector('.task-group-children');
        if (!childrenContainer) {
            const body = taskGroup.querySelector('.task-group-body');
            if (!body) {
                console.error(`[ThinkingController] Task group body not found for ${taskId}`);
                return;
            }
            childrenContainer = document.createElement('div');
            childrenContainer.className = 'task-group-children';
            body.appendChild(childrenContainer);
        }

        // Render and insert tool
        const toolHtml = this._renderSingleTool(tool);
        if (toolHtml) {
            childrenContainer.insertAdjacentHTML('beforeend', toolHtml);
        }

        // Update count badge
        this._updateTaskChildCount(taskGroup);
    }

    /**
     * Update the child count badge on a Task group
     */
    _updateTaskChildCount(taskGroup) {
        const children = taskGroup.querySelectorAll('.task-group-children .thinking-tool-card');
        let countBadge = taskGroup.querySelector('.task-group-count');
        const header = taskGroup.querySelector('.task-group-header');

        const count = children.length;

        if (count > 0) {
            if (!countBadge) {
                // Create count badge if it doesn't exist
                const statusBadge = header.querySelector('.task-group-badge');
                if (statusBadge) {
                    countBadge = document.createElement('span');
                    countBadge.className = 'task-group-count';
                    statusBadge.before(countBadge);
                }
            }
            if (countBadge) {
                countBadge.textContent = `${count} tool${count !== 1 ? 's' : ''}`;
                countBadge.style.display = '';
            }
        } else if (countBadge) {
            countBadge.style.display = 'none';
        }
    }

    /**
     * Update a tool result (live update)
     * @param {Object} msg - The thinking message
     * @param {string} toolId - The tool ID
     * @param {string} content - The tool result content
     * @param {string[]|null} childToolIds - For Task results, list of child tool IDs
     */
    updateThinkingMessageToolResult(msg, toolId, content, childToolIds = null) {
        // First try standard tool card selector
        let toolCard = document.querySelector(`.thinking-tool-card[data-tool-id="${toolId}"]`);

        if (!toolCard) {
            // Check if it's a Task group
            const taskGroup = document.querySelector(`.task-group[data-task-id="${toolId}"]`);
            if (taskGroup) {
                this._updateTaskGroupResult(taskGroup, msg, toolId, content, childToolIds);
                return;
            }
            // Tool not found - this shouldn't happen
            console.warn(`[ThinkingController] Tool card not found for ${toolId}`);
            return;
        }

        // Standard tool update
        const tool = msg.tools?.find(t => t.toolId === toolId);
        if (!tool) return;

        const newHtml = this._renderSingleTool({
            ...tool,
            toolOutput: content,
            toolCompleted: true
        });

        if (newHtml) {
            toolCard.outerHTML = newHtml;
        }
    }

    /**
     * Update a Task group when its result arrives
     */
    _updateTaskGroupResult(taskGroup, msg, toolId, content, childToolIds) {
        // Mark as complete
        taskGroup.setAttribute('data-complete', 'true');

        // Update badge
        const badge = taskGroup.querySelector('.task-group-badge');
        if (badge) {
            badge.className = 'task-group-badge task-group-badge-success';
            badge.textContent = 'Done';
        }

        // Parse agent response and usage data
        const { text: agentResponse, usage } = this._parseTaskOutputWithUsage(content);

        // Inject usage badges into header
        if (usage) {
            const header = taskGroup.querySelector('.task-group-header');
            if (header) {
                header.querySelectorAll('.task-group-tokens, .task-group-duration').forEach(el => el.remove());
                const statusBadge = taskGroup.querySelector('.task-group-badge');
                const tokText = formatTokensBadge(usage.totalTokens);
                const durText = formatDuration(usage.durationMs);
                const insertBefore = (el) => { if (statusBadge) statusBadge.before(el); else header.appendChild(el); };
                if (durText) {
                    const durEl = document.createElement('span');
                    durEl.className = 'task-group-duration';
                    durEl.textContent = durText;
                    insertBefore(durEl);
                }
                if (tokText) {
                    const tokEl = document.createElement('span');
                    tokEl.className = 'task-group-tokens';
                    tokEl.textContent = tokText;
                    insertBefore(tokEl);
                }
            }
        }

        // Update or create preview
        let preview = taskGroup.querySelector('.task-group-preview');
        if (agentResponse) {
            const strippedResponse = this._stripMarkdownSyntax(agentResponse);
            const previewText = strippedResponse.slice(0, 150).trim();

            if (!preview) {
                const header = taskGroup.querySelector('.task-group-header');
                preview = document.createElement('div');
                preview.className = 'task-group-preview';
                header.after(preview);
            }
            preview.textContent = previewText + (strippedResponse.length > 150 ? '...' : '');
        }

        // Update or create full response
        let responseContainer = taskGroup.querySelector('.task-group-response');
        const body = taskGroup.querySelector('.task-group-body');

        if (agentResponse && body) {
            if (!responseContainer) {
                responseContainer = document.createElement('div');
                responseContainer.className = 'task-group-response';
                body.insertBefore(responseContainer, body.firstChild);
            }
            responseContainer.innerHTML = this._renderMarkdown(agentResponse);
        }

        // Verify/correct child tool grouping if server provided childToolIds
        if (childToolIds && childToolIds.length > 0) {
            this._verifyTaskChildren(taskGroup, childToolIds);
        }

        // Update count badge
        this._updateTaskChildCount(taskGroup);
    }

    /**
     * Verify and correct child tool grouping based on server-provided IDs
     * This handles cases where tools were rendered flat during parallel execution
     */
    _verifyTaskChildren(taskGroup, childToolIds) {
        const container = taskGroup.closest('.thinking-step-tools');
        if (!container) return;

        let childrenContainer = taskGroup.querySelector('.task-group-children');
        if (!childrenContainer) {
            const body = taskGroup.querySelector('.task-group-body');
            if (!body) return;
            childrenContainer = document.createElement('div');
            childrenContainer.className = 'task-group-children';
            body.appendChild(childrenContainer);
        }

        // Move any misplaced tools into this Task group
        for (const toolId of childToolIds) {
            // Skip if already in this Task group
            if (childrenContainer.querySelector(`[data-tool-id="${toolId}"]`)) {
                continue;
            }

            // Find the tool anywhere in the container (might be a sibling or in another Task)
            const tool = container.querySelector(`.thinking-tool-card[data-tool-id="${toolId}"]`);
            if (tool) {
                // Move it into this Task's children
                childrenContainer.appendChild(tool);
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // LEGACY METHODS (compatibility)
    // ═══════════════════════════════════════════════════════════════

    renderThinkingBlock(msg) {
        return this._renderSection([msg]);
    }

    renderThinkingGroup(thinkingMsgs) {
        const div = document.createElement('div');
        div.className = 'message thinking';
        div.id = `thinking-group-${thinkingMsgs[0].id}`;
        div.innerHTML = this._renderSection(thinkingMsgs);
        this.ctx.getMessageContainer().appendChild(div);
    }

    renderThinkingEdits(thinkingMsgs) {
        return ''; // Tools are inline with each step now
    }

    updateThinkingEditsSection(msg) {
        // No-op - tools update inline
    }

    createThinkingGroupElement(thinkingGroup) {
        const groupDiv = document.createElement('div');
        groupDiv.className = 'message thinking';
        groupDiv.innerHTML = this._renderSection(thinkingGroup);
        return groupDiv;
    }
}
