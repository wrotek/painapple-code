import S from './strings.js';
import { debug, getVersionInfo } from './config.js';
/**
 * Keyboard Shortcuts Registry and Manager
 *
 * Central registry for all keyboard shortcuts with:
 * - Single source of truth for shortcut definitions
 * - Platform-aware key display (Cmd on Mac, Ctrl elsewhere)
 * - Dynamic help content generation
 */

// Detect Mac/iOS — Cmd is the action modifier on these platforms. iPadOS 13+
// reports navigator.platform as 'MacIntel' too, so the same regex catches it.
export const IS_MAC = /Mac|iPhone|iPad|iPod/.test(navigator.platform);
const CURRENT_PLATFORM = IS_MAC ? 'mac' : 'other';

/**
 * Resolve effective keybindings for a shortcut on a given platform.
 *
 * Schema:
 *   keys:  bindings registered on BOTH platforms (literal physical key combo)
 *   mac:   bindings registered only on Mac/iPad
 *   other: bindings registered only on Windows/Linux/ChromeOS
 *
 * Effective bindings = (keys ∪ platform-specific). No aliasing — Cmd and
 * Ctrl are distinct keys on Mac, treated as such, so each registry entry
 * declares exactly which physical keys fire on which platform.
 */
export function resolveKeys(shortcut, platform = CURRENT_PLATFORM) {
    return [...(shortcut.keys || []), ...(shortcut[platform] || [])];
}

/**
 * Format a single key combo for display.
 *  - On Mac: substitutes ⌘ ⌃ ⌥ ⇧ sigils; joins sigil to key with a narrow
 *    no-break space ( ) so chips don't break mid-binding.
 *  - On other: pass through as captured (e.g. "Ctrl+K").
 *
 * Also strips redundant Shift on shifted symbols ("Shift+?" → "?").
 */
export function formatKeyForDisplay(keyCombo) {
    const cleaned = keyCombo.replace(/^Shift\+([^A-Za-z0-9])$/i, '$1');
    if (IS_MAC) {
        return cleaned
            .replace(/Cmd\+/gi, '⌘ ')
            .replace(/Ctrl\+/gi, '⌃ ')
            .replace(/Alt\+/gi, '⌥ ')
            .replace(/Shift\+/gi, '⇧ ');
    }
    return cleaned;
}

/**
 * Normalize a chord for comparison ("Ctrl+Shift+K" → "ctrl+k+shift").
 * Modifier order is irrelevant, so sort the parts.
 */
function normalizeChord(keyString) {
    return keyString.toLowerCase().split('+').sort().join('+');
}

// literal chord → chord that actually fires on this platform. Built lazily
// from SHORTCUTS + user overrides; invalidated whenever the map is rebuilt.
let literalChordMap = null;

function buildLiteralChordMap() {
    const overrides = loadUserShortcutOverrides();
    const map = new Map();
    for (const shortcut of SHORTCUTS) {
        const effective = overrides[shortcut.id] || resolveKeys(shortcut);
        if (!effective.length) continue;
        // Every chord this entry declares on ANY platform is a valid alias to
        // look it up by — that's what the hardcoding surfaces wrote down.
        const declared = [...(shortcut.keys || []), ...(shortcut.mac || []), ...(shortcut.other || [])];
        for (const chord of declared) {
            const key = normalizeChord(chord);
            if (map.has(key)) continue;  // first entry in registry order wins
            // On Mac, advertise the Cmd binding when the entry has one — several
            // entries keep an iPad-safe Ctrl chord in `keys` AND a Cmd twin in
            // `mac` (both fire), and ⌘ is what a Mac user expects to read.
            // Otherwise keep the literal if it still fires here, else fall back
            // to the entry's first effective binding.
            const cmd = IS_MAC && effective.find(e => /Cmd\+/i.test(e));
            const live = effective.find(e => normalizeChord(e) === key);
            map.set(key, cmd || live || effective[0]);
        }
    }
    return map;
}

/**
 * Format a chord that was hardcoded OUTSIDE this registry — quick-action
 * definitions, widget `shortcut:` fields — for display on this platform.
 *
 * Those surfaces each wrote down one platform's chord (historically the Ctrl
 * one), so on Mac they advertised a binding that doesn't fire while the help
 * overlay showed the Cmd one. Resolve the literal back to its SHORTCUTS entry
 * (honouring user overrides) and render that entry's effective binding.
 * Unclaimed literals fall through to plain sigil formatting.
 */
export function formatLiteralChord(literal) {
    if (!literal) return literal;
    if (!literalChordMap) literalChordMap = buildLiteralChordMap();
    return formatKeyForDisplay(literalChordMap.get(normalizeChord(literal)) || literal);
}

/**
 * Format a chord handled locally by a widget rather than by this registry
 * (annotation undo, in-preview search…). Those handlers gate on
 * `e.metaKey || e.ctrlKey`, so Cmd genuinely works on Mac — advertise it.
 */
export function formatModChord(literal) {
    if (!literal) return literal;
    return formatKeyForDisplay(IS_MAC ? literal.replace(/Ctrl\+/gi, 'Cmd+') : literal);
}

/**
 * Resolve chord placeholders inside a strings.yaml value, so UI copy can name
 * a shortcut without hardcoding one platform's modifier:
 *
 *   "Search ({key:Ctrl+F})"   → "Search (⌘ F)"      on Mac, "Search (Ctrl+F)" elsewhere
 *   "Undo ({modkey:Ctrl+Z})"  → "Undo (⌘ Z)"        on Mac  (widget-local handler)
 *
 * `key:` resolves through the shortcut registry (use it when a SHORTCUTS entry
 * owns the binding); `modkey:` is for handlers that gate on metaKey||ctrlKey.
 */
export function withChords(text) {
    if (typeof text !== 'string') return text;
    return text
        .replace(/\{key:([^}]+)\}/g, (_, chord) => formatLiteralChord(chord))
        .replace(/\{modkey:([^}]+)\}/g, (_, chord) => formatModChord(chord));
}

/**
 * Shortcut categories for help organization
 */
export const CATEGORIES = {
    sessions: 'Sessions & Tabs',
    panels: 'Panels',
    search: 'Search',
    editor: 'Editor',
    navigation: 'Navigation',
    other: 'Other'
};

/**
 * Shortcut registry
 *
 * Format:
 * - id: Unique identifier
 * - keys / mac / other: Key bindings, resolved per-platform by resolveKeys().
 *     `keys`  = bindings on BOTH platforms (literal — e.g. ['Ctrl+`'])
 *     `mac`   = bindings on Mac/iPad only (e.g. ['Cmd+T'])
 *     `other` = bindings on Win/Linux/ChromeOS only (e.g. ['Ctrl+T'])
 *   Effective bindings = (keys ∪ platform-specific). Cmd and Ctrl are
 *   distinct keys on Mac — no aliasing.
 * - action: App method name to call
 * - args: Optional arguments for action
 * - label: Human-readable description
 * - category: Category for help grouping
 * - when: Context restriction (always, global [default], notInInput, notInTerminal, notInEditor, session, editor, terminal)
 *         'always' = fires everywhere including terminal; 'global' = fires everywhere EXCEPT terminal
 */
export const SHORTCUTS = [
    // ─────────────────────────────────────────────────────────────────────
    // Sessions & Tabs
    // ─────────────────────────────────────────────────────────────────────
    {
        id: 'newSession',
        mac: ['Cmd+T'],
        other: ['Ctrl+T'],
        action: 'createSession',
        label: S.shortcuts.new_session,
        category: 'sessions'
    },
    {
        id: 'quickSwitcher',
        // Cmd+P / Ctrl+P matches the universal "Quick Open" muscle memory
        // from VS Code / Cursor / Zed — both keys open the same fuzzy picker.
        mac: ['Cmd+K', 'Cmd+P'],
        other: ['Ctrl+K', 'Ctrl+P'],
        action: 'toggleQuickSwitcher',
        label: S.quick_switcher.action.label,
        category: 'sessions',
        when: 'always'
    },
    {
        id: 'openDialog',
        mac: ['Cmd+O'],
        other: ['Ctrl+O'],
        action: 'toggleOpenDialog',
        label: S.open_dialog.action.label,
        category: 'sessions',
        when: 'always'
    },
    {
        id: 'browseSessions',
        mac: ['Cmd+Shift+K'],
        other: ['Ctrl+Shift+K'],
        action: 'showSessionsBrowser',
        label: S.shortcuts.browse_sessions,
        category: 'sessions'
    },
    {
        id: 'commandPalette',
        // Universal command-palette binding in VS Code / Cursor / Zed.
        // Opens the quick switcher pre-set to '>' command mode, listing
        // every Quick Action (which already covers most user-visible
        // commands). F1 is the title-bar muscle memory in VS Code, dropped
        // on Mac since iPad keyboards have no F-keys.
        mac: ['Cmd+Shift+P'],
        other: ['Ctrl+Shift+P', 'F1'],
        action: 'openCommandPalette',
        label: S.shortcuts.command_palette,
        category: 'sessions',
        when: 'always'
    },
    {
        id: 'gridSwitcher',
        // Alt+Tab works on Mac/iPad in-browser (macOS uses Cmd+Tab for the
        // app switcher); OS-reserves Alt+Tab on Win/Linux so we rebind there.
        mac: ['Alt+Tab'],
        other: ['Ctrl+Shift+]'],
        action: 'cycleGridSwitcher',
        args: [1],
        label: S.shortcuts.grid_switcher,
        category: 'sessions',
        when: 'always'
    },
    {
        id: 'gridSwitcherReverse',
        mac: ['Alt+Shift+Tab'],
        other: ['Ctrl+Shift+['],
        action: 'cycleGridSwitcher',
        args: [-1],
        label: S.shortcuts.grid_switcher_reverse,
        category: 'sessions',
        when: 'always',
        hidden: true
    },
    {
        id: 'closeTab',
        keys: ['Alt+W'],
        mac: ['Cmd+W'],
        other: ['Ctrl+W'],
        action: 'closeActiveTab',
        label: S.shortcuts.close_tab,
        category: 'sessions',
        when: 'always'
    },
    {
        id: 'reopenTab',
        mac: ['Cmd+Shift+T'],
        other: ['Ctrl+Shift+T'],
        action: 'reopenLastClosedTab',
        label: S.shortcuts.reopen_tab,
        category: 'sessions'
    },
    {
        id: 'cloneSession',
        // Cmd+N on Mac follows the "new of this kind" convention (the
        // current "kind" is a chat session). On Win/Linux Ctrl+N is taken
        // by newScratch, so clone falls back to Ctrl+Shift+N there.
        mac: ['Cmd+N'],
        other: ['Ctrl+Shift+N'],
        action: 'cloneSession',
        label: S.shortcuts.clone_session,
        category: 'sessions'
    },
    {
        id: 'newScratch',
        // Literal Ctrl+N on both platforms — universal "new file" idiom.
        // Mac's Ctrl modifier is largely free (rarely used by Mac apps),
        // so binding Ctrl+N there doesn't shadow Cmd+N (which clones).
        keys: ['Ctrl+N'],
        action: 'createScratchTab',
        label: S.shortcuts.new_scratch,
        category: 'sessions',
        when: 'always'
    },
    {
        id: 'prevTab',
        mac: ['Cmd+['],
        other: ['Ctrl+['],
        action: 'cycleTab',
        args: [-1],
        label: S.shortcuts.prev_tab,
        category: 'sessions',
        when: 'always'
    },
    {
        id: 'nextTab',
        mac: ['Cmd+]'],
        other: ['Ctrl+]'],
        action: 'cycleTab',
        args: [1],
        label: S.shortcuts.next_tab,
        category: 'sessions',
        when: 'always'
    },
    // Tab 1-9 shortcuts (generated below)

    // ─────────────────────────────────────────────────────────────────────
    // Panels
    // ─────────────────────────────────────────────────────────────────────
    {
        id: 'toggleTerminal',
        // Ctrl+` is the universal editor binding (VS Code / Cursor / Zed);
        // Ctrl+\ kept as the painapple-native alt (survives the `notInEditor`
        // gating that freed the backtick back up — see commit history).
        keys: ['Ctrl+`', 'Ctrl+\\'],
        action: 'toggleTerminalPanel',
        label: S.shortcuts.toggle_terminal,
        category: 'panels',
        when: 'always'
    },
    {
        id: 'newTerminal',
        // Ctrl+Shift+` is VS Code's "new terminal"; Ctrl+Shift+C kept as
        // the alt — both universal so they fire on every platform.
        keys: ['Ctrl+Shift+`', 'Ctrl+Shift+C'],
        // Cmd+Shift+C additively on Mac/iPad — matches the Mac muscle
        // memory for terminal-flavored chords. On macOS proper this
        // overrides Chrome/Safari's "Inspect Element" while the app is
        // focused; power users can rebind in settings if they need it.
        mac: ['Cmd+Shift+C'],
        action: 'createTerminal',
        label: S.shortcuts.new_terminal,
        category: 'panels',
        when: 'always'
    },
    {
        id: 'toggleRailMenu',
        // Ctrl/Cmd+B is the universal toggle-sidebar chord (VS Code /
        // Cursor / Zed). Default 'global' gating keeps it out of the
        // terminal, so tmux's Ctrl+B prefix still reaches xterm.
        mac: ['Cmd+B'],
        other: ['Ctrl+B'],
        action: 'toggleRailMenu',
        label: S.shortcuts.toggle_rail,
        category: 'panels'
    },
    {
        id: 'toggleFiles',
        keys: ['Alt+F'],
        action: 'toggleFileExplorer',
        label: S.shortcuts.toggle_files,
        category: 'panels'
    },
    {
        // Alt+V for "view" — Alt+P is already the prompt history. Reopens the
        // last previewed file, so it doubles as the way back after Escape.
        id: 'togglePreview',
        keys: ['Alt+V'],
        action: 'togglePreview',
        label: S.shortcuts.toggle_preview,
        category: 'panels'
    },
    {
        id: 'toggleLogs',
        keys: ['Alt+L'],
        action: 'toggleLogExplorer',
        label: S.shortcuts.toggle_logs,
        category: 'panels'
    },
    {
        id: 'toggleGit',
        keys: ['Alt+G'],
        action: 'toggleGitPanel',
        label: S.shortcuts.toggle_git,
        category: 'panels'
    },
    {
        id: 'toggleActiveSessions',
        keys: ['Alt+S'],
        action: 'toggleActiveSessions',
        label: S.shortcuts.toggle_sessions,
        category: 'panels'
    },
    {
        id: 'toggleCostAnalytics',
        keys: ['Alt+4'],
        action: 'toggleCostAnalytics',
        label: S.shortcuts.toggle_costs,
        category: 'panels'
    },
    {
        id: 'toggleDiscussion',
        keys: ['Alt+/'],
        action: 'toggleDiscussion',
        label: S.shortcuts.toggle_discussion,
        category: 'panels'
    },
    {
        id: 'toggleBackgroundTasks',
        keys: [],
        action: 'toggleBackgroundTasks',
        label: S.shortcuts.toggle_tasks,
        category: 'panels'
    },
    {
        id: 'toggleBrowser',
        keys: ['Alt+B'],
        action: 'toggleBrowser',
        label: S.shortcuts.toggle_browser,
        category: 'panels'
    },
    {
        id: 'toggleDebug',
        keys: ['Alt+D'],
        action: 'toggleDebugConsole',
        label: S.shortcuts.toggle_debug,
        category: 'panels'
    },
    {
        id: 'toggleEruda',
        // Alt+Shift+D fits the Alt-family of feature panels and leaves
        // Ctrl+Shift+D free for a future Debug/Diagnostics view (the
        // VS Code / Cursor / Zed consensus binding).
        keys: ['Alt+Shift+D'],
        action: 'toggleEruda',
        label: S.shortcuts.toggle_eruda,
        category: 'panels'
    },
    {
        id: 'toggleHistoryExplorer',
        keys: ['Alt+H'],
        action: 'toggleHistoryExplorer',
        label: S.shortcuts.toggle_history,
        category: 'panels'
    },
    {
        id: 'toggleZenMode',
        keys: ['Alt+Z'],
        action: 'toggleZenMode',
        label: S.shortcuts?.toggle_zen || 'Zen Mode',
        category: 'panels'
    },
    {
        id: 'toggleQuickActions',
        keys: ['Ctrl+Q'],
        action: 'toggleQuickActions',
        label: S.shortcuts.quick_actions,
        category: 'panels'
    },
    {
        id: 'togglePromptExplorer',
        // Ctrl+R is universal — bash reverse-i-search muscle memory.
        // Works on Mac too (Ctrl is largely free there) and is the
        // iPad-safe slot. Cmd+R is intentionally left unbound so it
        // reloads the page natively in browsers/PWA.
        keys: ['Alt+P', 'Ctrl+R'],
        action: 'togglePromptExplorer',
        label: S.shortcuts.toggle_prompts,
        category: 'panels',
        when: 'notInTerminal'
    },
    {
        id: 'savePromptDraft',
        // Banks the current input as a server-side draft (retrieve via
        // Prompt Explorer → Drafts). Ctrl+Shift+S is the iPad-safe slot
        // (Cmd+Shift+S is not OS-reserved on iPad but Ctrl works
        // everywhere); Cmd+Shift+S rides along on Mac.
        keys: ['Ctrl+Shift+S'],
        mac: ['Cmd+Shift+S'],
        action: 'savePromptDraft',
        label: S.shortcuts.save_prompt_draft,
        category: 'panels',
        when: 'notInTerminal'
    },
    {
        id: 'reloadPage',
        // Cmd+R reload, bound explicitly for the iOS/PWA standalone
        // wrapper where there's no browser chrome to handle it natively.
        // iPad reports as Mac, so this `mac` slot covers it. In a normal
        // desktop browser it just calls location.reload() — same result.
        mac: ['Cmd+R'],
        action: 'reloadPage',
        label: S.shortcuts.reload_page,
        category: 'other',
        when: 'always'
    },
    {
        id: 'toggleSkills',
        keys: ['Alt+K'],
        action: 'toggleSkills',
        label: S.shortcuts.toggle_skills,
        category: 'panels',
        when: 'notInTerminal'
    },
    {
        id: 'toggleCommands',
        keys: ['Alt+Shift+K'],
        action: 'toggleCommands',
        label: S.shortcuts.toggle_commands,
        category: 'panels',
        when: 'notInTerminal'
    },
    {
        id: 'toggleThinkingSettings',
        mac: ["Cmd+'"],
        other: ["Ctrl+'"],
        action: 'toggleThinkingSettings',
        label: S.shortcuts.toggle_thinking,
        category: 'panels'
    },
    {
        id: 'cycleEffortOneShot',
        mac: ["Cmd+Shift+'"],
        other: ["Ctrl+Shift+'"],
        action: 'cycleEffortOneShot',
        label: S.shortcuts.cycle_effort_oneshot,
        category: 'panels'
    },

    // ─────────────────────────────────────────────────────────────────────
    // Search
    // ─────────────────────────────────────────────────────────────────────
    {
        id: 'search',
        mac: ['Cmd+F'],
        other: ['Ctrl+F'],
        action: 'openSearch',
        label: S.shortcuts.search,
        category: 'search'
    },
    {
        id: 'searchFiles',
        // VS Code muscle memory for project-wide search. Ctrl+Shift+F is the
        // iPad-safe binding; Cmd+Shift+F rides along on Mac.
        keys: ['Ctrl+Shift+F'],
        mac: ['Cmd+Shift+F'],
        action: 'toggleSearchFiles',
        label: S.shortcuts.search_files,
        category: 'search'
    },
    {
        id: 'findNext',
        mac: ['Cmd+G'],
        other: ['Ctrl+G', 'F3'],
        action: 'findNext',
        label: S.shortcuts.find_next,
        category: 'search'
    },
    {
        id: 'findPrev',
        mac: ['Cmd+Shift+G'],
        other: ['Ctrl+Shift+G', 'Shift+F3'],
        action: 'findPrevious',
        label: S.shortcuts.find_prev,
        category: 'search'
    },

    // ─────────────────────────────────────────────────────────────────────
    // Editor
    // ─────────────────────────────────────────────────────────────────────
    {
        id: 'toggleInlineEdit',
        keys: ['e'],
        action: 'togglePreviewInlineEdit',
        label: S.shortcuts?.toggle_inline_edit || 'Toggle edit mode (preview)',
        category: 'editor',
        when: 'notInInput'
    },

    // ─────────────────────────────────────────────────────────────────────
    // Navigation & Other
    // ─────────────────────────────────────────────────────────────────────
    {
        id: 'prevUserMessage',
        mac: ['Cmd+up'],
        other: ['Ctrl+up'],
        action: 'goToPreviousUserMessage',
        label: S.shortcuts.prev_message,
        category: 'navigation',
        when: 'session'
    },
    {
        id: 'nextUserMessage',
        mac: ['Cmd+down'],
        other: ['Ctrl+down'],
        action: 'goToNextUserMessage',
        label: S.shortcuts.next_message,
        category: 'navigation',
        when: 'session'
    },
    {
        id: 'focusInput',
        mac: ['Cmd+/'],
        other: ['Ctrl+/'],
        action: 'focusInput',
        label: S.shortcuts.toggle_focus,
        category: 'navigation',
        // notInEditor: lets CodeMirror handle Ctrl+/ / Cmd+/ in scratch tabs.
        // Still fires from textareas (markdown inline-edit), panels, and chrome.
        when: 'notInEditor'
    },
    {
        id: 'focusProject',
        mac: ['Cmd+L'],
        other: ['Ctrl+L'],
        action: 'focusProject',
        label: S.shortcuts.focus_project,
        category: 'navigation'
    },
    {
        id: 'connect',
        mac: ['Cmd+Enter'],
        other: ['Ctrl+Enter'],
        action: 'connectIfDisconnected',
        label: S.shortcuts.send,
        category: 'navigation',
        when: 'disconnected'
    },
    {
        id: 'help',
        // No keyboard binding: F1 went to the command palette, and '?' is
        // useless here because the message input is almost always focused, so
        // the key just types a '?'. Reach Help via the palette or /help.
        keys: [],
        action: 'showHelp',
        label: S.shortcuts.help,
        category: 'other',
        when: 'notInInput'
    },
    {
        id: 'settings',
        // Ctrl+, on both platforms — iPad reserves Cmd+, for native app
        // Settings, so the in-app binding never fires there. Mac's free
        // Ctrl slot gives iPad users a fallback that always reaches us.
        keys: ['Ctrl+,'],
        // Cmd+, on Mac too: works on macOS proper, matches platform muscle
        // memory, and harmlessly no-ops on iPad (where the OS swallows it).
        mac: ['Cmd+,'],
        action: 'showSettings',
        label: S.shortcuts.settings,
        category: 'other'
    },
    {
        id: 'escape',
        keys: ['Escape'],
        action: 'handleEscape',
        label: S.shortcuts.close_cancel,
        category: 'other',
        when: 'notInTerminal'
    },
    {
        // Enter=Allow while an interactive permission card is waiting. Gated by
        // the `permissionPending` context so it only claims Enter when a card is
        // up and the message box is empty — otherwise Enter stays Send. Esc=Deny
        // is handled by the `escape` entry above via handleEscape().
        id: 'permissionAllow',
        keys: ['Enter'],
        action: 'allowPendingPermission',
        label: S.shortcuts.permission_allow,
        category: 'other',
        when: 'permissionPending'
    },
    {
        id: 'backToSessions',
        keys: ['Backspace'],
        action: 'handleBackToSessions',
        label: S.shortcuts.back_sessions,
        category: 'navigation',
        when: 'backToSessionsContext'
    }
];

// Generate tab switching shortcuts (1-9)
for (let i = 1; i <= 9; i++) {
    SHORTCUTS.push({
        id: `switchTab${i}`,
        mac: [`Cmd+${i}`],
        other: [`Ctrl+${i}`],
        action: 'switchToTabByIndex',
        args: [i - 1],
        label: S.shortcuts.switch_tab.replace('{n}', i),
        category: 'sessions',
        when: 'always',
        hidden: i > 5  // Only show 1-5 in help
    });
}

// Storage key for user config (shared with config-widget.js, shortcut-hints.js, config.js)
export const CONFIG_STORAGE_KEY = 'claude-code-user-config';

/**
 * Load user shortcut overrides from localStorage
 */
function loadUserShortcutOverrides() {
    try {
        const saved = localStorage.getItem(CONFIG_STORAGE_KEY);
        if (saved) {
            const config = JSON.parse(saved);
            return config.shortcuts || {};
        }
    } catch (e) {
        console.error('Failed to load shortcut overrides:', e);
    }
    return {};
}

/**
 * Fetch server-side shortcut overrides.
 * @returns {Promise<Object|null>} {id: [keys]} map, or null on network failure
 */
export async function fetchServerShortcuts() {
    try {
        const resp = await fetch('/api/bridge/shortcuts');
        if (!resp.ok) return null;
        const data = await resp.json();
        return data.shortcuts || {};
    } catch (e) {
        console.warn('[shortcuts] Failed to fetch server shortcuts:', e);
        return null;
    }
}

/**
 * Push shortcut overrides to server (fire-and-forget).
 * @param {Object} overrides - {id: [keys]} map
 */
export function pushServerShortcuts(overrides) {
    fetch('/api/bridge/shortcuts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shortcuts: overrides || {} }),
    }).catch(() => {});
}

/**
 * Reconcile shortcut overrides with server state.
 * Server wins when it has data; otherwise bootstrap server from localStorage.
 * Called on app load. If unreachable, keep localStorage behavior.
 * @returns {Promise<boolean>} true if localStorage was updated from server
 */
export async function reconcileShortcutsWithServer() {
    const serverOverrides = await fetchServerShortcuts();
    if (serverOverrides === null) return false;

    let config = {};
    try {
        const saved = localStorage.getItem(CONFIG_STORAGE_KEY);
        if (saved) config = JSON.parse(saved);
    } catch (e) { /* ignore, treat as empty */ }

    const localOverrides = config.shortcuts || {};
    const serverHasData = Object.keys(serverOverrides).length > 0;
    const localHasData = Object.keys(localOverrides).length > 0;

    if (serverHasData) {
        if (JSON.stringify(serverOverrides) === JSON.stringify(localOverrides)) {
            return false;
        }
        config.shortcuts = serverOverrides;
        try {
            localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(config));
        } catch (e) { /* ignore */ }
        debug.log('[shortcuts] Synced overrides from server');
        return true;
    }

    if (localHasData) {
        pushServerShortcuts(localOverrides);
        debug.log('[shortcuts] Uploaded local overrides to server');
    }
    return false;
}

/**
 * ShortcutManager - Handles keyboard events and executes shortcuts
 */
export class ShortcutManager {
    constructor(app) {
        this.app = app;
        this.shortcuts = new Map();  // normalized key -> shortcut definition
        this.enabled = true;
        this.userOverrides = {};
        this.init();
    }

    init() {
        this.buildShortcutMap();

        // Single global keyboard handler (capture phase to fire first)
        document.addEventListener('keydown', (e) => this.handle(e), true);
    }

    /**
     * Build the shortcut lookup map, applying user overrides
     */
    buildShortcutMap() {
        this.shortcuts.clear();
        this.userOverrides = loadUserShortcutOverrides();
        literalChordMap = null;  // overrides may have moved a binding

        for (const shortcut of SHORTCUTS) {
            const hasOverride = !!this.userOverrides[shortcut.id];
            const keys = hasOverride
                ? this.userOverrides[shortcut.id]
                : resolveKeys(shortcut);

            for (const key of keys) {
                this.shortcuts.set(this.normalizeKey(key), shortcut);
            }
        }
    }

    /**
     * Reload shortcuts (call when user changes config)
     */
    reloadShortcuts() {
        this.buildShortcutMap();
    }

    /**
     * Get the current keys for a shortcut (with user overrides applied)
     */
    getShortcutKeys(shortcutId) {
        const shortcut = SHORTCUTS.find(s => s.id === shortcutId);
        if (!shortcut) return [];
        return this.userOverrides[shortcutId] || resolveKeys(shortcut);
    }

    /**
     * Normalize a key string (e.g., "Ctrl+K" -> "ctrl+k")
     */
    normalizeKey(keyString) {
        return normalizeChord(keyString);
    }

    /**
     * Convert KeyboardEvent to normalized key string
     */
    eventToKey(e) {
        // iPadOS WKWebView synthetic events (autofill / QuickType / IME)
        // can arrive with e.key (and e.code) undefined — never a shortcut.
        if (!e.key) return null;

        const parts = [];

        // Modifiers (sorted order)
        if (e.altKey) parts.push('alt');
        if (e.ctrlKey) parts.push('ctrl');
        if (e.metaKey) parts.push('cmd');
        if (e.shiftKey) parts.push('shift');

        // Main key
        let key = e.key.toLowerCase();

        // When Alt is held, iPadOS (and macOS Option) emits alternate characters
        // for many keys — e.g. Alt+F produces 'ń', Alt+E produces 'ł', Alt+/ produces '÷'.
        // Derive the key from e.code (physical key) instead, so Alt+letter shortcuts
        // work regardless of the OS's Option-layer character mapping.
        if (e.altKey) {
            const code = e.code || '';
            const m = code.match(/^Key([A-Z])$/) || code.match(/^Digit([0-9])$/);
            if (m) key = m[1].toLowerCase();
            else if (e.code === 'Slash') key = '/';
        }

        // Normalize special keys
        if (key === ' ') key = 'space';
        if (key === 'escape') key = 'escape';
        if (key === 'enter') key = 'enter';
        if (key === 'arrowup') key = 'up';
        if (key === 'arrowdown') key = 'down';
        if (key === 'arrowleft') key = 'left';
        if (key === 'arrowright') key = 'right';

        // Handle backtick (` key has code "Backquote")
        if (e.code === 'Backquote') key = '`';

        // Skip if key is just a modifier
        if (['control', 'alt', 'shift', 'meta'].includes(key)) {
            return null;
        }

        parts.push(key);
        return parts.sort().join('+');
    }

    /**
     * Handle keyboard event
     */
    handle(e) {
        if (!this.enabled) return;

        const key = this.eventToKey(e);
        if (!key) return;

        // Let elements that handle their own keyboard events take priority.
        // `data-shortcuts-disabled="true"` blocks every shortcut (modal-style
        // inputs like the quick switcher). Anything else is treated as a
        // comma/space-separated list of bare keys to block — e.g.
        // `enter,escape,tab` lets the inline-edit textarea claim those keys
        // while leaving Ctrl+/ and other modifier shortcuts working.
        const disabledAttr = document.activeElement?.dataset?.shortcutsDisabled;
        if (disabledAttr === 'true' || disabledAttr === '') return;
        if (disabledAttr) {
            const blocked = disabledAttr.toLowerCase().split(/[,\s]+/).filter(Boolean);
            if (blocked.includes(key)) return;
        }

        const shortcut = this.shortcuts.get(key);
        if (!shortcut) return;

        // Check context restrictions
        if (!this.checkContext(shortcut, e)) return;

        // Execute the action
        e.preventDefault();
        e.stopImmediatePropagation();  // Prevent other handlers at same level
        this.execute(shortcut);
    }

    /**
     * Check if shortcut should fire in current context
     */
    checkContext(shortcut, e) {
        const when = shortcut.when || 'global';
        const activeEl = document.activeElement;
        const inInput = activeEl?.tagName === 'INPUT' ||
                       activeEl?.tagName === 'TEXTAREA' ||
                       activeEl?.isContentEditable;
        // Check for terminal focus: xterm.js uses .xterm class, widget uses .terminal-widget-xterm
        const inTerminal = activeEl?.closest('.xterm') ||
                          activeEl?.closest('.terminal-container') ||
                          activeEl?.closest('.terminal-widget-xterm');
        // CodeMirror focus: contentEditable lives inside .cm-editor
        const inEditor = activeEl?.closest('.cm-editor');

        switch (when) {
            case 'notInInput':
                return !inInput && !inTerminal;
            case 'notInTerminal':
                return !inTerminal;
            case 'notInEditor':
                // Lets CodeMirror's own keymap handle the key (e.g. Ctrl+/
                // for toggle-comment). Terminal is NOT blocked here — that
                // lets focusInput() act as an escape-hatch out of xterm.
                // (Per-widget passthrough lives in terminal/init.js.)
                return !inEditor;
            case 'session':
                return this.app.activeMode === 'session';
            case 'terminal':
                return this.app.activeMode === 'terminal' || inTerminal;
            case 'backToSessionsContext':
                // Backspace for back-to-sessions: only when pill visible AND
                // either not in input, or in input but input is empty
                if (!this.app.chatCtrl?.canGoBackToSessions()) return false;
                if (inTerminal) return false;
                if (inInput) {
                    // Allow if input is empty (so we don't steal backspace from editing)
                    const inputEl = this.app.els?.messageInput;
                    return inputEl && inputEl.value.length === 0;
                }
                return true;
            case 'permissionPending': {
                // Enter=Allow for an interactive permission card. Only fire when
                // a card is actually waiting, never in the terminal, and — when
                // focus is in a text field — only from the (empty) message box.
                // That keeps Enter as Send while the user is typing, and lets
                // the deny-guidance field claim Enter for itself.
                if (inTerminal) return false;
                if (!this.app.pendingPermissionCard?.()) return false;
                if (!inInput) return true;
                const mi = this.app.els?.messageInput;
                return activeEl === mi && mi.value.length === 0;
            }
            case 'always':
                return true;
            case 'disconnected':
                // Only fire when there is a session and it's not connected,
                // so when already-connected the key passes through to other handlers.
                return this.app.activeSession?.status === 'disconnected' && !inTerminal;
            case 'global':
            default:
                // By default, shortcuts don't fire when terminal is focused
                // so keystrokes pass through to xterm.js (bash, vim, etc.)
                return !inTerminal;
        }
    }

    /**
     * Execute a shortcut action
     */
    execute(shortcut) {
        const method = this.app[shortcut.action];
        if (typeof method === 'function') {
            method.call(this.app, ...(shortcut.args || []));
        } else {
            console.warn(`Shortcut action not found: ${shortcut.action}`);
        }
    }

    /**
     * Format key for display (platform-aware). Delegates to formatKeyForDisplay
     * so the help dialog, hints overlay, and settings editor all render keys
     * consistently — Mac sigils (⌘ ⌃ ⌥ ⇧) on Mac, "Ctrl + K" elsewhere.
     */
    formatKey(keyString) {
        return formatKeyForDisplay(keyString);
    }

    /**
     * Format multiple keys for display (shows all keys joined by " / ")
     */
    formatKeys(keys) {
        if (!keys || keys.length === 0) return '';
        return keys.map(k => this.formatKey(k)).join(' / ');
    }

    /**
     * Get shortcuts grouped by category for help display
     */
    getHelpContent() {
        const byCategory = {};

        for (const shortcut of SHORTCUTS) {
            if (shortcut.hidden) continue;

            const cat = shortcut.category;
            if (!byCategory[cat]) byCategory[cat] = [];

            const isOverride = !!this.userOverrides[shortcut.id];
            const keys = isOverride
                ? this.userOverrides[shortcut.id]
                : resolveKeys(shortcut);

            const formatted = this.formatKeys(keys);
            if (!formatted) continue;  // No binding (e.g. Help) — nothing to list

            byCategory[cat].push({
                keys: formatted,
                label: shortcut.label
            });
        }

        return byCategory;
    }

    /**
     * Render help HTML from registry
     */
    renderHelp() {
        const byCategory = this.getHelpContent();
        const esc = (s) => String(s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const section = (title, pairs, hint = '') => `
            <div class="help-section">
                <h4>${esc(title)}</h4>
                ${(pairs || []).map(([code, desc]) =>
                    `<div class="help-item"><code>${esc(code)}</code> <span>${esc(desc)}</span></div>`
                ).join('')}
                ${hint ? `<div class="help-hint">${esc(hint)}</div>` : ''}
            </div>
        `;

        let html = '';

        // Static sections from strings.yaml (help:)
        html += section(S.help.slash_title, S.help.slash_commands);
        html += section(S.help.shell_title, S.help.shell_commands);
        html += section(S.help.triggers_title, S.help.triggers, S.help.triggers_hint);

        // Keyboard shortcuts by category
        for (const [category, categoryLabel] of Object.entries(CATEGORIES)) {
            const shortcuts = byCategory[category];
            if (!shortcuts || shortcuts.length === 0) continue;

            html += `<div class="help-section"><h4>${categoryLabel}</h4>`;
            for (const s of shortcuts) {
                html += `<div class="help-item"><code>${s.keys}</code> <span>${s.label}</span></div>`;
            }
            html += '</div>';
        }

        // About — server package version + the frontend build this page loaded
        html += this.renderAbout(section);

        return html;
    }

    /**
     * About section: version identity.
     *
     * The frontend build is the `?v=` cache-bust stamp (newest static-asset
     * mtime) the page was served with, rendered as a local timestamp. When it
     * differs from the server's current stamp the page is running stale
     * assets, so we say so — that mismatch is the usual explanation for "I
     * changed the JS but nothing happened".
     */
    renderAbout(_section) {
        const info = getVersionInfo();
        const rows = [];

        // Rendered verbatim — the server owns the format (and the leading
        // "v"), since only it knows whether the value came from git or from
        // the build-time constant.
        if (info.server) rows.push([info.server, S.help.about_server]);

        const build = this.formatBuild(info.clientBuild);
        if (build) rows.push([build, S.help.about_frontend]);

        if (!rows.length) return '';

        // Two independent staleness axes, and they need different remedies:
        // newer assets on the server = reload the page; newer code in the
        // checkout than the server booted with = restart the server.
        const hints = [];
        if (info.restartNeeded) {
            hints.push(S.help.about_restart.replace('{disk}', info.diskVersion || ''));
        }
        if (info.stale) {
            hints.push(S.help.about_stale.replace('{build}', this.formatBuild(info.serverBuild) || ''));
        }

        // Built inline rather than via renderHelp's `section()` helper so the
        // About link can sit INSIDE the section, directly under the version
        // rows it elaborates on.
        //
        // A <button>, not an <a href> — the handler in DialogController has to
        // close this modal first, otherwise the widget opens underneath it
        // (help sits at --z-modal 3000, widgets top out at --z-widget 1700).
        const esc = (s) => this.escapeHelp(s);
        const hint = hints.join(' ');
        return `
            <div class="help-section">
                <h4>${esc(S.help.about_title)}</h4>
                ${rows.map(([code, desc]) =>
                    `<div class="help-item"><code>${esc(code)}</code> <span>${esc(desc)}</span></div>`
                ).join('')}
                ${hint ? `<div class="help-hint">${esc(hint)}</div>` : ''}
                <button type="button" class="help-about-link" data-action="open-about">
                    ${esc(S.help.about_more)}
                </button>
            </div>
        `;
    }

    /** Local escape helper — renderHelp's `esc` is scoped to that method. */
    escapeHelp(s) {
        return String(s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    /** Epoch-seconds build stamp → readable local timestamp. */
    formatBuild(stamp) {
        const secs = Number(stamp);
        if (!secs || !Number.isFinite(secs)) return stamp ? String(stamp) : '';
        const d = new Date(secs * 1000);
        if (Number.isNaN(d.getTime())) return String(stamp);
        const p = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    }
}
