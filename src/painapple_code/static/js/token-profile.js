/**
 * Token Profile - Per-session OAuth token profile selector
 *
 * Status bar item (next to model name) that lets the user pick which
 * OAuth token profile to use for the current session.
 * Hidden when no token profiles exist in ~/.config/painapple-code/tokens/.
 *
 * The selected profile is sent with every user_message over WebSocket.
 * The server applies it before spawning Claude — no separate API call needed.
 */

import { CONFIG } from './config.js';

// Deterministic color per profile name
const PROFILE_COLORS = [
    '#4a9eff', // blue
    '#67c23a', // green
    '#e6a23c', // orange
    '#f56c6c', // red
    '#b37feb', // purple
    '#36cfc9', // cyan
    '#ff85c0', // pink
    '#ffd666', // gold
];

function profileColor(name) {
    if (!name) return 'var(--text-secondary)';
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
    return PROFILE_COLORS[Math.abs(hash) % PROFILE_COLORS.length];
}

class TokenProfileManager {
    constructor() {
        this.container = null;  // #status-token-profile span
        this.isOpen = false;
        this._popup = null;
        this.currentProfile = null; // null = global default / system
        this.currentSessionId = null;
        this.globalDefault = null;
        this.profiles = []; // [{name: "max"}, ...]
    }

    init() {
        this.container = document.getElementById('status-token-profile');
        if (!this.container) return;

        this.container.addEventListener('click', (e) => {
            e.stopPropagation();
            this._togglePopup();
        });

        // Close popup on outside click
        document.addEventListener('click', (e) => {
            if (this.isOpen && this._popup && !this._popup.contains(e.target)) {
                this._closePopup();
            }
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.isOpen) {
                e.preventDefault();
                e.stopPropagation();
                this._closePopup();
            }
        }, true);

        this.loadProfiles();
    }

    async loadProfiles() {
        try {
            const resp = await fetch(`${CONFIG.API_BASE}/api/app/token-profiles`);
            if (!resp.ok) return;
            const data = await resp.json();
            this.profiles = data.profiles || [];
            this.globalDefault = data.default_profile || null;

            if (this.profiles.length > 0) {
                this.container.classList.add('visible');
                this._updateDisplay();
            }
        } catch (e) {
            console.error('Failed to load token profiles:', e);
        }
    }

    async setSession(sessionId) {
        this.currentSessionId = sessionId;

        if (this.profiles.length === 0) return;

        // Synchronous seed — paint the session's cached profile immediately
        // on tab switch (the fetch below only confirms). Same mapping as the
        // fetch (`token_profile || null`); unbound tabs show the default.
        const session = window.app?.activeSession;
        this.currentProfile = sessionId
            ? (session?.tokenProfileName || null)
            : this.globalDefault;
        this._updateDisplay();

        if (!sessionId) return;

        try {
            const resp = await fetch(`${CONFIG.API_BASE}/api/session/${sessionId}/token-profile`);
            // Bail if a newer setSession() superseded us during the await.
            if (this.currentSessionId !== sessionId) return;
            if (resp.ok) {
                const data = await resp.json();
                this.currentProfile = data.token_profile || null;
                this.globalDefault = data.global_default || null;
                // Cache on the session so the next switch seeds synchronously.
                const sess = window.app?.sessionManager?.sessions
                    ?.find(s => s.storeId === sessionId);
                if (sess) sess.tokenProfileName = data.token_profile || null;
                this._updateDisplay();
            }
        } catch (e) {
            console.error('Error loading session token profile:', e);
            this.currentProfile = this.globalDefault;
            this._updateDisplay();
        }
    }

    // ─── Display ───────────────────────────────────────────────────

    _updateDisplay() {
        if (!this.container) return;
        const active = this.currentProfile;
        const color = active ? profileColor(active) : '';
        this.container.innerHTML = active
            ? `<span class="tp-name">${active}</span>`
            : `<span class="tp-name" style="color:var(--text-muted)">no token</span>`;
        this.container.style.color = color;
        this.container.classList.add('clickable');

        // Fresh-session setup panel mirrors this state — keep its pills in
        // sync however the profile changed (popup, session load).
        window.sessionSetupPanel?.refresh();
    }

    // ─── Popup ─────────────────────────────────────────────────────

    _togglePopup() {
        this.isOpen ? this._closePopup() : this._openPopup();
    }

    _openPopup() {
        this._closePopup();
        if (this.profiles.length === 0) return;

        const popup = document.createElement('div');
        popup.className = 'token-profile-popup';
        this._popup = popup;
        this.isOpen = true;

        const effective = this.currentProfile;

        // "No token" option
        let html = `<div class="tp-option${!effective ? ' selected' : ''}" data-profile="">
            <span class="tp-opt-label">No token</span>
            <span class="tp-opt-desc"></span>
        </div>`;

        // Profile options
        for (const p of this.profiles) {
            const isSelected = effective === p.name;
            const isDefault = this.globalDefault === p.name;
            html += `<div class="tp-option${isSelected ? ' selected' : ''}" data-profile="${p.name}">
                <span class="tp-opt-label">${p.name}</span>
                <span class="tp-opt-desc">${isDefault ? 'default' : ''}</span>
            </div>`;
        }

        // "Set as default" footer
        html += `<div class="tp-popup-footer">
            <button class="tp-set-default">Set as default</button>
        </div>`;

        popup.innerHTML = html;

        // Event handlers
        popup.addEventListener('click', (e) => {
            const opt = e.target.closest('.tp-option');
            if (opt) {
                this.selectProfile(opt.dataset.profile || null);
                return;
            }
            const def = e.target.closest('.tp-set-default');
            if (def) this._saveAsGlobalDefault();
        });

        // Position above status bar
        document.body.appendChild(popup);
        const rect = this.container.getBoundingClientRect();
        popup.style.left = `${rect.left}px`;
        popup.style.bottom = `${window.innerHeight - rect.top + 6}px`;

        requestAnimationFrame(() => popup.classList.add('open'));
    }

    _closePopup() {
        if (this._popup) {
            this._popup.remove();
            this._popup = null;
        }
        this.isOpen = false;
    }

    // ─── Actions ───────────────────────────────────────────────────

    async selectProfile(profileName) {
        this.currentProfile = profileName;
        this._updateDisplay();
        this._closePopup();

        if (!this.currentSessionId) {
            await this._saveToGlobal(profileName);
            return;
        }

        // Cache on the session so the next tab switch seeds synchronously.
        {
            const sess = window.app?.activeSession;
            if (sess?.storeId === this.currentSessionId) sess.tokenProfileName = profileName || null;
        }

        try {
            await fetch(`${CONFIG.API_BASE}/api/session/${this.currentSessionId}/token-profile`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token_profile: profileName })
            });
        } catch (e) {
            console.error('Error saving session token profile:', e);
        }
    }

    async _saveAsGlobalDefault() {
        const profileName = this.currentProfile;
        this.globalDefault = profileName;
        this._closePopup();
        await this._saveToGlobal(profileName);
    }

    async _saveToGlobal(profileName) {
        // Defaults are per-provider — target the active session's provider when
        // known, else the legacy endpoint (writes the DEFAULT provider's entry).
        const s = window.app?.activeSession;
        const provider = s?.provider || s?.pendingProvider || null;
        const url = provider
            ? `${CONFIG.API_BASE}/api/app/provider-defaults/${encodeURIComponent(provider)}`
            : `${CONFIG.API_BASE}/api/app/default-token-profile`;
        try {
            await fetch(url, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token_profile: profileName })
            });
        } catch (e) {
            console.error('Error saving default token profile:', e);
        }
    }
}

export const tokenProfile = new TokenProfileManager();

window.tokenProfile = tokenProfile;

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => tokenProfile.init());
} else {
    tokenProfile.init();
}
