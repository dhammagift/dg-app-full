// Native platform implementation for the offline layer (dg-node's public/offline/app.js reads
// window.dgPlatform; see its header and docs/OFFLINE_PWA_PLAN.md "platform.js"). This file is
// bundled into www/ and must be the FIRST script on the page (build-page.js injects it at the
// dg:app-scripts marker) so the site's browser platform.js — which loads right after with a
// `if (window.dgPlatform) return` guard — becomes a no-op.
//
// The app's own origin is https://localhost on Android and capacitor://localhost on iOS — Capacitor's
// defaults, and NOT configurable to https on iOS (it refuses a scheme WKWebView itself handles).
// Nothing here hardcodes either one: this file and native-bridge.js compare against location.origin.
// The difference matters for one thing only — the offline layer needs a secure context, which both
// are (WebKit treats a scheme registered by the embedding app as trustworthy).
//
// Differences from the browser implementation, all of them app constraints:
//   - distBase: the app's own origin has no server behind it, so the database and its manifest are
//     fetched from the real site.
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

    // Test APKs are built with DG_ONLINE_ORIGIN=https://test.dhamma.gift (build-assets.js prepends it).
    var ONLINE_ORIGIN = window.DG_ONLINE_ORIGIN || 'https://dhamma.gift';
    var STATE_KEY = 'dg.offline.state';
    var WANT_DATA_KEY = 'dg.offline.wantData';
    var DECLINED_KEY = 'dg.app.downloadDeclined';

    // search/index.html's quote popup / "open in new tab" check this to take their app branch (a
    // phone has no server behind a second copy of the page); nothing set it since app.js moved to dg-node.
    window.dgOfflineReady = true;
    // Where the published archive and its manifest live on the real site. Always the NETWORK base,
    // even after the archive has been fetched onto the device: the manifest is a few hundred bytes,
    // and pointing it at the local file handler would turn a 404 into "the library is not
    // published" during the update check.
    var REMOTE_BASE = ONLINE_ORIGIN + '/mobile-data';
    var ARCHIVE = 'dg.db.gz';
    var MANIFEST = 'db-manifest.json';

    // The archive, when iOS can fetch it better than a Web Worker can: a WebView's JavaScript is
    // suspended the moment the app leaves the foreground, so DgDownloadPlugin.swift puts the 216 MB
    // transfer on the system's background URLSession. What the worker then downloads is the FILE,
    // from the app's own handler — a local read that takes seconds instead of minutes, which is why
    // it survives the round trip to the background. The offline layer asks for this after consent
    // and before its transfer (dg-node's offline/app.js, prepareArchive), so the consent sheet, the
    // progress card and the update path are untouched: only the source of the bytes moves.
    //
    // Android has no such plugin (its foreground service does the same job for the worker's own
    // fetch) and a browser has no Capacitor at all, so both keep the code path they have always had.
    function localBaseFor(path) {
        var Cap = window.Capacitor;
        if (!path || !Cap || typeof Cap.convertFileSrc !== 'function') return null;
        var dir = path.replace(/\/[^/]*$/, '');
        var url = Cap.convertFileSrc(dir);
        return url ? url.replace(/\/$/, '') : null;
    }

    function prepareArchive() {
        var Plugins = window.Capacitor && window.Capacitor.Plugins;
        var D = Plugins && Plugins.DgDownload;
        if (!D || typeof D.start !== 'function' || typeof D.existing !== 'function') return Promise.resolve(false);

        function adopt(file) {
            // A non-empty path, not a size: the plugin deliberately does not read file metadata (see
            // DgDownloadPlugin.swift — it is a required-reason API and would drag a privacy manifest
            // in behind it), and the byte counts arrive through the download's progress events.
            var base = file && file.path ? localBaseFor(file.path) : null;
            if (!base) return false;
            window.dgPlatform.distBase = base;
            return true;
        }

        return Promise.resolve(D.existing()).then(function (onDisk) {
            if (adopt(onDisk)) return true;   // a previous run's archive: import it, no transfer at all
            return Promise.resolve(D.start({ url: REMOTE_BASE + '/' + ARCHIVE })).then(function (file) {
                // The manifest has to sit beside the archive: db-worker.js names the OPFS file after
                // its build_id and reads file_gz from it, so a local base without one would be read
                // as a plain, uncompressed database and rejected.
                return Promise.resolve(D.start({ url: REMOTE_BASE + '/' + MANIFEST }))
                    .then(function () { return file; });
            }).then(adopt);
        }).catch(function () { return false; });   // refused, offline, plugin unhappy: the worker's own path
    }

    window.dgPlatform = {
        name: 'native',
        distBase: window.DG_DIST_BASE || REMOTE_BASE,
        onlineBase: ONLINE_ORIGIN,
        prepareArchive: prepareArchive,

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

        askConsent: function () {
            var Network = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Network;
            if (!Network) return Promise.resolve(true);
            return Promise.all([Network.getStatus(), readManifest()]).then(function (out) {
                var status = out[0];
                var m = out[1] || {};
                if (status.connectionType === 'wifi') return true;
                if (status.connected === false) return true; // the download itself will fail visibly
                // The site's own consent sheet (dg-node offline-status.js, 'dg:need-consent'): themed,
                // both figures — the archive that downloads and the database on the device. The native
                // AlertDialog showed only the on-device size ("584 MB"), which read as the download.
                return new Promise(function (resolve) {
                    var answered = false;
                    window.dispatchEvent(new CustomEvent('dg:need-consent', { detail: {
                        bytes: m.bytes, bytesGz: m.bytes_gz, langs: m.langs,
                        resolve: function (p) { answered = true; resolve(p); },
                    } }));
                    if (!answered) resolve(nativeConsent(m));
                });
            }).catch(function () { return true; });
        },
    };

    // Fallback for a page without offline-status.js.
    function nativeConsent(m) {
        var Dialog = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Dialog;
        if (!Dialog) return true;
        var ru = (localStorage.getItem('dhammaLanguage') || localStorage.getItem('siteLanguage') || 'en') === 'ru';
        var mb = function (b) { return Math.round(b / 1048576) + (ru ? ' МБ' : ' MB'); };
        var size = m.bytes_gz && m.bytes
            ? (ru ? ' (скачать ' + mb(m.bytes_gz) + ', на устройстве ' + mb(m.bytes) + ')' : ' (' + mb(m.bytes_gz) + ' download, ' + mb(m.bytes) + ' on device)')
            : '';
        return Dialog.confirm({
            title: ru ? 'Офлайн-библиотека' : 'Offline library',
            message: ru ? 'Скачать офлайн-библиотеку' + size + ' через мобильный интернет?'
                        : 'Download the offline library' + size + ' over mobile data?',
            okButtonTitle: ru ? 'Скачать' : 'Download',
            cancelButtonTitle: ru ? 'Не сейчас' : 'Not now',
        }).then(function (v) { return !!v.value; });
    }

    // The published manifest carries the real sizes: bytes_gz is what crosses the connection, bytes is
    // the database it unpacks into. A few hundred bytes.
    function readManifest() {
        var base = REMOTE_BASE;
        return fetch(base.replace(/\/$/, '') + '/db-manifest.json')
            .then(function (r) { return r.ok ? r.json() : null; })
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
    // A library the reader deleted in Settings must not come straight back: without this the next
    // launch saw "nothing stored, never declined" and started the 216 MB download on its own. The
    // same flag as a decline; it clears once a library is present again (Settings → Download).
    window.addEventListener('message', function (event) {
        if (event.origin !== location.origin || !event.data || !event.data.dgOfflineDeleteRequest) return;
        try { localStorage.setItem(DECLINED_KEY, '1'); localStorage.removeItem(WANT_DATA_KEY); } catch (e) { /* private mode */ }
    });
    window.addEventListener('dg:download-declined', function () {
        try { localStorage.setItem(DECLINED_KEY, '1'); } catch (e) { /* ignore */ }
    });
})();
// The speechSynthesis stand-in lives in src/tts.js now: every page with the voice player needs it.
