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

    // ---------------------------------------------------------------------------------------
    // Second and later loads: the run is done (see DONE_KEY), so this page exists only to report
    // where the app ends up. That is how the deep-link check works — CI opens dhammagift://... with
    // `simctl openurl`, and the only way to see the result from outside the WebView is for the page
    // to write down its own path.
    // ---------------------------------------------------------------------------------------
    function watchRoute() {
        var last = location.pathname + location.search;
        var seen = [];
        setInterval(function () {
            var now = location.pathname + location.search;
            if (now === last) return;
            last = now;
            seen.push(now);
            rewriteReport({ runs: 2, currentPath: now, routeHistory: seen });
        }, 500);
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
        watchRoute();
        return;
    }

    waitForLibrary()
        .then(function () {
            if (!report.libraryPresent) return;
            return CASES.reduce(function (chain, c) {
                return chain.then(function () { return runCase(c); }).then(function (r) { report.cases.push(r); });
            }, Promise.resolve());
        })
        .then(function () {
            // Before answering, so a reload cannot make this page run the cases a second time.
            markDone();
            return report$write();
        })
        .then(function (written) {
            window.__dgSelftest = { written: written, report: report };
            // Navigate either way: the report is already out (file or console), and leaving the app
            // on a page that shows local data is what makes the screenshots CI takes show the app
            // itself rather than its home screen.
            showLocalResults();
        });
})();
