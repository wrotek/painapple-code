/**
 * GridSwitcher — fullscreen grid of session preview cards (iPad-style switcher).
 *
 * Triggered by clicking the header "All sessions" button or pressing Alt+Tab.
 * Shows every open session as a card with name, cwd, status dot, last
 * assistant snippet, and a meta footer (turn count / cost / time-ago).
 *
 * Click a card to switch; click X to close that session; Esc or click the
 * backdrop to dismiss the switcher itself.
 */

import S from './strings.js';
import { escapeHtml } from './utils.js';
import { ICONS } from './widget-system/icons.js';
import { projectColorStyle } from './project-colors.js';

export class GridSwitcher {
    constructor(app) {
        this.app = app;
        this.overlay = null;
        this.modal = null;
        this.grid = null;
        this.visible = false;
        this._build();
    }

    _build() {
        const overlay = document.createElement('div');
        overlay.id = 'grid-switcher-overlay';
        overlay.className = 'gs-overlay';
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.setAttribute('aria-label', S.grid_switcher.title);
        overlay.hidden = true;
        overlay.innerHTML = `
            <div class="gs-modal">
                <div class="gs-header">
                    <h2 class="gs-title">${S.grid_switcher.title}</h2>
                    <span class="gs-count"></span>
                    <div class="gs-spacer"></div>
                    <button class="gs-close-btn" data-tooltip="${S.grid_switcher.close_tooltip}" aria-label="${S.grid_switcher.close_tooltip}">
                        ${ICONS.close}
                    </button>
                </div>
                <div class="gs-grid"></div>
            </div>
        `;
        document.body.appendChild(overlay);

        this.overlay = overlay;
        this.modal = overlay.querySelector('.gs-modal');
        this.grid = overlay.querySelector('.gs-grid');
        this.countEl = overlay.querySelector('.gs-count');

        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) this.hide();
        });
        overlay.querySelector('.gs-close-btn').addEventListener('click', () => this.hide());

        this.grid.addEventListener('click', (e) => {
            const closeBtn = e.target.closest('.gs-card-close');
            if (closeBtn) {
                e.stopPropagation();
                this._closeSession(closeBtn.dataset.sessionId);
                return;
            }
            const card = e.target.closest('.gs-card');
            if (card) this._switchTo(card.dataset.sessionId);
        });

        this.grid.addEventListener('keydown', (e) => {
            const card = e.target.closest('.gs-card');
            if (!card) return;
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                this._switchTo(card.dataset.sessionId);
            } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                e.preventDefault();
                this._focusSibling(card, 1);
            } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                e.preventDefault();
                this._focusSibling(card, -1);
            }
        });
    }

    /**
     * Show the grid switcher.
     * @param {Object} [opts]
     * @param {boolean} [opts.commitOnAltRelease] - When true, releasing Alt
     *   commits the currently-focused card (Mac/Windows app-switcher feel).
     *   Set by the Alt+Tab shortcut path; not by button clicks.
     * @param {number} [opts.initialDirection] - When set, focus the card in
     *   that direction relative to the active session (1 = next, -1 = prev).
     *   Without it, focus stays on the active card.
     */
    show(opts = {}) {
        if (this.visible) return;
        this._render();
        this.overlay.hidden = false;
        this.visible = true;

        if (opts.initialDirection) {
            this.advance(opts.initialDirection);
        } else {
            const target = this.grid.querySelector('.gs-card.active') || this.grid.querySelector('.gs-card');
            this._select(target);
        }

        if (opts.commitOnAltRelease) {
            this._commitOnAltRelease = true;
            document.addEventListener('keyup', this._onKeyUp, true);
        }
    }

    hide() {
        if (!this.visible) return;
        this.overlay.hidden = true;
        this.visible = false;
        if (this._commitOnAltRelease) {
            document.removeEventListener('keyup', this._onKeyUp, true);
            this._commitOnAltRelease = false;
        }
    }

    toggle() {
        this.visible ? this.hide() : this.show();
    }

    /**
     * Commit on Alt-release: switch to whichever card the user has focused.
     * Mirrors the Mac/Windows app-switcher feel (hold modifier, tap to cycle,
     * release to enter).
     */
    _onKeyUp = (e) => {
        if (e.key !== 'Alt' || !this.visible) return;
        const selected = this.grid.querySelector('.gs-card.gs-selected')
            || document.activeElement?.closest?.('.gs-card');
        if (selected && this.grid.contains(selected)) {
            this._switchTo(selected.dataset.sessionId);
        } else {
            this.hide();
        }
    };

    _render() {
        const sessions = this.app.sessionManager?.sessions || [];
        const activeSession = this.app.activeSession;

        this.countEl.textContent = sessions.length
            ? S.grid_switcher.count.replace('{n}', sessions.length)
            : '';

        if (!sessions.length) {
            this.grid.innerHTML = `<div class="gs-empty">${S.grid_switcher.empty}</div>`;
            return;
        }

        this.grid.innerHTML = sessions
            .map(s => this._renderCard(s, s === activeSession))
            .join('');
    }

    _renderCard(session, isActive) {
        const name = escapeHtml(session.name || S.grid_switcher.untitled);
        const cwdRaw = session.cwd || '';
        const cwdShort = cwdRaw.replace(/^\/home\/[^/]+\//, '~/');
        const cwd = cwdShort ? escapeHtml(cwdShort) : `<span class="gs-card-cwd-empty">${S.grid_switcher.no_cwd}</span>`;
        const status = session.processStatusClass || '';
        const snippet = this._lastSnippet(session);
        const meta = this._metaLine(session);
        const wt = session.isWorktree
            ? `<span class="gs-card-wt" title="${escapeHtml(session.worktreeName || '')}">${escapeHtml(session.worktreeName || S.grid_switcher.worktree_label)}</span>`
            : '';
        const pendingClass = session.hasPendingQuestion
            ? (session.pendingQuestionType === 'plan_approval' ? 'plan' : 'question')
            : '';
        const pending = session.hasPendingQuestion
            ? `<span class="gs-card-pending ${pendingClass}" data-tooltip="${pendingClass === 'plan' ? S.grid_switcher.plan_ready : S.grid_switcher.pending_question}">?</span>`
            : '';
        const unread = session.unread ? '<span class="gs-card-unread"></span>' : '';
        const fav = (session.storeId && this._isFavorite(session.storeId)) ? '<span class="gs-card-fav">★</span>' : '';

        const classes = [
            'gs-card',
            isActive ? 'active' : '',
            session.unread ? 'unread' : '',
            session.hasPendingQuestion ? 'has-pending' : '',
            session.isWorktree ? 'is-worktree' : '',
        ].filter(Boolean).join(' ');

        return `
            <div class="${classes}" data-session-id="${escapeHtml(session.id)}" tabindex="0" role="button" aria-label="${name}"${projectColorStyle(session.cwd)}>
                <div class="gs-card-top">
                    <span class="gs-card-status ${status}"></span>
                    <span class="gs-card-name">${name}</span>
                    ${fav}
                    ${pending}
                    ${unread}
                    <button class="gs-card-close" data-session-id="${escapeHtml(session.id)}" data-tooltip="${S.grid_switcher.close_session_tooltip}" aria-label="${S.grid_switcher.close_session_tooltip}">
                        ${ICONS.close}
                    </button>
                </div>
                <div class="gs-card-cwd" title="${escapeHtml(cwdRaw)}">${cwd}${wt}</div>
                <div class="gs-card-snippet">${snippet}</div>
                <div class="gs-card-meta">${meta}</div>
            </div>
        `;
    }

    _isFavorite(storeId) {
        try {
            const favs = JSON.parse(localStorage.getItem('claude-code-favorites') || '[]');
            return Array.isArray(favs) && favs.includes(storeId);
        } catch (e) {
            return false;
        }
    }

    _lastSnippet(session) {
        const msgs = session.messages || [];
        if (!msgs.length) return `<em class="gs-snippet-empty">${S.grid_switcher.no_messages}</em>`;

        for (let i = msgs.length - 1; i >= 0; i--) {
            const m = msgs[i];
            if (m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()) {
                return escapeHtml(m.content.slice(0, 240));
            }
        }
        for (let i = msgs.length - 1; i >= 0; i--) {
            const m = msgs[i];
            if (m.role === 'user' && typeof m.content === 'string' && m.content.trim()) {
                return `<span class="gs-snippet-user">${S.grid_switcher.user_prefix}</span> ${escapeHtml(m.content.slice(0, 200))}`;
            }
        }
        return `<em class="gs-snippet-empty">${S.grid_switcher.no_messages}</em>`;
    }

    _metaLine(session) {
        const parts = [];
        const turnCount = (session.messages || []).filter(m => m.role === 'user' && typeof m.content === 'string').length;
        if (turnCount > 0) {
            parts.push(`${turnCount} ${turnCount === 1 ? S.grid_switcher.turn : S.grid_switcher.turns}`);
        }
        const cost = session.totalCost;
        if (cost && cost > 0) {
            parts.push('$' + cost.toFixed(cost < 1 ? 3 : 2));
        }
        if (session.lastActivity) {
            const ago = this._timeAgo(session.lastActivity);
            if (ago) parts.push(ago);
        }
        return escapeHtml(parts.join(' • '));
    }

    _timeAgo(iso) {
        const ms = Date.now() - new Date(iso).getTime();
        if (Number.isNaN(ms) || ms < 0) return '';
        if (ms < 60_000) return S.grid_switcher.now;
        const m = Math.floor(ms / 60_000);
        if (m < 60) return `${m}m`;
        const h = Math.floor(m / 60);
        if (h < 24) return `${h}h`;
        const d = Math.floor(h / 24);
        return `${d}d`;
    }

    _switchTo(sessionId) {
        const session = this.app.sessionManager?.get(sessionId);
        if (!session) return;
        const tabCtrl = this.app.tabCtrl;
        if (tabCtrl?.switchToSession) {
            tabCtrl.switchToSession(session);
        }
        this.hide();
    }

    _closeSession(sessionId) {
        const session = this.app.sessionManager?.get(sessionId);
        if (!session) return;
        this.app.closeSession?.(session);
        this._render();
        const remaining = this.grid.querySelector('.gs-card');
        if (!remaining) {
            this.hide();
        } else {
            this._select(remaining);
        }
    }

    _focusSibling(card, dir) {
        const cards = Array.from(this.grid.querySelectorAll('.gs-card'));
        const i = cards.indexOf(card);
        if (i < 0) return;
        const next = cards[(i + dir + cards.length) % cards.length];
        this._select(next);
    }

    /**
     * Move selection to the next/previous card. Used by Alt+Tab / Alt+Shift+Tab
     * cycling. Falls back to the active card (or first card) if nothing in
     * the grid is currently selected.
     */
    advance(dir = 1) {
        const cards = Array.from(this.grid.querySelectorAll('.gs-card'));
        if (!cards.length) return;
        const current = this.grid.querySelector('.gs-card.gs-selected')
            || document.activeElement?.closest?.('.gs-card');
        if (current && this.grid.contains(current)) {
            this._focusSibling(current, dir);
            return;
        }
        const fallback = this.grid.querySelector('.gs-card.active') || cards[0];
        const start = cards.indexOf(fallback);
        this._select(cards[(start + dir + cards.length) % cards.length]);
    }

    /**
     * Set the selection cursor on a card. Manages the `.gs-selected` class
     * (used by CSS for the visual highlight) and moves DOM focus for a11y.
     *
     * We don't rely on `:focus-visible` for the highlight because programmatic
     * `.focus()` calls — especially while a modifier key like Alt is held —
     * inconsistently trigger it across browsers (notably iPadOS Safari).
     */
    _select(card) {
        if (!card) return;
        const prev = this.grid.querySelector('.gs-card.gs-selected');
        if (prev && prev !== card) prev.classList.remove('gs-selected');
        card.classList.add('gs-selected');
        card.focus();
    }
}
