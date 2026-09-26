// Copies the dictionary app's own web sources into www/ — the directory `cap sync` packages into
// the APK's assets.
//
// Same split as this repository's root: src/ is committed and www/ is build output (and ignored by
// .gitignore's `www/` rule). There is nothing to generate beyond the copy, because the UI itself is
// the live site, reached through capacitor.config.json's server.url. www/ carries only what the
// app owns: index.html, the page Capacitor shows when the site cannot be reached, and
// dict-bridge.js, which MainActivity injects into the loaded page.
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, 'src');
const WWW = path.join(__dirname, 'www');

// Two markers, one source each. dict-bridge.js carries "// @rate-prompt": the rating sheet lives
// once, in the main app's src/native-bridge.js between its @rate-prompt-begin/-end markers, and is
// pasted in here. The same file and the offline page carry "@launch-screens": the splash and the
// "no connection" screen live once, in src/launch-screens.js.
const ROOT_SRC = path.join(__dirname, '..', 'src');
const launchScreens = () => fs.readFileSync(path.join(ROOT_SRC, 'launch-screens.js'), 'utf8');

function bridgeSource() {
    const main = fs.readFileSync(path.join(ROOT_SRC, 'native-bridge.js'), 'utf8');
    const block = main.split(/^.*@rate-prompt-begin.*\n/m)[1].split(/^.*@rate-prompt-end.*\n/m)[0];
    return fs.readFileSync(path.join(SRC, 'dict-bridge.js'), 'utf8')
        .replace(/^.*\/\/ @rate-prompt .*\n/m, () => block)
        .replace(/^.*\/\/ @site-updater .*\n/m, () => fs.readFileSync(path.join(ROOT_SRC, 'site-updater.js'), 'utf8'));
}

// The offline page: <!-- @launch-screens --> becomes the shared script, inline (the page is served
// from the app's own assets, and one file fewer is one request fewer when the network is the problem).
function errorPageSource() {
    return fs.readFileSync(path.join(SRC, 'index.html'), 'utf8')
        .replace('<!-- @launch-screens -->', () => '<script>\n' + launchScreens() + '</script>');
}
module.exports = { bridgeSource, errorPageSource };

// The snapshot of the dictionary's page (tools/snapshot.js: the page in both languages and everything it loads,
// laid out as the site serves it) is what the app opens with no network at all: it becomes www/ (the page
// itself is www/index.html and www/ru/index.html), with a manifest of what is in it (site-manifest.json: the
// paths and their SHA-256) that the updater compares the site against.
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
    if (!fs.existsSync(path.join(SNAPSHOT, 'index.html'))) {
        throw new Error('dict/snapshot/ is missing: run  SITE=https://dict.dhamma.gift node tools/snapshot.js  first (CI does).');
    }
    const files = [];
    copyTree(SNAPSHOT, WWW, files);
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
        if (name === 'index.html') continue;   // the offline page (below, as error.html): index.html is the dictionary
        fs.copyFileSync(path.join(SRC, name), path.join(WWW, name));
    }
    fs.writeFileSync(path.join(WWW, 'dict-bridge.js'), bridgeSource());
    fs.writeFileSync(path.join(WWW, 'error.html'), errorPageSource());
    console.log(`dict: ${bundled} file(s) of the page snapshot and ${files.length} of the app's own copied to www/`);
}
