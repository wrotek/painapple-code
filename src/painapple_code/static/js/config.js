/**
 * Configuration constants and command registry
 */

// Debug mode: enabled via ?debug=true URL param or localStorage
const debugParam = new URLSearchParams(window.location.search).get('debug');
const DEBUG = debugParam === 'true' || localStorage.getItem('debug') === 'true';

// Server identity — set on /api/info fetch + first WebSocket connect.
// `serverHome` is the OS user home (e.g. /home/app inside Docker, /home/me on
// a host install) — only meaningful for ~ expansion.
// `serverWorkspace` is the bridge's --workspace value (e.g. /workspace/myproj
// inside Docker, /home/me/dev/myproj on host) — used as the project base for
// the file explorer, autocomplete, and relative path resolution.
let serverHome = null;
let serverWorkspace = null;

// Version identity, shown in the help dialog's About section.
// `serverVersion` / `serverStaticBuild` come from /api/info.
let serverVersion = null;
let serverStaticBuild = null;
// Set when the checkout has moved on since the server booted — the process is
// serving older code than what's on disk, so it needs a restart (not a reload).
let serverDiskVersion = null;
let serverRestartNeeded = false;
// How the frontend is delivered: one bundle or ~190 loose modules. Whether a
// source install got the bundle depends on Node being present at install time,
// which is invisible from the page — so the About panel says which it is.
// null (not false) until /api/info answers, and on servers too old to report.
let serverBundled = null;
let serverBundleReason = null;
// License expression + project URLs from the installed distribution, shown in
// the About widget. Server-supplied so a fork advertises its own source.
let serverLicense = null;
let serverUrls = {};
let serverAuthor = null;

// The frontend build THIS page actually loaded: /app rewrites every asset URL
// with `?v=<newest static mtime>`, so our own module URL carries it. Reading it
// here (rather than asking the server) is what makes a stale-page check
// meaningful — the server's current mtime moves the moment a file is edited,
// while this stays pinned to whatever the browser cached.
export const CLIENT_BUILD = (() => {
    try {
        return new URL(import.meta.url).searchParams.get('v');
    } catch {
        return null;
    }
})();

// Default system settings
const DEFAULTS = {
    SESSION_LIST_LIMIT: 100,
};

// User config storage key (shared with config-panel.js)
const CONFIG_STORAGE_KEY = 'claude-code-user-config';

// NOTE: there is deliberately no cap on concurrent session tabs. The old
// CONFIG.MAX_SESSIONS (default 10, user-settable 1-20) refused createSession()
// once the strip was full; nothing about the client actually breaks past that
// number, so the guard was pure friction. The legacy `maxSessions` key may
// still sit in localStorage on old profiles — it is simply ignored.

// Load session list limit from user config
function getSessionListLimit() {
    try {
        const saved = localStorage.getItem(CONFIG_STORAGE_KEY);
        if (saved) {
            const config = JSON.parse(saved);
            if (config.sessionListLimit && Number.isInteger(config.sessionListLimit) && config.sessionListLimit >= 10 && config.sessionListLimit <= 500) {
                return config.sessionListLimit;
            }
        }
    } catch (e) {
        console.error('Failed to load sessionListLimit from config:', e);
    }
    return DEFAULTS.SESSION_LIST_LIMIT;
}

// Determine protocol based on page protocol (http vs https)
const isSecure = window.location.protocol === 'https:';
const wsProtocol = isSecure ? 'wss:' : 'ws:';
const httpProtocol = isSecure ? 'https:' : 'http:';

export const CONFIG = {
    DEBUG,
    get SESSION_LIST_LIMIT() { return getSessionListLimit(); },
    DEFAULT_SESSION_LIST_LIMIT: DEFAULTS.SESSION_LIST_LIMIT,
    WS_URL: `${wsProtocol}//${window.location.host}/chat`,
    API_BASE: `${httpProtocol}//${window.location.host}`,
    RECONNECT_DELAYS: [1000, 2000, 4000, 8000, 16000, 30000],
    STORAGE_KEY: 'claude-code-sessions',
    ACTIVE_SESSION_KEY: 'claude-code-active-session',
    ACTIVE_MODE_KEY: 'claude-code-active-mode',
    WIDGET_TABS_KEY: 'claude-code-widget-tabs',
    TAB_ORDER_KEY: 'claude-code-tab-order',
    HISTORY_KEY: 'claude-code-history',
    MAX_OUTPUT_LENGTH: 3000,
    MAX_HISTORY: 10,
    // Dynamic getters for paths that depend on server home / workspace.
    // HOME = OS user home (~ semantics). PROJECTS_BASE = where to anchor the
    // file explorer and resolve relative paths — prefer the explicit
    // --workspace value, fall back to ~/dev for host installs.
    get HOME() { return serverHome || '/home'; },
    get WORKSPACE() { return serverWorkspace || serverHome || '/home'; },
    get PROJECTS_BASE() {
        if (serverWorkspace) return serverWorkspace;
        return serverHome ? `${serverHome}/dev` : '/home';
    },
};

// Instance identity (injected by server via --instance-name / --accent CLI flags)
export const INSTANCE = window.INSTANCE_CONFIG || null;

// Called when server sends home path in connected message
export function setServerHome(home) {
    if (home && !serverHome) {
        serverHome = home;
        debug.log('Server home set:', home);
    }
}

// Called when server sends --workspace value (in /api/info and the WS
// `connected` message). This is what powers the file explorer's anchor
// and CONFIG.PROJECTS_BASE; setting it once is enough since the bridge
// can't change --workspace at runtime.
export function setServerWorkspace(workspace) {
    if (workspace && !serverWorkspace) {
        serverWorkspace = workspace;
        debug.log('Server workspace set:', workspace);
    }
}

// Called with the /api/info payload. Unlike home/workspace these are allowed
// to be re-set: a reconnect after a server upgrade should report the new
// version rather than the one this tab booted against.
export function setServerVersionInfo({ version, staticBuild, bundled, bundleReason, diskVersion, restartNeeded, license, urls, author } = {}) {
    if (version) serverVersion = version;
    if (staticBuild) serverStaticBuild = String(staticBuild);
    // Explicit undefined check: `false` is the interesting value here, and a
    // truthiness guard would discard exactly the case worth reporting.
    if (bundled !== undefined && bundled !== null) serverBundled = Boolean(bundled);
    if (bundleReason !== undefined) serverBundleReason = bundleReason || null;
    serverDiskVersion = diskVersion || null;
    serverRestartNeeded = Boolean(restartNeeded);
    if (license) serverLicense = license;
    if (urls && typeof urls === 'object' && Object.keys(urls).length) serverUrls = urls;
    if (author) serverAuthor = author;
}

/**
 * Version identity for the About section.
 * `stale` is true when the server has newer static assets than this page
 * loaded — i.e. a reload would pick up frontend changes.
 */
export function getVersionInfo() {
    return {
        server: serverVersion,
        clientBuild: CLIENT_BUILD,
        serverBuild: serverStaticBuild,
        stale: Boolean(
            CLIENT_BUILD && serverStaticBuild && CLIENT_BUILD !== serverStaticBuild
        ),
        bundled: serverBundled,
        bundleReason: serverBundleReason,
        diskVersion: serverDiskVersion,
        restartNeeded: serverRestartNeeded,
        license: serverLicense,
        urls: serverUrls,
        author: serverAuthor,
    };
}

/**
 * Debug logger - only logs when CONFIG.DEBUG is true
 * Usage: debug.log('message'), debug.warn('warning')
 */
export const debug = {
    log: (...args) => DEBUG && console.log('[DEBUG]', ...args),
    warn: (...args) => DEBUG && console.warn('[DEBUG]', ...args),
    info: (...args) => DEBUG && console.info('[DEBUG]', ...args),
};

// Detect if device likely has a physical keyboard
// iPhone = touch-only, everything else (iPad/desktop) likely has keyboard
export const HAS_PHYSICAL_KEYBOARD = !/iPhone/.test(navigator.userAgent);

export const COMMANDS = [
    { cmd: '/help', desc: 'Show help and keyboard shortcuts', action: 'showHelp' },
    { cmd: '/clear', desc: 'Archive session, start fresh in same project', action: 'clearMessages' },
    { cmd: '/compact', desc: 'Ask Claude to summarize conversation', action: 'compactSession', hasArgs: true },
    { cmd: '/new', desc: 'Create a new session', action: 'createSession' },
    { cmd: '/fork', desc: 'Fork session (branch conversation)', action: 'forkSession' },
    { cmd: '/fork-compact', desc: 'Fork session then compact (branch + summarize)', action: 'forkCompactSession', hasArgs: true },
    { cmd: '/clone', desc: 'Clone session (same project, fresh chat). Add text to send immediately.', action: 'cloneSession', hasArgs: true },
    { cmd: '/plan', desc: 'Enter plan mode (explore & design before coding)', action: 'planMode', hasArgs: true },
    { cmd: '/btw', desc: 'Side question — fork a quick discussion thread (no selection needed)', action: 'btwDiscussion', hasArgs: true },
    { cmd: '/login', desc: 'Sign in to Anthropic — opens an interactive terminal', action: 'openLoginTerminal' },
    { cmd: '/logout', desc: 'Sign out of Anthropic — opens an interactive terminal', action: 'openLogoutTerminal' },
];

// Default shell commands for autocomplete (loaded from localStorage if available)
export function getRecentShellCommands() {
    try {
        const saved = localStorage.getItem('recent-shell');
        if (saved) {
            return JSON.parse(saved);
        }
    } catch {}
    return [
        'git status',
        'git diff',
        'ls -la',
        'npm test',
        'npm run build',
    ];
}
