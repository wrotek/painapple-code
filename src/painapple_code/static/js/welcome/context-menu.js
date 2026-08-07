/**
 * Long-press detection + session and project context menus.
 *
 * The session menu (renderContextMenu/showContextMenu) appears on right-click
 * or long-press of any session row/card. The project menu lives lower down
 * and appears on right-click/long-press of the project name beneath a card.
 *
 * Long-press detection lives here because it's the entry point for both
 * menus on touch devices. The triggered/timestamp/suppressNextClick flags
 * are read elsewhere (welcome.js attachEventListeners) so they're hosted on
 * the shared `longPress` ref in state.js.
 */

import S from '../strings.js';
import { debug } from '../config.js';
import { copyToClipboard, showToast } from '../context-menu.js';
import {
    state,
    longPress,
    contextMenuOpenTime,
    isFavorite,
    saveWelcomeState,
} from './state.js';
import { showPreview } from './preview.js';
import {
    toggleFavorite,
    renameSession,
    renameProject,
    setProjectFilter,
} from './api.js';
import { renderWelcomeScreen } from '../welcome.js';
import { showProjectColorPicker } from '../project-color-picker.js';

// ═══════════════════════════════════════════════════════════════════════════
// SESSION CONTEXT MENU
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Render context menu.
 */
function renderContextMenu(session, x, y) {
    if (!session) return '';

    const sessionId = session.session_id;
    const isFav = isFavorite(sessionId);

    return `
        <div class="session-context-overlay" data-action="close-context"></div>
        <div class="session-context-menu" style="left: ${x}px; top: ${y}px;">
            <button class="context-menu-item" data-action="context-toggle-favorite">
                <svg viewBox="0 0 24 24" fill="${isFav ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2">
                    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
                </svg>
                ${isFav ? 'Remove from Favorites' : 'Add to Favorites'}
            </button>
            <button class="context-menu-item" data-action="context-rename">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                </svg>
                Rename
            </button>
            <div class="context-menu-divider"></div>
            <button class="context-menu-item" data-action="context-open">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                    <polyline points="15 3 21 3 21 9"/>
                    <line x1="10" y1="14" x2="21" y2="3"/>
                </svg>
                Open
            </button>
            <button class="context-menu-item" data-action="context-open-new-tab">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                    <line x1="9" y1="3" x2="9" y2="21"/>
                </svg>
                Open in New Tab
            </button>
            <button class="context-menu-item" data-action="context-preview">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                    <circle cx="12" cy="12" r="3"/>
                </svg>
                Quick Preview
            </button>
            <button class="context-menu-item" data-action="context-copy-id">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                </svg>
                Copy Session ID
            </button>
            <button class="context-menu-item" data-action="context-copy-url">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
                    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
                </svg>
                Copy Session URL
            </button>
            <div class="context-menu-divider"></div>
            <button class="context-menu-item" data-action="context-fork">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="12" cy="18" r="3"/>
                    <circle cx="6" cy="6" r="3"/>
                    <circle cx="18" cy="6" r="3"/>
                    <path d="M18 9v1a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V9"/>
                    <line x1="12" y1="12" x2="12" y2="15"/>
                </svg>
                Fork Session
            </button>
            <div class="context-menu-divider"></div>
            <button class="context-menu-item context-menu-item--accent" data-action="context-new-session">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M12 5v14M5 12h14"/>
                </svg>
                New Session on Project
            </button>
        </div>
    `;
}

/**
 * Show context menu.
 * NOTE: Menu is appended to document.body (like ContextMenu class) to avoid
 * event bubbling issues with the welcome screen's click handlers.
 */
export function showContextMenu(session, x, y, container) {
    // Close any existing context menu
    closeContextMenu(container);

    state.contextMenuSession = session;
    state.contextMenuPos = { x, y };
    state.contextMenuContainer = container; // Store for later use

    // Track when menu was opened for click suppression
    contextMenuOpenTime.value = Date.now();

    // Render context menu - append to body, not container
    const menuHtml = renderContextMenu(session, x, y);
    document.body.insertAdjacentHTML('beforeend', menuHtml);

    // Adjust position if menu would go off screen
    const menu = document.body.querySelector('.session-context-menu');
    if (menu) {
        const rect = menu.getBoundingClientRect();
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;

        if (rect.right > viewportWidth) {
            menu.style.left = `${x - rect.width}px`;
        }
        if (rect.bottom > viewportHeight) {
            menu.style.top = `${y - rect.height}px`;
        }
    }

    attachContextMenuListeners(container);
}

/**
 * Close context menu.
 */
export function closeContextMenu(container) {
    state.contextMenuSession = null;
    state.contextMenuPos = null;
    state.contextMenuContainer = null;

    // Menu is in document.body, not container
    const overlay = document.body.querySelector('.session-context-overlay');
    const menu = document.body.querySelector('.session-context-menu');
    if (overlay) overlay.remove();
    if (menu) menu.remove();
}

/**
 * Attach context menu event listeners.
 *
 * KEY: Uses setTimeout to delay adding dismiss listeners.
 * This is the standard pattern (used by ContextMenu class) to prevent
 * the same touch gesture that opened the menu from immediately closing it.
 *
 * Additional protection: We track the open timestamp and ignore clicks
 * that happen too close to when the menu was opened (iOS can generate
 * synthetic click events after touchend).
 */
function attachContextMenuListeners(container) {
    const session = state.contextMenuSession;
    if (!session) return;

    // Menu is now in document.body
    const overlay = document.body.querySelector('.session-context-overlay');
    const menu = document.body.querySelector('.session-context-menu');

    // Use the shared open timestamp for protection against immediate synthetic clicks
    const openedAt = contextMenuOpenTime.value;
    const minClickDelay = 350; // Ignore clicks within 350ms of opening (increased for iOS)

    // Delay adding dismiss listeners to avoid immediate dismissal from same gesture
    // This is the key pattern from ContextMenu class
    setTimeout(() => {
        // Document-level click listener to dismiss
        const dismissOnClick = (e) => {
            // Don't dismiss if clicking inside the menu
            if (menu && menu.contains(e.target)) return;
            // Don't dismiss if clicking the overlay (it has its own handler)
            if (overlay && overlay.contains(e.target)) return;
            // Ignore clicks that happen too soon after opening (synthetic iOS clicks)
            if (Date.now() - openedAt < minClickDelay) return;
            closeContextMenu(container);
            document.removeEventListener('click', dismissOnClick, true);
        };
        document.addEventListener('click', dismissOnClick, true);
    }, 10); // Match ContextMenu class timing

    // Overlay click - but also needs delay protection for iOS
    if (overlay) {
        overlay.addEventListener('click', (e) => {
            e.stopPropagation();
            // Same protection: ignore clicks too close to menu open time
            if (Date.now() - openedAt < minClickDelay) return;
            closeContextMenu(container);
        });
    }

    // Menu item handlers - these can be immediate since user explicitly clicks them
    // Toggle favorite
    menu?.querySelector('[data-action="context-toggle-favorite"]')?.addEventListener('click', async (e) => {
        e.stopPropagation();
        closeContextMenu(container);
        await toggleFavorite(session.session_id, container);
    });

    // Rename
    menu?.querySelector('[data-action="context-rename"]')?.addEventListener('click', async (e) => {
        e.stopPropagation();
        closeContextMenu(container);
        await renameSession(session.session_id, session.name || 'Session', container);
    });

    // Open (current tab)
    menu?.querySelector('[data-action="context-open"]')?.addEventListener('click', (e) => {
        e.stopPropagation();
        // Save state before opening (for "back to sessions" feature)
        saveWelcomeState(container);
        closeContextMenu(container);
        window.dispatchEvent(new CustomEvent('welcome:open-session', {
            detail: { sessionId: session.session_id, projectPath: session.project_path, fromWelcome: true }
        }));
    });

    // Open in new tab (no back button needed since we stay on welcome)
    menu?.querySelector('[data-action="context-open-new-tab"]')?.addEventListener('click', (e) => {
        e.stopPropagation();
        closeContextMenu(container);
        window.dispatchEvent(new CustomEvent('welcome:open-session-new-tab', {
            detail: { sessionId: session.session_id, projectPath: session.project_path }
        }));
    });

    // Preview
    menu?.querySelector('[data-action="context-preview"]')?.addEventListener('click', (e) => {
        e.stopPropagation();
        closeContextMenu(container);
        showPreview(session, container);
    });

    // Copy session ID
    menu?.querySelector('[data-action="context-copy-id"]')?.addEventListener('click', async (e) => {
        e.stopPropagation();
        closeContextMenu(container);
        if (await copyToClipboard(session.session_id)) showToast(S.toast.session_id_copied);
    });

    // Copy session URL
    menu?.querySelector('[data-action="context-copy-url"]')?.addEventListener('click', async (e) => {
        e.stopPropagation();
        closeContextMenu(container);
        const url = `${location.origin}/app?session=${session.session_id}`;
        if (await copyToClipboard(url)) showToast(S.toast.url_copied);
    });

    // Fork
    menu?.querySelector('[data-action="context-fork"]')?.addEventListener('click', (e) => {
        e.stopPropagation();
        // Save state before forking
        saveWelcomeState(container);
        closeContextMenu(container);
        window.dispatchEvent(new CustomEvent('welcome:fork-session', {
            detail: { sessionId: session.session_id, projectPath: session.project_path, fromWelcome: true }
        }));
    });

    // New session on this project
    menu?.querySelector('[data-action="context-new-session"]')?.addEventListener('click', (e) => {
        e.stopPropagation();
        closeContextMenu(container);
        window.dispatchEvent(new CustomEvent('welcome:new-session-on-project', {
            detail: { projectPath: session.project_path }
        }));
    });
}

// ═══════════════════════════════════════════════════════════════════════════
// LONG-PRESS DETECTION
// ═══════════════════════════════════════════════════════════════════════════

export function setupLongPress(element, session, container) {
    let startX, startY;

    const startLongPress = (x, y) => {
        startX = x;
        startY = y;
        longPress.triggered = false;
        longPress.timer = setTimeout(() => {
            longPress.triggered = true;
            longPress.timestamp = Date.now();
            longPress.suppressNextClick = true; // Suppress the click that iOS generates after touchend
            showContextMenu(session, x, y, container);
        }, 500); // 500ms long press
    };

    const cancelLongPress = () => {
        if (longPress.timer) {
            clearTimeout(longPress.timer);
            longPress.timer = null;
        }
    };

    const checkMove = (x, y) => {
        // Cancel if moved more than 10px
        if (Math.abs(x - startX) > 10 || Math.abs(y - startY) > 10) {
            cancelLongPress();
        }
    };

    // Touch events - use passive: false for touchstart/touchend to allow preventDefault
    element.addEventListener('touchstart', (e) => {
        // Don't start long press if touching project element (has its own handler)
        if (e.target.closest('[data-action="filter-project"]')) {
            return;
        }
        const touch = e.touches[0];
        startLongPress(touch.clientX, touch.clientY);
    }, { passive: true });

    element.addEventListener('touchmove', (e) => {
        const touch = e.touches[0];
        checkMove(touch.clientX, touch.clientY);
    }, { passive: true });

    element.addEventListener('touchend', (e) => {
        cancelLongPress();
        // If long press was triggered, prevent any follow-up actions
        if (longPress.triggered) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            // Keep suppressNextClick true - it will be cleared by the click handler or timeout
            setTimeout(() => { longPress.suppressNextClick = false; }, 400);
        }
    }, { passive: false }); // Need passive: false to allow preventDefault

    element.addEventListener('touchcancel', cancelLongPress);

    // Capture click events and suppress them if triggered by long press
    element.addEventListener('click', (e) => {
        if (longPress.suppressNextClick) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            longPress.suppressNextClick = false;
        }
    }, { capture: true });

    // Right-click
    element.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        longPress.triggered = true;
        longPress.timestamp = Date.now();
        longPress.suppressNextClick = true;
        showContextMenu(session, e.clientX, e.clientY, container);
    });
}

/**
 * Check if a long press was recently triggered (within 500ms).
 * This helps prevent stray click events from being processed.
 */
export function wasLongPressRecent() {
    return longPress.triggered && (Date.now() - longPress.timestamp < 500);
}

// ═══════════════════════════════════════════════════════════════════════════
// PROJECT CONTEXT MENU
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Show context menu for a project.
 * @param {string} projectPath - Full project path
 * @param {string} projectName - Display name
 * @param {number} x - Mouse X
 * @param {number} y - Mouse Y
 * @param {HTMLElement} container
 */
export function showProjectContextMenu(projectPath, projectName, x, y, container) {
    // Close any existing context menu
    closeProjectContextMenu(container);

    state.projectContextMenu = { path: projectPath, name: projectName, x, y };

    // Render context menu
    const menu = document.createElement('div');
    menu.className = 'project-context-menu';
    menu.innerHTML = `
        <div class="context-menu-item" data-action="ctx-filter-project">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
                <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>
            </svg>
            Filter by project
        </div>
        <div class="context-menu-item" data-action="ctx-rename-project">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
                <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
                <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
            </svg>
            ${S.ui.welcome.context.rename_project}
        </div>
        <div class="context-menu-item" data-action="ctx-set-color">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
                <circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/>
                <circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/>
                <circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/>
                <circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/>
                <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/>
            </svg>
            ${S.ui.welcome.context.set_color}
        </div>
        <div class="context-menu-item" data-action="ctx-new-session">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
                <line x1="12" y1="5" x2="12" y2="19"/>
                <line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
            New session
        </div>
        <div class="context-menu-separator"></div>
        <div class="context-menu-item" data-action="ctx-copy-path">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
            </svg>
            Copy path
        </div>
        <div class="context-menu-item" data-action="ctx-open-terminal">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
                <polyline points="4 17 10 11 4 5"/>
                <line x1="12" y1="19" x2="20" y2="19"/>
            </svg>
            Open in terminal
        </div>
    `;

    // Position menu
    menu.style.position = 'fixed';
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    menu.style.zIndex = '9999';

    // Add to DOM
    document.body.appendChild(menu);

    // Adjust position if menu goes off screen
    requestAnimationFrame(() => {
        const rect = menu.getBoundingClientRect();
        if (rect.right > window.innerWidth) {
            menu.style.left = `${window.innerWidth - rect.width - 8}px`;
        }
        if (rect.bottom > window.innerHeight) {
            menu.style.top = `${window.innerHeight - rect.height - 8}px`;
        }
    });

    // Add click handlers
    menu.querySelectorAll('.context-menu-item').forEach(item => {
        item.addEventListener('click', () => {
            const action = item.dataset.action;
            handleProjectContextAction(action, projectPath, projectName, container);
            closeProjectContextMenu(container);
        });
    });

    // Close on click outside
    const closeHandler = (e) => {
        if (!menu.contains(e.target)) {
            closeProjectContextMenu(container);
            document.removeEventListener('click', closeHandler);
        }
    };
    setTimeout(() => document.addEventListener('click', closeHandler), 0);

    // Close on Escape
    const escHandler = (e) => {
        if (e.key === 'Escape') {
            closeProjectContextMenu(container);
            document.removeEventListener('keydown', escHandler);
        }
    };
    document.addEventListener('keydown', escHandler);
}

/**
 * Close project context menu.
 */
export function closeProjectContextMenu(container) {
    state.projectContextMenu = null;
    document.querySelectorAll('.project-context-menu').forEach(m => m.remove());
}

/**
 * Handle project context menu action.
 */
function handleProjectContextAction(action, projectPath, projectName, container) {
    switch (action) {
        case 'ctx-filter-project':
            setProjectFilter(projectPath, projectName, container);
            break;

        case 'ctx-rename-project':
            renameProject(projectPath, projectName, container);
            break;

        case 'ctx-set-color': {
            // Reuse the context menu's position for the swatch popup.
            const pos = state.projectContextMenu || {};
            showProjectColorPicker(
                projectPath, pos.x || 100, pos.y || 100,
                () => renderWelcomeScreen(container),
            );
            break;
        }

        case 'ctx-new-session':
            window.dispatchEvent(new CustomEvent('welcome:new-session-on-project', {
                detail: { projectPath }
            }));
            break;

        case 'ctx-copy-path':
            navigator.clipboard.writeText(projectPath).then(() => {
                // Brief visual feedback could be added here
                debug.log('[Welcome] Copied path:', projectPath);
            });
            break;

        case 'ctx-open-terminal':
            window.dispatchEvent(new CustomEvent('welcome:open-terminal', {
                detail: { cwd: projectPath }
            }));
            break;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC: GLOBAL ESCAPE HANDLING
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Close welcome screen context menu if open (exported for global Escape handling).
 * Re-exported through welcome.js as the public API.
 * @returns {boolean} True if context menu was closed
 */
export function closeWelcomeContextMenu() {
    // Check session context menu
    if (state.contextMenuSession) {
        closeContextMenu(state.contextMenuContainer);
        return true;
    }
    // Check project context menu
    if (state.projectContextMenu) {
        const container = document.getElementById('welcome-container');
        closeProjectContextMenu(container);
        return true;
    }
    return false;
}
