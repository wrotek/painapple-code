/**
 * TabController - Unified tab management for sessions, files, and widgets
 *
 * Handles:
 * - View switching (session, editor, widget)
 * - Tab cycling and navigation
 * - Widget tabs (terminals, etc.)
 * - Tab rendering
 */

import { CONFIG, debug } from '../config.js';
import { Storage, escapeHtml, appConfirm } from '../utils.js';
import S from '../strings.js';
import { WidgetManager, WidgetBus, TerminalWidget, FilePreviewWidget } from '../widget-system/init.js';
import { ICONS } from '../widget-system/icons.js';
import { getFileName, detectLanguage, getLanguageIcon } from '../file-tabs.js';
import { isFavoriteSession } from '../welcome.js';
import { recordOpen as recordRecentOpen } from '../recent-opens.js';
import { projectColorStyle } from '../project-colors.js';
import { basename } from '../path-utils.js';

export class TabController {
    constructor(ctx) {
        this.ctx = ctx;

        // Tab state (owned by this controller)
        this.widgetTabs = [];  // Array of {id, widgetId, title, icon, isTerminal?}
        this.activeWidgetTabId = null;
        this.activeMode = 'session';  // 'session' | 'widget' | 'welcome'

        // Unified strip order — sessions and widget tabs interleaved.
        // Entries: {kind:'session', id, storeId?} | {kind:'widget', id}
        // Self-healing via _syncTabOrder(); persisted to localStorage and
        // carried to the server inside the /api/app/tabs payload.
        this.tabOrder = Storage.get(CONFIG.TAB_ORDER_KEY, []) || [];
        this._lastSavedOrderJson = null;

        // Boot guard: widget tabs are recreated by restoreWidgetTabs(), which
        // runs LATER in app.initFromUrl than the first renderTabs() (a session
        // switch renders the strip immediately). Until then a widget entry in
        // tabOrder has no live tab behind it, and pruning it there would throw
        // away its strip position — the tab would come back appended at the end
        // on every reload, dragging the tabs behind it forward.
        this._widgetTabsRestored = false;

        // Stack of recently closed widget tabs (for Ctrl+Shift+T reopen).
        // Sessions have their own stack on SessionManager; the app's
        // reopenLastClosedTab() merges both by closedAt.
        this.recentlyClosedTabs = [];
        this._maxRecentlyClosedTabs = 10;
    }

    // ═══════════════════════════════════════════════════════════════
    // GETTERS (for external access to state)
    // ═══════════════════════════════════════════════════════════════

    get sessionManager() {
        return this.ctx._app.sessionManager;
    }

    get activeSession() {
        return this.ctx.session;
    }

    get els() {
        return this.ctx.els;
    }

    /**
     * Have widget tabs been recreated yet this page load? Until they have,
     * serializeWidgetTabs() is empty and the strip is only half-built, so
     * persisting it would erase the server's widget-tab record.
     */
    get widgetTabsRestored() {
        return this._widgetTabsRestored;
    }

    // ═══════════════════════════════════════════════════════════════
    // UNIFIED TAB LIST
    // ═══════════════════════════════════════════════════════════════

    /**
     * Get all tabs (sessions + files + widgets) in strip order
     * @returns {Array<{type: string, id: string, data: object}>}
     */
    getAllTabs() {
        this._syncTabOrder();
        const sessionById = new Map(this.sessionManager.sessions.map(s => [s.id, s]));
        const widgetById = new Map(this.widgetTabs.map(t => [t.id, t]));
        return this.tabOrder
            .map(e => e.kind === 'session'
                ? { type: 'session', id: e.id, data: sessionById.get(e.id) }
                : { type: 'widget', id: e.id, data: widgetById.get(e.id) })
            // Entries with no live tab behind them (widget tabs still awaiting
            // restoreWidgetTabs) are placeholders, not tabs: renderTabs skips
            // them, so keeping them here would make this list longer than the
            // strip and drift every index-based caller — cycleTab included.
            .filter(t => t.data);
    }

    /**
     * Reconcile tabOrder with the actual session/widget-tab lists.
     * - Remaps session entries whose client id changed (rebuild-from-server)
     *   by matching storeId.
     * - Drops entries whose tab no longer exists.
     * - Inserts new sessions: mid-array creations (atIndex, e.g. welcome-tab
     *   replace) keep their position relative to session neighbors; sessions
     *   at the array end append to the END OF THE STRIP — this is what lets
     *   widget tabs sit between session tabs.
     * - Appends new widget tabs at the end of the strip.
     * - Finally hoists pinned entries to the front (stable), so tabOrder is
     *   ALWAYS normalized pinned-first and array indices match visual order.
     */
    _syncTabOrder() {
        const sessions = this.sessionManager.sessions;
        const sessionById = new Map(sessions.map(s => [s.id, s]));
        const widgetIds = new Set(this.widgetTabs.map(t => t.id));

        // Remap stale session ids via storeId (sessions rebuilt from server state)
        for (const e of this.tabOrder) {
            if (e.kind !== 'session' || sessionById.has(e.id) || !e.storeId) continue;
            const match = sessions.find(s => s.storeId === e.storeId);
            if (match && !this.tabOrder.some(o => o !== e && o.kind === 'session' && o.id === match.id)) {
                e.id = match.id;
            }
        }

        // Drop stale entries; keep session storeIds fresh. Widget entries are
        // held onto until restoreWidgetTabs() has had its turn (see
        // _widgetTabsRestored) so a reload can't lose their strip position;
        // getAllTabs() filters the not-yet-live ones out of the visible list.
        this.tabOrder = this.tabOrder.filter(e => e.kind === 'session'
            ? sessionById.has(e.id)
            : (widgetIds.has(e.id) || !this._widgetTabsRestored));
        for (const e of this.tabOrder) {
            if (e.kind === 'session' && sessionById.get(e.id).storeId) {
                e.storeId = sessionById.get(e.id).storeId;
            }
        }

        // Insert missing sessions
        const hasSession = (id) => this.tabOrder.some(e => e.kind === 'session' && e.id === id);
        sessions.forEach((s, i) => {
            if (hasSession(s.id)) return;
            const entry = { kind: 'session', id: s.id, ...(s.storeId ? { storeId: s.storeId } : {}) };
            const next = sessions.slice(i + 1).find(n => hasSession(n.id));
            if (next) {
                const idx = this.tabOrder.findIndex(e => e.kind === 'session' && e.id === next.id);
                this.tabOrder.splice(idx, 0, entry);
            } else {
                this.tabOrder.push(entry);
            }
        });

        // Append missing widget tabs
        for (const t of this.widgetTabs) {
            if (!this.tabOrder.some(e => e.kind === 'widget' && e.id === t.id)) {
                this.tabOrder.push({ kind: 'widget', id: t.id });
            }
        }

        this._partitionPinned();
    }

    // ═══════════════════════════════════════════════════════════════
    // PINNED TABS
    // ═══════════════════════════════════════════════════════════════

    /**
     * Hoist pinned entries to the front of tabOrder, preserving relative order
     * within each group (filter is stable). Keeping tabOrder itself normalized
     * — rather than sorting at read time — means index-based callers (moveTab,
     * getTabPosition, switchToTabByIndex, cycleTab) all agree with the strip,
     * and applyDomOrder() can keep reading the DOM back 1:1.
     *
     * NOTE the field is `stripPinned`, not `pinned`: this file already uses
     * "pinned" for the unrelated file-preview ephemeral→permanent promotion
     * (see openFilePreviewTab), so the strip concept gets its own name.
     * @private
     */
    _partitionPinned() {
        const pinned = this.tabOrder.filter(e => e.stripPinned);
        if (pinned.length === 0 || pinned.length === this.tabOrder.length) return;
        this.tabOrder = [...pinned, ...this.tabOrder.filter(e => !e.stripPinned)];
    }

    /**
     * Is this tab pinned to the front of the strip?
     * @param {string} kind - 'session' | 'widget'
     * @param {string} id
     */
    isTabPinned(kind, id) {
        return !!this.tabOrder.find(e => e.kind === kind && e.id === id)?.stripPinned;
    }

    /**
     * Toggle pinned state for a tab. Pinned tabs sort first in the strip and
     * are skipped by Close All / Close Others.
     * @param {string} kind - 'session' | 'widget'
     * @param {string} id
     * @param {boolean} [force] - explicit target state (default: flip)
     * @returns {boolean} the resulting pinned state
     */
    toggleTabPin(kind, id, force) {
        this._syncTabOrder();
        const entry = this.tabOrder.find(e => e.kind === kind && e.id === id);
        if (!entry) return false;

        const next = force === undefined ? !entry.stripPinned : !!force;
        if (next) entry.stripPinned = true;
        else delete entry.stripPinned;  // keep persisted entries lean

        this._partitionPinned();
        this.renderTabs();
        this.sessionManager._postTabStateToServer();
        return next;
    }

    /**
     * Persist tabOrder to localStorage (only when it actually changed).
     */
    _saveTabOrder() {
        const json = JSON.stringify(this.tabOrder);
        if (json === this._lastSavedOrderJson) return;
        this._lastSavedOrderJson = json;
        Storage.set(CONFIG.TAB_ORDER_KEY, this.tabOrder);
    }

    /**
     * Move a tab within the unified strip (context menu "Move left/right").
     * @param {string} kind - 'session' | 'widget'
     * @param {string} id - session client id or widget tab id
     * @param {number} direction - -1 left, +1 right
     */
    moveTab(kind, id, direction) {
        this._syncTabOrder();
        const idx = this.tabOrder.findIndex(e => e.kind === kind && e.id === id);
        const target = idx + direction;
        if (idx === -1 || target < 0 || target >= this.tabOrder.length) return;
        // Never let a move cross the pinned/unpinned boundary — _partitionPinned
        // would just snap it back on the next render.
        if (!!this.tabOrder[idx].stripPinned !== !!this.tabOrder[target].stripPinned) return;
        const [entry] = this.tabOrder.splice(idx, 1);
        this.tabOrder.splice(target, 0, entry);
        this.renderTabs();
        this.sessionManager._postTabStateToServer();
    }

    /**
     * Move an existing tab to an absolute strip index.
     *
     * Used by the reopen-closed-tab path: every creation API appends to the end
     * of the strip, so a reopened tab is created first and then slid back to the
     * slot it was closed from (recorded by getTabPosition at close time).
     *
     * The index is clamped into the tab's own pinned segment — a reopened
     * (unpinned) tab can't land inside the pinned block, which _partitionPinned
     * would undo on the next render anyway.
     *
     * @param {string} kind - 'session' | 'widget'
     * @param {string} id - session client id or widget tab id
     * @param {number} index - target strip index (tabOrder index)
     * @returns {boolean} false when the tab isn't in the strip or index is unusable
     */
    insertTabAt(kind, id, index) {
        if (!Number.isInteger(index) || index < 0) return false;
        this._syncTabOrder();
        const from = this.tabOrder.findIndex(e => e.kind === kind && e.id === id);
        if (from === -1) return false;

        const [entry] = this.tabOrder.splice(from, 1);
        const pinnedCount = this.tabOrder.filter(e => e.stripPinned).length;
        const lo = entry.stripPinned ? 0 : pinnedCount;
        const hi = entry.stripPinned ? pinnedCount : this.tabOrder.length;
        this.tabOrder.splice(Math.max(lo, Math.min(index, hi)), 0, entry);

        this._partitionPinned();
        this.renderTabs();
        this.sessionManager._postTabStateToServer();
        return true;
    }

    /**
     * Adopt the current DOM order of the strip into tabOrder (drag-and-drop
     * commit). Entries are matched by kind+id so session storeIds survive.
     */
    applyDomOrder() {
        const domOrder = [...this.els.tabs.querySelectorAll('.tab')]
            .map(el => ({ kind: el.dataset.type, id: el.dataset.id }));
        const byKey = new Map(this.tabOrder.map(e => [`${e.kind}:${e.id}`, e]));
        const next = domOrder
            .map(x => byKey.get(`${x.kind}:${x.id}`))
            .filter(Boolean);
        // Anything not visible in the DOM (shouldn't happen) keeps its entry at the end
        for (const e of this.tabOrder) {
            if (!next.includes(e)) next.push(e);
        }
        this.tabOrder = next;
        this.renderTabs();
        this.sessionManager._postTabStateToServer();
    }

    /**
     * Live-reposition a dragged tab element within the strip based on the
     * pointer's X coordinate. Shared by mouse and touch drag paths.
     * @private
     */
    _dragReposition(tabsEl, draggedEl, clientX) {
        // Auto-scroll when dragging near the strip edges
        const stripRect = tabsEl.getBoundingClientRect();
        if (clientX < stripRect.left + 36) tabsEl.scrollLeft -= 12;
        else if (clientX > stripRect.right - 36) tabsEl.scrollLeft += 12;

        // Insert before the first tab whose midpoint is right of the pointer.
        // Candidates are restricted to the dragged tab's own pinned group, so a
        // drag can't cross the pinned boundary (_partitionPinned would snap it
        // back on the next render, which reads as the drag being ignored).
        const dragPinned = draggedEl.classList.contains('is-pinned');
        const tabs = [...tabsEl.querySelectorAll('.tab')]
            .filter(el => el !== draggedEl
                && el.classList.contains('is-pinned') === dragPinned);
        let target = null;
        for (const el of tabs) {
            const r = el.getBoundingClientRect();
            if (clientX < r.left + r.width / 2) { target = el; break; }
        }
        // Past the last candidate: a pinned tab parks after the last pinned tab
        // (i.e. before the first unpinned one) rather than at the true end.
        if (!target && dragPinned) {
            target = [...tabsEl.querySelectorAll('.tab')]
                .find(el => el !== draggedEl && !el.classList.contains('is-pinned')) || null;
        }
        if (target) {
            if (target.previousElementSibling !== draggedEl) {
                tabsEl.insertBefore(draggedEl, target);
            }
        } else {
            // Past the last tab — the strip now holds only tabs (overflow
            // indicators moved to the viewport overlay), so append to the end.
            if (draggedEl.nextElementSibling !== null) {
                tabsEl.appendChild(draggedEl);
            }
        }
    }

    /**
     * Strip position of a tab in the unified order (for menu disabled states).
     * canMoveLeft/canMoveRight are group-aware: a tab can only move within its
     * own pinned/unpinned segment, so they go false at the segment edge.
     * @returns {{index: number, count: number, canMoveLeft: boolean, canMoveRight: boolean}}
     */
    getTabPosition(kind, id) {
        this._syncTabOrder();
        const index = this.tabOrder.findIndex(e => e.kind === kind && e.id === id);
        const samePinnedGroup = (i) => index !== -1 && i >= 0 && i < this.tabOrder.length
            && !!this.tabOrder[i].stripPinned === !!this.tabOrder[index].stripPinned;
        return {
            index,
            count: this.tabOrder.length,
            canMoveLeft: samePinnedGroup(index - 1),
            canMoveRight: samePinnedGroup(index + 1),
        };
    }

    /**
     * Serialize tabOrder for the server payload. Sessions are keyed by
     * storeId (entries without one are skipped — same rule as the session
     * list itself); widget tabs by tab id.
     */
    getOrderForPersistence() {
        this._syncTabOrder();
        return this.tabOrder
            .filter(e => e.kind === 'widget' || e.storeId)
            .map(e => ({
                ...(e.kind === 'widget'
                    ? { kind: 'widget', id: e.id }
                    : { kind: 'session', storeId: e.storeId }),
                ...(e.stripPinned ? { stripPinned: true } : {}),
            }));
    }

    /**
     * Apply a server-provided order (v2 tab-state). Session entries carry
     * storeId only — _syncTabOrder remaps them to live client ids.
     *
     * The server order is INCOMPLETE by construction: getOrderForPersistence()
     * skips sessions that have no storeId yet (nothing sent in them, so they
     * don't exist server-side and can't be keyed across a localStorage-loss
     * rebuild). Those entries are spliced back at their local position here —
     * left to _syncTabOrder they would be appended at the END of the strip, so
     * a tab the user had dragged left silently jumped to the far right on the
     * next reload, and Cmd+[ / Cmd+] then cycled through that reshuffled order
     * (the shortcut always follows the strip — it was the strip that moved).
     */
    applyServerOrder(order) {
        if (!Array.isArray(order) || order.length === 0) return;

        const localOrder = this.tabOrder;

        // Remember pins we already know about locally. The server order omits
        // sessions that have no storeId yet (getOrderForPersistence skips
        // them), so a freshly-created pinned tab would otherwise lose its pin
        // the moment server state wins. These entries keep their client id
        // across the reload, so kind:id is a valid key.
        const localPins = new Set(localOrder
            .filter(e => e.stripPinned)
            .map(e => `${e.kind}:${e.id}`));

        this.tabOrder = order
            .filter(e => e && (e.kind === 'widget' ? e.id : e.storeId))
            .map(e => ({
                ...(e.kind === 'widget'
                    ? { kind: 'widget', id: e.id }
                    : { kind: 'session', id: e.storeId, storeId: e.storeId }),
                ...(e.stripPinned ? { stripPinned: true } : {}),
            }));

        // Merge the local order back in: walk it once with a cursor into the
        // server-derived array. Entries the server also knows just advance the
        // cursor; entries it doesn't know are spliced AT the cursor, i.e. at
        // their local slot relative to the neighbours that did survive.
        //
        // This deliberately covers widget entries too, not just storeId-less
        // sessions: widget tabs the server order happens to omit would
        // otherwise be appended at the end by _syncTabOrder, which drags any
        // session sitting behind them to the front of the strip.
        //
        // Sessions are matched by storeId (the server's key); a session without
        // one is identity-only, so two storeId-less tabs never collide.
        const keyOf = (e) => e.kind === 'widget'
            ? `w:${e.id}`
            : (e.storeId ? `s:${e.storeId}` : null);
        const locate = (e) => {
            const direct = this.tabOrder.indexOf(e);
            if (direct !== -1) return direct;
            const k = keyOf(e);
            return k ? this.tabOrder.findIndex(x => keyOf(x) === k) : -1;
        };
        const localKeys = new Set(localOrder.map(keyOf).filter(Boolean));
        let cursor = 0;
        for (const entry of localOrder) {
            const idx = locate(entry);
            if (idx !== -1) {
                cursor = idx + 1;
                continue;
            }
            // Never jump in front of a tab the local order has no opinion
            // about (present on the server, absent locally): the server is the
            // only one that knows where it goes, so keep it ahead of us.
            while (cursor < this.tabOrder.length
                   && !localKeys.has(keyOf(this.tabOrder[cursor]))) {
                cursor++;
            }
            this.tabOrder.splice(cursor, 0, entry);
            cursor++;
        }

        this._syncTabOrder();

        // Re-apply local-only pins to the entries _syncTabOrder just re-inserted.
        if (localPins.size) {
            let restored = false;
            for (const e of this.tabOrder) {
                if (!e.stripPinned && localPins.has(`${e.kind}:${e.id}`)) {
                    e.stripPinned = true;
                    restored = true;
                }
            }
            if (restored) this._partitionPinned();
        }
    }

    /**
     * Get current tab index in unified list
     */
    getCurrentTabIndex() {
        const tabs = this.getAllTabs();
        if (this.activeMode === 'widget' && this.activeWidgetTabId) {
            return tabs.findIndex(t => t.type === 'widget' && t.id === this.activeWidgetTabId);
        } else if (this.activeSession) {
            // 'session' and 'welcome' both anchor to a session tab
            return tabs.findIndex(t => t.type === 'session' && t.id === this.activeSession.id);
        }
        return -1;
    }

    /**
     * Switch to tab by unified index
     */
    switchToTabByIndex(index) {
        const tabs = this.getAllTabs();
        if (index < 0 || index >= tabs.length) return;
        this.activateTab(tabs[index]);
    }

    /**
     * Activate a {type, id, data} tab descriptor (as returned by getAllTabs()
     * or pickSuccessorTab()). Returns false when there was nothing to activate.
     */
    activateTab(tab) {
        if (!tab?.data) return false;
        if (tab.type === 'session') {
            this.switchToSession(tab.data);
        } else {
            this.switchToWidgetTab(tab.id);
        }
        return true;
    }

    /**
     * Which tab should take focus when the tab (kind, id) closes?
     *
     * Resolved against the UNIFIED STRIP ORDER (getAllTabs()) — deliberately
     * NOT against sessionManager.sessions / this.widgetTabs. Those two arrays
     * are creation-ordered, so the moment a tab is dragged or pinned their
     * indices stop matching what the user sees, and picking "whatever slid into
     * the closed slot" lands on an arbitrary tab: with any tab pinned, closing
     * the LAST tab jumped to the pinned tab at the far LEFT of the strip. They
     * also can't see each other, so closing a widget tab could never land on an
     * adjacent session tab (and vice versa) even when that's the visual
     * neighbour.
     *
     * Prefers the LEFT neighbour (browser/editor convention — closing the last
     * tab lands on the new last tab), falling back to the right one only when
     * closing the very first tab.
     *
     * MUST be called BEFORE the tab is removed from its backing array.
     * @param {string} kind - 'session' | 'widget'
     * @param {string} id
     * @returns {{type: string, id: string, data: object}|null} null when nothing is left
     */
    pickSuccessorTab(kind, id) {
        const tabs = this.getAllTabs();
        const index = tabs.findIndex(t => t.type === kind && t.id === id);
        if (index === -1) return null;
        return tabs[index - 1] || tabs[index + 1] || null;
    }

    /**
     * Cycle to next/previous tab
     * @param {number} direction - 1 for next, -1 for previous
     */
    cycleTab(direction) {
        const tabs = this.getAllTabs();
        if (tabs.length === 0) return;

        const currentIdx = this.getCurrentTabIndex();
        let newIdx;

        if (currentIdx === -1) {
            newIdx = 0;
        } else {
            newIdx = (currentIdx + direction + tabs.length) % tabs.length;
        }

        this.switchToTabByIndex(newIdx);
    }

    // ═══════════════════════════════════════════════════════════════
    // SESSION VIEW SWITCHING
    // ═══════════════════════════════════════════════════════════════

    /**
     * Switch to session view (conversation)
     */
    switchToSession(session) {
        // Route to welcome up front when the session has no chat content. Avoids
        // a one-frame flash of #session-view before _doSessionSwitch reroutes.
        if (this.ctx._app.shouldShowWelcomeFor(session)) {
            this.switchToWelcome(session);
            // Still enqueue the session switch so _doSessionSwitch runs and
            // performs the rest of the state setup (activeSession, persistence,
            // scroll retargeting, etc.).
            this.ctx._app.switchSession(session);
            return;
        }

        const wasSessionMode = this.activeMode === 'session';
        const isSameSession = this.activeSession === session;

        this.activeMode = 'session';
        Storage.set(CONFIG.ACTIVE_MODE_KEY, 'session');

        // Update view visibility FIRST (before scroll restore)
        // This ensures the container is visible when we restore scroll position
        // (scroll position is lost/ignored when container is display:none)
        this.els.sessionView?.classList.add('active');
        this.els.welcomeView?.classList.remove('active');
        document.getElementById('widget-views')?.classList.remove('active');

        // Restore session-specific UI
        this.els.inputArea?.classList.remove('hidden');
        this.els.connectionBar?.classList.remove('hidden-by-terminal');

        // Restore session's floating widgets (hidden when entering widget tab mode)
        WidgetManager.setSessionWidgetsVisible(true);

        // Delegate session switching to app
        // (handles scroll save for outgoing session, render, and restore for incoming)
        this.ctx._app.switchSession(session);

        // If returning to the same session from a different mode (welcome /
        // file / widget), app.switchSession early-returns without doing the
        // full switch dance — so renderMessages never runs and the container
        // pool never activates the current session. Without these calls, the
        // previously-visible session's container stays on screen even though
        // activeSession is now this one (the "new session shows other tab's
        // chat" bug from the Cmd+T → pick project flow).
        if (!wasSessionMode && isSameSession) {
            this.ctx._app.renderMessages();
            this.ctx._app.restoreScrollPosition();
        }

        this.renderTabs();
    }

    /**
     * View toggle helper for session mode — used by _doSessionSwitch to flip
     * back from welcome without re-running the full switchToSession path
     * (which would re-enqueue _doSessionSwitch).
     */
    _enterSessionView() {
        this.activeMode = 'session';
        Storage.set(CONFIG.ACTIVE_MODE_KEY, 'session');
        this.els.sessionView?.classList.add('active');
        this.els.welcomeView?.classList.remove('active');
        document.getElementById('widget-views')?.classList.remove('active');
        this.els.inputArea?.classList.remove('hidden');
        WidgetManager.setSessionWidgetsVisible(true);
    }

    /**
     * Switch to welcome view (project picker / session discovery).
     * Symmetric with switchToSession — the session is the "owner" of the
     * welcome state (per-tab welcome containers inside #welcome-view).
     */
    switchToWelcome(session) {
        // Save isUserScrolledUp before leaving session mode (scroll position is
        // natively preserved by the browser on display:none containers).
        if (this.activeMode === 'session' && this.activeSession) {
            this.activeSession.isUserScrolledUp = this.ctx.scrollManager?.isUserScrolledUp ?? false;
        }

        this.activeMode = 'welcome';
        Storage.set(CONFIG.ACTIVE_MODE_KEY, 'welcome');

        // Toggle views
        this.els.sessionView?.classList.remove('active');
        document.getElementById('widget-views')?.classList.remove('active');
        this.els.welcomeView?.classList.add('active');

        // Welcome doesn't need an input area
        this.els.inputArea?.classList.add('hidden');
        this.els.connectionBar?.classList.remove('hidden-by-terminal');

        // Hide floating session widgets while in welcome
        WidgetManager.setSessionWidgetsVisible(false);

        // Render per-session welcome container
        this.ctx._app.renderWelcome(session);

        // Re-target scroll-aware components to the welcome container
        const scrollEl = this.ctx._app.getActiveScrollContainer();
        this.ctx._app.scrollManager?.setContainer(scrollEl);
        this.ctx._app.chatNavigator?.setScrollContainer?.(scrollEl);

        this.renderTabs();
    }

    // ═══════════════════════════════════════════════════════════════
    // WIDGET TAB MANAGEMENT
    // ═══════════════════════════════════════════════════════════════

    /**
     * Initialize widget tab event listeners
     */
    initWidgetTabEvents() {
        // Re-render tabs when favorites change (to show/hide favorite indicator)
        window.addEventListener('welcome:favorites-changed', () => this.renderTabs());

        // Listen for 'open as tab' requests from widgets
        WidgetBus.on('widget:open-as-tab', ({ widgetId, title, icon, filePath, background }) => {
            if (widgetId === 'terminal') {
                this.openTerminalWidgetTab({ transferFromFloating: true });
            } else if (widgetId === 'file-preview' && filePath) {
                this.openFilePreviewTab(filePath, title, { promoted: true, background });
            } else {
                this.openWidgetAsTab(widgetId, title, icon, { background });
            }
        });

        // Listen for file-preview navigating to a new file (update tab title/badge)
        WidgetBus.on('widget:file-changed', ({ widgetId, filePath, convertScratch }) => {
            if (widgetId === 'file-preview' && filePath) {
                // Convert scratch tab to file tab on Save As
                if (convertScratch) {
                    const scratchTab = this.widgetTabs.find(t => t.isScratch && t.id === this.activeWidgetTabId);
                    if (scratchTab) {
                        // Clean up scratch localStorage
                        if (scratchTab.scratchId) {
                            try { localStorage.removeItem(`claude-scratch-${scratchTab.scratchId}`); } catch (e) { /* ignore */ }
                        }
                        scratchTab.isScratch = false;
                        scratchTab.scratchId = null;
                        scratchTab.filePath = filePath;
                        scratchTab.title = basename(filePath);
                        scratchTab.icon = 'file';
                        this.renderTabs();
                        this.saveWidgetTabs();
                        return;
                    }
                }

                // Only update ephemeral preview tabs, not promoted ones
                const tab = this.widgetTabs.find(t => t.widgetId === 'file-preview' && !t.isScratch && t.isPreview);
                if (tab) {
                    tab.filePath = filePath;
                    tab.title = basename(filePath);
                    this.renderTabs();
                    this.saveWidgetTabs();
                }
            }
        });

        // Listen for widget tab close requests
        WidgetBus.on('widget:close-tab', ({ widgetId, keepScratch }) => {
            // Only close ephemeral preview tabs, not promoted ones
            const tab = this.widgetTabs.find(t => t.widgetId === widgetId && !(keepScratch && t.isScratch) && t.isPreview !== false);
            if (tab) {
                this.closeWidgetTab(tab.id);
            }
        });
    }

    /**
     * Open a new terminal as a widget tab
     * @param {Object} options
     * @param {boolean} options.transferFromFloating - Transfer existing floating terminal
     * @param {string} options.terminalSessionId - Existing terminal session ID (for reconnection)
     * @param {string} options.cwd - Working directory override
     * @param {string} options.title - Tab title override (e.g. "Login")
     * @param {string} options.icon - Tab icon override
     * @param {string} options.initialCommand - Command to type into the PTY once connected (include trailing \n)
     */
    openTerminalWidgetTab(options = {}) {
        const {
            transferFromFloating = false,
            terminalSessionId = null,
            cwd = null,
            title: titleOverride = null,
            icon: iconOverride = null,
            initialCommand = null,
        } = options;

        const termNum = TerminalWidget.getNextTabNumber();
        const title = titleOverride || `Terminal ${termNum}`;
        const icon = iconOverride || '>_';
        const tabId = `widget-terminal-${Date.now()}`;

        const tab = {
            id: tabId,
            widgetId: 'terminal',
            title: title,
            icon: icon,
            isTerminal: true,
            terminalSessionId: terminalSessionId  // Store for persistence
        };
        this.widgetTabs.push(tab);

        // Close floating widget if transferring
        if (transferFromFloating) {
            const widget = WidgetManager.get('terminal');
            if (widget) widget.close();
        }

        // Create container and render
        this.ensureWidgetViewContainer(tabId, 'terminal');

        const container = document.getElementById(`widget-view-${tabId}`);
        if (container) {
            const config = WidgetManager.configs.get('terminal');
            if (config?.render) {
                config.render(container, {
                    sessionId: this.activeSession?.storeId || null,
                    cwd: cwd || this.activeSession?.cwd || null,
                    isTab: true,
                    tabId: tabId,
                    transferFromFloating: transferFromFloating,
                    terminalSessionId: terminalSessionId,  // Pass for PTY reconnection
                    initialCommand: initialCommand  // One-shot command to type once PTY connects
                });
            }
        }

        this.switchToWidgetTab(tabId);
        this.renderTabs();
        this.saveWidgetTabs();

        return tabId;
    }

    /**
     * Open a scratch editor tab (Ctrl+N)
     */
    openScratchTab() {
        // Auto-increment name based on existing scratch tabs
        const scratchTabs = this.widgetTabs.filter(t => t.isScratch);
        const usedNumbers = scratchTabs.map(t => {
            const m = t.title?.match(/Untitled-(\d+)/);
            return m ? parseInt(m[1], 10) : 0;
        });
        let num = 1;
        while (usedNumbers.includes(num)) num++;

        const scratchId = `scratch-${Date.now()}`;
        const tabId = `widget-scratch-${Date.now()}`;
        const tab = {
            id: tabId,
            widgetId: 'file-preview',
            title: `Untitled-${num}`,
            icon: 'edit',
            isScratch: true,
            scratchId: scratchId
        };
        this.widgetTabs.push(tab);

        this.ensureWidgetViewContainer(tabId, 'file-preview');
        this.renderWidgetTabContent(tabId, 'file-preview', {
            isScratch: true,
            scratchId: scratchId,
            scratchName: tab.title
        });
        this.switchToWidgetTab(tabId);
        this.renderTabs();
        this.saveWidgetTabs();

        return tabId;
    }

    /**
     * Open file preview as a tab with specific file path
     * @param {string} filePath - The file path to preview
     * @param {string} title - Tab title (defaults to filename)
     * @param {Object} options - Options
     * @param {boolean} options.background - If true, don't switch to the tab
     */
    openFilePreviewTab(filePath, title, options = {}) {
        const { background = false, promoted = false, newTab = false } = options;
        const pinned = promoted || background || newTab;

        recordRecentOpen(filePath);

        // Close floating widget if open (always, whether creating or reusing tab)
        const floatingWidget = WidgetManager.get('file-preview');
        if (floatingWidget && floatingWidget.isVisible) floatingWidget.close();

        // Dedup: if a tab for this exact file already exists, reuse it instead
        // of creating a duplicate. Promote an ephemeral preview tab to pinned
        // if the caller asked for a full tab.
        const existingForPath = this.widgetTabs.find(t =>
            t.widgetId === 'file-preview' && !t.isScratch && t.filePath === filePath
        );
        if (existingForPath) {
            if (pinned && existingForPath.isPreview) existingForPath.isPreview = false;
            if (!background) this.switchToWidgetTab(existingForPath.id);
            this.renderTabs();
            this.saveWidgetTabs();
            return existingForPath.id;
        }

        // Only reuse the ephemeral preview tab for plain clicks (not promoted/background/newTab)
        if (!pinned) {
            const existing = this.widgetTabs.find(t => t.widgetId === 'file-preview' && !t.isScratch && t.isPreview);
            if (existing) {
                existing.filePath = filePath;
                existing.title = title || basename(filePath);
                this.switchToWidgetTab(existing.id);
                this.renderWidgetTabContent(existing.id, 'file-preview', { filePath });
                this.renderTabs();
                this.saveWidgetTabs();
                return existing.id;
            }
        }

        const tabId = `widget-file-preview-${Date.now()}`;
        const tab = {
            id: tabId,
            widgetId: 'file-preview',
            title: title || basename(filePath),
            icon: 'file',
            filePath: filePath,  // Store file path in tab data
            isPreview: !pinned  // Only plain-click tabs are ephemeral/reusable
        };
        this.widgetTabs.push(tab);

        // Save to localStorage for persistence
        try {
            localStorage.setItem('file-preview-path', filePath);
        } catch (e) { /* ignore */ }

        this.ensureWidgetViewContainer(tabId, 'file-preview');
        this.renderWidgetTabContent(tabId, 'file-preview', { filePath });
        if (!background) {
            this.switchToWidgetTab(tabId);
        }
        this.renderTabs();
        this.saveWidgetTabs();

        return tabId;
    }

    /**
     * Open a widget as a tab
     * @param {string} widgetId
     * @param {string} [title]
     * @param {string} [icon]
     * @param {Object} [options]
     * @param {boolean} [options.background] - If true, create the tab but don't switch to it
     */
    openWidgetAsTab(widgetId, title, icon, options = {}) {
        const { background = false } = options;
        // Check if already open
        const existing = this.widgetTabs.find(t => t.widgetId === widgetId);
        if (existing) {
            if (!background) this.switchToWidgetTab(existing.id);
            return;
        }

        // Close bottom-sheet widget if open
        const widget = WidgetManager.get(widgetId);
        if (widget) widget.close();

        const tabId = `widget-${widgetId}-${Date.now()}`;
        const tab = {
            id: tabId,
            widgetId: widgetId,
            title: title || widgetId,
            icon: icon || 'layers'
        };
        this.widgetTabs.push(tab);

        this.ensureWidgetViewContainer(tabId, widgetId);
        this.renderWidgetTabContent(tabId, widgetId);
        if (!background) this.switchToWidgetTab(tabId);
        this.renderTabs();
        this.saveWidgetTabs();
    }

    /**
     * Ensure widget view container exists
     */
    ensureWidgetViewContainer(tabId, widgetId) {
        let widgetViews = document.getElementById('widget-views');
        if (!widgetViews) {
            widgetViews = document.createElement('div');
            widgetViews.id = 'widget-views';
            widgetViews.className = 'view';
            document.getElementById('main-content').appendChild(widgetViews);
        }

        const container = document.createElement('div');
        container.id = `widget-view-${tabId}`;
        container.className = 'widget-tab-content';
        container.dataset.widgetId = widgetId;
        widgetViews.appendChild(container);

        return container;
    }

    /**
     * Render widget content into its tab container
     * @param {string} tabId - Tab identifier
     * @param {string} widgetId - Widget identifier
     * @param {Object} options - Additional options to pass to render
     * @param {string} options.filePath - File path (for file-preview)
     */
    renderWidgetTabContent(tabId, widgetId, options = {}) {
        const container = document.getElementById(`widget-view-${tabId}`);
        if (!container) return;

        const config = WidgetManager.configs.get(widgetId);
        if (config?.render) {
            config.render(container, {
                sessionId: this.activeSession?.storeId || null,
                cwd: this.activeSession?.cwd || null,
                isTab: true,
                tabId: tabId,
                ...options  // Pass through additional options like filePath
            });
        }
    }

    /**
     * Switch to a widget tab
     */
    switchToWidgetTab(tabId) {
        const tab = this.widgetTabs.find(t => t.id === tabId);
        if (!tab) return;

        // Save isUserScrolledUp BEFORE hiding session view.
        // Note: scrollPosition is natively preserved by the browser on display:none
        // elements (per-tab scroll architecture), so no manual save needed.
        if (this.activeMode === 'session' && this.activeSession) {
            this.activeSession.isUserScrolledUp = this.ctx.scrollManager?.isUserScrolledUp ?? false;
        }

        this.activeWidgetTabId = tabId;
        this.activeMode = 'widget';
        Storage.set(CONFIG.ACTIVE_MODE_KEY, 'widget');

        // Notify widget of tab activation (e.g. file-preview swaps per-instance state)
        WidgetBus.emit('widget:tab-activated', { widgetId: tab.widgetId, tabId });

        // Hide session's floating widgets so they don't overlap the tab content
        WidgetManager.setSessionWidgetsVisible(false);

        // Hide other views
        this.els.sessionView?.classList.remove('active');
        this.els.welcomeView?.classList.remove('active');

        // Show widget views container
        const widgetViews = document.getElementById('widget-views');
        if (widgetViews) {
            widgetViews.classList.add('active');
        }

        // Show active widget tab content
        document.querySelectorAll('.widget-tab-content').forEach(el => {
            el.classList.remove('active');
        });
        const container = document.getElementById(`widget-view-${tabId}`);
        if (container) {
            container.classList.add('active');
        }

        // Hide input area and connection bar (!important override prevents async re-show)
        this.els.inputArea?.classList.add('hidden');
        this.els.connectionBar?.classList.add('hidden-by-terminal');

        // Focus terminal if applicable
        if (tab.widgetId === 'terminal' || tab.isTerminal) {
            setTimeout(() => {
                const tabState = TerminalWidget.getTabState(tabId);
                if (tabState?.terminal) {
                    tabState.terminal.focus();
                    TerminalWidget.fit();
                }
            }, 50);
        }

        this.renderTabs();
        this.saveWidgetTabs();
        // Flush the active-tab pointer now (saveWidgetTabs' post is 500ms
        // debounced) — the server's activeTab is the first-choice restore
        // source on load, same rationale as the session-switch flush.
        this.sessionManager._postTabStateToServer({ immediate: true });
    }

    /**
     * Close a widget tab
     */
    async closeWidgetTab(tabId) {
        let index = this.widgetTabs.findIndex(t => t.id === tabId);
        if (index === -1) return;

        let tab = this.widgetTabs[index];

        // Warn before closing scratch with content — before any state cleanup,
        // so declining leaves the tab fully intact
        if (tab.isScratch && tab.scratchId) {
            let hasContent = false;
            try {
                const raw = localStorage.getItem(`claude-scratch-${tab.scratchId}`);
                if (raw) {
                    const saved = JSON.parse(raw);
                    hasContent = !!(saved.content && saved.content.trim());
                }
            } catch (e) { /* ignore */ }
            if (hasContent) {
                const ok = await appConfirm(S.widgets.file_preview.discard_scratch_confirm, { confirmLabel: 'Discard', danger: true });
                if (!ok) return;
                // Re-resolve after the async gap — the strip may have changed
                index = this.widgetTabs.findIndex(t => t.id === tabId);
                if (index === -1) return;
                tab = this.widgetTabs[index];
            }
            try {
                localStorage.removeItem(`claude-scratch-${tab.scratchId}`);
            } catch (e) { /* ignore */ }
        }

        // Cleanup terminal state
        if (tab.widgetId === 'terminal' || tab.isTerminal) {
            TerminalWidget.removeTabState(tabId);
        }

        // Cleanup file-preview state (editor, etc.)
        if (tab.widgetId === 'file-preview') {
            FilePreviewWidget.removeTabState(tabId);
        }

        // Snapshot reopenable tabs (currently only file-preview — terminals carry
        // PTY state, scratch content was just confirmed-discarded above).
        if (tab.widgetId === 'file-preview' && tab.filePath && !tab.isScratch) {
            this.recentlyClosedTabs.push({
                type: 'widget',
                widgetId: tab.widgetId,
                filePath: tab.filePath,
                title: tab.title,
                isPreview: tab.isPreview ?? true,
                // Strip slot, so reopen lands where it was closed from instead of
                // appending at the end (creation APIs always append).
                stripIndex: this.getTabPosition('widget', tabId).index,
                closedAt: new Date().toISOString(),
            });
            if (this.recentlyClosedTabs.length > this._maxRecentlyClosedTabs) {
                this.recentlyClosedTabs.shift();
            }
        }

        // Resolve the successor while the closing tab is still in the strip —
        // pickSuccessorTab() reads visual order, so it must run before the splice.
        const wasActive = this.activeWidgetTabId === tabId;
        const successor = wasActive ? this.pickSuccessorTab('widget', tabId) : null;

        this.widgetTabs.splice(index, 1);

        // Remove container
        document.getElementById(`widget-view-${tabId}`)?.remove();

        // Hand focus to the strip's left neighbour (may be a session tab)
        if (wasActive) {
            if (successor) {
                // Drop the dead id first: if the successor is a session tab,
                // switchToSession leaves activeWidgetTabId alone and a stale one
                // would keep matching in renderTabs/getCurrentTabIndex.
                this.activeWidgetTabId = null;
                this.activateTab(successor);
            } else {
                this.activeWidgetTabId = null;
                this.activeMode = 'session';
                Storage.set(CONFIG.ACTIVE_MODE_KEY, 'session');
                this.els.sessionView?.classList.add('active');
                this.els.welcomeView?.classList.remove('active');
                document.getElementById('widget-views')?.classList.remove('active');
                this.els.inputArea?.classList.remove('hidden');
                this.els.connectionBar?.classList.remove('hidden-by-terminal');
                // Restore scroll position for active session
                this.ctx._app.restoreScrollPosition();
            }
        }

        this.renderTabs();
        this.saveWidgetTabs();
    }

    // ═══════════════════════════════════════════════════════════════
    // WIDGET TAB PERSISTENCE
    // ═══════════════════════════════════════════════════════════════

    /**
     * Serialize widget tabs for persistence (localStorage + server payload).
     */
    serializeWidgetTabs() {
        return this.widgetTabs.map(t => {
            const tabData = {
                id: t.id,
                widgetId: t.widgetId,
                title: t.title,
                icon: t.icon,
                isTerminal: t.isTerminal || false
            };
            // For terminals, save the sessionId to enable reconnection to existing PTY
            if (t.isTerminal) {
                const termState = TerminalWidget.getTabState(t.id);
                if (termState?.sessionId) {
                    tabData.terminalSessionId = termState.sessionId;
                }
            }
            // For scratch tabs, save scratch metadata
            if (t.isScratch) {
                tabData.isScratch = true;
                tabData.scratchId = t.scratchId;
            }
            // For file-preview tabs, save the current file path and preview state
            // Use tab's stored filePath first, then localStorage as fallback
            if (t.widgetId === 'file-preview' && !t.isScratch) {
                const savedPath = t.filePath || localStorage.getItem('file-preview-path');
                if (savedPath) {
                    tabData.filePath = savedPath;
                }
                tabData.isPreview = t.isPreview ?? true;
            }
            return tabData;
        });
    }

    /**
     * Save widget tabs to localStorage and mirror to the server
     * (same iPadOS write-loss protection as session tabs).
     */
    saveWidgetTabs() {
        debug.log('[TabController] saveWidgetTabs called, tabs:', this.widgetTabs.map(t => t.id));
        const data = {
            tabs: this.serializeWidgetTabs(),
            activeTabId: this.activeWidgetTabId
        };
        Storage.set(CONFIG.WIDGET_TABS_KEY, data);
        this._saveTabOrder();
        this.sessionManager._postTabStateToServer();
    }

    /**
     * Restore widget tabs — from server state when available (server wins,
     * matching session reconciliation), else from localStorage.
     * @param {Object} [serverState] - v2 /api/app/tabs response
     * @returns {boolean} True if widget tabs were restored
     */
    restoreWidgetTabs(serverState = null) {
        let saved;
        if (serverState && Array.isArray(serverState.widgetTabs)) {
            // Server has a v2 record (key present) — it is the source of truth,
            // even when empty (widget tabs may have been closed on another device).
            saved = {
                tabs: serverState.widgetTabs,
                activeTabId: serverState.activeTab?.kind === 'widget' ? serverState.activeTab.id : null,
            };
            debug.log('[TabController] restoreWidgetTabs from server:', saved.tabs.length, 'tabs');
        } else {
            saved = Storage.get(CONFIG.WIDGET_TABS_KEY);
            debug.log('[TabController] restoreWidgetTabs from localStorage:', saved);
        }
        // From here on widget tabs are live (or there are none), so
        // _syncTabOrder may prune widget entries again — see the constructor.
        this._widgetTabsRestored = true;
        if (!saved?.tabs?.length) return false;

        for (const tabData of saved.tabs) {
            // Skip removed widget types
            if (tabData.widgetId === 'file-editor') continue;
            // Skip file-browser tabs (mode removed 2026-04-19)
            if (tabData.widgetId === 'file-explorer' && tabData.isFileBrowser) continue;

            // Recreate the tab
            const tab = {
                id: tabData.id,
                widgetId: tabData.widgetId,
                title: tabData.title,
                icon: tabData.icon,
                isTerminal: tabData.isTerminal,
                terminalSessionId: tabData.terminalSessionId || null,
                filePath: tabData.filePath || null,
                isPreview: tabData.isPreview ?? true,
                isScratch: tabData.isScratch || false,
                scratchId: tabData.scratchId || null
            };
            this.widgetTabs.push(tab);

            // Create container
            this.ensureWidgetViewContainer(tab.id, tab.widgetId);

            // For file-preview tabs, ensure the path is in localStorage before rendering
            if (tab.widgetId === 'file-preview' && tab.filePath) {
                try {
                    localStorage.setItem('file-preview-path', tab.filePath);
                } catch (e) { /* ignore */ }
            }

            // Render widget content
            const container = document.getElementById(`widget-view-${tab.id}`);
            if (container) {
                const config = WidgetManager.configs.get(tab.widgetId);
                if (config?.render) {
                    const renderCtx = {
                        sessionId: this.activeSession?.storeId || null,
                        cwd: this.activeSession?.cwd || null,
                        isTab: true,
                        tabId: tab.id,
                        // Pass terminal sessionId for PTY reconnection
                        terminalSessionId: tab.terminalSessionId,
                        // Pass file path for file-preview restoration
                        filePath: tab.filePath
                    };
                    // Pass scratch context for scratch tab restoration
                    if (tab.isScratch) {
                        renderCtx.isScratch = true;
                        renderCtx.scratchId = tab.scratchId;
                        renderCtx.scratchName = tab.title;
                    }
                    config.render(container, renderCtx);
                }
            }
        }

        // Restore active tab ID (don't switch yet - caller will handle that)
        if (saved.activeTabId && this.widgetTabs.find(t => t.id === saved.activeTabId)) {
            this.activeWidgetTabId = saved.activeTabId;
        } else if (this.widgetTabs.length > 0) {
            this.activeWidgetTabId = this.widgetTabs[0].id;
        }

        // Save cleaned-up state (removes skipped/removed widget tabs)
        if (this.widgetTabs.length !== saved.tabs.length) {
            this.saveWidgetTabs();
        }

        return this.widgetTabs.length > 0;
    }


    // ═══════════════════════════════════════════════════════════════
    // TAB RENDERING
    // ═══════════════════════════════════════════════════════════════

    /**
     * Scroll the active tab into view (centered if possible)
     */
    scrollActiveTabIntoView() {
        const tabsContainer = this.els.tabs;
        const activeTab = tabsContainer?.querySelector('.tab.active');
        if (!activeTab || !tabsContainer) return;

        // Get the tab's position relative to the scrollable container
        const containerRect = tabsContainer.getBoundingClientRect();
        const tabRect = activeTab.getBoundingClientRect();

        // Calculate visible bounds (the tab's position relative to container's viewport)
        const tabLeftRelative = tabRect.left - containerRect.left + tabsContainer.scrollLeft;
        const tabRightRelative = tabLeftRelative + tabRect.width;
        const visibleLeft = tabsContainer.scrollLeft;
        const visibleRight = tabsContainer.scrollLeft + tabsContainer.clientWidth;

        // Check if tab is fully visible
        if (tabLeftRelative >= visibleLeft && tabRightRelative <= visibleRight) {
            return; // Already visible
        }

        // Calculate scroll position to center the tab
        const tabCenterRelative = tabLeftRelative + tabRect.width / 2;
        const targetScroll = tabCenterRelative - tabsContainer.clientWidth / 2;

        // Clamp to valid scroll range
        const maxScroll = tabsContainer.scrollWidth - tabsContainer.clientWidth;
        const clampedScroll = Math.max(0, Math.min(targetScroll, maxScroll));

        tabsContainer.scrollTo({
            left: clampedScroll,
            behavior: 'smooth'
        });
    }

    /**
     * Open the all-sessions grid switcher (iPad-style card grid).
     * Triggered by the desktop header button, the mobile rail-drawer button,
     * or the Alt+Tab shortcut.
     */
    toggleTabsOverview() {
        this.ctx._app?.toggleGridSwitcher?.();
    }

    /**
     * Pin affordance for a tab: the `is-pinned` root class plus a clickable
     * pin glyph that unpins. Rendered for both session and widget tabs so the
     * whole strip behaves the same.
     * @returns {{cls: string, btn: string}}
     * @private
     */
    _pinDecor(kind, id) {
        if (!this.isTabPinned(kind, id)) return { cls: '', btn: '' };
        return {
            cls: ' is-pinned',
            btn: `<span class="tab-pin-btn" data-unpin="${id}" data-unpin-kind="${kind}"`
                + ` data-tooltip="${escapeHtml(S.context_menus.tab.unpin_hint)}">`
                + `${ICONS.pin || ''}</span>`,
        };
    }

    /**
     * Render a single session tab
     * @private
     */
    _renderSessionTab(session) {
        const isActive = (this.activeMode === 'session' || this.activeMode === 'welcome')
            && session === this.activeSession;
        // Show name (truncated if long)
        const displayName = session.name.length > 30
            ? session.name.slice(0, 30) + '...'
            : session.name;
        // Tooltip shows full name + cwd (relative with ~)
        const cwdShort = session.cwd?.replace(/^\/home\/[^/]+\//, '~/') || session.cwd;
        const tooltip = `${session.name} - ${cwdShort}`;
        // Process status: running-claude, running-shadowgit, or empty
        const processStatus = session.processStatusClass || '';
        // Pending question indicator
        const hasPendingQuestion = session.hasPendingQuestion;
        const pendingType = session.pendingQuestionType;
        const badgeClass = pendingType === 'plan_approval' ? 'plan-badge'
            : pendingType === 'permission' ? 'permission-badge' : '';
        const badgeTooltip = pendingType === 'plan_approval' ? S.tab_badges.plan
            : pendingType === 'permission' ? S.tab_badges.permission : S.tab_badges.question;
        const badgeGlyph = pendingType === 'permission' ? '!' : '?';
        const isFav = session.storeId && isFavoriteSession(session.storeId);
        const isWorktree = session.isWorktree;
        const wtSubtitle = isWorktree ? `<span class="wt-tab-subtitle">${escapeHtml(session.worktreeName || '')}</span>` : '';
        const pin = this._pinDecor('session', session.id);
        return `
            <div class="tab tab-session ${isActive ? 'active' : ''} ${session.unread ? 'unread' : ''} ${hasPendingQuestion ? 'has-question' : ''} ${isFav ? 'is-favorite' : ''} ${isWorktree ? 'is-worktree' : ''}${pin.cls}"
                 data-type="session" data-id="${session.id}" data-tooltip="${escapeHtml(tooltip)}"${projectColorStyle(session.cwd)}>
                <span class="status-dot ${processStatus}"></span>
                <span class="tab-name">${escapeHtml(displayName)}${wtSubtitle}</span>
                ${hasPendingQuestion ? `<span class="question-badge ${badgeClass}" data-tooltip="${escapeHtml(badgeTooltip)}">${badgeGlyph}</span>` : ''}
                <span class="unread-dot"></span>
                ${pin.btn}
                <span class="close-btn" data-close="${session.id}">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M18 6L6 18M6 6l12 12"/>
                    </svg>
                </span>
            </div>
        `;
    }

    /**
     * Render a single widget tab
     * @private
     */
    _renderWidgetTab(tab) {
        const isActive = this.activeMode === 'widget' && tab.id === this.activeWidgetTabId;
        const pin = this._pinDecor('widget', tab.id);

        // Scratch tabs get pencil icon and italic name
        if (tab.isScratch) {
            const iconSvg = ICONS.edit || '';
            return `
            <div class="tab tab-widget tab-scratch ${isActive ? 'active' : ''}${pin.cls}"
                 data-type="widget" data-id="${tab.id}" data-tooltip="Scratch editor">
                <span class="file-icon widget-icon">${iconSvg}</span>
                <span class="tab-name">${escapeHtml(tab.title)}</span>
                ${pin.btn}
                <span class="close-btn" data-close="${tab.id}">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M18 6L6 18M6 6l12 12"/>
                    </svg>
                </span>
            </div>
            `;
        }

        // File-preview tabs get language badge like editor tabs
        if (tab.widgetId === 'file-preview' && tab.filePath) {
            const lang = detectLanguage(tab.filePath);
            const icon = getLanguageIcon(lang);
            const fileName = basename(tab.filePath);
            return `
            <div class="tab tab-file ${isActive ? 'active' : ''}${pin.cls}"
                 data-type="widget" data-id="${tab.id}" data-tooltip="${escapeHtml(tab.filePath)}">
                <span class="file-icon">${escapeHtml(icon)}</span>
                <span class="tab-name">${escapeHtml(fileName)}</span>
                ${pin.btn}
                <span class="close-btn" data-close="${tab.id}">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M18 6L6 18M6 6l12 12"/>
                    </svg>
                </span>
            </div>
            `;
        }

        const iconSvg = ICONS[tab.icon] || ICONS.layers || '';
        return `
            <div class="tab tab-widget ${isActive ? 'active' : ''}${pin.cls}"
                 data-type="widget" data-id="${tab.id}" data-tooltip="${escapeHtml(tab.title)}">
                <span class="file-icon widget-icon">${iconSvg}</span>
                <span class="tab-name">${escapeHtml(tab.title)}</span>
                ${pin.btn}
                <span class="close-btn" data-close="${tab.id}">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M18 6L6 18M6 6l12 12"/>
                    </svg>
                </span>
            </div>
        `;
    }

    /**
     * Render all tabs (sessions + files + widgets) in unified strip order
     */
    renderTabs() {
        const tabsHtml = this.getAllTabs().map(t => {
            if (!t.data) return '';
            return t.type === 'session'
                ? this._renderSessionTab(t.data)
                : this._renderWidgetTab(t.data);
        }).join('');

        this._saveTabOrder();

        // Only the tabs live inside the scroll strip. The overflow indicators
        // are static overlays in .tabs-viewport (a sibling of #tabs) — they are
        // NOT re-created here, so rebuilding #tabs never disturbs them and
        // toggling them never changes this strip's scrollWidth.
        this.els.tabs.innerHTML = tabsHtml;

        // Install delegated event handlers ONCE on the tabs container
        // (survives innerHTML replacement — no per-element listeners needed)
        this._installTabDelegation();

        // Scroll active tab into view (after DOM is updated and layout computed)
        // Double-rAF ensures layout is complete, especially on initial page load.
        // The overlays don't affect layout, so update order vs. scroll is moot.
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                this.updateOverflowIndicator();
                this.scrollActiveTabIntoView();
            });
        });
    }

    /**
     * Install delegated event handlers on the tabs container (once only).
     * All tab click, touch, and overflow events are handled via event delegation
     * so renderTabs() can safely replace innerHTML without leaking listeners.
     * @private
     */
    _installTabDelegation() {
        if (this._tabDelegationInstalled) return;
        this._tabDelegationInstalled = true;

        const tabsEl = this.els.tabs;

        // Header overview button (lives in <header>, not inside #tabs)
        const headerOverviewBtn = document.querySelector('.header-overview-btn');
        if (headerOverviewBtn) {
            headerOverviewBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.toggleTabsOverview(headerOverviewBtn);
            });
        }

        // Overflow indicators (overlay siblings in .tabs-viewport, not inside
        // #tabs — so their clicks are wired directly, not via #tabs delegation).
        const viewport = this.els.tabsViewport || tabsEl.parentElement;
        viewport?.querySelector('.tabs-overflow-left')?.addEventListener('click', (e) => {
            e.stopPropagation();
            tabsEl.scrollBy({ left: -tabsEl.clientWidth * 0.8, behavior: 'smooth' });
        });
        viewport?.querySelector('.tabs-overflow-right')?.addEventListener('click', (e) => {
            e.stopPropagation();
            tabsEl.scrollBy({ left: tabsEl.clientWidth * 0.8, behavior: 'smooth' });
        });

        // ── Click delegation ──
        tabsEl.addEventListener('click', (e) => {
            // Swallow the click that trails a completed drag-reorder. The
            // browser dispatches it within a few ms of pointerup, so the
            // window is short — a deliberate follow-up click must not be eaten.
            if (this._suppressClickUntil) {
                const trailing = Date.now() < this._suppressClickUntil;
                this._suppressClickUntil = 0;
                if (trailing) {
                    e.stopPropagation();
                    return;
                }
            }

            // Tab click
            const tabEl = e.target.closest('.tab');
            if (!tabEl) return;

            const tabType = tabEl.dataset.type;
            const tabId = tabEl.dataset.id;

            const unpinBtn = e.target.closest('.tab-pin-btn');
            if (unpinBtn) {
                // Clicking the pin glyph unpins, without activating the tab.
                e.stopPropagation();
                this.toggleTabPin(unpinBtn.dataset.unpinKind, unpinBtn.dataset.unpin, false);
                return;
            }

            if (e.target.closest('.close-btn')) {
                const closeId = e.target.closest('.close-btn').dataset.close;
                if (tabType === 'session') {
                    const session = this.sessionManager.get(closeId);
                    if (session) this.ctx._app.closeSession(session);
                } else if (tabType === 'widget') {
                    this.closeWidgetTab(closeId);
                }
            } else {
                if (tabType === 'session') {
                    const session = this.sessionManager.get(tabId);
                    if (session) this.switchToSession(session);
                } else if (tabType === 'widget') {
                    this.switchToWidgetTab(tabId);
                }
            }
        });

        // ── Drag-to-reorder (mouse / trackpad) ──
        this._installMouseDrag(tabsEl);

        // ── Long-press delegation (touch devices) ──
        // Hold 400ms to "pick up" the tab. Then: drag horizontally to
        // reorder, or release without moving to open the context menu.
        let pressTimer = null;
        let clickBlocker = null;
        let touchTab = null;
        let touchArmed = false;    // long-press fired — tab picked up
        let touchDragged = false;  // armed + moved — reordering
        let touchStartX = 0;

        const removeClickBlocker = () => {
            if (clickBlocker) {
                document.removeEventListener('click', clickBlocker, { capture: true });
                clickBlocker = null;
            }
        };

        const installClickBlocker = () => {
            clickBlocker = (evt) => {
                evt.preventDefault();
                evt.stopPropagation();
                evt.stopImmediatePropagation();
                // Auto-remove after one use to prevent leaks
                removeClickBlocker();
            };
            document.addEventListener('click', clickBlocker, { capture: true, once: true });
        };

        const resetTouchDrag = () => {
            if (pressTimer) {
                clearTimeout(pressTimer);
                pressTimer = null;
            }
            touchTab?.classList.remove('dragging');
            touchTab = null;
            touchArmed = false;
            touchDragged = false;
        };

        tabsEl.addEventListener('touchstart', (e) => {
            const tabEl = e.target.closest('.tab');
            if (!tabEl) return;

            // Clean up any existing blocker from previous interaction
            removeClickBlocker();
            touchTab = tabEl;
            touchArmed = false;
            touchDragged = false;
            touchStartX = e.touches[0].clientX;

            pressTimer = setTimeout(() => {
                pressTimer = null;
                touchArmed = true;
                tabEl.classList.add('dragging');
            }, 400);
        }, { passive: true });

        tabsEl.addEventListener('touchmove', (e) => {
            if (touchArmed && touchTab) {
                // Picked up — reorder instead of scrolling the strip
                e.preventDefault();
                touchDragged = true;
                this._dragReposition(tabsEl, touchTab, e.touches[0].clientX);
                return;
            }
            // Moving before the long-press fires = scroll; cancel the pick-up
            if (pressTimer) {
                clearTimeout(pressTimer);
                pressTimer = null;
            }
        }, { passive: false });

        tabsEl.addEventListener('touchend', (e) => {
            const tabEl = touchTab;
            const wasArmed = touchArmed;
            const wasDragged = touchDragged;
            resetTouchDrag();
            if (!tabEl || !wasArmed) return;

            // Swallow the synthetic click that follows the long-press
            e.preventDefault();
            e.stopPropagation();
            installClickBlocker();
            setTimeout(removeClickBlocker, 400);

            if (wasDragged) {
                // Trailing synthetic click is covered by preventDefault + the
                // one-shot click blocker above
                this.applyDomOrder();
            } else {
                // Long-press without movement — context menu
                const rect = tabEl.getBoundingClientRect();
                const items = this.ctx._app.buildTabContextMenu(tabEl);
                if (items.length > 0) {
                    this.ctx._app.contextMenu.show(touchStartX, rect.bottom + 4, items);
                }
            }
        }, { passive: false });

        tabsEl.addEventListener('touchcancel', () => {
            resetTouchDrag();
        }, { passive: true });

        // ── Scroll listener for overflow indicator ──
        tabsEl.addEventListener('scroll', () => {
            this.updateOverflowIndicator();
        });
    }

    /**
     * Install pointer-based drag-to-reorder for mouse/trackpad (touch has its
     * own long-press path). A small threshold distinguishes drag from click;
     * the trailing click is suppressed via _suppressClickUntil.
     * @private
     */
    _installMouseDrag(tabsEl) {
        let candidate = null;
        let dragging = false;
        let startX = 0;
        let startY = 0;

        const onMove = (e) => {
            if (!candidate) return;
            if (!dragging) {
                if (Math.abs(e.clientX - startX) < 6 && Math.abs(e.clientY - startY) < 6) return;
                dragging = true;
                candidate.classList.add('dragging');
                tabsEl.classList.add('tabs-drag-active');
            }
            this._dragReposition(tabsEl, candidate, e.clientX);
        };

        const onUp = () => {
            document.removeEventListener('pointermove', onMove);
            document.removeEventListener('pointerup', onUp);
            document.removeEventListener('pointercancel', onUp);
            if (dragging && candidate) {
                candidate.classList.remove('dragging');
                tabsEl.classList.remove('tabs-drag-active');
                this._suppressClickUntil = Date.now() + 150;
                this.applyDomOrder();
            }
            candidate = null;
            dragging = false;
        };

        tabsEl.addEventListener('pointerdown', (e) => {
            // Touch is handled by the long-press path; ignore non-primary buttons
            if (e.pointerType === 'touch' || e.button !== 0) return;
            const tabEl = e.target.closest('.tab');
            if (!tabEl || e.target.closest('.close-btn')) return;
            candidate = tabEl;
            dragging = false;
            startX = e.clientX;
            startY = e.clientY;
            document.addEventListener('pointermove', onMove);
            document.addEventListener('pointerup', onUp);
            document.addEventListener('pointercancel', onUp);
        });
    }

    /**
     * Update the overflow indicators showing count of hidden tabs on each side
     */
    updateOverflowIndicator() {
        const tabsContainer = this.els.tabs;
        if (!tabsContainer) return;
        // Indicators are overlay siblings in .tabs-viewport, not children of #tabs.
        const viewport = this.els.tabsViewport || tabsContainer.parentElement;
        const leftInd = viewport?.querySelector('.tabs-overflow-left');
        const rightInd = viewport?.querySelector('.tabs-overflow-right');
        if (!leftInd && !rightInd) return;

        // Get all tab elements (not the overview button or separators)
        const tabs = tabsContainer.querySelectorAll('.tab');

        // Short-circuit: if there's no actual overflow (or no tabs), hide both
        // indicators. Required because #tabs is now `flex: 0 1 auto` and often
        // sizes exactly to content — otherwise the per-tab measurement below
        // can flag tabs as hidden purely from sub-pixel/coordinate drift.
        const hasOverflow = tabsContainer.scrollWidth - tabsContainer.clientWidth > 1;
        if (tabs.length === 0 || !hasOverflow) {
            if (leftInd) leftInd.style.display = 'none';
            if (rightInd) rightInd.style.display = 'none';
            return;
        }

        // Count tabs hidden on each side (20px tolerance for partial visibility).
        // Use getBoundingClientRect() — viewport coords work regardless of which
        // ancestor is `offsetParent` (#tabs is position:static so offsetLeft is
        // measured from <body>, which broke the comparison previously).
        const containerRect = tabsContainer.getBoundingClientRect();
        let hiddenLeft = 0;
        let hiddenRight = 0;
        tabs.forEach(tab => {
            const r = tab.getBoundingClientRect();
            if (r.right < containerRect.left + 20) hiddenLeft++;
            if (r.left > containerRect.right - 20) hiddenRight++;
        });

        if (leftInd) {
            if (hiddenLeft > 0) {
                leftInd.textContent = `+${hiddenLeft}`;
                leftInd.style.display = 'flex';
            } else {
                leftInd.style.display = 'none';
            }
        }
        if (rightInd) {
            if (hiddenRight > 0) {
                rightInd.textContent = `+${hiddenRight}`;
                rightInd.style.display = 'flex';
            } else {
                rightInd.style.display = 'none';
            }
        }
    }

    /**
     * Close active tab (for keyboard shortcut)
     */
    closeActiveTab() {
        if (this.activeMode === 'widget' && this.activeWidgetTabId) {
            this.closeWidgetTab(this.activeWidgetTabId);
        }
    }
}
