// The screenshot tour: walks the app through the functionality that matters and tells the driver when
// each view is on screen.
//
// Injected into www/ only by test/ios-sim/prepare-www.js --tour, which is only ever run on a build
// output tree. Why a tour rather than a fixed list of URLs: what the owner wants pictures of is the
// app DOING things — search results, a text in the reader, the dictionary popup, the settings sheet,
// history, the TOC — and most of those are views the SPA renders itself. From outside the WebView
// nothing can press a button; from inside, the page can, and then say "ready" (DgSelfTest.stage →
// Documents/stage.txt), and the driver screenshots exactly that moment.
//
// The signal is one file overwritten per stage, not a timing guess: a screenshot taken at the wrong
// moment is worse than none, because it looks like a bug.

(function () {
    'use strict';

    var SETTLE_MS = 1200;      // a view that renders instantly still needs a frame to paint
    var READY_TIMEOUT_MS = 30000;
    // How long a view is HELD before the tour moves on. Not politeness: the driver screenshots the
    // simulator from outside, and without a hold it photographed whatever came next — the first run's
    // "search" picture was of the reader. The hold is generous because a missed picture is invisible
    // (there is simply no file), while a wrong one looks like a bug.
    var SHOT_HOLD_MS = 5000;

    function plugin() {
        var P = window.Capacitor && window.Capacitor.Plugins;
        return P && P.DgSelfTest;
    }

    function wait(ms) {
        return new Promise(function (resolve) { setTimeout(resolve, ms); });
    }

    // Wait for something the site renders asynchronously (search hits, reader text, the dictionary
    // popup) instead of sleeping a fixed time and hoping.
    function waitFor(check, timeout) {
        var started = Date.now();
        return new Promise(function (resolve) {
            (function poll() {
                var ok = false;
                try { ok = !!check(); } catch (e) { ok = false; }
                if (ok) return resolve(true);
                if (Date.now() - started > (timeout || READY_TIMEOUT_MS)) return resolve(false);
                setTimeout(poll, 250);
            })();
        });
    }

    function go(route, ready) {
        try {
            history.pushState({}, '', route);
            window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
        } catch (e) { /* the view stays where it was; the screenshot then shows that, which is a fact too */ }
        return waitFor(ready).then(function () { return wait(SETTLE_MS); });
    }

    function stage(name) {
        var P = plugin();
        if (!P || typeof P.stage !== 'function') {
            console.log('dg-tour: no stage plugin, stopping');
            return Promise.resolve(false);
        }
        return Promise.resolve(P.stage({ name: name }))
            .then(function () { return wait(SHOT_HOLD_MS); })
            .then(function () { return true; });
    }

    function textShown() {
        var body = document.body && document.body.innerText || '';
        return body.length > 400;
    }

    // View markers, each one something only that view has. The first version asked for "a table
    // somewhere" and was true on the page it started from — the tour then announced a stage for a
    // view that had not rendered.
    function resultsShown() {
        return document.querySelectorAll('#results-tbody tr').length > 0;
    }

    function readerShown() {
        var sutta = document.getElementById('sutta');
        return !!sutta && (sutta.innerText || '').length > 200;
    }

    function historyShown() {
        return tabShown('tab-fav');
    }

    function tocShown() {
        var pane = document.getElementById('toc-pane');
        return !!pane && pane.children.length > 0;
    }

    // The dictionary, as the app's own quick modal shows it (quickModal.js's tab list: fav, 4as,
    // memo, dpd). Activating it is a click on its tab button — the same click a reader makes — and the
    // wait is for the PANEL to become active, not for the article: the article comes from the DPD data,
    // which the app downloads on demand.
    //
    // What this deliberately is NOT: the word-tap popup in the reader. That lookup is POINTER-based
    // (paliLookup.js: getClickedWordWithHTML(event.target, event.clientX, event.clientY), which
    // hit-tests the coordinates), and synthetic clicks — element.click(), or a MouseEvent carrying the
    // word's own coordinates — did not open it in a headless browser on this build. Rather than ship a
    // picture that pretends, that one stays a device check: one tap on a phone. The reader screenshot
    // next to this file is what a reader sees before tapping.
    function dictionaryShown() {
        var active = document.querySelector('.quick-tab-content.active');
        return !!active && active.id === 'tab-dpd';
    }

    function openDictionaryTab() {
        var btn = document.querySelector('.quick-tab-btn[data-tab="tab-dpd"]');
        if (btn) btn.click();
    }

    // The app's own answer, not a guess at markup: home-bundle.js exposes isSettingsSheetOpen().
    function settingsShown() {
        return !!(window.DgHome && window.DgHome.isSettingsSheetOpen && window.DgHome.isSettingsSheetOpen());
    }

    // A quick-modal tab is on screen when its panel has a layout box.
    function tabShown(id) {
        var el = document.getElementById(id);
        return !!el && el.offsetParent !== null;
    }

    function quickModal() {
        return typeof window.toggleQuickModal === 'function';
    }

    function startWhenReady() {
        // The SPA boots on DOMContentLoaded and renders its first view a moment later; the tour waits
        // for real content rather than for the event.
        return waitFor(textShown).then(function () { return wait(SETTLE_MS); });
    }

    // The app's page lives on capacitor://localhost, and the dictionary preload asks the site for
    // 24MB of DPD data. In the online tour that fetch dies with WebKit's "Request url is not
    // HTTP/HTTPS", which does not say WHICH url it objected to. This asks the same question about a
    // small file the tour does not otherwise need, and writes one console line per answer, so the
    // next run separates "the app cannot fetch from the site at all" from "only the dictionary path
    // is broken". Never rejects: a probe that stops the tour would hide the screenshots.
    function networkProbe() {
        console.log('[dg-net] origin=' + location.origin + ' caches=' + (typeof window.caches) +
                    ' onLine=' + navigator.onLine + ' dictScript=' + (typeof window.dgDictScript));
        var urls = ['https://dhamma.gift/manifest.json',
                    'https://dhamma.gift/config/ai-search.json',
                    // The dictionary the app asks for, small file first: if the small one in the same
                    // directory answers 200 while the big one throws, the problem is the 6MB response,
                    // not the path or the scheme.
                    'https://dhamma.gift/assets/js/standalone-dpd/pali-lookup-standalone.js',
                    'https://dhamma.gift/assets/js/standalone-dpd/dpd_i2h.js'];
        return urls.reduce(function (chain, url) {
            return chain.then(function () {
                var started = Date.now();
                return fetch(url, { cache: 'no-cache' }).then(function (res) {
                    return res.text().then(function (t) {
                        console.log('[dg-net] ' + url + ' -> ' + res.status + ' ' + t.length + 'B in ' + (Date.now() - started) + 'ms');
                    });
                }, function (e) {
                    console.log('[dg-net] ' + url + ' FAILED in ' + (Date.now() - started) + 'ms: ' + (e && e.message));
                });
            });
        }, Promise.resolve()).catch(function (e) { console.log('[dg-net] probe itself failed: ' + (e && e.message)); });
    }

    startWhenReady()
        .then(networkProbe)
        .then(function () { return stage('home'); })
        .then(function (ok) { if (!ok) return Promise.reject(new Error('stopped')); return go('/kacchapa?langs=ru,en', resultsShown); })
        .then(function () { return stage('search'); })
        .then(function () { return go('/dn22:2.2', readerShown); })
        .then(function () { return stage('reader'); })
        .then(function () {
            // The settings sheet, opened the way the app opens it (index.html intercepts the
            // /settings/ link on narrow screens and calls exactly this).
            try {
                if (window.DgHome && typeof window.DgHome.openSettingsSheet === 'function') {
                    window.DgHome.openSettingsSheet();
                }
            } catch (e) { /* shown as it is */ }
            return waitFor(settingsShown, 8000).then(function () { return wait(SETTLE_MS); });
        })
        .then(function () { return stage('settings'); })
        .then(function () {
            // The dictionary: the quick modal's DPD tab, opened by the documented API
            // (window.toggleQuickModal('tab-dpd'), quickModal.js).
            try {
                if (window.DgHome && window.DgHome.closeSettingsSheet) window.DgHome.closeSettingsSheet();
                if (quickModal()) window.toggleQuickModal('tab-fav');
            } catch (e) { /* shown as it is */ }
            return waitFor(function () { return tabShown('tab-fav'); }, 8000)
                .then(function () {
                    try { openDictionaryTab(); } catch (e) { /* shown as it is */ }
                    return waitFor(dictionaryShown, 12000);
                })
                .then(function () { return wait(SETTLE_MS); });
        })
        .then(function () { return stage('dictionary'); })
        .then(function () {
            // Favourites and history — what feeds the "recently read" quick actions.
            try { if (quickModal()) window.toggleQuickModal('tab-fav'); } catch (e) { /* shown as it is */ }
            return waitFor(historyShown, 8000).then(function () { return wait(SETTLE_MS); });
        })
        .then(function () { return stage('favorites-history'); })
        .then(function () {
            try { if (quickModal()) window.toggleQuickModal(); } catch (e) { /* the next view still renders */ }
            return go('/toc', tocShown);
        })
        .then(function () { return stage('toc'); })
        .then(function () { return stage('done'); })
        .catch(function (e) { console.log('dg-tour stopped:', e && e.message); return stage('done'); });
})();
