#!/usr/bin/env node
// Runs the SAME self-test in Chromium, on this machine, before any of it reaches a simulator.
//
// The iOS job's expensive parts are the macOS runner and the simulator boot; the report it judges is
// produced by test/ios-sim/selftest.js, which is plain page JavaScript. So the fixture, the manifest,
// the /mobile-data override, the eight cases and the judging logic can all be checked here in
// seconds — and when the simulator run does fail, "does it also fail in Chromium?" is the first
// question worth answering.
//
// What it can NOT check is the reason the iOS job exists at all: WKWebView's own OPFS/SAH-pool
// behaviour. Chromium being green is a pre-flight, not a substitute.
//
// Usage:
//   node test/make-fixture-db.js test/fixture.db
//   node test/ios-sim/prepare-www.js --www .tmp/www-test
//   node test/serve-local.js .tmp/www-test .tmp/www-test/mobile-data 8097 &
//   node test/ios-sim/local-check.js

const path = require('path');
const { judge } = require('./judge');

const PLAYWRIGHT = process.env.DG_PLAYWRIGHT || require.resolve('playwright-core');
const { chromium } = require(PLAYWRIGHT);
const BASE = process.env.DG_BASE_URL || 'http://localhost:8097';
const TIMEOUT_MS = +(process.env.DG_SELFTEST_TIMEOUT_MS || 300000);
// Same override the other browser checks in this repo honour: a workstation that would rather use
// the Chrome it already has than download the exact build this playwright-core version pins.
const EXECUTABLE = process.env.DG_CHROMIUM || chromium.executablePath();

(async () => {
    const browser = await chromium.launch({ executablePath: EXECUTABLE, args: ['--no-sandbox'] });
    const context = await browser.newContext();
    const page = await context.newPage();

    let report = null;
    page.on('console', (msg) => {
        const text = msg.text();
        if (text.startsWith('DG_SELFTEST_REPORT ')) {
            try { report = JSON.parse(text.slice('DG_SELFTEST_REPORT '.length)); } catch (e) { /* judge() will fail on null */ }
        }
    });
    page.on('pageerror', (err) => console.error('page error:', err.message));
    // The self-test navigates to the reader at the end (its screenshot step), which aborts whatever
    // request is in flight — that is the expected end of this run, not a failure.
    page.on('requestfailed', () => {});

    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });

    const started = Date.now();
    while (!report && Date.now() - started < TIMEOUT_MS) {
        // The page replaces itself with the reader at the very end of the self-test (the screenshot
        // step), and a closed/crashed target throws out of waitForTimeout — neither is a reason to
        // lose a report that already arrived.
        try {
            await page.waitForTimeout(500);
        } catch (e) {
            break;
        }
    }
    await browser.close();

    if (!report) {
        console.error(`no self-test report from the page within ${TIMEOUT_MS} ms`);
        process.exit(1);
    }
    process.exit(judge(report));
})().catch((e) => {
    console.error('local-check failed:', e.message);
    process.exit(1);
});
