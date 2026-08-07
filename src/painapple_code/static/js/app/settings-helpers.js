/**
 * Settings / font / helpers mixin — focusProject (folder picker vs input focus),
 * connectIfDisconnected, showSettings, the font-scale controls (adjustFontSize /
 * applyFontScale / updateTerminalFontSize), applyInstanceConfig, and the
 * shadow-git helper install pill (_checkHelpersInstall / _updateHelpersPill /
 * refreshHelpersStatus). Extracted from app.js; applied to App.prototype via
 * Object.assign. Uses `this` (App instance) plus the imports below.
 */
import S from '../strings.js';
import { CONFIG, INSTANCE } from '../config.js';
import { Storage } from '../utils.js';
import { WidgetManager, TerminalWidget } from '../widget-system/init.js';
import { OpenDialog } from '../open-dialog.js';

export const settingsHelperMethods = {
    /**
     * Open the folder picker (or focus the message input when connected).
     * On welcome / disconnected: opens OpenDialog to pick or create a project.
     */
    focusProject() {
        // Check if welcome screen is showing
        const isWelcome = this.chatCtrl?.isWelcomeShowing();

        if (isWelcome || this.activeSession?.status === 'disconnected') {
            // No project yet — open the picker so the user can choose one
            OpenDialog.show();
        } else {
            // Connected - focus message input instead
            this.els.messageInput?.focus();
        }
    },

    connectIfDisconnected() {
        const s = this.activeSession;
        if (!s) return;
        // Welcome / no project yet — open picker instead of pinging a dead URL.
        if (!s.cwd) {
            OpenDialog.show();
            return;
        }
        // Force an immediate retry. Covers 'connecting' (slow open / hung
        // handshake) and 'disconnected' (backoff still pending), and also the
        // half-open zombie case where status is still 'connected' but the
        // socket is dead (iPad PWA resume) — forceReconnect tears down whatever
        // ws exists and resets the attempt counter so the next delay is 1s not
        // 30s. Skip only a genuinely healthy socket with a recent server frame.
        const healthy = s.status === 'connected' &&
            s.ws && s.ws.readyState === WebSocket.OPEN &&
            s._lastServerFrame && (Date.now() - s._lastServerFrame) < 75_000;
        if (!healthy) {
            s.forceReconnect();
        }
    },

    showSettings() {
        WidgetManager.open('config');
    },

    // ─────────────────────────────────────────────────────────────────────
    // Font Size Control
    // ─────────────────────────────────────────────────────────────────────

    /**
     * Adjust font scale by delta (e.g., -0.1 or +0.1)
     */
    adjustFontSize(delta) {
        const newScale = Math.round((this.fontScale + delta) * 10) / 10;
        // Clamp between 0.7 and 1.5
        if (newScale < 0.7 || newScale > 1.5) return;

        this.fontScale = newScale;
        Storage.set('claude-font-scale', this.fontScale);
        this.applyFontScale();
    },

    /**
     * Apply font scale to CSS and terminal
     */
    applyFontScale() {
        // Update CSS variable
        document.documentElement.style.setProperty('--font-scale', this.fontScale);

        // Update label in settings panel (if open)
        const label = document.getElementById('font-size-label');
        if (label) {
            label.textContent = `${Math.round(this.fontScale * 100)}%`;
        }

        // Update terminal font size (base 14px)
        const terminalFontSize = Math.round(14 * this.fontScale);
        this.updateTerminalFontSize(terminalFontSize);
    },

    /**
     * Apply per-instance identity: accent color override, header badge, top stripe.
     * Activated when server is started with --instance-name / --accent flags.
     */
    applyInstanceConfig() {
        if (!INSTANCE) return;

        const root = document.documentElement;

        // Override accent CSS variables
        if (INSTANCE.accent) {
            root.style.setProperty('--accent', INSTANCE.accent);
            // Keep the rgb-triplet twin in sync for rgba(var(--accent-rgb), α) tints
            const hex = INSTANCE.accent.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)?.[1];
            if (hex) {
                const full = hex.length === 3 ? [...hex].map(c => c + c).join('') : hex;
                const rgb = [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16));
                root.style.setProperty('--accent-rgb', rgb.join(', '));
            }
        }
        if (INSTANCE.hover) root.style.setProperty('--accent-hover', INSTANCE.hover);
        if (INSTANCE.muted) root.style.setProperty('--accent-muted', INSTANCE.muted);

        // Instance badge — placed in BOTH the page header (visible on desktop)
        // and the rail drawer header (visible on mobile). CSS shows whichever
        // copy matches the viewport; the other is hidden by the rail's media
        // query. Two badges keeps state simple — no on-resize relocation needed.
        if (INSTANCE.name) {
            const makeBadge = () => {
                const b = document.createElement('div');
                b.className = 'instance-badge';
                b.textContent = INSTANCE.name;
                if (INSTANCE.accent) b.style.background = INSTANCE.accent;
                return b;
            };

            const header = document.querySelector('header');
            const hamburger = header?.querySelector('#rail-toggle-btn');
            if (hamburger) hamburger.after(makeBadge());
            else if (header) header.insertBefore(makeBadge(), header.firstChild);

            const railHeader = document.querySelector('.rail-drawer-header');
            if (railHeader) railHeader.insertBefore(makeBadge(), railHeader.firstChild);
        }

        // Thin accent stripe at top of viewport
        if (INSTANCE.accent) {
            const stripe = document.createElement('div');
            stripe.className = 'instance-stripe';
            stripe.style.background = INSTANCE.accent;
            const appEl = document.getElementById('app');
            if (appEl) appEl.insertBefore(stripe, appEl.firstChild);
        }
    },

    /**
     * Update terminal font size
     */
    updateTerminalFontSize(fontSize) {
        TerminalWidget.setFontSize(fontSize);
    },

    /**
     * Fetch helper install state and update the #status-helpers pill.
     * The pill is always visible (current/outdated/missing) so the
     * auto-journal feature stays discoverable. Auto-pop the install
     * modal only when state warrants action:
     *  - any_outdated → always pop (overrides dismiss)
     *  - missing → pop unless user dismissed via "Don't show again"
     */
    async _checkHelpersInstall({ promptIfNeeded = true } = {}) {
        try {
            const resp = await fetch(`${CONFIG.API_BASE}/api/bridge/helpers/status`);
            if (!resp.ok) return;
            const status = await resp.json();
            this._updateHelpersPill(status);

            if (!promptIfNeeded || status.all_current) return;

            let dismissed = false;
            try { dismissed = localStorage.getItem('helpers_install_dismissed') === 'true'; } catch {}

            if (status.any_outdated || !dismissed) {
                WidgetManager.open('helpers-install', { status });
            }
        } catch { /* silent — never block the app */ }
    },

    _updateHelpersPill(status) {
        const pill = document.getElementById('status-helpers');
        if (!pill) return;
        const state = status.all_current ? 'current'
            : status.any_outdated ? 'outdated'
            : 'missing';
        const label = state === 'current'  ? S.helpers.pill.current
                    : state === 'outdated' ? S.helpers.pill.outdated
                    :                        S.helpers.pill.not_installed;
        pill.hidden = false;
        pill.classList.remove('current', 'outdated', 'missing');
        pill.classList.add(state);
        pill.textContent = label;
        pill.setAttribute('data-tooltip', label);
        pill.onclick = () => WidgetManager.open('helpers-install', { status });
    },

    /**
     * Public: re-fetch helper status and update the pill. Called by the
     * install widget after a successful install/update so the pill clears.
     */
    async refreshHelpersStatus() {
        await this._checkHelpersInstall({ promptIfNeeded: false });
    },
};
