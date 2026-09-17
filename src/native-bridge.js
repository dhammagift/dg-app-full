// Bridges "leave the app" links to the device's real browser via @capacitor/browser (Chrome
// Custom Tabs on Android) instead of the app's own WebView. Two reasons this can't just be a
// plain navigation/window.open like on the real site:
//
// 1. Capacitor's WebView only navigates within its own local origin (https://localhost on Android,
//    capacitor://localhost on iOS — this app's static asset server) by default — a plain `location.href`/`<a href>` to an external
//    https:// URL is silently swallowed (no server.allowNavigation configured, and adding one
//    would still leave the user "trapped" in the app's WebView with no obvious way back).
// 2. /login specifically is Firebase/Google auth — Google actively rejects OAuth sign-in
//    attempted inside an embedded WebView ("disallowed_useragent"), it must run in a real browser
//    context. Custom Tabs count as a real browser to Google; this app's WebView does not.
//
// Loaded on both index.html and settings/index.html (the only two pages this app has with links
// of this kind) — NOT part of app.js, which is the data-shim only (see its own header comment)
// and isn't loaded on the settings page at all.
(function () {
    // ---------------------------------------------------------------------------------------
    // Error reports to the site (dg-node POST /api/app-log)
    // ---------------------------------------------------------------------------------------

    // What broke on a reader's phone, seen without adb. Here rather than in platform.js because
    // this file is on every bundled page (/assets/lbl.html, Settings, ...), platform.js only on
    // the home page. Nothing waits on it: reports collect in memory, repeats are dropped, one
    // sendBeacon carries the batch a few seconds later or when the app is hidden, and reports made
    // offline stay in localStorage until the next flush.
    (function installErrorReports() {
        var KEY = 'dg.app.errorQueue';
        var ENDPOINT = (window.DG_ONLINE_ORIGIN || 'https://dhamma.gift') + '/api/app-log';
        var seen = {};
        var seenCount = 0;
        var queue = [];
        var version = '';
        var timer = null;
        try { queue = JSON.parse(localStorage.getItem(KEY) || '[]'); } catch (e) { queue = []; }
        function save() {
            try { localStorage.setItem(KEY, JSON.stringify(queue.slice(-50))); } catch (e) { /* storage blocked or full */ }
        }
        function flush() {
            timer = null;
            // Empty: leave storage alone — another page of the app may have queued reports there.
            if (!queue.length) return;
            if (navigator.onLine === false || !navigator.sendBeacon) return save();
            var batch = queue.splice(0, 50);
            // Stamped at send time: an error during startup is queued before app-version.json is read.
            batch.forEach(function (r) { if (!r.app) r.app = version; });
            var sent = navigator.sendBeacon(ENDPOINT, new Blob([JSON.stringify(batch)], { type: 'text/plain' }));
            if (!sent) queue = batch.concat(queue);
            save();
        }
        function report(kind, msg, where) {
            msg = String(msg || '').slice(0, 800);
            var key = kind + '|' + msg;
            if (seen[key] || seenCount >= 30) return; // one page load never sends more than 30 distinct reports
            seen[key] = true;
            seenCount++;
            queue.push({ kind: kind, msg: msg, where: where || '', page: location.pathname + location.search,
                app: version, ua: navigator.userAgent, t: Date.now() });
            if (!timer) timer = setTimeout(flush, 5000);
        }
        fetch('/app-version.json').then(function (r) { return r.json(); })
            .then(function (v) { version = v.version + ' (' + v.build + ')'; }, function () {});
        window.addEventListener('error', function (e) {
            var el = e.target;
            if (el && el !== window && (el.src || el.href)) return report('resource', el.src || el.href); // a <script>/<link>/<img> that failed
            report('error', e.message, (e.filename || '') + ':' + (e.lineno || 0) + ':' + (e.colno || 0));
        }, true);
        window.addEventListener('unhandledrejection', function (e) {
            var r = e.reason;
            report('rejection', (r && (r.stack || r.message)) || r);
        });
        var consoleError = console.error;
        console.error = function () {
            try {
                report('console', Array.prototype.map.call(arguments, function (a) {
                    if (a && a.stack) return a.stack;
                    try { return typeof a === 'object' ? JSON.stringify(a) : String(a); } catch (e) { return String(a); }
                }).join(' '));
            } catch (e) { /* never let reporting break logging */ }
            return consoleError.apply(console, arguments);
        };
        document.addEventListener('visibilitychange', function () {
            if (document.visibilityState === 'hidden') flush();
        });
        if (queue.length) timer = setTimeout(flush, 5000);
    })();

    // ---------------------------------------------------------------------------------------
    // PDF export (the reader footer's PDF icon)
    // ---------------------------------------------------------------------------------------

    // pdfmake's download() is a blob download, and Android's WebView drops those silently: the icon
    // did nothing (tablet test). In the app the file goes to the cache directory and the system share
    // sheet opens with it — "save to Files", Drive, a messenger, a PDF viewer. pdfmake is loaded on
    // demand (settings.js), so its global is patched the moment the library assigns it.
    // Site configs (/config/sync-config.json — Firebase for cloud sync, /config/tts-config.json — Google
    // voices) are read from the site, not bundled: owner wants a changed key to reach the app without
    // an app release. Both features need the network anyway. The literal default, not ONLINE_ORIGIN:
    // that var is declared further down and is still undefined here.
    (function siteConfigsFromSite() {
        var origin = window.DG_ONLINE_ORIGIN || 'https://dhamma.gift';
        var pageFetch = window.fetch;
        window.fetch = function (input, init) {
            var raw = typeof input === 'string' ? input : (input && input.url) || '';
            try {
                var u = new URL(raw, location.href);
                if (u.origin === location.origin && /^\/config\/[\w.-]+\.json$/.test(u.pathname)) {
                    return pageFetch.call(window, origin + u.pathname + u.search, init);
                }
                // The dictionary data is not bundled (dictionaryFromSite below): ai-search.js fetches it as
                // text, so the same cached-or-site copy answers here.
                if (u.origin === location.origin && u.pathname.indexOf('/assets/js/standalone-dpd/') === 0 &&
                    typeof window.dgDictScript === 'function') {
                    return window.dgDictScript(u.pathname).then(function (text) {
                        return new Response(text, { status: 200, headers: { 'Content-Type': 'application/javascript' } });
                    });
                }
                // Google voices with the site's trial key: Google only accepts it from dhamma.gift pages,
                // so the call goes through the site (dg-fastify /api/tts/*), which adds the key. A reader's
                // own key still goes straight to Google. text/plain keeps the POST a simple CORS request.
                if (u.host === 'texttospeech.googleapis.com' && window.TRIAL_KEY && u.searchParams.get('key') === window.TRIAL_KEY) {
                    if (u.pathname === '/v1/voices') {
                        u.searchParams.delete('key');
                        return pageFetch.call(window, origin + '/api/tts/voices' + u.search);
                    }
                    if (u.pathname === '/v1/text:synthesize') {
                        return pageFetch.call(window, origin + '/api/tts/synthesize', {
                            method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: init && init.body,
                        });
                    }
                }
            } catch (e) { /* not a URL: leave it to the page's fetch */ }
            return pageFetch.apply(window, arguments);
        };
    })();

    // The lookup popup's Pali dictionary (DPD: dpd_i2h, dpd_deconstructor, dpd_ebts, ru/dpd_ebts, ~24MB) is not
    // in the APK: it is updated regularly, so it comes from the site like the library (owner). It lives in the
    // Cache API for offline use; with a network the first use per launch revalidates it (ETag — a 304 costs
    // nothing) and a changed file replaces the cached copy. paliLookup.js asks through window.dgDictScript.
    (function dictionaryFromSite() {
        if (!window.caches) return;
        var origin = window.DG_ONLINE_ORIGIN || 'https://dhamma.gift';
        var CACHE = 'dg-dict';
        var FILES = ['/assets/js/standalone-dpd/dpd_i2h.js', '/assets/js/standalone-dpd/dpd_deconstructor.js',
                     '/assets/js/standalone-dpd/dpd_ebts.js', '/assets/js/standalone-dpd/ru/dpd_ebts.js'];
        var checked = {};

        // Resolves to the newest Response available: the site's when it changed, else the cached one.
        function fromSite(cache, src, cached) {
            if (checked[src] || navigator.onLine === false) return Promise.resolve(cached);
            checked[src] = true;
            return fetch(origin + src, { cache: 'no-cache' }).then(function (res) {
                if (!res.ok) return cached;
                var etag = res.headers.get('etag');
                if (cached && etag && cached.headers.get('etag') === etag) return cached;
                return cache.put(src, res.clone()).then(function () { return res; });
            }).catch(function () { checked[src] = false; return cached; });
        }

        window.dgDictScript = function (src) {
            return caches.open(CACHE).then(function (cache) {
                return cache.match(src).then(function (hit) {
                    if (hit) {
                        fromSite(cache, src, hit.clone()); // refresh in the background; this tap uses the cached copy
                        return hit.text();
                    }
                    return fromSite(cache, src, null).then(function (res) {
                        if (!res) throw new Error('dictionary is not downloaded yet and there is no network: ' + src);
                        return res.text();
                    });
                });
            });
        };

        // The dictionary travels with the offline library (owner: not "library ready, now tap a word"): it is
        // fetched alongside the library's download as soon as that starts, and at every launch where the
        // library is already installed — which is also the moment a changed dictionary on the site is picked
        // up. Once per launch; files already current cost a revalidation each.
        var prepared = false;
        function prepare() {
            if (prepared) return;
            prepared = true;
            caches.open(CACHE).then(function (cache) {
                return FILES.reduce(function (chain, src) {
                    return chain.then(function () {
                        return cache.match(src).then(function (hit) { return fromSite(cache, src, hit || null); });
                    });
                }, Promise.resolve());
            }).catch(function (e) { prepared = false; console.warn('[dg-dict] could not cache the dictionary:', e && e.message); });
        }
        window.addEventListener('dg:dl-progress', prepare); // the library's download has started
        if (window.dgOfflineLibrary && typeof window.dgOfflineLibrary.then === 'function') {
            window.dgOfflineLibrary.then(function (state) {
                if (state && state.local) setTimeout(prepare, 3000); // after the page itself has settled
            }, function () { /* no library: the dictionary still loads on first use */ });
        }
    })();

    (function sharePdfDownloads() {
        var Plugins = window.Capacitor && window.Capacitor.Plugins;
        if (!Plugins || !Plugins.Filesystem || !Plugins.Share) return;
        function patch(pm) {
            if (!pm || typeof pm.createPdf !== 'function' || pm.__dgShared) return pm;
            var create = pm.createPdf;
            pm.createPdf = function () {
                var doc = create.apply(pm, arguments);
                doc.download = function (name) {
                    var file = String(name || 'document.pdf').replace(/[\\/:*?"<>|]+/g, '_');
                    doc.getBase64(function (data) {
                        Plugins.Filesystem.writeFile({ path: file, data: data, directory: 'CACHE' })
                            .then(function (written) { return Plugins.Share.share({ title: file, files: [written.uri] }); })
                            .catch(function (e) {
                                var msg = (e && e.message) || String(e);
                                if (!/cancel/i.test(msg)) console.error('[dg-pdf] could not share the PDF:', msg);
                            });
                    });
                };
                return doc;
            };
            pm.__dgShared = true;
            return pm;
        }
        var current = patch(window.pdfMake);
        try {
            Object.defineProperty(window, 'pdfMake', {
                configurable: true,
                get: function () { return current; },
                set: function (v) { current = patch(v); },
            });
        } catch (e) { /* a non-configurable global: leave pdfmake as it is */ }
    })();

    // ---------------------------------------------------------------------------------------
    // Native route handoff: App Shortcuts and dhamma.gift deep links
    // ---------------------------------------------------------------------------------------

    // MainActivity cannot loadUrl() a deep path: Capacitor's asset server has no file behind
    // /toc/pli-tv-bu-pm (only index.html at the root — the same reason a raw reload of a
    // pushState'd URL 404s). It passes the real target as ?_nativeRoute=... on the root URL
    // instead, and this rewrites the visible location to it BEFORE the page's own bootstrap
    // script reads window.location (that runs on DOMContentLoaded, this runs at parse time).
    // Lives here rather than in dg-node's app.js because it is native-only glue — on the site
    // nothing ever produces this parameter.
    (function rewriteNativeShortcutRoute() {
        var params = new URLSearchParams(location.search);
        var route = params.get('_nativeRoute');
        if (!route) return;
        // Two of the four App Shortcuts (Dictionary, Memo — same set as dg-twa's and the site
        // manifest's) name pages this app does not contain: /dict and /memo are rendered by the
        // server, /login and /docs were never bundled. Rewriting the URL for them would land the
        // reader on the search page (a path Capacitor cannot resolve falls back to index.html), so
        // they go to the real site in the device's own browser — the same treatment their links get
        // when tapped inside the page (NOT_BUNDLED_RE below).
        // The literal origin, not ONLINE_ORIGIN: that var is declared further down and would still
        // be undefined here, since this runs at parse time.
        var EXTERNAL_ROUTES = /^\/(ru\/)?(dict|memorize|docs)(\/|$)/; // login is bundled now (below)
        if (EXTERNAL_ROUTES.test(route)) {
            openExternal((window.DG_ONLINE_ORIGIN || 'https://dhamma.gift') + route);
            return;
        }
        // The memorisation app IS bundled now (build-assets.js copies siteroot/memo), and it is a
        // real file: Capacitor cannot resolve the /memo/ directory, so the shortcut points at it.
        // Pages of their own (not SPA routes) are loaded as files. replaceState only renamed the address
        // and left the home page on screen: the Memo shortcut and a dhamma.gift/memo link opened search.
        var page = /^\/(ru\/)?(memo|login)\/?$/.exec(route);
        if (page) {
            location.replace('/' + (page[1] || '') + page[2] + '/index.html');
            return;
        }
        history.replaceState(null, '', route);
    })();

    // ---------------------------------------------------------------------------------------
    // dhammagift:// — the app's own URL scheme (docs/DEEP_LINKS.md)
    // ---------------------------------------------------------------------------------------

    // Two ways one arrives, one mapping for both (src/deep-link.js, loaded before this file):
    //
    //   * Android's MainActivity cannot hand a custom-scheme URL to the page directly (the asset
    //     server has no file behind /mn1), so it loads the root with ?_deepLink=<the url> and this
    //     rewrites the location to what the mapping returns — same trick as _nativeRoute above, and
    //     the same reason it has to happen at parse time, before the SPA's bootstrap reads
    //     window.location. Android's Google-login return does NOT come through here: it travels in
    //     intent extras, which no URL carries (see MainActivity.handleIntent).
    //   * iOS has no such handoff: a custom scheme arrives through the SceneDelegate, and Capacitor's
    //     App plugin turns it into an appUrlOpen event. That covers both a cold launch and a link
    //     tapped while the app is already running, which is why the listener below uses
    //     location.replace() — the app is up and the SPA is already initialised.
    (function followIncomingDeepLink() {
        if (!window.dgDeepLinkToLocalUrl) return;
        var raw = new URLSearchParams(location.search).get('_deepLink');
        if (!raw) return;
        var target = window.dgDeepLinkToLocalUrl(raw);
        // Not ours, or an auth return without its token: leave the page where it is rather than
        // navigating somewhere meaningless.
        if (target) location.replace(target);
    })();

    var HANDLED_KEY = 'dg.deeplink.handled';

    // The offline layer's progress card is driven by dg:dl-progress events, and while
    // DgDownloadPlugin does the transfer (src/platform.js's prepareArchive) those bytes cross on the
    // native side — so the plugin's own events are forwarded in the same shape. Deliberately NOT the
    // plugin's "done": the library is not usable until the worker has imported the file, and that
    // import reports its own progress a moment later.
    (function bridgeNativeDownloadProgress() {
        var Plugins = window.Capacitor && window.Capacitor.Plugins;
        var D = Plugins && Plugins.DgDownload;
        if (!D || typeof D.addListener !== 'function') return;
        D.addListener('progress', function (e) {
            var detail = e || {};
            window.dispatchEvent(new CustomEvent('dg:dl-progress', { detail: {
                phase: 'download',
                loaded: detail.loaded || 0,
                total: detail.total || 0,
                done: false,
            } }));
        });
    })();

    (function followLiveDeepLinks() {
        var CapApp = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
        if (!CapApp || typeof CapApp.addListener !== 'function' || !window.dgDeepLinkToLocalUrl) return;
        CapApp.addListener('appUrlOpen', function (event) {
            // Remembered before anything else: the page the mapping opens is a NEW load, so this is
            // the only place that sees the raw URL, and a test that cannot tell "never arrived" from
            // "arrived and mapped to nothing" is a test nobody can act on.
            try {
                var seen = JSON.parse(localStorage.getItem('dg.deeplink.seen') || '[]');
                seen.push((event && event.url) || '');
                localStorage.setItem('dg.deeplink.seen', JSON.stringify(seen.slice(-10)));
            } catch (e) { /* private mode */ }
            var target = window.dgDeepLinkToLocalUrl(event && event.url);
            if (!target) return;
            // Capacitor retains the event until a listener consumes it, so the page the mapping just
            // opened is handed the SAME url again — navigating again would be a reload loop.
            var stamp = ((event && event.url) || '') + '|' + target;
            try {
                if (sessionStorage.getItem(HANDLED_KEY) === stamp) return;
                sessionStorage.setItem(HANDLED_KEY, stamp);
            } catch (e) { /* private mode: worst case one extra navigation */ }
            location.replace(target);
        });
    })();

    // The reader pushState's clean URLs like /sn22.56. Going Back to one from another document
    // (Log in, Memo) or reloading it makes Capacitor load that path as a file: the dot reads as an
    // extension and the WebView shows ERR_INVALID_RESPONSE. On the way out, park the entry on the
    // root with the same _nativeRoute handoff, which the page rewrites back on load (above).
    window.addEventListener('pagehide', function () {
        var last = location.pathname.split('/').pop();
        if (last.indexOf('.') === -1 || /\.html?$/.test(last)) return;
        history.replaceState(history.state, '', '/?_nativeRoute=' + encodeURIComponent(location.pathname + location.search + location.hash));
    });

    // ---------------------------------------------------------------------------------------
    // Dynamic shortcuts: "recently read" in the launcher's long-press menu
    // ---------------------------------------------------------------------------------------

    // The one capability the web platform does not have (see docs/OFFLINE_PWA_PLAN.md and
    // docs/PWA_SHORTCUTS.md): a web manifest's shortcuts are static and a TWA/PWA cannot reach
    // ShortcutManager at all. Native cannot read localStorage, so the page reads its own history
    // and hands over a ready list — one small bridge (android/.../DgShortcutsPlugin.java).
    // Four: two pinned (Contents, Favorites — owner's order: "toc, fav+history, dyn, dyn") and two
    // that are actually "recently read". Android shows dynamic shortcuts above the static ones and
    // a launcher shows four, so the pinned pair has to live here rather than in the manifest XML —
    // the XML keeps Dictionary and Memo, which is what appears on launchers showing more.
    // (Before, this list was everything the history held: "toc", "bupm", "история", "запись1/2" —
    // bare commands and memo recordings, none of them a text — and the designed shortcuts were
    // pushed out of the menu entirely.)
    var SHORTCUTS_MAX = 2;
    // Settings switch "Recent texts in app shortcuts" (dg-app-full#4). 'off' disables them; any
    // other value (including none) keeps the default, on. Static shortcuts are unaffected.
    var SHORTCUTS_FLAG = 'dgDynamicShortcuts';

    function isRu() {
        return (localStorage.getItem('dhammaLanguage') || localStorage.getItem('siteLanguage') || 'en') === 'ru';
    }

    function readJson(key) {
        try { return JSON.parse(localStorage.getItem(key)) || []; } catch (e) { return []; }
    }

    // Any same-site URL becomes an in-app route (path + query + hash). History entries store a
    // full or relative URL; the app's own origin is https://localhost, so the check is on the
    // real host, not on location.
    function toRoute(url) {
        if (!url) return null;
        try {
            var u = new URL(url, 'https://dhamma.gift/');
            if (!/(^|\.)dhamma\.gift$/.test(u.hostname)) return null;
            return u.pathname + u.search + u.hash;
        } catch (e) { return null; }
    }

    // Is this route a text (or a book inside the navigator), i.e. something worth putting in the
    // launcher? Deliberately strict: a shortcut must reopen something the reader was READING.
    // Excluded, with the owner's own examples: search queries (/?q=…), SPA commands typed into the
    // search box (which land in history as "/toc", "/bupm"), the quick modal (/4as), the memo app
    // (/memo, whose recordings showed up as "запись1") and every static page under /assets.
    function isTextRoute(route) {
        var path = String(route || '').split('?')[0].split('#')[0];
        if (/^\/(assets|memo|memorize|settings|offline)\b/.test(path)) return false;
        if (path === '/' || path === '/4as' || /^\/4as\/\d$/.test(path)) return false;
        // A text id starts with letters and carries digits somewhere: /dn22, /sn56.11,
        // /pli-tv-bu-vb-pj1, /dn22:2.2 — and /toc/<book> for a whole book.
        if (/^\/toc\/[a-z0-9-]+$/i.test(path)) return true;
        return /^\/[a-z][a-z-]*\d/i.test(path);
    }

    function collectRecent() {
        // An empty list is still pushed, and that is what removes the ones already in the launcher.
        if (localStorage.getItem(SHORTCUTS_FLAG) === 'off') return [];
        var items = [];
        var seen = {};
        function push(id, label, route, rank) {
            if (!route || seen[route]) return;
            seen[route] = 1;
            items.push({ id: id, label: String(label || route), route: route, rank: rank });
        }

        // Only "recently read". Contents and Favorites used to be pinned here with ranks 0/1, on the
        // assumption that Android lists dynamic shortcuts above static ones — on the owner's launcher
        // it is the other way round, so the pinned pair ended up below Dictionary/Memo instead of
        // above them. They are static shortcuts now (res/xml/shortcuts.xml, in the owner's order);
        // this list adds at most two texts the reader actually opened, after them.
        readJson('dg_favorites').forEach(function (fav) {
            if (!fav) return;
            var route = (fav.path && fav.search) ? (fav.path + fav.search) : ('/' + (fav.slug || ''));
            if (fav.id && fav.id !== fav.slug && route.indexOf('#') === -1) route += '#' + fav.id;
            if (!isTextRoute(route)) return;
            push('dg-recent-fav-' + items.length, fav.title || fav.slug, route, 10 + items.length);
        });
        // History entries are [displayText, url, timestamp] (settings-bundle.js).
        readJson('localSearchHistory').forEach(function (entry) {
            if (!entry || !entry[1]) return;
            var route = toRoute(entry[1]);
            if (!isTextRoute(route)) return;
            push('dg-recent-' + items.length, entry[0], route, 10 + items.length);
        });
        // Lowest rank first; the pinned two carry 0/1 and everything else starts at 10.
        items.sort(function (a, b) { return (a.rank || 0) - (b.rank || 0); });
        return items.slice(0, SHORTCUTS_MAX);
    }

    function pushDynamicShortcuts() {
        var plugin = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.DgShortcuts;
        if (!plugin || typeof plugin.set !== 'function') return; // plain browser / older build
        // Pushed even when empty ON PURPOSE: that is what clears the junk already on the device.
        // Shortcuts set by an earlier build (bare commands, memo recordings) stay in the launcher
        // until setDynamicShortcuts() replaces the list, so skipping the call when there is nothing
        // new left the owner staring at "toc / bupm / история / запись1" forever.
        var items = collectRecent();
        Promise.resolve(plugin.set({ items: items })).catch(function (e) {
            console.log('[dg-shortcuts] set failed:', (e && e.message) || e);
        });
    }

    var CapAppForShortcuts = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
    if (CapAppForShortcuts) {
        pushDynamicShortcuts();
        // Refreshed when the reader leaves the app: cheap, and by then the session's history is
        // complete — pushing on every navigation would rewrite the launcher menu constantly.
        CapAppForShortcuts.addListener('appStateChange', function (state) {
            if (!state.isActive) pushDynamicShortcuts();
        });
        // Also once shortly after load: the first visit of a session has nothing in history yet,
        // so the appStateChange above would only ever fire with an empty list.
        setTimeout(pushDynamicShortcuts, 4000);
    }

    // ---------------------------------------------------------------------------------------
    // Sharing out: the Web Share API, backed by the native share sheet
    // ---------------------------------------------------------------------------------------

    // A link shared or copied out of the app has to work for whoever receives it. The page's own
    // origin is https://localhost, which exists only inside this app (issue #8: a shared
    // "https://localhost/an3.1:1.1?s=…"). Every way out — the share sheet, the clipboard API and a
    // plain copy — carries the real site's address instead.
    var APP_ORIGIN_RE = new RegExp(location.origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
    function toSiteUrls(text) {
        return typeof text === 'string' ? text.replace(APP_ORIGIN_RE, 'https://dhamma.gift') : text;
    }

    // The WebView's own navigator.share is preferred when it exists (it was unreliable across
    // builds, hence the fallback); either way the shared data is rewritten first. Capacitor's Share
    // plugin goes through the platform's own sheet (Android ACTION_SEND chooser).
    (function installWebShare() {
        var Share = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Share;
        var nativeShare = typeof navigator.share === 'function' ? navigator.share.bind(navigator) : null;
        if (!nativeShare && !(Share && typeof Share.share === 'function')) return;
        try {
            Object.defineProperty(navigator, 'share', {
                configurable: true,
                writable: true,
                value: function (data) {
                    var p = data || {};
                    var out = { title: p.title, text: toSiteUrls(p.text), url: toSiteUrls(p.url) };
                    if (nativeShare) return nativeShare(out);
                    return Share.share({ title: out.title, text: out.text, url: out.url, dialogTitle: out.title })
                        .then(function () { return undefined; });
                },
            });
        } catch (e) {
            console.log('[dg-share] could not install navigator.share:', (e && e.message) || e);
        }
    })();

    (function rewriteCopiedLinks() {
        var cb = navigator.clipboard;
        if (cb && typeof cb.writeText === 'function') {
            var write = cb.writeText.bind(cb);
            try { cb.writeText = function (text) { return write(toSiteUrls(text)); }; } catch (e) { /* read-only */ }
        }
        // copyToClipboard.js falls back to execCommand('copy') on a selection: fixed on the way out.
        document.addEventListener('copy', function (e) {
            var el = document.activeElement;
            var sel = (el && /^(TEXTAREA|INPUT)$/.test(el.tagName) && typeof el.selectionStart === 'number')
                ? el.value.slice(el.selectionStart, el.selectionEnd)
                : String(window.getSelection ? window.getSelection() : '');
            var fixed = toSiteUrls(sel);
            if (!sel || fixed === sel || !e.clipboardData) return;
            e.clipboardData.setData('text/plain', fixed);
            e.preventDefault();
        }, true);
    })();

    // ---------------------------------------------------------------------------------------
    // Download progress in the status bar
    // ---------------------------------------------------------------------------------------

    // Backgrounding the app is exactly when the reader loses the progress card (and when Android
    // is most willing to consider the process idle), so the same numbers the page already has go
    // to an ongoing notification with a real progress bar — DgProgressPlugin.java. Nothing is
    // downloaded here: the transfer still runs in the page's own worker (WorkManager cannot write
    // to OPFS — see docs/OFFLINE_PWA_PLAN.md), this only mirrors dg:dl-progress natively.
    (function bridgeDownloadProgress() {
        var plugin = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.DgProgress;
        if (!plugin || typeof plugin.update !== 'function') return;

        var lastSent = 0;
        var active = false;

        function mb(bytes) { return Math.round((bytes || 0) / 1048576) + ' MB'; }
        function isRu() {
            return (localStorage.getItem('dhammaLanguage') || localStorage.getItem('siteLanguage') || 'en') === 'ru';
        }

        function clear() {
            if (!active) return;
            active = false;
            Promise.resolve(plugin.clear()).catch(function () { /* nothing to clear */ });
        }

        window.addEventListener('dg:dl-progress', function (event) {
            var detail = event.detail || {};
            if (detail.done) { clear(); return; }
            var percent = detail.total ? Math.min(100, Math.round((detail.loaded / detail.total) * 100)) : -1;
            var now = Date.now();
            // The worker posts every ~200ms; that is right for a smooth in-page bar and far too
            // often for the notification manager. ~1/s, plus always the last one (100%).
            if (percent >= 0 && percent < 100 && now - lastSent < 900) return;
            lastSent = now;
            active = true;
            var text;
            if (detail.phase === 'import') {
                text = isRu() ? 'Распаковка и применение…' : 'Unpacking and applying…';
            } else if (percent >= 0) {
                text = isRu()
                    ? 'Загрузка офлайн-библиотеки — ' + percent + '% (' + mb(detail.loaded) + ' из ' + mb(detail.total) + ')'
                    : 'Downloading the offline library — ' + percent + '% (' + mb(detail.loaded) + ' of ' + mb(detail.total) + ')';
            } else {
                text = isRu()
                    ? 'Загрузка офлайн-библиотеки — ' + mb(detail.loaded)
                    : 'Downloading the offline library — ' + mb(detail.loaded);
            }
            Promise.resolve(plugin.update({ title: 'Dhamma.gift', text: text, percent: percent }))
                .catch(function () { /* permission denied — the page's own card still shows it */ });
        });

        // The ways a transfer stops without a `done` event: the reader pressed ×, the copy turned
        // out unusable, the library was deleted, or the download was declined. app.js dispatches
        // all four.
        ['dg:offline-cancelled', 'dg:offline-invalid', 'dg:offline-deleted', 'dg:download-declined']
            .forEach(function (name) { window.addEventListener(name, clear); });

        // Safety net for a page that went away mid-transfer (process killed): a stale
        // "downloading" notification the reader cannot dismiss is worse than none at all.
        setInterval(function () { if (active && Date.now() - lastSent > 180000) clear(); }, 60000);
    })();

    // ---------------------------------------------------------------------------------------
    // "This needs the internet" — warn, and hand the reader to a browser that has it
    // ---------------------------------------------------------------------------------------

    // Reader modes such as ?mode=devanagari transform the script ON THE SERVER, and the app has no
    // server: its origin is https://localhost. The offline shim therefore forwards that request to
    // dhamma.gift, and with no connection it fails — which used to be a toast ("Failed to fetch")
    // and nothing else. Owner's ask: "сможешь его пробрасывать в браузер и предупреждать если кто в
    // оффлайн откроет, что нужен интернет для этого режима?" — so: say which mode needs what, and
    // offer to open the same text in the device's own browser, where the site is online and the
    // conversion works.
    //
    // Once per URL: the reader is looking at one text, and a dialog that reappears on every retry
    // (the reader may hit it for language and script in the same view) would be worse than the
    // original problem.
    // /api/text/<id>?<query> -> <origin>/<id>?<query>. Anything else is passed through unchanged.
    function readerUrlFor(url) {
        try {
            var u = new URL(url);
            var m = u.pathname.match(/^\/api\/text\/(.+)$/);
            if (!m) return url;
            return u.origin + '/' + m[1] + (u.search || '');
        } catch (e) {
            return url;
        }
    }

    (function offerBrowserForOnlineModes() {
        var Dialog = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Dialog;
        var seen = {};
        window.addEventListener('dg:online-only', function (event) {
            var detail = event.detail || {};
            var url = detail.url || '';
            if (!url || seen[url]) return;
            seen[url] = true;
            var ru = (localStorage.getItem('dhammaLanguage') || localStorage.getItem('siteLanguage') || 'en') === 'ru';
            // A data URL is not something a browser can show: /api/text/sn56.11?mode=devanagari
            // would open raw JSON in the reader's face. The reader's own address is derived from it
            // (same query, path = the sutta id), which is the page they actually asked for — and the
            // site applies the mode itself there.
            url = readerUrlFor(url);
            var what = detail.reason === 'script'
                ? (ru ? 'Конвертация системы письма выполняется на сервере'
                      : 'Script conversion is done on the server')
                : (ru ? 'Этот язык не входит в офлайн-библиотеку'
                      : 'This language is not part of the offline library');
            var message = what + '. ' + (ru
                ? 'Нужен интернет. Открыть этот текст в браузере?'
                : 'It needs an internet connection. Open this text in the browser?');
            // No Dialog plugin (plain browser, or an older build): fall back to opening it — the
            // reader asked for a mode that only the site can serve.
            if (!Dialog || typeof Dialog.confirm !== 'function') { openExternal(url); return; }
            Dialog.confirm({
                title: ru ? 'Нужен интернет' : 'Internet required',
                message: message,
                okButtonTitle: ru ? 'Открыть в браузере' : 'Open in browser',
                cancelButtonTitle: ru ? 'Остаться' : 'Stay here',
            }).then(function (res) {
                if (res && res.value) openExternal(url);
            }).catch(function () { /* dismissed */ });
        });
    })();

    // The status-bar strip is the site's own dark navbar band, always (issue #15): it is the
    // window background now (android/app/src/main/res/values/{colors,styles}.xml), so there is
    // nothing for this file to switch — the old per-theme StatusBar calls repainted it white in
    // the light theme and set dark icons on it, both wrong for a band that never changes.

    function openExternal(url) {
        var Browser = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Browser;
        // A Custom Tab only shows web pages. An app link (the lookup popup's dttp://, goldendict://,
        // dpd://, mdict:// dictionaries, mailto:) is an Android intent: a plain navigation hands it
        // to Capacitor, which launches it.
        if (!/^https?:/i.test(url)) { window.location.href = url; return; }
        if (Browser) Browser.open({ url: url });
        else window.location.href = url; // plain-browser fallback (local dev/testing, no Capacitor runtime)
    }

    // memo/login/docs are same-ORIGIN paths (https://localhost/docs/...) but not actually
    // bundled content — a plain origin check alone calls them "not external" and lets
    // window.open() below try to open them locally, 404ing silently in a blank new tab/window.
    // Shared with the click listener further down so both agree on what "not bundled" means.
    // /memo is NOT here any more: it ships inside the app (see copyMemoApp in build-assets.js).
    // /memorize is: that is the legacy PHP reader in memorisation mode, and it cannot run here.
    // read/d/rev/frev/ml, r.php, history.php: the legacy PHP reading modes the menus link to, never bundled.
    // documents (PDFs), legacy.suttacentral.net, th, assets/br and the timers are site-only too.
    // theravada.ru / tipitaka.theravada.su: the site's local mirrors behind the results' "Ru" links (openRu.js).
    var NOT_BUNDLED_RE = /^\/(ru\/)?(dict|memorize|docs|read|d|rev|frev|ml|documents|legacy\.suttacentral\.net|th|theravada\.ru|theravada\.rf|tipitaka\.theravada\.su)(\/|$)|^\/(ru\/)?(r|history)\.php$|^\/(ru\/)?assets\/(br|repeat-timer|pomodoro-timer)(\/|$)/;

    // Where a link has to go outside this WebView, or null when it opens here. /4nt (the edition
    // comparison) is never bundled; its online copy is s.dhamma.gift without the /4nt prefix, the
    // mapping megareader.js and search-render.js already use — the reader's and the results'
    // "Compare" menus keep the local /4nt path on https://localhost and opened nothing.
    function onlineUrlFor(url) {
        try {
            var u = new URL(url, location.href);
            if (u.origin !== location.origin) return /^javascript:/i.test(u.href) ? null : u.href;
            if (/^\/4nt(\/|$)/.test(u.pathname)) return 'https://s.dhamma.gift' + u.pathname.replace(/^\/4nt/, '') + u.search + u.hash;
            if (NOT_BUNDLED_RE.test(u.pathname)) return ONLINE_ORIGIN + u.pathname + u.search + u.hash;
            // Old help pages the site redirects to the docs (list baked in by build-assets.js).
            if ((window.DG_SITE_ONLY_PATHS || []).indexOf(u.pathname) !== -1) return ONLINE_ORIGIN + u.pathname + u.search + u.hash;
        } catch (e) { /* not a URL */ }
        return null;
    }

    function isExternal(url) {
        return onlineUrlFor(url) !== null;
    }
    // Reachable from a test: whether a link leaves this WebView (the browser, or the site) is the
    // app's own decision — NOT_BUNDLED_RE plus the baked site-only list — and a link checker that
    // re-implements it would either duplicate the rule or, worse, call a correctly-routed link
    // broken (its first version reported /r.php, which this predicate sends to the site on purpose).
    window.dgIsExternalUrl = isExternal;

    // mirror-link.js (public/overrides/js/mirror-link.js) already resolves 4nt/TBW/Th.ru/Th.su
    // etc. to the right URL (local mirror vs. online fallback — this app never bundles the local
    // mirrors, so it always resolves online, see TODO.md) — it just does the actual opening via
    // A same-origin destination must be navigated INSIDE this WebView, the SPA way: pushState and
    // let index.html's own popstate handler render the view. Doing it as a real navigation
    // (target="_blank", window.open, location.href) asks Capacitor for a second WebView or a fresh
    // document, and this app's origin has no server behind those paths: the reader got Chrome's
    // "Webpage not available — https://localhost/sn56.48:1.4 could not be loaded because
    // net::ERR_INVALID_RESPONSE", and that window had no back handling at all, so the only way out
    // was killing the app (owner, screenshots). Every search result link is target="_blank", so
    // this was the normal way to open a text, not an edge case.
    function openInPlace(url) {
        var ext = onlineUrlFor(url);
        if (ext) { openExternal(ext); return true; }
        var dirIndex = bundledIndexFor(url);
        if (dirIndex) { location.href = dirIndex; return true; }
        var pm = /^\/(ru\/)?(bi)?pm\.php$/.exec(new URL(url, location.href).pathname);
        if (pm) url = '/toc/' + (pm[2] ? 'bipm' : 'pm');
        try {
            var u = new URL(url, location.href);
            // A real file (a bundled page such as /assets/common/history.html or
            // /settings/index.html) is an ordinary navigation: the file exists, Capacitor serves
            // it, and back works because it is a normal history entry in the same WebView. A
            // pushState here would hand "assets/common/history.html" to the SPA router as a search
            // keyword instead.
            if (/\.html?$/i.test(u.pathname) || /^\/(assets|settings)\//.test(u.pathname)) {
                location.href = u.pathname + u.search + u.hash;
                return true;
            }
            history.pushState({ dgNativeNav: true }, '', u.pathname + u.search + u.hash);
            window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
            return true;
        } catch (e) {
            return false;
        }
    }

    // target="_blank" on a same-origin link: capture phase, so no other handler navigates first.
    document.addEventListener('click', function (e) {
        var a = e.target.closest ? e.target.closest('a[target="_blank"][href]') : null;
        if (!a) return;
        var href = a.getAttribute('href');
        if (!href || href.charAt(0) === '#' || /^javascript:/i.test(href)) return;
        // Cross-origin, /4nt and not-bundled sections go outside (openInPlace decides); a
        // target="_blank" link left to the WebView opened nothing — the lookup popup's
        // dict.dhamma.gift links were exactly that.
        e.preventDefault();
        e.stopPropagation();
        openInPlace(href);
    }, true);

    // window.open()/location.href, which hits problem #1 above. Patching window.open here, rather
    // than editing mirror-link.js, keeps that file identical to the one the live site uses.
    // No realOpen any more: nothing is allowed to open a browser window inside the app's own
    // WebView (see openInPlace). External destinations go through the Browser plugin, same-origin
    // ones through the SPA router.
    window.open = function (url, target, features) {
        if (!url) {
            // mirror-link.js's openMirrorLink() opens a blank window SYNCHRONOUSLY first (so the
            // eventual navigation still counts as a direct response to the click, not a popup),
            // then sets its .location once the async local-vs-online check resolves — emulate
            // just enough of that shape for its own code to work unmodified.
            return { closed: false, set location(url) { openExternal(url); } };
        }
        if (isExternal(url)) {
            // mirror-link.js's own targets are already absolute (real cross-origin URLs); a
            // not-bundled path like "/docs/multitool" is same-origin and relative, so it has to
            // be resolved against the REAL site, not this app's own https://localhost, or the
            // Browser plugin would just try to open a Custom Tab on a host that doesn't exist
            // outside this app's own WebView.
            openExternal(onlineUrlFor(url));
            return null;
        }
        // Same-origin and bundled: in place, never a second WebView (see openInPlace).
        openInPlace(url);
        return null;
    };

    // memo (/memo/, /ru/memo/), login (/login, /ru/login) and the Help/Docs portal
    // (/docs/..., /ru/docs/...) are real site sections this app doesn't bundle — memo/login
    // never were part of the SPA this app copies (see TODO.md); docs (dg-docs, Docusaurus)
    // deliberately stays online-only too (owner: "докс — отдельная опция, скачивать/онлайн при
    // онбординге, чтобы АПК был меньше" — baking the ~23MB build into the APK for content that's
    // read occasionally, not offline-critical like search/reader, was the wrong tradeoff; a real
    // downloadable-docs option is a bigger separate feature — packaging+extracting a whole static
    // site at runtime, not a simple asset-list addition like everything else in build-assets.js —
    // left for later if actually wanted). All three have no local version to even attempt, unlike
    // mirror-link.js's targets, so they always go straight to the live site via a real browser
    // (target="_blank" on these same-origin-relative links would otherwise just try to navigate
    // the WebView to a path that doesn't exist locally — see build-assets.js/app.js's "/toc/..."
    // 404 comments).
    // Shared/copied links (toSiteUrls) stay on dhamma.gift; only the app's own trips follow a test origin.
    var ONLINE_ORIGIN = window.DG_ONLINE_ORIGIN || 'https://dhamma.gift';
    // A bundled directory (/memo/) is a folder with an index.html; Capacitor answers the folder URL
    // itself with the app's root index.html, so the reader got a search for "memo" instead.
    var BUNDLED_DIRS = ['/memo/', '/assets/diff/', '/login/'];
    function bundledIndexFor(url) {
        try {
            var u = new URL(url, location.href);
            if (u.origin !== location.origin) return null;
            var dir = u.pathname.replace(/^\/ru\//, '/').replace(/\/?$/, '/');
            return BUNDLED_DIRS.indexOf(dir) !== -1 ? dir + 'index.html' + u.search + u.hash : null;
        } catch (e) { return null; }
    }

    // Late, bubble-phase twin of the capture handler above: openDicts.js's openWithQuery() swaps a
    // javascript:void(0) href for the real one INSIDE the click, after the capture handler already
    // let the link go, and the WebView then opened nothing (the home sheets' dictionary rows).
    window.addEventListener('click', function (e) {
        if (e.defaultPrevented || !e.target.closest) return;
        var a = e.target.closest('a[target="_blank"][href]');
        var href = a && a.getAttribute('href');
        if (!href || href.charAt(0) === '#' || /^javascript:/i.test(href)) return;
        e.preventDefault();
        openInPlace(href);
    });

    document.addEventListener('click', function (e) {
        if (e.defaultPrevented) return; // already routed by the capture handler above (/docs opened twice)
        var a = e.target.closest('a[href]');
        if (a) {
            var href = a.getAttribute('href');
            var dirIndex = bundledIndexFor(href);
            if (dirIndex) {
                e.preventDefault();
                location.href = dirIndex;
                return;
            }
            if (/^\/(ru\/)?(bi)?pm\.php(\?|$)/.test(href)) {
                e.preventDefault();
                openInPlace(href);
                return;
            }
            // By pathname, not the raw href: the reading-mode menus build absolute
            // https://localhost/read/ links, which a regex on the raw href never matched.
            var mapped = onlineUrlFor(href);
            var u = new URL(href, location.href);
            if (mapped && u.origin === location.origin) {
                e.preventDefault();
                openExternal(mapped);
                return;
            }
            // Capacitor falls back to index.html only when the last path segment has no dot, so a
            // plain link to /an3.57:1.3 (the Favorites/History sheet rows) was looked up as a file:
            // "Webpage not available ... net::ERR_INVALID_RESPONSE". Reload through the root with
            // the same _nativeRoute handoff MainActivity uses (rewriteNativeShortcutRoute above).
            if (u.origin === location.origin && /\.[^/]*$/.test(u.pathname) && !/\.[a-z]{2,5}$/i.test(u.pathname)) {
                e.preventDefault();
                location.href = '/?_nativeRoute=' + encodeURIComponent(u.pathname + u.search + u.hash);
            }
            return;
        }
        // settings/index.html's "Log in" button navigates via `location.href = ...` from its own
        // .onclick, set after this listener runs (capture phase) — same target as the anchors
        // above, but NOT sent externally like them: opening /login in a Custom Tab is a dead end
        // for this specific button (owner-reported "sends you somewhere you can't get into") —
        // that tab's resulting Firebase session lives in a different browser on a different
        // origin, it can never reach back into this app's own WebView storage (see quickModal.js
        // override's dgOfflineLoginWithPhrase() for the actual fix — a passphrase, entered right
        // here in the app, no browser handoff needed). Route to the real working control instead
        // of the dead-end external one: home + auto-open the Quick Modal on its default tab
        // (settings-bundle.js's own "?sacca=true" trigger, no tab argument — same as the plain
        // modal-open shortcut used to be before it went through app.js) where that sync button
        // lives.
        if (e.target.closest('#cloudBtn')) {
            e.preventDefault();
            e.stopPropagation();
            // Owner: "Log in" opens the sign-in page, as on the site — now bundled (build-assets.js), so
            // it runs in this WebView and its passphrase sign-in reaches this app's own storage.
            var ruLogin = (localStorage.getItem('dhammaLanguage') || localStorage.getItem('siteLanguage') || 'en') === 'ru';
            (window.top || window).location.href = ruLogin ? '/ru/login/index.html' : '/login/index.html'; // settings is an iframe sheet
        }
        // settings/index.html's "Voice and reading speed" -> "Open" button: same
        // location.href-from-onclick shape as #cloudBtn above, pointed at /read/ (or /ru/read/)
        // — the legacy standalone reader page, real and working on the live site (verified: 200),
        // but never bundled into this app (same reason the "DG Read" App Shortcut was dropped —
        // see shortcuts.xml's own comment: its logic was never ported to the offline shim). Left
        // unhandled, this just silently loaded a blank 404 in the app's own WebView with nothing
        // in the console to explain why — no fetch involved, so app.js's shim never even sees it.
        // #voiceBtn is no longer intercepted: settings/index.html opens the reader's own voice panel
        // (the legacy /read/ page it used to send the reader to redirects to the home page now).
    }, true);

    // Owner (real usage): "не работают переходы назад — кнопка Android назад или свайп назад".
    // Capacitor 6 moved hardware-back handling out of the core Bridge and into the optional
    // @capacitor/app plugin — with it absent (as it was), Android's back dispatcher has nothing
    // registered at all, so both the back button and the edge-swipe-back gesture (same dispatch
    // path) just fall through to the default Activity behavior and exit/background the app
    // instead of going back within the SPA's own pushState history. @capacitor/app's `canGoBack`
    // is computed from the native WebView's own back/forward list, which faithfully tracks every
    // pushState navigation the SPA already does (search → reader → TOC, etc.) — so this is
    // exactly "go back one step in the app", not a full page reload.
    // ---------------------------------------------------------------------------------------
    // Google sign-in through the system browser
    // ---------------------------------------------------------------------------------------

    // Google refuses OAuth inside an app's WebView, so settings.js's signInWithPopup cannot work here.
    // The app opens <site>/login/app-google.html in the system browser with a one-time state; that page
    // signs in normally and hands the Google ID token back (intent:// naming this app's package ->
    // MainActivity -> /login/index.html#dg_google=...&state=...), and here the same Firebase account is
    // signed in with it. The merge/overwrite choice made before leaving is kept with the state: the
    // login page reloads on the way back.
    (function googleSignInViaBrowser() {
        var KEY = 'dg.app.googleSignIn';
        var origin = window.DG_ONLINE_ORIGIN || 'https://dhamma.gift';
        var Plugins = (window.Capacitor && window.Capacitor.Plugins) || {};

        // The URL the system browser is sent to, built in one place and reachable from a test:
        // whether the handoff is right (a one-time state, the package the page validates, the
        // language, and the platform that decides how the token comes back) is a contract with a page
        // on the site, and a contract nobody can call is a contract nobody checks.
        function signInUrl(state, pkg) {
            var ru = /^\/ru\//.test(location.pathname) ||
                (localStorage.getItem('dhammaLanguage') || localStorage.getItem('siteLanguage') || 'en') === 'ru';
            // &plat: the page must return through intent:// on Android and dhammagift:// on iOS, and
            // only the app knows which it is — a user-agent guess would be a second thing to keep
            // correct on every iOS release.
            var plat = (window.Capacitor && window.Capacitor.getPlatform && window.Capacitor.getPlatform()) || 'web';
            return origin + '/login/app-google.html?state=' + state +
                '&pkg=' + encodeURIComponent(pkg || 'gift.dhamma.mobile') + '&lang=' + (ru ? 'ru' : 'en') +
                '&plat=' + encodeURIComponent(plat);
        }
        window.dgSignInUrl = function (state, pkg) { return signInUrl(state || 'a1b2c3d4e5f60718293a4b5c6d7e8f90', pkg); };

        function start() {
            var bytes = new Uint8Array(16);
            crypto.getRandomValues(bytes);
            var state = Array.prototype.map.call(bytes, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
            try {
                localStorage.setItem(KEY, JSON.stringify({ state: state, overwrite: window.pendingOverwrite === true, at: Date.now() }));
            } catch (e) { /* no storage: the state check on return fails closed */ }
            var info = Plugins.App && Plugins.App.getInfo ? Plugins.App.getInfo() : Promise.resolve({});
            return info.catch(function () { return {}; }).then(function (i) {
                openExternal(signInUrl(state, i.id));
            });
        }
        // settings.js defines its own syncLoginGoogle, and on some pages it loads after this file.
        try {
            Object.defineProperty(window, 'syncLoginGoogle', { configurable: true, get: function () { return start; }, set: function () {} });
        } catch (e) { window.syncLoginGoogle = start; }

        function finish() {
            var m = /^#dg_google=([^&]+)&state=([a-f0-9]+)$/.exec(location.hash);
            if (!m) return;
            history.replaceState(history.state, '', location.pathname + location.search);
            var saved = null;
            try { saved = JSON.parse(localStorage.getItem(KEY) || 'null'); localStorage.removeItem(KEY); } catch (e) { /* unreadable: rejected below */ }
            if (!saved || saved.state !== m[2] || Date.now() - saved.at > 15 * 60 * 1000) {
                console.error('[dg-google] sign-in reply does not match a request from this app; ignored');
                return;
            }
            window.pendingOverwrite = saved.overwrite === true;
            Promise.resolve(typeof window.initFirebase === 'function' && window.initFirebase()).then(function () {
                return firebase.auth().signInWithCredential(firebase.auth.GoogleAuthProvider.credential(decodeURIComponent(m[1])));
            }).then(function () {
                localStorage.setItem('dg_cloud_session', 'true');
            }).catch(function (e) {
                console.error('[dg-google] Firebase sign-in with the Google token failed:', e && (e.code || e.message));
                if (typeof window.showBubbleNotification === 'function') {
                    var ru = /^\/ru\//.test(location.pathname);
                    window.showBubbleNotification(ru ? 'Не получилось войти через Google. Попробуйте ещё раз' : 'Google sign-in failed. Please try again', 6000, 'error');
                }
            });
        }
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', finish);
        else finish();
        window.addEventListener('hashchange', finish);
    })();

    var CapApp = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
    if (CapApp) {
        CapApp.addListener('backButton', function (ev) {
            // Closing an open overlay first is the expected mobile pattern — otherwise "back"
            // while the Quick Modal (Favorites/History/compass) is open exits the app instead of
            // just closing the modal.
            if (window.quickModalIsOpen && typeof window.toggleQuickModal === 'function') {
                window.toggleQuickModal();
                return;
            }
            if (ev.canGoBack) window.history.back();
            else CapApp.exitApp();
        });
    }

    // ---------------------------------------------------------------------------------------
    // App version row (settings → "App version")
    // ---------------------------------------------------------------------------------------

    // Owner: "в app версии в настройках версия не отображалась". Two reasons it could be blank,
    // both handled here:
    //  1. this file is injected into <head> on some pages and at </body> on others, so the row may
    //     not exist yet when the script runs — hence the DOM-ready wait;
    //  2. it used to be filled ONLY from Capacitor's App.getInfo(), inside the `if (CapApp)` block,
    //     so any failure (or the plain browser used for testing) left the row as "&nbsp;".
    // The build now also writes www/app-version.json (from android/app/build.gradle), so the row
    // always has a real answer — and it still prefers the plugin, which is the authoritative source
    // on a device (it reads the installed package's versionName/versionCode).
    function fillVersionRow() {
        var row = document.getElementById('dgAppVersionRow');
        if (!row) return;
        var desc = document.getElementById('dgAppVersionDesc');

        function show(text) {
            if (desc) desc.textContent = text;
            row.style.cursor = 'pointer';
            row.addEventListener('click', function () {
                navigator.clipboard.writeText(text).catch(function (e) {
                    console.error('[dg-version] clipboard write failed', e);
                });
            });
        }

        function fromBuildFile() {
            fetch('/app-version.json', { cache: 'no-store' })
                .then(function (r) { return r.ok ? r.json() : null; })
                .then(function (info) {
                    if (info && info.version) show('v' + info.version + ' (' + info.build + ')');
                })
                .catch(function () { /* nothing to show; the row stays empty */ });
        }

        // Only the build file: settings opens in an iframe over the page, where App.getInfo() never
        // answered and the row stayed blank on a device. The file is written from the same
        // build.gradle versionName/versionCode, so it is the same answer.
        fromBuildFile();
    }

    // Settings → "Recent texts in app shortcuts" switch (row injected by build-assets.js).
    function wireShortcutsToggle() {
        var box = document.getElementById('dgDynShortcuts');
        if (!box) return;
        var ru = isRu();
        document.getElementById('dgDynShortcutsTitle').textContent = ru ? 'Недавние тексты в ярлыках' : 'Recent texts in app shortcuts';
        document.getElementById('dgDynShortcutsDesc').textContent = ru ? 'Меню долгого нажатия на значок приложения.' : 'Long-press menu of the app icon.';
        box.checked = localStorage.getItem(SHORTCUTS_FLAG) !== 'off';
        box.addEventListener('change', function () {
            localStorage.setItem(SHORTCUTS_FLAG, box.checked ? 'on' : 'off');
            pushDynamicShortcuts();
        });
    }

    function onReady() { fillVersionRow(); wireShortcutsToggle(); }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onReady);
    else onReady();
})();
