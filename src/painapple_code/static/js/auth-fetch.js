/**
 * Wrap window.fetch to redirect to /login on a 401 from /api/*.
 *
 * Without this, a stale tab whose cookie was cleared (logout from another
 * tab, expired Max-Age, separate iPadOS PWA/Safari cookie jars) keeps
 * polling forever and floods the server log with 401s.
 *
 * Skips /api/login and /api/logout so a wrong-password response on the
 * login form doesn't loop. No-op while already on /login.
 */

let redirected = false;

const originalFetch = window.fetch.bind(window);

function getRequestPath(input) {
    try {
        const raw = typeof input === 'string' ? input
            : input instanceof Request ? input.url
            : input instanceof URL ? input.href
            : String(input);
        return new URL(raw, window.location.origin).pathname;
    } catch {
        return null;
    }
}

function shouldRedirect(path, status) {
    if (status !== 401) return false;
    if (redirected) return false;
    if (window.location.pathname === '/login') return false;
    if (!path || !path.startsWith('/api/')) return false;
    if (path === '/api/login' || path === '/api/logout') return false;
    return true;
}

window.fetch = async function authAwareFetch(...args) {
    const response = await originalFetch(...args);
    const path = getRequestPath(args[0]);
    if (shouldRedirect(path, response.status)) {
        redirected = true;
        const next = encodeURIComponent(window.location.pathname + window.location.search);
        window.location.replace(`/login?next=${next}`);
    }
    return response;
};
