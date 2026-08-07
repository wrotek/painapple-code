/**
 * Agent task_progress mixin — handles `system/task_progress` events for
 * background agents launched via the Agent tool.
 *   - _handleTaskProgress: per-event update (Map keyed by tool_use_id)
 *   - _updateAgentActivity: compose activity-strip label (single vs many)
 *   - _checkAgentStalls: 10s interval that flags 60s-silent agents
 *   - _onAgentCompleted: fires toast + bookkeeping when an agent finishes
 *   - _flushStaleAgents: end-of-turn / session-end purge
 *
 * Drives the `boxes` activity-strip icon, header agents badge, and the live
 * task-block DOM (`.task-block[data-tool-use-id="…"]`). Applied to
 * Session.prototype via Object.assign in session.js.
 */

import S from '../strings.js';
import { showToast } from '../context-menu.js';

const getApp = () => window.app;

export const agentProgressMethods = {
    /**
     * Handle task_progress system events from background agents.
     * Updates the Task block UI with live progress and the activity strip.
     */
    _handleTaskProgress(data) {
        const app = getApp();
        const toolUseId = data.tool_use_id;
        if (!toolUseId) return;

        const usage = data.usage || {};
        const progress = {
            description: data.description || '',
            toolCount: usage.tool_uses || 0,
            totalTokens: usage.total_tokens || 0,
            durationMs: usage.duration_ms || 0,
            lastToolName: data.last_tool_name || '',
            lastUpdate: Date.now(),
            stalled: false,
        };

        this._agentProgress.set(toolUseId, progress);
        // Track peak for "N/total" completion display
        if (this._agentProgress.size > this._agentBatchPeak) {
            this._agentBatchPeak = this._agentProgress.size;
        }

        // Update the Task block in the DOM
        if (this.isActive && app?.toolRenderer) {
            const block = document.querySelector(`.task-block[data-tool-use-id="${toolUseId}"]`);
            if (block) {
                app.toolRenderer.updateTaskProgress(block, progress);
            }
        }

        // Update activity strip with agent summary
        this._updateAgentActivity();

        // Update header badge
        if (this.isActive) getApp()?.updateAgentsBadge(this._agentProgress.size);

        // Start stall detection if not already running
        if (!this._agentStallInterval) {
            this._agentStallInterval = setInterval(() => this._checkAgentStalls(), 10_000);
        }
    },

    /**
     * Update activity strip to show agent progress summary.
     */
    _updateAgentActivity() {
        // Count active (non-stalled, recent) agents
        const now = Date.now();
        let activeCount = 0;
        let totalTools = 0;
        let lastDesc = '';
        for (const [, p] of this._agentProgress) {
            if (now - p.lastUpdate < 30_000) {
                activeCount++;
                totalTools += p.toolCount;
                lastDesc = p.description;
            }
        }

        if (activeCount === 0) return;

        if (activeCount === 1) {
            this._setActivity({
                active: true,
                icon: 'boxes',
                label: lastDesc,
                detail: S.agent_progress.tools_badge.replace('{count}', totalTools)
            });
        } else {
            const label = S.activity.agents.many
                .replace('{count}', activeCount)
                .replace('{tools}', totalTools);
            this._setActivity({ active: true, icon: 'boxes', label });
        }
    },

    /**
     * Detect stalled agents (no progress for 60s) and update their UI.
     */
    _checkAgentStalls() {
        const app = getApp();
        const now = Date.now();
        let hasActive = false;

        for (const [toolUseId, p] of this._agentProgress) {
            const elapsed = now - p.lastUpdate;
            if (elapsed > 60_000 && !p.stalled) {
                p.stalled = true;
                if (this.isActive && app?.toolRenderer) {
                    const block = document.querySelector(`.task-block[data-tool-use-id="${toolUseId}"]`);
                    if (block) app.toolRenderer.updateTaskProgress(block, p);
                }
            }
            if (elapsed < 120_000) hasActive = true;  // Still consider alive for 2min
        }

        // Stop checking when no agents are active
        if (!hasActive) {
            clearInterval(this._agentStallInterval);
            this._agentStallInterval = null;
        }
    },

    /**
     * Called when an agent task completes — fires toast and cleans up progress state.
     * @param {string} toolUseId - The completed Agent tool_use_id
     * @param {string} description - Agent description (from toolInput)
     */
    _onAgentCompleted(toolUseId, description) {
        const progress = this._agentProgress.get(toolUseId);
        if (!progress) return;

        // Save to completed list before removing
        this._completedAgents.push({
            toolUseId,
            description: description || progress.description,
            toolCount: progress.toolCount,
            totalTokens: progress.totalTokens,
            durationMs: progress.durationMs,
            completedAt: Date.now(),
        });

        this._agentProgress.delete(toolUseId);
        const total = this._agentBatchPeak;
        const remaining = this._agentProgress.size;
        const done = total - remaining;

        const toastOpts = { duration: 5000, pauseOnHover: true };

        if (remaining === 0 && total > 1) {
            // All agents done
            showToast(S.agent_progress.all_completed.replace('{total}', total), toastOpts);
            this._agentBatchPeak = 0;
        } else if (total > 1) {
            // Batch progress
            const msg = S.agent_progress.completed_batch
                .replace('{done}', done)
                .replace('{total}', total)
                .replace('{desc}', description);
            showToast(msg, toastOpts);
        } else {
            // Single agent
            showToast(S.agent_progress.completed_single.replace('{desc}', description), toastOpts);
            this._agentBatchPeak = 0;
        }

        // Update header badge
        if (this.isActive) getApp()?.updateAgentsBadge(remaining);

        // Stop stall interval if no agents left
        if (remaining === 0 && this._agentStallInterval) {
            clearInterval(this._agentStallInterval);
            this._agentStallInterval = null;
        }
    },

    /**
     * Move any still-running agents to completed and clear badge.
     * Called on turn end / session end when agents won't get individual result events.
     */
    _flushStaleAgents() {
        if (this._agentProgress.size === 0) return;
        for (const [id, p] of this._agentProgress) {
            this._completedAgents.push({
                toolUseId: id, description: p.description,
                toolCount: p.toolCount, totalTokens: p.totalTokens,
                durationMs: p.durationMs, completedAt: Date.now(),
            });
        }
        this._agentProgress.clear();
        this._agentBatchPeak = 0;
        if (this._agentStallInterval) {
            clearInterval(this._agentStallInterval);
            this._agentStallInterval = null;
        }
        if (this.isActive) getApp()?.updateAgentsBadge(0);
    },
};
