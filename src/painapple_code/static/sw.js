/**
 * Service Worker for pAInapple Code PWA
 *
 * Caching strategy:
 * - Precache: App shell (HTML, critical CSS/JS)
 * - Cache-first: Static assets (icons, fonts)
 * - Network-first: HTML pages (for fresh content)
 * - Network-only: API calls, WebSocket
 */

// Version is injected by server based on file mtimes (no manual bumping needed).
// Prefix bumped to `auth` to force full cache eviction on the auth rollout.
const CACHE_NAME = 'claude-code-auth-v__CACHE_VERSION__';
const STATIC_CACHE = 'claude-code-auth-static-v__CACHE_VERSION__';

// Assets to precache (app shell).
//
// The versioned entries must carry the SAME ?v= the page requests them with,
// for two reasons: an unversioned URL is served `no-store`, so precaching one
// downloaded a second, uncacheable copy of each module on every load; and
// `caches.match()` keys on the full URL, so a bare entry never matched the
// page's versioned request and the precache did nothing for JS/CSS.
// Injected by the server: already version-stamped, and listing the single
// bundle instead of the loose modules when this install ships one.
const PRECACHE_ASSETS = __PRECACHE_ASSETS__;

// Install event - precache assets
self.addEventListener('install', (event) => {
  console.log('[SW] Installing service worker...');

  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('[SW] Precaching app shell');
        return cache.addAll(PRECACHE_ASSETS);
      })
      .then(() => {
        console.log('[SW] Precaching complete');
        return self.skipWaiting();
      })
      .catch((err) => {
        console.error('[SW] Precaching failed:', err);
      })
  );
});

// Activate event - clean old caches
self.addEventListener('activate', (event) => {
  console.log('[SW] Activating service worker...');

  event.waitUntil(
    caches.keys()
      .then((cacheNames) => {
        return Promise.all(
          cacheNames
            .filter((name) => name !== CACHE_NAME && name !== STATIC_CACHE)
            .map((name) => {
              console.log('[SW] Deleting old cache:', name);
              return caches.delete(name);
            })
        );
      })
      .then(() => {
        console.log('[SW] Claiming clients');
        return self.clients.claim();
      })
  );
});

// Fetch event - serve from cache or network
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Skip non-GET requests
  if (event.request.method !== 'GET') {
    return;
  }

  // Skip WebSocket requests
  if (url.protocol === 'ws:' || url.protocol === 'wss:') {
    return;
  }

  // Skip API requests (always go to network)
  if (url.pathname.startsWith('/api/') || url.pathname === '/chat') {
    return;
  }

  // Skip chrome-extension and other non-http(s) requests
  if (!url.protocol.startsWith('http')) {
    return;
  }

  // Skip cross-origin — browser HTTP cache handles third-party CDNs natively.
  // Intercepting cross-origin module imports has historically caused Safari
  // to mis-cache or reject responses, surfacing as a fake 503 from our
  // catch handler and a `TypeError: Importing a module script failed`.
  // (All third-party libs are now vendored under /static/vendor/, so the app
  // itself no longer loads anything cross-origin; this guard stays defensive.)
  if (url.origin !== self.location.origin) {
    return;
  }

  // For JS/CSS files - network first (server adds cache-bust params)
  if (url.pathname.match(/\/static\/.*\.(js|css)$/)) {
    event.respondWith(networkFirst(event.request));
    return;
  }

  // For other static assets (icons, images) - cache first
  if (url.pathname.startsWith('/static/')) {
    event.respondWith(cacheFirst(event.request));
    return;
  }

  // For HTML pages - network first with cache fallback
  if (event.request.headers.get('accept')?.includes('text/html') ||
      url.pathname === '/app' ||
      url.pathname === '/test' ||
      url.pathname === '/') {
    event.respondWith(networkFirst(event.request));
    return;
  }

  // Default - network first
  event.respondWith(networkFirst(event.request));
});

/**
 * Cache-first strategy
 * Try cache, fall back to network (and update cache)
 */
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) {
    // Return cached version and update cache in background
    updateCache(request);
    return cached;
  }

  try {
    const response = await fetch(request);
    // Only cache 2xx and not redirects — redirect responses follow to the
    // auth login page, which we don't want pinned to the requested URL.
    if (response.ok && !response.redirected) {
      const cache = await caches.open(STATIC_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    console.error('[SW] Cache-first fetch failed:', err);
    return new Response('Offline', { status: 503 });
  }
}

/**
 * Network-first strategy
 * Try network, fall back to cache
 */
async function networkFirst(request) {
  try {
    const response = await fetch(request);
    // Only cache 2xx and not redirects — an auth-redirected response would
    // otherwise pin the login page under the original URL.
    if (response.ok && !response.redirected) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    console.log('[SW] Network failed, trying cache:', request.url);
    const cached = await caches.match(request);
    if (cached) {
      return cached;
    }

    // Return offline page for HTML requests
    if (request.headers.get('accept')?.includes('text/html')) {
      return caches.match('/app') || new Response(offlineHTML(), {
        headers: { 'Content-Type': 'text/html' }
      });
    }

    // For everything else (JS modules, CSS, JSON, etc.), surface a real network
    // error rather than a synthetic 503 — a fake 503 with a text body makes
    // module imports fail with the misleading "Importing a module script failed".
    return Response.error();
  }
}

/**
 * Update cache in background
 */
async function updateCache(request) {
  try {
    const response = await fetch(request);
    if (response.ok && !response.redirected) {
      const cache = await caches.open(STATIC_CACHE);
      await cache.put(request, response);
    }
  } catch (err) {
    // Ignore - just a background update
  }
}

/**
 * Offline HTML fallback
 */
function offlineHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>pAInapple Code - Offline</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #1a1a2e;
      color: #e0e0e0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .offline-container {
      text-align: center;
      max-width: 400px;
    }
    .offline-icon {
      font-size: 64px;
      margin-bottom: 20px;
    }
    h1 { font-size: 24px; margin-bottom: 12px; }
    p { color: #a0a0a0; margin-bottom: 20px; line-height: 1.5; }
    button {
      background: #4a9eff;
      color: white;
      border: none;
      padding: 12px 24px;
      border-radius: 8px;
      font-size: 16px;
      cursor: pointer;
    }
    button:hover { background: #3a8eef; }
  </style>
</head>
<body>
  <div class="offline-container">
    <div class="offline-icon">📡</div>
    <h1>You're Offline</h1>
    <p>pAInapple Code requires an internet connection to communicate with the server.</p>
    <button onclick="location.reload()">Try Again</button>
  </div>
</body>
</html>`;
}

// Handle messages from clients
self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') {
    self.skipWaiting();
  }

  if (event.data === 'clearCache') {
    caches.keys().then((names) => {
      names.forEach((name) => caches.delete(name));
    });
  }
});
