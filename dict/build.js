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

// dict-bridge.js carries a "// @rate-prompt" marker; the rating sheet itself lives once, in the main
// app's src/native-bridge.js between its @rate-prompt-begin/-end markers, and is pasted in here.
function bridgeSource() {
    const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'native-bridge.js'), 'utf8');
    const block = main.split(/^.*@rate-prompt-begin.*\n/m)[1].split(/^.*@rate-prompt-end.*\n/m)[0];
    return fs.readFileSync(path.join(SRC, 'dict-bridge.js'), 'utf8').replace(/^.*\/\/ @rate-prompt .*\n/m, () => block);
}
module.exports = { bridgeSource };

if (require.main === module) {
    fs.mkdirSync(WWW, { recursive: true });
    const files = fs.readdirSync(SRC);
    for (const name of files) {
        fs.copyFileSync(path.join(SRC, name), path.join(WWW, name));
    }
    fs.writeFileSync(path.join(WWW, 'dict-bridge.js'), bridgeSource());
    console.log(`dict: ${files.length} file(s) copied to www/`);
}
