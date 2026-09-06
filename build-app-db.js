#!/usr/bin/env node
// build-app-db.js — cuts a language slice out of dg-node's dg.db for the app to ship.
//
// dg.db holds every language SuttaCentral has, which is right for the server and wrong for a
// phone: measured on prod it is 595MB, and it grows every time SC adds a translation. The app
// needs the same database in the same shape, containing only the languages it offers.
//
// So this does not build anything from the corpus — it copies. dg-node's build-search-db.js stays
// the single thing that reads SC Bilara and decides what a row means; this takes its output and
// removes rows. That keeps the app's database provably a subset of the server's rather than a
// second interpretation of the same source files, which is the whole reason the app moved off its
// own core.db/lang_*.db build.
//
// Pali (kind 'root'/'variant'), the HTML markup and the sutta metadata are always copied whole —
// they are language-independent and the reader needs all of them. Only translations are filtered.
//
// Usage:
//   node build-app-db.js --from=/var/www/html/nodejs/dg.db --langs=ru,en   # -> dist/dg-mobile.db
//   node build-app-db.js --langs=ru            # --from/--out default to the repo layout
//
// Runs standalone too — one file, nothing to install (node:sqlite is built in):
//   curl -O https://raw.githubusercontent.com/dhammagift/dg-app-full/main/build-app-db.js
//   node build-app-db.js --from=/var/www/html/nodejs/dg.db --langs=ru,en --out=/var/www/dg-mobile.db
//   node build-app-db.js --langs=all           # everything, i.e. a plain copy
//   node build-app-db.js --langs=ru,en --fts=prefix   # smaller index, weaker matching (see below)
//   node build-app-db.js --langs=ru,en --fts=none     # no index at all — for measuring only
//
// Output: dist/dg-mobile.db, dist/dg-mobile.db.gz and dist/db-manifest.json beside them.
//
// The .gz is what a device actually downloads: the file is mostly text and text compresses, and
// the worker inflates it on the way into OPFS (src/db-download.js). The plain .db stays published
// for an app old enough not to read the manifest's file_gz. A database that already exists —
// built by an earlier version of this script, or by this one with --no-gzip — is compressed and
// its manifest brought up to date without rebuilding anything:
//
//   node build-app-db.js --compress=/var/www/dg-ru-en.db

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
// node:sqlite, not better-sqlite3, even though this repo depends on the latter: that keeps the
// file runnable on its own. The database being sliced lives on the prod server, which has
// dg-node but no checkout of this repo and no reason to gain one — so this has to work as a
// single downloaded file with nothing installed. dg-fastify.js already runs on node:sqlite
// there, which also settles the only real question: that build has FTS5 with the trigram
// tokenizer, since build-search-db.js creates exactly that index with it.
const { DatabaseSync } = require('node:sqlite');

// Only needed for the --from / --out defaults, and paths.js is part of the repo — so a
// standalone copy still works as long as both are given explicitly.
let repoPaths = null;
try { repoPaths = require('./paths'); } catch (e) { /* running as a single file */ }

// Mirrors build-search-db.js: the AI translation is stored so the reader can show it, but stays
// out of the search index. Kept in sync by hand — if that set grows there, it grows here.
const UNINDEXED_TRANSLATORS = ['ai'];

// How to index. The trigram index is what makes the app's search agree with the site's: it
// indexes every 3-character window, which is what lets "kacchapa" match inside "mahākacchapa" the
// way the server's grep did. That coverage is also why it is large — several times the text it
// indexes. The alternatives exist to be measured against it, not because either is equivalent:
//
//   trigram  (default) — matches the server exactly.
//   prefix             — unicode61 tokens, queried as "word*". Finds the start of a word only,
//                        so compounds stop matching mid-word. This is the FTS4 behaviour the app
//                        shipped before, and its results DIVERGE from the site's.
//   none               — no index. Search does not work; useful only to see what the index costs
//                        and to price building it on the device instead of shipping it.
const FTS_MODES = {
    trigram: "tokenize='trigram remove_diacritics 1'",
    prefix:  "tokenize='unicode61 remove_diacritics 2', prefix='2 3 4'",
    none:    null,
};

// The index is defined exactly as build-search-db.js defines dg.db's, down to the tokenizer
// options, and populated from exactly the same expression. That is not tidiness: the core running
// in the app builds its MATCH queries the same way it does on the server, so any difference in how
// the index folds text is a difference the core cannot see and cannot correct.
//
// It used to differ, and that was exactly the divergence. The slice indexed a fully folded copy of
// the text — every diacritic stripped — under a PLAIN trigram tokenizer, so the stored side was
// folded and the query side was not: the server's tokenizer folds both, a plain one folds neither.
// Searching for "kacchapanam" therefore worked while "kacchapānaṁ", as the word is actually
// written, found nothing in the app and two suttas on the site. Caught by test/e2e-browser.js.
//
// What forced the plain tokenizer was @capacitor-community/sqlite, whose SQLCipher build sits
// around SQLite 3.39 while remove_diacritics reached the TRIGRAM tokenizer in 3.45. That
// dependency is gone — the app runs @sqlite.org/sqlite-wasm 3.53 and nothing else — so the
// constraint went with it. ё stays the one fold done by hand, for the same reason it is on the
// server: the tokenizer treats it as a letter in its own right, and the query side folds it the
// same way.
const YO_FOLD = "replace(replace(txt, 'ё', 'е'), 'Ё', 'Е')";

// Bumped when the SHAPE of the database changes — a column added, a table renamed, the FTS
// definition altered. The app checks it on open and refuses a file it was not built against,
// because the alternative is queries that almost fit.
const SCHEMA_VERSION = 1;

// ---- provenance: what this build contains, at a granularity a patch can address ---------------
// A database that cannot say what is in it can only ever be replaced whole. These two tables are
// what makes anything smaller possible later, and they have to be in the file BEFORE it reaches a
// device: a patch is computed by comparing two builds, and a build that never recorded its own
// contents cannot be one of them.
//
// The unit is (sutta_id, kind, lang, translator). That is the shape corpus changes actually have
// — "these segments of this sutta, by this translator" — never a scattering of single lines. Each
// chunk carries a hash of its text in segment order, so comparing two builds means reading a few
// hundred KB of hashes rather than having both 170MB files. Without this table the only way to
// diff two published databases is to download the old one.
//
// build_id is the hash OF those hashes, not a timestamp or a counter. Two builds of the same
// corpus therefore get the same id even though their bytes differ — the FTS index is rebuilt from
// scratch every run, so page layout never matches — which is what lets a device ask "is there
// anything new for me?" and get an honest no after a CI run that changed nothing.
function buildProvenance(db, args, srcPath) {
    db.exec(`
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT) WITHOUT ROWID;
        CREATE TABLE chunks (
            sutta_id TEXT, kind TEXT, lang TEXT, translator TEXT,
            n INTEGER, hash TEXT,
            PRIMARY KEY (sutta_id, kind, lang, translator)) WITHOUT ROWID;
    `);

    const insert = db.prepare('INSERT INTO chunks VALUES (?, ?, ?, ?, ?, ?)');
    const buildHash = crypto.createHash('sha256');
    let chunkCount = 0, rowCount = 0;
    let key = null, hash = null, n = 0;

    const flush = () => {
        if (!key) return;
        const digest = hash.digest('hex').slice(0, 32);
        insert.run(key[0], key[1], key[2], key[3], n, digest);
        // The key goes into build_id alongside the digest, so a chunk that MOVES — same text,
        // different translator — still counts as a change.
        buildHash.update(`${key.join(' ')} ${digest}\n`);
        chunkCount++;
    };

    // Streamed, not .all(): this walks every row in the database, and materialising 1.4M of them
    // as JS objects to hash each once would cost more memory than the rest of the build together.
    // html joins in as its own kind — markup changes with the corpus like anything else.
    const statement = db.prepare(`
        SELECT sutta_id, kind, COALESCE(lang, '') lang, COALESCE(translator, '') translator, ord, txt
          FROM texts
         UNION ALL
        SELECT sutta_id, 'html', '', '', ord, txt FROM html
         ORDER BY 1, 2, 3, 4, 5`);

    db.exec('BEGIN');
    for (const row of statement.iterate()) {
        rowCount++;
        if (!key || key[0] !== row.sutta_id || key[1] !== row.kind ||
            key[2] !== row.lang || key[3] !== row.translator) {
            flush();
            key = [row.sutta_id, row.kind, row.lang, row.translator];
            hash = crypto.createHash('sha256');
            n = 0;
        }
        // segment_id is deliberately not hashed: ord already fixes the position, and a
        // renumbering that leaves every text alone is not a change a reader can see.
        hash.update(row.txt == null ? '' : String(row.txt));
        hash.update('\n');
        n++;
    }
    flush();
    db.exec('COMMIT');

    const meta = {
        schema_version: String(SCHEMA_VERSION),
        build_id: buildHash.digest('hex').slice(0, 16),
        langs: args.langs === 'all' ? 'all' : args.langs.join(','),
        fts: args.fts,
        source: path.basename(srcPath),
        built_at: new Date().toISOString(),
    };
    const setMeta = db.prepare('INSERT INTO meta VALUES (?, ?)');
    for (const [k, v] of Object.entries(meta)) setMeta.run(k, v);
    return { meta, chunks: chunkCount, rows: rowCount };
}

// Read in 1MB blocks rather than through fs.readFileSync: the file being hashed is the 170MB one.
function sha256File(file) {
    const hash = crypto.createHash('sha256');
    const fd = fs.openSync(file, 'r');
    try {
        const buffer = Buffer.allocUnsafe(1 << 20);
        let read;
        while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
            hash.update(buffer.subarray(0, read));
        }
    } finally { fs.closeSync(fd); }
    return hash.digest('hex');
}

function parseArgs() {
    const args = { from: null, langs: null, out: null, fts: 'trigram', gzip: true, compress: null };
    for (const arg of process.argv.slice(2)) {
        const [key, value] = arg.replace(/^--/, '').split('=');
        if (key === 'from') args.from = value;
        if (key === 'out') args.out = value;
        if (key === 'langs') args.langs = value === 'all' ? 'all' : value.split(',').map(s => s.trim()).filter(Boolean);
        if (key === 'fts') args.fts = value;
        if (key === 'no-gzip') args.gzip = false;
        if (key === 'compress') args.compress = value;
    }
    if (args.compress) return args;
    if (!(args.fts in FTS_MODES)) {
        console.error(`--fts must be one of: ${Object.keys(FTS_MODES).join(', ')}`);
        process.exit(1);
    }
    if (!args.from) {
        if (!repoPaths) {
            console.error('--from is required when running this file outside the repo');
            process.exit(1);
        }
        args.from = repoPaths.f('dg.db');
    }
    if (!args.langs) {
        console.error('--langs is required (e.g. --langs=ru,en, or --langs=all for no filtering)');
        process.exit(1);
    }
    return args;
}

function mb(bytes) { return (bytes / 1048576).toFixed(1); }

// ---- the compressed copy ----------------------------------------------------------------------
// Written beside the database as <file>.gz and recorded in the manifest as file_gz/bytes_gz, so a
// device can choose it. Streamed through zlib rather than read into memory — the input is the
// hundreds-of-MB file this whole script exists to keep off a phone's RAM, and the server this runs
// on is the one dg-node already fills.
//
// gzip and not something stronger because the other end is a WebView: DecompressionStream speaks
// gzip and deflate and nothing else, and no library has to ship in the APK for it.
function gzipFile(file) {
    return new Promise((resolve, reject) => {
        const out = `${file}.gz`;
        const tmp = `${out}.part`;
        const gzip = zlib.createGzip({ level: zlib.constants.Z_BEST_COMPRESSION, memLevel: 9 });
        fs.createReadStream(file, { highWaterMark: 1 << 20 })
            .on('error', reject)
            .pipe(gzip).on('error', reject)
            .pipe(fs.createWriteStream(tmp)).on('error', reject)
            .on('finish', () => {
                try { fs.renameSync(tmp, out); resolve(out); } catch (e) { reject(e); }
            });
    });
}

// The manifest's compressed-file entries, computed from the .gz that exists on disk. Kept
// separate from the manifest's other fields so --compress can add them to a manifest written by
// an older version of this script without recomputing anything about the database itself.
function compressedEntries(dbFile, gzFile) {
    return {
        file_gz: path.basename(gzFile),
        bytes_gz: fs.statSync(gzFile).size,
        sha256_gz: sha256File(gzFile),
    };
}

// --compress=<db>: gzip an existing database and update the manifest beside it. This is the path
// for a server that already has the file: nothing is rebuilt, the build_id does not change, and a
// device that has this build already is not told there is anything new.
async function compressExisting(dbFile) {
    if (!fs.existsSync(dbFile)) throw new Error(`database not found: ${dbFile}`);
    const manifestPath = path.join(path.dirname(dbFile), 'db-manifest.json');
    let manifest = null;
    if (fs.existsSync(manifestPath)) {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        if (manifest.file && manifest.file !== path.basename(dbFile)) {
            throw new Error(
                `${manifestPath} describes ${manifest.file}, not ${path.basename(dbFile)} — ` +
                `compress the file the manifest names, or move the manifest`);
        }
    } else {
        // A database published before manifests existed. The device-facing fields it needs are
        // read from the file's own meta table, which every build since provenance carries.
        const db = new DatabaseSync(dbFile, { readOnly: true });
        const meta = {};
        let hasMeta = true;
        try {
            for (const row of db.prepare('SELECT key, value FROM meta').all()) meta[row.key] = row.value;
        } catch (e) {
            hasMeta = false;
        } finally { db.close(); }
        if (!hasMeta) {
            // Older still: no meta at all. The app opens such a file (the worker keeps it under
            // its legacy name) and the download works, but it carries no build_id, so no device
            // can ever be told that a newer build exists. Good enough to test with, and said so.
            console.warn(
                `WARNING: ${dbFile} has no meta table (built before provenance). The manifest will name it\n` +
                `and its .gz, but without a build_id — devices cannot be offered an update until it is\n` +
                `rebuilt: node build-app-db.js --from=<dg.db> --langs=ru,en --out=${dbFile}`);
        }
        manifest = { ...meta, schema_version: Number(meta.schema_version) || SCHEMA_VERSION, patches: [] };
    }
    manifest.file = path.basename(dbFile);
    manifest.bytes = fs.statSync(dbFile).size;
    if (!manifest.sha256) manifest.sha256 = sha256File(dbFile);

    let t = Date.now();
    console.log(`compressing ${dbFile} (${mb(manifest.bytes)} MB)...`);
    const gzFile = await gzipFile(dbFile);
    Object.assign(manifest, compressedEntries(dbFile, gzFile));
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    console.log(
        `${gzFile}: ${mb(manifest.bytes_gz)} MB — ${Math.round(100 * manifest.bytes_gz / manifest.bytes)}% ` +
        `of the ${mb(manifest.bytes)} MB database (${((Date.now() - t) / 1000).toFixed(1)}s)\n` +
        `manifest: ${manifestPath} (build ${manifest.build_id || 'none'}, file_gz ${manifest.file_gz})`);
}

async function main() {
    const args = parseArgs();
    if (args.compress) return compressExisting(args.compress);

    if (!fs.existsSync(args.from)) {
        throw new Error(
            `source database not found: ${args.from}\n` +
            `Build it in dg-node first ("npm run build-search-db"), or pass --from=<path>.`
        );
    }
    if (!args.out) {
        if (!repoPaths) {
            console.error('--out is required when running this file outside the repo');
            process.exit(1);
        }
        args.out = path.join(repoPaths.DIST, 'dg-mobile.db');
    }
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${args.out}${suffix}`, { force: true });

    const started = Date.now();
    const db = new DatabaseSync(args.out);
    // Same throwaway-output settings build-search-db.js uses: nothing here is worth recovering,
    // the file is rebuilt from scratch on failure.
    db.exec('PRAGMA journal_mode = OFF');
    db.exec('PRAGMA synchronous = OFF');
    db.exec(`ATTACH DATABASE '${args.from.replace(/'/g, "''")}' AS src`);

    // Schema copied verbatim from build-search-db.js. Not read back from src's sqlite_master on
    // purpose: a silent schema drift between the two repos should fail loudly here, at build time,
    // not produce a database whose columns the app's queries almost fit.
    db.exec(`
        CREATE TABLE suttas (
            id TEXT PRIMARY KEY, category TEXT, dir_path TEXT, title TEXT, mr INTEGER);
        CREATE TABLE texts (
            sutta_id TEXT, segment_id TEXT, ord INTEGER,
            kind TEXT, lang TEXT, translator TEXT, source TEXT, txt TEXT);
        CREATE TABLE html (sutta_id TEXT, segment_id TEXT, ord INTEGER, txt TEXT);
    `);

    const all = args.langs === 'all';
    const langList = all ? [] : args.langs;
    const langPlaceholders = langList.map(() => '?').join(',');

    let t = Date.now();
    db.exec('BEGIN');
    db.prepare('INSERT INTO suttas SELECT * FROM src.suttas').run();
    db.prepare('INSERT INTO html SELECT * FROM src.html').run();

    // rowid is carried across explicitly. The FTS index below is external-content
    // (content='texts', content_rowid='rowid'), so every indexed row is addressed by the rowid of
    // its texts row — let SQLite assign fresh ones and the index would point at the wrong text.
    const textsSql = all
        ? 'INSERT INTO texts(rowid, sutta_id, segment_id, ord, kind, lang, translator, source, txt) ' +
          'SELECT rowid, sutta_id, segment_id, ord, kind, lang, translator, source, txt FROM src.texts'
        : 'INSERT INTO texts(rowid, sutta_id, segment_id, ord, kind, lang, translator, source, txt) ' +
          'SELECT rowid, sutta_id, segment_id, ord, kind, lang, translator, source, txt FROM src.texts ' +
          `WHERE kind <> 'translation' OR lang IN (${langPlaceholders})`;
    const inserted = db.prepare(textsSql).run(...(all ? [] : langList));
    db.exec('COMMIT');
    console.log(`copied: ${inserted.changes} text rows (${Date.now() - t}ms)`);

    const kept = db.prepare(
        "SELECT lang, count(*) c FROM texts WHERE kind = 'translation' GROUP BY lang ORDER BY c DESC"
    ).all();
    if (!all) {
        const got = new Set(kept.map(r => r.lang));
        const absent = langList.filter(l => !got.has(l));
        if (absent.length) {
            throw new Error(
                `requested language(s) not present in ${args.from}: ${absent.join(', ')}\n` +
                `Available: ${db.prepare("SELECT DISTINCT lang FROM src.texts WHERE kind='translation' ORDER BY lang")
                    .all().map(r => r.lang).join(', ')}`
            );
        }
    }

    t = Date.now();
    db.exec(`
        CREATE INDEX idx_texts_sutta   ON texts(sutta_id, kind);
        CREATE INDEX idx_texts_lookup  ON texts(sutta_id, kind, translator, ord);
        CREATE INDEX idx_html_sutta    ON html(sutta_id);
        CREATE INDEX idx_texts_segid   ON texts(segment_id);
    `);
    console.log(`indexes (${Date.now() - t}ms)`);

    // The index is rebuilt rather than copied: it is derived data, and building it here keeps the
    // ё-folding and the excluded translators identical to build-search-db.js by construction.
    if (FTS_MODES[args.fts]) {
        t = Date.now();
        db.exec(`
            CREATE VIRTUAL TABLE fts USING fts5(
                txt, content='texts', content_rowid='rowid',
                ${FTS_MODES[args.fts]});
        `);
        const ph = UNINDEXED_TRANSLATORS.map(() => '?').join(',');
        db.prepare(
            `INSERT INTO fts(rowid, txt)
             SELECT rowid, ${YO_FOLD} FROM texts
             WHERE translator IS NULL OR translator NOT IN (${ph})`
        ).run(...UNINDEXED_TRANSLATORS);
        console.log(`fts index, ${args.fts} (${Date.now() - t}ms)`);
    } else {
        console.log('fts index: skipped (--fts=none) — search will NOT work in this file');
    }

    t = Date.now();
    const provenance = buildProvenance(db, args, args.from);
    console.log(
        `provenance: build ${provenance.meta.build_id}, ` +
        `${provenance.chunks} chunks over ${provenance.rows} rows (${Date.now() - t}ms)`);

    // Where the bytes went. The index usually dominates, and that is the number worth seeing
    // before deciding what to ship — guessing at it is how you end up shipping 170MB by accident.
    let breakdown = '';
    try {
        const rows = db.prepare('SELECT name, sum(pgsize) b FROM dbstat GROUP BY name').all();
        let ftsBytes = 0, idxBytes = 0, dataBytes = 0;
        for (const r of rows) {
            if (r.name.startsWith('fts')) ftsBytes += Number(r.b);
            else if (r.name.startsWith('idx_') || r.name.startsWith('sqlite_')) idxBytes += Number(r.b);
            else dataBytes += Number(r.b);
        }
        breakdown = `  data ${mb(dataBytes)} MB · indexes ${mb(idxBytes)} MB · fts ${mb(ftsBytes)} MB\n`;
    } catch (e) { /* dbstat is a compile-time option; skip the breakdown if absent */ }

    db.exec('DETACH DATABASE src');
    db.exec('ANALYZE');
    db.close();

    // The manifest is what a device reads BEFORE deciding to download anything: it is a few
    // hundred bytes, it carries the same build_id the file itself records in meta, and comparing
    // the two is the entire "do I need this?" question. Published next to the database, under a
    // fixed name, so the app needs no index of past builds to find the current one.
    const bytes = fs.statSync(args.out).size;
    t = Date.now();
    const manifest = {
        ...provenance.meta,
        schema_version: SCHEMA_VERSION,
        file: path.basename(args.out),
        bytes,
        sha256: sha256File(args.out),
        chunks: provenance.chunks,
        // Empty for now, and named anyway: the applier reads this list to decide between a patch
        // chain and a full download, and a device shipped today must already understand the shape
        // it will see tomorrow rather than choke on an unknown field.
        patches: [],
    };
    // The compressed copy is what a device downloads; see gzipFile(). Written before the manifest
    // so the manifest never names a .gz that is not there yet.
    let gzLine = '';
    if (args.gzip) {
        t = Date.now();
        fs.rmSync(`${args.out}.gz`, { force: true });
        const gzFile = await gzipFile(args.out);
        Object.assign(manifest, compressedEntries(args.out, gzFile));
        gzLine = `${gzFile}: ${mb(manifest.bytes_gz)} MB on the wire ` +
            `(${Math.round(100 * manifest.bytes_gz / bytes)}% of the database, gzip in ${Date.now() - t}ms)\n`;
    }
    const manifestPath = path.join(path.dirname(args.out), 'db-manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    console.log(`manifest: ${manifestPath}`);

    const srcMb = mb(fs.statSync(args.from).size);
    const outMb = mb(bytes);
    console.log(
        `\n${args.out}: ${outMb} MB (from ${srcMb} MB)\n` + breakdown + gzLine +
        `build ${manifest.build_id} · schema ${SCHEMA_VERSION} · ${provenance.chunks} chunks\n` +
        `translations kept: ${kept.map(r => `${r.lang} ${r.c}`).join(', ') || 'none'}\n` +
        `Total ${((Date.now() - started) / 1000).toFixed(1)}s`
    );
}

main().catch(e => { console.error(e.message || e); process.exit(1); });
