/**
 * Goal bar — the active session's provider thread goal (Codex `/goal`),
 * pinned above the input while one exists.
 *
 * A goal is long-running and self-driving: Codex starts turn after turn on its
 * own until it marks the goal complete, so the user needs to see — at a glance
 * and without scrolling — what it's working toward, whether it's still going,
 * and what it has spent, plus the controls to pause/resume/clear it. The
 * transcript records the transitions (server-stored "Goal set/paused/complete"
 * rows); this bar is the live state.
 *
 * State lives on the Session (`session.goal`, a ThreadGoal dict from the
 * server: objective/status/tokensUsed/tokenBudget/timeUsedSeconds). Buttons
 * send a `control_command` frame (no user message is stored for them).
 */

import S from './strings.js';
import { escapeHtml } from './utils.js';
import { showToast } from './context-menu.js';

const T = () => S.goal_bar || {};

const TARGET_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/></svg>';

// status → visual tone (CSS modifier) — anything unknown reads as paused.
const TONE = {
    active: 'active',
    paused: 'paused',
    blocked: 'paused',
    usageLimited: 'stopped',
    budgetLimited: 'stopped',
    complete: 'complete',
};

let _session = null;      // session currently painted
let _expanded = false;    // objective expanded (per page, reset on session switch)
let _armTimer = null;     // two-click Clear arm
let _bound = false;

function fmtTokens(n) {
    n = Number(n) || 0;
    return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function fmtSeconds(sec) {
    sec = Math.floor(Number(sec) || 0);
    if (sec < 60) return `${sec}s`;
    const m = Math.floor(sec / 60), s = sec % 60;
    if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
    const h = Math.floor(m / 60), mm = m % 60;
    return mm ? `${h}h ${mm}m` : `${h}h`;
}

function usageText(goal) {
    const t = T();
    const tokens = goal.tokenBudget
        ? (t.usage_budget || '{tokens} / {budget} tokens')
            .replace('{tokens}', fmtTokens(goal.tokensUsed))
            .replace('{budget}', fmtTokens(goal.tokenBudget))
        : (t.usage || '{tokens} tokens').replace('{tokens}', fmtTokens(goal.tokensUsed));
    return goal.timeUsedSeconds ? `${tokens} · ${fmtSeconds(goal.timeUsedSeconds)}` : tokens;
}

function el() {
    return document.getElementById('goal-bar');
}

function disarm(btn) {
    clearTimeout(_armTimer);
    _armTimer = null;
    if (btn) {
        btn.classList.remove('armed');
        btn.textContent = T().clear || 'Clear';
    }
}

function onClick(e) {
    const bar = el();
    if (!bar || !_session) return;

    if (e.target.closest('.goal-bar-objective')) {
        _expanded = !_expanded;
        render(_session);
        return;
    }

    const btn = e.target.closest('.goal-bar-btn');
    if (!btn) return;
    const action = btn.dataset.action;

    if (action === 'clear' && !btn.classList.contains('armed')) {
        // Two-click arm — window.confirm can silently no-op in the iPad PWA.
        btn.classList.add('armed');
        btn.textContent = T().clear_confirm || 'Clear goal?';
        clearTimeout(_armTimer);
        _armTimer = setTimeout(() => disarm(btn), 2500);
        return;
    }
    if (action === 'clear') disarm(btn);

    if (!_session.sendControlCommand?.(`/goal ${action}`)) {
        showToast(T().not_connected || 'Not connected', { className: 'toast-error', duration: 3000 });
        return;
    }
    // Optimistic: dim the controls until the server's goal update repaints.
    bar.classList.add('pending');
}

function bind() {
    if (_bound) return;
    const bar = el();
    if (!bar) return;
    bar.addEventListener('click', onClick);
    _bound = true;
}

/**
 * Paint the bar for `session` (the ACTIVE session). Hidden when it has no goal.
 * Call on session switch and whenever the active session's goal changes.
 */
export function render(session) {
    const bar = el();
    if (!bar) return;
    bind();
    if (session !== _session) {
        _expanded = false;
        disarm(null);
    }
    _session = session || null;
    const goal = session?.goal;
    if (!goal || !goal.objective) {
        bar.hidden = true;
        bar.innerHTML = '';
        return;
    }

    const t = T();
    const status = goal.status || 'active';
    const tone = TONE[status] || 'paused';
    const statusLabel = t.status?.[status] || status;
    // A running turn under an active goal pulses; an active goal between
    // turns (or after a reload mid-run) still reads Active, just steady.
    const running = status === 'active' && !!session._lastActivity;

    let actions = '';
    if (status === 'active') {
        actions += `<button class="goal-bar-btn" data-action="pause" data-tooltip="${escapeHtml(t.pause_tooltip || '')}">${escapeHtml(t.pause || 'Pause')}</button>`;
    } else if (status !== 'complete') {
        actions += `<button class="goal-bar-btn goal-bar-btn-primary" data-action="resume" data-tooltip="${escapeHtml(t.resume_tooltip || '')}">${escapeHtml(t.resume || 'Resume')}</button>`;
    }
    actions += `<button class="goal-bar-btn goal-bar-btn-clear" data-action="clear" data-tooltip="${escapeHtml(t.clear_tooltip || '')}">${escapeHtml(t.clear || 'Clear')}</button>`;

    bar.className = `goal-bar tone-${tone}${running ? ' running' : ''}${_expanded ? ' expanded' : ''}`;
    bar.innerHTML = `
        <span class="goal-bar-icon" data-tooltip="${escapeHtml(t.tooltip || '')}">${TARGET_SVG}</span>
        <span class="goal-bar-status"><span class="goal-bar-dot"></span>${escapeHtml(statusLabel)}</span>
        <button class="goal-bar-objective" type="button"
                data-tooltip="${escapeHtml(_expanded ? (t.collapse_tooltip || '') : (t.expand_tooltip || ''))}">${escapeHtml(goal.objective)}</button>
        <span class="goal-bar-usage">${escapeHtml(usageText(goal))}</span>
        <span class="goal-bar-actions">${actions}</span>`;
    bar.hidden = false;
}

export const GoalBar = { render };
