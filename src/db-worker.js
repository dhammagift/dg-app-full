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

import sqlite3InitModule from './vendor/sqlite-wasm/index.mjs';
import core from './core-bundle.mjs';

// dg-mobile.db, not dg.db: the server's own database is dg.db and lives on the same box, so
// sharing the name is how a symlink ends up pointing 600MB of every language at a phone.
const DB_NAME = '/dg-mobile.db';
const POOL_NAME = 'dg-offline';

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
async function downloadInto(pool, url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`dg-mobile.db: HTTP ${response.status}`);
    const total = Number(response.headers.get('Content-Length')) || 0;
    const reader = response.body.getReader();
    let loaded = 0, lastReport = 0;

    await pool.importDb(DB_NAME, async () => {
        const { done, value } = await reader.read();
        if (done) return undefined;
        loaded += value.byteLength;
        const now = Date.now();
        if (now - lastReport > 200) {
            lastReport = now;
            post({ type: 'progress', loaded, total });
        }
        return value;
    });
    post({ type: 'progress', loaded, total });
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

async function open(distBase) {
    const pool = await getPool();
    const present = pool.getFileNames().includes(DB_NAME);
    if (!present) {
        post({ type: 'downloading' });
        await downloadInto(pool, `${distBase}/dg-mobile.db`);
    }

    db = new pool.OpfsSAHPoolDb(DB_NAME);
    core.init({ searchDb: nodeSqliteShim(db), DG_OFFLINE: '/offline-data/dhammagift' });

    // The same in-memory sutta index initServer() builds on the server, from the same query.
    const skeleton = {};
    for (const row of db.selectObjects('SELECT id, category, dir_path, title, mr FROM suttas')) {
        skeleton[row.id] = { category: row.category, dir_path: row.dir_path, title: row.title, mr: row.mr };
    }
    core.setSkeleton(skeleton);
    return { suttas: Object.keys(skeleton).length, downloaded: !present };
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
            post({ id, ok: true, result: { present: pool.getFileNames().includes(DB_NAME) } });
        } catch (e) { post({ id, ok: false, error: e.message }); }
        return;
    }

    if (op === 'open') {
        ready = ready || open(args.distBase);
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
