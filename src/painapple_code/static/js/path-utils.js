/**
 * Server-flavored path helpers.
 *
 * Every path the client manipulates belongs to the SERVER's filesystem,
 * not the browser's — an iPad can be driving a Windows server — so the
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

/**
 * Which separators the flavor ACCEPTS — a different question from which one
 * `pathSep` emits, and the one this module used to get wrong. Windows treats
 * '\' and '/' interchangeably, but on POSIX a backslash is an ordinary
 * filename character: splitting on it truncates a real file called
 * `notes\2024-Q1.md` down to `2024-Q1.md`.
 */
function splitRe(sample) { return isWindowsPaths(sample) ? /[\\/]+/ : /\/+/; }
function trailSepRe(sample) { return isWindowsPaths(sample) ? /[\\/]+$/ : /\/+$/; }
function leadSepRe(sample) { return isWindowsPaths(sample) ? /^[\\/]+/ : /^\/+/; }

/** Windows flavor for a pair of paths — either one can carry the tell (a
 *  drive letter or UNC prefix), and a declared path_style outranks both. */
function winPair(a, b) { return isWindowsPaths(a || '') || isWindowsPaths(b || ''); }

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
    if (isWindowsPaths(p)) {
        const unc = p.match(UNC);
        if (unc) return unc[0] + '\\';
        if (WIN_ABS.test(p)) return p.slice(0, 2) + '\\';
    }
    if (p.startsWith('/')) return '/';
    return '';
}

/**
 * Split into components, dropping empties. `sample` exists for callers that
 * hand us a rootless fragment — the drive letter that makes a path
 * recognizably Windows has already been sliced off, so the fragment alone
 * would sniff as POSIX.
 */
export function splitPath(p, sample = p) {
    return (p || '').split(splitRe(sample)).filter(Boolean);
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
    for (const part of splitPath(root ? startFrom.slice(root.length) : startFrom, startFrom)) {
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
    const parts = splitPath(root ? p.slice(root.length) : p, p);
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
    return dir.replace(trailSepRe(dir), '') + sep + child;
}

/** Trailing separators removed, but never past the root. */
export function stripTrailingSep(p) {
    if (!p) return p;
    const root = pathRoot(p);
    const trimmed = p.replace(trailSepRe(p), '');
    return trimmed.length >= root.length && trimmed ? trimmed : (root || p);
}

/**
 * `path` expressed relative to `base`, or `path` unchanged when it isn't
 * under `base`. Replaces the `p.startsWith(cwd + '/') ? p.slice(cwd.length + 1) : p`
 * idiom, which on Windows never matched — so shadow-git/history endpoints
 * that require a repo-relative pathspec were handed absolute paths and
 * silently returned nothing.
 *
 * Emits forward slashes on Windows: the consumers are git pathspecs and API
 * keys, which are '/' on every platform. On POSIX the backslashes that
 * survive are part of the filename, so they're left alone.
 */
export function relativeTo(path, base) {
    if (!path || !base) return path;
    if (!isUnder(path, base)) return path;
    const win = winPair(path, base);
    // stripTrailingSep is what isUnder compared against — including when
    // base IS the root, where it stops at '/' or 'C:\' rather than emptying
    // out. Slicing by any other length eats a real character.
    const rest = path.slice(stripTrailingSep(base).length);
    const trimmed = rest.replace(leadSepRe(base), '');
    return win ? trimmed.replace(/\\/g, '/') : trimmed;
}

/** Directory part of a path — '' when there's no separator. */
export function dirname(p) {
    const parent = parentOf(p);
    return parent === null ? '' : parent;
}

/**
 * Is `child` inside `dir` (or equal to it)?
 *
 * On Windows this is case- and separator-insensitive, because the same file
 * is reachable as `C:/Users/me/proj` or `C:\Users\me\proj` and the two sides
 * often come from different places (the server reports one, a link the other).
 * On POSIX neither folding applies — case matters and '\' is a filename
 * character. Normalization is 1:1 in length apart from the trailing strip,
 * so `relativeTo` can slice by `stripTrailingSep(dir).length`.
 */
export function isUnder(child, dir) {
    if (!child || !dir) return false;
    const win = winPair(child, dir);
    const sep = win ? '\\' : '/';
    const norm = (s) => (win ? s.toLowerCase().replace(/\//g, '\\') : s).replace(win ? /\\+$/ : /\/+$/, '');
    const c = norm(child);
    const d = norm(dir);
    if (c === d) return true;
    return c.startsWith(d) && c.charAt(d.length) === sep;
}
