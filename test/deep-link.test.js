#!/usr/bin/env node
// The dhammagift:// contract, checked as pure string work — no browser, no device, no simulator.
//
// src/deep-link.js maps a scheme URL to a path on the app's own origin, and BOTH platforms hand the
// same raw URL to it, so this file is the test for Android and iOS at once. Everything the contract
// promises (docs/DEEP_LINKS.md) is a case below; a change that breaks a promise fails here in a
// second instead of on a phone.
//
// Usage: node test/deep-link.test.js

const assert = require('assert');
const toLocalUrl = require('../src/deep-link.js');

const CASES = [
    // [name, input, expected]
    ['reader: a sutta id', 'dhammagift://mn1', '/?_nativeRoute=%2Fmn1'],
    ['reader: id with a dot', 'dhammagift://sn56.11', '/?_nativeRoute=%2Fsn56.11'],
    ['reader: vinaya id (letters and dashes, then a digit)', 'dhammagift://pli-tv-bu-vb-pj1', '/?_nativeRoute=%2Fpli-tv-bu-vb-pj1'],
    ['reader: an id keeps its query', 'dhammagift://mn1?langs=ru', '/?_nativeRoute=%2Fmn1%3Flangs%3Dru'],
    ['route: explicit, segments included', 'dhammagift://route/dn22:2.2', '/?_nativeRoute=%2Fdn22%3A2.2'],
    ['route: a TOC book', 'dhammagift://route/toc/pli-tv-bu-pm', '/?_nativeRoute=%2Ftoc%2Fpli-tv-bu-pm'],
    ['route: the favourites sheet (a digit after /, so the id rule cannot catch it)', 'dhammagift://route/4as', '/?_nativeRoute=%2F4as'],
    ['route: with a query', 'dhammagift://route/search?q=kacchapa', '/?_nativeRoute=%2Fsearch%3Fq%3Dkacchapa'],
    ['search: explicit', 'dhammagift://search?q=kacchapa', '/?q=kacchapa'],
    ['search: explicit, with langs forwarded', 'dhammagift://search?q=kacchapa&langs=ru,en', '/?q=kacchapa&langs=ru%2Cen'],
    ['search: a bare word', 'dhammagift://kacchapa', '/?q=kacchapa'],
    ['search: a word with a query', 'dhammagift://kacchapa?langs=ru', '/?q=kacchapa&langs=ru'],
    ['search: a bare word is url-encoded', 'dhammagift://%D1%87%D0%B5%D1%80%D0%B5%D0%BF%D0%B0%D1%85%D0%B0', '/?q=%D1%87%D0%B5%D1%80%D0%B5%D0%BF%D0%B0%D1%85%D0%B0'],
    ['search: only the site\'s own query keys survive', 'dhammagift://kacchapa?evil=1&fast=1', '/?q=kacchapa&fast=1'],
    ['auth: the sign-in return', 'dhammagift://auth?id_token=tok&state=abc123', '/login/index.html#dg_google=tok&state=abc123'],
    ['auth: the Russian login page', 'dhammagift://auth?id_token=tok&state=abc123&lang=ru', '/ru/login/index.html#dg_google=tok&state=abc123'],
    // Refusals. Each one would otherwise put the reader somewhere meaningless.
    // Universal Links / verified App Links: the same mapping through an ordinary site URL.
    ['universal link: a text path', 'https://dhamma.gift/mn1', '/?_nativeRoute=%2Fmn1'],
    ['universal link: with a segment', 'https://dhamma.gift/dn22:2.2', '/?_nativeRoute=%2Fdn22%3A2.2'],
    ['universal link: a subdomain', 'https://www.dhamma.gift/toc', '/?_nativeRoute=%2Ftoc'],
    ['universal link: a search query', 'https://dhamma.gift/?q=kacchapa', '/?_nativeRoute=%2F%3Fq%3Dkacchapa'],
    ['universal link: the home page is not a route', 'https://dhamma.gift/', null],
    ['refuse: an https host we do not claim', 'https://example.com/mn1', null],
    ['refuse: a lookalike host', 'https://dhamma.gift.example.com/mn1', null],
    ['refuse: no scheme at all', 'mn1', null],
    ['refuse: empty', '', null],
    ['refuse: auth without a token', 'dhammagift://auth?state=abc123', null],
    ['refuse: auth without a state', 'dhammagift://auth?id_token=tok', null],
    ['refuse: search without q', 'dhammagift://search?langs=ru', null],
    ['refuse: an empty route', 'dhammagift://route/', null],
    ['refuse: the unparseable colon-in-host form (that is what route/ is for)', 'dhammagift://dn22:2.2', null],

    // The site's legacy reader URLs, which external sites still link to (SuttaCentral:
    // find.dhamma.gift/read/?q=MN1) and Gemini now answers questions with (/d/?q=mn5). The site
    // 301s them; the app has no server, so src/deep-link.js mirrors dg-fastify.js's
    // LEGACY_READERS table. Expectations below were taken from the live server, not invented —
    // every one of them was diffed against its own 301 before being written down.
    ['legacy: Gemini answers with /d/?q=mn5 (devanagari prefix)', 'https://find.dhamma.gift/d/?q=mn5',
        '/?_nativeRoute=' + encodeURIComponent('/mn5?mode=devanagari')],
    ['legacy: SuttaCentral links /read/?q=MN1, and the id is lowercased', 'https://find.dhamma.gift/read/?q=MN1',
        '/?_nativeRoute=' + encodeURIComponent('/mn1')],
    ['legacy: /r means Russian', 'https://dhamma.gift/r/?q=mn1',
        '/?_nativeRoute=' + encodeURIComponent('/mn1?lang=ru')],
    ['legacy: /memorize is a mode, not the external memo app', 'https://dhamma.gift/memorize/?q=sn56.11',
        '/?_nativeRoute=' + encodeURIComponent('/sn56.11?mode=memorize')],
    ['legacy: two settings at once (/mt = multi + Russian)', 'https://dhamma.gift/mt/?q=mn1',
        '/?_nativeRoute=' + encodeURIComponent('/mn1?mode=multi&lang=ru')],
    ['legacy: index.html is the same page, and a segment survives', 'https://dhamma.gift/read/index.html?q=mn1:2.3',
        '/?_nativeRoute=' + encodeURIComponent('/mn1:2.3')],
    ['legacy: a q that is not a text id is a search', 'https://dhamma.gift/read/?q=kacchapa',
        '/?_nativeRoute=' + encodeURIComponent('/?q=kacchapa')],
    ['legacy: /history.php is Favorites', 'https://dhamma.gift/history.php',
        '/?_nativeRoute=' + encodeURIComponent('/4as')],
    ['legacy: /read.php is the contents', 'https://dhamma.gift/read.php',
        '/?_nativeRoute=' + encodeURIComponent('/toc')],
    ['legacy: an explicit query key beats the prefix default', 'https://dhamma.gift/r/?q=mn1&lang=en',
        '/?_nativeRoute=' + encodeURIComponent('/mn1?lang=en')],
    ['legacy: a modern route is not touched', 'https://dhamma.gift/toc/pli-tv-bu-pm',
        '/?_nativeRoute=' + encodeURIComponent('/toc/pli-tv-bu-pm')],
];

// Applied twice must equal applied once: both this mapping and native-bridge.js's _nativeRoute
// handler run legacyRoute, and one link can reach the page through either.
const LEGACY_IDEMPOTENT = ['/d/?q=mn5', '/read/?q=MN1', '/mn1', '/toc/pli-tv-bu-pm', '/?q=x', '/4as'];

let failed = 0;
for (const [name, input, expected] of CASES) {
    let actual;
    try {
        actual = toLocalUrl(input);
    } catch (e) {
        actual = 'threw: ' + e.message;
    }
    const ok = actual === expected;
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
    if (!ok) console.log(`     ${input}\n     expected ${JSON.stringify(expected)}\n     actual   ${JSON.stringify(actual)}`);
}

try {
    assert.strictEqual(toLocalUrl(undefined), null);
    assert.strictEqual(toLocalUrl(null), null);
} catch (e) {
    failed++;
    console.log('FAIL refuses undefined/null input');
}

try {
    const { legacyRoute } = toLocalUrl;
    for (const route of LEGACY_IDEMPOTENT) {
        assert.strictEqual(legacyRoute(legacyRoute(route)), legacyRoute(route), route);
    }
    console.log('ok   legacy rewriting is idempotent');
} catch (e) {
    failed++;
    console.log('FAIL legacy rewriting is not idempotent: ' + e.message);
}

console.log(failed ? `\nRESULT: FAILED (${failed} of ${CASES.length + 2})` : `\nRESULT: OK — ${CASES.length + 2} deep-link cases agree with the documented contract.`);
process.exit(failed ? 1 : 0);
