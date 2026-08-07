/**
 * Deterministic per-project color coding.
 *
 * Hashes a project path (session cwd) into a curated palette of
 * dark-theme-friendly hues so every project gets a stable accent color
 * across session tabs, welcome cards, and project pickers — zero config.
 *
 * The hash is client-side only (djb2 over the normalized path); it does
 * NOT need to match the server's project hash. Same input string always
 * yields the same color, on every device.
 *
 * Consumers interpolate `projectColorStyle(path)` into template markup;
 * CSS then reads `var(--project-color, <fallback>)` so elements without
 * a known project degrade gracefully.
 */

/**
 * Curated palette: distinct hues at similar perceived brightness,
 * readable as accents against the dark theme. Order interleaves hues so
 * adjacent hash buckets don't look alike.
 */
export const PROJECT_PALETTE = [
    '#4A9EFF', // blue
    '#34D399', // emerald
    '#F59E0B', // amber
    '#F472B6', // pink
    '#A78BFA', // violet
    '#22D3EE', // cyan
    '#FB923C', // orange
    '#A3E635', // lime
    '#F87171', // red
    '#38BDF8', // sky
    '#FBBF24', // yellow
    '#C084FC', // purple
    '#2DD4BF', // teal
    '#FB7185', // rose
];

/** djb2 string hash — tiny, fast, stable across sessions/devices. */
function hashString(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) {
        h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
    }
    return h;
}

/**
 * User-assigned custom colors, keyed by normalized project path.
 * Populated once from the server (`loadProjectColors`) and mutated in
 * place by `setProjectColorOverride` after a picker change, so the
 * synchronous `getProjectColor` lookups scattered across the UI (tabs,
 * welcome cards, pickers) always see the latest override without a fetch.
 * @type {Map<string, string>}
 */
const CUSTOM_COLORS = new Map();

/** Normalize a path the same way for hashing and override lookups. */
function normalizePath(path) {
    if (!path) return '';
    return String(path).replace(/\/+$/, '');
}

/**
 * Load the custom-color overrides map from the server. Call once at app
 * init (and after any change if desired). Failures are non-fatal — the UI
 * simply falls back to deterministic hash colors.
 * @param {Record<string,string>} colors - path → hex map from the API
 */
export function applyProjectColors(colors) {
    CUSTOM_COLORS.clear();
    if (colors && typeof colors === 'object') {
        for (const [path, color] of Object.entries(colors)) {
            const key = normalizePath(path);
            if (key && color) CUSTOM_COLORS.set(key, color);
        }
    }
}

/**
 * Set or clear a single project's override in the in-memory map.
 * @param {string} path - project path
 * @param {string|null} color - hex color, or null/'' to clear
 */
export function setProjectColorOverride(path, color) {
    const key = normalizePath(path);
    if (!key) return;
    if (color) CUSTOM_COLORS.set(key, color);
    else CUSTOM_COLORS.delete(key);
}

/** True when the project has a user-assigned color (vs. the hash default). */
export function hasCustomProjectColor(path) {
    return CUSTOM_COLORS.has(normalizePath(path));
}

/**
 * Accent color for a project path — custom override if the user set one,
 * otherwise the deterministic hash color.
 * @param {string|null|undefined} path - project path (session cwd)
 * @returns {string|null} hex color, or null when path is empty
 */
export function getProjectColor(path) {
    const normalized = normalizePath(path);
    if (!normalized) return null;
    const custom = CUSTOM_COLORS.get(normalized);
    if (custom) return custom;
    return PROJECT_PALETTE[hashString(normalized) % PROJECT_PALETTE.length];
}

/**
 * Fetch the custom-color overrides from the server and apply them.
 * Call once early in app init; safe to call again to refresh. Non-fatal on
 * error — the UI falls back to deterministic hash colors.
 * @returns {Promise<void>}
 */
export async function loadProjectColors() {
    try {
        const res = await fetch('/api/project/colors', { credentials: 'same-origin' });
        if (!res.ok) return;
        const data = await res.json();
        applyProjectColors(data.colors || {});
    } catch (e) {
        // Colors are cosmetic — never block the app on this.
    }
}

/**
 * Persist a project's custom color to the server, then update the in-memory
 * override so subsequent renders pick it up immediately.
 * @param {string} path - project path
 * @param {string|null} color - hex color, or null/'' to clear (revert to hash)
 * @returns {Promise<string|null>} the stored color, or null when cleared
 */
export async function saveProjectColor(path, color) {
    const res = await fetch(
        `/api/project/color?cwd=${encodeURIComponent(path)}`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ color: color || '' }),
        }
    );
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || 'Failed to save project color');
    }
    const data = await res.json();
    setProjectColorOverride(path, data.color);
    return data.color;
}

/**
 * Inline style attribute exposing `--project-color` to CSS.
 * Returns '' for empty paths so templates can interpolate unconditionally:
 *   `<div class="card"${projectColorStyle(session.project_path)}>`
 * Palette colors are hex literals — nothing to escape.
 */
export function projectColorStyle(path) {
    const color = getProjectColor(path);
    return color ? ` style="--project-color: ${color}"` : '';
}
