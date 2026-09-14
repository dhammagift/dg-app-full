// Resolves every real asset search/index.html references — the static <script>/<link> tags plus
// everything ensureSearchAssets()/ensureReaderAssets()/ensureTocAssets() lazily inject inside that
// file's own inline SPA engine — and copies each one into www/ at the IDENTICAL relative URL path
// production serves it at. That's the whole point: the generated index.html (build-page.js) needs
// zero path edits, because every /assets/..., /reader/..., /nodejs/res/... URL it requests already
// resolves on disk exactly the way dg-light.js's static mounts resolve it.
//
// Mirrors dg-light.js's override-then-legacy resolution order (public/overrides/... wins, the
// legacy asset tree is the fallback) — see paths.js for where those two roots come from.
//
// ponytail: the ASSETS list below is hand-maintained, so a NEW <script> added to the site has to
// be added here too — exactly the manual syncing this repo split is meant to end. The planned
// replacement is a Playwright crawl of a running dg-light.js that saves every 200 response at its
// own URL path, which also makes buildScriptBundles()/buildModeTable() below unnecessary (the
// server already serves both). Kept as-is for now so the split lands without also changing how
// the app is built.
//
// Also regenerates the two script bundles dg-light.js's buildScriptBundle() builds at server
// startup (there's no server here to do that for us), plus reader/mode-table.json's
// server-computed `availableLangs` field (normally a directory scan dg-light.js does at request
// time) baked to whatever languages this build actually bundles.
//
// Usage: node build-assets.js [--langs=ru,en]

const fs = require('fs');
const path = require('path');
const { NODEJS_ROOT, LEGACY_ASSETS, WWW, SRC, requireNodeRoot, f, l } = require('./paths');

// The legacy repo's ROOT (paths.js exposes its assets/ dir; /read/** and /memorize/** live beside
// it, not inside it).
const LEGACY_ROOT = path.dirname(LEGACY_ASSETS);
const lr = rel => path.join(LEGACY_ROOT, rel);

function parseArgs() {
    const args = { langs: ['ru', 'en'] };
    for (const arg of process.argv.slice(2)) {
        const [key, value] = arg.replace(/^--/, '').split('=');
        if (key === 'langs') args.langs = value.split(',');
    }
    return args;
}

// { url: where search/index.html fetches it from, sources: candidate absolute paths, first
// existing one wins — same precedence as dg-light.js's override-then-legacy static mounts }
const ASSETS = [
    // ---- head, eager ----
    { url: '/assets/js/dhamma-i18n.js', sources: [f('public/overrides/js/dhamma-i18n.js')] },
    { url: '/assets/js/mirror-link.js', sources: [f('public/overrides/js/mirror-link.js')] },
    { url: '/assets/js/ai-search.js', sources: [f('public/overrides/js/ai-search.js')] },
    { url: '/assets/js/dict-mode-shared.js', sources: [f('public/overrides/js/dict-mode-shared.js')] },
    // Lazy-loaded by autopali.js for fuzzy Pali suggestions.
    { url: '/assets/js/pali-skeleton.js', sources: [f('public/overrides/js/pali-skeleton.js')] },
    // Imported by the offline worker for ?script= conversion (Devanagari, Thai, ...).
    { url: '/assets/js/pali-script.js', sources: [f('public/overrides/js/pali-script.js')] },
    { url: '/manifest.json', sources: [f('configs/manifest.json')] },
    { url: '/nodejs/res/menu-links.json', sources: [f('configs/search/menu-links.json')] },
    { url: '/assets/img/favico-noglass.png', sources: [l('img/favico-noglass.png')] },
    { url: '/assets/css/bootstrap.5.3.1.min.css', sources: [l('css/bootstrap.5.3.1.min.css')] },
    { url: '/assets/css/langswitch.css', sources: [f('public/overrides/css/langswitch.css')] },
    { url: '/assets/css/paliLookup.css', sources: [l('css/paliLookup.css')] },
    { url: '/assets/css/extrastyles.css', sources: [l('css/extrastyles.css')] },
    { url: '/assets/js/fontawesome-local.js', sources: [f('public/overrides/js/fontawesome-local.js')] },
    { url: '/assets/css/table.css', sources: [l('css/table.css')] },
    { url: '/nodejs/res/css/home.css', sources: [f('search/css/home.css')] },
    { url: '/assets/js/jquery-3.7.0.min.js', sources: [l('js/jquery-3.7.0.min.js')] },
    { url: '/assets/js/bootstrap.bundle.5.3.1.min.js', sources: [l('js/bootstrap.bundle.5.3.1.min.js')] },
    { url: '/assets/js/openFdg.js', sources: [l('js/openFdg.js')] },
    { url: '/assets/js/smoothScroll.js', sources: [f('public/overrides/js/smoothScroll.js')] },
    { url: '/assets/js/langswitch.js', sources: [f('public/overrides/js/langswitch.js')] },
    { url: '/assets/js/themeswitch.js', sources: [l('js/themeswitch.js')] },
    { url: '/assets/js/openDicts.js', sources: [l('js/openDicts.js')] },
    { url: '/assets/js/autopali.js', sources: [f('public/overrides/js/autopali.js')] },
    { url: '/assets/js/uihelp.js', sources: [l('js/uihelp.js')] },
    { url: '/assets/css/jquery-ui.min.css', sources: [l('css/jquery-ui.min.css')] },
    { url: '/assets/js/jquery-ui.min.js', sources: [l('js/jquery-ui.min.js')] },
    // paliLookup.js itself is a local script (Category B). Its dict.dhamma.gift iframe modes
    // ("dpdfull" etc, and the "newwindow" mode) are genuinely online-only (Category C) and
    // deliberately not shimmed. BUT: owner (real usage) — "не работает словарь встроенный" —
    // "standalone"/"standaloneru" (word-tap popup dictionary) is actually the DEFAULT mode
    // whenever the user hasn't picked one (see paliLookup.js's own fallback right after
    // `if (savedDict) {...} else { savedDict = "standalone(ru)" }`), and it's fully offline —
    // it works off 3 plain JS data files (dpd_i2h/dpd_deconstructor/dpd_ebts, ~24MB for both
    // langs), no dict.dhamma.gift involved at all. Those 3 were the actual missing piece.
    { url: '/assets/js/paliLookup.js', sources: [f('public/overrides/js/paliLookup.js')] },
    { url: '/assets/js/standalone-dpd/dpd_i2h.js', sources: [l('js/standalone-dpd/dpd_i2h.js')] },
    { url: '/assets/js/standalone-dpd/dpd_deconstructor.js', sources: [l('js/standalone-dpd/dpd_deconstructor.js')] },
    { url: '/assets/js/standalone-dpd/dpd_ebts.js', sources: [l('js/standalone-dpd/dpd_ebts.js')] },
    { url: '/assets/js/standalone-dpd/ru/dpd_ebts.js', sources: [l('js/standalone-dpd/ru/dpd_ebts.js')] },
    // Lazy-loaded by settings.js's toggleQuickModal() stub (script.src = "/assets/js/quickModal.js")
    // on first Quick Menu open — was missing here entirely, so that fetch 404'd and History/
    // Favorites/Quick search never rendered offline (the stub silently swallows script.onerror).
    { url: '/assets/js/quickModal.js', sources: [f('public/overrides/js/quickModal.js')] },
    // Find-on-page (Ctrl+F replacement, search/index.html's own tags). Added to the site after
    // this list was written, so the app shipped a page whose two <script> tags resolved to
    // index.html — the "Unexpected identifier" class of failure below is exactly what that looks
    // like on a device. verifyPageAssets() now fails the build for the next one.
    { url: '/assets/js/dg-page-find.js', sources: [f('public/overrides/js/dg-page-find.js')] },
    { url: '/assets/js/dg-page-find-ui.js', sources: [f('public/overrides/js/dg-page-find-ui.js')] },
    { url: '/assets/img/buttons/chrome-cta.png', sources: [l('img/buttons/chrome-cta.png')] },
    { url: '/assets/img/buttons/firefox-cta.png', sources: [l('img/buttons/firefox-cta.png')] },
    { url: '/assets/img/buttons/edge-cta.png', sources: [l('img/buttons/edge-cta.png')] },
    { url: '/assets/img/buttons/opera-cta.png', sources: [l('img/buttons/opera-cta.png')] },
    { url: '/assets/img/buttons/google-play-cta.png', sources: [l('img/buttons/google-play-cta.png')] },
    { url: '/assets/img/buttons/apk-cta.png', sources: [l('img/buttons/apk-cta.png')] },
    { url: '/assets/img/buttons/telegram-cta.png', sources: [l('img/buttons/telegram-cta.png')] },

    // ---- ensureSearchAssets() (lazy, first search) ----
    { url: '/assets/js/datatables/datatables.min.css', sources: [l('js/datatables/datatables.min.css')] },
    { url: '/assets/js/datatables/datatables.min.js', sources: [l('js/datatables/datatables.min.js')] },
    { url: '/assets/js/search-render.js', sources: [f('public/overrides/js/search-render.js')] },
    { url: '/assets/js/natural.js', sources: [l('js/natural.js')] },
    { url: '/assets/js/strip-html.js', sources: [l('js/strip-html.js')] },

    // ---- ensureReaderAssets() (lazy, idle-prefetched) ----
    { url: '/reader/css/index.css', sources: [f('reader/css/index.css')] },
    { url: '/reader/css/rus-multi.css', sources: [f('reader/css/rus-multi.css')] },
    // @font-face src in both reader CSS files above — a url() inside a stylesheet, so no
    // <link>/<script> tag points at it and nothing but this entry pulls it in.
    { url: '/reader/css/roboto-lightest.woff', sources: [f('reader/css/roboto-lightest.woff'), l('../read/css/roboto-lightest.woff')] },
    { url: '/reader/css/uiextra.css', sources: [f('reader/css/uiextra.css')] },
    { url: '/assets/js/copyToClipboard.js', sources: [f('public/overrides/js/copyToClipboard.js')] },
    { url: '/assets/js/linksdpr.js', sources: [l('js/linksdpr.js')] },
    { url: '/assets/js/linksbjt.js', sources: [l('js/linksbjt.js')] },
    { url: '/assets/js/linksbw.js', sources: [l('js/linksbw.js')] },
    { url: '/assets/js/linksru.js', sources: [l('js/linksru.js')] },
    { url: '/reader/common.js', sources: [f('reader/common.js')] },
    { url: '/reader/megareader.js', sources: [f('reader/megareader.js')] },

    // ---- loadPiEnRuScripts() / wireResultLinks() (lazy, quick-link columns) ----
    { url: '/assets/js/openDpr.js', sources: [l('js/openDpr.js')] },
    { url: '/assets/js/openRu.js', sources: [l('js/openRu.js')] },
    { url: '/assets/js/openBw.js', sources: [l('js/openBw.js')] },

    // ---- ensureTocAssets() — TOC data (/api/toc*) is deliberately not shimmed yet (deferred,
    // see plan), but the script itself is cheap to ship so the TOC pane fails softly (empty/error
    // state) instead of a script-load error. ----
    { url: '/spa/toc.js', sources: [f('public/spa/toc.js')] },

    // ---- static config JSON/HTML (category B — server just serves these as files, no logic) ----
    { url: '/reader/translator-priority.json', sources: [f('configs/reader/translator-priority.json')] },
    { url: '/reader/lang_ru.json', sources: [f('configs/reader/lang_ru.json')] },
    { url: '/reader/lang_en.json', sources: [f('configs/reader/lang_en.json')] },
    // Thai interface (the menu's "DG (th)", /?lang=th): without these the app fell back to English and
    // reported "Unable to load localization config (404)" (app error log, the tablet).
    { url: '/reader/lang_th.json', sources: [f('configs/reader/lang_th.json')] },
    { url: '/reader/bu-pm-fragment.html', sources: [f('reader/bu-pm-fragment.html')] },
    { url: '/reader/bi-pm-fragment.html', sources: [f('reader/bi-pm-fragment.html')] },
    { url: '/assets/js/translators.json', sources: [l('js/translators.json')] },
    // dg-node's offline shim caches this one explicitly for offline use (OFFLINE_EXTRA_URLS in
    // public/offline/app.js). The app has no service worker, so the file has to BE there — miss
    // it and reader translator labels silently disappear offline.
    { url: '/assets/js/translators.js', sources: [l('js/translators.js')] },
    { url: '/nodejs/res/lang_ru.json', sources: [f('configs/search/lang_ru.json')] },
    { url: '/nodejs/res/lang_en.json', sources: [f('configs/search/lang_en.json')] },
    { url: '/assets/i18n/lang_global_en.json', sources: [f('public/overrides/i18n/lang_global_en.json')] },
    { url: '/assets/i18n/lang_global_ru.json', sources: [f('public/overrides/i18n/lang_global_ru.json')] },
    { url: '/nodejs/res/lang_th.json', sources: [f('configs/search/lang_th.json')] },
    { url: '/assets/i18n/lang_global_th.json', sources: [f('public/overrides/i18n/lang_global_th.json')] },
    { url: '/nodejs/res/slides.json', sources: [f('configs/search/slides.json')] },
    { url: '/nodejs/res/announcements.json', sources: [f('configs/search/announcements.json')] },
    { url: '/nodejs/res/dict-modes.json', sources: [f('configs/search/dict-modes.json')] },
    { url: '/settings/scripts.json', sources: [f('settings/scripts.json')] },
    // Server-generated at startup (buildTranslatorCatalogCache in dg-light.js) — static once
    // built, same treatment as settings-bundle.js/home-bundle.js above: snapshot the current
    // file rather than reimplement the aggregation. Used by /spa/toc.js for translator badges.
    { url: '/settings/translator-catalog.json', sources: [f('settings/translator-catalog.json')] },
    // Master settings page (settings/index.html) — a SEPARATE page from search/index.html (the
    // gear icon does a real navigation to /settings/, not a modal), copied verbatim the same way,
    // plus its own small dependency surface (all static — no server logic beyond what's already
    // bundled above). buildSettingsDemoCache()/buildLangCountsCache() in dg-light.js generate the
    // two JSON files at server startup — same one-time-snapshot treatment as translator-catalog.
    { url: '/settings/index.html', sources: [f('settings/index.html')] },
    { url: '/settings/preview-frame.html', sources: [f('settings/preview-frame.html')] },
    { url: '/settings/demo-data.json', sources: [f('settings/demo-data.json')] },
    { url: '/settings/lang-counts.json', sources: [f('settings/lang-counts.json')] },
    { url: '/assets/css/styles.css', sources: [l('css/styles.css')] },
    { url: '/assets/texts/sutta_words.txt', sources: [l('texts/sutta_words.txt')] },
    { url: '/assets/js/textinfo.js', sources: [l('js/textinfo.js')] },

    // ---- header/shell images (the persistent search bar's surrounding chrome) ----
    { url: '/assets/img/dgsanhkalogo.png', sources: [l('img/dgsanhkalogo.png')] },
    { url: '/assets/img/dgsankhaonly.png', sources: [l('img/dgsankhaonly.png')] },
    { url: '/assets/img/gray.png', sources: [l('img/gray.png')] },
    { url: '/assets/img/logo4nt_plain.png', sources: [l('img/logo4nt_plain.png')] },
    { url: '/assets/img/read/favicon-black.png', sources: [l('img/read/favicon-black.png')] },
    // /manifest.json is bundled (configs/manifest.json) and both browsers and Android's own
    // install machinery fetch the icons it declares; without them the manifest points at 404s.
    { url: '/assets/img/pwa-bold-monocolor-192.png', sources: [l('img/pwa-bold-monocolor-192.png')] },
    { url: '/assets/img/pwa-bold-monocolor-512.png', sources: [l('img/pwa-bold-monocolor-512.png')] },
];


function copyAsset({ url, sources }) {
    const src = sources.find(p => fs.existsSync(p));
    if (!src) {
        console.warn(`MISSING: ${url} — none of ${sources.join(', ')} exist`);
        return false;
    }
    const dest = path.join(WWW, url);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    return true;
}

// Same concatenation dg-light.js's buildScriptBundle() does at server startup — copied, not
// require()'d, to keep mobile/ decoupled from the live server (CLAUDE.md, project memory).
function buildScriptBundles() {
    const pairs = [
        { out: '/assets/js/settings-bundle.js', sources: [
            f('public/overrides/js/settings.js'),
            f('public/overrides/js/dg-text-router.js'),
        ] },
        { out: '/assets/js/home-bundle.js', sources: [
            f('public/overrides/js/randPlaceholder.js'),
            f('search/js/home.js'),
        ] },
    ];
    for (const { out, sources } of pairs) {
        const parts = sources.map(src => `// ---- ${path.relative(NODEJS_ROOT, src)} ----\n${fs.readFileSync(src, 'utf8')}`);
        let content = parts.join('\n;\n');
        if (out.endsWith('settings-bundle.js')) {
            // ponytail: the probe is already dead code under Capacitor's default `localhost`
            // hostname (its own guard skips it there) — this is defense-in-depth, not a fix for
            // an active bug. Upgrade path if that ever changes: make the probe itself Capacitor-aware.
            content = content.replace(
                "if (window.location.hostname !== '127.0.0.1' && window.location.hostname !== 'localhost') {",
                "if (false) { // ponytail: neutered for offline app build (mobile/build-assets.js) — no local dev server to redirect to"
            );
        }
        const dest = path.join(WWW, out);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, content, 'utf8');
    }
}

// dg-light.js serves this by hand-merging the static file with a directory-scan-computed
// `availableLangs` (READER_LANGS) — no live server here to scan anything, so bake it to whatever
// this build actually bundles (mobile/dist/lang_<code>.db, see build-offline-db.js).
function buildModeTable(langs) {
    const modeTable = JSON.parse(fs.readFileSync(f('configs/reader/mode-table.json'), 'utf8'));
    const dest = path.join(WWW, 'reader', 'mode-table.json');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, JSON.stringify({ ...modeTable, availableLangs: langs }, null, 2), 'utf8');
}

function copySvgIcons() {
    const destDir = path.join(WWW, 'assets', 'svg');
    fs.mkdirSync(destDir, { recursive: true });
    // Legacy icons first, dg-node's public/overrides/svg on top — the site's /assets mount order.
    // Only the legacy set was copied, so a new icon added in dg-node (table-list.svg for the nav bar)
    // was missing from the app and failed verifyReferencedAssets.
    let count = 0;
    for (const srcDir of [path.join(LEGACY_ASSETS, 'svg'), f('public/overrides/svg')]) {
        if (!fs.existsSync(srcDir)) continue;
        for (const name of fs.readdirSync(srcDir)) {
            const from = path.join(srcDir, name);
            if (!fs.statSync(from).isFile()) continue;
            fs.copyFileSync(from, path.join(destDir, name));
            count++;
        }
    }
    return count;
}

function copyReaderImages() {
    const srcDir = f('reader/images');
    if (!fs.existsSync(srcDir)) {
        console.warn(`MISSING: reader/images directory does not exist`);
        return;
    }
    const destDir = path.join(WWW, 'reader', 'images');
    fs.mkdirSync(destDir, { recursive: true });
    for (const name of fs.readdirSync(srcDir)) {
        fs.copyFileSync(path.join(srcDir, name), path.join(destDir, name));
    }
}

// settings/index.html is copied verbatim (via ASSETS above) on every run — this patches the
// copy afterward, same one-liner every time, so a re-run after a site update doesn't silently
// drop it. Gives the "Log in" button (native-bridge.js) a real browser to run Google/Firebase
// auth in — see that file's header for why the WebView itself can't do it.
function injectNativeBridge() {
    const dest = path.join(WWW, 'settings', 'index.html');
    let html = fs.readFileSync(dest, 'utf8');
    const tag = '<script src="/native-bridge.js"></script>\n';
    if (!html.includes(tag)) html = html.replace('<head>', `<head>\n${tag}`);
    fs.writeFileSync(dest, html, 'utf8');
}

// Same patch-the-copy pattern as injectNativeBridge() above, applied to the same file — adds
// the "Offline library" status/download row (and a disabled "Offline docs" placeholder, see
// build-assets.js's copyDocs-removal comment) to the live settings page's own "Данные"/"Data"
// section. Markup only; offline-library-settings.js (separate file) does the actual status
// check + bilingual text, so this stays a dumb structural patch, safe to re-run every build.
function injectOfflineLibraryRow() {
    const dest = path.join(WWW, 'settings', 'index.html');
    let html = fs.readFileSync(dest, 'utf8');
    const marker = '<div class="rows">\n      <div class="row">\n        <div><p class="row-title" id="t-clearHist">';
    const rows = `<div class="rows">
      <div class="row" id="dgOfflineLibRow">
        <div><p class="row-title" id="dgOfflineLibTitle">Offline library</p><p class="row-desc" id="dgOfflineLibDesc">&nbsp;</p></div>
        <div class="row-control"><button class="btn" type="button" id="dgOfflineLibBtn">Download now</button></div>
      </div>
      <div class="row">
        <div><p class="row-title" id="dgOfflineDocsTitle">Offline docs<span class="badge">soon</span></p><p class="row-desc" id="dgOfflineDocsDesc">&nbsp;</p></div>
        <div class="row-control"><button class="btn" type="button" disabled>Download</button></div>
      </div>
      <div class="row">
        <div><p class="row-title" id="t-clearHist">`;
    if (!html.includes('id="dgOfflineLibRow"')) {
        // A warning used to be enough here. It is not: this row is the ONLY way a reader can see
        // whether the library downloaded, retry a failed download, or take an update, so a build
        // that quietly skips it ships an app with no route to any of that — and the warning
        // scrolls past in a CI log nobody reads on a green run.
        if (!html.includes(marker)) {
            throw new Error(
                'injectOfflineLibraryRow: anchor not found in settings/index.html.\n' +
                'The Data section markup changed upstream in dg-node. Update `marker` to match it — ' +
                'without this row there is no way to download, retry, or update the offline library.'
            );
        }
        html = html.replace(marker, rows);
    }
    // dg-node's own settings page now ships this row AND its script tag
    // (/offline/offline-library-settings.js, copied with the offline layer below). The legacy
    // root-path tag is still recognised so an older dg-node checkout keeps working, but it must
    // not be added twice: /offline-library-settings.js no longer exists in www/.
    // Matched on src=, not on the whole tag: the site's own tag carries `defer`, and comparing a
    // whole tag string without it appended a second copy (two scripts, two status renders).
    const tag = '<script src="/offline/offline-library-settings.js"';
    const legacyTag = '<script src="/offline-library-settings.js"';
    const hasScript = html.includes(tag) || html.includes(legacyTag);
    if (!hasScript) {
        html = html.replace('</body>', `${tag}></script>\n</body>`);
    }
    if (!html.includes('id="dgOfflineLibBtn"') || !(html.includes(tag) || html.includes(legacyTag))) {
        throw new Error('injectOfflineLibraryRow: the row or its script is not in the output page');
    }
    fs.writeFileSync(dest, html, 'utf8');
}

// Same patch-the-copy pattern as injectOfflineLibraryRow() above, one more row in the same
// "Данные"/"Data" section. No row-control/button (native-bridge.js makes the whole row itself
// the control: tapping it copies the version string) — matches this app's other injected rows'
// convention of a plain hardcoded English title, no site i18n hook.
function injectAppVersionRow() {
    const dest = path.join(WWW, 'settings', 'index.html');
    let html = fs.readFileSync(dest, 'utf8');
    const marker = `<div class="row-control"><button class="btn btn-danger" type="button" id="resetAllBtn">Сбросить</button></div>
      </div>
    </div>
  </section>`;
    const withRow = `<div class="row-control"><button class="btn btn-danger" type="button" id="resetAllBtn">Сбросить</button></div>
      </div>
      <div class="row" id="dgDynShortcutsRow">
        <div><p class="row-title" id="dgDynShortcutsTitle">Recent texts in app shortcuts</p><p class="row-desc" id="dgDynShortcutsDesc">Long-press the app icon.</p></div>
        <div class="row-control"><span class="switch"><input type="checkbox" id="dgDynShortcuts" checked><span class="track"></span><span class="thumb"></span></span></div>
      </div>
      <div class="row" id="dgAppVersionRow" style="cursor:pointer">
        <div><p class="row-title" id="dgAppVersionTitle">App version</p><p class="row-desc" id="dgAppVersionDesc">&nbsp;</p></div>
      </div>
    </div>
  </section>`;
    if (!html.includes('id="dgAppVersionRow"')) {
        if (!html.includes(marker)) {
            throw new Error(
                'injectAppVersionRow: anchor not found in settings/index.html.\n' +
                'The Data section markup changed upstream in dg-node. Update `marker` to match it.'
            );
        }
        html = html.replace(marker, withRow);
    }
    fs.writeFileSync(dest, html, 'utf8');
}

// dg-docs (Help/Docs portal): deliberately NOT bundled. First cut baked the ~23MB Docusaurus
// build (en+ru) into the APK, but owner (weighing APK size vs. offline benefit): docs are read
// occasionally, not offline-critical the way search/reader are — the DB download at first launch
// already costs real MB/time, docs shouldn't tax every install for content most sessions never
// open. native-bridge.js routes /docs and /ru/docs links to the live site instead (same treatment
// as memo/login — see that file). A real "download docs for offline" toggle is a bigger separate
// feature (packaging+extracting a whole static site tree at runtime, not a single blob like the
// DBs) — worth doing if actually wanted, not implemented here.

// Whole static trees from the legacy repo that the site's own pages link to.
//
// Why trees and not more entries in ASSETS: a path the app does not have is NOT a 404 on a
// device — Capacitor answers it with the root index.html, so the reader sees the search page
// instead of the page they tapped. That is how "History" (burger + tile), "Materials", "Abbr."
// and the grammar pages were broken in the app while looking perfectly fine in a browser (a real
// 404 there, and nobody clicks 404s). Owner: "много нюансов... содержание неполная копия".
//
// Sizes are what makes this affordable (measured): common 0.4M, grammar 64K, css 2.8M, img 22M,
// js/grammar 104K, js/dark-mode-switch 120K, diff 116K, repeat-timer 5.4M. NOT copied wholesale:
// materials (75M) and texts (147M) — only the handful of files actually linked from the UI.
const ASSET_TREES = [
    'common', 'grammar', 'css', 'js/grammar', 'js/dark-mode-switch', 'diff',
];

// Called BEFORE the ASSETS loop on purpose: this copies the legacy tree, and the ASSETS loop then
// overlays public/overrides/* on top. The reverse order silently replaced OUR files with legacy
// ones — /assets/svg/star.svg (the shortcut icon) was being overwritten by the legacy star on every
// build, and the same applied to every CSS/JS the app overrides.
function copyAssetTrees() {
    let done = 0;
    for (const rel of ASSET_TREES) {
        const from = l(rel);
        if (!fs.existsSync(from)) {
            console.warn(`SKIP asset tree ${rel} — not present in the legacy tree`);
            continue;
        }
        const dest = path.join(WWW, 'assets', rel);
        copyTree(from, dest);
        // Then the overrides for the same tree, so the app serves what the site serves: same
        // override-then-legacy precedence as dg-light.js's static mounts.
        const override = f(path.join('public', 'overrides', rel));
        if (fs.existsSync(override)) copyTree(override, dest);
        done++;
    }
    // Site-only pages (native-bridge.js opens them online), a test page and a library's demo page come
    // along with the trees; server-side leftovers (.php, *Bak*) are not pages at all (owner).
    for (const url of SITE_ONLY_PATHS.concat(['/assets/diff/test.html', '/assets/js/dark-mode-switch/index.html'])) {
        fs.rmSync(path.join(WWW, url), { force: true });
    }
    for (const rel of ASSET_TREES) removeLeftovers(path.join(WWW, 'assets', rel));
    return done;
}

function removeLeftovers(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) removeLeftovers(p);
        else if (/\.php$|Bak/.test(entry.name)) fs.rmSync(p);
    }
}

// Small pages/scripts that live outside those trees and are linked from the UI (or from a page
// inside a tree). Same reasoning as ASSET_TREES — each one was a "tapping it opens the search page"
// bug on the device.
const ASSET_LOOSE_FILES = [
    'lbl.html', 'lbl-en.html',
    'listdiff.html', 'makelist.html', 'rr.html',
    'rrbi.html', // texts/abbr.html is common/abbr.html now; texts/dn2.9.html stays on the site (owner)
    // The memorisation app loads the same theme script as the rest of the site, plus its audio
    // player and the two album covers it shows while playing.
    'js/themeswitch.js', 'js/jsPlayer.js',
    'img/albumart-memo.png', 'img/albumart-samadhi.png',
    'materials/cases.html', 'materials/conjugations.html', 'materials/pali_cases_ru.html',
    'materials/prat.html',
    'js/nav-component.js', 'js/pmjs.js', 'js/audioLazyLoad.js', 'js/switchView.js',
    'js/lbl.js', 'js/lunar.js', 'js/settings.js', 'js/diacritics.js',
    'js/standalone-dpd/pali-lookup-standalone.js',
    // Datatables (non-min, asked for by abbr.html), Font Awesome, and the PDF-export pair. ~7MB
    // raw between them, and the only reason "Export to PDF" and the abbreviation page worked while
    // everything around them did: without the files the app answers those URLs with index.html.
    'js/datatables/datatables.js', 'js/fontawesome.6.6.all.js',
    'js/pdfmake.min.js', 'js/vfs_fonts.js',
    // Images the shipped pages reference. Deliberately NOT the whole img/ tree (22MB): every one
    // of these was found by verifyReferencedAssets(), which fails the build when a referenced file
    // is absent — so the list cannot silently fall behind, and the APK does not carry a picture
    // library for pages nobody opens.
    'img/dictSettings.png', 'img/buttons/pwa-cta.png', 'img/multi-tool-512x512.png',
    'img/find-dhamma-512x512.png', 'img/albumart512.png', 'img/favicon-sc.png',
    'img/gray-white.png', 'img/icon-192x192.png',
    // Found by the app's error reports, not by verifyReferencedAssets (legacy pages it does not parse).
    'img/dictSettingsRu.jpg', 'img/dhammafindlogo.webp',
];

function copyAssetLooseFiles() {
    let done = 0;
    for (const rel of ASSET_LOOSE_FILES) {
        // public/overrides/ wins over the legacy tree, exactly as dg-light.js's two static mounts
        // resolve it: /assets/js/settings.js is OUR settings.js on the site, not the legacy one.
        const override = f(path.join('public', 'overrides', rel));
        const from = fs.existsSync(override) ? override : l(rel);
        if (!fs.existsSync(from)) {
            console.warn(`SKIP asset file ${rel} — not present in the legacy tree`);
            continue;
        }
        const dest = path.join(WWW, 'assets', rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(from, dest);
        done++;
    }
    return done;
}

// Recursive copy — the offline layer has a vendor/ subtree (sqlite-wasm), and a flat copy would
// silently ship a worker whose wasm import 404s on the device.
function copyTree(from, to) {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
        const src = path.join(from, entry.name);
        const dest = path.join(to, entry.name);
        if (entry.isDirectory()) copyTree(src, dest);
        else fs.copyFileSync(src, dest);
    }
}

// The offline layer (fetch shim, data worker, status UI, core bundle, sqlite-wasm vendor) now
// lives in dg-node's public/offline/ and is built there by `npm run build-offline`. The app used
// to carry its own copies in src/; they drifted from the site's — the exact failure that got
// www/ generated in the first place — so the app copies dg-node's output verbatim and only
// overlays the two files that are genuinely native (src/platform.js, src/native-bridge.js).
// Same answers as the site by construction: one worker, one core bundle (docs/OFFLINE_PWA_PLAN.md,
// "Этап 2").
function copyOfflineLayer() {
    const from = f('public/offline');
    const to = path.join(WWW, 'offline');
    if (!fs.existsSync(path.join(from, 'app.js'))) {
        throw new Error(
            `${from}/app.js not found — run "npm run build-offline" in the dg-node checkout first ` +
            `(DG_NODE_PATH=${NODEJS_ROOT})`
        );
    }
    if (!fs.existsSync(path.join(from, 'core-bundle.js'))) {
        throw new Error(`${from}/core-bundle.js not found — run "npm run build-offline" in dg-node`);
    }
    copyTree(from, to);
    // The native platform wins: the page loads /offline/platform.js first, and dg-node's browser
    // copy (already in `to`) returns early because window.dgPlatform exists.
    copyNative('platform.js', path.join(to, 'platform.js'));
    return fs.readdirSync(to).length;
}

// DG_ONLINE_ORIGIN=https://test.dhamma.gift makes a test APK download the library, call the online
// API and open site-only pages on the test site. Unset = https://dhamma.gift (the files' default).
const ONLINE_ORIGIN = process.env.DG_ONLINE_ORIGIN || '';
if (ONLINE_ORIGIN && !/^https:\/\/([a-z0-9-]+\.)*dhamma\.gift$/.test(ONLINE_ORIGIN)) {
    throw new Error(`DG_ONLINE_ORIGIN must be https://[sub.]dhamma.gift, got "${ONLINE_ORIGIN}"`);
}
// Old help pages the site now 301s to the docs (dg-fastify.js LEGACY_HELP_REDIRECTS). Read from the
// server itself so the list cannot drift: they are left out of www/ and native-bridge.js opens them
// on the site, which redirects to the docs page.
const SITE_ONLY_PATHS = (() => {
    const src = fs.readFileSync(f('dg-fastify.js'), 'utf8');
    const block = /const LEGACY_HELP_REDIRECTS = \{([\s\S]*?)\};/.exec(src);
    return block ? [...block[1].matchAll(/'([\w.-]+\.html)'\s*:/g)].map(m => '/assets/common/' + m[1]) : [];
})().concat([
    // Kept on the site, not in the app (owner): the old multi-tool and a page only Memo links to.
    '/assets/common/multiTool.html', '/assets/common/multiToolRu.html', '/assets/texts/dn2.9.html',
]);
function copyNative(name, to) {
    const head = (ONLINE_ORIGIN ? `window.DG_ONLINE_ORIGIN = ${JSON.stringify(ONLINE_ORIGIN)};\n` : '') +
        `window.DG_SITE_ONLY_PATHS = ${JSON.stringify(SITE_ONLY_PATHS)};\n`;
    fs.writeFileSync(to, head + fs.readFileSync(path.join(SRC, name), 'utf8'));
}

// The app's own web files. Everything else the page needs (the whole offline data layer, the
// reader, the search UI) is copied from dg-node — see copyOfflineLayer above and ASSETS.
function copyNativeFiles() {
    copyNative('native-bridge.js', path.join(WWW, 'native-bridge.js'));
    fs.copyFileSync(path.join(SRC, 'tts.js'), path.join(WWW, 'tts.js'));
    return 2;
}

// The ASSETS list above is hand-maintained, so a NEW <script>/<link> added to the site is copied
// only if someone remembers to add it here. Forgetting costs more than it sounds: Capacitor's
// asset server falls back to the root index.html for a path it does not have, so a missing
// /assets/js/foo.js is served as HTML, the browser reports "Unexpected identifier <a Russian word
// from the top comment>" — and the feature dies on the device with an error that names neither the
// file nor the build. This walks the BUILT page and fails loudly instead. Same spirit as
// build-page.js's own verify(): a page that builds but is wrong is worse than a failed build.
function verifyPageAssets() {
    const pages = ['index.html', path.join('settings', 'index.html')];
    const missing = [];
    for (const rel of pages) {
        const file = path.join(WWW, rel);
        if (!fs.existsSync(file)) continue;
        const html = fs.readFileSync(file, 'utf8')
            // Commented-out tags are not requests: search/index.html keeps a disabled
            // /assets/js/diacritics.js <script> in a comment, and demanding a file for it would
            // be a false failure on every build.
            .replace(/<!--[\s\S]*?-->/g, '');
        const refs = [
            ...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g),
            ...html.matchAll(/<link[^>]*\shref="([^"]+\.(?:css|woff2?|png|svg|ico))"/g),
        ];
        for (const [, url] of refs) {
            if (/^(https?:)?\/\//.test(url) || url.startsWith('data:')) continue;
            const clean = url.split('?')[0].split('#')[0];
            if (!clean.startsWith('/')) continue; // relative to the page, resolved below
            if (!fs.existsSync(path.join(WWW, clean))) missing.push(`${rel}: ${clean}`);
        }
    }
    if (missing.length) {
        throw new Error(
            'build-assets.js: the built page references files that are not in www/:\n  - ' +
            missing.join('\n  - ') +
            '\nAdd each one to ASSETS (or fix the page). On the device these are served as ' +
            'index.html, so the failure looks like a JavaScript syntax error in an unrelated file.'
        );
    }
    return true;
}

// Paths that are allowed to be missing, each for a stated reason. Kept short and specific on
// purpose: the whole point of this check is that a missing file on a device is not a 404 but
// index.html (the reader sees the search page), so an exception here must be a decision, not a
// convenience.
const REFERENCE_EXCEPTIONS = [
    // Font subsets referenced from search/css/home.css and player CSS. Absent from the legacy
    // checkout AND from the site itself (verified: the same 404 in a browser) — a font the
    // platform falls back from, not a page or a script.
    /^\/assets\/fonts\//,
    // The .json-under-a-.js-name family: legacy JSONP fallbacks tried AFTER the .json that really
    // exists (/nodejs/res/*, /settings/scripts.js, /reader/mode-table.js, …), plus the legacy
    // reader's client-side DB, which was never shipped anywhere.
    /^\/(nodejs\/res|settings|reader)\/[A-Za-z0-9_-]+\.js$/,
    /^\/nodejs\/dg_db\.js$/,
    // Missing in the legacy tree itself (checked with find across the repo): there is nothing to
    // copy from, and the SITE answers these with its own 404 too — so this is not an app gap.
    /^\/assets\/brru\/blurbs-ru\.js$/,
    // Server-side config (siteroot/config, not in git), fetched by the voice player. It can hold
    // the Google TTS key, so it must NOT be baked into an APK — the player falls back to online.
    /^\/config\//,
    // Fetched by assets/js/lbl.js and absent from the legacy tree itself (checked) — the call
    // catches its 404, on the site as well as here.
    /^\/read\/reader-rus-translations\.js$/,
    /^\/assets\/materials\/(cases|conjugations|pali_cases_ru)\.html$/,
    /^\/assets\/grammar\/numerals(_declension)?\.html$/,
    /^\/assets\/common\/modalsSC\.html$/,
    // Named only in a search-core comment: AI drafts are for lbl.html and never shipped (owner).
    /^\/assets\/texts\/ai\//,
];

// The check that would have caught History/Materials/grammar before a device did. It walks the
// BUILT bundle and asks, for every same-site URL any copied HTML/JS/CSS names, whether the file is
// actually there. Vendor bundles (jquery, datatables, the sqlite wasm) are skipped by size — they
// are copies of npm packages that reference nothing of ours.
function verifyReferencedAssets() {
    // (?![-\w]) after the extension: without it "toc.json" matched as "toc.js" and the check
    // demanded a file nobody references.
    const REF = /["'(`(]\s*(\/(?:assets|nodejs|reader|read|memo|spa|settings|api-snapshots)\/[A-Za-z0-9_@./+%-]+\.(?:js|css|json|html|woff2?|svg|png|wasm))(?![-\w])/g;
    const MAX_SCAN_BYTES = 2 * 1024 * 1024;
    const missing = new Map(); // url -> first file that asked for it

    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === 'vendor' || entry.name === 'standalone-dpd') continue;
                walk(full);
                continue;
            }
            if (!/\.(?:html|js|css)$/.test(entry.name)) continue;
            if (!/\.(?:html|css)$/.test(entry.name) && fs.statSync(full).size > MAX_SCAN_BYTES) continue;
            let text = fs.readFileSync(full, 'utf8');
            // Commented-out tags are not requests — index.html keeps the legacy PHP reader and the
            // Thai demo links inside comments, and demanding files for those is a false failure.
            if (entry.name.endsWith('.html')) text = text.replace(/<!--[\s\S]*?-->/g, '');
            for (const match of text.matchAll(REF)) {
                const url = match[1];
                if (!fs.existsSync(path.join(WWW, url))) {
                    if (!missing.has(url)) missing.set(url, path.relative(WWW, full));
                }
            }
        }
    };
    walk(WWW);

    const real = [...missing.entries()].filter(([url]) => !REFERENCE_EXCEPTIONS.some(re => re.test(url)) &&
        !SITE_ONLY_PATHS.includes(url)); // left out on purpose, opened on the site (see SITE_ONLY_PATHS)
    if (real.length) {
        throw new Error(
            'build-assets.js: the built bundle references site files that are not in www/:\n  - ' +
            real.map(([url, from]) => `${url}  (first asked for by ${from})`).join('\n  - ') +
            '\nAdd each one to ASSET_TREES/ASSET_LOOSE_FILES (or to ASSETS with an override). ' +
            'On a device a missing path is answered with index.html — the reader taps "History" ' +
            'and gets the search page.'
        );
    }
    return true;
}

// /api/toc has no server in this app: it is answered from the build-time snapshots
// (build-toc-snapshot.js -> www/api-snapshots/), which native platform.js's mapStatic rewrites to.
// Those files live in www/, so any `rm -rf www` + rebuild without that step silently ships an app
// whose TOC pane says "Failed to load TOC: /api/toc: HTTP 404" (owner, screenshot). The build has
// no network to fetch them itself, so it demands them instead of pretending.
function verifyTocSnapshot() {
    const toc = path.join(WWW, 'api-snapshots', 'toc.json');
    if (!fs.existsSync(toc)) {
        throw new Error(
            'build-assets.js: www/api-snapshots/toc.json is missing — run ' +
            '"node build-toc-snapshot.js --base=<a running dg-node server>" before build-assets.js.\n' +
            'Without it the offline TOC pane fails with "HTTP 404" on every device.'
        );
    }
    const books = fs.readdirSync(path.join(WWW, 'api-snapshots')).filter(n => n.startsWith('toc-book-')).length;
    if (books === 0) {
        throw new Error('build-assets.js: no toc-book-*.json snapshots in www/api-snapshots — re-run build-toc-snapshot.js');
    }
    return books;
}

// Files that do not live under /assets in the URL space. The memorisation app loads the legacy
// voice player at /read/js/voice.js (published from public/overrides/read/, the same override the
// site serves), and a missing one is not a 404 on a device — it is index.html parsed as JavaScript,
// i.e. a SyntaxError from a file nobody suspects.
const ROOT_FILES = [
    { url: '/read/js/voice.js', sources: ['public/overrides/read/js/voice.js'] },
    { url: '/read/css/voice.css', sources: ['public/overrides/read/css/voice.css'] },
    // The line-by-line tools and the memo app load these; dg-node carries its own copies now
    // (public/overrides/read/js), the legacy reader tree is no longer a source.
    { url: '/read/js/ranges.js', sources: ['public/overrides/read/js/ranges.js'] },
    { url: '/read/js/voice-mem.js', sources: ['public/overrides/read/js/voice-mem.js'] },
    { url: '/read/js/reader-rus-translations.js', sources: ['public/overrides/read/js/reader-rus-translations.js'] },
    { url: '/assets/img/albumart.png', sources: ['img/albumart.png'], legacy: true },
];

// Whole trees that live outside /assets in the URL space. /read/images is the legacy reader's icon
// set (132KB; the legacy tree keeps it as assets/img/read) and several bundled tools point at it.
const ROOT_TREES = [
    { url: '/read/images', from: 'img/read', legacy: true },
    // dg-node's own /read mount (public/overrides/read) on top: assets/diff asks for its icons there.
    { url: '/read/images', from: 'public/overrides/read/images' },
];

function copyRootTrees() {
    let done = 0;
    for (const { url, from, legacy } of ROOT_TREES) {
        const src = legacy ? l(from) : f(from);
        if (!fs.existsSync(src)) { console.warn(`SKIP root tree ${url} — ${src} missing`); continue; }
        copyTree(src, path.join(WWW, url));
        done++;
    }
    return done;
}

function copyRootFiles() {
    let done = 0;
    for (const { url, sources, legacy, root } of ROOT_FILES) {
        const resolve = p => (root ? lr(p) : legacy ? l(p) : f(p));
        const from = sources.map(resolve).find(p => fs.existsSync(p));
        if (!from) { console.warn(`SKIP root file ${url} — no source among ${sources.join(', ')}`); continue; }
        const dest = path.join(WWW, url);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(from, dest);
        done++;
    }
    return done;
}

// The memorisation app (/memo/ — index.html, memo.js, memo.css, presets.json, ~150KB in total) is
// published from dg-node's own siteroot/memo, so the app can simply carry it: it is static and its
// only fetch is a relative presets.json. It was the one tile that still opened in the device's
// browser instead of the app (owner: "зачем на memorizer внешняя? посели его внутри").
function copyMemoApp() {
    const from = path.join(NODEJS_ROOT, 'siteroot', 'memo');
    if (!fs.existsSync(path.join(from, 'index.html'))) {
        throw new Error(`${from}/index.html not found — did the memorisation app move in dg-node?`);
    }
    copyTree(from, path.join(WWW, 'memo'));
    // memo.js takes its language from the path (/ru/memo/ → Russian), and the Favorites sheet's Memo
    // tab opens /ru/memo/index.html for a Russian interface — the site serves the same folder there.
    copyTree(from, path.join(WWW, 'ru', 'memo'));
    return fs.readdirSync(path.join(WWW, 'memo')).length;
}

// Directory links (/memo/, /settings/) resolve on a server; Capacitor has no directory resolution
// and answers them with the root index.html — which is how "Memo" opened the search page and how
// Settings once did the same (see native-bridge.js / DgTextRouter.settingsUrl). Rewritten to the
// explicit file, in every bundled page, because the memo app links to /memo/ itself.
function resolveDirectoryLinksEverywhere() {
    const DIRS = ['memo', 'settings'];
    let patched = 0;
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === 'offline') continue;
                walk(full);
                continue;
            }
            if (!entry.name.endsWith('.html')) continue;
            const html = fs.readFileSync(full, 'utf8');
            let next = html;
            for (const d of DIRS) next = next.split(`href="/${d}/"`).join(`href="/${d}/index.html"`);
            if (next !== html) { fs.writeFileSync(full, next, 'utf8'); patched++; }
        }
    };
    walk(WWW);
    return patched;
}

// Every bundled page needs native-bridge.js, not just the two the app generates.
//
// The bridge is what turns Android's back button into in-app history (history.back()), routes
// external links to the Browser plugin, rewrites target="_blank" into in-place navigation and keeps
// the status bar in step with the page's theme. build-page.js injects it into index.html and
// build-assets.js into settings/index.html — but the pages that come from the legacy tree (grammar,
// materials, tools, line-by-line, the memorisation app) had none, so on those the back button did
// nothing at all: the reader opened "Просклонять заданное слово" and could not get back except by
// killing the app (owner). The legacy repo is off limits, so this patches the copy on its way into
// www/, next to the directory links above.
function injectBridgeIntoPages() {
    let patched = 0;
    const tag = '<script src="/native-bridge.js"></script>';
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === 'offline' || entry.name === 'vendor') continue;
                walk(full);
                continue;
            }
            if (!entry.name.endsWith('.html')) continue;
            let html = fs.readFileSync(full, 'utf8');
            const before = html;
            // The voice player needs the speechSynthesis stand-in loaded ahead of it (src/tts.js).
            if (html.includes('/read/js/voice.js') && !html.includes('/tts.js')) {
                html = html.replace(/<script[^>]*src="\/read\/js\/voice\.js"/, m => '<script src="/tts.js"></script>\n' + m);
            }
            // Fragments inserted with innerHTML (reader/*-pm-fragment.html) have no </body>; a
            // script tag inside them would never execute, so skipping them loses nothing.
            if (!html.includes('native-bridge.js') && html.includes('</body>')) {
                html = html.replace('</body>', tag + '\n</body>');
            }
            if (html === before) continue;
            fs.writeFileSync(full, html, 'utf8');
            patched++;
        }
    };
    walk(WWW);
    return patched;
}

// The installed app's version, readable by the page. Capacitor's App.getInfo() is the
// authoritative source on a device, but the settings row has to say something even when the plugin
// is missing or fails (and on a plain browser, where the row showed up empty — owner's report).
// android/app/build.gradle is the single source of truth for it, so read it at build time.
function writeAppVersion() {
    const gradle = path.join(__dirname, 'android', 'app', 'build.gradle');
    if (!fs.existsSync(gradle)) return null;
    const text = fs.readFileSync(gradle, 'utf8');
    const version = (text.match(/versionName\s+"([^"]+)"/) || [])[1];
    const build = (text.match(/versionCode\s+(\d+)/) || [])[1];
    if (!version) return null;
    fs.writeFileSync(path.join(WWW, 'app-version.json'),
        JSON.stringify({ version: version, build: build || '?', app: 'gift.dhamma.mobile' }, null, 2) + '\n');
    return version + ' (' + build + ')';
}

function main() {
    requireNodeRoot();
    const args = parseArgs();
    fs.mkdirSync(WWW, { recursive: true });
    // ORDER IS LOAD-BEARING: legacy first (whole trees, svg icons, reader images), then the
    // explicit ASSETS list, which is where public/overrides/* lives — so the app's own version of
    // a file always wins over the legacy one it shadows. Reversed, the legacy tree overwrote our
    // overrides silently (see copyAssetTrees).
    const treeCount = copyAssetTrees();
    const looseCount = copyAssetLooseFiles();
    const svgCount = copySvgIcons();
    copyReaderImages();
    let ok = 0, missing = 0;
    for (const asset of ASSETS) {
        if (copyAsset(asset)) ok++; else missing++;
    }
    const nativeCount = copyNativeFiles();
    const memoCount = copyMemoApp();
    const rootCount = copyRootFiles();
    const rootTreeCount = copyRootTrees();
    const offlineCount = copyOfflineLayer();
    const dirLinks = resolveDirectoryLinksEverywhere();
    const bridged = injectBridgeIntoPages();
    buildScriptBundles();
    buildModeTable(args.langs);
    injectNativeBridge();
    injectOfflineLibraryRow();
    injectAppVersionRow();
    verifyPageAssets();
    verifyReferencedAssets();
    verifyTocSnapshot();
    const appVersion = writeAppVersion();
    console.log(`Assets: ${ok} copied, ${missing} missing. +${memoCount} memo files, +${rootCount} root files, +${rootTreeCount} root trees, ${dirLinks} pages with directory links resolved, ${bridged} pages given native-bridge.js, +${treeCount} legacy trees, +${looseCount} loose legacy files, +${svgCount} svg icons, +${nativeCount} native file(s), +${offlineCount} offline-layer entries from dg-node/public/offline, reader/images/, 2 generated bundles, mode-table.json (langs=${args.langs.join(',')}).`);
    console.log(`  app version: ${appVersion || 'unknown'}\n  dg-node: ${NODEJS_ROOT}\n  legacy assets: ${LEGACY_ASSETS}`);
    if (missing > 0) process.exitCode = 1;
}

main();
