/**
 * Selection System - Module Index
 *
 * Text selection handling for Comments Stash and Discussion features.
 * Supports text selection on:
 * - Rendered markdown in FilePreviewWidget
 * - Chat messages in main conversation
 */

export {
    initSelectionHandler,
    registerSelectionContainer,
    unregisterSelectionContainer,
    destroySelectionHandler
} from './selection-handler.js';
