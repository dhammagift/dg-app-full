// Checks that the slice's FTS index folds text the way dg-node's core expects it to.
//
// The core states the contract itself (core/search-core.js, above ftsPhrase): "The FTS index
// stores a ё-folded copy, so the query has to be folded the same way. Diacritics need no help
// here — the tokenizer folds those on both sides." The core is shared with the server, so the
// slice has to satisfy that contract exactly. When it did not — a fully pre-folded index under a
// plain trigram tokenizer — the app answered nothing for "kacchapānaṁ" while the site answered
// two suttas, and only the already-folded spelling "kacchapanam" worked. That is the regression
// this file exists to catch, and it is checked two ways.
//
// First, the definition: the slice's index DDL has to be dg.db's, character for character. That
// is the property the core actually depends on, and it is the one that silently drifted.
//
// Then, the behaviour: a handful of rows built here under that same definition. Self-contained on
// purpose — tying these cases to the shared fixture is what made them stale, since the fixture has
// no word with ё in it and the counts moved whenever it did.
//
// Usage: node test/fts-fold.test.js [db]   (default: dist/dg-mobile.db)

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const REPO = path.join(__dirname, '..');
const SLICE = process.argv[2] || path.join(REPO, 'dist', 'dg-mobile.db');

let bad = 0;
const chk = (label, ok, extra) => {
    if (!ok) bad++;
    console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (extra !== undefined ? '  -> ' + extra : ''));
};

// ---- the definition -------------------------------------------------------------------------
// Read out of dg-node's build script rather than repeated here: a copy of the expected string in
// this file would drift alongside the one it is meant to police.
const NODE_ROOT = process.env.DG_NODE_PATH || path.join(REPO, '..', 'dg-node');
const serverBuild = path.join(NODE_ROOT, 'build-search-db.js');
if (fs.existsSync(serverBuild)) {
    const wanted = (fs.readFileSync(serverBuild, 'utf8').match(/tokenize='([^']+)'/) || [])[1];
    const sliceBuild = fs.readFileSync(path.join(REPO, 'build-app-db.js'), 'utf8');
    const got = (sliceBuild.match(/trigram:\s*"tokenize='([^']+)'"/) || [])[1];
    chk(`tokenizer matches dg.db's: ${wanted}`, wanted && wanted === got, got);

    if (fs.existsSync(SLICE)) {
        const built = new DatabaseSync(SLICE);
        const ddl = built.prepare("SELECT sql FROM sqlite_master WHERE name = 'fts'").get();
        chk('built slice carries that tokenizer', !!ddl && ddl.sql.includes(`tokenize='${wanted}'`),
            ddl ? (ddl.sql.match(/tokenize='[^']+'/) || ['none'])[0] : 'no fts table');
        built.close();
    } else {
        console.log('SKIP  built slice not present (run build-app-db.js to check it too)');
    }
} else {
    console.log(`SKIP  dg-node not at ${NODE_ROOT} — definition check needs it`);
}

// ---- the behaviour --------------------------------------------------------------------------
const db = new DatabaseSync(':memory:');
db.exec(`
    CREATE TABLE texts (txt TEXT);
    CREATE VIRTUAL TABLE fts USING fts5(
        txt, content='texts', content_rowid='rowid',
        tokenize='trigram remove_diacritics 1');
`);
const ROWS = [
    'Seyyathāpi kacchapo aṅgāni sake kapāle samodahati.',
    'Mahākacchapānaṁ pana rūpaṁ evaṁ hoti.',
    'Подобно тому, как черепаха втягивает конечности в панцирь.',
    'Ёжик в тумане нёс узелок.',
];
const insert = db.prepare('INSERT INTO texts(txt) VALUES (?)');
for (const row of ROWS) insert.run(row);
// The same expression build-app-db.js populates the index with: ё folded, nothing else.
db.exec("INSERT INTO fts(rowid, txt) SELECT rowid, replace(replace(txt, 'ё', 'е'), 'Ё', 'Е') FROM texts");

// The query side folds ё and nothing else, exactly as the core does. If a case below needs the
// query stripped of diacritics to pass, the index is wrong, not the test.
const foldYo = t => t.replace(/ё/g, 'е').replace(/Ё/g, 'Е');
const stmt = db.prepare('SELECT count(*) c FROM fts WHERE fts MATCH ?');
const q = kw => stmt.get('"' + foldYo(kw).replace(/"/g, '""') + '"').c;

// Only the compound row: the other Pali row reads "kacchapo", which does not contain it.
chk('infix inside a compound: kacchapa', q('kacchapa') === 1, q('kacchapa'));
chk('query without diacritics: kacchapanam', q('kacchapanam') === 1, q('kacchapanam'));
// The case that was broken: the word as it is actually written.
chk('query with diacritics: kacchapānaṁ', q('kacchapānaṁ') === 1, q('kacchapānaṁ'));
chk('mixed case: KacchaPA', q('KacchaPA') === 1, q('KacchaPA'));
chk('russian infix', q('ерепах') === 1, q('ерепах'));
chk('yo in query finds e in index', q('ёжик') === 1, q('ёжик'));
chk('e in query finds yo in text', q('ежик') === 1, q('ежик'));
chk('e in query finds yo mid-word', q('нес узелок') === 1, q('нес узелок'));
chk('absent word', q('zzzzz') === 0, q('zzzzz'));

console.log(bad ? `\n${bad} FAILED` : '\nthe slice folds exactly as dg.db does');
process.exit(bad ? 1 : 0);
