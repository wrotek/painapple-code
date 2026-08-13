/**
 * Pre-app boot script — classic (non-module) so it runs synchronously in
 * <head>, before the deferred module graph and before first paint.
 *
 * This file exists because of CSP: `script-src` no longer allows
 * 'unsafe-inline', so the three things that used to be inline <script>
 * blocks in web-client.html live here instead. Keep it dependency-free and
 * small — it is the only render-blocking script the app ships.
 */
(function () {
    'use strict';

    // 1. Instance config.
    //
    // The server writes its JSON into a <script type="application/json">
    // data block. A non-JS `type` means the browser never executes the
    // element, so CSP's script-src does not gate it — which is exactly why
    // the config can stay in the document without re-opening 'unsafe-inline'.
    // Consumers still read `window.INSTANCE_CONFIG`, unchanged.
    try {
        var el = document.getElementById('instance-config');
        var raw = el && el.textContent && el.textContent.trim();
        if (raw) {
            var cfg = JSON.parse(raw);
            if (cfg && typeof cfg === 'object') window.INSTANCE_CONFIG = cfg;
        }
    } catch (e) { /* malformed config — the app's ?. reads all tolerate absence */ }

    // 2. Layout density before first paint — the config module that owns
    //    applyLayout() loads much later, which flashes normal-density UI for
    //    compact/spacious users. Normal is the :root default.
    try {
        var userCfg = JSON.parse(localStorage.getItem('claude-code-user-config') || '{}');
        if (userCfg.layout === 'compact' || userCfg.layout === 'spacious') {
            document.documentElement.dataset.layout = userCfg.layout;
        }
    } catch (e) { /* corrupt config — keep normal */ }

    // 3. Service worker registration. Deferred to the load event, so running
    //    from <head> rather than the end of <body> changes nothing.
    if ('serviceWorker' in navigator) {
        window.addEventListener('load', function () {
            navigator.serviceWorker.register('/sw.js', { scope: '/' })
                .then(function (registration) {
                    console.log('SW registered:', registration.scope);

                    // Check for updates
                    registration.addEventListener('updatefound', function () {
                        var newWorker = registration.installing;
                        newWorker.addEventListener('statechange', function () {
                            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                                // New version available - auto-apply it
                                console.log('New version available - activating...');
                                newWorker.postMessage('skipWaiting');
                            }
                        });
                    });

                    // Reload when new SW takes control (ensures fresh code)
                    var refreshing = false;
                    navigator.serviceWorker.addEventListener('controllerchange', function () {
                        if (refreshing) return;
                        refreshing = true;
                        console.log('New SW controlling page - reloading...');
                        window.location.reload();
                    });
                })
                .catch(function (err) {
                    console.error('SW registration failed:', err);
                });
        });
    }
})();
