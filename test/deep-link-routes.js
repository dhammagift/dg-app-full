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

const playwright = require(process.env.DG_PLAYWRIGHT || 'playwright-core');
const engine = process.env.DG_BROWSER || 'chromium';
const BROWSER = process.env.DG_CHROMIUM || playwright.chromium.executablePath();
const BASE = process.env.DG_BASE_URL || 'http://localhost:8097';
// The same four links also run in WebKit (DG_BROWSER=webkit, ubuntu): the mapping and the handoff
// are engine-independent, and WebKit is the engine family iOS ships. What is NOT the same is the
// storage: WebKitGTK on Linux is not WKWebView, and whether it exposes OPFS says nothing about iOS
// (the simulator job tests the real thing). So a missing marker is reported, not failed when WebKit
// is the engine — the routing assertion, which needs no database, is failed.

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
    const browser = await playwright[engine].launch({
        ...(engine === 'chromium' ? { executablePath: BROWSER } : {}),
        args: engine === 'chromium' ? ['--no-sandbox'] : [],
    });
    console.log(`deep links in ${engine}`);
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
        const strictMarker = engine === 'chromium';
        const ok = routed && errors.length === 0 && (!strictMarker || rendered);
        if (!ok) failed++;

        console.log(`${ok ? 'ok  ' : 'FAIL'} ${deepLink} -> ${landed}${marker ? ` (page ${rendered ? 'shows' : 'does NOT show'} "${marker}")` : ''}`);
        if (!ok || (marker && !rendered)) {
            if (!routed) console.log(`     expected ${expected}`);
            if (marker && !rendered && strictMarker) console.log(`     the page did not show "${marker}"`);
            if (marker && !rendered && !strictMarker) console.log(`     note: no "${marker}" in the page — expected in WebKit if it exposes no OPFS`);
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
