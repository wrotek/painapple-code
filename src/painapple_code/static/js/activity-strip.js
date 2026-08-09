/**
 * Activity Strip — replaces typing dots with a live activity indicator.
 * Shows what Claude is doing (Thinking, Reading file.py, Running tests...)
 * plus an elapsed timer. Lives inside #input-container for zero scroll impact.
 */

import { basename } from './path-utils.js';

// ── SVG icons (14×14, stroke-based) ────────────────────────────────

const ICONS = {
    sparkle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v1m0 16v1m-8-9H3m18 0h-1m-2.636-6.364l-.707.707M6.343 17.657l-.707.707m0-12.728l.707.707m11.314 11.314l.707.707"/><circle cx="12" cy="12" r="4"/></svg>',
    thinking: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 1 1 7.072 0l-.548.547A3.374 3.374 0 0 0 14 18.469V19a2 2 0 1 1-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"/></svg>',
    file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
    pencil: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>',
    terminal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>',
    globe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>',
    boxes: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>',
    writing: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>',
    compress: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/></svg>',
    lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
};

// ── Tool name → activity detail extraction ─────────────────────────


/**
 * Extract human-readable activity text and icon from a tool_use block.
 * Returns { icon, label, detail? } — label is the verb, detail is the argument.
 * @param {string} name - Tool name (Read, Edit, Bash, etc.)
 * @param {Object} input - Tool input object
 * @returns {{ icon: string, label: string, detail?: string }}
 */
import S from './strings.js';

export function getToolActivity(name, input = {}) {
    switch (name) {
        case 'Read':
            return { icon: 'file', label: S.activity.tools.read, detail: basename(input.file_path) };
        case 'Edit':
            return { icon: 'pencil', label: S.activity.tools.edit, detail: basename(input.file_path) };
        case 'Write':
            return { icon: 'pencil', label: S.activity.tools.write, detail: basename(input.file_path) };
        case 'Bash':
            return { icon: 'terminal', label: S.activity.tools.bash, detail: input.command || '' };
        case 'Grep':
            return { icon: 'search', label: S.activity.tools.grep, detail: input.pattern || '' };
        case 'Glob':
            return { icon: 'search', label: S.activity.tools.glob, detail: input.pattern || '' };
        case 'Task':
            return { icon: 'boxes', label: S.activity.tools.task, detail: input.description || S.activity.tools.task_default };
        case 'WebFetch':
            return { icon: 'globe', label: S.activity.tools.web_fetch };
        case 'WebSearch':
            return { icon: 'globe', label: S.activity.tools.web_search };
        case 'TodoWrite':
            return { icon: 'writing', label: S.activity.tools.todo_write };
        case 'NotebookEdit':
            return { icon: 'pencil', label: S.activity.tools.notebook_edit, detail: basename(input.notebook_path) };
        default:
            return { icon: 'sparkle', label: S.activity.tools.default.replace('{name}', name) };
    }
}

// ── ActivityStrip class ────────────────────────────────────────────

export class ActivityStrip {
    /**
     * @param {HTMLElement} stripEl - The .activity-strip element
     * @param {HTMLElement} containerEl - The #input-area element (for .working class)
     */
    constructor(stripEl, containerEl) {
        this.el = stripEl;
        this.containerEl = containerEl;
        this.iconEl = stripEl.querySelector('.activity-strip-icon');
        this.textEl = stripEl.querySelector('.activity-strip-text');
        this.timerEl = stripEl.querySelector('.activity-strip-timer');
        this._interval = null;
        this._startTime = null;
        this.active = false;
    }

    /**
     * Show activity strip and start timer.
     * @param {{ icon?: string, label?: string, text?: string, detail?: string }} activity
     */
    show(activity = {}) {
        const icon = activity.icon || 'sparkle';

        this._setIcon(icon);
        this._setText(activity);
        this.el.classList.add('visible');
        this.containerEl.classList.add('working');

        if (!this.active) {
            // Use session's turn start time if provided, otherwise now
            this._startTime = activity.startTime || Date.now();
            this._startTimer();
        } else if (activity.startTime && activity.startTime !== this._startTime) {
            // Switching between two running sessions — update to this session's timer
            this._startTime = activity.startTime;
            this._updateTimer();
        }
        // Paused: the turn is blocked on user input (permission ask) — freeze
        // the elapsed display instead of ticking through the wait. The caller
        // shifts the session's turn start time on resume so the paused span
        // never counts into the elapsed time.
        if (activity.paused) {
            this._updateTimer();
            this._stopTimer();
            this.el.classList.add('paused');
        } else {
            this.el.classList.remove('paused');
            if (!this._interval) this._startTimer();
        }
        this.active = true;
    }

    /**
     * Update activity text/icon without restarting timer.
     * @param {{ icon?: string, label?: string, text?: string, detail?: string }} activity
     */
    update(activity) {
        if (!this.active) {
            this.show(activity);
            return;
        }
        if (activity.icon) this._setIcon(activity.icon);
        if (activity.label || activity.text || activity.detail) this._setText(activity);
    }

    /**
     * Hide activity strip and stop timer.
     */
    hide() {
        this.active = false;
        this.el.classList.remove('visible');
        this.el.classList.remove('paused');
        this.containerEl.classList.remove('working');
        this._stopTimer();
    }

    // ── Private ────────────────────────────────────────────────────

    _setText(activity) {
        const label = activity.label || activity.text || S.activity.states.working;
        const detail = activity.detail;
        this.textEl.textContent = '';
        const labelNode = document.createTextNode(label);
        this.textEl.appendChild(labelNode);
        if (detail) {
            const sep = document.createTextNode(' ');
            this.textEl.appendChild(sep);
            const detailSpan = document.createElement('span');
            detailSpan.className = 'activity-detail';
            detailSpan.textContent = detail;
            this.textEl.appendChild(detailSpan);
        }
    }

    _setIcon(name) {
        const svg = ICONS[name] || ICONS.sparkle;
        this.iconEl.innerHTML = svg;
    }

    _startTimer() {
        this._stopTimer();
        this._updateTimer();
        this._interval = setInterval(() => this._updateTimer(), 1000);
    }

    _stopTimer() {
        if (this._interval) {
            clearInterval(this._interval);
            this._interval = null;
        }
    }

    _updateTimer() {
        if (!this._startTime) return;
        const elapsed = Date.now() - this._startTime;
        this.timerEl.textContent = this._formatTime(elapsed);
    }

    _formatTime(ms) {
        const totalSec = Math.floor(ms / 1000);
        const min = Math.floor(totalSec / 60);
        const sec = totalSec % 60;
        if (min === 0) return `0:${sec.toString().padStart(2, '0')}`;
        return `${min}:${sec.toString().padStart(2, '0')}`;
    }
}
