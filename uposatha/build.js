// Copies the Uposatha app's own web sources into www/ — the directory `cap sync` packages into the
// APK's assets.
//
// Same split as the dictionary app (dict/build.js): src/ is committed and www/ is build output. The
// UI itself is the live site (capacitor.config.json's server.url), so www/ carries only what the
// app owns: index.html, the "no connection" page Capacitor shows when the site cannot be reached
// (server.errorPath), and uposatha-bridge.js, which MainActivity injects into the loaded page.
//
// Shared code is pasted in by marker, one source each:
//   "// @rate-prompt"     in uposatha-bridge.js: the rating sheet, from ../src/native-bridge.js
//   "// @launch-screens"  in uposatha-bridge.js and index.html: the splash and the "no connection"
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
        .replace(/^.*\/\/ @launch-screens .*\n/m, () => launchScreens());
}

function errorPageSource() {
    return fs.readFileSync(path.join(SRC, 'index.html'), 'utf8')
        .replace('<!-- @launch-screens -->', () => '<script>\n' + launchScreens() + '</script>');
}
module.exports = { bridgeSource, errorPageSource };

if (require.main === module) {
    fs.mkdirSync(WWW, { recursive: true });
    const files = fs.readdirSync(SRC);
    for (const name of files) {
        fs.copyFileSync(path.join(SRC, name), path.join(WWW, name));
    }
    fs.writeFileSync(path.join(WWW, 'uposatha-bridge.js'), bridgeSource());
    fs.writeFileSync(path.join(WWW, 'index.html'), errorPageSource());
    console.log(`uposatha: ${files.length} file(s) copied to www/`);
}
