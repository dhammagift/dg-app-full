#!/usr/bin/env node
// Captures a fixed matrix of API responses from a running server into JSON files.
//
// Used to pin down what "the app repeats the site" has to mean concretely. Point it at
// dg-fastify.js running on the fixture database (test/make-fixture-db.js) and it writes the
// answers the site gives; point it later at the app's own core over the same fixture and the two
// directories can be diffed. Any difference is either a bug in the app or a decision someone has
// to make on purpose — which is the whole reason to have the files rather than an impression.
//
// The matrix is deliberately made of the cases that broke before, not of round numbers:
// a stem that only matches inside a compound, a query carrying the punctuation people paste in
// from a translation, both phases of the two-step client protocol, every reader mode, and a scope
// that has to exclude the vinaya text.
//
// Usage:
//   node test/make-fixture-db.js ../dg-node/dg.db
//   (cd ../dg-node && PORT=3000 node dg-fastify.js &)
//   node test/capture.js --base=http://localhost:3000 --out=test/snapshots/site

const fs = require('fs');
const path = require('path');

const REQUESTS = [
    // Search — the stem is present bare, inflected, and inside a compound.
    ['search-kacchapa',        '/search?q=kacchapa&langs=ru,en'],
    ['search-kacchapa-fast',   '/search?q=kacchapa&langs=ru,en&fast=1'],
    ['search-kacchapa-exact',  '/search?q=kacchapa&langs=ru,en&exact=true'],
    ['search-context',         '/search?q=kacchapa&langs=ru,en&lb=1&la=2'],
    ['search-scope-dhamma',    '/search?q=kacchapa&langs=ru,en&scope=dhamma'],
    ['search-scope-vinaya',    '/search?q=kacchapa&langs=ru,en&scope=vinaya'],
    ['search-scope-all',       '/search?q=kacchapa&langs=ru,en&scope=all'],
    // Cyrillic, and the same query with the punctuation a pasted quotation carries.
    ['search-russian',         '/search?q=черепаха&langs=ru,en'],
    ['search-punctuation',     '/search?q=%C2%ABчерепаха%C2%BB,&langs=ru,en'],
    // Diacritics present and absent must reach the same rows.
    ['search-diacritics',      '/search?q=kacchap%C4%81na%E1%B9%81&langs=ru,en'],
    ['search-no-diacritics',   '/search?q=kacchapanam&langs=ru,en'],
    // Below the trigram floor: has to be refused, not answered wrongly.
    ['search-too-short',       '/search?q=ka&langs=ru,en'],
    ['search-no-hits',         '/search?q=zzzzzz&langs=ru,en'],
    // Second phase of the phased client.
    ['enrich-dn22',            '/search/enrich?q=kacchapa&ids=dn22&langs=ru,en'],
    // Reader: every mode in configs/reader/mode-table.json.
    ['text-dn22-st',           '/api/text/dn22?mode=st'],
    ['text-dn22-mt',           '/api/text/dn22?mode=mt'],
    ['text-dn22-ml',           '/api/text/dn22?mode=ml'],
    ['text-dn22-read',         '/api/text/dn22?mode=read'],
    ['text-dn22-ee',           '/api/text/dn22?mode=ee'],
    ['text-explicit-translators', '/api/text/dn22?translators=ru_o,ru_sv'],
    ['text-unknown',           '/api/text/nosuchsutta'],
    // Navigation, including the scope-aware neighbours.
    ['nav-dn22',               '/api/nav/dn22'],
    ['nav-sn56.11',            '/api/nav/sn56.11'],
    ['nav-scoped',             '/api/nav/dn22?scope=dhamma'],
];

function parseArgs() {
    const args = { base: 'http://localhost:3000', out: null };
    for (const arg of process.argv.slice(2)) {
        const [k, v] = arg.replace(/^--/, '').split('=');
        if (k === 'base') args.base = v;
        if (k === 'out') args.out = v;
    }
    if (!args.out) { console.error('--out=<dir> is required'); process.exit(1); }
    return args;
}

async function main() {
    const args = parseArgs();
    fs.mkdirSync(args.out, { recursive: true });
    let ok = 0, failed = 0;
    for (const [name, url] of REQUESTS) {
        const dest = path.join(args.out, `${name}.json`);
        try {
            const res = await fetch(args.base + url);
            const body = await res.text();
            // Status is recorded alongside the body: "404 for an unknown sutta" is part of the
            // contract, and a capture that only kept bodies would call two different answers equal.
            let parsed;
            try { parsed = JSON.parse(body); } catch (e) { parsed = { __nonJson: body.slice(0, 400) }; }
            fs.writeFileSync(dest, JSON.stringify({ status: res.status, body: parsed }, null, 1) + '\n');
            ok++;
        } catch (e) {
            fs.writeFileSync(dest, JSON.stringify({ error: e.message }, null, 1) + '\n');
            failed++;
        }
    }
    console.log(`captured ${ok} response(s) into ${args.out}${failed ? `, ${failed} failed` : ''}`);
    if (failed) process.exitCode = 1;
}

main();
