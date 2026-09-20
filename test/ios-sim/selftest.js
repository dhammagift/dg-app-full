// The in-app self-test. Injected into www/index.html only by test/ios-sim/prepare-www.js, which is
// only ever run on a build output tree — a shipped bundle never contains this file.
//
// What it answers, and why it has to be asked from INSIDE the app: the whole iOS data layer is a
// bet that a Web Worker can download the offline library into OPFS and open it through sqlite-wasm's
// SAH-pool VFS, reading a file from device storage rather than memory. None of that is visible from
// outside the WebView, and a GitHub runner has no debugger. So the page proves it itself: wait for
// the library, ask the same questions the site answers, hand the raw results to the native side
// (DgSelfTestPlugin, debug builds only), and let CI diff them.
//
// The two injected globals make the proof mean something (see prepare-www.js): the library comes
// from the app's own bundle, and every "needs the internet" path is pointed at a dead port. A single
// 200 answer is therefore a local answer — with a reachable dhamma.gift this test would pass even
// with the database never opening.

(function () {
    'use strict';

    var STATE_KEY = 'dg.offline.state';
    // The run happened / its report, in localStorage: the page reloads as part of this test (it has
    // to — it ends on a real page of the app), and without a flag every reload runs the whole
    // sequence again, navigating again, for as long as the app lives.
    // Opened by the run itself (see selfDeepLink): a route, not a search, so the path it lands on
    // cannot be confused with anything the page does on its own.
    var SELF_DEEP_LINK = 'dhammagift://route/toc';
    var DONE_KEY = 'dg.selftest.done';
    var REPORT_KEY = 'dg.selftest.report';
    var DEADLINE_MS = 5 * 60 * 1000;   // a cold simulator, a cold worker, a small fixture
    var POLL_MS = 250;

    function isDone() {
        try { return localStorage.getItem(DONE_KEY) === '1'; } catch (e) { return false; }
    }
    function markDone() {
        try { localStorage.setItem(DONE_KEY, '1'); } catch (e) { /* private mode: it will run twice, not fatal */ }
    }
    function rememberReport(json) {
        try { localStorage.setItem(REPORT_KEY, json); } catch (e) { /* quota: the file write still happened */ }
    }

    // The cases the fixture can answer. Same request shapes test/e2e-browser.js uses against the
    // real database; `expect` is a substring that must appear in the body, so the check is not just
    // "something came back".
    var CASES = [
        { name: 'search-kacchapa',      url: '/search?q=kacchapa&langs=ru,en',            expect: 'dn22' },
        { name: 'search-kacchapa-fast', url: '/search?q=kacchapa&langs=ru,en&fast=1',     expect: 'dn22' },
        { name: 'search-russian',       url: '/search?q=%D1%87%D0%B5%D1%80%D0%B5%D0%BF%D0%B0%D1%85%D0%B0&langs=ru,en', expect: 'dn22' },
        { name: 'search-no-hits',       url: '/search?q=zzzzzz&langs=ru,en',              expect: null },
        { name: 'text-dn22-st',         url: '/api/text/dn22?mode=st',                    expect: 'Evaṁ me sutaṁ' },
        { name: 'text-dn22-mt',         url: '/api/text/dn22?mode=mt',                    expect: 'evaṁ' },
        // dn22 is the first sutta in the fixture, so its own slug is nowhere in a correct answer:
        // what must appear is the NEXT one.
        { name: 'nav-dn22',             url: '/api/nav/dn22',                             expect: 'sn56.11' },
        { name: 'toc-snapshot',         url: '/api/toc',                                  expect: 'dn' },
    ];

    var report = {
        runs: 1,
        startedAt: new Date().toISOString(),
        origin: location.origin,
        distBase: (window.dgPlatform && window.dgPlatform.distBase) || window.DG_DIST_BASE || null,
        // The origin the offline layer actually uses, not the global: native-bridge.js overwrites
        // window.DG_ONLINE_ORIGIN later in the page, and it is platform.js's value that decides where
        // a request the local database cannot answer is sent.
        onlineOrigin: (window.dgPlatform && window.dgPlatform.onlineBase) || window.DG_ONLINE_ORIGIN || null,
        isSecureContext: window.isSecureContext,
        hasOpfs: !!(navigator.storage && navigator.storage.getDirectory),
        workerOk: null,
        libraryPresent: false,
        waitedMs: null,
        state: null,
        progress: [],
        cases: [],
        navigatedTo: null,
        error: null,
    };

    // platform.js now asks before every first download, Wi-Fi included (App Store guideline
    // 4.2.3(ii) — see src/platform.js's askConsent). Right, for a reader; fatal for this script:
    // nobody is here to tap the sheet's "Download" button, and the auto-download intent that used
    // to start silently on Wi-Fi now blocks on it forever — run 263's actual failure, a 300s
    // timeout with "TO JS {"connected":true,"connectionType":"wifi"}" as the last console line and
    // no selftest.json ever written. This harness IS the reader tapping "Download": it answers the
    // sheet the instant it opens, same as a human would.
    window.addEventListener('dg:need-consent', function (event) {
        if (event && event.detail && typeof event.detail.resolve === 'function') event.detail.resolve(true);
    });

    // Progress lines the page already dispatches (offline-status.js paints them): the first thing
    // to look at when the library never becomes present.
    ['dg:dl-progress', 'dg:offline-invalid', 'dg:download-declined', 'dg:update-available'].forEach(function (name) {
        window.addEventListener(name, function (event) {
            var d = (event && event.detail) || {};
            report.progress.push({
                event: name,
                phase: d.phase || null,
                loaded: d.loaded || null,
                total: d.total || null,
                percent: d.percent || null,
                done: !!d.done,
            });
            if (report.progress.length > 200) report.progress.shift();
        });
    });

    function readState() {
        try { return JSON.parse(localStorage.getItem(STATE_KEY) || 'null'); } catch (e) { return null; }
    }

    function waitForLibrary() {
        var started = Date.now();
        return new Promise(function (resolve) {
            (function poll() {
                var state = readState();
                if (state && state.present) {
                    report.state = state;
                    report.libraryPresent = true;
                    report.waitedMs = Date.now() - started;
                    return resolve();
                }
                if (Date.now() - started > DEADLINE_MS) {
                    report.state = state;
                    report.waitedMs = Date.now() - started;
                    report.error = 'the offline library never became present';
                    return resolve();
                }
                setTimeout(poll, POLL_MS);
            })();
        });
    }

    function runCase(c) {
        return fetch(c.url, { cache: 'no-store' }).then(function (response) {
            return response.text().then(function (body) {
                var hit = c.expect === null ? true : body.indexOf(c.expect) !== -1;
                return {
                    name: c.name,
                    url: c.url,
                    status: response.status,
                    bytes: body.length,
                    expect: c.expect,
                    ok: response.ok && hit && body.length > 0,
                    sample: body.slice(0, 300),
                };
            });
        }).catch(function (e) {
            return { name: c.name, url: c.url, status: null, bytes: 0, expect: c.expect, ok: false, sample: 'threw: ' + e.message };
        });
    }

    // Two questions the simulator can answer and a phone test would otherwise answer late:
    //
    //  * does this WebView speak on its own? Android's does not (no window.speechSynthesis in System
    //    WebView), which is why the app carries DgTtsPlugin there. If WKWebView has working voices,
    //    iOS needs no speech plugin at all — and this probe is what decides that, from CI, instead of
    //    shipping a synthesizer nobody needed.
    //  * does the native progress plugin answer? It is the idle-timer mirror that keeps the screen
    //    awake during the download (DgProgressPlugin.swift); if it is not registered, that is worth
    //    knowing before a 216 MB transfer dies on a locked phone.
    function probeSpeech() {
        var s = window.speechSynthesis;
        // engine: 'plugin' means src/tts.js installed its shim over the WebView's own speech (see its
        // guard) — the thing the reader's player actually needs to work.
        // engine reads the OBJECT the page ended up with, not a flag set at install time: the first
        // version reported 'plugin' while speak() still threw the native error, because a readonly
        // window.speechSynthesis had silently swallowed the assignment.
        var out = { api: !!s, engine: (s && s.__dgTtsPlugin) ? 'plugin' : 'native', voices: null, speaks: null };
        if (!s) return Promise.resolve(out);
        try { out.voices = (s.getVoices() || []).length; } catch (e) { out.voices = 'threw'; }
        if (typeof SpeechSynthesisUtterance !== 'function') return Promise.resolve(out);
        return new Promise(function (resolve) {
            var done = false;
            var u = new SpeechSynthesisUtterance('test');
            function finish(value) { if (done) return; done = true; out.speaks = value; resolve(out); }
            u.onstart = function () { finish('started'); };
            u.onend = function () { finish('ended'); };
            u.onerror = function (e) { finish('error:' + (e && e.error)); };
            try { s.speak(u); } catch (e) { finish('threw:' + e.message); }
            // No speaker in a simulator, and no user gesture to unlock audio: whether it starts is
            // the question, not whether sound came out.
            setTimeout(function () { finish('timeout'); }, 4000);
        });
    }

    function probeProgressPlugin() {
        var p = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.DgProgress;
        // capacitor:false means a plain browser (the local Chromium pre-flight), where the plugin
        // cannot exist and its absence says nothing. In the app, absence is a real failure.
        if (!p || typeof p.update !== 'function') return Promise.resolve({ present: false, capacitor: !!window.Capacitor });
        return Promise.resolve(p.update({ title: 'probe', text: 'probe', percent: 42 }))
            .then(function (r) {
                var result = { present: true, awake: !!(r && r.awake) };
                return Promise.resolve(typeof p.clear === 'function' ? p.clear() : null)
                    .then(function () { return result; }, function () { return result; });
            })
            .catch(function (e) { return { present: true, error: e.message }; });
    }

    // Where the safe area actually landed. The screenshot shows the truth, but a number says WHICH
    // case it is: with the WebView inset (ios.contentInset = "always") the visual viewport starts
    // below the status bar and these differ from the raw screen; with no inset they are equal and
    // the page's own header is under the clock (the bug the first screenshots showed).
    function probeViewport() {
        var vv = window.visualViewport;
        return {
            innerHeight: window.innerHeight,
            innerWidth: window.innerWidth,
            screenHeight: window.screen ? window.screen.height : null,
            screenWidth: window.screen ? window.screen.width : null,
            visualOffsetTop: vv ? vv.offsetTop : null,
            visualHeight: vv ? vv.height : null
        };
    }

    // The native voice, mirrored from Android's DgTtsPlugin. The WebView's own speechSynthesis is
    // what the probe above is for; this one asks the plugin the player will actually use, so a
    // missing or mute engine is a CI result rather than a silent reader.
    function probeTtsPlugin() {
        var p = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.DgTts;
        if (!p || typeof p.getVoices !== 'function') {
            return Promise.resolve({ present: false, capacitor: !!window.Capacitor });
        }
        return Promise.resolve(p.getVoices()).then(function (r) {
            var voices = (r && r.voices) || [];
            var out = {
                present: true,
                voices: voices.length,
                sample: voices.slice(0, 3).map(function (v) { return v.lang + '/' + v.name; })
            };
            var lang = voices.length && voices[0].lang ? voices[0].lang : 'en-US';
            return Promise.resolve(p.speak({ id: 'selftest', text: 'Dhamma gift self test', lang: lang, rate: 1 }))
                .then(function () { out.speak = 'queued'; return out; })
                .catch(function (e) { out.speak = 'rejected: ' + e.message; return out; });
        }).catch(function (e) { return { present: true, error: e.message }; });
    }

    // The background-download plugin, asked the one harmless question it answers without a network:
    // does it exist and can it create its background URLSession (load() would have thrown otherwise)?
    // It also tells CI whether a previous run left an archive on disk — which is how the local-import
    // path will be exercised without downloading 216 MB in a runner.
    function probeDownloadPlugin() {
        var p = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.DgDownload;
        if (!p || typeof p.existing !== 'function') {
            return Promise.resolve({ present: false, capacitor: !!window.Capacitor });
        }
        return Promise.resolve(p.existing())
            .then(function (r) { return { present: true, path: (r && r.path) || null, found: !!(r && r.path) }; })
            .catch(function (e) { return { present: true, error: e.message }; });
    }

    // The Screen Wake Lock the offline layer takes while a download runs (dg-node's
    // offline-status.js). This spy has to be installed before the transfer starts — the self-test
    // script loads at the end of the page and the download is asynchronous, so parse time is in
    // time. What it can prove on a runner is that the code ASKS; that the screen then stays on is a
    // device question (and the reason the owner's iPhone measurement matters).
    function spyWakeLock() {
        var wl = navigator.wakeLock;
        var out = { api: !!(wl && typeof wl.request === 'function'), requests: 0, releases: 0, how: null };
        if (!out.api) return out;

        function wrapRequest(owner) {
            var request = owner.request;
            owner.request = function (type) {
                out.requests++;
                return request.call(this === owner ? owner : this, type).then(function (lock) {
                    var release = lock.release.bind(lock);
                    lock.release = function () { out.releases++; return release(); };
                    return lock;
                });
            };
        }

        // The PROTOTYPE, not the instance: WebKit hands out a fresh WakeLock object on every
        // `navigator.wakeLock` access, so wrapping the one this script sees catches nothing — which is
        // exactly what run 135 reported ("api: true, requests: 0") while the layer was requesting a
        // lock on an object the spy had never met. Chromium caches the object, which is why the same
        // spy looked correct locally.
        var proto = window.WakeLock && window.WakeLock.prototype;
        if (proto && typeof proto.request === 'function') {
            wrapRequest(proto);
            out.how = 'prototype';
        } else {
            wrapRequest(wl);
            out.how = 'instance';
        }
        return out;
    }

    // ---------------------------------------------------------------------------------------
    // The link crawler, inside the real WebView.
    //
    // test/links.js crawls this from outside with Playwright (Linux, Chromium): seven pages, and it
    // really clicks every link, because "a path the device cannot serve is not a 404 in a WebView, it
    // is index.html". A simulator's WebView cannot be driven from outside, so the same classes of
    // failure are checked from inside, on the links the page ACTUALLY renders — the results view, the
    // TOC and the reader are rendered first through the SPA's own router (pushState + popstate, the
    // same handoff native-bridge uses for shortcuts), then their links are resolved:
    //
    //   * a link with a real file extension (.html, .php, .js, ...) must load: a 404 is a page the
    //     reader cannot reach,
    //   * a folder link (a trailing slash) always shows the home page in this WebView, whatever the
    //     folder contains — the asset handler answers every dotless path with the root index.html,
    //   * a legacy reader route (/read/, /r.php, /memorize/, ...) is not in this app at all.
    //
    // Everything else without an extension is a route the SPA handles in place (/toc, /sn56.11) — the
    // router intercepts the click and no document is ever fetched. Those are counted, not failed: a
    // fetch-based check cannot judge them, and calling them broken was this check's first version's
    // mistake (41 "failures" that were all routes the app serves perfectly well).
    //
    // Click-specific verdicts (a second window, a URL handed to the outside browser) belong to the
    // native side and are covered by the deep-link and routing checks.
    // ---------------------------------------------------------------------------------------
    var LINK_VIEWS = ['/?q=kacchapa&langs=ru,en', '/toc', '/dn22:2.2'];
    var STATIC_PAGES = ['/settings/index.html'];
    var LEGACY_ROUTE = /^\/(ru\/)?(read|r|d|ml|mt|multi|mlth|memorize|th)(\/|$)|^\/(ru\/)?(read|history)\.php$/;
    var FILE_EXT = /\.(html?|php|js|mjs|css|json|png|jpe?g|svg|webp|gif|pdf|woff2?|ttf|txt|csv|xml)$/i;

    function sameOriginLinks(root) {
        var seen = {};
        Array.prototype.forEach.call(root.querySelectorAll('a[href]'), function (a) {
            var href = a.getAttribute('href');
            if (!href || /^(#|javascript:|mailto:|tel:)/i.test(href)) return;
            // Not rendered, not a link the reader can click: every view keeps the previous view's
            // markup in the DOM (the reader's legacy link rows are still there while results are
            // shown), and test/links.js skips those too ("link no longer on the page"). Without this
            // the crawler reported four dead links three times over — all of them invisible.
            if (!a.getClientRects || a.getClientRects().length === 0) return;
            if (a.closest('[hidden]') || a.closest('[aria-hidden="true"]')) return;
            var u;
            try { u = new URL(a.href || href, location.href); } catch (e) { return; }
            if (u.origin !== location.origin) { seen.__external = (seen.__external || 0) + 1; return; }
            seen[u.pathname + u.search] = 1;
        });
        return seen;
    }

    // Render a route in place and hand back the links the view now shows.
    function linksOfView(route) {
        return new Promise(function (resolve) {
            try {
                history.pushState({}, '', route);
                window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
            } catch (e) { /* the view stays as it was */ }
            setTimeout(function () { resolve(sameOriginLinks(document)); }, 2500);
        });
    }

    function checkLinks() {
        var out = { views: {}, checked: 0, external: 0, routes: 0, failed: [] };

        function resolve(map) {
            var hrefs = Object.keys(map);
            out.external += map.__external || 0;
            return hrefs.reduce(function (chain, href) {
                return chain.then(function () {
                    var path = href.split('?')[0];
                    // The app's own verdict first: a link it deliberately opens in the browser
                    // (/r.php, /dict, /docs, the mirrors) is not something this WebView has to serve.
                    if (typeof window.dgIsExternalUrl === 'function' && window.dgIsExternalUrl(href)) {
                        out.external++;
                        return;
                    }
                    if (LEGACY_ROUTE.test(path)) {
                        out.failed.push({ href: href, why: 'legacy reader route — not in this app' });
                        return;
                    }
                    if (/\/$/.test(path) && path !== '/') {
                        out.failed.push({ href: href, why: 'folder link — this WebView shows the home page for it' });
                        return;
                    }
                    if (!FILE_EXT.test(path)) {
                        // A route the SPA handles in place: no document load, nothing to fetch.
                        out.routes++;
                        return;
                    }
                    out.checked++;
                    return fetch(href, { cache: 'no-store' }).then(function (r) {
                        if (r.status !== 200) out.failed.push({ href: href, why: 'the device cannot load it (' + r.status + ')' });
                    }).catch(function (e) {
                        out.failed.push({ href: href, why: 'fetch threw: ' + e.message });
                    });
                });
            }, Promise.resolve());
        }

        return LINK_VIEWS.reduce(function (chain, route) {
            return chain.then(function () {
                return linksOfView(route).then(function (map) {
                    out.views[route] = Object.keys(map).length;
                    return resolve(map);
                });
            });
        }, Promise.resolve()).then(function () {
            return STATIC_PAGES.reduce(function (chain, page) {
                return chain.then(function () {
                    return fetch(page, { cache: 'no-store' }).then(function (r) {
                        if (r.status !== 200) {
                            out.failed.push({ href: page, why: 'page does not load (' + r.status + ')' });
                            return null;
                        }
                        return r.text();
                    }).then(function (html) {
                        if (!html) return;
                        var doc = new DOMParser().parseFromString(html, 'text/html');
                        var map = sameOriginLinks(doc);
                        out.views[page] = Object.keys(map).length;
                        return resolve(map);
                    });
                });
            }, Promise.resolve());
        }).then(function () { return out; });
    }

    // ---------------------------------------------------------------------------------------
    // The functionality that has to work, checked as PAGES WITH CONTENT.
    //
    // A 200 is not enough on this platform: a path the app cannot serve is answered with index.html,
    // which is also a 200 — the failure mode that once put a History link into a search box. So each
    // page is checked for a marker only that page carries, grouped by the area the owner named:
    // multi-tool, search, reader, dictionary, TTS, cloud and Google sign-in.
    //
    // search and reader are covered by the eight request cases above (they answer from the local
    // database); what is left is everything that ships as a file of its own.
    // ---------------------------------------------------------------------------------------
    var PAGE_CHECKS = [
        // Tools / multi-tool. The multi-tool itself is deliberately NOT bundled (owner: the APK
        // should not carry it) — native-bridge opens it in the device's browser, which the routing
        // checks cover. These are the ones that must open inside the app.
        { url: '/assets/lbl.html', title: 'Построчные Переводы', area: 'tools' },
        { url: '/assets/listdiff.html', title: 'Text Links Diff', area: 'tools' },
        { url: '/assets/makelist.html', title: 'Make List from Text', area: 'tools' },
        { url: '/assets/rr.html', title: 'Random Rule', area: 'tools' },
        { url: '/assets/common/abbr.html', title: 'Edition Abbreviations', area: 'tools' },
        { url: '/assets/materials/prat.html', title: 'Буддийский монашеский кодекс', area: 'materials' },
        // Memorisation app, settings, and the two pages the cloud sign-in lives on.
        { url: '/memo/index.html', title: 'Memorize', area: 'memo' },
        { url: '/settings/index.html', title: 'Настройки', area: 'settings' },
        { url: '/login/index.html', title: 'Cloud Sync', area: 'cloud' },
        { url: '/ru/login/index.html', title: 'Cloud Sync', area: 'cloud' },
        // The dictionary's own code (the DPD data itself is fetched from the site on purpose: ~24 MB
        // and updated often) and the reader's voice player, which is what TTS runs through.
        { url: '/assets/js/dict-mode-shared.js', body: 'dict', area: 'dictionary' },
        { url: '/read/js/voice.js', body: 'speechSynthesis', area: 'tts' },
    ];

    function checkPages() {
        var out = { checked: 0, byArea: {}, failed: [] };
        return PAGE_CHECKS.reduce(function (chain, c) {
            return chain.then(function () {
                out.checked++;
                return fetch(c.url, { cache: 'no-store' }).then(function (r) {
                    if (r.status !== 200) {
                        out.failed.push({ area: c.area, url: c.url, why: 'the device cannot load it (' + r.status + ')' });
                        return null;
                    }
                    return r.text();
                }).then(function (body) {
                    if (body === null) return;
                    out.byArea[c.area] = (out.byArea[c.area] || 0) + 1;
                    var want = c.title || c.body;
                    if (body.toLowerCase().indexOf(want.toLowerCase()) === -1) {
                        out.failed.push({ area: c.area, url: c.url, why: 'served something else (no "' + want + '" in it)' });
                    }
                }).catch(function (e) {
                    out.failed.push({ area: c.area, url: c.url, why: 'fetch threw: ' + e.message });
                });
            });
        }, Promise.resolve()).then(function () { return out; });
    }

    // The dictionary's own code. build-assets deliberately does NOT bundle it (nor the ~24 MB DPD
    // data behind it): the app fetches both from the site and caches them, so with no network the
    // honest outcomes are "served from the cache" or "refused, and says why". Silence or a raw stack
    // trace is the failure — a reader tapping a word must be told something they can act on.
    function checkDictionaryCode() {
        return fetch('/assets/js/standalone-dpd/pali-lookup-standalone.js', { cache: 'no-store' })
            .then(function (r) { return r.status === 200 ? { ok: true, how: 'served' } : { ok: false, why: 'HTTP ' + r.status }; })
            .catch(function (e) {
                var msg = (e && e.message) || String(e);
                var honest = /not downloaded|no network/i.test(msg);
                return { ok: honest, how: 'refused: ' + msg, why: honest ? null : 'refused without saying why: ' + msg };
            });
    }

    // The dictionary's mode table: a JSON file the settings UI reads, and the one dictionary asset
    // whose absence is silent (the dropdown would simply be empty).
    function checkDictionaryModes() {
        return fetch('/nodejs/res/dict-modes.json', { cache: 'no-store' })
            .then(function (r) {
                if (r.status !== 200) return { ok: false, why: 'dict-modes.json: ' + r.status };
                return r.json().then(function (data) {
                    var keys = Object.keys(data || {});
                    return { ok: keys.length > 1, keys: keys.length, why: keys.length > 1 ? null : 'the mode table is empty' };
                });
            })
            .catch(function (e) { return { ok: false, why: 'dict-modes.json: ' + e.message }; });
    }

    // Google sign-in, client side: the URL the system browser is sent to. The shape is the contract
    // with dg-node's app-google.html (a one-time state it validates, the package it compares, the
    // language, and the platform that decides whether the token returns through intent:// or
    // dhammagift://). test/login-handoff.test.js checks the other half — what that page sends back.
    function checkSignInUrl() {
        if (typeof window.dgSignInUrl !== 'function') return { ok: false, why: 'no sign-in URL builder in the page' };
        var url = window.dgSignInUrl();
        var ok = /\/login\/app-google\.html\?state=[a-f0-9]{16,64}&pkg=[^&]+&lang=(ru|en)&plat=[a-z]+$/.test(url);
        return { ok: ok, url: url, why: ok ? null : 'unexpected sign-in URL shape' };
    }

    // Dynamic quick actions. Two things are checkable without the Home Screen, which no simulator can
    // show: that the list the page hands over comes back from the system unchanged (set/get round
    // trip through UIApplication.shared.shortcutItems — that is the whole native API), and that a tap
    // opens its route (the plugin posts the app's own deep link, so the app ends up on that page; the
    // isDone branch below fires it once and the next load reports where it landed).
    function checkShortcuts() {
        var p = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.DgShortcuts;
        if (!p || typeof p.set !== 'function' || typeof p.get !== 'function') {
            return Promise.resolve({ present: false, capacitor: !!window.Capacitor });
        }
        var want = { id: 'selftest', label: 'Selftest text', route: '/dn22:2.2' };
        return Promise.resolve(p.set({ items: [want] }))
            .then(function () { return p.get(); })
            .then(function (r) {
                var items = (r && r.items) || [];
                var first = items[0] || {};
                return {
                    present: true,
                    count: items.length,
                    ok: items.length === 1 && first.route === want.route && first.title === want.label,
                    item: first
                };
            })
            .catch(function (e) { return { present: true, error: e.message }; });
    }

    function report$write() {
        // Serialised and remembered before anything else: the plugin branch below returns early in a
        // plain browser, and a later load of this page (the deep-link watcher) merges whatever is
        // stored here — computing json after that early return printed "undefined" and lost the run.
        var json = JSON.stringify(report, null, 2);
        rememberReport(json);
        var Plugins = window.Capacitor && window.Capacitor.Plugins;
        var plugin = Plugins && Plugins.DgSelfTest;
        if (!plugin || typeof plugin.write !== 'function') {
            // Not a failure of the app: a release build has no such plugin, and neither does a plain
            // browser. Print the report instead — that is what makes this same file usable as a
            // local check in Chromium (test/ios-sim/local-check.js) and readable in the simulator's
            // console log if the native write is ever the thing that breaks.
            console.log('DG_SELFTEST_REPORT ' + json);
            return Promise.resolve(false);
        }
        return Promise.resolve(plugin.write({ json: json }))
            .then(function () { return true; })
            .catch(function (e) { console.error('dg-selftest: write failed: ' + e.message); return false; });
    }

    // Leave the app on search results served from the LOCAL database: they are the one screen that
    // proves, at a glance, that the library opened — real hits, real texts, no server. (A reader
    // route would be prettier but is reached by rewriting window.location before the SPA boots, and
    // the SPA's own router is what decides whether a path is a text — search results do not depend
    // on that, and `?q=` on the root is a request the site answers at bootstrap by design: it is what
    // Android's share intent uses.)
    function showLocalResults() {
        var target = '/?q=kacchapa&langs=ru,en';
        report.navigatedTo = target;
        setTimeout(function () { location.replace(target); }, 250);
    }

    function selfDeepLink() {
        report.selfDeepLink = SELF_DEEP_LINK;
        try {
            location.href = SELF_DEEP_LINK;
        } catch (e) {
            report.selfDeepLinkError = e.message;
        }
        // If nothing took over, the same page as before: search results from the local database.
        setTimeout(showLocalResults, 3000);
    }

    // ---------------------------------------------------------------------------------------
    // Second and later loads: the run is done (see DONE_KEY), so this page exists only to report
    // where the app ended up, immediately and unconditionally. That is how the deep-link check
    // works: CI opens dhammagift://... with `simctl openurl`, the app navigates (a real page load,
    // which destroys any polling watcher before it could report), and the fresh load writes its own
    // path out. Which URLs actually arrived is reported too — an app that never received the URL and
    // a mapping that answered it with nothing look identical from here otherwise.
    // ---------------------------------------------------------------------------------------
    function reportCurrentPath() {
        // A quick action tap, once: the plugin posts dhammagift://route/4as and the page cannot stay
        // where it is. Guarded in sessionStorage so the load it causes does not fire it again — the
        // deep link's own loop guard would also stop the second navigation, but a test should not lean
        // on that to terminate.
        try {
            var p = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.DgShortcuts;
            if (p && typeof p.open === 'function' && !sessionStorage.getItem('dg.selftest.shortcutTried')) {
                sessionStorage.setItem('dg.selftest.shortcutTried', '1');
                p.open({ route: '/4as' }).catch(function () { /* reported through deepLinksSeen */ });
            }
        } catch (e) { /* private mode: the tap path is then only covered in the report below */ }

        var received = [];
        try { received = JSON.parse(localStorage.getItem('dg.deeplink.seen') || '[]'); } catch (e) { /* private mode */ }
        rewriteReport({ runs: 2, currentPath: location.pathname + location.search, deepLinksSeen: received });
    }

    function rewriteReport(extra) {
        var out = { runs: 1, currentPath: location.pathname + location.search };
        for (var k in extra) out[k] = extra[k];
        try {
            var previous = JSON.parse(previousReport() || 'null');
            if (previous) for (var p in previous) if (!(p in out)) out[p] = previous[p];
        } catch (e) { /* no previous report: the fresh one still carries the path */ }
        var restored = JSON.stringify(out, null, 2);
        rememberReport(restored);
        var Plugins = window.Capacitor && window.Capacitor.Plugins;
        var plugin = Plugins && Plugins.DgSelfTest;
        if (plugin && typeof plugin.write === 'function') {
            Promise.resolve(plugin.write({ json: restored })).catch(function () { console.log('DG_SELFTEST_REPORT ' + restored); });
        } else {
            console.log('DG_SELFTEST_REPORT ' + restored);
        }
    }

    function previousReport() {
        try { return localStorage.getItem(REPORT_KEY); } catch (e) { return null; }
    }

    // A reload must not re-run the cases: without this the page navigated to its results, the
    // self-test ran again, navigated again, and the app spent the whole run reloading — which is
    // exactly how the first simulator screenshots came back showing a half-loaded home page.
    if (isDone()) {
        reportCurrentPath();
        return;
    }

    var wakeLockSpy = spyWakeLock();

    waitForLibrary()
        .then(function () {
            if (!report.libraryPresent) return;
            return CASES.reduce(function (chain, c) {
                return chain.then(function () { return runCase(c); }).then(function (r) { report.cases.push(r); });
            }, Promise.resolve());
        })
        .then(function () {
            return probeSpeech().then(function (r) { report.speech = r; });
        })
        .then(function () {
            return probeProgressPlugin().then(function (r) { report.progressPlugin = r; });
        })
        .then(function () {
            return probeTtsPlugin().then(function (r) { report.ttsPlugin = r; });
        })
        .then(function () {
            return probeDownloadPlugin().then(function (r) { report.downloadPlugin = r; });
        })
        .then(function () {
            return checkLinks().then(function (r) { report.linkCheck = r; });
        })
        .then(function () {
            return checkPages().then(function (r) { report.pageChecks = r; });
        })
        .then(function () {
            return checkShortcuts().then(function (r) { report.shortcuts = r; });
        })
        .then(function () {
            report.dictionaryModes = checkDictionaryModes();
            report.signInUrl = checkSignInUrl();
            report.dictionaryCode = checkDictionaryCode();
            return report.dictionaryModes;
        })
        .then(function (modes) {
            report.dictionaryModes = modes;
            return report.dictionaryCode;
        })
        .then(function (code) {
            report.dictionaryCode = code;
        })
        .then(function () {
            report.viewport = probeViewport();
            // Read at WRITE time, not at parse time: prepareArchive moves dgPlatform.distBase when
            // the native downloader hands the archive over, so the value captured when this script
            // loaded is the network base and says nothing about where the library actually came
            // from. Run 130's report showed the dead origin next to a library that could only have
            // been imported from the app's own storage — the numbers were right, the label was not.
            report.distBase = (window.dgPlatform && window.dgPlatform.distBase) || report.distBase;
            report.wakeLock = wakeLockSpy;
        })
        .then(function () {
            // Before answering, so a reload cannot make this page run the cases a second time.
            markDone();
            return report$write();
        })
        .then(function (written) {
            window.__dgSelftest = { written: written, report: report };
            // The report is out. Now try the app's own URL scheme, opened FROM THE PAGE: that is the
            // same chain the outside world uses — CFBundleURLTypes, SceneDelegate, Capacitor's
            // appUrlOpen event, then src/deep-link.js's mapping — minus SpringBoard's "Open in
            // Dhamma.gift?" confirmation, which iOS shows for a scheme opened from outside the app
            // and which no headless run can tap. Whatever happens, the app then lands on a page that
            // shows local data, so the screenshots are never a blank frame.
            selfDeepLink();
        });
})();
