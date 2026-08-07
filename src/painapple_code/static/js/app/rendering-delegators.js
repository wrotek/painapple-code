/**
 * Rendering-delegator mixin — message / thinking / tool render + collapse-toggle
 * methods, mostly thin delegators to this.chatCtrl / this.thinkingCtrl /
 * this.toolRenderer plus small DOM toggles. Extracted from app.js; applied to
 * App.prototype via Object.assign. Only CONFIG is imported (truncateOutput).
 */
import { CONFIG } from '../config.js';

export const renderingDelegatorMethods = {
    renderMessage(msg, scroll = true) {
        this.chatCtrl.renderMessage(msg, scroll);
    },

    /** @delegate ThinkingController */
    renderThinkingMessageWithGrouping(msg) {
        this.thinkingCtrl.renderThinkingMessageWithGrouping(msg);
    },

    /** @delegate ThinkingController */
    addToThinkingGroup(groupElement, msg) {
        this.thinkingCtrl.addToThinkingGroup(groupElement, msg);
    },

    /** @delegate ThinkingController */
    renderThinkingBlock(msg) {
        return this.thinkingCtrl.renderThinkingBlock(msg);
    },

    /** @delegate ThinkingController */
    updateThinkingMessageTool(msg, block, parentTaskId = null) {
        this.thinkingCtrl.updateThinkingMessageTool(msg, block, parentTaskId);
    },

    /** @delegate ThinkingController */
    updateThinkingGroupHeader(group) {
        this.thinkingCtrl.updateThinkingGroupHeader(group);
    },

    /** @delegate ThinkingController */
    updateThinkingMessageToolResult(msg, toolId, content, childToolIds = null) {
        this.thinkingCtrl.updateThinkingMessageToolResult(msg, toolId, content, childToolIds);
        // Scroll after thinking tool result expands content
        this.scrollToBottom();
    },

    /** @delegate ThinkingController */
    updateThinkingEditsSection(msg) {
        this.thinkingCtrl.updateThinkingEditsSection(msg);
    },

    /** @delegate ThinkingController */
    toggleThinking(id) {
        this.thinkingCtrl.toggleThinking(id);
    },

    /** @delegate ThinkingController */
    renderThinkingGroup(thinkingMsgs) {
        this.thinkingCtrl.renderThinkingGroup(thinkingMsgs);
    },

    /** @delegate ThinkingController */
    toggleThinkingGroup(groupId) {
        this.thinkingCtrl.toggleThinkingGroup(groupId);
    },

    /** @delegate ThinkingController */
    toggleThinkingStep(groupId, stepNum) {
        this.thinkingCtrl.toggleThinkingStep(groupId, stepNum);
    },

    /** @delegate ThinkingController - NEW: toggle thoughts list visibility */
    toggleThinkingThoughts(sectionId) {
        this.thinkingCtrl.toggleThinkingThoughts(sectionId);
    },

    /** @delegate ThinkingController - NEW: toggle individual thought */
    toggleThought(thoughtId) {
        this.thinkingCtrl.toggleThought(thoughtId);
    },

    /** Toggle Task group collapse/expand (sub-agent tools) */
    toggleTaskGroup(taskId) {
        const group = document.querySelector(`.task-group[data-task-id="${taskId}"]`);
        if (group) {
            group.classList.toggle('expanded');
        }
    },

    /** @delegate ThinkingController - toggle all tool outputs in a thinking section */
    toggleThinkingTools(sectionId) {
        this.thinkingCtrl.toggleThinkingTools(sectionId);
    },

    /** @delegate ThinkingController - toggle a single tool's collapse state */
    toggleToolCollapse(toolId) {
        this.thinkingCtrl.toggleToolCollapse(toolId);
    },

    // ═══════════════════════════════════════════════════════════════
    // NORMAL TOOL COLLAPSE (non-thinking tool messages)
    // ═══════════════════════════════════════════════════════════════

    /**
     * Toggle collapse state of a single normal tool block
     * @param {string} toolId - The tool's ID (from data-tool-id)
     */
    toggleNormalToolCollapse(toolId) {
        const wrapper = document.querySelector(`.tool-block-wrapper[data-tool-id="${toolId}"]`);
        if (!wrapper) return;
        wrapper.classList.toggle('tool-collapsed');
    },

    /**
     * Toggle collapse state of all tools in a tool group
     * @param {string} groupId - The group's ID (tool-group-xxx)
     */
    toggleToolGroup(groupId) {
        const group = document.getElementById(groupId);
        if (!group) return;

        const isCollapsed = group.classList.toggle('tools-collapsed');

        // Sync all individual tool wrappers in this group
        group.querySelectorAll('.tool-block-wrapper').forEach(wrapper => {
            if (isCollapsed) {
                wrapper.classList.add('tool-collapsed');
            } else {
                wrapper.classList.remove('tool-collapsed');
            }
        });

        // Scroll to group start after collapsing, but only if not already visible
        if (isCollapsed) {
            const container = document.getElementById('messages-container');
            if (container) {
                const groupRect = group.getBoundingClientRect();
                const containerRect = container.getBoundingClientRect();
                // Only scroll if group top is above visible area
                if (groupRect.top < containerRect.top) {
                    group.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }
            }
        }
    },

    // ═══════════════════════════════════════════════════════════════
    // TOOL RENDERING (delegated to ToolRenderer module)
    // ═══════════════════════════════════════════════════════════════

    /** @deprecated Use toolRenderer.renderToolBlock() */
    renderToolBlock(msg) {
        return this.toolRenderer.renderToolBlock(msg);
    },

    /** @deprecated Use toolRenderer.getToolHeaderPreview() */
    getToolHeaderPreview(toolName, input) {
        return this.toolRenderer.getToolHeaderPreview(toolName, input);
    },

    /** @deprecated Use toolRenderer.formatToolInput() */
    formatToolInput(toolName, input) {
        return this.toolRenderer.formatToolInput(toolName, input);
    },

    /** @deprecated Use toolRenderer.linkifyToolOutput() */
    linkifyToolOutput(text) {
        return this.toolRenderer.linkifyToolOutput(text);
    },

    /** @deprecated Use toolRenderer.renderEditDiff() */
    renderEditDiff(input, toolOutput, toolId = null) {
        return this.toolRenderer.renderEditDiff(input, toolOutput, toolId);
    },

    /** @deprecated Use toolRenderer.parseEditLineNumber() */
    parseEditLineNumber(toolOutput, newString) {
        return this.toolRenderer.parseEditLineNumber(toolOutput, newString);
    },

    /** @deprecated Use toolRenderer.renderReadImageBlock() */
    renderReadImageBlock(msg) {
        return this.toolRenderer.renderReadImageBlock(msg);
    },

    /** @deprecated Use toolRenderer.renderTodoBlock() */
    renderTodoBlock(msg) {
        return this.toolRenderer.renderTodoBlock(msg);
    },

    /** @deprecated Use toolRenderer.truncateOutput() */
    truncateOutput(text, maxLen = CONFIG.MAX_OUTPUT_LENGTH) {
        return this.toolRenderer.truncateOutput(text, maxLen);
    },

    /** @deprecated Use toolRenderer.updateToolResult() */
    updateToolResult(msg) {
        const updated = this.toolRenderer.updateToolResult(msg);
        if (!updated) {
            // Fallback: re-render the message element if tool block wasn't found
            // This handles race conditions where DOM element wasn't ready
            console.warn(`[App] Tool update failed, attempting fallback re-render for msg ${msg.id}`);
            const msgEl = document.getElementById(`msg-${msg.id}`);
            if (msgEl) {
                // Re-render the tool block inside the existing message element
                msgEl.innerHTML = this.toolRenderer.renderToolBlock(msg);
                this.toolRenderer.processWriteCharts(msgEl);
                this.toolRenderer.processWriteExcalidraw(msgEl);
                this.toolRenderer.processReadExcalidraw(msgEl);
            } else {
                // Message element also not found - this is unusual, log it
                console.error(`[App] Fallback re-render failed: msg-${msg.id} not found in DOM`);
            }
        }
        // Scroll after tool result expands content (fixes autoscroll stopping on tool output)
        this.scrollToBottom();
    },

    /** @deprecated Use toolRenderer.toggleTool() */
    toggleTool(msgId) {
        this.toolRenderer.toggleTool(msgId);
    },

    /**
     * Toggle a Task block's expanded/collapsed state
     */
    toggleTaskBlock(msgId) {
        const taskBlock = document.querySelector(`#tool-${msgId}.task-block`);
        if (taskBlock) {
            taskBlock.classList.toggle('expanded');
        }
    },

    toggleSkillBlock(msgId) {
        const skillBlock = document.querySelector(`#tool-${msgId}.skill-block`);
        if (skillBlock) {
            skillBlock.classList.toggle('expanded');
        }
    },

    toggleTaskOutputBlock(msgId) {
        const block = document.querySelector(`#tool-${msgId}.tob`);
        if (block) {
            block.classList.toggle('expanded');
        }
    },
};
