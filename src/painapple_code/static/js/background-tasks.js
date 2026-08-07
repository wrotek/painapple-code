/**
 * Background Task Tracker
 *
 * Tracks Claude Code background tasks (run_in_background Bash commands),
 * polls their output files via /api/tasks/{id}, and updates inline cards
 * with live output preview.
 */

import { CONFIG } from './config.js';
import { escapeHtml } from './utils.js';
import { showToast } from './context-menu.js';
import S from './strings.js';

const POLL_INTERVAL_RUNNING = 500;   // ms while task is active
const POLL_INTERVAL_IDLE = 3000;     // ms for list refresh in widget
const MAX_PREVIEW_BYTES = 50000;     // Keep last 50KB in memory
const PREVIEW_LINES = 6;             // Show last N lines in inline card
const MAX_CONSECUTIVE_ERRORS = 20;   // Stop polling after this many failures

/**
 * Parse the background task pattern from Bash tool output.
 * Returns {taskId, outputPath} or null.
 */
export function parseBackgroundTaskOutput(text) {
    if (!text) return null;
    const m = text.match(
        /Command running in background with ID: (\w+)\.\s*Output is being written to: (.+)/
    );
    if (!m) return null;
    return { taskId: m[1], outputPath: m[2].trim() };
}

class BackgroundTaskTracker {
    constructor() {
        /** @type {Map<string, TaskState>} */
        this.tasks = new Map();
        /** @type {Set<function>} */
        this.listeners = new Set();
    }

    /**
     * Start tracking a background task.
     * @param {string} taskId - The hex task ID
     * @param {string} [command] - The bash command (for display)
     */
    track(taskId, command) {
        if (this.tasks.has(taskId)) return;

        const state = {
            taskId,
            command: command || '',
            offset: 0,
            output: '',
            completed: false,
            failed: false,
            errorCount: 0,
            intervalId: null,
            startedAt: Date.now(),
        };
        this.tasks.set(taskId, state);

        // Start polling
        this._poll(taskId);
        state.intervalId = setInterval(() => this._poll(taskId), POLL_INTERVAL_RUNNING);

        this._emit('tracked', taskId);
    }

    /**
     * Stop tracking a task (cleanup).
     */
    untrack(taskId) {
        const state = this.tasks.get(taskId);
        if (!state) return;
        if (state.intervalId) clearInterval(state.intervalId);
        this.tasks.delete(taskId);
    }

    /**
     * Get all tracked tasks.
     */
    getAll() {
        return Array.from(this.tasks.values()).map(s => ({
            taskId: s.taskId,
            command: s.command,
            completed: s.completed,
            failed: s.failed,
            outputSize: s.output.length,
            startedAt: s.startedAt,
            elapsed: Date.now() - s.startedAt,
        }));
    }

    /**
     * Get full output for a task.
     */
    getOutput(taskId) {
        const state = this.tasks.get(taskId);
        return state ? state.output : '';
    }

    /**
     * Is any task still running?
     */
    hasRunningTasks() {
        for (const s of this.tasks.values()) {
            if (!s.completed) return true;
        }
        return false;
    }

    /**
     * Count of running tasks.
     */
    runningCount() {
        let n = 0;
        for (const s of this.tasks.values()) {
            if (!s.completed) n++;
        }
        return n;
    }

    /**
     * Register a listener for task state changes.
     * Events: 'tracked', 'output', 'completed', 'failed'
     */
    onStateChange(callback) {
        this.listeners.add(callback);
        return () => this.listeners.delete(callback);
    }

    // ── Internal ──────────────────────────────────────────────────

    async _poll(taskId) {
        const state = this.tasks.get(taskId);
        if (!state || state.completed) return;

        try {
            const res = await fetch(
                `${CONFIG.API_BASE}/api/tasks/${taskId}?offset=${state.offset}`
            );
            if (!res.ok) {
                state.errorCount++;
                if (res.status === 404 && state.errorCount < MAX_CONSECUTIVE_ERRORS) {
                    // Task file doesn't exist yet - wait
                    return;
                }
                if (state.errorCount >= MAX_CONSECUTIVE_ERRORS) {
                    state.completed = true;
                    state.failed = true;
                    if (state.intervalId) {
                        clearInterval(state.intervalId);
                        state.intervalId = null;
                    }
                    this._emit('failed', taskId);
                }
                return;
            }

            state.errorCount = 0;
            const data = await res.json();

            // Append new content
            if (data.content) {
                state.output += data.content;
                state.offset = data.offset;

                // Ring buffer: trim if too large
                if (state.output.length > MAX_PREVIEW_BYTES) {
                    state.output = state.output.slice(-MAX_PREVIEW_BYTES);
                }

                this._updateInlineCard(taskId, state);
                this._emit('output', taskId);
            }

            // Check completion
            if (!data.is_running) {
                state.completed = true;
                if (state.intervalId) {
                    clearInterval(state.intervalId);
                    state.intervalId = null;
                }
                this._onTaskCompleted(taskId, state);
            }
        } catch (e) {
            state.errorCount++;
            if (state.errorCount >= MAX_CONSECUTIVE_ERRORS) {
                state.completed = true;
                state.failed = true;
                if (state.intervalId) {
                    clearInterval(state.intervalId);
                    state.intervalId = null;
                }
                this._emit('failed', taskId);
            }
        }
    }

    _updateInlineCard(taskId, state) {
        const outputEl = document.getElementById(`bg-task-${taskId}-output`);
        if (!outputEl) return;

        const lines = state.output.split('\n').filter(l => l.trim());
        const lastLines = lines.slice(-PREVIEW_LINES);

        if (lastLines.length === 0) {
            outputEl.innerHTML = '<div class="bg-task-loading">Waiting for output...</div>';
            return;
        }

        outputEl.innerHTML = `<pre class="bg-task-pre">${
            lastLines.map(l => escapeHtml(l)).join('\n')
        }</pre>`;

        // Auto-scroll to bottom
        outputEl.scrollTop = outputEl.scrollHeight;
    }

    _onTaskCompleted(taskId, state) {
        // Update inline card badge
        const badge = document.getElementById(`bg-task-${taskId}-badge`);
        if (badge) {
            badge.className = 'bg-task-badge bg-task-badge-done';
            badge.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="10" height="10"><polyline points="20 6 9 17 4 12"/></svg> Done`;
        }

        // Toast notification
        const shortId = taskId.slice(0, 7);
        const cmdPreview = state.command
            ? state.command.split('&&').pop().trim().slice(0, 40)
            : shortId;
        showToast(S.toast.background_task_done.replace('{cmd}', cmdPreview));

        this._emit('completed', taskId);
    }

    _emit(event, taskId) {
        for (const cb of this.listeners) {
            try { cb(event, taskId); } catch (e) { /* ignore */ }
        }
    }
}

/** Global singleton */
export const bgTaskTracker = new BackgroundTaskTracker();

/**
 * Fetch full task list from server (for widget use).
 * Returns tasks even if not tracked client-side.
 */
export async function fetchTaskList() {
    try {
        const res = await fetch(`${CONFIG.API_BASE}/api/tasks`);
        if (!res.ok) return [];
        const data = await res.json();
        return data.tasks || [];
    } catch {
        return [];
    }
}

/**
 * Fetch full output for a task from server (for widget detail view).
 */
export async function fetchTaskOutput(taskId) {
    try {
        const res = await fetch(`${CONFIG.API_BASE}/api/tasks/${taskId}`);
        if (!res.ok) return null;
        return await res.json();
    } catch {
        return null;
    }
}
