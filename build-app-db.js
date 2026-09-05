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
//   node build-app-db.js --from=/var/www/html/nodejs/dg.db --langs=ru,en
//   node build-app-db.js --langs=ru            # --from/--out default to the repo layout
//
// Runs standalone too — one file, nothing to install (node:sqlite is built in):
//   curl -O https://raw.githubusercontent.com/dhammagift/dg-app-full/main/build-app-db.js
//   node build-app-db.js --from=/var/www/html/nodejs/dg.db --langs=ru,en --out=/var/www/dg-ru-en.db
//   node build-app-db.js --langs=all           # everything, i.e. a plain copy
//   node build-app-db.js --langs=ru,en --fts=prefix   # smaller index, weaker matching (see below)
//   node build-app-db.js --langs=ru,en --fts=none     # no index at all — for measuring only
//
// Output: dist/dg.db

const fs = require('fs');
const path = require('path');
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
    trigram: "tokenize='trigram'",
    prefix:  "tokenize='unicode61 remove_diacritics 2', prefix='2 3 4'",
    none:    null,
};

// dg.db's own index is tokenize='trigram remove_diacritics 1'. The app cannot use that option:
// @capacitor-community/sqlite talks to SQLCipher for Android (net.zetetic:android-database-
// sqlcipher:4.5.3, SQLite ~3.39), and remove_diacritics was only added to the TRIGRAM tokenizer in
// SQLite 3.45 — the trigram tokenizer itself has been there since 3.34, it is just that option
// that is newer. Rather than depend on which SQLite a given device ships, the slice folds the text
// itself before indexing and uses a plain trigram tokenizer, which works on every version that has
// trigram at all.
//
// This is the same trick build-search-db.js already uses for ё (the tokenizer will not fold that
// one either, being a Cyrillic letter in its own right) — just extended to every mark. The fold is
// length-preserving, matching dg-fastify.js's foldText(), so an offset found in folded text still
// slices the real word form ("kacchapānaṁ", not "kacchapanam") out of the original.
const foldCharCache = new Map();
function foldChar(ch) {
    let folded = foldCharCache.get(ch);
    if (folded === undefined) {
        const stripped = ch.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
        folded = stripped.length === 1 ? stripped : ch.toLowerCase();
        if (folded.length !== 1) folded = ch;
        if (folded === 'ё') folded = 'е';
        foldCharCache.set(ch, folded);
    }
    return folded;
}
const FOLDABLE_CHARS = /[A-Z\u0080-\uFFFF]/g;
function foldText(text) {
    return typeof text === 'string' ? text.replace(FOLDABLE_CHARS, foldChar) : text;
}

function parseArgs() {
    const args = { from: null, langs: null, out: null, fts: 'trigram' };
    for (const arg of process.argv.slice(2)) {
        const [key, value] = arg.replace(/^--/, '').split('=');
        if (key === 'from') args.from = value;
        if (key === 'out') args.out = value;
        if (key === 'langs') args.langs = value === 'all' ? 'all' : value.split(',').map(s => s.trim()).filter(Boolean);
        if (key === 'fts') args.fts = value;
    }
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

function main() {
    const args = parseArgs();

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
        args.out = path.join(repoPaths.DIST, 'dg.db');
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
        // Folding happens inside SQLite through a user-defined function, so this stays one
        // set-based insert over ~1.4M rows instead of a round trip per row.
        db.function('dg_fold', { deterministic: true }, foldText);
        db.prepare(
            `INSERT INTO fts(rowid, txt)
             SELECT rowid, dg_fold(txt) FROM texts
             WHERE translator IS NULL OR translator NOT IN (${ph})`
        ).run(...UNINDEXED_TRANSLATORS);
        console.log(`fts index, ${args.fts} (${Date.now() - t}ms)`);
    } else {
        console.log('fts index: skipped (--fts=none) — search will NOT work in this file');
    }

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

    const srcMb = mb(fs.statSync(args.from).size);
    const outMb = mb(fs.statSync(args.out).size);
    console.log(
        `\n${args.out}: ${outMb} MB (from ${srcMb} MB)\n` + breakdown +
        `translations kept: ${kept.map(r => `${r.lang} ${r.c}`).join(', ') || 'none'}\n` +
        `Total ${((Date.now() - started) / 1000).toFixed(1)}s`
    );
}

main();
