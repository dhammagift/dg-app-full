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
//   node build-app-db.js --langs=ru            # --from defaults to $DG_NODE_PATH/dg.db
//   node build-app-db.js --langs=all           # everything, i.e. a plain copy
//
// Output: dist/dg.db

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { DIST, f } = require('./paths');

// Mirrors build-search-db.js: the AI translation is stored so the reader can show it, but stays
// out of the search index. Kept in sync by hand — if that set grows there, it grows here.
const UNINDEXED_TRANSLATORS = ['ai'];

function parseArgs() {
    const args = { from: null, langs: null, out: path.join(DIST, 'dg.db') };
    for (const arg of process.argv.slice(2)) {
        const [key, value] = arg.replace(/^--/, '').split('=');
        if (key === 'from') args.from = value;
        if (key === 'out') args.out = value;
        if (key === 'langs') args.langs = value === 'all' ? 'all' : value.split(',').map(s => s.trim()).filter(Boolean);
    }
    if (!args.from) args.from = f('dg.db');
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
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${args.out}${suffix}`, { force: true });

    const started = Date.now();
    const db = new Database(args.out);
    // Same throwaway-output settings build-search-db.js uses: nothing here is worth recovering,
    // the file is rebuilt from scratch on failure.
    db.pragma('journal_mode = OFF');
    db.pragma('synchronous = OFF');
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
    t = Date.now();
    db.exec(`
        CREATE VIRTUAL TABLE fts USING fts5(
            txt, content='texts', content_rowid='rowid',
            tokenize='trigram remove_diacritics 1');
    `);
    const ph = UNINDEXED_TRANSLATORS.map(() => '?').join(',');
    db.prepare(
        `INSERT INTO fts(rowid, txt)
         SELECT rowid, replace(replace(txt, 'ё', 'е'), 'Ё', 'Е') FROM texts
         WHERE translator IS NULL OR translator NOT IN (${ph})`
    ).run(...UNINDEXED_TRANSLATORS);
    console.log(`fts index (${Date.now() - t}ms)`);

    db.exec('DETACH DATABASE src');
    db.exec('ANALYZE');
    db.close();

    const srcMb = mb(fs.statSync(args.from).size);
    const outMb = mb(fs.statSync(args.out).size);
    console.log(
        `\n${args.out}: ${outMb} MB (from ${srcMb} MB)\n` +
        `translations kept: ${kept.map(r => `${r.lang} ${r.c}`).join(', ') || 'none'}\n` +
        `Total ${((Date.now() - started) / 1000).toFixed(1)}s`
    );
}

main();
