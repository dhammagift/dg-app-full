#!/usr/bin/env node
// Builds a small dg.db in dg-node's exact format, for testing without the corpus.
//
// The point is not to be a corpus — it is to be an ORACLE. dg-fastify.js runs on whatever dg.db
// it is pointed at, so a fixture in the real schema lets the server itself answer the same
// requests the app answers, and the two can be diffed. That is the only check that actually means
// "the app repeats the site" rather than "the app looks about right".
//
// So this mirrors build-search-db.js exactly, including the parts that are easy to get subtly
// wrong: `ord` is the position of a segment within its file (it is what lb/la context windows
// count along), `kind` separates root/variant/translation, translations carry lang+translator+
// source, the html table is separate, and the FTS index is external-content over texts with the
// ё-folded copy and the 'ai' translator left out.
//
// Usage: node test/make-fixture-db.js [out.db]

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const OUT = process.argv[2] || path.join(__dirname, 'fixture.db');
const UNINDEXED_TRANSLATORS = ['ai'];

// Pali chosen so the interesting cases are present: an inflected run of the same stem, a compound
// that only an infix match can find (mahākacchapānaṁ), diacritics, and a niggahita spelled ṁ.
const SUTTAS = [
    {
        id: 'dn22', category: 'dhamma', dir_path: 'pli/ms/sutta/dn', title: 'Mahāsatipaṭṭhānasutta', mr: 12,
        segments: [
            { seg: 'dn22:0.1', root: 'Dīgha Nikāya 22', variant: null, html: '<header><h1>' },
            { seg: 'dn22:1.1', root: 'Evaṁ me sutaṁ—', variant: null, html: '<p>' },
            { seg: 'dn22:1.2', root: 'ekaṁ samayaṁ bhagavā kurūsu viharati.', variant: 'kurūsu → kurusu', html: '' },
            { seg: 'dn22:1.3', root: 'Seyyathāpi kacchapo aṅgāni sake kapāle samodahati.', variant: 'kacchapo → kacchapa', html: '' },
            { seg: 'dn22:1.4', root: 'Mahākacchapānaṁ pana rūpaṁ evaṁ hoti.', variant: null, html: '' },
            { seg: 'dn22:1.5', root: 'Idaṁ vuccati, bhikkhave, dukkhaṁ ariyasaccaṁ.', variant: null, html: '</p>' },
        ],
        translations: {
            'ru|o|dgmain':        ['Дигха Никая 22', 'Так я слышал —', 'однажды Благословенный жил среди куру.', 'Подобно тому, как черепаха втягивает конечности в панцирь.', 'У больших черепах облик именно таков.', 'Это, монахи, называется благородной истиной о страдании.'],
            'ru|sv|dgother':      ['ДН 22', 'Вот что я слышал.', 'Однажды Благословенный пребывал в стране Куру.', 'Словно чepeпaxa, прячущая лапы в свой панцирь.', 'Облик больших черепах таков.', 'Это зовётся, монахи, благородной истиной о страдании.'],
            'ru|ai|null':         ['ДН 22 (ИИ)', 'Так я слышал.', 'Однажды Будда был у куру.', 'Как черепаха прячет лапы.', 'Большие черепахи выглядят так.', 'Это истина о страдании.'],
            'en|sujato|sc':       ['Long Discourses 22', 'So I have heard.', 'At one time the Buddha was staying in the land of the Kurus.', 'Like a turtle drawing its limbs into its shell.', 'Great turtles look just like this.', 'This, mendicants, is called the noble truth of suffering.'],
            'en|thanissaro|dgother': ['DN 22', 'I have heard that on one occasion', 'the Blessed One was staying among the Kurus.', 'Just as a tortoise gathers its limbs in its own shell.', 'Of great tortoises the form is thus.', 'This, monks, is called the noble truth of stress.'],
        },
    },
    {
        id: 'sn56.11', category: 'dhamma', dir_path: 'pli/ms/sutta/sn/sn56', title: 'Dhammacakkappavattanasutta', mr: 9,
        segments: [
            { seg: 'sn56.11:0.1', root: 'Saṁyutta Nikāya 56.11', variant: null, html: '<header><h1>' },
            { seg: 'sn56.11:1.1', root: 'Evaṁ me sutaṁ—', variant: null, html: '<p>' },
            { seg: 'sn56.11:2.1', root: 'Idaṁ kho pana, bhikkhave, dukkhaṁ ariyasaccaṁ.', variant: 'dukkhaṁ → dukkha', html: '' },
            { seg: 'sn56.11:2.2', root: 'Kacchapānaṁ viya gati dukkhā hoti.', variant: null, html: '</p>' },
        ],
        translations: {
            'ru|o|dgmain':  ['Саньютта Никая 56.11', 'Так я слышал —', 'Это, монахи, благородная истина о страдании.', 'Участь их тяжка, словно у черепах.'],
            'en|sujato|sc': ['Linked Discourses 56.11', 'So I have heard.', 'Now this, mendicants, is the noble truth of suffering.', 'Their going is hard, as of turtles.'],
        },
    },
    {
        id: 'pli-tv-bu-vb-pj1', category: 'vinaya', dir_path: 'pli/ms/vinaya/pli-tv-vi/pli-tv-bu-vb', title: 'Paṭhamapārājika', mr: 4,
        segments: [
            { seg: 'pli-tv-bu-vb-pj1:1.1', root: 'Tena samayena buddho bhagavā verañjāyaṁ viharati.', variant: null, html: '<p>' },
            { seg: 'pli-tv-bu-vb-pj1:1.2', root: 'Kacchapasadisā te bhikkhū ahesuṁ.', variant: null, html: '</p>' },
        ],
        translations: {
            'en|brahmali|sc': ['At one time the Buddha was staying at Verañjā.', 'Those monks were like turtles.'],
            'ru|o|dgmain':    ['Однажды Будда пребывал в Вераньдже.', 'Те монахи были подобны черепахам.'],
        },
    },
];

function build() {
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${OUT}${suffix}`, { force: true });
    const db = new DatabaseSync(OUT);
    db.exec('PRAGMA journal_mode = OFF');
    db.exec(`
        CREATE TABLE suttas (
            id TEXT PRIMARY KEY, category TEXT, dir_path TEXT, title TEXT, mr INTEGER);
        CREATE TABLE texts (
            sutta_id TEXT, segment_id TEXT, ord INTEGER,
            kind TEXT, lang TEXT, translator TEXT, source TEXT, txt TEXT);
        CREATE TABLE html (sutta_id TEXT, segment_id TEXT, ord INTEGER, txt TEXT);
    `);

    const insSutta = db.prepare('INSERT INTO suttas VALUES (?,?,?,?,?)');
    const insText = db.prepare(
        'INSERT INTO texts (sutta_id, segment_id, ord, kind, lang, translator, source, txt) VALUES (?,?,?,?,?,?,?,?)');
    const insHtml = db.prepare('INSERT INTO html (sutta_id, segment_id, ord, txt) VALUES (?,?,?,?)');

    db.exec('BEGIN');
    for (const s of SUTTAS) {
        insSutta.run(s.id, s.category, s.dir_path, s.title, s.mr);

        // One file becomes a run of rows sharing (sutta_id, kind, translator); ord restarts per
        // run, exactly as build-search-db.js's ingest() does it.
        let ord = 0;
        for (const seg of s.segments) insText.run(s.id, seg.seg, ord++, 'root', null, null, null, seg.root);
        ord = 0;
        for (const seg of s.segments) {
            if (seg.variant) insText.run(s.id, seg.seg, ord, 'variant', null, null, null, seg.variant);
            ord++;
        }
        ord = 0;
        for (const seg of s.segments) {
            if (seg.html) insHtml.run(s.id, seg.seg, ord, seg.html);
            ord++;
        }
        for (const [key, lines] of Object.entries(s.translations)) {
            const [lang, translator, source] = key.split('|');
            ord = 0;
            for (const line of lines) {
                insText.run(s.id, s.segments[ord].seg, ord, 'translation', lang, translator,
                    source === 'null' ? null : source, line);
                ord++;
            }
        }
    }
    db.exec('COMMIT');

    db.exec(`
        CREATE INDEX idx_texts_sutta   ON texts(sutta_id, kind);
        CREATE INDEX idx_texts_lookup  ON texts(sutta_id, kind, translator, ord);
        CREATE INDEX idx_html_sutta    ON html(sutta_id);
        CREATE INDEX idx_texts_segid   ON texts(segment_id);
    `);

    // The server's own index shape: remove_diacritics on trigram, ё folded into the stored copy,
    // 'ai' excluded. The APP's slice differs deliberately (see build-app-db.js) — this file stands
    // in for dg.db, so it must look like dg.db.
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

    db.exec('ANALYZE');
    const counts = {
        suttas: db.prepare('SELECT count(*) c FROM suttas').get().c,
        texts: db.prepare('SELECT count(*) c FROM texts').get().c,
        html: db.prepare('SELECT count(*) c FROM html').get().c,
        translators: db.prepare("SELECT count(DISTINCT lang || '_' || translator) c FROM texts WHERE kind='translation'").get().c,
    };
    db.close();
    console.log(`${OUT}: ${counts.suttas} suttas, ${counts.texts} text rows, ${counts.html} html rows, ${counts.translators} translators`);
}

build();
