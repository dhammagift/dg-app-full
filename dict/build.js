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

fs.mkdirSync(WWW, { recursive: true });
const files = fs.readdirSync(SRC);
for (const name of files) {
    fs.copyFileSync(path.join(SRC, name), path.join(WWW, name));
}
console.log(`dict: ${files.length} file(s) copied to www/`);
