#!/usr/bin/env node
// build-core-bundle.js — makes dg-node's core/search-core.js loadable in the app's WebView.
//
// The app must not reimplement the site's search; it must run it. That module already contains no
// HTTP and no Express — it is the query layer and nothing else — so almost all of it is portable
// as written. Three things are not, and this replaces exactly those:
//
//   require('../configs/reader/*.json')  -> the JSON, inlined
//   fsSync.readdirSync(...) for READER_LANGS -> the list, computed here at build time
//   module.exports                       -> a global the worker can pick up
//
// Nothing else is touched. That restraint is the point: the day this file starts "adapting"
// behaviour is the day the app has a second implementation again, which is what the whole
// exercise was meant to end. If the core ever stops being portable, this should fail loudly
// rather than paper over it — hence the assertions below.
//
// Output: www/core-bundle.js, defining self.DG_SEARCH_CORE.
//
// Usage: node build-core-bundle.js   (DG_NODE_PATH as everywhere else)

const fs = require('fs');
const path = require('path');
const { WWW, requireNodeRoot, f } = require('./paths');

// What the core still reaches for after the substitutions above, and what the bundle provides in
// its place. Only path.join survives, and only because filterPreferredTranslators still decides
// which tree a translation came from by looking at a path — so the core synthesises one from
// DG_OFFLINE. Joining strings with a slash is all that needs, and shimming it keeps the core
// byte-identical. Anything BEYOND this list is a build failure by design: the day the core starts
// needing a real filesystem, that should surface here and not as a blank screen on a phone.
const PATH_SHIM = `// path.join, and only join: see build-core-bundle.js for why the core needs it.
const path = { join: (...parts) => parts.filter(Boolean).join('/').replace(/\\/{2,}/g, '/') };
`;
const ALLOWED_PATH_METHODS = ['join'];

function main() {
    requireNodeRoot();
    const src = f('core/search-core.js');
    if (!fs.existsSync(src)) {
        throw new Error(
            `${src} not found.\n` +
            `The app runs dg-node's search core; without it there is nothing to bundle.`
        );
    }
    let code = fs.readFileSync(src, 'utf8');

    // --- configs: inline the JSON the core requires -------------------------------------------
    const configRe = /const (\w+) = require\('\.\.\/configs\/([^']+)'\);/g;
    const inlined = [];
    code = code.replace(configRe, (_, name, rel) => {
        const json = fs.readFileSync(f(path.join('configs', rel)), 'utf8').trim();
        inlined.push(rel);
        return `const ${name} = ${json};`;
    });
    if (!inlined.length) throw new Error('no config requires found — has the core changed shape?');

    // --- READER_LANGS: the core scans configs/reader/ for lang_*.json -------------------------
    const readerDir = f(path.join('configs', 'reader'));
    const readerLangs = fs.readdirSync(readerDir)
        .filter(n => /^lang_[a-z]+\.json$/.test(n))
        .map(n => n.match(/^lang_([a-z]+)\.json$/)[1])
        .sort();
    const langsRe = /const READER_LANGS = fsSync\.readdirSync\([\s\S]*?\.sort\(\);/;
    if (!langsRe.test(code)) throw new Error('READER_LANGS scan not found — has the core changed shape?');
    code = code.replace(langsRe,
        `const READER_LANGS = ${JSON.stringify(readerLangs)}; // computed at build time by build-core-bundle.js`);

    // --- the two node requires the core opens with --------------------------------------------
    code = code
        .replace("const fsSync = require('fs');\n", '')
        .replace("const path = require('path');\n", '');

    // Whatever is left must not reach for Node. Checked rather than hoped: a require() surviving
    // into the bundle is a blank screen on a phone, discovered late.
    const leftoverRequire = code.match(/\brequire\s*\(/);
    if (leftoverRequire) {
        const line = code.slice(0, code.indexOf(leftoverRequire[0])).split('\n').length;
        throw new Error(`core/search-core.js still calls require() at line ${line} of the bundle — add it to the shim above`);
    }
    if (/\bfsSync\./.test(code)) {
        throw new Error('core/search-core.js still uses fsSync.* after bundling — it cannot run in a WebView');
    }
    for (const m of code.matchAll(/\bpath\.(\w+)\(/g)) {
        if (!ALLOWED_PATH_METHODS.includes(m[1])) {
            throw new Error(`core/search-core.js uses path.${m[1]}(), which the bundle does not shim — add it or change the core`);
        }
    }

    // --- exports -> a global -------------------------------------------------------------------
    const exportsRe = /module\.exports = \{([\s\S]*?)\};\s*$/;
    if (!exportsRe.test(code)) throw new Error('module.exports block not found — has the core changed shape?');
    code = code.replace(exportsRe, (_, names) => `return {${names}};`);

    const stamp = new Date().toISOString();
    const out =
`// GENERATED — do not edit. Built by build-core-bundle.js from dg-node's core/search-core.js.
// Source: ${src}
// Built:  ${stamp}
// Configs inlined: ${inlined.join(', ')}
// READER_LANGS: ${readerLangs.join(', ')}
//
// This is the site's own search core, running in the app. Editing it here would recreate the
// fork this repository exists to remove — change dg-node and rebuild.
self.DG_SEARCH_CORE = (function () {
${PATH_SHIM}
${code}
})();
`;

    fs.mkdirSync(WWW, { recursive: true });
    const dest = path.join(WWW, 'core-bundle.js');
    fs.writeFileSync(dest, out);
    console.log(`core bundle: ${path.relative(process.cwd(), dest)} (${(out.length / 1024).toFixed(1)} KB, ` +
        `configs: ${inlined.length}, reader langs: ${readerLangs.length})`);
}

main();
