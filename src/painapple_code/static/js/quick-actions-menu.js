/**
 * Quick Actions Radial Menu
 *
 * A floating action button that expands into a radial menu for quick access
 * to common actions. Replaces the debug FAB with a more powerful interface.
 *
 * Features:
 * - Radial menu layout with configurable actions
 * - Tap-to-open, tap-to-select interaction
 * - Press-drag-release for power users (optional)
 * - Draggable FAB position
 * - Smooth animations with staggered reveals
 * - Context-aware action swapping
 * - Configurable via Settings
 * - Context menu with search and preset switching (right-click / long-press)
 */

import { Storage } from './utils.js';
import { QuickActionsRegistry, DEFAULT_QUICK_ACTIONS_CONFIG, QUICK_ACTION_PRESETS, updatePresets, syncCustomActions } from './quick-actions-registry.js';
// Note: showConfigPanel is imported dynamically to avoid circular dependency with config-widget.js
import { TooltipManager } from './tooltips.js';
import { WidgetBus } from './widget-system/index.js';
import S from './strings.js';
import { debug } from './config.js';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const STORAGE_KEY = 'claude-quick-actions';
/**
 * Compute default FAB position. On wide screens, sits just outside the 900px content area.
 */
function getDefaultPosition() {
    const vw = window.innerWidth;
    let right = 16;
    if (vw > 1100) {
        const style = getComputedStyle(document.documentElement);
        const padding = parseFloat(style.getPropertyValue('--layout-content-padding')) || 14;
        const rail = parseFloat(style.getPropertyValue('--left-rail-width')) || 48;
        // Place FAB past content + gutter arrows (rail + padding + 900 + 56px clearance)
        right = vw - rail - padding - 900 - 56 - 52; // 52 = FAB width
    }
    return { right, bottom: 100 };
}
const DRAG_THRESHOLD = 8;
const MENU_RADIUS = 80; // Distance from center to items
const ITEM_SIZE = 48; // Item diameter (44px + buffer)
const EDGE_PADDING = 12; // Minimum distance from viewport edge
const LONG_PRESS_DELAY = 300; // ms for drag-release mode
const CONTEXT_MENU_LONG_PRESS = 500; // ms for context menu on mobile

// Keyboard shortcuts: 1-4 for top arc (L→R), Q-W-E-R for bottom arc (L→R)
// Bottom arc positions go clockwise (R→L visually), so keys are assigned in reverse
// to make them read left-to-right: position n-1 gets Q, position n-2 gets W, etc.
const ALL_KEYS = ['1', '2', '3', '4', 'q', 'w', 'e', 'r'];
const ALL_LABELS = ['1', '2', '3', '4', 'Q', 'W', 'E', 'R'];

/**
 * Get the key label for a slot position (handles bottom-arc reversal)
 */
function getSlotKeyLabel(position, totalSlots) {
    if (position < 4) {
        return ALL_LABELS[position];
    }
    // Bottom arc: reverse so it reads L→R visually
    const keyIndex = 4 + (totalSlots - 1 - position);
    return keyIndex < ALL_LABELS.length ? ALL_LABELS[keyIndex] : '';
}

/**
 * Get the slot position for a key press (handles bottom-arc reversal)
 */
function getSlotForKey(key, totalSlots) {
    const k = key.toLowerCase();
    const keyIndex = ALL_KEYS.indexOf(k);
    if (keyIndex === -1) return -1;

    if (keyIndex < 4) {
        return keyIndex < totalSlots ? keyIndex : -1;
    }
    // Q→position n-1, W→position n-2, E→position n-3, R→position n-4
    const position = totalSlots - 1 - (keyIndex - 4);
    return position >= 4 ? position : -1;
}

// Feather icons SVG paths (subset we need)
const ICONS = {
    'plus-circle': '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/>',
    'x': '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
    'chevron-left': '<polyline points="15 18 9 12 15 6"/>',
    'chevron-right': '<polyline points="9 18 15 12 9 6"/>',
    'git-branch': '<line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
    'copy': '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    'edit-3': '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>',
    'terminal': '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>',
    'plus-square': '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/>',
    'folder': '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
    'scroll': '<path d="M8 21h12a2 2 0 0 0 2-2v-2H10v2a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v3h4"/><path d="M19 3H9a2 2 0 0 0-2 2v11a2 2 0 0 1 2-2h8"/>',
    'file-diff': '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/>',
    'git-merge': '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/>',
    'dollar-sign': '<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
    'dollarSign': '<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
    'coins': '<circle cx="8" cy="8" r="6"/><path d="M18.09 10.37A6 6 0 1 1 10.34 18"/><path d="M7 6h1v4"/><path d="m16.71 13.88.7.71-2.82 2.82"/>',
    'activity': '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
    'database': '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>',
    'message-circle': '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>',
    'bug': '<path d="M8 2l1.88 1.88"/><path d="M14.12 3.88 16 2"/><path d="M9 7.13v-1a3.003 3.003 0 1 1 6 0v1"/><path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6"/><path d="M12 20v-9"/><path d="M6.53 9C4.6 8.8 3 7.1 3 5"/><path d="M6 13H2"/><path d="M3 21c0-2.1 1.7-3.9 3.8-4"/><path d="M20.97 5c0 2.1-1.6 3.8-3.5 4"/><path d="M22 13h-4"/><path d="M17.2 17c2.1.1 3.8 1.9 3.8 4"/>',
    'settings': '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    'help-circle': '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
    'square': '<rect x="3" y="3" width="18" height="18" rx="2"/>',
    'trash-2': '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>',
    'minimize-2': '<polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/>',
    'chevrons-down': '<polyline points="7 13 12 18 17 13"/><polyline points="7 6 12 11 17 6"/>',
    'chevrons-up': '<polyline points="17 11 12 6 7 11"/><polyline points="17 18 12 13 7 18"/>',
    'maximize-2': '<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>',
    'edit': '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>',
    'clipboard': '<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/>',
    'code': '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
    'bookmark-plus': '<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/><line x1="12" y1="7" x2="12" y2="13"/><line x1="9" y1="10" x2="15" y2="10"/>',
    'bookmark': '<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>',
    'bookmark-minus': '<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/><line x1="9" y1="10" x2="15" y2="10"/>',
    'search': '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
    'file-plus': '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/>',
    'image': '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
    'paperclip': '<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
    'camera': '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>',
    'folder-open': '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><path d="M2 10h20"/>',
    'home': '<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>',
    'arrow-left': '<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>',
    'clock': '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    'star': '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
    'refresh-cw': '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
    'wifi': '<path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/>',
    'moon': '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
    'maximize': '<path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/>',
    'share-2': '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>',
    'slash': '<circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>',
    'play': '<polygon points="5 3 19 12 5 21 5 3"/>',
    'package': '<line x1="16.5" y1="9.4" x2="7.5" y2="4.21"/><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>',
    'check-circle': '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',
    'git-commit': '<circle cx="12" cy="12" r="4"/><line x1="1.05" y1="12" x2="7" y2="12"/><line x1="17.01" y1="12" x2="22.96" y2="12"/>',
    'git-pull-request': '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><line x1="6" y1="9" x2="6" y2="21"/>',
    'check-square': '<polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
    'zap': '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
    'check': '<polyline points="20 6 9 17 4 12"/>',
    'crosshair': '<circle cx="12" cy="12" r="10"/><line x1="22" y1="12" x2="18" y2="12"/><line x1="6" y1="12" x2="2" y2="12"/><line x1="12" y1="6" x2="12" y2="2"/><line x1="12" y1="22" x2="12" y2="18"/>',
    'command': '<path d="M18 3a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3 3 3 0 0 0 3-3 3 3 0 0 0-3-3H6a3 3 0 0 0-3 3 3 3 0 0 0 3 3 3 3 0 0 0 3-3V6a3 3 0 0 0-3-3 3 3 0 0 0-3 3 3 3 0 0 0 3 3h12a3 3 0 0 0 3-3 3 3 0 0 0-3-3z"/>',
};

// ─────────────────────────────────────────────────────────────────────────────
// Quick Actions Menu Class
// ─────────────────────────────────────────────────────────────────────────────

class QuickActionsMenu {
    constructor() {
        this.fab = null;
        this.menu = null;
        this.overlay = null;
        this.contextMenu = null;
        this.isOpen = false;
        this.isContextMenuOpen = false;
        this.visibility = 'always'; // 'always' | 'mobile' | 'disabled'
        this.position = getDefaultPosition();
        this.config = { ...DEFAULT_QUICK_ACTIONS_CONFIG };
        // User-defined custom actions (terminal/prompt/slash) — synced into
        // the registry via syncCustomActions() whenever they change
        this.customActions = [];

        // Drag state
        this.startX = 0;
        this.startY = 0;
        this.startRight = 0;
        this.startBottom = 0;
        this.isDragging = false;
        this.didDrag = false;

        // Long press for drag-release mode
        this.longPressTimer = null;
        this.isLongPress = false;
        this.highlightedIndex = -1;

        // Context menu state
        this.contextMenuTimer = null;
        this.searchResults = [];
        this.selectedResultIndex = 0;

        // Store focused element to restore after action (keeps keyboard open)
        this.previousFocus = null;

        // Track if menu was opened at cursor position (vs FAB position)
        this.openedAtCursor = false;

        // Edge-aware positioning: track if we shifted the menu to fit all items
        this.menuOffset = { x: 0, y: 0 };

        this.loadState();
    }

    /**
     * Load state from localStorage (position is device-local, config syncs from server)
     */
    loadState() {
        // Load position from localStorage (device-specific)
        const saved = Storage.get(STORAGE_KEY);
        if (saved) {
            if (saved.position) this.position = saved.position;
        }

        // Config (slots, preset, visibility) will be loaded from server in loadServerConfig()
        // Use localStorage as fallback until server responds
        if (saved?.config) {
            this.config = { ...DEFAULT_QUICK_ACTIONS_CONFIG, ...saved.config };
        }
        if (saved?.visibility !== undefined) {
            this.visibility = saved.visibility;
        } else if (saved?.enabled !== undefined) {
            // Migrate legacy boolean → tri-state
            this.visibility = saved.enabled ? 'always' : 'disabled';
        }
        if (Array.isArray(saved?.customActions)) {
            this.customActions = saved.customActions;
            syncCustomActions(this.customActions);
        }
    }

    /**
     * Resolve current visibility setting against device into a boolean
     */
    isVisibleHere() {
        if (this.visibility === 'disabled') return false;
        if (this.visibility === 'mobile') {
            // Mobile = touch-primary devices (phones, tablets including iPad)
            return window.matchMedia('(pointer: coarse)').matches;
        }
        return true; // 'always'
    }

    /**
     * Load config from server (cross-device sync)
     */
    async loadServerConfig() {
        try {
            // Load presets from ~/.painapple-code/presets/*.json
            const presetsRes = await fetch('/api/bridge/presets');
            if (presetsRes.ok) {
                const presets = await presetsRes.json();
                if (Object.keys(presets).length > 0) {
                    updatePresets(presets);
                    this.rebuildPresetsSection();
                }
            }
            // Load user's active config (slots, options)
            const response = await fetch('/api/bridge/config');
            if (response.ok) {
                const globalConfig = await response.json();
                if (globalConfig.quickActions) {
                    const qa = globalConfig.quickActions;
                    if (qa.visibility !== undefined) {
                        this.visibility = qa.visibility;
                    } else if (qa.enabled !== undefined) {
                        // Migrate legacy boolean → tri-state
                        this.visibility = qa.enabled ? 'always' : 'disabled';
                    }
                    if (qa.config) this.config = { ...DEFAULT_QUICK_ACTIONS_CONFIG, ...qa.config };
                    if (Array.isArray(qa.customActions)) {
                        this.customActions = qa.customActions;
                        syncCustomActions(this.customActions);
                    }
                    this.updateVisibility();
                    if (this.isOpen) this.renderMenuItems();
                    debug.log('[QuickActions] Loaded config from server');
                }
            }
        } catch (e) {
            console.warn('[QuickActions] Failed to load server config:', e);
        }
    }

    /**
     * Save state - position to localStorage, config to server
     */
    saveState() {
        // Save position to localStorage (device-specific)
        Storage.set(STORAGE_KEY, {
            position: this.position,
            // Keep config in localStorage as fallback
            visibility: this.visibility,
            config: this.config,
            customActions: this.customActions
        });

        // Save config to server (cross-device sync)
        this.saveServerConfig();
    }

    /**
     * Save config to server (debounced)
     */
    saveServerConfig() {
        // Debounce server saves
        if (this._saveTimeout) clearTimeout(this._saveTimeout);
        this._saveTimeout = setTimeout(() => this._doSaveServerConfig(), 500);
    }

    async _doSaveServerConfig() {
        try {
            // Load current global config first
            const response = await fetch('/api/bridge/config');
            const globalConfig = response.ok ? await response.json() : {};

            // Update quickActions section
            globalConfig.quickActions = {
                visibility: this.visibility,
                config: this.config,
                customActions: this.customActions
            };

            // Save back
            await fetch('/api/bridge/config', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(globalConfig)
            });
            debug.log('[QuickActions] Saved config to server');
        } catch (e) {
            console.warn('[QuickActions] Failed to save server config:', e);
        }
    }

    /**
     * Initialize the menu - call once after DOM is ready
     */
    init() {
        if (this.fab) return;

        this.createElements();
        this.attachEventListeners();
        this.updateVisibility();
        this.applyPosition();

        // Re-evaluate visibility when device pointer type changes (mobile mode)
        const coarseMq = window.matchMedia('(pointer: coarse)');
        if (coarseMq.addEventListener) {
            coarseMq.addEventListener('change', () => this.updateVisibility());
        }

        // Load config from server (async, will update UI when ready)
        this.loadServerConfig();

        // Listen for debug error events to show badge on FAB
        WidgetBus.on('debug:errors-changed', ({ unseen }) => {
            this.updateFabBadge(unseen);
        });

        debug.log('[QuickActions] Initialized');
    }

    createElements() {
        // Create FAB
        this.fab = document.createElement('button');
        this.fab.className = 'quick-actions-fab';
        this.fab.setAttribute('aria-label', 'Quick actions menu');
        this.fab.setAttribute('aria-expanded', 'false');
        this.fab.setAttribute('aria-haspopup', 'true');
        this.fab.setAttribute('data-tooltip', 'Quick Actions - Drag to move, right-click for options');
        this.fab.innerHTML = `
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                ${ICONS['zap']}
            </svg>
        `;

        // Error badge on FAB
        this.fabBadge = document.createElement('span');
        this.fabBadge.className = 'quick-actions-fab-badge';
        this.fab.appendChild(this.fabBadge);

        // Create overlay for clicking outside
        this.overlay = document.createElement('div');
        this.overlay.className = 'quick-actions-overlay';

        // Create radial menu container
        this.menu = document.createElement('div');
        this.menu.className = 'quick-actions-menu';
        this.menu.setAttribute('role', 'menu');

        // Create context menu
        this.contextMenu = document.createElement('div');
        this.contextMenu.className = 'quick-actions-context-menu';
        this.contextMenu.innerHTML = this.renderContextMenuHTML();

        // Add to DOM
        document.body.appendChild(this.overlay);
        document.body.appendChild(this.menu);
        document.body.appendChild(this.contextMenu);
        document.body.appendChild(this.fab);
    }

    renderContextMenuHTML() {
        return `
            <div class="qa-context-search">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    ${ICONS['search']}
                </svg>
                <input type="text" placeholder="Find action..." autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
            </div>
            <div class="qa-context-results"></div>
            <div class="qa-context-presets">
                <div class="qa-context-section-title">Presets</div>
                ${Object.entries(QUICK_ACTION_PRESETS).map(([id, preset]) => `
                    <button class="qa-context-preset" data-preset="${id}">
                        <span class="qa-preset-radio"></span>
                        <span class="qa-preset-name">${preset.name}</span>
                        <span class="qa-preset-desc">${preset.slots.length} actions</span>
                    </button>
                `).join('')}
            </div>
            <div class="qa-context-footer">
                <button class="qa-context-footer-item qa-debug-logs-item" data-action="debug-logs" style="display:none">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        ${ICONS['bug']}
                    </svg>
                    ${S.quick_actions?.open_debug_logs || 'Open Debug Logs'}
                </button>
                <button class="qa-context-footer-item" data-action="customize">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        ${ICONS['settings']}
                    </svg>
                    Customize...
                </button>
            </div>
        `;
    }

    attachEventListeners() {
        // FAB click (left click)
        this.fab.addEventListener('click', (e) => {
            if (this.didDrag) {
                e.preventDefault();
                e.stopPropagation();
                return;
            }
            // If context menu is open, close it
            if (this.isContextMenuOpen) {
                e.preventDefault();
                e.stopPropagation();
                this.closeContextMenu();
                return;
            }
            this.toggle();
        });

        // FAB right-click (context menu)
        this.fab.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.openContextMenu();
        });

        // Overlay click to close
        this.overlay.addEventListener('click', () => {
            this.close();
            this.closeContextMenu();
        });

        // Mouse drag
        this.fab.addEventListener('mousedown', (e) => {
            if (e.button === 0) { // Left click only
                this.onPointerDown(e.clientX, e.clientY, e);
            }
        });
        document.addEventListener('mousemove', (e) => this.onPointerMove(e.clientX, e.clientY));
        document.addEventListener('mouseup', () => this.onPointerUp());

        // Touch drag + long press for context menu
        this.fab.addEventListener('touchstart', (e) => {
            // Store currently focused element to restore after action (keeps keyboard open)
            this.previousFocus = document.activeElement;

            // Stop propagation to prevent swipe gesture detection from starting
            e.stopPropagation();

            const touch = e.touches[0];
            this.onPointerDown(touch.clientX, touch.clientY, e);

            // Start context menu timer (longer than drag-release)
            // Works whether radial is open or closed — openContextMenu()
            // handles closing the radial first if needed
            this.contextMenuTimer = setTimeout(() => {
                if (!this.didDrag) {
                    this.openContextMenu();
                    // Prevent the radial menu from opening
                    if (this.longPressTimer) {
                        clearTimeout(this.longPressTimer);
                        this.longPressTimer = null;
                    }
                }
            }, CONTEXT_MENU_LONG_PRESS);
        }, { passive: true });

        document.addEventListener('touchmove', (e) => {
            if (!this.isDragging && !this.isLongPress) return;

            // Prevent swipe gestures (tab switching) while dragging FAB
            if (this.didDrag) {
                e.preventDefault();
                e.stopPropagation();
            }

            const touch = e.touches[0];
            this.onPointerMove(touch.clientX, touch.clientY);

            // Cancel context menu if dragging
            if (this.didDrag && this.contextMenuTimer) {
                clearTimeout(this.contextMenuTimer);
                this.contextMenuTimer = null;
            }
        }, { passive: false, capture: true });

        document.addEventListener('touchend', () => {
            this.onPointerUp();
            if (this.contextMenuTimer) {
                clearTimeout(this.contextMenuTimer);
                this.contextMenuTimer = null;
            }
        });

        // Keyboard
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                if (this.isContextMenuOpen) {
                    this.closeContextMenu();
                    e.preventDefault();
                } else if (this.isOpen) {
                    this.close();
                    e.preventDefault();
                }
            }
            // Ctrl+. to toggle menu (legacy, Ctrl+Q is configurable via shortcuts)
            if ((e.ctrlKey || e.metaKey) && e.key === '.') {
                e.preventDefault();
                this.toggle();
            }
            // Slot keys (1-4 + Q-W-E-R) to execute slot action when menu is open
            if (this.isOpen && !this.isContextMenuOpen) {
                const slots = this.config.slots;
                const slotIndex = getSlotForKey(e.key, slots.length);
                if (slotIndex !== -1 && slotIndex < slots.length) {
                    e.preventDefault();
                    e.stopPropagation();

                    // Highlight the item briefly
                    const item = this.menu?.querySelector(`[data-slot-index="${slotIndex}"]`);
                    if (item) {
                        item.classList.add('key-pressed');
                    }

                    // Check if action is disabled
                    const actionId = slots[slotIndex];
                    const action = QuickActionsRegistry.get(actionId);
                    if (action?.disabled?.()) {
                        // Shake animation via CSS, then remove class
                        setTimeout(() => item?.classList.remove('key-pressed'), 300);
                        return;
                    }

                    // Delay execution so user sees the highlight before menu closes
                    setTimeout(() => {
                        this.executeAction(actionId);
                    }, 120);
                }
            }
        });

        // Right-click on background to show radial menu at cursor position
        document.addEventListener('contextmenu', (e) => {
            // Skip if context menu is open (radial menu can be reopened at new position)
            if (this.isContextMenuOpen) return;

            // If radial menu is already open, right-click opens context menu instead
            if (this.isOpen) {
                e.preventDefault();
                this.openContextMenu();
                return;
            }

            // Skip if clicking on interactive elements that have their own context menus
            const target = e.target;
            const interactiveSelectors = [
                'input', 'textarea', 'select', 'button', 'a',
                '[contenteditable]', '[data-context-menu]',
                '.code-block', '.tool-block',
                '.quick-actions-fab', '.widget', '.widget-tab-content', '.modal',
                '.fe-container', '.terminal', '.editor',
                '.tab', '.file-path-link', '.turn-file-pill',
                '.turn-summary-bar'
            ];

            // Check if target or any parent matches interactive selectors
            const isInteractive = interactiveSelectors.some(sel =>
                target.matches(sel) || target.closest(sel)
            );

            // Also skip if there's a text selection (user might want to copy)
            const hasSelection = window.getSelection()?.toString().trim().length > 0;

            if (isInteractive || hasSelection) return;

            // Check if cursor is actually over selectable text
            // caretRangeFromPoint returns nearest caret position even for empty space,
            // so we must verify the click is within the text's visual bounds
            const range = document.caretRangeFromPoint(e.clientX, e.clientY);
            if (range && range.startContainer.nodeType === Node.TEXT_NODE) {
                // Get the bounding rect of the character at this position
                const textNode = range.startContainer;
                const offset = range.startOffset;

                // Create a range for the character at the caret position
                const charRange = document.createRange();
                charRange.setStart(textNode, offset);
                charRange.setEnd(textNode, Math.min(offset + 1, textNode.length));
                const charRect = charRange.getBoundingClientRect();

                // Check if click is actually within the text line's vertical bounds
                // (horizontal can be looser since text reflows)
                const isOverText = (
                    charRect.height > 0 &&
                    e.clientY >= charRect.top &&
                    e.clientY <= charRect.bottom &&
                    e.clientX >= charRect.left - 20 && // Some horizontal tolerance
                    e.clientX <= charRect.right + 20
                );

                if (isOverText) {
                    // Actually over text - check if it's selectable
                    const textParent = textNode.parentElement;
                    if (textParent) {
                        const userSelect = window.getComputedStyle(textParent).userSelect;
                        if (userSelect !== 'none') {
                            return; // Don't show quick actions over selectable text
                        }
                    }
                }
            }

            // Open radial menu at cursor position
            e.preventDefault();
            this.openAtPosition(e.clientX, e.clientY);
        });

        // Radial menu item clicks (or click inside menu area to close)
        this.menu.addEventListener('click', (e) => {
            const item = e.target.closest('.quick-action-item');
            if (item) {
                const actionId = item.dataset.actionId;
                this.executeAction(actionId);
            } else {
                // Clicked inside menu area but not on an item - close the menu
                this.close();
            }
        });

        // Context menu interactions
        this.attachContextMenuListeners();
    }

    attachContextMenuListeners() {
        const searchInput = this.contextMenu.querySelector('.qa-context-search input');
        const resultsContainer = this.contextMenu.querySelector('.qa-context-results');

        // Search input
        searchInput.addEventListener('input', (e) => {
            this.handleSearch(e.target.value);
        });

        // Search keyboard navigation
        searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                this.navigateResults(1);
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                this.navigateResults(-1);
            } else if (e.key === 'Enter') {
                e.preventDefault();
                this.executeSelectedResult();
            }
        });

        // Results click - handle add button, slot picker, and result execution
        resultsContainer.addEventListener('click', (e) => {
            // Handle slot picker item click (replace or add)
            const slotItem = e.target.closest('.qa-slot-picker-item');
            if (slotItem) {
                e.stopPropagation();
                const slotIndex = parseInt(slotItem.dataset.slotIndex, 10);
                const newActionId = slotItem.dataset.newAction;
                this.handleSlotReplace(slotIndex, newActionId);
                return;
            }

            // Handle add button click
            const addBtn = e.target.closest('.qa-result-add-btn');
            if (addBtn) {
                e.stopPropagation();
                const actionId = addBtn.dataset.actionId;
                this.handleAddToMenu(actionId);
                return;
            }

            // Handle result click (execute action)
            const result = e.target.closest('.qa-context-result');
            if (result) {
                const actionId = result.dataset.actionId;
                this.executeAction(actionId);
                this.closeContextMenu();
            }
        });

        // Preset clicks
        this.contextMenu.querySelectorAll('.qa-context-preset').forEach(btn => {
            btn.addEventListener('click', () => {
                const presetId = btn.dataset.preset;
                this.applyPreset(presetId);
                this.updateContextMenuPresets();
                // Brief visual feedback, then close context menu and open radial
                // so the user can immediately use an action from the new preset
                setTimeout(() => {
                    this.closeContextMenu();
                    this.open();
                }, 150);
            });
        });

        // Footer actions
        this.contextMenu.querySelectorAll('.qa-context-footer-item').forEach(btn => {
            btn.addEventListener('click', () => {
                const action = btn.dataset.action;
                if (action === 'debug-logs') {
                    window.WidgetManager.open('debug-logs');
                } else if (action === 'customize') {
                    // Use WidgetManager directly instead of dynamic import
                    // (dynamic import gets a separate module instance due to cache-busting)
                    window.WidgetManager.open('config', { tab: 'quickactions' });
                }
                this.closeContextMenu();
            });
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Context Menu Methods
    // ─────────────────────────────────────────────────────────────────────────

    openContextMenu(anchor) {
        if (this.isContextMenuOpen) return;

        // If radial is open, capture its visual center as anchor before closing
        // (edge-aware offset may have shifted items away from the FAB)
        if (this.isOpen && !anchor) {
            const menuRect = this.menu.getBoundingClientRect();
            anchor = {
                x: menuRect.left + menuRect.width / 2,
                y: menuRect.top + menuRect.height / 2
            };
        }

        // Close radial menu if open
        if (this.isOpen) this.close();

        this.isContextMenuOpen = true;
        this.fab.removeAttribute('data-tooltip'); // Hide tooltip while context menu is open
        TooltipManager.hideTooltip(); // Clear any pending/active tooltip
        this.overlay.classList.add('visible');

        // Position context menu near anchor point (or FAB if no anchor)
        this.positionContextMenu(anchor);

        this.contextMenu.classList.add('open');
        this.updateContextMenuPresets();

        // Sync debug logs item visibility with current error state
        const debugItem = this.contextMenu.querySelector('.qa-debug-logs-item');
        if (debugItem) {
            debugItem.style.display = this.fab.classList.contains('has-errors') ? '' : 'none';
        }

        // Clear and focus search
        const searchInput = this.contextMenu.querySelector('.qa-context-search input');
        searchInput.value = '';
        this.handleSearch('');

        // Focus search input after animation
        setTimeout(() => searchInput.focus(), 50);
    }

    closeContextMenu() {
        if (!this.isContextMenuOpen) return;

        this.isContextMenuOpen = false;
        this.contextMenu.classList.remove('open');
        this.fab.setAttribute('data-tooltip', 'Quick Actions - Drag to move, right-click for options'); // Restore tooltip
        this.overlay.classList.remove('visible');
        this.searchResults = [];
        this.selectedResultIndex = 0;
    }

    positionContextMenu(anchor) {
        const fabRect = this.fab.getBoundingClientRect();
        const menuWidth = 280;
        const padding = 12;

        // Use anchor point if provided (e.g., from radial menu center),
        // otherwise use FAB position
        const anchorY = anchor ? anchor.y : (fabRect.top + fabRect.height / 2);
        const anchorX = anchor ? anchor.x : (fabRect.left + fabRect.width / 2);
        // Virtual rect around anchor point for space calculations
        const anchorTop = anchor ? anchor.y - 26 : fabRect.top;
        const anchorBottom = anchor ? anchor.y + 26 : fabRect.bottom;

        // Use visualViewport for accurate dimensions with keyboard open (iOS Safari)
        const viewportHeight = window.visualViewport?.height || window.innerHeight;

        // Calculate available space above and below anchor
        const spaceAbove = anchorTop;
        const spaceBelow = viewportHeight - anchorBottom;

        const isAbove = spaceAbove > spaceBelow;

        // Toggle class for layout direction
        this.contextMenu.classList.toggle('menu-above', isAbove);
        this.isMenuAbove = isAbove; // Store for handleSearch to use

        if (isAbove) {
            // Anchor menu BOTTOM to just above anchor - menu grows UPWARD
            // With column-reverse, search input (at flex-end) stays near anchor
            const bottomPos = viewportHeight - anchorTop + padding;
            this.contextMenu.style.top = 'auto';
            this.contextMenu.style.bottom = `${bottomPos}px`;
            // Constrain height to available space above anchor
            this.contextMenu.style.maxHeight = `${anchorTop - padding * 2}px`;
        } else {
            // Anchor menu TOP to just below anchor - menu grows DOWNWARD
            this.contextMenu.style.bottom = 'auto';
            this.contextMenu.style.top = `${anchorBottom + padding}px`;
            // Constrain height to available space below anchor
            this.contextMenu.style.maxHeight = `${viewportHeight - anchorBottom - padding * 2}px`;
        }

        // Horizontal positioning - center on anchor, clamped to screen bounds
        const viewportWidth = window.visualViewport?.width || window.innerWidth;
        const idealLeft = anchorX - menuWidth / 2;
        // Clamp: at least `padding` from left, and right edge at least `padding` from viewport right
        const maxLeft = viewportWidth - menuWidth - padding;
        const left = Math.max(padding, Math.min(maxLeft, idealLeft));
        this.contextMenu.style.left = `${left}px`;
    }

    updateContextMenuPresets() {
        const currentPreset = this.config.preset || 'balanced';
        this.contextMenu.querySelectorAll('.qa-context-preset').forEach(btn => {
            const isActive = btn.dataset.preset === currentPreset;
            btn.classList.toggle('active', isActive);
        });
    }

    /** Rebuild presets section from current QUICK_ACTION_PRESETS (called after server load). */
    rebuildPresetsSection() {
        const section = this.contextMenu.querySelector('.qa-context-presets');
        if (!section) return;
        const currentPreset = this.config.preset || 'balanced';
        section.innerHTML = `
            <div class="qa-context-section-title">Presets</div>
            ${Object.entries(QUICK_ACTION_PRESETS).map(([id, preset]) => `
                <button class="qa-context-preset${id === currentPreset ? ' active' : ''}" data-preset="${id}">
                    <span class="qa-preset-radio"></span>
                    <span class="qa-preset-name">${preset.name}</span>
                    <span class="qa-preset-desc">${preset.slots.length} actions</span>
                </button>
            `).join('')}
        `;
        // Rebind click handlers
        section.querySelectorAll('.qa-context-preset').forEach(btn => {
            btn.addEventListener('click', () => {
                const presetId = btn.dataset.preset;
                this.applyPreset(presetId);
                this.updateContextMenuPresets();
                setTimeout(() => {
                    this.closeContextMenu();
                    this.open();
                }, 150);
            });
        });
    }

    handleSearch(query) {
        const resultsContainer = this.contextMenu.querySelector('.qa-context-results');
        const presetsSection = this.contextMenu.querySelector('.qa-context-presets');
        const footerSection = this.contextMenu.querySelector('.qa-context-footer');

        if (!query.trim()) {
            resultsContainer.innerHTML = '';
            resultsContainer.classList.remove('has-results');
            presetsSection.style.display = '';
            footerSection.style.display = '';
            this.searchResults = [];
            this.expandedResultId = null;
            return;
        }

        // Search all actions
        const results = this.searchActions(query.toLowerCase());
        this.searchResults = results;
        this.selectedResultIndex = 0;

        if (results.length > 0) {
            // Hide presets and footer to maximize space for results
            presetsSection.style.display = 'none';
            footerSection.style.display = 'none';
            resultsContainer.classList.add('has-results');
            resultsContainer.innerHTML = results.slice(0, 6).map((result, i) => {
                const isInSlots = this.config.slots.includes(result.action.id);
                const isExpanded = this.expandedResultId === result.action.id;

                return `
                <div class="qa-context-result-wrapper${isExpanded ? ' expanded' : ''}">
                    <div class="qa-context-result-row">
                        <button class="qa-context-result${i === 0 ? ' selected' : ''}" data-action-id="${result.action.id}">
                            <div class="qa-result-icon">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                    ${ICONS[result.action.icon] || ICONS['help-circle']}
                                </svg>
                            </div>
                            <div class="qa-result-text">
                                <div class="qa-result-label">${this.highlightMatch(result.action.label, query)}</div>
                                <div class="qa-result-desc">${result.action.description}</div>
                            </div>
                            ${result.action.shortcut ? `<div class="qa-result-shortcut">${result.action.shortcut}</div>` : ''}
                        </button>
                        <button class="qa-result-add-btn${isInSlots ? ' in-menu' : ''}"
                                data-action-id="${result.action.id}"
                                data-tooltip="${isInSlots ? 'Already in menu' : 'Add to quick actions'}">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                ${isInSlots ? ICONS['check'] : ICONS['plus-circle']}
                            </svg>
                        </button>
                    </div>
                    ${isExpanded ? this.renderSlotPicker(result.action.id) : ''}
                </div>
            `}).join('');
        } else {
            // No results - still hide presets/footer, show "no results" message
            presetsSection.style.display = 'none';
            footerSection.style.display = 'none';
            resultsContainer.classList.add('has-results');
            resultsContainer.innerHTML = `
                <div class="qa-context-no-results">No actions found for "${query}"</div>
            `;
        }
    }

    renderSlotPicker(actionId) {
        const slots = this.config.slots;
        const canAdd = slots.length < 8;

        return `
            <div class="qa-slot-picker">
                <div class="qa-slot-picker-title">${canAdd ? 'Add or replace:' : 'Replace which slot?'}</div>
                <div class="qa-slot-picker-slots">
                    ${slots.map((slotId, i) => {
                        const action = QuickActionsRegistry.get(slotId);
                        const icon = action ? (ICONS[action.icon] || ICONS['help-circle']) : ICONS['help-circle'];
                        const label = action?.label || slotId;
                        return `
                            <button class="qa-slot-picker-item" data-slot-index="${i}" data-new-action="${actionId}" data-tooltip="Replace: ${label}">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                    ${icon}
                                </svg>
                            </button>
                        `;
                    }).join('')}
                    ${canAdd ? `
                        <button class="qa-slot-picker-item add-new" data-slot-index="-1" data-new-action="${actionId}" data-tooltip="Add as new">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                ${ICONS['plus-circle']}
                            </svg>
                        </button>
                    ` : ''}
                </div>
            </div>
        `;
    }

    handleAddToMenu(actionId) {
        const isInSlots = this.config.slots.includes(actionId);
        if (isInSlots) {
            // Already in menu - could remove or just ignore
            this.showToast(S.toast.already_in_quick);
            return;
        }

        if (this.config.slots.length < 8) {
            // Can add directly
            this.config.slots.push(actionId);
            this.config.preset = 'custom';
            this.saveState();
            this.showToast(S.toast.added_to_quick);
            // Re-render search results to update the + button
            const searchInput = this.contextMenu.querySelector('.qa-context-search input');
            this.handleSearch(searchInput.value);
        } else {
            // Need to replace - expand the slot picker
            this.expandedResultId = actionId;
            const searchInput = this.contextMenu.querySelector('.qa-context-search input');
            this.handleSearch(searchInput.value);
        }
    }

    handleSlotReplace(slotIndex, newActionId) {
        if (slotIndex === -1) {
            // Add as new slot
            this.config.slots.push(newActionId);
        } else {
            // Replace existing slot
            this.config.slots[slotIndex] = newActionId;
        }
        this.config.preset = 'custom';
        this.saveState();
        this.expandedResultId = null;
        this.showToast(slotIndex === -1 ? 'Added to quick actions' : 'Replaced in quick actions');

        // Re-render search results
        const searchInput = this.contextMenu.querySelector('.qa-context-search input');
        this.handleSearch(searchInput.value);
    }

    showToast(message) {
        // Remove any existing toast
        const existing = this.contextMenu.querySelector('.qa-toast');
        if (existing) existing.remove();

        const toast = document.createElement('div');
        toast.className = 'qa-toast';
        toast.textContent = message;
        this.contextMenu.appendChild(toast);

        // Animate in
        requestAnimationFrame(() => toast.classList.add('visible'));

        // Remove after delay
        setTimeout(() => {
            toast.classList.remove('visible');
            setTimeout(() => toast.remove(), 200);
        }, 1500);
    }

    searchActions(query) {
        const allActions = QuickActionsRegistry.getAll();
        const results = [];

        for (const action of allActions) {
            const score = this.scoreMatch(query, action);
            if (score > 0) {
                results.push({ action, score });
            }
        }

        // Sort by score descending
        results.sort((a, b) => b.score - a.score);
        return results;
    }

    scoreMatch(query, action) {
        const q = query.toLowerCase();
        let score = 0;

        // Exact label start (highest)
        if (action.label.toLowerCase().startsWith(q)) score += 100;
        // Label contains
        else if (action.label.toLowerCase().includes(q)) score += 50;

        // Action ID contains (for power users: "git", "term", etc.)
        if (action.id.toLowerCase().includes(q)) score += 40;

        // Description contains
        if (action.description.toLowerCase().includes(q)) score += 25;

        // Category contains
        if (action.category.toLowerCase().includes(q)) score += 10;

        // Shortcut exact match
        if (action.shortcut?.toLowerCase().includes(q)) score += 30;

        return score;
    }

    highlightMatch(text, query) {
        const idx = text.toLowerCase().indexOf(query.toLowerCase());
        if (idx === -1) return text;
        return text.slice(0, idx) +
               `<mark>${text.slice(idx, idx + query.length)}</mark>` +
               text.slice(idx + query.length);
    }

    navigateResults(direction) {
        if (this.searchResults.length === 0) return;

        const maxIndex = Math.min(this.searchResults.length - 1, 5);
        this.selectedResultIndex = Math.max(0, Math.min(maxIndex, this.selectedResultIndex + direction));

        // Update visual selection
        const results = this.contextMenu.querySelectorAll('.qa-context-result');
        results.forEach((el, i) => {
            el.classList.toggle('selected', i === this.selectedResultIndex);
        });
    }

    executeSelectedResult() {
        if (this.searchResults.length === 0) return;
        const selected = this.searchResults[this.selectedResultIndex];
        if (selected) {
            this.executeAction(selected.action.id);
            this.closeContextMenu();
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Pointer/Drag Methods
    // ─────────────────────────────────────────────────────────────────────────

    onPointerDown(clientX, clientY, e) {
        this.startX = clientX;
        this.startY = clientY;
        this.startRight = this.position.right;
        this.startBottom = this.position.bottom;
        this.isDragging = true;
        this.didDrag = false;

        // Start long press timer for drag-release mode
        if (this.config.options.dragRelease) {
            this.longPressTimer = setTimeout(() => {
                this.isLongPress = true;
                if (!this.isOpen && !this.isContextMenuOpen) {
                    this.open();
                }
            }, LONG_PRESS_DELAY);
        }
    }

    onPointerMove(clientX, clientY) {
        if (!this.isDragging) return;

        const dx = clientX - this.startX;
        const dy = clientY - this.startY;

        // Check if we've moved beyond threshold
        if (!this.didDrag && (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD)) {
            this.didDrag = true;
            this.fab.classList.add('dragging');
            // Cancel long press if we're dragging
            if (this.longPressTimer) {
                clearTimeout(this.longPressTimer);
                this.longPressTimer = null;
            }
        }

        if (this.didDrag) {
            // Dragging FAB position (works with any menu open)
            const newRight = this.startRight - dx;
            const newBottom = this.startBottom - dy;

            const padding = 8;
            const fabSize = 52;
            const viewportWidth = window.visualViewport?.width || window.innerWidth;
            const viewportHeight = window.visualViewport?.height || window.innerHeight;

            this.position = {
                right: Math.max(padding, Math.min(viewportWidth - fabSize - padding, newRight)),
                bottom: Math.max(padding, Math.min(viewportHeight - fabSize - padding, newBottom))
            };

            this.applyPosition();

            // Reposition any open menu to follow FAB
            if (this.isContextMenuOpen) {
                this.positionContextMenu();
            }
            if (this.isOpen) {
                // Radial menu position is tied to FAB via CSS, but re-render to update tooltips
                this.renderMenuItems();
            }
        } else if (this.isLongPress && this.isOpen) {
            // Drag-to-select mode
            this.updateHighlight(clientX, clientY);
        }
    }

    onPointerUp() {
        if (!this.isDragging) return;

        this.isDragging = false;
        this.fab.classList.remove('dragging');

        if (this.longPressTimer) {
            clearTimeout(this.longPressTimer);
            this.longPressTimer = null;
        }

        if (this.didDrag) {
            // Save position after dragging (works with any menu open)
            this.saveState();
            setTimeout(() => { this.didDrag = false; }, 100);
        }

        if (this.isLongPress && this.isOpen) {
            // Execute highlighted action on release
            if (this.highlightedIndex >= 0) {
                const slots = this.config.slots;
                if (this.highlightedIndex < slots.length) {
                    this.executeAction(slots[this.highlightedIndex]);
                }
            }
            this.isLongPress = false;
            this.highlightedIndex = -1;
            this.close();
        }
    }

    updateHighlight(clientX, clientY) {
        const fabRect = this.fab.getBoundingClientRect();
        const centerX = fabRect.left + fabRect.width / 2;
        const centerY = fabRect.top + fabRect.height / 2;

        const dx = clientX - centerX;
        const dy = clientY - centerY;
        const distance = Math.sqrt(dx * dx + dy * dy);

        // Only select if dragged far enough from center
        if (distance < 30) {
            this.setHighlight(-1);
            return;
        }

        // Calculate angle and map to item index
        const angle = Math.atan2(dy, dx);
        const slots = this.config.slots;
        const itemCount = slots.length;
        const angleStep = (2 * Math.PI) / itemCount;
        const startAngle = -3 * Math.PI / 4; // Start from top-left (more horizontal layout)

        // Normalize angle to 0-2PI range starting from top-left
        let normalizedAngle = angle - startAngle;
        if (normalizedAngle < 0) normalizedAngle += 2 * Math.PI;
        if (normalizedAngle >= 2 * Math.PI) normalizedAngle -= 2 * Math.PI;

        const index = Math.floor(normalizedAngle / angleStep);
        this.setHighlight(Math.min(index, itemCount - 1));
    }

    setHighlight(index) {
        if (this.highlightedIndex === index) return;

        // Remove old highlight
        const oldItem = this.menu.querySelector('.quick-action-item.highlighted');
        if (oldItem) oldItem.classList.remove('highlighted');

        this.highlightedIndex = index;

        // Add new highlight
        if (index >= 0) {
            const items = this.menu.querySelectorAll('.quick-action-item');
            if (items[index]) {
                items[index].classList.add('highlighted');
                // Haptic feedback
                if (this.config.options.hapticFeedback && navigator.vibrate) {
                    navigator.vibrate(10);
                }
            }
        }
    }

    applyPosition() {
        if (!this.fab) return;
        this.fab.style.right = `${this.position.right}px`;
        this.fab.style.bottom = `${this.position.bottom}px`;

        // Position menu relative to FAB (with offset for edge-awareness)
        if (this.menu) {
            this.menu.style.right = `${this.position.right}px`;
            this.menu.style.bottom = `${this.position.bottom}px`;
        }
    }

    /**
     * Calculate offset needed to ensure all menu items are visible.
     * Returns {x, y} offset to apply to the menu (positive = move right/up).
     */
    calculateEdgeOffset() {
        const viewportWidth = window.visualViewport?.width || window.innerWidth;
        const viewportHeight = window.visualViewport?.height || window.innerHeight;

        // FAB center position in viewport coordinates
        const fabCenterX = viewportWidth - this.position.right - 26; // 26 = half FAB width
        const fabCenterY = viewportHeight - this.position.bottom - 26;

        // Calculate item positions for current slot configuration
        const slots = this.config.slots;
        const itemCount = slots.length;
        const angleStep = (2 * Math.PI) / itemCount;
        const startAngle = -3 * Math.PI / 4;

        let minX = Infinity, maxX = -Infinity;
        let minY = Infinity, maxY = -Infinity;

        for (let i = 0; i < itemCount; i++) {
            const angle = startAngle + (i * angleStep);
            const itemX = fabCenterX + Math.cos(angle) * MENU_RADIUS;
            const itemY = fabCenterY + Math.sin(angle) * MENU_RADIUS;

            // Account for item size (item center ± half item size)
            minX = Math.min(minX, itemX - ITEM_SIZE / 2);
            maxX = Math.max(maxX, itemX + ITEM_SIZE / 2);
            minY = Math.min(minY, itemY - ITEM_SIZE / 2);
            maxY = Math.max(maxY, itemY + ITEM_SIZE / 2);
        }

        // Calculate how much we need to shift to keep all items in viewport
        let offsetX = 0;
        let offsetY = 0;

        // Check left edge
        if (minX < EDGE_PADDING) {
            offsetX = EDGE_PADDING - minX;
        }
        // Check right edge
        if (maxX > viewportWidth - EDGE_PADDING) {
            offsetX = viewportWidth - EDGE_PADDING - maxX;
        }
        // Check top edge
        if (minY < EDGE_PADDING) {
            offsetY = EDGE_PADDING - minY;
        }
        // Check bottom edge
        if (maxY > viewportHeight - EDGE_PADDING) {
            offsetY = viewportHeight - EDGE_PADDING - maxY;
        }

        return { x: offsetX, y: offsetY };
    }

    /**
     * Apply offset to menu for edge-aware positioning.
     * Uses CSS transform for smooth animation.
     * Offset: positive X = move right, positive Y = move down
     */
    applyMenuOffset(offset, animate = true) {
        if (!this.menu) return;

        if (animate) {
            this.menu.classList.add('edge-shift');
        } else {
            this.menu.classList.remove('edge-shift');
        }

        this.menu.style.transform = `translate(${offset.x}px, ${offset.y}px)`;
    }

    /**
     * Reset menu offset (used when closing)
     */
    resetMenuOffset(animate = true) {
        if (!this.menu) return;

        if (animate) {
            this.menu.classList.add('edge-shift');
            // Remove the class after animation completes
            setTimeout(() => {
                this.menu?.classList.remove('edge-shift');
            }, 300);
        } else {
            this.menu.classList.remove('edge-shift');
        }

        this.menu.style.transform = '';
        this.menuOffset = { x: 0, y: 0 };
    }

    /**
     * Calculate offset for a specific center position (used by openAtPosition)
     */
    calculateEdgeOffsetAt(centerX, centerY) {
        const viewportWidth = window.visualViewport?.width || window.innerWidth;
        const viewportHeight = window.visualViewport?.height || window.innerHeight;

        // Calculate item positions for current slot configuration
        const slots = this.config.slots;
        const itemCount = slots.length;
        const angleStep = (2 * Math.PI) / itemCount;
        const startAngle = -3 * Math.PI / 4;

        let minX = Infinity, maxX = -Infinity;
        let minY = Infinity, maxY = -Infinity;

        for (let i = 0; i < itemCount; i++) {
            const angle = startAngle + (i * angleStep);
            const itemX = centerX + Math.cos(angle) * MENU_RADIUS;
            const itemY = centerY + Math.sin(angle) * MENU_RADIUS;

            minX = Math.min(minX, itemX - ITEM_SIZE / 2);
            maxX = Math.max(maxX, itemX + ITEM_SIZE / 2);
            minY = Math.min(minY, itemY - ITEM_SIZE / 2);
            maxY = Math.max(maxY, itemY + ITEM_SIZE / 2);
        }

        let offsetX = 0;
        let offsetY = 0;

        if (minX < EDGE_PADDING) {
            offsetX = EDGE_PADDING - minX;
        }
        if (maxX > viewportWidth - EDGE_PADDING) {
            offsetX = viewportWidth - EDGE_PADDING - maxX;
        }
        if (minY < EDGE_PADDING) {
            offsetY = EDGE_PADDING - minY;
        }
        if (maxY > viewportHeight - EDGE_PADDING) {
            offsetY = viewportHeight - EDGE_PADDING - maxY;
        }

        return { x: offsetX, y: offsetY };
    }

    updateVisibility() {
        if (!this.fab) return;
        this.fab.style.display = this.isVisibleHere() ? 'flex' : 'none';
    }

    updateFabBadge(count) {
        if (!this.fabBadge) return;
        // Show/hide debug logs item in context menu
        const debugItem = this.contextMenu?.querySelector('.qa-debug-logs-item');
        if (debugItem) debugItem.style.display = count > 0 ? '' : 'none';

        if (count > 0) {
            this.fabBadge.textContent = count > 99 ? '99+' : String(count);
            this.fabBadge.classList.add('visible');
            this.fab.classList.add('has-errors');
            // Brief attention animation on first error
            if (!this._hadErrors) {
                this._hadErrors = true;
                this.fab.classList.add('error-attention');
                setTimeout(() => this.fab.classList.remove('error-attention'), 600);
            }
        } else {
            this.fabBadge.textContent = '';
            this.fabBadge.classList.remove('visible');
            this.fab.classList.remove('has-errors');
            this._hadErrors = false;
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Radial Menu Methods
    // ─────────────────────────────────────────────────────────────────────────

    toggle() {
        if (this.isOpen) {
            this.close();
        } else {
            this.open();
        }
    }

    open() {
        if (this.isOpen) return;

        this.isOpen = true;
        this.fab.classList.add('open');
        this.fab.setAttribute('aria-expanded', 'true');
        this.fab.removeAttribute('data-tooltip'); // Hide tooltip while menu is open
        TooltipManager.hideTooltip(); // Clear any pending/active tooltip
        this.overlay.classList.add('visible');
        this.menu.classList.add('open');

        // Calculate and apply edge-aware offset
        this.menuOffset = this.calculateEdgeOffset();
        if (this.menuOffset.x !== 0 || this.menuOffset.y !== 0) {
            this.applyMenuOffset(this.menuOffset, true);
        }

        this.renderMenuItems();
    }

    close() {
        if (!this.isOpen) return;

        this.isOpen = false;
        this.fab.classList.remove('open');
        this.fab.setAttribute('aria-expanded', 'false');
        this.fab.setAttribute('data-tooltip', 'Quick Actions - Drag to move, right-click for options'); // Restore tooltip
        this.overlay.classList.remove('visible');
        this.menu.classList.remove('open');

        // Clear highlights
        this.highlightedIndex = -1;

        // Reset edge-aware offset
        if (this.menuOffset.x !== 0 || this.menuOffset.y !== 0) {
            this.resetMenuOffset(true);
        }

        // Reset menu position if it was opened at cursor
        if (this.openedAtCursor) {
            this.openedAtCursor = false;
            this.applyPosition(); // Restore menu to FAB position
        }
    }

    /**
     * Open the radial menu at a specific screen position (e.g., right-click location)
     */
    openAtPosition(x, y) {
        // Calculate position from right/bottom edges
        const viewportWidth = window.visualViewport?.width || window.innerWidth;
        const viewportHeight = window.visualViewport?.height || window.innerHeight;

        // Position menu centered at cursor
        const menuRight = viewportWidth - x - 26; // 26 = half of menu center
        const menuBottom = viewportHeight - y - 26;

        // Apply cursor position to menu only (FAB stays in place)
        this.menu.style.right = `${menuRight}px`;
        this.menu.style.bottom = `${menuBottom}px`;
        this.openedAtCursor = true;

        // Calculate edge offset for cursor position
        this.menuOffset = this.calculateEdgeOffsetAt(x, y);
        if (this.menuOffset.x !== 0 || this.menuOffset.y !== 0) {
            this.applyMenuOffset(this.menuOffset, true);
        }

        // If already open, just reposition (no animation needed)
        if (this.isOpen) return;

        this.isOpen = true;
        // Don't change FAB appearance when opened via background click
        this.overlay.classList.add('visible');
        this.menu.classList.add('open');

        this.renderMenuItems();
    }

    renderMenuItems() {
        const slots = this.config.slots;
        const itemCount = slots.length;
        const angleStep = (2 * Math.PI) / itemCount;
        const startAngle = -3 * Math.PI / 4; // Start from top-left (more horizontal layout)

        let html = '';

        slots.forEach((actionId, index) => {
            const action = QuickActionsRegistry.get(actionId);
            if (!action) {
                console.warn(`[QuickActions] Unknown action in slot: ${actionId}`);
                return;
            }

            const angle = startAngle + (index * angleStep);
            const x = Math.cos(angle) * MENU_RADIUS;
            const y = Math.sin(angle) * MENU_RADIUS;

            const isEnabled = action.isEnabled();
            const badge = action.badge ? action.badge() : null;
            const iconSvg = ICONS[action.icon] || ICONS['help-circle'];

            // Calculate tooltip position based on item position
            let tooltipPosition = 'left';
            if (x > 20) tooltipPosition = 'left';
            else if (x < -20) tooltipPosition = 'right';
            else if (y < 0) tooltipPosition = 'bottom';
            else tooltipPosition = 'top';

            // Slot key for keyboard shortcut (1-4 for top, Q-W-E-R for bottom L→R)
            const slotKey = getSlotKeyLabel(index, itemCount);

            html += `
                <button class="quick-action-item${isEnabled ? '' : ' disabled'}"
                        data-action-id="${actionId}"
                        data-slot="${slotKey}"
                        data-slot-index="${index}"
                        data-tooltip="${action.label}${action.shortcut ? ` (${action.shortcut})` : ''}"
                        data-tooltip-position="${tooltipPosition}"
                        style="--item-x: ${x}px; --item-y: ${y}px; --item-delay: ${index * 30}ms"
                        ${isEnabled ? '' : 'disabled'}
                        role="menuitem"
                        aria-label="${action.label}${action.shortcut ? ` (${action.shortcut})` : ''} - Press ${slotKey}">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        ${iconSvg}
                    </svg>
                    <span class="quick-action-slot-number">${slotKey}</span>
                    ${badge ? `<span class="quick-action-badge">${badge}</span>` : ''}
                </button>
            `;
        });

        this.menu.innerHTML = html;
    }

    executeAction(actionId) {
        const success = QuickActionsRegistry.execute(actionId);
        if (success) {
            this.close();
        }

        // Restore focus to previous element (keeps keyboard open on iOS)
        // Use setTimeout to run after action completes.
        // Skip the restore if the action moved focus to a different input
        // (e.g. quick switcher) — otherwise we'd steal focus and dismiss
        // the mobile keyboard that the new input just brought up.
        if (this.previousFocus && this.previousFocus.focus) {
            setTimeout(() => {
                const current = document.activeElement;
                const tookFocus = current && current !== this.previousFocus &&
                    (current.tagName === 'INPUT' ||
                     current.tagName === 'TEXTAREA' ||
                     current.isContentEditable);
                if (!tookFocus) {
                    this.previousFocus?.focus();
                }
                this.previousFocus = null;
            }, 50);
        }
    }

    /**
     * Update configuration (called from settings)
     */
    setConfig(newConfig) {
        this.config = { ...this.config, ...newConfig };
        this.saveState();
        if (this.isOpen) {
            this.renderMenuItems();
        }
    }

    /**
     * Apply a preset
     */
    applyPreset(presetId) {
        const preset = QUICK_ACTION_PRESETS[presetId];
        if (!preset) {
            console.warn(`[QuickActions] Unknown preset: ${presetId}`);
            return;
        }

        this.config.preset = presetId;
        this.config.slots = [...preset.slots];
        this.saveState();

        if (this.isOpen) {
            this.renderMenuItems();
        }
    }

    /**
     * Get current configuration
     */
    getConfig() {
        return { ...this.config };
    }

    /**
     * Get user-defined custom actions
     */
    getCustomActions() {
        return [...this.customActions];
    }

    /**
     * Replace custom actions: re-sync the registry, persist, refresh menu
     */
    setCustomActions(list) {
        this.customActions = Array.isArray(list) ? list : [];
        syncCustomActions(this.customActions);
        this.saveState();

        if (this.isOpen) {
            this.renderMenuItems();
        }
    }

    /**
     * Set FAB visibility mode: 'always' | 'mobile' | 'disabled'
     */
    setVisibility(mode) {
        if (!['always', 'mobile', 'disabled'].includes(mode)) return;
        this.visibility = mode;
        this.updateVisibility();
        this.saveState();
    }

    /**
     * Get FAB visibility mode
     */
    getVisibility() {
        return this.visibility;
    }

    /**
     * Reset position to default
     */
    resetPosition() {
        this.position = getDefaultPosition();
        this.applyPosition();
        this.saveState();
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton instance
// ─────────────────────────────────────────────────────────────────────────────

export const quickActionsMenu = new QuickActionsMenu();

/**
 * Initialize the quick actions menu
 */
export function initQuickActionsMenu() {
    quickActionsMenu.init();
}

// Export for settings panel
export { QUICK_ACTION_PRESETS, getSlotKeyLabel };
