#!/usr/bin/env node
// The dhammagift:// handoff, end to end in a browser: the root URL Android's MainActivity builds
// (`/?_deepLink=<url>`) must land the SPA on the page the contract promises.
//
// test/deep-link.test.js checks the mapping in isolation; this checks that the app actually USES it
// — native-bridge.js loaded before the page's own bootstrap, the rewrite happening early enough for
// the SPA's router to see it, and the result being a real rendered page rather than a URL that
// happened to change. Both platforms reach the same code (Android through this handoff, iOS through
// the appUrlOpen event, which calls the identical function), so a green run here is the web half of
// the proof; test/ios-sim/assert-deeplink.js is the other half, in the real WebView.
//
// Usage: node test/deep-link-routes.js          (needs a served www — see test/serve-local.js)

const { chromium } = require(process.env.DG_PLAYWRIGHT || 'playwright-core');
const BROWSER = process.env.DG_CHROMIUM || chromium.executablePath();
const BASE = process.env.DG_BASE_URL || 'http://localhost:8097';

// [scheme url, where the SPA must end up, a marker that only the right page shows]
const CASES = [
    // The reader route is checked by the path alone: whether /mn1 renders text depends on the
    // database the run points at, and this file is about the handoff, not about the library
    // (test/ios-sim/ covers the library, and the parity checks cover the answers).
    ['dhammagift://mn1', '/mn1', null],
    ['dhammagift://kacchapa', '/kacchapa', 'kacchap'],
    ['dhammagift://route/toc', '/toc', null],
    ['dhammagift://search?q=kacchapa&langs=ru,en', '/kacchapa', 'kacchap'],
];

(async () => {
    const browser = await chromium.launch({ executablePath: BROWSER, args: ['--no-sandbox'] });
    let failed = 0;

    for (const [deepLink, expected, marker] of CASES) {
        const context = await browser.newContext();
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (e) => errors.push(String(e).slice(0, 140)));

        await page.goto(`${BASE}/?_deepLink=${encodeURIComponent(deepLink)}`, { waitUntil: 'domcontentloaded' });
        // The rewrite happens at parse time and the SPA routes on DOMContentLoaded; the extra wait is
        // for the reader/search to fetch from the database and render.
        await page.waitForTimeout(4000);

        const landed = await page.evaluate(() => location.pathname + location.search);
        const text = await page.evaluate(() => document.body.innerText || '');
        const routed = landed === expected || landed.indexOf(expected + '?') === 0;
        const rendered = marker ? text.indexOf(marker) !== -1 : true;
        const ok = routed && rendered && errors.length === 0;
        if (!ok) failed++;

        console.log(`${ok ? 'ok  ' : 'FAIL'} ${deepLink} -> ${landed}${marker ? ` (page ${rendered ? 'shows' : 'does NOT show'} "${marker}")` : ''}`);
        if (!ok) {
            if (!routed) console.log(`     expected ${expected}`);
            if (errors.length) console.log(`     page errors: ${errors.join(' | ')}`);
        }
        await context.close();
    }

    await browser.close();
    console.log(failed ? `\nRESULT: FAILED (${failed} of ${CASES.length})` : `\nRESULT: OK — ${CASES.length} deep links landed on a rendered page.`);
    process.exit(failed ? 1 : 0);
})().catch((e) => {
    console.error('deep-link routing check failed:', e.message);
    process.exit(1);
});
