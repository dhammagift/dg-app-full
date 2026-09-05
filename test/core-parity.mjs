// Runs dg-node's search core — the bundled, browser-shaped copy the app will load — against the
// same fixture database the site was captured from, and diffs the answers.
//
// This is the check the whole repository is arranged around. "The app repeats the site" is only
// worth anything if it is a diff of two JSON documents; anything softer than that is how the app
// drifted the first time.
//
// The database here is opened with @sqlite.org/sqlite-wasm, which is what the app will use in the
// WebView: it is the official SQLite build, it has FTS5 with the trigram tokenizer, and its oo1
// API is SYNCHRONOUS — which is why the core needs no rewrite. The one adapter below exists
// because the core was written against node:sqlite's prepare().all() shape.
//
// Usage:
//   node test/make-fixture-db.js ../dg-node/dg.db
//   node build-core-bundle.js
//   node test/core-parity.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const DB = process.env.FIXTURE_DB || path.join(process.env.DG_NODE_PATH || '../dg-node', 'dg.db');
const SNAPSHOTS = path.join(HERE, 'snapshots', 'site');

// node:sqlite's surface, over sqlite-wasm's. Deliberately tiny: if this ever needs to grow into
// something that reshapes results, the core has stopped being portable and that is worth knowing.
function nodeSqliteShim(db) {
    return {
        prepare(sql) {
            return {
                all: (...params) => db.selectObjects(sql, params),
                get: (...params) => db.selectObject(sql, params),
            };
        },
        function(name, opts, fn) {
            db.createFunction(name, (_ctx, ...args) => fn(...args), { deterministic: !!opts?.deterministic });
        },
    };
}

// Loaded exactly the way the worker loads it: as an ES module.
async function loadBundle() {
    const url = pathToFileURL(path.join(REPO, 'www', 'core-bundle.mjs')).href;
    const mod = await import(url);
    if (!mod.default) throw new Error('bundle has no default export');
    return mod.default;
}

// Same shape searchHandler() builds, minus the HTTP. Kept here rather than in the core because it
// IS the route's job — the app's fetch shim will do the same few lines.
function searchLikeTheRoute(core, query, params = {}) {
    const keyword = core.stripSearchPunctuation(query);
    const scope = params.scope || 'default';
    const targetLangs = (params.langs || 'ru,en').split(',').map(l => l.trim());
    const exact = params.exact === 'true';
    const lb = parseInt(params.lb) || 0;
    const la = parseInt(params.la) || 0;
    if (keyword.length < 3) {
        return Promise.resolve({
            metadata: { query: keyword, scope, resolvedPrefixes: core.resolveAllowedPrefixes(scope), langs: targetLangs, totalFiles: 0, totalMatches: 0, hasVariantMatch: false, tooShort: true },
            data: {}, wordReport: [], variantSegments: [],
        });
    }
    return params.fast === '1'
        ? core.buildFastResponse(keyword, scope, exact, targetLangs, lb, la)
        : core.buildSearchResponse(keyword, scope, exact, targetLangs, lb, la);
}

// The cases from test/capture.js that go through /search, with their query strings unpacked.
const CASES = [
    ['search-kacchapa',       'kacchapa',    {}],
    ['search-kacchapa-fast',  'kacchapa',    { fast: '1' }],
    ['search-kacchapa-exact', 'kacchapa',    { exact: 'true' }],
    ['search-context',        'kacchapa',    { lb: '1', la: '2' }],
    ['search-scope-dhamma',   'kacchapa',    { scope: 'dhamma' }],
    ['search-scope-vinaya',   'kacchapa',    { scope: 'vinaya' }],
    ['search-scope-all',      'kacchapa',    { scope: 'all' }],
    ['search-russian',        'черепаха',    {}],
    ['search-punctuation',    '«черепаха»,', {}],
    ['search-diacritics',     'kacchapānaṁ', {}],
    ['search-no-diacritics',  'kacchapanam', {}],
    ['search-too-short',      'ka',          {}],
    ['search-no-hits',        'zzzzzz',      {}],
];

const main = async () => {
    const sqlite3 = await sqlite3InitModule({ print: () => {}, printErr: () => {} });

    // The WASM build has no view of the host filesystem, so the fixture is deserialised into the
    // in-memory database. That is fine for a fixture and NOT how the app will do it: on a device
    // the file is opened through the OPFS SAH-pool VFS, so a 170MB database is read from storage
    // rather than held in RAM.
    const bytes = new Uint8Array(fs.readFileSync(DB));
    const raw = new sqlite3.oo1.DB();
    const ptr = sqlite3.wasm.allocFromTypedArray(bytes);
    const rc = sqlite3.capi.sqlite3_deserialize(
        raw.pointer, 'main', ptr, bytes.length, bytes.length,
        sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE);
    if (rc) throw new Error('sqlite3_deserialize failed with rc=' + rc);
    const core = await loadBundle();

    core.init({ searchDb: nodeSqliteShim(raw), DG_OFFLINE: '/var/www/offline-data/dhammagift' });
    const skeleton = {};
    for (const row of raw.selectObjects('SELECT id, category, dir_path, title, mr FROM suttas')) {
        skeleton[row.id] = { category: row.category, dir_path: row.dir_path, title: row.title, mr: row.mr };
    }
    core.setSkeleton(skeleton);

    let same = 0;
    const differing = [];
    for (const [name, query, params] of CASES) {
        const expected = JSON.parse(fs.readFileSync(path.join(SNAPSHOTS, `${name}.json`), 'utf8')).body;
        let actual;
        try { actual = await searchLikeTheRoute(core, query, params); }
        catch (e) { actual = { __error: e.message }; }
        const a = JSON.stringify(expected), b = JSON.stringify(actual);
        if (a === b) { same++; console.log('SAME  ' + name); }
        else {
            differing.push(name);
            console.log('DIFF  ' + name);
            console.log('   site: ' + a.slice(0, 220));
            console.log('   app : ' + b.slice(0, 220));
        }
    }
    raw.close();
    console.log(`\n${same}/${CASES.length} identical to the site` + (differing.length ? `; differing: ${differing.join(', ')}` : ''));
    process.exit(differing.length ? 1 : 0);
};

main();
