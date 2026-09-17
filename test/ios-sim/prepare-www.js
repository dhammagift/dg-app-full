#!/usr/bin/env node
// Turns the built www/ into the bundle a SIMULATOR run uses — the only iOS check that can run
// without an Apple account, a device or a network to dhamma.gift.
//
// Three edits, all of them to build output (www/ is generated, so nothing here touches a committed
// source file, and a shipped bundle is never built this way):
//
//   1. www/mobile-data/{dg.db.gz,db-manifest.json} — the small fixture database, packaged exactly
//      like prod packages dg.db. The app therefore follows its normal path: fetch the archive,
//      unpack it into OPFS, open it through the SAH-pool VFS, answer from it.
//   2. a config script BEFORE /offline/platform.js — which is what makes the run meaningful:
//        DG_DIST_BASE   = '/mobile-data'      the fixture comes from the app's own bundle instead of
//                                             the network, so the test needs no server and no CORS;
//        DG_ONLINE_ORIGIN = 'http://127.0.0.1:59999'  nothing listens there, deliberately. Every
//                                             "needs the internet" fallback in the offline layer is
//                                             now guaranteed to fail, so an answer can ONLY have come
//                                             from the local database. A reachable dhamma.gift would
//                                             let this test pass with OPFS broken. A high, closed port
//                                             on purpose: 9 (the discard port) is on Chromium's
//                                             blocked-port list and fails with ERR_UNSAFE_PORT before
//                                             a socket is even opened, which is a weaker statement than
//                                             "connection refused".
//   3. the self-test script itself, appended at the end of the page (test/ios-sim/selftest.js).
//
// Usage: node test/ios-sim/prepare-www.js [--www www] [--fixture test/fixture.db]

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const REPO = path.join(__dirname, '..', '..');

// The fixture's own meta table: the one authority on build_id, schema version and the languages the
// slice carries. A fixture without it cannot be downloaded by the app at all, so say that here
// rather than letting the run fail later as "incomplete download".
function readMeta(file) {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
        const meta = {};
        for (const row of db.prepare('SELECT key, value FROM meta').all()) meta[row.key] = row.value;
        if (!meta.build_id) fail(`${file} has no meta.build_id — rebuild it with node test/make-fixture-db.js`);
        return meta;
    } catch (e) {
        fail(`could not read meta from ${file}: ${e.message} (rebuild it with node test/make-fixture-db.js)`);
    } finally {
        db.close();
    }
}

function arg(name, fallback) {
    const i = process.argv.indexOf('--' + name);
    return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const WWW = path.resolve(REPO, arg('www', 'www'));
const FIXTURE = path.resolve(REPO, arg('fixture', 'test/fixture.db'));
const DEAD_ORIGIN = 'http://127.0.0.1:59999';
const originLine = /^window\.DG_ONLINE_ORIGIN = .*;$/m;

// Every .js under www, package and vendor directories included: the two files carrying the baked
// origin are mine to know about, not something a hardcoded list should have to keep up with.
function walkJs(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walkJs(full, out);
        else if (entry.name.endsWith('.js')) out.push(full);
    }
    return out;
}

function fail(message) {
    console.error('prepare-www: ' + message);
    process.exit(1);
}

if (!fs.existsSync(path.join(WWW, 'index.html'))) fail(`no built page at ${WWW}/index.html — build www first`);
if (!fs.existsSync(FIXTURE)) fail(`no fixture database at ${FIXTURE} — run node test/make-fixture-db.js`);

// 1. The fixture, packaged like the published library. The manifest is built from the database's own
// `meta` table rather than invented here: public/offline/db-worker.js saves the unpacked file under
// the manifest's build_id and then refuses it unless the file's own meta.build_id matches — that is
// how it detects a download that stopped halfway. Two sources for that id would be a test failing
// for a reason that has nothing to do with iOS.
const dbBytes = fs.readFileSync(FIXTURE);
const meta = readMeta(FIXTURE);
const gzBytes = zlib.gzipSync(dbBytes, { level: 9 });
const dataDir = path.join(WWW, 'mobile-data');
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(path.join(dataDir, 'dg.db.gz'), gzBytes);
const manifest = {
    schema_version: Number(meta.schema_version || 1),
    build_id: meta.build_id,
    langs: meta.langs || 'ru,en',
    fts: meta.fts || 'trigram',
    source: path.basename(FIXTURE),
    built_at: meta.built_at || new Date().toISOString(),
    file_gz: 'dg.db.gz',
    bytes_gz: gzBytes.length,
    bytes: dbBytes.length,
    sha256: crypto.createHash('sha256').update(gzBytes).digest('hex'),
};
fs.writeFileSync(path.join(dataDir, 'db-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`fixture: ${(dbBytes.length / 1024).toFixed(0)} kB -> ${(gzBytes.length / 1024).toFixed(0)} kB gz, build_id ${manifest.build_id}`);

// 2. The config script, before the offline layer reads window.DG_* at load time.
const pagePath = path.join(WWW, 'index.html');
let page = fs.readFileSync(pagePath, 'utf8');
const platformTag = '<script src="/offline/platform.js"></script>';
if (page.indexOf(platformTag) === -1) fail('www/index.html has no /offline/platform.js tag to anchor to');
const configTag = [
    '<script>',
    '/* Injected by test/ios-sim/prepare-www.js for a simulator run — never in a shipped build. */',
    `window.DG_DIST_BASE = ${JSON.stringify('/mobile-data')};`,
    `window.DG_ONLINE_ORIGIN = ${JSON.stringify(DEAD_ORIGIN)};`,
    '</script>',
].join('\n');
if (page.indexOf('window.DG_DIST_BASE') !== -1) fail('www/index.html already carries a test config — rebuild www');
page = page.replace(platformTag, configTag + '\n' + platformTag);

// 2b. The same dead origin in every generated file that carries it — native-bridge.js and
// offline/platform.js both get the line prepended by build-assets.js, and offline/platform.js is
// loaded first, so patching only the page's own config script is not enough. Every "leave the app"
// link, the error-report endpoint and every request the local database cannot answer read this
// variable; pointing them all at a dead port is what makes a 200 answer in this test provably local.
let patched = 0;
for (const file of walkJs(WWW)) {
    const text = fs.readFileSync(file, 'utf8');
    if (!originLine.test(text)) continue;
    fs.writeFileSync(file, text.replace(originLine, `window.DG_ONLINE_ORIGIN = ${JSON.stringify(DEAD_ORIGIN)};`));
    patched++;
}
if (!patched) fail('no generated file in www/ carries a DG_ONLINE_ORIGIN line to replace');
console.log(`origin: ${patched} generated file(s) now point at ${DEAD_ORIGIN}`);

// 3. The self-test itself, last on the page: it waits for the library rather than racing it.
const selftestSrc = path.join(__dirname, 'selftest.js');
if (!fs.existsSync(selftestSrc)) fail('test/ios-sim/selftest.js is missing');
fs.copyFileSync(selftestSrc, path.join(WWW, 'ios-selftest.js'));
const selftestTag = '<script src="/ios-selftest.js"></script>';
if (!page.includes('</body>')) fail('www/index.html has no </body> to append the self-test to');
page = page.replace('</body>', selftestTag + '\n</body>');
fs.writeFileSync(pagePath, page);

console.log(`page: config + ${selftestTag} injected`);
console.log(`ready: www/ is now a simulator test bundle (origin ${DEAD_ORIGIN}, library from /mobile-data)`);
