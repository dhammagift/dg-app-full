// Service worker for the offline script-conversion engine (Aksharamukha + Pyodide) — see
// script-engine.js's own header for the full picture. Registered with default scope "/" (its own
// directory), so it technically controls the whole app, but its fetch handler only ever answers
// requests under VIRTUAL_PREFIX and explicitly ignores everything else (no respondWith() call at
// all), so the browser's normal fetch path runs exactly as if this worker didn't exist for those.
//
// This is the reason a service worker is used here at all, rather than just patching
// self.fetch/window.fetch the way app.js already does for its own routes: a dynamic import()
// (needed for pyodide.mjs and aksharamukha's own index.js, both ES modules) does not consult a
// JS-level fetch patch, but it DOES fire a service worker's 'fetch' event like any other
// subresource load — this is the one thing that reliably intercepts it offline.
//
// dg-node's OWN service worker registration is deliberately dropped from this app (see
// build-page.js) because it tries to cache/serve the whole site, which would fight app.js's own
// interception of /search, /api/text etc. This worker avoids that entirely by only ever touching
// one unrelated path prefix nothing else uses.
const VIRTUAL_PREFIX = '/__aksharamukha_engine__/';
const CACHE_NAME = 'dg-script-engine-v1';

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    if (!url.pathname.startsWith(VIRTUAL_PREFIX)) return; // untouched — browser handles it normally
    event.respondWith(
        caches.open(CACHE_NAME)
            .then((cache) => cache.match(event.request))
            .then((res) => res || new Response('not cached: ' + url.pathname, { status: 404 }))
    );
});

// No previous version of this worker to finish serving requests for — skip the usual wait so a
// reader who just consented to the ~16MB download doesn't also have to reload the app once more
// before this worker actually controls the page.
self.addEventListener('install', (event) => { event.waitUntil(self.skipWaiting()); });
self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()); });
