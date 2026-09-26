// Copies the Uposatha app's own web sources into www/ — the directory `cap sync` packages into the
// APK's assets.
//
// Same split as the dictionary app (dict/build.js): src/ is committed and www/ is build output. The
// UI itself is the live site (capacitor.config.json's server.url), so www/ carries only what the
// app owns: index.html, the "no connection" page Capacitor shows when the site cannot be reached
// (now error.html: it is only shown should the bundled page itself fail to load), and uposatha-bridge.js, which MainActivity injects into the loaded page.
//
// Shared code is pasted in by marker, one source each:
//   "// @rate-prompt"     in uposatha-bridge.js: the rating sheet, from ../src/native-bridge.js
//   "// @site-updater"    in uposatha-bridge.js: the bundled page kept current, from ../src/site-updater.js
//   "// @launch-screens"  in index.html: the "no connection"
//                         screen, from ../src/launch-screens.js
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, 'src');
const WWW = path.join(__dirname, 'www');
const ROOT_SRC = path.join(__dirname, '..', 'src');
const launchScreens = () => fs.readFileSync(path.join(ROOT_SRC, 'launch-screens.js'), 'utf8');

function bridgeSource() {
    const main = fs.readFileSync(path.join(ROOT_SRC, 'native-bridge.js'), 'utf8');
    const block = main.split(/^.*@rate-prompt-begin.*\n/m)[1].split(/^.*@rate-prompt-end.*\n/m)[0];
    return fs.readFileSync(path.join(SRC, 'uposatha-bridge.js'), 'utf8')
        .replace(/^.*\/\/ @rate-prompt .*\n/m, () => block)
        .replace(/^.*\/\/ @site-updater .*\n/m, () => fs.readFileSync(path.join(ROOT_SRC, 'site-updater.js'), 'utf8'))
        .replace(/^.*\/\/ @launch-screens .*\n/m, () => launchScreens());
}

function errorPageSource() {
    return fs.readFileSync(path.join(SRC, 'index.html'), 'utf8')
        .replace('<!-- @launch-screens -->', () => '<script>\n' + launchScreens() + '</script>');
}
module.exports = { bridgeSource, errorPageSource };

// The snapshot of the calendar page (tools/snapshot.js: the page and everything it loads, laid out as the
// site serves it) is what the app opens with no network at all: it becomes www/, with the page itself also
// as www/index.html, and a manifest of what is in it (site-manifest.json: the paths and their SHA-256) that
// the updater compares the site against.
const crypto = require('crypto');
const SNAPSHOT = path.join(__dirname, 'snapshot');

function copyTree(from, to, list) {
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
        const src = path.join(from, entry.name), dst = path.join(to, entry.name);
        if (entry.isDirectory()) { fs.mkdirSync(dst, { recursive: true }); copyTree(src, dst, list); continue; }
        fs.copyFileSync(src, dst);
        list.push('/' + path.relative(WWW, dst).split(path.sep).join('/'));
    }
}

function bundleSnapshot() {
    if (!fs.existsSync(path.join(SNAPSHOT, 'uposatha-calendar.html'))) {
        throw new Error('uposatha/snapshot/ is missing: run  SITE=https://test.dhamma.gift node tools/snapshot.js  first (CI does).');
    }
    const files = [];
    copyTree(SNAPSHOT, WWW, files);
    fs.copyFileSync(path.join(SNAPSHOT, 'uposatha-calendar.html'), path.join(WWW, 'index.html'));
    const empty = files.filter((f) => fs.statSync(path.join(WWW, f)).size === 0);
    if (empty.length) throw new Error('the snapshot has empty files (a bundle with blank styles is worse than none): ' + empty.join(', '));
    const hashes = {};
    for (const f of files) hashes[f] = crypto.createHash('sha256').update(fs.readFileSync(path.join(WWW, f))).digest('hex');
    fs.writeFileSync(path.join(WWW, 'site-manifest.json'), JSON.stringify({ built: new Date().toISOString(), files, hashes }));
    return files.length;
}

if (require.main === module) {
    fs.rmSync(WWW, { recursive: true, force: true });
    fs.mkdirSync(WWW, { recursive: true });
    const bundled = bundleSnapshot();
    const files = fs.readdirSync(SRC);
    for (const name of files) {
        if (name === 'index.html') continue;   // the offline page (below, as error.html): index.html is the calendar
        fs.copyFileSync(path.join(SRC, name), path.join(WWW, name));
    }
    fs.writeFileSync(path.join(WWW, 'uposatha-bridge.js'), bridgeSource());
    fs.writeFileSync(path.join(WWW, 'error.html'), errorPageSource());
    console.log(`uposatha: ${bundled} file(s) of the page snapshot and ${files.length} of the app's own copied to www/`);
}
