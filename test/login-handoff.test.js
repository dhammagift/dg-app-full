#!/usr/bin/env node
// The Google sign-in handoff page (dg-node's siteroot/login/app-google.html), driven for real in a
// browser with Firebase stubbed: after a successful popup the page must return the Google ID token
// to the app — through an intent:// URL on Android, and through dhammagift:// on iOS, which has no
// intent:// at all. Until this existed, iOS sign-in ended in a URL the platform cannot open.
//
// Why a test rather than "looks right": the return URL is the entire contract between three places
// (this page, the platform's URL handling, and the app's mapping in src/deep-link.js), and it is
// built inside an IIFE that nothing else can call. Stubbing firebase is what makes it reachable.
//
// Needs a dg-node checkout (DG_NODE_PATH, or the prod default) and a browser.
//
// Usage: node test/login-handoff.test.js

const http = require('http');
const fs = require('fs');
const path = require('path');

const { chromium } = require(process.env.DG_PLAYWRIGHT || 'playwright-core');
const BROWSER = process.env.DG_CHROMIUM || chromium.executablePath();
const NODE_ROOT = process.env.DG_NODE_PATH || '/var/www/html/nodejs';
const PAGE = path.join(NODE_ROOT, 'siteroot', 'login', 'app-google.html');
const STATE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const TOKEN = 'FAKE.ID_TOKEN';
const PORT = +(process.env.DG_LOGIN_PORT || 8123);

// The three answers that matter: Android keeps exactly what it has always sent (the app's
// MainActivity reads the id_token/state EXTRAS out of that intent), iOS gets the scheme its
// Info.plist registers, and a request that did not come from the app is refused.
const CASES = [
    {
        name: 'android: intent:// naming the package',
        query: `state=${STATE}&pkg=gift.dhamma.mobile&lang=en&plat=android`,
        expect: `intent://auth#Intent;scheme=dhammagift;package=gift.dhamma.mobile;S.id_token=${encodeURIComponent(TOKEN)};S.state=${STATE};S.lang=en;end`,
    },
    {
        name: 'android: no plat at all (an app that has not been updated)',
        query: `state=${STATE}&pkg=gift.dhamma.mobile&lang=en`,
        expect: `intent://auth#Intent;scheme=dhammagift;package=gift.dhamma.mobile;S.id_token=${encodeURIComponent(TOKEN)};S.state=${STATE};S.lang=en;end`,
    },
    {
        name: 'ios: the dhammagift:// scheme',
        query: `state=${STATE}&pkg=gift.dhamma.mobile&lang=en&plat=ios`,
        expect: `dhammagift://auth?id_token=${encodeURIComponent(TOKEN)}&state=${STATE}&lang=en`,
    },
    {
        name: 'ios: russian',
        query: `state=${STATE}&pkg=gift.dhamma.mobile&lang=ru&plat=ios`,
        expect: `dhammagift://auth?id_token=${encodeURIComponent(TOKEN)}&state=${STATE}&lang=ru`,
    },
    {
        name: 'refuse: a state that is not a one-time token',
        query: 'state=short&pkg=gift.dhamma.mobile&lang=en',
        refuse: true,
    },
    {
        name: 'refuse: a package that is not one of our apps',
        query: `state=${STATE}&pkg=com.example.evil&lang=en`,
        refuse: true,
    },
];

// Firebase, stubbed to the exact three things the page touches: apps (a length check),
// initializeApp, and auth().signInWithPopup returning a credential with an idToken.
const FIREBASE_STUB = `
window.firebase = {
    apps: [],
    initializeApp: function (cfg) { this.apps.push(cfg); },
    // firebase-compat's shape, which the page uses: GoogleAuthProvider hangs off the auth FUNCTION
    // (firebase.auth.GoogleAuthProvider), not off what auth() returns.
    auth: (function () {
        var auth = function () {
            return {
                signInWithPopup: function () { return Promise.resolve({ credential: { idToken: '${TOKEN}' } }); }
            };
        };
        auth.GoogleAuthProvider = function () {};
        return auth;
    })()
};
`;

function serve() {
    // The page and nothing else: every other request (the Firebase CDN, the sync config) is either
    // aborted or answered by the test, so a failure here cannot be blamed on the network.
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            const file = req.url.split('?')[0];
            if (file === '/login/app-google.html' && fs.existsSync(PAGE)) {
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(fs.readFileSync(PAGE));
                return;
            }
            res.writeHead(404);
            res.end();
        });
        server.listen(PORT, '127.0.0.1', () => resolve(server));
    });
}

(async () => {
    if (!fs.existsSync(PAGE)) {
        console.error(`no sign-in page at ${PAGE} — set DG_NODE_PATH to a dg-node checkout`);
        process.exit(1);
    }
    const server = await serve();
    const browser = await chromium.launch({ executablePath: BROWSER, args: ['--no-sandbox'] });
    let failed = 0;

    for (const c of CASES) {
        const context = await browser.newContext();
        await context.addInitScript(FIREBASE_STUB);
        // The real Firebase SDK must not load, or it defines window.firebase itself and the stub
        // below is shadowed (first attempt: the page died on auth/invalid-api-key from the real
        // SDK, with the stub parked beside it). An empty script body is used rather than an abort:
        // aborting leaves the page reporting "Firebase scripts did not load", which is a different
        // failure than the one being tested.
        await context.route('**/firebasejs/**', (route) =>
            route.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));
        await context.route('**/config/sync-config.json', (route) =>
            route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));

        const page = await context.newPage();
        await page.goto(`http://127.0.0.1:${PORT}/login/app-google.html?${c.query}`, { waitUntil: 'domcontentloaded' });

        let ok, detail;
        if (c.refuse) {
            const hidden = await page.locator('#go').isHidden();
            const err = (await page.locator('#err').textContent() || '').trim();
            ok = hidden && err.length > 0;
            detail = hidden ? `refused: "${err}"` : 'the sign-in button was still offered';
        } else {
            await page.locator('#go').click();
            await page.locator('#back').waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
            const href = await page.locator('#back').getAttribute('href');
            ok = href === c.expect;
            detail = href === c.expect ? href : `got      ${href}\nexpected ${c.expect}`;
        }
        if (!ok) failed++;
        console.log(`${ok ? 'ok  ' : 'FAIL'} ${c.name}`);
        if (!ok) console.log(`     ${detail}`);
        await context.close();
    }

    await browser.close();
    server.close();
    console.log(failed ? `\nRESULT: FAILED (${failed} of ${CASES.length})` : `\nRESULT: OK — ${CASES.length} handoff cases agree with the contract.`);
    process.exit(failed ? 1 : 0);
})().catch((e) => {
    console.error('login handoff check failed:', e.message);
    process.exit(1);
});
