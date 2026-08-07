/**
 * Drafts Pill
 *
 * Small clickable "N drafts" pill in the top-right corner of the empty chat
 * input — the visible entry point to Prompt Explorer → Drafts. Drafts are
 * auto-banked silently while typing (see InputHandler's draft auto-sync),
 * so without this pill they'd be invisible until the user opened the
 * Prompt Explorer by hand.
 *
 * Visibility mirrors the shortcut-hints overlay lifecycle: shown only when
 * the input is empty, not in shell/plan mode, and at least one draft exists.
 * Count refreshes on `drafts-changed` window events (dispatched by every
 * draft mutation path) and lazily when the input empties.
 */

import S from './strings.js';
import { CONFIG } from './config.js';
import { openPromptExplorerDrafts } from './widgets/prompt-explorer-widget.js';

// Don't refetch the count more often than this on input-emptied transitions
// (drafts-changed events always refetch — they signal a real mutation)
const REFRESH_THROTTLE_MS = 60000;

class DraftsPillController {
    constructor() {
        this.el = null;
        this.count = 0;
        this.inputEmpty = true;
        this.suppressed = false;   // forced off by mode (shell/plan)
        this._lastFetch = 0;
    }

    init() {
        this.el = document.getElementById('drafts-pill');
        if (!this.el) return;
        this.el.setAttribute('data-tooltip', S.ui.input.drafts_pill_tooltip);
        this.el.addEventListener('click', () => openPromptExplorerDrafts());
        window.addEventListener('drafts-changed', () => this.refresh());
        this.refresh();
    }

    /** Refetch the draft count from the server. */
    async refresh() {
        this._lastFetch = Date.now();
        try {
            const res = await fetch(`${CONFIG.API_BASE}/api/drafts`);
            if (!res.ok) return;
            const data = await res.json();
            this.count = data.count ?? (data.drafts || []).length;
        } catch {
            /* offline/auth hiccup — keep last known count */
        }
        this._sync();
    }

    /** Called by input-handler whenever input content changes. */
    updateVisibility(textareaValue) {
        const isEmpty = !textareaValue || textareaValue.length === 0;
        const becameEmpty = isEmpty && !this.inputEmpty;
        this.inputEmpty = isEmpty;
        this._sync();
        // Input just emptied → opportunistic freshness check (throttled)
        if (becameEmpty && Date.now() - this._lastFetch > REFRESH_THROTTLE_MS) {
            this.refresh();
        }
    }

    /** Called by input-handler whenever input mode changes. */
    setMode(mode) {
        this.suppressed = mode === 'shell' || mode === 'plan';
        this._sync();
    }

    _sync() {
        if (!this.el) return;
        const show = this.count > 0 && this.inputEmpty && !this.suppressed;
        if (show) {
            this.el.textContent = this.count === 1
                ? S.ui.input.drafts_pill_one
                : S.ui.input.drafts_pill_many.replace('{count}', this.count);
        }
        this.el.classList.toggle('visible', show);
    }
}

export const DraftsPill = new DraftsPillController();

// Initialize on DOM ready (same pattern as ShortcutHints)
if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => DraftsPill.init());
    } else {
        DraftsPill.init();
    }
}
