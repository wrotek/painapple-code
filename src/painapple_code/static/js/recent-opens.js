/**
 * Recent file opens — a small localStorage-backed log of files the user has
 * opened (floating preview or tab). The Cmd+K quick-switcher blends these with
 * files Claude modified (turn_files) so its empty-query default list reflects
 * "recently opened or modified", merged purely by recency.
 *
 * Paths are stored as given by the open chokepoints (absolute), newest-first,
 * deduped by path, capped at MAX entries.
 */

const KEY = 'recent-file-opens';
const MAX = 60;

function read() {
    try {
        const raw = localStorage.getItem(KEY);
        if (!raw) return [];
        const list = JSON.parse(raw);
        return Array.isArray(list) ? list : [];
    } catch {
        return [];
    }
}

export function recordOpen(path) {
    if (!path || typeof path !== 'string') return;
    try {
        const list = read().filter(e => e && e.path !== path);
        list.unshift({ path, t: Date.now() });
        if (list.length > MAX) list.length = MAX;
        localStorage.setItem(KEY, JSON.stringify(list));
    } catch {
        // localStorage may be unavailable / quota-full — opens tracking is a
        // nice-to-have, so swallow.
    }
}

export function getRecentOpens() {
    return read();
}
