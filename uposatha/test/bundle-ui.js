// Browser check that the Uposatha app opens with NO network: the bundled page (www/, a snapshot of the site's
// calendar page) served the way Capacitor serves the APK's assets, with the real bridge and every request
// to anywhere else refused. And that the updater fetches what the site has changed — one file — and hands
// only that to DgSite.
//
//   (cd uposatha && SITE=... node tools/snapshot.js && node build.js) first, then:  node uposatha/test/bundle-ui.js
const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('/usr/lib/node_modules/@playwright/cli/node_modules/playwright');

const WWW = path.join(__dirname, '..', 'www');
const SHOTS = process.env.DG_SHOTS || '/var/www/html/dict-app';
const PORT = 8107;
const { bridgeSource } = require(path.join(__dirname, '..', 'build.js'));

const results = [];
function check(name, actual, expected) {
    const pass = JSON.stringify(actual) === JSON.stringify(expected);
    results.push(pass);
    console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${pass ? '' : `\n       expected ${JSON.stringify(expected)}\n       actual   ${JSON.stringify(actual)}`}`);
}

// Capacitor's asset server: a file if there is one, else the app's index.html (its SPA fallback).
const TYPES = { html: 'text/html', js: 'application/javascript', css: 'text/css', json: 'application/json', svg: 'image/svg+xml', woff2: 'font/woff2', png: 'image/png', wasm: 'application/wasm' };
const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let file = path.join(WWW, decodeURIComponent(url.pathname));
    if (!file.startsWith(WWW) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(WWW, 'index.html');
    const ext = path.extname(file).slice(1);
    res.writeHead(200, { 'content-type': TYPES[ext] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
});

function capacitorStub() {
    window.__calls = { puts: [], shortcuts: [] };
    window.Capacitor = {
        getPlatform: () => 'android', isNativePlatform: () => true,
        Plugins: {
            App: { addListener: () => ({ remove() {} }), exitApp() {} },
            DgShortcuts: { set: (o) => { window.__calls.shortcuts.push(o.items); return Promise.resolve({ count: o.items.length }); } },
            DgSound: { pick: () => Promise.resolve({}), channel: () => Promise.resolve() },
            DgSite: { put: (o) => { window.__calls.puts.push({ path: o.path, data: o.data }); return Promise.resolve(); }, list: () => Promise.resolve({ files: [] }), clear: () => Promise.resolve() },
            LocalNotifications: { requestPermissions: () => Promise.resolve({ display: 'granted' }), createChannel: () => Promise.resolve(), getPending: () => Promise.resolve({ notifications: [] }), cancel: () => Promise.resolve(), schedule: () => Promise.resolve() },
        },
    };
}

(async () => {
    await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
    const browser = await chromium.launch({ args: ['--no-sandbox'] });
    const BRIDGE = bridgeSource();
    const manifest = JSON.parse(fs.readFileSync(path.join(WWW, 'site-manifest.json'), 'utf8'));
    try {
        for (const [theme, lang] of [['light', 'ru'], ['dark', 'en']]) {
            const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: theme, locale: lang === 'ru' ? 'ru-RU' : 'en-US' });
            await ctx.addInitScript(capacitorStub);
            await ctx.addInitScript(BRIDGE);
            const page = await ctx.newPage();
            const refused = [], bad = [], errors = [];
            // Offline: nothing outside the app's own origin is reachable, except the "site" we stand in for below.
            const changed = '/assets/css/uposatha-calendar.css';
            const changedBody = fs.readFileSync(path.join(WWW, changed), 'utf8') + '\n/* changed on the site */\n';
            await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => {
                const u = new URL(route.request().url());
                if (u.origin === 'https://test.dhamma.gift') {
                    const p = u.pathname === '/uposatha-calendar' ? '/uposatha-calendar.html' : u.pathname;
                    if (p === changed) return route.fulfill({ status: 200, contentType: 'text/css', body: changedBody });
                    const f = path.join(WWW, p);
                    if (manifest.files.includes(p) && fs.existsSync(f)) return route.fulfill({ status: 200, contentType: TYPES[path.extname(f).slice(1)] || 'application/octet-stream', body: fs.readFileSync(f) });
                    return route.fulfill({ status: 404, body: '' });
                }
                refused.push(u.href);
                return route.abort('internetdisconnected');
            });
            page.on('response', (r) => { if (r.url().startsWith(`http://127.0.0.1:${PORT}`) && r.status() >= 400) bad.push(r.status() + ' ' + r.url()); });
            page.on('pageerror', (e) => errors.push(e.message));
            await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
            await page.waitForTimeout(600);
            check(`${lang}/${theme}: no splash of the page at 0.6 s`, await page.evaluate(() => !document.getElementById('up-splash')), true);
            await page.waitForTimeout(2400);
            check(`${lang}/${theme}: the app layer is up (tabs at the bottom)`, await page.evaluate(() => [document.body.classList.contains('app'), !document.getElementById('appnav').hidden]), [true, true]);
            check(`${lang}/${theme}: the calendar has days`, await page.evaluate(() => { document.querySelector('#appnav [data-tab="list"]').click(); return document.body.innerText.length > 500; }), true);
            check(`${lang}/${theme}: the page draws no splash of its own (Android's is native)`, await page.evaluate(() => !document.getElementById('up-splash')), true);
            check(`${lang}/${theme}: no script errors offline`, errors, []);
            check(`${lang}/${theme}: nothing of the app's own is missing (no 4xx)`, bad, []);
            if (theme === 'light') {
                console.log('       requests refused (the site chrome asking for the network):', JSON.stringify([...new Set(refused)].slice(0, 6)));
            }
            await page.screenshot({ path: path.join(SHOTS, `launch-upo-offline-${lang}-${theme}.png`) });
            // The updater: 6 s after load, one changed file goes to DgSite, and only that one.
            await page.waitForTimeout(7000);
            const puts = await page.evaluate(() => window.__calls.puts.map((p) => [p.path, atob(p.data).endsWith('/* changed on the site */\n')]));
            check(`${lang}/${theme}: the updater hands over exactly the file the site changed`, puts, [[changed, true]]);
            await ctx.close();
        }
    } finally {
        await browser.close();
        server.close();
    }
    console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
    process.exit(results.every(Boolean) ? 0 : 1);
})();
