// End-to-end: load the real built page in a real browser, let it download the database into OPFS
// through its own worker, and then compare what window.fetch('/search?...') returns against the
// snapshots captured from the live site.
// Both the driver and the browser are found rather than hardcoded, so this runs on CI as well as
// on a workstation. That matters more than it sounds: this file is the check that would have
// caught the .mjs MIME failure, and it was not running anywhere but one machine when the app
// shipped broken.
const fs = require('fs');
const path = require('path');

const PLAYWRIGHT = process.env.DG_PLAYWRIGHT || '/home/user/dg-node/node_modules/playwright-core';
const { chromium } = require(PLAYWRIGHT);
// DG_CHROMIUM is an explicit override (a workstation that would rather point at its own system
// Chrome than have Playwright download one); otherwise chromium.executablePath() is Playwright's
// own resolution — respects PLAYWRIGHT_BROWSERS_PATH, and matches whatever `playwright install`
// actually put on disk instead of a second, hand-maintained guess at that path (CI used to guess
// a plain "/usr/bin/google-chrome" with no install step behind it at all — see this file's git
// history for why that stopped being safe to assume).
const BROWSER = process.env.DG_CHROMIUM || chromium.executablePath();

const SNAPSHOTS = path.join(__dirname, 'snapshots', 'site');
const BASE = process.env.DG_BASE_URL || 'http://localhost:8097';

// The same request matrix capture.js uses, minus the ones served from static snapshots.
const CASES = [
    ['search-kacchapa',        '/search?q=kacchapa&langs=ru,en'],
    ['search-kacchapa-fast',   '/search?q=kacchapa&langs=ru,en&fast=1'],
    ['search-kacchapa-exact',  '/search?q=kacchapa&langs=ru,en&exact=true'],
    ['search-context',         '/search?q=kacchapa&langs=ru,en&lb=1&la=2'],
    ['search-scope-dhamma',    '/search?q=kacchapa&langs=ru,en&scope=dhamma'],
    ['search-scope-vinaya',    '/search?q=kacchapa&langs=ru,en&scope=vinaya'],
    ['search-scope-all',       '/search?q=kacchapa&langs=ru,en&scope=all'],
    ['search-russian',         '/search?q=%D1%87%D0%B5%D1%80%D0%B5%D0%BF%D0%B0%D1%85%D0%B0&langs=ru,en'],
    ['search-punctuation',     '/search?q=%C2%AB%D1%87%D0%B5%D1%80%D0%B5%D0%BF%D0%B0%D1%85%D0%B0%C2%BB,&langs=ru,en'],
    ['search-diacritics',      '/search?q=kacchap%C4%81na%E1%B9%81&langs=ru,en'],
    ['search-no-diacritics',   '/search?q=kacchapanam&langs=ru,en'],
    ['search-too-short',       '/search?q=ka&langs=ru,en'],
    ['search-no-hits',         '/search?q=zzzzzz&langs=ru,en'],
    ['enrich-dn22',            '/search/enrich?q=kacchapa&ids=dn22&langs=ru,en'],
    ['text-dn22-st',           '/api/text/dn22?mode=st'],
    ['text-dn22-mt',           '/api/text/dn22?mode=mt'],
    ['text-dn22-ml',           '/api/text/dn22?mode=ml'],
    ['text-dn22-read',         '/api/text/dn22?mode=read'],
    ['text-dn22-ee',           '/api/text/dn22?mode=ee'],
    ['text-explicit-translators', '/api/text/dn22?translators=ru_o,ru_sv'],
    ['text-unknown',           '/api/text/nosuchsutta'],
    ['nav-dn22',               '/api/nav/dn22'],
    ['nav-sn56.11',            '/api/nav/sn56.11'],
    ['nav-scoped',             '/api/nav/dn22?scope=dhamma'],
];

(async () => {
    let browser;
    try {
        // --disable-dev-shm-usage: /dev/shm is often tiny on CI VMs/containers, and Chrome uses
        // it for shared memory by default — too small and the renderer crashes on launch with no
        // useful error surfacing here at all (this is the single most common reason "headless
        // Chrome works everywhere except CI" reports exist). Falls back to /tmp instead, which is
        // always sized to the disk, not RAM.
        browser = await chromium.launch({ executablePath: BROWSER, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    } catch (e) {
        console.log('chromium.launch failed:', e.message);
        process.exit(1);
    }
    const page = await browser.newPage();
    // Point the app at this server's own /mobile-data instead of the live host.
    await page.addInitScript(() => { window.DG_DIST_BASE = '/mobile-data'; });
    const errors = [];
    page.on('pageerror', e => errors.push('PAGEERROR: ' + String(e).slice(0, 200)));
    page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 200)); });

    // A loaded/cold CI runner can be slow enough for the very first page load or worker
    // (module worker + OPFS SAH-pool init, see db-worker.js) to blow past a generous timeout on
    // the FIRST try even though nothing is actually wrong — retrying with a fresh navigation
    // costs a few seconds on the rare occasion it's needed and nothing when it isn't. Real
    // breakage (a genuinely broken worker) fails identically on every attempt, so this doesn't
    // hide anything, it just stops a slow start from masquerading as one.
    let opened;
    for (let attempt = 1; attempt <= 3; attempt++) {
        errors.length = 0;
        try {
            await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
            opened = await page.evaluate(async () => {
                try { return { ok: true, result: await window.dgOfflineReady }; }
                catch (e) { return { ok: false, error: e.message }; }
            });
        } catch (e) {
            opened = { ok: false, error: e.message };
        }
        console.log(`dgOfflineReady (attempt ${attempt}) ->`, JSON.stringify(opened));
        if (opened.ok) break;
        if (attempt < 3) await new Promise(r => setTimeout(r, 3000));
    }
    if (!opened.ok) {
        console.log(errors.join('\n'));
        await browser.close();
        process.exit(1);
    }

    // Two device-only failures this file now guards, both invisible to the request matrix below.
    //
    // The worker: it imports two ES modules, and a browser accepts a module only with a
    // JavaScript MIME type. When those files ended in .mjs, Capacitor's asset server — which
    // consults Android's MimeTypeMap, and that has no "mjs" — served them as octet-stream, the
    // worker never started, and every search and reader request in the app failed. The check is
    // just the await above: it now runs against a server whose MIME table is no more permissive
    // than a device's (see test/serve-local.js), so a return to .mjs fails here.
    //
    // Settings: the site links to it as a directory, href="/settings/". Capacitor does not
    // resolve a directory, and an unresolved path falls back to the root index.html — so the gear
    // opened the SEARCH page at the address /settings/, the router read "settings" as a keyword,
    // and there was no way into Settings at all.
    const gear = await page.evaluate(() => {
        const a = document.getElementById('settingsButton');
        return a && a.getAttribute('href');
    });
    const settings = await page.goto(BASE + gear, { waitUntil: 'domcontentloaded', timeout: 45000 })
        .then(() => page.evaluate(() => ({ title: document.title, isSearch: !!document.getElementById('paliauto') })))
        .catch(e => ({ error: e.message }));
    const settingsOk = settings && !settings.error && !settings.isSearch;
    console.log((settingsOk ? 'SAME  ' : 'DIFF  ') + `settings reachable via ${gear} -> ` +
        JSON.stringify(settings && (settings.title || settings.error)));
    if (!settingsOk) {
        console.log('   the gear does not open Settings — a directory link that Capacitor cannot resolve');
        await browser.close();
        process.exit(1);
    }
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.evaluate(() => window.dgOfflineReady);

    let same = 0;
    const differing = [];
    for (const [name, url] of CASES) {
        const expected = JSON.parse(fs.readFileSync(path.join(SNAPSHOTS, `${name}.json`), 'utf8'));
        const actual = await page.evaluate(async (u) => {
            const r = await fetch(u);
            let body; try { body = await r.json(); } catch (e) { body = { __nonJson: true }; }
            return { status: r.status, body };
        }, url);
        const a = JSON.stringify(expected), b = JSON.stringify(actual);
        if (a === b) { same++; console.log('SAME  ' + name); }
        else {
            differing.push(name);
            console.log('DIFF  ' + name);
            console.log('   site: ' + a.slice(0, 260));
            console.log('   app : ' + b.slice(0, 260));
        }
    }
    console.log(`\n${same}/${CASES.length} identical to the site` + (differing.length ? `; differing: ${differing.join(', ')}` : ''));
    if (errors.length) console.log('\npage errors:\n  ' + errors.slice(0, 8).join('\n  '));
    await browser.close();
    process.exit(differing.length ? 1 : 0);
})();
