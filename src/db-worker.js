// The offline data layer. Everything that touches the database happens in here, and nothing else
// does.
//
// It is a Worker for one concrete reason: OPFS gives out synchronous access handles
// (createSyncAccessHandle) only inside a Worker — on the main thread that method does not exist.
// Synchronous access is what lets SQLite read a 170MB file from storage instead of holding it in
// memory, and it is also what lets dg-node's core/search-core.js run here UNCHANGED: that module
// queries synchronously, because on the server it runs against node:sqlite.
//
// So the shape is: page -> postMessage -> this worker -> the site's own core -> SQLite -> back.
// The page's fetch shim is already asynchronous, so nothing above this file had to change to
// accommodate the boundary.

// Both imports end in .js, deliberately: a browser only accepts a module served with a
// JavaScript MIME type, and Android's MimeTypeMap has no entry for "mjs". Capacitor's asset
// server therefore served these as application/octet-stream, this worker failed to start, and
// with it went every search and every reader request in the app. See build-core-bundle.js.
import sqlite3InitModule from './vendor/sqlite-wasm/index.js';
import core from './core-bundle.js';

// dg-mobile.db, not dg.db: the server's own database is dg.db and lives on the same box, so
// sharing the name is how a symlink ends up pointing 600MB of every language at a phone.
//
// A downloaded copy is stored under its own build id — /dg-mobile.<build_id>.db — for one
// reason: the SAH pool can import and unlink files but cannot rename one, so replacing a database
// in place would mean destroying the working copy before knowing the new one arrived. Naming by
// build instead lets the new file land alongside the old, and the old one is unlinked only once
// the new one opens. It also makes a half-finished download self-identifying: its meta either
// cannot be read or does not carry the build its name claims.
//
// LEGACY_DB_NAME is the unversioned name shipped before this, still on devices that installed
// early. It is read as a valid current copy and replaced by a named one at the first update.
const LEGACY_DB_NAME = '/dg-mobile.db';
const DB_PREFIX = '/dg-mobile.';
const POOL_NAME = 'dg-offline';

// The shape this worker is written against. A file declaring anything else is not opened: the
// alternative is queries that almost fit, answering almost-right.
const SCHEMA_VERSION = 1;

function dbNameFor(buildId) { return `${DB_PREFIX}${buildId}.db`; }
function nameToBuild(name) { return name.slice(DB_PREFIX.length, -'.db'.length); }

let db = null;
let ready = null;
let poolPromise = null;

function post(msg) {
    self.postMessage(msg);
}

// dg-node's core was written against node:sqlite's prepare().all()/.get(). sqlite-wasm's oo1 API
// is equivalent but spelled differently, so this is the whole adapter. Kept deliberately thin: if
// it ever needs to reshape a result, the core has stopped being portable and that is worth
// noticing rather than smoothing over.
function nodeSqliteShim(oo1db) {
    return {
        prepare(sql) {
            return {
                all: (...params) => oo1db.selectObjects(sql, params),
                get: (...params) => oo1db.selectObject(sql, params),
            };
        },
        function(name, opts, fn) {
            oo1db.createFunction(name, (_ctx, ...args) => fn(...args), { deterministic: !!opts?.deterministic });
        },
    };
}

// Streams the database straight into OPFS. The pool's importDb() takes a callback and writes each
// chunk as it arrives, so the file never exists as one 170MB buffer — which is the difference
// between working on a phone and not.
async function downloadInto(pool, url, name) {
    // Reading a file the system already fetched is not a download and should not be described as
    // one — it is fast, local, and the reader is watching a second bar move for reasons they did
    // not ask about unless it is named.
    const phase = /^https?:\/\//.test(url) && !url.includes('_capacitor_file_') ? 'download' : 'import';
    const response = await fetch(url);
    if (!response.ok) throw new Error(`dg-mobile.db: HTTP ${response.status}`);
    const total = Number(response.headers.get('Content-Length')) || 0;
    const reader = response.body.getReader();
    let loaded = 0, lastReport = 0;

    await pool.importDb(name, async () => {
        const { done, value } = await reader.read();
        if (done) return undefined;
        loaded += value.byteLength;
        const now = Date.now();
        if (now - lastReport > 200) {
            lastReport = now;
            post({ type: 'progress', loaded, total, phase });
        }
        return value;
    });
    post({ type: 'progress', loaded, total, phase });
    return loaded;
}

// Installing the VFS is cheap and idempotent per worker, and both status and open need it —
// status so the page can decide whether to ask about network use before anything is downloaded.
function getPool() {
    poolPromise = poolPromise || (async () => {
        const sqlite3 = await sqlite3InitModule({ print: () => {}, printErr: () => {} });
        // opfs-sahpool, not the plain "opfs" VFS: the latter needs the page to be cross-origin
        // isolated (COOP/COEP headers), which a Capacitor WebView does not give us.
        return sqlite3.installOpfsSAHPoolVfs({ name: POOL_NAME, initialCapacity: 6 });
    })();
    return poolPromise;
}

// Every dg-mobile file the pool holds, newest naming first. More than one means an update was
// interrupted between importing the new file and unlinking the old — normal, and resolved by
// opening them in turn until one proves sound.
function storedDatabases(pool) {
    return pool.getFileNames()
        .filter(n => n === LEGACY_DB_NAME || (n.startsWith(DB_PREFIX) && n.endsWith('.db')))
        .sort((a, b) => (a === LEGACY_DB_NAME ? 1 : 0) - (b === LEGACY_DB_NAME ? 1 : 0));
}

// What makes a stored file usable is that the reader can read from it — everything else is
// bookkeeping. A truncated import fails the first query here, which is where that should surface,
// rather than as a blank reader later.
//
// Missing provenance is deliberately NOT a rejection. Copies published before meta existed are
// already on devices; they read perfectly well and simply cannot say which build they are, so they
// are kept and treated as out of date. Their owner is then offered the current build instead of
// silently losing the 170MB they already downloaded.
function inspect(pool, name) {
    let handle = null;
    try {
        handle = new pool.OpfsSAHPoolDb(name);
        handle.selectObject('SELECT count(*) c FROM suttas');

        let meta = {};
        try {
            for (const row of handle.selectObjects('SELECT key, value FROM meta')) meta[row.key] = row.value;
        } catch (e) { meta = {}; }

        if (meta.schema_version && Number(meta.schema_version) !== SCHEMA_VERSION) {
            handle.close();
            return { name, ok: false, reason: `schema ${meta.schema_version} != ${SCHEMA_VERSION}` };
        }
        // A file saved under a build id it does not carry is a download that stopped partway and
        // happened to leave valid pages behind.
        if (name !== LEGACY_DB_NAME && meta.build_id !== nameToBuild(name)) {
            handle.close();
            return { name, ok: false, reason: 'incomplete download' };
        }
        return { name, ok: true, meta, handle };
    } catch (e) {
        if (handle) { try { handle.close(); } catch (_) {} }
        return { name, ok: false, reason: e.message };
    }
}

function adopt(candidate) {
    db = candidate.handle;
    core.init({ searchDb: nodeSqliteShim(db), DG_OFFLINE: '/offline-data/dhammagift' });

    // The same in-memory sutta index initServer() builds on the server, from the same query.
    const skeleton = {};
    for (const row of db.selectObjects('SELECT id, category, dir_path, title, mr FROM suttas')) {
        skeleton[row.id] = { category: row.category, dir_path: row.dir_path, title: row.title, mr: row.mr };
    }
    core.setSkeleton(skeleton);
    return Object.keys(skeleton).length;
}

// Downloads the current build and adopts it, leaving whatever was open until the new file is
// proven — a failed update must cost a reader nothing, and a reader who is mid-download is still
// reading from the old copy. Peak storage is two databases; the alternative is losing the only one.
async function fetchCurrent(pool, distBase, sourceUrl) {
    const manifest = await fetchManifest(distBase);
    if (manifest && Number(manifest.schema_version) !== SCHEMA_VERSION) {
        throw new Error(
            `published database is schema ${manifest.schema_version}, this app reads ${SCHEMA_VERSION}` +
            ` — update the app`);
    }
    // Without a manifest the build id is unknown until the file is here, so it lands under the
    // legacy name. That keeps an older server (one publishing no manifest) working.
    const target = manifest && manifest.build_id ? dbNameFor(manifest.build_id) : LEGACY_DB_NAME;
    const stale = storedDatabases(pool).filter(n => n !== target);

    // sourceUrl, when the page supplies one, is a file the system already downloaded (see
    // DgDownloader.java) exposed to the WebView through Capacitor.convertFileSrc. Reading it is
    // the same fetch-and-stream as reading the server, so nothing below changes — the difference
    // is only that those bytes crossed the network under Android's control rather than ours, and
    // therefore survived the reader leaving the app.
    post({ type: 'downloading' });
    await downloadInto(pool, sourceUrl || `${distBase}/${(manifest && manifest.file) || 'dg-mobile.db'}`, target);

    const candidate = inspect(pool, target);
    if (!candidate.ok) {
        try { pool.unlink(target); } catch (_) {}
        throw new Error(`downloaded database unusable: ${candidate.reason}`);
    }
    if (db) { try { db.close(); } catch (_) {} db = null; }
    const suttas = adopt(candidate);
    for (const name of stale) { try { pool.unlink(name); } catch (_) {} }
    return { suttas, build_id: candidate.meta.build_id, downloaded: true };
}

// The manifest is small and its absence is not an error: a device that is offline, or pointed at
// a server that publishes none, must still open the copy it already has.
async function fetchManifest(distBase) {
    try {
        const response = await fetch(`${distBase}/db-manifest.json`, { cache: 'no-store' });
        if (!response.ok) return null;
        return await response.json();
    } catch (e) { return null; }
}

async function open(distBase, sourceUrl) {
    const pool = await getPool();

    for (const name of storedDatabases(pool)) {
        const candidate = inspect(pool, name);
        if (!candidate.ok) { try { pool.unlink(name); } catch (_) {} continue; }
        const suttas = adopt(candidate);
        return { suttas, build_id: candidate.meta.build_id, downloaded: false };
    }
    return fetchCurrent(pool, distBase, sourceUrl);
}

// One operation per endpoint the shim intercepts. Each is the few lines dg-fastify.js's route
// does around the core — parameter defaults and nothing else. Response building stays in the
// core, which is the point.
const OPS = {
    async search({ q, scope = 'default', langs = 'ru,en', exact = false, lb = 0, la = 0, fast = false }) {
        const keyword = core.stripSearchPunctuation(q || '');
        const targetLangs = langs.split(',').map(l => l.trim());
        if (keyword.length < 3) {
            return {
                metadata: {
                    query: keyword, scope, resolvedPrefixes: core.resolveAllowedPrefixes(scope),
                    langs: targetLangs, totalFiles: 0, totalMatches: 0, hasVariantMatch: false, tooShort: true,
                },
                data: {}, wordReport: [], variantSegments: [],
            };
        }
        return fast
            ? core.buildFastResponse(keyword, scope, exact, targetLangs, lb, la)
            : core.buildSearchResponse(keyword, scope, exact, targetLangs, lb, la);
    },

    // Mirrors dg-fastify.js's /search/enrich route step for step. It is more than "enrich the
    // ids": the skeleton is rebuilt restricted to those ids first, because that is what decides
    // which segments matched, and the word report is the slow, exact one — by this point
    // unique_words are already computed, so it costs nothing and agrees with the full /search.
    async enrich({ q, ids, langs = 'ru,en', scope = 'default', exact = false, lb = 0, la = 0 }) {
        const keyword = core.stripSearchPunctuation(q || '');
        const targetLangs = langs.split(',').map(l => l.trim());
        const requestedIds = (ids || '').split(',').map(s => s.trim()).filter(Boolean);
        if (!keyword) return { __status: 400, error: 'Parameter "q" is mandatory.' };
        if (!requestedIds.length) return { __status: 400, error: 'Parameter "ids" is mandatory.' };
        if (keyword.length < 3) return { data: {}, variantSegments: [] };

        const { searchResults, empty } = await core.buildMatchSkeleton(
            keyword, scope, exact, targetLangs, lb, la, requestedIds);
        const suttaIds = Object.keys(searchResults);
        if (empty || suttaIds.length === 0) return { data: {}, variantSegments: [] };

        await core.enrichSuttaBatch(searchResults, suttaIds, targetLangs, keyword, scope, lb, la);
        const sortedData = core.sortSuttaResults(searchResults);
        let totalMatches = 0;
        for (const id of suttaIds) totalMatches += sortedData[id].count;
        const variantSegments = await core.findVariantSegments(keyword, exact);
        return {
            data: sortedData,
            wordReport: core.buildWordReport(searchResults),
            metadata: {
                query: keyword, scope, resolvedPrefixes: core.resolveAllowedPrefixes(scope),
                langs: targetLangs, lb, la, exactMatch: exact,
                totalFiles: suttaIds.length, totalMatches, hasVariantMatch: variantSegments.length > 0,
            },
            variantSegments,
        };
    },

    // Mirrors dg-fastify.js's /api/text route. Two things here are easy to get wrong and were:
    // the columns come from ?langs/?lang, NOT from the mode's `columns` — a mode only supplies
    // multiFor, and only when ?lang is given too; and a language with no translation at all falls
    // back to English, which changes the columns it reports.
    async text({ suttaId, mode, langs, lang, translators, multiFor }) {
        const modeConfig = mode ? core.MODE_TABLE[mode] : null;
        const targetLangs = langs ? langs.split(',').map(l => l.trim())
            : lang ? [lang]
            : ['ru', 'en'];
        const explicitTranslators = translators ? translators.split(',').map(t => t.trim()) : null;
        const multiForLangs = (modeConfig && modeConfig.multiFor && lang) ? [lang]
            : (multiFor ? multiFor.split(',').map(l => l.trim()) : null);

        const base = await core.getSuttaBaseData(suttaId);
        if (!base) return { __status: 404, error: `Unknown sutta id: ${suttaId}` };
        let data = await core.buildTextDataFromBase(base, suttaId, targetLangs, explicitTranslators, multiForLangs);
        let effectiveLangs = targetLangs;

        const hasAnyTranslation = data.segments.some(seg => Object.keys(seg.translations).length > 0);
        if (!modeConfig && !hasAnyTranslation && !targetLangs.includes('en') && !explicitTranslators) {
            const fallbackData = await core.buildTextDataFromBase(base, suttaId, ['en'], null, multiForLangs);
            const fallbackHasTranslation = fallbackData &&
                fallbackData.segments.some(seg => Object.keys(seg.translations).length > 0);
            if (fallbackHasTranslation) {
                data = fallbackData;
                effectiveLangs = targetLangs.concat(['en']);
            }
        }
        data.columns = effectiveLangs;
        data.lang = lang || effectiveLangs[0] || null;
        return data;
    },

    async nav({ suttaId, scope }) {
        const nav = core.navFor(suttaId, scope);
        return nav || { __status: 404, error: `Unknown sutta id: ${suttaId}` };
    },
};

self.onmessage = async (event) => {
    const { id, op, args } = event.data || {};

    // Answerable before the database is opened, and deliberately so: the page needs to know
    // whether a download is coming before it asks the reader about it.
    if (op === 'status') {
        try {
            const pool = await getPool();
            const present = storedDatabases(pool).length > 0;
            // When there is nothing stored, the manifest is fetched before the reader is asked
            // about the download — a few hundred bytes, so that the question can name the real
            // size instead of a number compiled in months ago. Its absence is not fatal.
            const manifest = present ? null : await fetchManifest(args && args.distBase);
            post({ id, ok: true, result: {
                present,
                bytes: manifest ? manifest.bytes : null,
                build_id: manifest ? manifest.build_id : null,
                langs: manifest ? manifest.langs : null,
            } });
        } catch (e) { post({ id, ok: false, error: e.message }); }
        return;
    }

    // "Is there anything new for me?" — one small JSON fetch, compared against the build the open
    // database records. It only reports; replacing 170MB is the reader's decision, not a
    // background one, so nothing is downloaded here. Answering false while offline is correct.
    if (op === 'check') {
        try {
            if (!db) throw new Error('database not opened');
            const local = db.selectObject("SELECT value FROM meta WHERE key = 'build_id'");
            const manifest = await fetchManifest(args.distBase);
            post({ id, ok: true, result: manifest ? {
                current: manifest.build_id === (local && local.value),
                build_id: manifest.build_id,
                bytes: manifest.bytes,
                built_at: manifest.built_at,
                schema_supported: Number(manifest.schema_version) === SCHEMA_VERSION,
            } : { unknown: true } });
        } catch (e) { post({ id, ok: false, error: e.message }); }
        return;
    }

    if (op === 'update') {
        try {
            const pool = await getPool();
            post({ id, ok: true, result: await fetchCurrent(pool, args.distBase, args.sourceUrl) });
        } catch (e) { post({ id, ok: false, error: e.message }); }
        return;
    }

    if (op === 'open') {
        ready = ready || open(args.distBase, args.sourceUrl);
        try { post({ id, ok: true, result: await ready }); }
        catch (e) { ready = null; post({ id, ok: false, error: e.message }); }
        return;
    }

    try {
        if (!ready) throw new Error('database not opened');
        await ready;
        const handler = OPS[op];
        if (!handler) throw new Error(`unknown op: ${op}`);
        post({ id, ok: true, result: await handler(args || {}) });
    } catch (e) {
        post({ id, ok: false, error: e.message });
    }
};
