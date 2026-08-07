/**
 * QuickAccessRegistry — maps an input prefix to a Provider factory.
 *
 * Longer prefixes are tested first ("file " before "f"), so a prefix that's
 * a subset of another doesn't shadow it.
 */

class QuickAccessRegistryClass {
    constructor() {
        this.entries = [];
    }

    /**
     * Register a provider.
     * @param {string} prefix - "" for default, or e.g. ">", "#", "file "
     * @param {Function} factory - Returns a provider instance (lazily instantiated)
     * @param {string} placeholder - Input placeholder when this provider is active
     */
    register(prefix, factory, placeholder) {
        this.entries.push({ prefix, factory, placeholder, _instance: null });
        this.entries.sort((a, b) => b.prefix.length - a.prefix.length);
    }

    /**
     * Find the matching entry for an input string.
     * Default ("") provider always matches as a last resort.
     */
    match(input) {
        for (const e of this.entries) {
            if (e.prefix === '' || input.startsWith(e.prefix)) return e;
        }
        return null;
    }

    /**
     * Get (or lazily create) the provider instance.
     */
    instance(entry) {
        if (!entry._instance) entry._instance = entry.factory();
        return entry._instance;
    }

    /**
     * Strip the prefix off an input and return the remaining query.
     */
    stripPrefix(input, prefix) {
        return input.slice(prefix.length);
    }

    /**
     * Look up an entry by exact prefix — used when a prefix is already active
     * as controller state and we don't want to re-match against input content.
     */
    findByPrefix(prefix) {
        return this.entries.find(e => e.prefix === prefix) || null;
    }

    /**
     * Tell every already-instantiated provider to clear any transient state
     * (e.g. drill-in focus). Called when the switcher is re-opened.
     */
    resetAllInstances() {
        for (const e of this.entries) {
            e._instance?.onReset?.();
        }
    }
}

export const QuickAccessRegistry = new QuickAccessRegistryClass();
