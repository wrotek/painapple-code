/**
 * Abstract Provider for the Quick Switcher.
 *
 * Subclasses must implement getItems(query). All other methods are optional.
 *
 * Item shape (returned from getItems):
 *   {
 *     id: string,            // stable id for tracking selections
 *     type: string,          // 'file' | 'command' | 'panel' | …
 *     label: string,         // primary text (highlighted on match)
 *     description?: string,  // secondary text under label
 *     icon?: string,         // SVG markup OR a string name (provider-defined)
 *     meta?: string,         // right-aligned chip text (e.g. shortcut, "recent")
 *     score?: number,        // for sorting — higher first
 *     matches?: number[],    // indices into `label` for highlighting
 *     data?: any             // free-form payload the provider uses on execute
 *   }
 */

export class BaseProvider {
    /**
     * Return matching items for a query (already stripped of prefix).
     * Should be fast and idempotent.
     * @param {string} query
     * @returns {Promise<Array>}
     */
    async getItems(query) {
        return [];
    }

    /**
     * Execute the user's choice.
     * @param {object} item - From getItems()
     * @param {object} [opts] - Modifier-driven hints: {background, newTab}
     * @returns {Promise<void> | void}
     */
    async execute(item, opts = {}) {
        // override
    }

    /**
     * Return secondary actions for an item (right-click / long-press).
     * Same shape as ContextMenu items: {label, action, separator?, type?}.
     * Empty array → no menu shown.
     * @param {object} item
     * @returns {Array}
     */
    getContextMenuItems(item) {
        return [];
    }
}
