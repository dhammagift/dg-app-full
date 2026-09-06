// Offline Pali script-conversion engine (Aksharamukha + Pyodide), downloaded on demand — most
// readers never touch a non-default script, so this shouldn't tax every install the way the main
// database (always needed) does. Files are hosted at DG_SCRIPT_ENGINE_BASE (same server as the
// database, siteroot/mobile-data/aksharamukha/ in dg-node — a plain static drop, no server code
// needed: that directory is already auto-served, see the mobile-data comment in app.js).
//
// Ported from dg-fastify.js's convertPaliScript()/convertScriptInSearchResult()/'/api/
// transliterate' route (same aksharamukha npm package, same Scripts keys) — kept a 1:1 port
// rather than a second implementation, so offline conversion matches what the live server would
// return for the same script.
//
// Runs on the MAIN THREAD, not db-worker.js: a single conversion is tens of milliseconds
// (verified against the standalone package), cheap enough not to need a worker, and doing it here
// avoids re-solving service-worker registration (main-thread only) a second time from inside a
// dedicated worker.
(function () {
    const ENGINE_BASE = (typeof window !== 'undefined' && window.DG_SCRIPT_ENGINE_BASE) || 'https://dhamma.gift/mobile-data/aksharamukha';
    const VIRTUAL_PREFIX = '/__aksharamukha_engine__/';
    const VIRTUAL_ORIGIN = location.origin + VIRTUAL_PREFIX.slice(0, -1);
    const CACHE_NAME = 'dg-script-engine-v1';
    const MODE_KEY = 'dgScriptEngineMode';

    let manifestPromise = null;
    function fetchManifest() {
        if (!manifestPromise) manifestPromise = fetch(ENGINE_BASE + '/manifest.json').then((r) => r.json());
        return manifestPromise;
    }

    let swReadyPromise = null;
    // A freshly-registered worker starts 'installing', not 'active' — anything that needs it to
    // actually intercept fetches (downloadEngine's own cache.put keys, and later boot()'s
    // import()s) has to wait for 'activated', not just for register() to resolve.
    function ensureServiceWorker() {
        if (swReadyPromise) return swReadyPromise;
        swReadyPromise = navigator.serviceWorker.register('/script-engine-sw.js').then((reg) => {
            if (reg.active) return reg;
            const worker = reg.installing || reg.waiting;
            if (!worker) return reg;
            return new Promise((resolve) => {
                worker.addEventListener('statechange', function onChange() {
                    if (worker.state === 'activated') { worker.removeEventListener('statechange', onChange); resolve(reg); }
                });
            });
        });
        return swReadyPromise;
    }

    let downloadPromise = null;
    // Idempotent and resumable: files already in the cache (a previous run that got partway,
    // or a previous app session — Cache Storage persists) are skipped, so a retry after a
    // failure only fetches what's still missing.
    function downloadEngine(onProgress) {
        if (downloadPromise) return downloadPromise;
        downloadPromise = (async () => {
            await ensureServiceWorker();
            const manifest = await fetchManifest();
            const cache = await caches.open(CACHE_NAME);
            let loaded = 0;
            for (const f of manifest.files) {
                const key = VIRTUAL_ORIGIN + '/' + f.name;
                if (await cache.match(key)) {
                    loaded += f.bytes;
                    if (onProgress) onProgress(loaded, manifest.totalBytes);
                    continue;
                }
                const res = await fetch(ENGINE_BASE + '/' + f.name);
                if (!res.ok) throw new Error(f.name + ': HTTP ' + res.status);
                await cache.put(key, res);
                loaded += f.bytes;
                if (onProgress) onProgress(loaded, manifest.totalBytes);
            }
        })();
        return downloadPromise;
    }

    let readyPromise = null;
    // Boots Aksharamukha from whatever downloadEngine() already put in Cache Storage. Both
    // import()s below resolve to VIRTUAL_ORIGIN URLs — script-engine-sw.js answers those from
    // Cache Storage once activated, which is why ensureServiceWorker() is awaited first.
    //
    // Aksharamukha.new()'s own browser-detection code assumes it was loaded via a plain
    // <script src> tag on a page (reads document.currentScript, meaningless here) — two of its
    // own static hooks sidestep that entirely instead of fighting it:
    // _loadPyodideRef lets it skip its own (CDN-reaching) pyodide loader in favour of the exact
    // module instance already imported above, and _setCurrentScript makes its
    // getCurrentScriptPath() (used both for pyodide's own indexURL and for the wheel installs
    // below) resolve to VIRTUAL_ORIGIN instead of throwing.
    function boot() {
        if (readyPromise) return readyPromise;
        readyPromise = (async () => {
            await ensureServiceWorker();
            const aksh = await import(/* webpackIgnore: true */ VIRTUAL_ORIGIN + '/index.js');
            const Aksharamukha = aksh.default;
            const Scripts = aksh.Scripts;
            const pyodideModule = await import(/* webpackIgnore: true */ VIRTUAL_ORIGIN + '/pyodide.mjs');
            Aksharamukha._loadPyodideRef = pyodideModule.loadPyodide;
            Aksharamukha._setCurrentScript({ src: VIRTUAL_ORIGIN + '/index.js' });
            const instance = await Aksharamukha.new();
            return { instance, Scripts };
        })();
        return readyPromise;
    }

    function resolveScriptKey(Scripts, code) {
        if (!code) return null;
        const lower = code.toLowerCase();
        for (const key of Object.keys(Scripts)) if (key.toLowerCase() === lower) return key;
        return null;
    }

    // Same shape as dg-fastify.js's convertPaliScript(): IAST -> the target script.
    async function convertPaliScript(text, scriptCode) {
        if (!text) return text;
        const { instance, Scripts } = await boot();
        const realKey = resolveScriptKey(Scripts, scriptCode);
        if (!realKey) return text;
        try {
            return await instance.processAsync(Scripts.IAST, Scripts[realKey], text);
        } catch (e) {
            console.error('[script-engine] conversion to', scriptCode, 'failed:', e);
            return text;
        }
    }

    // Same shape as dg-fastify.js's convertScriptInSearchResult(): walks a /search or
    // /search/enrich JSON body's Pali fields in place, one Promise.all for every string found
    // rather than one at a time.
    async function convertScriptInSearchResult(result, scriptCode) {
        if (!scriptCode) return;
        const { Scripts } = await boot();
        if (!resolveScriptKey(Scripts, scriptCode)) return;
        const jobs = [];
        const convertField = (obj, field) => {
            if (obj && obj[field]) jobs.push((async () => { obj[field] = await convertPaliScript(obj[field], scriptCode); })());
        };
        for (const suttaId in (result.data || {})) {
            for (const seg of (result.data[suttaId].segments || [])) {
                convertField(seg, 'root_text');
                convertField(seg, 'variant');
                (seg.lb_context || []).forEach((c) => convertField(c, 'root_text'));
                (seg.la_context || []).forEach((c) => convertField(c, 'root_text'));
            }
        }
        (result.variantSegments || []).forEach((v) => convertField(v, 'text'));
        await Promise.all(jobs);
    }

    // Same shape as dg-fastify.js's /api/text/:id route: result.segments[] directly (not nested
    // under a suttaId like /search's result.data), and the same dualScript nuance — a mode like
    // "devanagari" (see reader/mode-table.json) shows the converted script on the main line AND
    // keeps the original Latin Pali on a second line (root_text_iso, stashed before overwriting
    // root_text), and leaves variant unconverted since prod attaches it under the Latin line, not
    // the converted one.
    async function convertScriptInTextResult(result, scriptCode, dualScript) {
        if (!scriptCode) return;
        const { Scripts } = await boot();
        if (!resolveScriptKey(Scripts, scriptCode)) return;
        await Promise.all((result.segments || []).map(async (seg) => {
            if (dualScript) seg.root_text_iso = seg.root_text;
            if (seg.root_text) seg.root_text = await convertPaliScript(seg.root_text, scriptCode);
            if (!dualScript && seg.variant) seg.variant = await convertPaliScript(seg.variant, scriptCode);
        }));
    }

    // Same shape as dg-fastify.js's '/api/transliterate' route: AutoDetect -> IAST Pali, for the
    // word-click dictionary lookup (paliLookup.js's ensureIastWord()).
    async function transliterateToIast(text) {
        if (!text) return { text: '', converted: false };
        const { instance, Scripts } = await boot();
        try {
            const converted = await instance.processAsync(Scripts.AutoDetect, Scripts.IASTPI, text);
            return { text: converted, converted: true };
        } catch (e) {
            console.error('[script-engine] transliterate failed:', e);
            return { text, converted: false };
        }
    }

    window.dgScriptEngine = {
        // 'online' | 'offline' | null (not chosen yet, or a previous offline install failed and
        // was deliberately not persisted — see app.js's ensureScriptMode()).
        getMode: () => localStorage.getItem(MODE_KEY),
        setMode: (mode) => { if (mode) localStorage.setItem(MODE_KEY, mode); else localStorage.removeItem(MODE_KEY); },
        isOfflineReady: () => readyPromise !== null,
        downloadEngine,
        boot,
        convertPaliScript,
        convertScriptInSearchResult,
        convertScriptInTextResult,
        transliterateToIast,
    };
})();
