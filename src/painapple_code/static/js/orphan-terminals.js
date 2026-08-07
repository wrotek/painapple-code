import S from './strings.js';
/**
 * Orphaned Terminals Manager
 *
 * Handles detection, display, and reconnection of orphaned terminal sessions
 * (PTY processes running on server without active WebSocket connections)
 */

import { CONFIG, debug } from './config.js';
import { TerminalWidget } from './widget-system/init.js';
import { escapeHtml, appConfirm } from './utils.js';
import { showToast } from './context-menu.js';

class OrphanTerminalsManager {
    constructor() {
        this.btn = null;
        this.badge = null;
        this.dropdown = null;
        this.list = null;
        this.bulkActions = null;
        this.orphans = [];
        this.isOpen = false;
    }

    /**
     * Initialize the orphan terminals UI
     */
    init() {
        this.btn = document.getElementById('orphan-terminals-btn');
        this.badge = document.getElementById('orphan-badge');
        this.dropdown = document.getElementById('orphan-dropdown');
        this.list = document.getElementById('orphan-list');
        this.bulkActions = document.getElementById('orphan-bulk-actions');
        const refreshBtn = document.getElementById('orphan-refresh-btn');
        const tabAllBtn = document.getElementById('orphan-tab-all-btn');
        const killAllBtn = document.getElementById('orphan-kill-all-btn');

        if (!this.btn || !this.dropdown) {
            console.warn('Orphan terminals UI elements not found');
            return;
        }

        // Toggle dropdown on button click
        this.btn.addEventListener('click', (e) => {
            // Don't toggle if clicking inside dropdown
            if (e.target.closest('.orphan-terminals-dropdown')) {
                return;
            }
            this.toggle();
        });

        // Refresh button
        if (refreshBtn) {
            refreshBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.refresh();
            });
        }

        // Tab All button
        if (tabAllBtn) {
            tabAllBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.tabAll();
            });
        }

        // Kill All button
        if (killAllBtn) {
            killAllBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.killAll();
            });
        }

        // Close on outside click
        document.addEventListener('click', (e) => {
            if (this.isOpen && !this.btn.contains(e.target)) {
                this.close();
            }
        });

        // Close on Escape
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.isOpen) {
                this.close();
            }
        });

        // Initial check
        this.refresh();

        // Periodic refresh every 30 seconds
        setInterval(() => this.refreshBadge(), 30000);
    }

    /**
     * Toggle dropdown visibility
     */
    toggle() {
        if (this.isOpen) {
            this.close();
        } else {
            this.open();
        }
    }

    /**
     * Open the dropdown
     */
    open() {
        this.isOpen = true;
        this.dropdown.classList.add('visible');
        this.refresh();
    }

    /**
     * Close the dropdown
     */
    close() {
        this.isOpen = false;
        this.dropdown.classList.remove('visible');
    }

    /**
     * Refresh the orphaned terminals list
     */
    async refresh() {
        try {
            const orphans = await this.fetchOrphans();
            this.orphans = orphans;
            this.updateBadge();
            this.renderList();
        } catch (err) {
            console.error('Failed to fetch orphaned terminals:', err);
            this.list.innerHTML = `<div class="orphan-dropdown-empty">${S.orphan_terminals.failed_load}</div>`;
        }
    }

    /**
     * Just refresh the badge count (lightweight)
     */
    async refreshBadge() {
        try {
            const orphans = await this.fetchOrphans();
            this.orphans = orphans;
            this.updateBadge();
        } catch (err) {
            // Silently fail for background refresh
        }
    }

    /**
     * Fetch orphaned terminals from server
     * @returns {Promise<Array>} List of orphaned terminal sessions
     */
    async fetchOrphans() {
        const response = await fetch(`${CONFIG.API_BASE}/api/terminals`);
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        const data = await response.json();
        const serverTerminals = data.terminals || [];

        // Get currently connected terminal session IDs
        const connectedIds = this.getConnectedSessionIds();

        // Filter to only orphaned ones (not connected by any tab)
        return serverTerminals.filter(t => !connectedIds.has(t.session));
    }

    /**
     * Get session IDs of all currently connected terminals
     * @returns {Set<string>}
     */
    getConnectedSessionIds() {
        const ids = new Set();

        // Get tab terminal session IDs
        const tabIds = TerminalWidget.getTabIds();
        for (const tabId of tabIds) {
            const state = TerminalWidget.getTabState(tabId);
            if (state?.sessionId) {
                ids.add(state.sessionId);
            }
        }

        // Get floating terminal session ID if exists
        // Note: Floating terminal uses a different state access pattern
        // We'll check via the floating state export if available

        return ids;
    }

    /**
     * Update the badge count and bulk actions visibility
     */
    updateBadge() {
        const count = this.orphans.filter(t => t.alive).length;
        if (this.badge) {
            this.badge.textContent = count > 0 ? count : '';
            this.badge.dataset.count = count;
        }
        // Show bulk actions only when there are orphans
        if (this.bulkActions) {
            this.bulkActions.style.display = this.orphans.length > 0 ? 'flex' : 'none';
        }
    }

    /**
     * Render the orphaned terminals list
     */
    renderList() {
        if (!this.list) return;

        if (this.orphans.length === 0) {
            this.list.innerHTML = `<div class="orphan-dropdown-empty">${S.orphan_terminals.empty}</div>`;
            return;
        }

        this.list.innerHTML = this.orphans.map(term => `
            <div class="orphan-terminal-item" data-session="${escapeHtml(term.session)}">
                <div class="orphan-terminal-info">
                    <span class="orphan-terminal-pid">PID ${term.pid || '?'}</span>
                    <span class="orphan-terminal-status ${term.alive ? '' : 'dead'}">
                        ${term.alive ? 'running' : 'dead'}
                    </span>
                </div>
                <div class="orphan-terminal-cwd" data-tooltip="${escapeHtml(term.cwd || '')}">${escapeHtml(term.cwd || 'unknown')}</div>
                <div class="orphan-terminal-actions">
                    ${term.alive ? `
                        <button class="attach-btn" data-action="tab">Tab</button>
                        <button class="float-btn" data-action="float">Float</button>
                    ` : ''}
                    <button class="kill-btn" data-action="kill">Kill</button>
                </div>
            </div>
        `).join('');

        // Add click handlers
        this.list.querySelectorAll('.orphan-terminal-item').forEach(item => {
            item.querySelectorAll('button').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const action = btn.dataset.action;
                    const session = item.dataset.session;
                    if (action === 'tab') {
                        this.attachToTab(session);
                    } else if (action === 'float') {
                        this.attachToFloat(session);
                    } else if (action === 'kill') {
                        this.killTerminal(session);
                    }
                });
            });
        });
    }

    /**
     * Attach to an orphaned terminal by creating a new tab with its session ID
     * @param {string} sessionId - The terminal session ID to attach to
     */
    attachToTab(sessionId) {
        const term = this.orphans.find(t => t.session === sessionId);
        if (!term) return;

        // Create a new terminal tab with this session ID
        if (window.app?.tabCtrl) {
            const tabId = window.app.tabCtrl.openTerminalWidgetTab({
                terminalSessionId: sessionId,
                cwd: term.cwd
            });
            debug.log(`Attached to orphaned terminal ${sessionId} as tab ${tabId}`);
        }

        this.close();
        this.refresh();
    }

    /**
     * Attach to an orphaned terminal in the floating panel
     * @param {string} sessionId - The terminal session ID to attach to
     */
    attachToFloat(sessionId) {
        const term = this.orphans.find(t => t.session === sessionId);
        if (!term) return;

        // Attach to floating terminal with this session ID
        TerminalWidget.attachToSession(sessionId, term.cwd);
        debug.log(`Attached to orphaned terminal ${sessionId} in floating panel`);

        this.close();
        this.refresh();
    }

    /**
     * Kill an orphaned terminal
     * @param {string} sessionId - The terminal session ID to kill
     */
    async killTerminal(sessionId) {
        try {
            const response = await fetch(`${CONFIG.API_BASE}/api/terminal/${encodeURIComponent(sessionId)}`, {
                method: 'DELETE'
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            debug.log(`Killed orphaned terminal: ${sessionId}`);
            this.refresh();
        } catch (err) {
            console.error('Failed to kill terminal:', err);
            alert(S.orphan_terminals.kill_failed.replace('{error}', err.message));
        }
    }

    /**
     * Open all alive orphaned terminals in tabs
     */
    tabAll() {
        const aliveOrphans = this.orphans.filter(t => t.alive);
        if (aliveOrphans.length === 0) return;

        for (const term of aliveOrphans) {
            if (window.app?.tabCtrl) {
                window.app.tabCtrl.openTerminalWidgetTab({
                    terminalSessionId: term.session,
                    cwd: term.cwd
                });
            }
        }

        debug.log(`Opened ${aliveOrphans.length} orphaned terminals as tabs`);
        this.close();
        this.refresh();
    }

    /**
     * Kill all orphaned terminals
     */
    async killAll() {
        if (this.orphans.length === 0) return;

        const count = this.orphans.length;
        const ok = await appConfirm(
            S.orphan_terminals.kill_all_confirm.replace('{count}', count),
            { confirmLabel: 'Kill All', danger: true }
        );
        if (!ok) return;

        const results = await Promise.allSettled(
            this.orphans.map(term =>
                fetch(`${CONFIG.API_BASE}/api/terminal/${encodeURIComponent(term.session)}`, {
                    method: 'DELETE'
                })
            )
        );

        const succeeded = results.filter(r => r.status === 'fulfilled' && r.value.ok).length;
        const failed = count - succeeded;

        debug.log(`Killed ${succeeded} orphaned terminals${failed > 0 ? `, ${failed} failed` : ''}`);
        showToast(failed > 0
            ? S.orphan_terminals.kill_all_partial
                .replace('{ok}', succeeded).replace('{count}', count).replace('{failed}', failed)
            : S.orphan_terminals.kill_all_done.replace('{count}', succeeded));
        this.refresh();
    }
}

// Singleton instance
export const orphanTerminals = new OrphanTerminalsManager();
