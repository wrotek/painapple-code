/**
 * Utility functions and Storage class
 */

// DOM selectors
export const $ = (sel) => document.querySelector(sel);
export const $$ = (sel) => document.querySelectorAll(sel);

// Generate unique ID
export const genId = () => 'sess_' + Math.random().toString(36).substr(2, 9);

// Escape HTML to prevent XSS
export const escapeHtml = (text) => {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
};

// Escape a string for safe interpolation INSIDE a double-quoted HTML attribute
// value. escapeHtml only neutralizes & < > (safe for element *content*), but
// attribute values also need quotes escaped — otherwise model-controlled data
// (e.g. a file_path containing `"`) can break out of the attribute and inject
// new attributes or event handlers. Use this for any attr built from untrusted
// input; keep the value out of inline JS entirely (read it back via dataset).
export const escapeAttr = (text) =>
    escapeHtml(text).replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Sanitize server-produced SVG before it goes into innerHTML. The chart /
// excalidraw renderers build SVG from model-authored specs, so it can carry
// <foreignObject>, onerror/onbegin handlers, or xlink:href="javascript:".
// DOMPurify's SVG profile strips those. Fail closed (drop the SVG) if
// DOMPurify isn't loaded — never inject unsanitized SVG.
export const sanitizeSvg = (svg) => {
    if (typeof DOMPurify === 'undefined' || typeof DOMPurify.sanitize !== 'function') {
        console.error('DOMPurify not loaded — SVG dropped');
        return '';
    }
    return DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } });
};

// Decode HTML entities (reverse of escapeHtml)
export const decodeHtml = (html) => {
    const div = document.createElement('div');
    div.innerHTML = html;
    return div.textContent;
};

/**
 * Open a URL externally via a synthetic anchor click — the same mechanism
 * as tapping a rendered <a target="_blank"> in chat, which is the only
 * link-opening primitive proven to work everywhere we run. Do NOT use
 * window.open() for external links: in the iPad standalone PWA (WKWebView)
 * it silently no-ops even inside a user gesture, while native anchor
 * activation reliably hands http(s) URLs to Safari. On desktop browsers
 * this opens a regular new tab. Must be called during a user gesture
 * (click/touchend handler) or popup blocking may swallow it.
 */
export function openExternal(url) {
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    document.body.appendChild(a);
    a.click();
    a.remove();
}

// Format time as HH:MM, prefixed with YYYY-MM-DD if older than 18 hours
export const formatTime = (date) => {
    const d = new Date(date);
    const time = d.toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
    });
    if (Date.now() - d.getTime() > 18 * 3600 * 1000) {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${day} ${time}`;
    }
    return time;
};

// Higher-precision sibling of formatTime. Defaults to HH:MM:SS;
// pass {ms: true} for HH:MM:SS.mmm (debug-log granularity).
export const formatTimePrecise = (date, { ms = false } = {}) => {
    const d = new Date(date);
    const opts = {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    };
    if (ms) opts.fractionalSecondDigits = 3;
    return d.toLocaleTimeString('en-US', opts);
};

// Three-branch formatter: HH:MM today, "Mon D" earlier this year, "Mon D, YYYY" older.
export const formatTimeOrDate = (date) => {
    const d = new Date(date);
    const now = new Date();
    if (now - d < 86400000 && d.getDate() === now.getDate()) {
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    if (d.getFullYear() === now.getFullYear()) {
        return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    }
    return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
};

// Format relative time ("just now", "5m ago", "2h ago", "yesterday", "3d ago",
// "2w ago" up to 30 days, then locale date).
export const formatRelativeTime = (date) => {
    const now = new Date();
    const then = new Date(date);
    const diffMs = now - then;
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHour = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHour / 24);

    if (diffSec < 60) return 'just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    if (diffHour < 24) return `${diffHour}h ago`;
    if (diffDay === 1) return 'yesterday';
    if (diffDay < 7) return `${diffDay}d ago`;
    if (diffDay < 30) return `${Math.floor(diffDay / 7)}w ago`;
    return then.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};

// Format duration in ms as "450ms" / "45s" / "3m 42s" / "2h 5m".
// Omits the smaller unit when it's 0 ("3m", not "3m 0s").
export const formatDuration = (ms) => {
    if (!ms || ms <= 0) return '';
    if (ms < 1000) return `${Math.round(ms)}ms`;
    const sec = Math.floor(ms / 1000);
    if (sec < 60) return `${sec}s`;
    const min = Math.floor(sec / 60);
    if (min < 60) {
        const remSec = sec % 60;
        return remSec > 0 ? `${min}m ${remSec}s` : `${min}m`;
    }
    const hr = Math.floor(min / 60);
    const remMin = min % 60;
    return remMin > 0 ? `${hr}h ${remMin}m` : `${hr}h`;
};

// Format byte count as "123 B" / "1.5 KB" / "2.3 MB" / "1.2 GB"
// Uses 1024-based units; strips trailing ".0" (e.g., "1 KB" not "1.0 KB").
export const formatSize = (bytes) => {
    if (!bytes || bytes <= 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
};

// Format mtime (seconds-since-epoch) as "Just now" / "5m ago" / "2h ago" / "Mar 15"
export const formatDate = (mtime) => {
    if (!mtime) return '';
    const d = new Date(mtime * 1000);
    const now = new Date();
    const diff = now - d;
    if (diff < 0) return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(diff / 3600000);
    if (hours < 24) return `${hours}h ago`;
    const sameYear = d.getFullYear() === now.getFullYear();
    return d.toLocaleDateString('en-US', sameYear
        ? { month: 'short', day: 'numeric' }
        : { month: 'short', day: 'numeric', year: 'numeric' });
};

/**
 * Thinking keyword definitions with token budgets
 * Based on Claude Code's extended thinking system
 */
export const THINKING_KEYWORDS = {
    // Ultrathink level (31,999 tokens) - most specific, check first
    ultrathink: [
        'ultrathink',
        'think really hard',
        'think super hard',
        'think very hard',
        'think harder',
        'think intensely',
        'think longer'
    ],
    // Megathink level (10,000 tokens)
    megathink: [
        'megathink',
        'think hard',
        'think deeply',
        'think a lot',
        'think about it',
        'think more'
    ],
    // Basic think level (4,000 tokens) - most generic, check last
    think: [
        'think'
    ]
};

// All keywords flattened for matching (longer phrases first to avoid partial matches)
const ALL_THINKING_KEYWORDS = [
    ...THINKING_KEYWORDS.ultrathink,
    ...THINKING_KEYWORDS.megathink,
    ...THINKING_KEYWORDS.think
].sort((a, b) => b.length - a.length);

/**
 * Get thinking level for a keyword
 * @param {string} keyword - The matched keyword
 * @returns {string} Level name (ultrathink, megathink, think)
 */
export function getThinkingLevel(keyword) {
    const lower = keyword.toLowerCase();
    if (THINKING_KEYWORDS.ultrathink.includes(lower)) return 'ultrathink';
    if (THINKING_KEYWORDS.megathink.includes(lower)) return 'megathink';
    return 'think';
}

/**
 * Highlight thinking keywords in text
 * @param {string} text - Text to highlight (should already be HTML-escaped)
 * @param {Object} options - Options
 * @param {boolean} options.showBudget - Show token budget in tooltip (default: true)
 * @returns {string} HTML with highlighted keywords
 */
export function highlightThinkingKeywords(text, options = {}) {
    const { showBudget = true } = options;

    // Token budgets for tooltips
    const budgets = {
        ultrathink: '31,999',
        megathink: '10,000',
        think: '4,000'
    };

    // Build regex pattern (case-insensitive, word boundaries)
    // Escape special regex chars and join with |
    const pattern = ALL_THINKING_KEYWORDS
        .map(kw => kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('|');

    const regex = new RegExp(`\\b(${pattern})\\b`, 'gi');

    return text.replace(regex, (match) => {
        const level = getThinkingLevel(match);
        const tooltip = showBudget ? ` data-tooltip="${level}: ${budgets[level]} tokens"` : '';
        return `<span class="thinking-keyword thinking-keyword-${level}"${tooltip}>${match}</span>`;
    });
}

/**
 * Check if text contains any thinking keywords
 * @param {string} text - Text to check
 * @returns {boolean}
 */
export function hasThinkingKeywords(text) {
    const lower = text.toLowerCase();
    return ALL_THINKING_KEYWORDS.some(kw => {
        const regex = new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
        return regex.test(lower);
    });
}

/**
 * localStorage wrapper with JSON serialization
 */
export class Storage {
    // Track last quota warning time to avoid spam
    static _lastQuotaWarning = 0;
    static _quotaWarningInterval = 60000; // 1 minute between warnings

    static get(key, defaultValue = null) {
        try {
            const data = localStorage.getItem(key);
            return data ? JSON.parse(data) : defaultValue;
        } catch {
            return defaultValue;
        }
    }

    /**
     * Save value to localStorage
     * @returns {boolean} true if save succeeded, false if quota exceeded
     */
    static set(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
            return true;
        } catch (e) {
            const isQuotaError = e.name === 'QuotaExceededError' ||
                                 e.code === 22 ||  // Legacy Safari
                                 e.code === 1014;  // Firefox

            if (isQuotaError) {
                console.error('[Storage] Quota exceeded saving:', key);
                this._notifyQuotaExceeded(key);
            } else {
                console.warn('[Storage] Error saving:', key, e);
            }
            return false;
        }
    }

    static remove(key) {
        localStorage.removeItem(key);
    }

    /**
     * Get localStorage usage statistics
     * @returns {{used: number, usedMB: string, keys: Object}}
     */
    static getUsage() {
        let total = 0;
        const keys = {};

        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            const value = localStorage.getItem(key);
            const size = (key.length + value.length) * 2; // UTF-16 = 2 bytes per char
            keys[key] = size;
            total += size;
        }

        return {
            used: total,
            usedMB: (total / 1024 / 1024).toFixed(2) + ' MB',
            keys
        };
    }

    /**
     * Check if storage is near quota (~5MB typical limit)
     * @returns {boolean}
     */
    static isNearQuota(thresholdMB = 4) {
        const { used } = this.getUsage();
        return used > thresholdMB * 1024 * 1024;
    }

    /**
     * Notify user of quota exceeded (throttled)
     * @private
     */
    static _notifyQuotaExceeded(key) {
        const now = Date.now();
        if (now - this._lastQuotaWarning < this._quotaWarningInterval) {
            return; // Throttle warnings
        }
        this._lastQuotaWarning = now;

        // Dispatch custom event that can be caught by the app
        const event = new CustomEvent('storage-quota-exceeded', {
            detail: { key, usage: this.getUsage() }
        });
        window.dispatchEvent(event);

        // Also show via window.debugLog if available (for debug console)
        if (window.debugLog) {
            window.debugLog('Storage', 'QUOTA EXCEEDED - Tab state may not persist!');
        }
    }
}

/**
 * Extract error message from FastAPI/Pydantic response
 * Handles both string and array formats of error.detail
 * @param {Object} err - Parsed error response body
 * @param {string} fallback - Fallback message if extraction fails
 * @returns {string} Human-readable error message
 */
export function extractApiError(err, fallback = 'Request failed') {
    if (!err || !err.detail) return fallback;

    // String detail (most common)
    if (typeof err.detail === 'string') return err.detail;

    // Array of Pydantic validation errors
    if (Array.isArray(err.detail)) {
        return err.detail
            .map(e => e.msg || JSON.stringify(e))
            .join(', ') || fallback;
    }

    // Object with message field
    if (typeof err.detail === 'object' && err.detail.msg) {
        return err.detail.msg;
    }

    return fallback;
}

/**
 * Parse <usage> tag and agentId line from Task tool output text.
 * Returns { text: cleanedText, usage: { totalTokens, toolUses, durationMs } | null }
 */
export function parseTaskUsage(text) {
    if (!text) return { text: '', usage: null };

    let usage = null;
    let cleaned = text;

    // Extract <usage>...</usage> block
    const usageMatch = cleaned.match(/<usage>([\s\S]*?)<\/usage>/);
    if (usageMatch) {
        const body = usageMatch[1];
        const get = (key) => {
            const m = body.match(new RegExp(`${key}:\\s*(\\d+)`));
            return m ? parseInt(m[1], 10) : 0;
        };
        usage = {
            totalTokens: get('total_tokens'),
            toolUses: get('tool_uses'),
            durationMs: get('duration_ms'),
        };
        cleaned = cleaned.replace(/<usage>[\s\S]*?<\/usage>/, '');
    }

    // Strip agentId line
    cleaned = cleaned.replace(/^agentId:\s+\S+.*$/gm, '');
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();

    return { text: cleaned, usage };
}

/** Format token count for badge display (e.g., 111828 -> "112K tok") */
export function formatTokensBadge(tokens) {
    if (!tokens || tokens <= 0) return '';
    if (tokens >= 1000) return `${Math.round(tokens / 1000)}K tok`;
    return `${tokens} tok`;
}


/**
 * In-app confirmation dialog replacing native confirm().
 * Native confirm() renders off-screen on iPadOS PWA.
 * Returns a Promise<boolean>.
 */
export function appConfirm(message, { confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false } = {}) {
    return new Promise((resolve) => {
        // Remove any existing confirm overlay
        const existing = document.getElementById('app-confirm-overlay');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.id = 'app-confirm-overlay';
        overlay.className = 'app-confirm-overlay';

        const box = document.createElement('div');
        box.className = 'app-confirm-box';

        const msg = document.createElement('p');
        msg.className = 'app-confirm-message';
        msg.textContent = message;

        const buttons = document.createElement('div');
        buttons.className = 'app-confirm-buttons';

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'app-confirm-cancel';
        cancelBtn.textContent = cancelLabel;

        const confirmBtn = document.createElement('button');
        confirmBtn.className = 'app-confirm-ok' + (danger ? ' danger' : '');
        confirmBtn.textContent = confirmLabel;

        buttons.append(cancelBtn, confirmBtn);
        box.append(msg, buttons);
        overlay.append(box);
        document.body.append(overlay);

        // Focus confirm button for keyboard accessibility
        confirmBtn.focus();

        function cleanup(result) {
            overlay.remove();
            resolve(result);
        }

        cancelBtn.addEventListener('click', () => cleanup(false));
        confirmBtn.addEventListener('click', () => cleanup(true));
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) cleanup(false);
        });
        overlay.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') cleanup(false);
        });
    });
}
