// Fills in the "Offline library" / "Offline docs" rows build-assets.js's
// injectOfflineLibraryRow() adds to the Data section of settings/index.html (a live-site page
// copied verbatim otherwise — see that function's header).
//
// This is a separate page from index.html, so app.js and the data worker are not loaded here at
// all — and the database cannot be inspected from this realm either: it lives in OPFS behind the
// SAH pool, which is single-writer, so installing the VFS a second time to count files would
// fight the page that actually uses it. app.js therefore leaves what this row needs in
// localStorage, which both pages share, and this only reads it.
//
// It used to open IndexedDB and look for core.db, lang_ru.db and lang_en.db. All three stopped
// existing when the app moved to one dg-mobile.db in OPFS, so the row reported "Not downloaded"
// to every reader, including those with the full library on disk.
(function () {
    var isRu = (localStorage.getItem('dhammaLanguage') || localStorage.getItem('siteLanguage') || 'en') === 'ru';
    var STATE_KEY = 'dg.offline.state';
    var WANT_UPDATE_KEY = 'dg.offline.wantUpdate';

    function readState() {
        try { return JSON.parse(localStorage.getItem(STATE_KEY) || 'null'); }
        catch (e) { return null; }
    }
    function mb(bytes) { return Math.round(bytes / 1048576); }

    var titleEl = document.getElementById('dgOfflineLibTitle');
    var descEl = document.getElementById('dgOfflineLibDesc');
    var btnEl = document.getElementById('dgOfflineLibBtn');
    if (!titleEl || !descEl || !btnEl) return; // row wasn't injected — fail soft, not fatal

    titleEl.textContent = isRu ? 'Офлайн-библиотека' : 'Offline library';

    var state = readState();
    var update = state && state.update;

    if (!state || !state.present) {
        descEl.textContent = isRu ? 'Не скачано.' : 'Not downloaded.';
        btnEl.textContent = isRu ? 'Скачать сейчас' : 'Download now';
        // A plain navigation home is enough here: app.js runs loadData() on every load of that
        // page and downloads whatever is missing, asking for consent if the connection warrants.
        btnEl.onclick = function () { location.href = '/'; };
    } else if (update) {
        descEl.textContent = isRu
            ? ('Скачано (сборка ' + (state.build_id || '?') + '). Доступно обновление' +
               (update.bytes ? ', ' + mb(update.bytes) + 'МБ.' : '.'))
            : ('Downloaded (build ' + (state.build_id || '?') + '). An update is available' +
               (update.bytes ? ', ' + mb(update.bytes) + 'MB.' : '.'));
        btnEl.textContent = isRu ? 'Обновить' : 'Update';
        // The download itself belongs to the other page, which owns the worker and the consent
        // dialog — this records the intent and goes there.
        btnEl.onclick = function () {
            try { localStorage.setItem(WANT_UPDATE_KEY, '1'); } catch (e) { /* ignore */ }
            location.href = '/';
        };
    } else {
        descEl.textContent = isRu
            ? ('Скачано, сборка ' + (state.build_id || '?') + '. Обновлений нет.')
            : ('Downloaded, build ' + (state.build_id || '?') + '. Up to date.');
        btnEl.textContent = isRu ? 'Перескачать' : 'Re-download';
        btnEl.onclick = function () {
            try { localStorage.setItem(WANT_UPDATE_KEY, '1'); } catch (e) { /* ignore */ }
            location.href = '/';
        };
    }

    var docsTitleEl = document.getElementById('dgOfflineDocsTitle');
    var docsDescEl = document.getElementById('dgOfflineDocsDesc');
    // .badge text ("soon"/"скоро") is already relabeled by the page's own applyLang() — this
    // script runs after it (script tag placed right before </body>), only the plain text node
    // in front of the badge needs setting here, not the badge itself.
    if (docsTitleEl && docsTitleEl.firstChild) docsTitleEl.firstChild.textContent = isRu ? 'Докс офлайн' : 'Offline docs';
    if (docsDescEl) docsDescEl.textContent = isRu
        ? 'Пока справка открывается онлайн — чтобы приложение оставалось компактным.'
        : 'Help currently opens online, to keep the app small.';
})();
