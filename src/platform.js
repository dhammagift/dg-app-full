// Native platform implementation for the offline layer (dg-node's public/offline/app.js reads
// window.dgPlatform; see its header and docs/OFFLINE_PWA_PLAN.md "platform.js"). This file is
// bundled into www/ and must be the FIRST script on the page (build-page.js injects it at the
// dg:app-scripts marker) so the site's browser platform.js — which loads right after with a
// `if (window.dgPlatform) return` guard — becomes a no-op.
//
// Differences from the browser implementation, all of them app constraints:
//   - distBase: the app's own origin (https://localhost) has no server behind it, so the
//     database and its manifest are fetched from the real site.
//   - onlineBase: every "needs the internet" data request (a language outside the ru+en slice,
//     script conversion, /api/transliterate, and any data request before the library is open)
//     is forwarded to the real site instead of the dead-end local origin.
//   - mapStatic: TOC and the Patimokkha fragments are bundled as static files (build-toc-
//     snapshot.js / build-assets.js), so their API URLs are rewritten to those files — no
//     server exists here to compute them.
//   - askConsent: Wi-Fi proceeds silently (the download card is its own signal); anything else
//     asks through a native dialog (@capacitor/dialog), naming the real byte size from the
//     published manifest.
//   - Auto-download on first open: the app must work offline by definition, so the first launch
//     starts the download by itself (the site is opt-in — its app.js only downloads on an
//     explicit intent key, which this file sets). A decline is remembered, so a reader on
//     mobile data who said no is never asked again on every launch; Settings → Offline
//     library → Download still works.
(function () {
    'use strict';

    var ONLINE_ORIGIN = 'https://dhamma.gift';
    var STATE_KEY = 'dg.offline.state';
    var WANT_DATA_KEY = 'dg.offline.wantData';
    var DECLINED_KEY = 'dg.app.downloadDeclined';

    window.dgPlatform = {
        name: 'native',
        distBase: window.DG_DIST_BASE || (ONLINE_ORIGIN + '/mobile-data'),
        onlineBase: ONLINE_ORIGIN,

        mapStatic: function (p) {
            if (p === '/api/toc') return '/api-snapshots/toc.json';
            if (p.indexOf('/api/toc/book/') === 0) {
                return '/api-snapshots/toc-book-' + decodeURIComponent(p.slice('/api/toc/book/'.length)) + '.json';
            }
            // Bundled as reader/{bu,bi}-pm-fragment.html (build-assets.js ASSETS); the worker
            // has no such route and the local origin has no server.
            if (p.indexOf('/api/patimokkha-fragment/') === 0) {
                var side = p.slice('/api/patimokkha-fragment/'.length);
                if (side === 'bu' || side === 'bi') return '/reader/' + side + '-pm-fragment.html';
            }
            return null;
        },

        askConsent: function (info) {
            var Network = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Network;
            if (!Network) return Promise.resolve(true);
            return Promise.all([Network.getStatus(), manifestBytes(info)]).then(function (out) {
                var status = out[0];
                var bytes = out[1];
                if (status.connectionType === 'wifi') return true;
                if (status.connected === false) return true; // the download itself will fail visibly
                var Dialog = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Dialog;
                if (!Dialog) return true;
                var ru = (localStorage.getItem('dhammaLanguage') || localStorage.getItem('siteLanguage') || 'en') === 'ru';
                var mb = bytes ? Math.round(bytes / (1024 * 1024)) : null;
                var msg = ru
                    ? 'Скачать офлайн-библиотеку' + (mb ? ' (' + mb + ' МБ)' : '') + ' через мобильный интернет?'
                    : 'Download the offline library' + (mb ? ' (' + mb + ' MB)' : '') + ' over mobile data?';
                return Dialog.confirm({
                    title: ru ? 'Офлайн-библиотека' : 'Offline library',
                    message: msg,
                    okButtonTitle: ru ? 'Скачать' : 'Download',
                    cancelButtonTitle: ru ? 'Не сейчас' : 'Not now',
                }).then(function (v) { return !!v.value; });
            }).catch(function () { return true; });
        },
    };

    // The published manifest carries the real size of the file that is about to be transferred.
    // dg-node's app.js calls askConsent({}) — its own consent is a Settings button with the size
    // written next to it, so it has no reason to fetch anything. Here the question IS the dialog,
    // so the number has to come from somewhere: the manifest is a few hundred bytes.
    function manifestBytes(info) {
        if (info && info.bytes) return Promise.resolve(info.bytes);
        var base = (window.dgPlatform && window.dgPlatform.distBase) || (ONLINE_ORIGIN + '/mobile-data');
        return fetch(base.replace(/\/$/, '') + '/db-manifest.json')
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (m) { return m && m.bytes ? m.bytes : null; })
            .catch(function () { return null; });
    }

    // The auto-download intent. Set only when nothing is stored yet (the intent is harmless when a
    // library exists — app.js only acts on it when the probe finds none) and when a previous
    // decline is still standing. The decline flag is cleared by the download itself: once
    // dg.offline.state reports present, the flag is history.
    try {
        var state = JSON.parse(localStorage.getItem(STATE_KEY) || 'null');
        var declined = localStorage.getItem(DECLINED_KEY) === '1';
        if (state && state.present) {
            if (declined) localStorage.removeItem(DECLINED_KEY);
        } else if (!declined) {
            localStorage.setItem(WANT_DATA_KEY, '1');
        }
    } catch (e) { /* private mode / quota — the reader downloads from Settings as on the site */ }

    // Mark a declined auto-download. askConsent cannot distinguish "wifi, silent yes" from a real
    // decline, and the 'offline-data-download-declined' rejection lands in app.js's
    // dgOfflineLibrary promise, not here — so app.js dispatches this event on that exact
    // rejection (small site-side hook) and the flag is remembered.
    window.addEventListener('dg:download-declined', function () {
        try { localStorage.setItem(DECLINED_KEY, '1'); } catch (e) { /* ignore */ }
    });
})();
