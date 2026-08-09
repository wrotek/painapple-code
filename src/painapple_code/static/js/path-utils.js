/**
 * Server-flavored path helpers.
 *
 * Every path the client manipulates belongs to the SERVER's filesystem,
 * not the browser's — an iPad can be driving a Windows bridge — so the
 * flavor comes from what the server reports (INSTANCE_CONFIG.path_style),
 * never from navigator.platform.
 *
 * Before this module the resolver was POSIX-only: `startsWith('/')` meant
 * "absolute" and joins were `'/' + parts.join('/')`, so a Windows cwd came
 * back as `/C:/Users/me/proj` — a drive letter demoted to a path segment,
 * which then 404s every listing.
 */

const WIN_ABS = /^[A-Za-z]:[\\/]/;
const UNC = /^\\\\[^\\/]+[\\/][^\\/]+/;

/** Windows path semantics? Falls back to sniffing a known server path so a
 *  cached page that predates the config flag still behaves. */
export function isWindowsPaths(sampleAbsPath = '') {
    const declared = window.INSTANCE_CONFIG?.path_style;
    if (declared === 'windows') return true;
    if (declared === 'posix') return false;
    return WIN_ABS.test(sampleAbsPath) || UNC.test(sampleAbsPath);
}

export function pathSep(sample = '') {
    return isWindowsPaths(sample) ? '\\' : '/';
}

/** Does this path stand on its own (no cwd needed)? */
export function isAbsolutePath(p, sample = '') {
    if (!p) return false;
    if (isWindowsPaths(sample || p)) return WIN_ABS.test(p) || UNC.test(p);
    return p.startsWith('/');
}

/**
 * The leading part that must survive normalization: '/' on POSIX,
 * 'C:\' or '\\server\share\' on Windows. '' for a relative path.
 */
export function pathRoot(p) {
    if (!p) return '';
    const unc = p.match(UNC);
    if (unc) return unc[0] + '\\';
    if (WIN_ABS.test(p)) return p.slice(0, 2) + '\\';
    if (p.startsWith('/')) return '/';
    return '';
}

/** Split on either separator, dropping empties. */
export function splitPath(p) {
    return (p || '').split(/[\\/]+/).filter(Boolean);
}

/**
 * Resolve `rel` against `base`, collapsing . and .. — the cross-platform
 * replacement for `'/' + combined.split('/').filter(...).join('/')`.
 */
export function resolvePath(base, rel) {
    const startFrom = isAbsolutePath(rel, base) ? rel : `${base || ''}/${rel || ''}`;
    const root = pathRoot(startFrom);
    const sep = isWindowsPaths(startFrom) ? '\\' : '/';
    const out = [];
    for (const part of splitPath(root ? startFrom.slice(root.length) : startFrom)) {
        if (part === '.') continue;
        if (part === '..') out.pop();
        else out.push(part);
    }
    if (!root) return out.join(sep);
    // root already ends with a separator; don't double it
    return root + out.join(sep);
}

/** Last component, either separator. */
export function basename(p) {
    const parts = splitPath(p);
    return parts.length ? parts[parts.length - 1] : '';
}

/** Containing directory, or null at the root. */
export function parentOf(p) {
    if (!p) return null;
    const root = pathRoot(p);
    const parts = splitPath(root ? p.slice(root.length) : p);
    if (!parts.length) return null;           // already at the root
    parts.pop();
    const sep = isWindowsPaths(p) ? '\\' : '/';
    if (root) return parts.length ? root + parts.join(sep) : root;
    return parts.join(sep) || null;
}

/** Join a directory and a child name with the server's separator. */
export function joinPath(dir, child) {
    if (!dir) return child || '';
    if (!child) return dir;
    const sep = isWindowsPaths(dir) ? '\\' : '/';
    return dir.replace(/[\\/]+$/, '') + sep + child;
}

/** Trailing separators removed, but never past the root. */
export function stripTrailingSep(p) {
    if (!p) return p;
    const root = pathRoot(p);
    const trimmed = p.replace(/[\\/]+$/, '');
    return trimmed.length >= root.length && trimmed ? trimmed : (root || p);
}

/** Is `child` inside `dir` (or equal to it)? Separator-insensitive. */
export function isUnder(child, dir) {
    if (!child || !dir) return false;
    const norm = (s) => (isWindowsPaths(s) ? s.toLowerCase() : s).replace(/[\\/]+$/, '');
    const c = norm(child);
    const d = norm(dir);
    if (c === d) return true;
    return c.startsWith(d) && /[\\/]/.test(c.charAt(d.length));
}
