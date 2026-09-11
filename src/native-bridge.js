// Bridges "leave the app" links to the device's real browser via @capacitor/browser (Chrome
// Custom Tabs on Android) instead of the app's own WebView. Two reasons this can't just be a
// plain navigation/window.open like on the real site:
//
// 1. Capacitor's WebView only navigates within its own local origin (https://localhost, this
//    app's static asset server) by default — a plain `location.href`/`<a href>` to an external
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
        var EXTERNAL_ROUTES = /^\/(ru\/)?(dict|memorize|login|docs)(\/|$)/;
        if (EXTERNAL_ROUTES.test(route)) {
            openExternal('https://dhamma.gift' + route);
            return;
        }
        // The memorisation app IS bundled now (build-assets.js copies siteroot/memo), and it is a
        // real file: Capacitor cannot resolve the /memo/ directory, so the shortcut points at it.
        if (route === '/memo' || route === '/memo/') {
            history.replaceState(null, '', '/memo/index.html');
            return;
        }
        history.replaceState(null, '', route);
    })();

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
            if (fav.id && fav.id !== fav.slug) route += '#' + fav.id;
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

    // Android's WebView does expose navigator.share on recent versions, but only when the app
    // declares the intent filters it needs, and it has been unreliable across WebView builds;
    // iOS's WKWebView exposes it behind its own quirks. Capacitor's Share plugin goes through the
    // platform's own sheet (Android ACTION_SEND chooser / iOS UIActivityViewController) and needs
    // nothing from the page. Defined only when the platform's own API is missing, so on a device
    // where navigator.share works the site's existing code keeps using it unchanged.
    (function installWebShareFallback() {
        var Share = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Share;
        if (!Share || typeof Share.share !== 'function') return;
        if (typeof navigator.share === 'function') return;
        try {
            Object.defineProperty(navigator, 'share', {
                configurable: true,
                writable: true,
                value: function (data) {
                    var payload = data || {};
                    return Share.share({
                        title: payload.title,
                        text: payload.text,
                        url: payload.url,
                        dialogTitle: payload.title,
                    }).then(function () { return undefined; });
                },
            });
        } catch (e) {
            console.log('[dg-share] could not install navigator.share:', (e && e.message) || e);
        }
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

    // ---------------------------------------------------------------------------------------
    // Native chrome follows the page's theme
    // ---------------------------------------------------------------------------------------

    // The owner's report: "тема у нас установлена, но тема приложения не установлена" — the page
    // switched to dark while the status bar stayed a light-theme bar, so the app never looked like
    // it was in dark mode. The page's theme lives in `data-bs-theme` on <html> (set by
    // themeswitch.js from localStorage.theme, which can be light/dark/auto), so the native side
    // just follows that attribute — no second source of truth, and 'auto' resolves to whatever the
    // page already computed for this device.
    (function followPageTheme() {
        var StatusBar = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.StatusBar;
        if (!StatusBar) return;

        var COLORS = { dark: '#101816', light: '#ffffff' };

        function apply() {
            var theme = document.documentElement.getAttribute('data-bs-theme') === 'dark' ? 'dark' : 'light';
            // Capacitor's Style.Dark means "light content on a dark bar" — the naming is inverted
            // relative to the theme, which is why this reads backwards and is correct.
            var style = theme === 'dark' ? 'DARK' : 'LIGHT';
            try {
                StatusBar.setStyle({ style: style }).catch(function () {});
                StatusBar.setBackgroundColor({ color: COLORS[theme] }).catch(function () {});
            } catch (e) { /* older plugin: the page itself is still themed */ }
        }

        apply();
        new MutationObserver(apply).observe(document.documentElement, {
            attributes: true,
            attributeFilter: ['data-bs-theme'],
        });
        // The theme script runs after this file and may set the attribute without a mutation we
        // can catch if it writes the same value twice in a row — one delayed re-read is enough.
        document.addEventListener('DOMContentLoaded', apply);
    })();

    function openExternal(url) {
        var Browser = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Browser;
        if (Browser) Browser.open({ url: url });
        else window.location.href = url; // plain-browser fallback (local dev/testing, no Capacitor runtime)
    }

    // memo/login/docs are same-ORIGIN paths (https://localhost/docs/...) but not actually
    // bundled content — a plain origin check alone calls them "not external" and lets
    // window.open() below try to open them locally, 404ing silently in a blank new tab/window.
    // Shared with the click listener further down so both agree on what "not bundled" means.
    // /memo is NOT here any more: it ships inside the app (see copyMemoApp in build-assets.js).
    // /memorize is: that is the legacy PHP reader in memorisation mode, and it cannot run here.
    var NOT_BUNDLED_RE = /^\/(ru\/)?(dict|memorize|login|docs)(\/|$)/;

    function isExternal(url) {
        try {
            var parsed = new URL(url, location.href);
            return parsed.origin !== location.origin || NOT_BUNDLED_RE.test(parsed.pathname);
        } catch (e) { return false; }
    }

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
        try {
            var u = new URL(url, location.href);
            if (u.origin !== location.origin) { openExternal(url); return true; }
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
        if (!href || href.charAt(0) === '#') return;
        // External links keep their own path below (the Browser bridge / mirror-link.js).
        try {
            if (new URL(href, location.href).origin !== location.origin) return;
        } catch (err) { return; }
        if (NOT_BUNDLED_RE.test(href)) return; // memo/dict/login/docs go to the real site
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
            var resolved = new URL(url, location.href);
            openExternal(resolved.origin === location.origin ? ONLINE_ORIGIN + resolved.pathname + resolved.search + resolved.hash : url);
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
    var ONLINE_ORIGIN = 'https://dhamma.gift';
    document.addEventListener('click', function (e) {
        var a = e.target.closest('a[href]');
        if (a) {
            var href = a.getAttribute('href');
            if (NOT_BUNDLED_RE.test(href)) {
                e.preventDefault();
                openExternal(ONLINE_ORIGIN + href);
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
            location.href = '/?sacca=true';
        }
        // settings/index.html's "Voice and reading speed" -> "Open" button: same
        // location.href-from-onclick shape as #cloudBtn above, pointed at /read/ (or /ru/read/)
        // — the legacy standalone reader page, real and working on the live site (verified: 200),
        // but never bundled into this app (same reason the "DG Read" App Shortcut was dropped —
        // see shortcuts.xml's own comment: its logic was never ported to the offline shim). Left
        // unhandled, this just silently loaded a blank 404 in the app's own WebView with nothing
        // in the console to explain why — no fetch involved, so app.js's shim never even sees it.
        if (e.target.closest('#voiceBtn')) {
            e.preventDefault();
            e.stopPropagation();
            var ru = (localStorage.getItem('dhammaLanguage') || localStorage.getItem('siteLanguage') || 'en') === 'ru';
            openExternal(ONLINE_ORIGIN + (ru ? '/ru/read/' : '/read/'));
        }
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

        var App = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
        if (App && typeof App.getInfo === 'function') {
            App.getInfo()
                .then(function (info) { show('v' + info.version + ' (' + info.build + ')'); })
                .catch(function (e) { console.error('[dg-version] App.getInfo failed', e); fromBuildFile(); });
        } else {
            fromBuildFile();
        }
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fillVersionRow);
    else fillVersionRow();
})();
