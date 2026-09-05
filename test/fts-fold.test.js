const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[2]);

// Query side must fold exactly the way build-app-db.js folded the indexed copy.
const foldCharCache = new Map();
function foldChar(ch) {
    let f = foldCharCache.get(ch);
    if (f === undefined) {
        const st = ch.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
        f = st.length === 1 ? st : ch.toLowerCase();
        if (f.length !== 1) f = ch;
        if (f === 'ё') f = 'е'; // ё -> е
        foldCharCache.set(ch, f);
    }
    return f;
}
const FOLDABLE = /[A-Z-￿]/g;
const fold = t => t.replace(FOLDABLE, foldChar);

const stmt = db.prepare('SELECT count(*) c FROM fts JOIN texts t ON t.rowid = fts.rowid WHERE fts MATCH ?');
const q = kw => stmt.get('"' + fold(kw).replace(/"/g, '""') + '"').c;

let bad = 0;
const chk = (label, ok, extra) => {
    if (!ok) bad++;
    console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (extra !== undefined ? '  -> ' + extra : ''));
};

chk('infix inside compound: kacchapa', q('kacchapa') === 2, q('kacchapa'));
chk('query without diacritics: kacchapanam', q('kacchapanam') > 0, q('kacchapanam'));
chk('query with diacritics: kacchapānaṁ', q('kacchapānaṁ') > 0, q('kacchapānaṁ'));
chk('mixed case: KacchaPA', q('KacchaPA') === 2, q('KacchaPA'));
chk('russian infix', q('ерепах') === 1, q('ерепах'));
chk('yo in query finds e in index', q('ёжик') === 1, q('ёжик'));
chk('e in query finds yo in text', q('ежик') === 1, q('ежик'));
chk('absent word', q('zzzzz') === 0);

console.log(bad ? '\n' + bad + ' FAILED' : '\nplain trigram + pre-folded index behaves like remove_diacritics');
process.exit(bad ? 1 : 0);
