/**
 * Status Bar Module
 * Manages connection status, token display, and typing indicator
 */

import { CONFIG } from './config.js';
import S from './strings.js';
import { showToast } from './context-menu.js';

// Models loaded from server (GET /api/app/models)
let MODELS = [];
let SUMMARY_MODEL_ID = '';
let _modelsLoaded = false;

// Provider registry loaded from server (GET /api/providers):
// { providers: [describe()...], default: name, default_pinned_by_flag: bool }
let PROVIDERS_INFO = null;
let _providersLoaded = false;

async function ensureProvidersLoaded() {
    if (_providersLoaded) return;
    try {
        const resp = await fetch(`${CONFIG.API_BASE}/api/providers`);
        if (resp.ok) {
            PROVIDERS_INFO = await resp.json();
            _providersLoaded = true;
        }
    } catch (e) { /* silent — chip stays hidden */ }
}

/** Call when the default provider changes so the next popup re-fetches. */
function invalidateProvidersCache() {
    _providersLoaded = false;
    PROVIDERS_INFO = null;
}

/** Look up one provider's registry entry by name. */
function providerInfo(name) {
    return PROVIDERS_INFO?.providers?.find(p => p.name === name) || null;
}

/** Compact chip label: "Claude Code (SDK)" → "Claude", "Codex CLI" → "Codex". */
function shortProviderLabel(displayName) {
    return (displayName || '').split(/[\s(]/)[0] || displayName || '';
}

/**
 * Author label for a session's assistant messages — the provider's OWN short
 * name, lowercased ("claude", "codex"), never a hardcoded vendor. A session's
 * provider locks on its first turn, so one label holds for the whole transcript.
 *
 * The provider id's first segment is the fallback (`codex-app-server` →
 * "codex"), so history rendered before the registry fetch lands still paints
 * the right author instead of flashing "claude" — same first-paint rule the
 * status-bar managers follow.
 */
function providerAuthorLabel(session) {
    const name = session?.provider || session?.pendingProvider
        || PROVIDERS_INFO?.default || '';
    const label = shortProviderLabel(providerInfo(name)?.display_name)
        || name.split(/[-_]/)[0];
    return (label || S.provider.assistant_fallback).toLowerCase();
}

/** Providers the picker offers (Settings → Providers toggles; default always on). */
function enabledProviders() {
    return (PROVIDERS_INFO?.providers || []).filter(p => p.enabled !== false);
}

/** The model list `provider` draws from: its self-described catalog (registry
 * `models` — Claude mirrors models.yaml, Codex reads the CLI's own cache),
 * falling back to the app-managed list while the registry hasn't loaded. */
function providerCatalog(provider) {
    return (provider?.models?.length ? provider.models : MODELS) || [];
}

async function ensureModelsLoaded() {
    if (_modelsLoaded) return;
    try {
        const resp = await fetch(`${CONFIG.API_BASE}/api/app/models`);
        if (resp.ok) {
            const data = await resp.json();
            MODELS = data.selectable || [];
            SUMMARY_MODEL_ID = data.summary_model || '';
            _modelsLoaded = true;
        }
    } catch (e) { /* silent — popup will show raw IDs */ }
}

/** Call this when models.yaml changes so next popup re-fetches. */
function invalidateModelsCache() {
    _modelsLoaded = false;
    MODELS = [];
    SUMMARY_MODEL_ID = '';
}

/**
 * Friendly label for a model ID. Looks it up in MODELS first, then falls
 * back to deriving from the ID pattern. "claude-haiku-4-5" → "Haiku 4.5".
 */
function formatModelLabel(id) {
    if (!id) return '';
    const found = MODELS.find(m => m.id === id);
    if (found?.label) return found.label;
    const m = id.match(/claude-([a-z]+)-(\d+)-(\d+)(?:\[(\w+)\])?/i);
    if (m) {
        const [, family, major, minor, variant] = m;
        const cap = family[0].toUpperCase() + family.slice(1);
        return variant ? `${cap} ${major}.${minor} (${variant.toUpperCase()})` : `${cap} ${major}.${minor}`;
    }
    return id;
}

/** Display label for the configured background/auto-journal model. */
function getSummaryModelLabel() {
    return SUMMARY_MODEL_ID ? formatModelLabel(SUMMARY_MODEL_ID) : 'Haiku';
}

/** Exported for config-widget and other consumers */
export { MODELS, ensureModelsLoaded, invalidateModelsCache, formatModelLabel, getSummaryModelLabel };
export { PROVIDERS_INFO, ensureProvidersLoaded, invalidateProvidersCache, providerInfo, shortProviderLabel, providerAuthorLabel, enabledProviders, providerCatalog };

/**
 * StatusBar - Manage status display
 */
export class StatusBar {
    /**
     * @param {Object} elements - DOM elements
     * @param {HTMLElement} elements.statusConnection - Connection dot (tooltip-driven)
     * @param {HTMLElement} elements.statusModel - Model name
     * @param {HTMLElement} elements.statusBranch - Git branch name
     * @param {HTMLElement} elements.statusProject - Project name display
     * @param {HTMLElement} elements.statusCost - Cost display
     * @param {HTMLElement} elements.statusTokens - Token bar container
     * @param {HTMLElement} elements.sendBtn - Send button
     * @param {HTMLElement} elements.followupBtn - Follow-up button (visible while working)
     * @param {HTMLElement} elements.stopBtn - Stop button
     * @param {Object} callbacks - Callback functions
     * @param {Function} callbacks.getSession - Returns active session
     */
    constructor(elements, callbacks = {}) {
        this.els = elements;
        this.getSession = callbacks.getSession || (() => null);

        // State
        this.isTyping = false;
        this.currentModel = null;       // preferred_model for active session
        this.globalDefaultModel = null; // active PROVIDER's default model
        this.currentSessionId = null;
        // Per-provider default-model cache (keyed by models_key) — lets a tab
        // switch seed the right provider's default synchronously instead of
        // leaving the previous provider's value up until the confirm fetch.
        this._defaultModelByProvider = {};
        this._modelPopup = null;
        this._modelPopupOpen = false;
    }

    // ─────────────────────────────────────────────────────────────────
    // Connection Status
    // ─────────────────────────────────────────────────────────────────

    /**
     * Update status display based on session state
     */
    updateStatus() {
        const session = this.getSession();
        if (!session) return;

        // Connection status — three states (connected | connecting | disconnected).
        // Rendered as a coloured WORD, not a dot: the dot used to sit flush
        // against the "Auto-journal" pill and was read as that pill's status
        // light. The colour still carries the state at a glance; the word says
        // which state it is without a hover.
        const dot = this.els.statusConnection;
        if (dot) {
            const state = session.status === 'connected' || session.status === 'connecting'
                ? session.status
                : 'disconnected';
            dot.classList.remove('connected', 'connecting', 'disconnected');
            dot.classList.add(state);
            dot.textContent = S.connection?.[state] || state;
            // When clickable (disconnected/connecting), advertise the action in
            // the tooltip. When connected the label already says "Connected",
            // so a tooltip repeating it is pure noise — drop it.
            const clickable = state !== 'connected';
            const tooltipKey = state === 'disconnected'
                ? 'disconnected_click'
                : 'connecting_click';
            if (clickable) {
                dot.setAttribute('data-tooltip',
                    S.connection?.[tooltipKey] || S.connection?.[state] || state);
            } else {
                dot.removeAttribute('data-tooltip');
            }
            dot.classList.toggle('clickable', clickable);
            // role/tabindex so trackpad-/keyboard-only users get the affordance too.
            if (clickable) {
                dot.setAttribute('role', 'button');
                dot.setAttribute('tabindex', '0');
            } else {
                dot.removeAttribute('role');
                dot.removeAttribute('tabindex');
            }
        }

        // Provider chip — which AI provider this session runs on (bound) or will
        // run on (pendingProvider / box default for a not-yet-created tab).
        // Hidden until the registry loads or when only one provider exists.
        const providerName = (session.storeId ? session.provider : session.pendingProvider)
            || PROVIDERS_INFO?.default || null;
        const provider = providerInfo(providerName);
        // Chip is pointless with a single choosable provider — unless this
        // session happens to run on something else (e.g. a provider since
        // disabled in Settings), where it's exactly the information needed.
        const multiProvider = enabledProviders().length > 1
            || (!!providerName && !!PROVIDERS_INFO && providerName !== PROVIDERS_INFO.default);
        if (this.els.statusProvider) {
            if (provider && multiProvider) {
                this.els.statusProvider.textContent = shortProviderLabel(provider.display_name);
                this.els.statusProvider.classList.add('clickable');
                this.els.statusProvider.classList.toggle('pending', !session.storeId);
                this.els.statusProvider.setAttribute('data-tooltip', session.storeId
                    ? `${provider.display_name} — ${S.provider.chip_tooltip}`
                    : S.provider.chip_tooltip_pending);
            } else {
                this.els.statusProvider.textContent = '';
                this.els.statusProvider.classList.remove('clickable', 'pending');
                this.els.statusProvider.removeAttribute('data-tooltip');
            }
        }

        // Providers that declare NO catalog (the app doesn't manage their
        // models at all) hide the model chip entirely.
        const providerHidesModel = !!provider && (provider.models || []).length === 0;

        // Model name (shortened) — the effective pick on this provider's own
        // catalog, the provider-reported actual, or "Default" when the provider
        // runs its own configured model (e.g. a fresh Codex session).
        if (this.els.statusModel) {
            const catalog = providerCatalog(provider);
            const displayId = this.effectiveModelId(provider, session);
            if (!providerHidesModel && (displayId || (provider?.models || []).length)) {
                let label;
                const known = displayId ? catalog.find(m => displayId.startsWith(m.id)) : null;
                if (known) {
                    label = known.label;
                } else if (displayId) {
                    const parts = displayId.replace('claude-', '').split('-');
                    label = parts.length >= 3 && !isNaN(parts[1]) && !isNaN(parts[2])
                        ? `${parts[0]}-${parts[1]}.${parts[2]}`
                        : parts.slice(0, 3).join('-');
                } else {
                    label = S.models.provider_default_label;
                }
                this.els.statusModel.textContent = label;
                this.els.statusModel.classList.add('clickable');
            } else {
                this.els.statusModel.textContent = '';
                this.els.statusModel.classList.remove('clickable');
            }
        }

        // Cost — hidden for tokens-only providers (no USD accounting); the
        // token meter still shows usage for them.
        if (this.els.statusCost) {
            const tokensOnly = session.providerCaps?.cumulative_cost === false;
            if (session.totalCost > 0 && !tokensOnly) {
                this.els.statusCost.textContent = `$${session.totalCost.toFixed(4)}`;
            } else {
                this.els.statusCost.textContent = '';
            }
        }

        // Token usage
        this._updateTokenDisplay(session);

        // Fresh-session setup panel mirrors this chip state in the empty
        // chat area — same funnel, cheap when hidden. window-global lookup
        // (not an import): the panel imports from this module.
        window.sessionSetupPanel?.refresh();
    }

    /**
     * Update git branch display
     * @param {string|null} branch - Branch name or null to hide
     */
    updateBranch(branch) {
        if (!this.els.statusBranch) return;

        if (branch) {
            this.els.statusBranch.innerHTML = `
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <line x1="6" y1="3" x2="6" y2="15"></line>
                    <circle cx="18" cy="6" r="3"></circle>
                    <circle cx="6" cy="18" r="3"></circle>
                    <path d="M18 9a9 9 0 0 1-9 9"></path>
                </svg>
                <span>${branch}</span>
            `;
            this.els.statusBranch.classList.add('visible');
        } else {
            this.els.statusBranch.innerHTML = '';
            this.els.statusBranch.classList.remove('visible');
        }
    }

    /**
     * Update project name display
     * Shows folder icon with project name, full path on hover
     * @param {string|null} cwd - Full project path or null to hide
     */
    updateProject(cwd) {
        const el = this.els.statusProject;
        if (!el) return;

        if (cwd) {
            // Extract project name and parent folder for context
            const parts = cwd.split('/').filter(Boolean);
            const projectName = parts[parts.length - 1] || cwd;
            const parentName = parts.length > 1 ? parts[parts.length - 2] : '';

            // Folder icon (filled style)
            el.innerHTML = `
                <svg viewBox="0 0 24 24" fill="currentColor">
                    <path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z"/>
                </svg>
                ${parentName ? `<span class="project-sep">/</span>` : ''}
                <span>${projectName}</span>
            `;
            el.setAttribute('data-tooltip', cwd);
            el.classList.add('visible');

            // Click to copy path
            el.onclick = (e) => {
                e.stopPropagation();
                navigator.clipboard.writeText(cwd).then(() => {
                    // Brief visual feedback
                    const originalTooltip = el.getAttribute('data-tooltip');
                    el.setAttribute('data-tooltip', 'Copied!');
                    el.style.color = 'var(--success)';
                    setTimeout(() => {
                        el.setAttribute('data-tooltip', originalTooltip);
                        el.style.color = '';
                    }, 1000);
                }).catch(() => {
                    // Silent fail - clipboard may not be available
                });
            };
        } else {
            el.innerHTML = '';
            el.classList.remove('visible');
            el.onclick = null;
        }
    }

    /**
     * Update token usage bar
     * Shows EFFECTIVE percentage (tokens / usable window) to match inline indicator
     */
    _updateTokenDisplay(session) {
        const tokensEl = this.els.statusTokens;
        if (!tokensEl) return;

        const fill = tokensEl.querySelector('.token-fill');
        const text = tokensEl.querySelector('.token-text');

        // Error state
        if (session.contextTokens === -1) {
            tokensEl.classList.add('visible');
            if (fill) {
                fill.style.width = '100%';
                fill.classList.remove('warning');
                fill.classList.add('danger');
            }
            if (text) {
                text.textContent = 'token error';
                text.classList.remove('warning');
                text.classList.add('danger');
            }
            return;
        }

        if (session.contextTokens > 0) {
            tokensEl.classList.add('visible');

            // Calculate reserved buffer and usable window (same logic as inline indicator)
            const reservedBuffer = session.contextBreakdown?.autocompact_buffer?.tokens || 0;
            const usableWindow = session.contextWindow - reservedBuffer;

            // Effective percentage - what actually matters for auto-compaction
            const effectivePct = reservedBuffer > 0
                ? Math.min(100, (session.contextTokens / usableWindow) * 100)
                : Math.min(100, (session.contextTokens / session.contextWindow) * 100);

            if (fill) {
                fill.style.width = `${effectivePct}%`;
                fill.classList.remove('warning', 'danger');
                // Thresholds aligned with inline indicator: 70% warning, 85% danger
                if (effectivePct >= 85) {
                    fill.classList.add('danger');
                } else if (effectivePct >= 70) {
                    fill.classList.add('warning');
                }
            }

            if (text) {
                const formatK = (n) => n >= 1000 ? `${Math.round(n / 1000)}K` : n;
                // Show tokens / usable window (not total window)
                text.textContent = `${formatK(session.contextTokens)} / ${formatK(usableWindow)}`;
                text.classList.remove('warning', 'danger');
                if (effectivePct >= 85) {
                    text.classList.add('danger');
                } else if (effectivePct >= 70) {
                    text.classList.add('warning');
                }
            }
        } else {
            tokensEl.classList.remove('visible');
        }
    }

    // ─────────────────────────────────────────────────────────────────
    // Send/Stop Button Toggle
    // ─────────────────────────────────────────────────────────────────

    /**
     * Toggle send/stop button visibility.
     * Activity strip is managed by ActivityStrip module directly.
     * @param {boolean} working - Whether Claude is working
     */
    toggleStopButton(working) {
        this.isTyping = working;
        this.els.sendBtn?.classList.toggle('hidden', working);
        this.els.followupBtn?.classList.toggle('visible', working);
        this.els.stopBtn?.classList.toggle('visible', working);
    }

    /**
     * Get current working state
     */
    get typing() {
        return this.isTyping;
    }

    // ─────────────────────────────────────────────────────────────────
    // Context Popover
    // ─────────────────────────────────────────────────────────────────

    /**
     * Load preferred model for a session (called on tab switch)
     */
    async setSession(sessionId) {
        this.currentSessionId = sessionId;

        // Synchronous seed — a tab switch must paint THIS session's provider
        // state immediately (session pref cache + per-provider default cache);
        // the fetches below only confirm. Never leave the previous session's
        // values up while awaiting, or the chip/setup-panel flash the old
        // provider's model until the network round-trip lands.
        const sess = this.getSession();
        const seedProviderName = (sess ? (sess.provider || sess.pendingProvider) : null)
            || PROVIDERS_INFO?.default || null;
        const seedKey = providerInfo(seedProviderName)?.models_key || seedProviderName;
        this.globalDefaultModel = (seedKey && this._defaultModelByProvider[seedKey]) || null;
        this.currentModel = sess?.preferredModel || this.globalDefaultModel;
        this.updateStatus();

        // Ensure models list is loaded from server
        await ensureModelsLoaded();
        // Bail if a newer setSession() superseded us during the await — otherwise a
        // slow response for an old session clobbers the current session's model.
        if (this.currentSessionId !== sessionId) return;

        if (!sessionId) {
            // Unbound tab — confirm the provider's configured default (scoped
            // endpoint when the tab's provider is known, legacy default-provider
            // endpoint otherwise).
            try {
                const url = seedProviderName
                    ? `${CONFIG.API_BASE}/api/app/provider-defaults/${encodeURIComponent(seedProviderName)}`
                    : `${CONFIG.API_BASE}/api/app/default-model`;
                const gr = await fetch(url);
                if (this.currentSessionId !== sessionId) return;
                if (gr.ok) {
                    const gd = await gr.json();
                    this.globalDefaultModel = gd.default_model || null;
                    if (seedKey) this._defaultModelByProvider[seedKey] = this.globalDefaultModel;
                }
            } catch (e) { /* silent */ }
            this.currentModel = this.globalDefaultModel;
            this.updateStatus();
            return;
        }
        try {
            const resp = await fetch(`${CONFIG.API_BASE}/api/session/${sessionId}/model`);
            if (this.currentSessionId !== sessionId) return;
            if (resp.ok) {
                const data = await resp.json();
                // global_default is the SESSION PROVIDER's configured default
                // (null when that provider has none — e.g. codex running its
                // own config.toml model, rendered as the "Default" row).
                this.globalDefaultModel = data.global_default || null;
                if (seedKey) this._defaultModelByProvider[seedKey] = this.globalDefaultModel;
                this.currentModel = data.preferred_model || null;
                if (sess) sess.preferredModel = data.preferred_model || null;
            } else {
                // Session not yet registered server-side (common right after a page
                // load / reconcile). Fall back to the provider default rather
                // than leaving currentModel null — a null lets the status chip show the
                // stale last-run model (session.model) instead of the real default.
                this.currentModel = this.globalDefaultModel;
            }
        } catch (e) {
            if (this.currentSessionId !== sessionId) return;
            this.currentModel = this.globalDefaultModel;
        }
        this.updateStatus();
    }

    /**
     * Initialize hover handlers for interactive elements
     */
    init() {
        // Connection dot — click to force-reconnect when not connected.
        // Auto-reconnect with backoff already runs in Session; this handler
        // just lets the user skip the wait and resets the attempt counter so
        // the next try is immediate.
        if (this.els.statusConnection) {
            const triggerReconnect = (e) => {
                const session = this.getSession();
                if (!session) return;
                // Always allow a user-initiated reconnect. Don't gate on
                // status: a half-open socket (iPad PWA resume) still reports
                // status 'connected' while being dead, and gating here made the
                // dot a silent no-op — the user's only manual recovery. Skip
                // only a genuinely healthy socket that saw a recent frame.
                const healthy = session.status === 'connected' &&
                    session.ws && session.ws.readyState === WebSocket.OPEN &&
                    session._lastServerFrame &&
                    (Date.now() - session._lastServerFrame) < 75_000;
                if (!healthy) {
                    e.stopPropagation();
                    if (typeof window !== 'undefined' && window.app?.connectIfDisconnected) {
                        window.app.connectIfDisconnected();
                    } else if (typeof session.forceReconnect === 'function') {
                        session.forceReconnect();
                    }
                }
            };
            this.els.statusConnection.addEventListener('click', triggerReconnect);
            this.els.statusConnection.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') triggerReconnect(e);
            });
        }

        // Model selector — click on status-model to open popup
        if (this.els.statusModel) {
            this.els.statusModel.addEventListener('click', (e) => {
                e.stopPropagation();
                this._toggleModelPopup();
            });
        }

        // Provider selector — click on status-provider to open the picker
        if (this.els.statusProvider) {
            this.els.statusProvider.addEventListener('click', (e) => {
                e.stopPropagation();
                this._toggleProviderPopup();
            });
        }

        // Close model/provider popups on outside click / Escape
        document.addEventListener('click', (e) => {
            if (this._modelPopupOpen && this._modelPopup && !this._modelPopup.contains(e.target)) {
                this._closeModelPopup();
            }
            if (this._providerPopupOpen && this._providerPopup && !this._providerPopup.contains(e.target)) {
                this._closeProviderPopup();
            }
        });

        // Warm the provider registry so the chip appears on first paint.
        ensureProvidersLoaded().then(() => this.updateStatus());

        // Token display hover handler - show popover on mouseenter
        if (this.els.statusTokens) {
            this.els.statusTokens.style.cursor = 'default';
            this._hoverTimeout = null;
            this._hideTimeout = null;

            this.els.statusTokens.addEventListener('mouseenter', () => {
                clearTimeout(this._hideTimeout);
                // Small delay before showing to avoid flicker on quick mouse passes
                this._hoverTimeout = setTimeout(() => {
                    this.showContextPopover();
                }, 150);
            });

            this.els.statusTokens.addEventListener('mouseleave', (e) => {
                clearTimeout(this._hoverTimeout);
                // Delay to allow mouse to reach popover
                this._hideTimeout = setTimeout(() => {
                    const popover = document.getElementById('context-popover');
                    if (popover && popover.matches(':hover')) return;
                    this.hideContextPopover();
                }, 300);
            });
        }

        // Close popover on escape (only if visible, don't block other handlers)
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this._modelPopupOpen) {
                this._closeModelPopup();
                e.stopPropagation();
                return;
            }
            if (e.key === 'Escape') {
                // Close status bar popover
                const statusPopover = document.getElementById('context-popover');
                if (statusPopover) {
                    this.hideContextPopover();
                    e.stopPropagation();
                    return;
                }
                // Close inline breakdown popover
                const inlinePopover = document.querySelector('.context-breakdown-popover');
                if (inlinePopover) {
                    inlinePopover.remove();
                    e.stopPropagation();
                    return;
                }
            }
        });
    }

    /**
     * Toggle context popover visibility
     */
    toggleContextPopover() {
        const existing = document.getElementById('context-popover');
        if (existing) {
            this.hideContextPopover();
        } else {
            this.showContextPopover();
        }
    }

    /**
     * Show context usage popover with detailed breakdown
     */
    showContextPopover() {
        const session = this.getSession();
        if (!session) return;

        // Remove existing popover
        this.hideContextPopover();

        const popover = document.createElement('div');
        popover.id = 'context-popover';
        popover.className = 'context-popover';

        // Calculate relative time
        const updatedAgo = session.contextUpdatedAt
            ? this._formatTimeAgo(Date.now() - session.contextUpdatedAt)
            : 'unknown';

        // Calculate effective percentage (same as inline indicator)
        const reservedBuffer = session.contextBreakdown?.autocompact_buffer?.tokens || 0;
        const usableWindow = session.contextWindow - reservedBuffer;
        const effectivePct = session.contextWindow > 0
            ? (reservedBuffer > 0
                ? Math.round((session.contextTokens / usableWindow) * 100)
                : Math.round((session.contextTokens / session.contextWindow) * 100))
            : 0;

        // Determine status class (thresholds aligned with inline: 70% warning, 85% danger)
        let statusClass = '';
        if (effectivePct >= 85) statusClass = 'danger';
        else if (effectivePct >= 70) statusClass = 'warning';

        // Format token numbers
        const formatK = (n) => {
            if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
            return String(n);
        };

        // Build breakdown HTML
        let breakdownHtml = '';
        if (session.contextBreakdown) {
            const breakdown = session.contextBreakdown;
            // Order categories logically
            const order = ['system_prompt', 'system_tools', 'custom_agents', 'memory_files', 'skills', 'messages', 'free_space', 'autocompact_buffer'];
            const labels = {
                system_prompt: 'System prompt',
                system_tools: 'Tool definitions',
                custom_agents: 'Custom agents',
                memory_files: 'Memory files',
                skills: 'Skills',
                messages: 'Conversation',
                free_space: 'Free space',
                autocompact_buffer: 'Reserved buffer'
            };

            breakdownHtml = '<div class="context-breakdown">';
            for (const key of order) {
                if (breakdown[key]) {
                    const { tokens, pct } = breakdown[key];
                    const isFree = key === 'free_space' || key === 'autocompact_buffer';
                    breakdownHtml += `
                        <div class="breakdown-row ${isFree ? 'muted' : ''}">
                            <span class="breakdown-label">${labels[key] || key}</span>
                            <span class="breakdown-tokens">${formatK(tokens)}</span>
                            <span class="breakdown-pct">${pct.toFixed(1)}%</span>
                        </div>`;
                    if (key === 'messages') {
                        breakdownHtml += '<div class="breakdown-divider"></div>';
                    }
                }
            }
            breakdownHtml += '</div>';
        }

        // Memory files detail
        let memoryHtml = '';
        if (session.contextMemoryFiles && session.contextMemoryFiles.length > 0) {
            memoryHtml = '<div class="context-memory"><div class="memory-title">Memory Files</div>';
            for (const file of session.contextMemoryFiles) {
                const shortPath = file.path.split('/').slice(-2).join('/');
                memoryHtml += `
                    <div class="memory-row">
                        <span class="memory-path" data-tooltip="${file.path}">${shortPath}</span>
                        <span class="memory-tokens">${formatK(file.tokens)}</span>
                    </div>`;
            }
            memoryHtml += '</div>';
        }

        // Session stats
        const turns = session.messages?.filter(m => m.role === 'user').length || 0;
        const cost = session.totalCost?.toFixed(4) || '0.0000';

        // Reserved buffer label (only if present)
        const reservedLabel = reservedBuffer > 0
            ? `<span class="popover-reserved">${Math.round((reservedBuffer / session.contextWindow) * 100)}% reserved</span>`
            : '';

        popover.innerHTML = `
            <div class="popover-header">
                <span class="popover-title">Context Usage</span>
                <span class="popover-updated">Updated ${updatedAgo}</span>
            </div>
            <div class="popover-progress">
                <div class="progress-bar">
                    <div class="progress-fill ${statusClass}" style="width: ${effectivePct}%"></div>
                </div>
                <div class="progress-text ${statusClass}">
                    ${effectivePct}% (${formatK(session.contextTokens)} / ${formatK(usableWindow)})
                    ${reservedLabel}
                </div>
            </div>
            ${breakdownHtml}
            ${memoryHtml}
            <div class="popover-footer">
                <span>Session: $${cost}</span>
                <span>${turns} turn${turns !== 1 ? 's' : ''}</span>
            </div>
        `;

        // Position below the token display
        const rect = this.els.statusTokens.getBoundingClientRect();
        popover.style.position = 'fixed';
        popover.style.bottom = `${window.innerHeight - rect.top + 8}px`;
        popover.style.right = `${window.innerWidth - rect.right}px`;

        // Cancel hide timeout when mouse enters popover
        popover.addEventListener('mouseenter', () => {
            clearTimeout(this._hideTimeout);
        });

        // Close when mouse leaves popover
        popover.addEventListener('mouseleave', (e) => {
            if (e.relatedTarget && this.els.statusTokens?.contains(e.relatedTarget)) {
                return; // Don't close - mouse moved back to token display
            }
            setTimeout(() => this.hideContextPopover(), 200);
        });

        document.body.appendChild(popover);

        // Animate in
        requestAnimationFrame(() => popover.classList.add('visible'));
    }

    // ─────────────────────────────────────────────────────────────────
    // Model Selector Popup
    // ─────────────────────────────────────────────────────────────────

    /** Effective model id for the active session on `provider`, or null when
     * the provider's own configured default applies (which the app can't name).
     * The user-pick chain (per-session pick → global default) is filtered to
     * ids the provider actually offers — a pick made under another provider must
     * not label this one — while the provider-REPORTED actual (`session.model`)
     * is always trusted. Prefix match: reported ids carry date suffixes. */
    effectiveModelId(provider, session) {
        const catalog = providerCatalog(provider);
        const inCat = id => !!id && catalog.some(m => id.startsWith(m.id));
        if (inCat(this.currentModel)) return this.currentModel;
        if (session?.model) return session.model;
        if (inCat(this.globalDefaultModel)) return this.globalDefaultModel;
        // The app always presents a concrete default — fall back to the
        // provider's top catalog model rather than the ambiguous "Default".
        // The server resolves the same top-of-enabled default; this just
        // covers the pre-fetch transient (globalDefaultModel not loaded yet).
        return catalog[0]?.id || null;
    }

    /** The active session's provider registry entry (bound, pending, or the
     * box default) — what the model chip/popup should describe. */
    _activeProvider() {
        const session = this.getSession();
        // provider wins once known; a bound tab whose provider hasn't been
        // echoed yet still resolves to the user's pick (pendingProvider).
        const name = session
            ? ((session.provider || session.pendingProvider)
                || PROVIDERS_INFO?.default)
            : PROVIDERS_INFO?.default;
        return providerInfo(name);
    }

    _toggleModelPopup() {
        if (this._modelPopupOpen) {
            this._closeModelPopup();
        } else {
            this._openModelPopup();
        }
    }

    async _openModelPopup() {
        await Promise.all([ensureModelsLoaded(), ensureProvidersLoaded()]);
        this._closeModelPopup();

        // The popup lists the ACTIVE PROVIDER's own catalog — Claude sessions
        // get the models.yaml list, Codex sessions get the Codex CLI's.
        const provider = this._activeProvider();
        const catalog = providerCatalog(provider);
        if (!catalog.length) return;

        const popup = document.createElement('div');
        popup.className = 'model-popup';
        this._modelPopup = popup;
        this._modelPopupOpen = true;

        // The row in effect: the per-session pick if this provider offers it,
        // else the provider's default. (No provider-reported actual here — the
        // popup is about the USER's pick.) The default always resolves to a
        // concrete catalog model — the server falls back to the top model, and
        // catalog[0] covers the pre-fetch transient — so there is no "Default"
        // pseudo-row; the default model is marked inline with a badge.
        const inCat = id => !!id && catalog.some(m => id.startsWith(m.id));
        const pick = inCat(this.currentModel) ? this.currentModel : null;
        const resolvedDefault =
            (inCat(this.globalDefaultModel) ? this.globalDefaultModel : null)
            || catalog[0]?.id || null;
        const effectiveModel = pick || resolvedDefault;

        const rows = catalog.map(m => {
            const isSelected = effectiveModel === m.id;
            const isDefault = resolvedDefault === m.id;
            return `<div class="model-option${isSelected ? ' selected' : ''}" data-model-id="${m.id}">
                <span class="model-option-label">${m.label}</span>
                <span class="model-option-desc">${isDefault ? S.models.global_default_badge : m.desc}</span>
            </div>`;
        });

        // "Set as default" writes THIS PROVIDER's new-session default model
        // (defaults are per-provider) — offered on every provider's popup.
        popup.innerHTML = rows.join('') + `<div class="model-popup-footer">
            <button class="model-set-default" data-model-id="${effectiveModel || ''}">${S.models.set_default_button}</button>
        </div>`;

        popup.addEventListener('click', (e) => {
            const opt = e.target.closest('.model-option');
            if (opt) { this._selectModel(opt.dataset.modelId); return; }
            const def = e.target.closest('.model-set-default');
            if (def) this._saveToGlobal(def.dataset.modelId, provider?.name);
        });

        // Position above the status-model element
        document.body.appendChild(popup);
        const rect = this.els.statusModel.getBoundingClientRect();
        popup.style.left = `${rect.left}px`;
        popup.style.bottom = `${window.innerHeight - rect.top + 6}px`;

        requestAnimationFrame(() => popup.classList.add('open'));
    }

    _closeModelPopup() {
        if (this._modelPopup) {
            this._modelPopup.remove();
            this._modelPopup = null;
        }
        this._modelPopupOpen = false;
    }

    // ─────────────────────────────────────────────────────────────────
    // Provider (provider) Picker Popup
    // ─────────────────────────────────────────────────────────────────

    _toggleProviderPopup(anchorEl) {
        if (this._providerPopupOpen) {
            this._closeProviderPopup();
        } else {
            this._openProviderPopup(anchorEl);
        }
    }

    /** Provider locked = the session has run a turn on it (server-reported at
     * connect; a providerSessionId appearing mid-session is the live signal). */
    _providerLocked(session) {
        return !!session?.storeId && (session.providerLocked || !!session.providerSessionId);
    }

    async _openProviderPopup(anchorEl) {
        await ensureProvidersLoaded();
        if (!PROVIDERS_INFO?.providers?.length) return;
        this._closeModelPopup();
        this._closeProviderPopup();

        const session = this.getSession();
        const bound = session?.storeId ? (session.provider || PROVIDERS_INFO.default) : null;
        const locked = this._providerLocked(session);
        const effective = bound || session?.pendingProvider || PROVIDERS_INFO.default;

        const popup = document.createElement('div');
        popup.className = 'model-popup provider-popup';
        this._providerPopup = popup;
        this._providerPopupOpen = true;

        // Three states: pre-connect tab (choice rides the create connect),
        // bound-but-empty (switchable in place until the first turn), locked
        // (picking another provider opens a fresh tab on it).
        const note = locked ? `<div class="provider-popup-note">${S.provider.fixed_note}</div>`
            : bound ? `<div class="provider-popup-note">${S.provider.switchable_note}</div>`
            : '';

        // Offer only Settings-enabled providers, plus this session's own provider
        // if it has since been disabled (the selected row must always exist).
        const offered = PROVIDERS_INFO.providers.filter(
            p => p.enabled !== false || p.name === effective);

        popup.innerHTML = note + offered.map(p => {
            const isSelected = p.name === effective;
            const isDefault = p.name === PROVIDERS_INFO.default;
            const cls = ['model-option', 'provider-option'];
            if (isSelected) cls.push('selected');
            if (!p.available) cls.push('unavailable');
            const desc = !p.available
                ? (p.unavailable_reason || '')
                : (isSelected && bound) ? S.provider.this_session
                : isDefault ? S.provider.default_badge
                : (p.description || '');
            return `<div class="${cls.join(' ')}" data-provider="${p.name}">
                <span class="model-option-label">${p.display_name}</span>
                <span class="model-option-desc">${desc}</span>
            </div>`;
        }).join('') + `<div class="model-popup-footer">
            <button class="provider-set-default" data-provider="${effective}"${PROVIDERS_INFO.default_pinned_by_flag ? ` disabled data-tooltip="${S.provider.pinned_by_flag}"` : ''}>${S.provider.set_default}</button>
        </div>`;

        popup.addEventListener('click', (e) => {
            const opt = e.target.closest('.provider-option');
            if (opt) { this._selectProvider(opt.dataset.provider); return; }
            const def = e.target.closest('.provider-set-default');
            if (def && !def.disabled) this._saveProviderDefault(def.dataset.provider);
        });

        document.body.appendChild(popup);
        // Anchor to whichever chip opened it: above a bottom chip (status
        // bar), below a top chip (connection bar).
        const anchor = anchorEl || this.els.statusProvider;
        const rect = anchor.getBoundingClientRect();
        popup.style.left = `${rect.left}px`;
        if (rect.top < window.innerHeight / 2) {
            popup.style.top = `${rect.bottom + 6}px`;
        } else {
            popup.style.bottom = `${window.innerHeight - rect.top + 6}px`;
        }

        requestAnimationFrame(() => popup.classList.add('open'));
    }

    _closeProviderPopup() {
        if (this._providerPopup) {
            this._providerPopup.remove();
            this._providerPopup = null;
        }
        this._providerPopupOpen = false;
    }

    async _selectProvider(name) {
        const p = providerInfo(name);
        const session = this.getSession();
        if (!p || !session) { this._closeProviderPopup(); return; }

        if (!p.available) {
            showToast(S.provider.unavailable_toast
                .replace('{provider}', p.display_name)
                .replace('{reason}', p.unavailable_reason || ''));
            return;  // keep the popup open — the row is informational
        }

        this._closeProviderPopup();

        if (!session.storeId) {
            // Tab not created server-side yet — the choice rides the create
            // connect (?provider=) once a project is picked.
            session.pendingProvider = name;
            this._afterProviderChange(session);
            showToast(S.provider.pending_toast.replace('{provider}', p.display_name));
            return;
        }

        const bound = session.provider || PROVIDERS_INFO.default;
        if (name === bound) return;  // already on it

        if (!this._providerLocked(session)) {
            // Empty bound session — switch it in place (server 409s if a turn
            // raced us, in which case fall through to the new-tab path).
            try {
                const resp = await fetch(`${CONFIG.API_BASE}/api/session/${session.storeId}/provider`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ provider: name }),
                });
                if (resp.ok) {
                    session.provider = name;
                    session.providerDisplayName = p.display_name;
                    session.providerCaps = p.capabilities || null;
                    this._afterProviderChange(session);
                    // The server re-anchors cross-provider picks on bind (a
                    // preferred_model the new provider's catalog doesn't offer
                    // is cleared) — re-pull model state so the chip agrees.
                    this.setSession(session.storeId);
                    showToast(S.provider.switch_toast.replace('{provider}', p.display_name));
                    return;
                }
                if (resp.status !== 409) {
                    console.error('Provider switch failed:', resp.status);
                    return;
                }
                session.providerLocked = true;  // raced a turn — fall through
            } catch (e) {
                console.error('Provider switch failed:', e);
                return;
            }
        }

        // Locked session → open a new tab pre-set to the picked provider.
        // Inherit the project too and connect right away, so the switch is one
        // action — not "new tab, now go pick the folder again".
        const created = session.cwd
            ? window.app?.sessionManager?.create?.({ cwd: session.cwd })
            : window.app?.createSession?.();
        if (created) {
            created.pendingProvider = name;
            if (session.cwd) {
                window.app?.switchToSession?.(created);
                // cwd is inherited, so the tab routes straight to the chat
                // view — suppress the connection bar's brief flash (same
                // guard as cloneSession).
                window.app?.els?.connectionBar?.classList.remove('visible');
                created.connect();
            }
            this._afterProviderChange(created);
            showToast(S.provider.new_tab_toast.replace('{provider}', p.display_name));
        }
    }

    /** Shared refresh after any provider change: persist tabs, redraw the strip
     * badge + status chips, and re-pull the per-provider vocabularies (each
     * provider speaks its own permission modes / effort scale / accounts). */
    _afterProviderChange(session) {
        window.app?.sessionManager?.saveSessions?.();
        window.app?.renderTabs?.();
        this.updateStatus();
        if (session?.isActive !== false) {
            window.permissionSettings?.setSession?.(session.storeId || null, {
                pendingProvider: session.pendingProvider || null,
            });
            window.effortSettings?.setSession?.(session.storeId || null);
            window.tokenProfile?.setSession?.(session.storeId || null);
        }
    }

    async _saveProviderDefault(name) {
        if (!name) return;
        this._closeProviderPopup();
        try {
            const resp = await fetch(`${CONFIG.API_BASE}/api/app/default-provider`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ default_provider: name }),
            });
            if (resp.ok && PROVIDERS_INFO) {
                PROVIDERS_INFO.default = name;
                this.updateStatus();
            }
        } catch (e) {
            console.error('Failed to save default provider:', e);
        }
    }

    async _selectModel(modelId) {
        this.currentModel = modelId || null;
        this._closeModelPopup();
        this.updateStatus();

        if (!this.currentSessionId) {
            if (modelId) await this._saveToGlobal(modelId);
            return;
        }

        // Keep the session's pref cache in step so the next tab switch
        // seeds the pick synchronously.
        const sess = this.getSession();
        if (sess?.storeId === this.currentSessionId) {
            sess.preferredModel = modelId || null;
        }

        try {
            await fetch(`${CONFIG.API_BASE}/api/session/${this.currentSessionId}/model`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                // '' (the "Default" row) clears the pin like null does
                body: JSON.stringify({ preferred_model: modelId || null }),
            });
        } catch (e) {
            console.error('Failed to save model preference:', e);
        }
    }

    async _saveToGlobal(modelId, providerName) {
        if (!modelId) return;
        this.globalDefaultModel = modelId;
        this._closeModelPopup();
        try {
            // Defaults are per-provider — write THIS provider's entry.
            const name = providerName || this._activeProvider()?.name || PROVIDERS_INFO?.default;
            const key = providerInfo(name)?.models_key || name;
            if (key) this._defaultModelByProvider[key] = modelId;
            await fetch(`${CONFIG.API_BASE}/api/app/provider-defaults/${encodeURIComponent(name)}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ default_model: modelId }),
            });
        } catch (e) {
            console.error('Failed to save default model:', e);
        }
    }

    /**
     * Hide context popover
     */
    hideContextPopover() {
        const popover = document.getElementById('context-popover');
        if (popover) {
            popover.classList.remove('visible');
            setTimeout(() => popover.remove(), 150);
        }
    }

    /**
     * Format milliseconds as relative time string
     */
    _formatTimeAgo(ms) {
        const seconds = Math.floor(ms / 1000);
        if (seconds < 5) return 'just now';
        if (seconds < 60) return `${seconds}s ago`;
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60) return `${minutes}m ago`;
        const hours = Math.floor(minutes / 60);
        return `${hours}h ago`;
    }
}
