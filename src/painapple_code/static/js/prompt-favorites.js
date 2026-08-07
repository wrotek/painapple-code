/**
 * Prompt Favorites - Mark prompts as favorites before/after sending
 *
 * Features:
 * - Toggle favorite state for current prompt before sending
 * - Visual feedback with heart icon states
 * - Auto-reset after sending (unfilled for next prompt)
 * - API functions for managing favorites from prompt explorer
 */

import { CONFIG, debug } from './config.js';

// ═══════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════

const state = {
    // Whether to mark the CURRENT prompt as favorite when sent
    markNextAsFavorite: false,
};

// ═══════════════════════════════════════════════════════════════════════
// API FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Add a prompt to favorites
 */
export async function addFavorite(promptId, contentPreview = '', note = '') {
    try {
        const response = await fetch(`${CONFIG.API_BASE}/api/prompts/favorites`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                prompt_id: promptId,
                content_preview: contentPreview,
                note: note,
            }),
        });
        const data = await response.json();
        return data.success;
    } catch (error) {
        console.error('[PromptFavorites] Failed to add favorite:', error);
        return false;
    }
}

/**
 * Remove a prompt from favorites
 */
export async function removeFavorite(promptId) {
    try {
        const response = await fetch(
            `${CONFIG.API_BASE}/api/prompts/favorites/${encodeURIComponent(promptId)}`,
            { method: 'DELETE' }
        );
        return response.ok;
    } catch (error) {
        console.error('[PromptFavorites] Failed to remove favorite:', error);
        return false;
    }
}

/**
 * Check if a prompt is favorited
 */
export async function isFavorite(promptId) {
    try {
        const response = await fetch(
            `${CONFIG.API_BASE}/api/prompts/favorites/${encodeURIComponent(promptId)}`
        );
        const data = await response.json();
        return data.is_favorite;
    } catch (error) {
        console.error('[PromptFavorites] Failed to check favorite:', error);
        return false;
    }
}

/**
 * Toggle favorite state for a prompt
 * @returns {Promise<boolean>} New favorite state (true = now favorite, false = now unfavorited)
 */
export async function toggleFavorite(promptId, contentPreview = '') {
    const currentlyFavorite = await isFavorite(promptId);
    if (currentlyFavorite) {
        await removeFavorite(promptId);
        return false;
    } else {
        await addFavorite(promptId, contentPreview);
        return true;
    }
}

/**
 * Get all favorites
 */
export async function getAllFavorites() {
    try {
        const response = await fetch(`${CONFIG.API_BASE}/api/prompts/favorites`);
        const data = await response.json();
        return data.favorites || {};
    } catch (error) {
        console.error('[PromptFavorites] Failed to get favorites:', error);
        return {};
    }
}

// ═══════════════════════════════════════════════════════════════════════
// UI STATE MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════

/**
 * Toggle whether to mark the next prompt as favorite
 */
export function toggleMarkNextAsFavorite() {
    state.markNextAsFavorite = !state.markNextAsFavorite;
    debug.log('[PromptFavorites] Toggled, markNextAsFavorite:', state.markNextAsFavorite);
    updateButtonUI();
}

/**
 * Check if next prompt should be marked as favorite
 */
export function shouldMarkAsFavorite() {
    return state.markNextAsFavorite;
}

/**
 * Reset state (called after sending, or when switching sessions)
 */
export function reset() {
    state.markNextAsFavorite = false;
    updateButtonUI();
}

/**
 * Update the favorite button UI
 */
function updateButtonUI() {
    const btn = document.getElementById('favorite-prompt-btn');
    if (!btn) {
        console.warn('[PromptFavorites] updateButtonUI: button not found');
        return;
    }

    const isActive = state.markNextAsFavorite;
    btn.classList.toggle('active', isActive);
    debug.log('[PromptFavorites] UI updated, active:', isActive);

    // Update title based on state
    btn.setAttribute('data-tooltip', isActive
        ? 'Prompt will be marked as favorite'
        : 'Mark prompt as favorite');
}

// ═══════════════════════════════════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════════════════════════════════

/**
 * Initialize the prompt favorites module
 */
export function init() {
    const btn = document.getElementById('favorite-prompt-btn');
    debug.log('[PromptFavorites] Init, button found:', !!btn);

    if (btn) {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            debug.log('[PromptFavorites] Button clicked, toggling...');
            toggleMarkNextAsFavorite();
        });
        debug.log('[PromptFavorites] Click listener attached');
    } else {
        console.warn('[PromptFavorites] Button #favorite-prompt-btn not found!');
    }

    updateButtonUI();
    debug.log('[PromptFavorites] Initialized, state:', state);
}

// Export state for debugging
export function getState() {
    return { ...state };
}
