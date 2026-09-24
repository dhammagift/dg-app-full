// Browser check for the app-only burger rows in src/dict-bridge.js.
//
// The rows only ever appear inside the Android app, so the two things that make it "the app" are
// mocked here: window.Capacitor (getPlatform() -> 'android', with DgShortcuts/App/Browser plugins
// that record what they are called with) and window.__DG_APP_VERSION__, which MainActivity
// prepends to the injected script. The bridge itself is the real file, evaluated in the page with
// playwright's page.evaluate — the same code path the WebViewListener fallback uses on devices
// whose WebView predates document-start injection.
//
// Not a unit test of the Android side: an APK is built separately (./gradlew assembleDebug), and
// nothing here can run a launcher or a WebView. What it does prove is that the injected script
// lands in the site's own panel, speaks the site's own classes, is right in both languages and both
// themes, and hands the plugin the routed history it is supposed to.
//
//   node test/bridge-ui.js            # mobile + desktop, en/ru, light/dark
//   DG_DICT_URL=... node test/bridge-ui.js
const fs = require('fs');
const path = require('path');
// The playwright CLI is the only copy on this machine; its bundled library is used directly so the
// browser can be launched with --no-sandbox (root).
const { chromium } = require('/usr/lib/node_modules/@playwright/cli/node_modules/playwright');

const BASE = process.env.DG_DICT_URL || 'http://test.dhamma.gift/dict/';
const SHOTS = process.env.DG_SHOTS || '/var/www/html/dict-app';
const BRIDGE = fs.readFileSync(path.join(__dirname, '..', 'src', 'dict-bridge.js'), 'utf8');
const HISTORY = ['kacchapa', 'dukkha', 'satipaṭṭhāna', 'anattā'];

const CASES = [
    { lang: 'en', url: BASE, theme: 'light', device: 'mobile', width: 390, height: 844, dsf: 3 },
    { lang: 'en', url: BASE, theme: 'dark', device: 'mobile', width: 390, height: 844, dsf: 3 },
    { lang: 'ru', url: BASE + 'ru/', theme: 'dark', device: 'mobile', width: 390, height: 844, dsf: 3 },
    { lang: 'en', url: BASE, theme: 'light', device: 'desktop', width: 1280, height: 900, dsf: 1 },
    { lang: 'ru', url: BASE + 'ru/', theme: 'light', device: 'desktop', width: 1280, height: 900, dsf: 1 },
];

function initScript({ version, history, theme }) {
    // Runs before the page's own scripts, like capacitor.config.json's native runtime would.
    try {
        localStorage.setItem('history-list', JSON.stringify(history));
        localStorage.setItem('theme', theme);
    } catch (e) { /* first paint of a fresh origin: storage may be unavailable */ }
    window.__DG_APP_VERSION__ = version;
    window.__dgCalls = { shortcuts: [], browsers: [], listeners: {}, exits: 0 };
    window.Capacitor = {
        getPlatform: function () { return 'android'; },
        isNativePlatform: function () { return true; },
        Plugins: {
            DgShortcuts: {
                set: function (opts) {
                    window.__dgCalls.shortcuts.push(JSON.parse(JSON.stringify(opts)));
                    return Promise.resolve({ count: (opts.items || []).length });
                },
            },
            App: {
                addListener: function (name, cb) {
                    window.__dgCalls.listeners[name] = cb;
                    return { remove: function () {} };
                },
                exitApp: function () { window.__dgCalls.exits += 1; return Promise.resolve(); },
            },
            Browser: {
                open: function (opts) {
                    window.__dgCalls.browsers.push(opts);
                    return Promise.resolve();
                },
            },
        },
    };
}

const results = [];
function check(name, actual, expected) {
    const pass = JSON.stringify(actual) === JSON.stringify(expected);
    results.push({ name, pass, actual, expected });
    console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${pass ? '' : `\n       expected ${JSON.stringify(expected)}\n       actual   ${JSON.stringify(actual)}`}`);
}

(async () => {
    fs.mkdirSync(SHOTS, { recursive: true });
    const browser = await chromium.launch({ args: ['--no-sandbox'] });
    const report = [];

    for (const c of CASES) {
        const context = await browser.newContext({
            viewport: { width: c.width, height: c.height },
            deviceScaleFactor: c.dsf,
            isMobile: c.device === 'mobile',
            hasTouch: c.device === 'mobile',
        });
        await context.addInitScript(initScript, { version: '2.0.0 (3)', history: HISTORY, theme: c.theme });
        const page = await context.newPage();
        await page.goto(c.url, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(600);

        // The bridge, exactly as MainActivity injects it.
        await page.evaluate(BRIDGE);
        await page.waitForTimeout(200);

        const t = c.lang === 'ru'
            ? { group: 'Приложение', shortcuts: 'Недавние слова в ярлыках', version: 'Версия приложения', rate: 'Оценить приложение' }
            : { group: 'App', shortcuts: 'Recent words in app shortcuts', version: 'App version', rate: 'Rate Us' };

        const rows = await page.evaluate(() => {
            // The row title is the .lb span's own text node; the <em> inside it is the note.
            const q = (s) => {
                const el = document.querySelector(s);
                if (!el) return null;
                const first = el.childNodes[0];
                return first && first.nodeType === 3 ? first.textContent.trim() : el.textContent.trim();
            };
            return {
                group: q('#dg-app-grp'),
                shortcuts: q('#dg-shortcuts-row .lb'),
                versionTitle: q('#dg-version-row .lb'),
                rateTitle: q('#dg-rate-row .lb'),
                inPanel: !!document.querySelector('#p-menu .pb #dg-app-grp'),
                // The three rows close the panel, in the owner's order: shortcuts, Rate Us, and the
                // version last ("версия же обычно последний пункт").
                lastThree: Array.from(document.querySelectorAll('#p-menu .pb > *')).slice(-3).map((e) => e.id),
                starClass: document.getElementById('dg-rate-star').getAttribute('class'),
                starColor: getComputedStyle(document.getElementById('dg-rate-star')).color,
                starFontSize: getComputedStyle(document.getElementById('dg-rate-star')).fontSize,
                starMask: getComputedStyle(document.getElementById('dg-rate-star')).maskImage,
                // The star is a mask <i>, so it has no text of its own: the button's text is the 5
                // and the 🙏, and the glyph sits between them.
                rateLabel: document.getElementById('dg-rate-btn').textContent,
                rateParts: Array.from(document.getElementById('dg-rate-btn').childNodes).map((n) => n.nodeType === 3 ? n.textContent : '#' + n.id),
                fiveSize: getComputedStyle(document.getElementById('dg-rate-five')).fontSize,
                fiveColor: getComputedStyle(document.getElementById('dg-rate-five')).color,
                note: document.getElementById('dg-shortcuts-note').textContent,
            };
        });

        check(`${c.lang}/${c.theme}/${c.device}: panel group`, rows.group, t.group);
        check(`${c.lang}/${c.theme}/${c.device}: rows are inside the burger panel`, rows.inPanel, true);
        check(`${c.lang}/${c.theme}/${c.device}: last three rows, in order`,
            rows.lastThree, ['dg-shortcuts-row', 'dg-rate-row', 'dg-version-row']);
        // The owner asked for a filled yellow star so the row stands out. The site's own star.svg
        // is the OUTLINE glyph, so the filled one is inlined as a mask — hence the check for the
        // solid path itself, not merely a mask being present.
        check(`${c.lang}/${c.theme}/${c.device}: Rate Us carries the site's mask-icon plumbing`,
            rows.starClass, 'gi');
        check(`${c.lang}/${c.theme}/${c.device}: the star is yellow`,
            rows.starColor, 'rgb(245, 197, 24)');
        check(`${c.lang}/${c.theme}/${c.device}: the star is a filled glyph, not the outline one`,
            /data:image\/svg\+xml/.test(rows.starMask) && rows.starMask.includes('M316.9') && !rows.starMask.includes('zm0%2079'),
            true);
        // The switch beside it is 22px tall (dg.css), and the first cut inherited the button font.
        check(`${c.lang}/${c.theme}/${c.device}: the star matches the switch's size`,
            rows.starFontSize, '22px');
        // "5★🙏", not "rate": the row is already titled Rate Us.
        check(`${c.lang}/${c.theme}/${c.device}: the button says five stars, not "rate"`,
            rows.rateParts, ['#dg-rate-five', '#dg-rate-star', '🙏']);
        // The site's action buttons are 11.5px; beside a 22px star that read as a typo.
        check(`${c.lang}/${c.theme}/${c.device}: the 5 is the star's own size`,
            rows.fiveSize, '22px');
        check(`${c.lang}/${c.theme}/${c.device}: the 5 is the star's own colour`,
            rows.fiveColor, 'rgb(245, 197, 24)');
        // The note carries the live count, so "the history has two words" and "the launcher dropped
        // one" stop looking like the same screenshot.
        check(`${c.lang}/${c.theme}/${c.device}: the row note states how many are in the launcher`,
            rows.note.includes(c.lang === 'ru' ? 'Сейчас: 3.' : 'Right now: 3.'), true);
        check(`${c.lang}/${c.theme}/${c.device}: shortcuts title`, rows.shortcuts, t.shortcuts);
        check(`${c.lang}/${c.theme}/${c.device}: version title`, rows.versionTitle, t.version);
        check(`${c.lang}/${c.theme}/${c.device}: rate title`, rows.rateTitle, t.rate);

        const version = await page.evaluate(() => document.querySelector('#dg-version-row .lb em').textContent.trim());
        check(`${c.lang}/${c.theme}/${c.device}: version value`, version, '2.0.0 (3)');

        // The plugin must have been handed the history — and ONLY the history: the dictionary has no
        // favourites in its shortcut set (owner: "не нужно брать избранное. в словаре только история
        // слов"). dictUrl() builds from the deployment's app base — "/" on dict.dhamma.gift, "/dict/"
        // on the test host — and carries the language as ?lang=ru rather than a /ru/ path segment, so
        // the expectation mirrors that instead of the page URL.
        const base = new URL(c.url).pathname.replace(/ru\/$/, '');
        const suffix = c.lang === 'ru' ? '?lang=ru' : '';
        const push = await page.evaluate(() => (window.__dgCalls.shortcuts[0] || null));
        check(`${c.lang}/${c.theme}/${c.device}: shortcut labels`, push && push.items.map((i) => i.label),
            ['kacchapa', 'dukkha', 'satipaṭṭhāna']);
        check(`${c.lang}/${c.theme}/${c.device}: shortcut routes`, push && push.items.map((i) => i.route),
            ['kacchapa', 'dukkha', 'satipa%E1%B9%AD%E1%B9%ADh%C4%81na'].map((w) => base + w + suffix));
        check(`${c.lang}/${c.theme}/${c.device}: nothing is disabled on the native side`,
            push && 'programmed' in push, false);
        // A recent word has no artwork of its own, so it carries no icon and the plugin falls back
        // to the app's mark; only the programmed entries have their own drawables.
        check(`${c.lang}/${c.theme}/${c.device}: recent words ask for no icon`,
            push && push.items.map((i) => i.icon), [undefined, undefined, undefined]);

        // Open the panel for the screenshot, scrolled to the end — the new rows are the last thing
        // in a panel taller than the viewport, so a screenshot without this shows none of them.
        await page.click('#menubtn');
        await page.waitForSelector('#p-menu[data-open="true"]', { timeout: 5000 });
        await page.waitForTimeout(400);
        await page.evaluate(() => {
            const pb = document.querySelector('#p-menu .pb');
            if (pb) pb.scrollTop = pb.scrollHeight;
        });
        await page.waitForTimeout(300);

        const shot = path.join(SHOTS, `dict-bridge-${c.lang}-${c.theme}-${c.device}.png`);
        await page.locator('#p-menu').screenshot({ path: shot });
        report.push({ ...c, shot });

        // Rate Us must open the store listing through the native browser.
        await page.click('#dg-rate-btn');
        const opened = await page.evaluate(() => window.__dgCalls.browsers[0] || null);
        check(`${c.lang}/${c.theme}/${c.device}: Rate Us opens the Play listing`,
            opened && opened.url, 'https://play.google.com/store/apps/details?id=gift.dhamma.pali');

        // A lookup must reach the launcher at once, not at the next app-state change: the site's
        // own addToHistory() is what the bridge wraps.
        if (c.device === 'mobile' && c.theme === 'light') {
            const wrapped = await page.evaluate(() => typeof window.addToHistory === 'function' && window.addToHistory.__dgWrapped === true);
            check('the site hooks its own addToHistory', wrapped, true);
            const before = await page.evaluate(() => window.__dgCalls.shortcuts.length);
            await page.evaluate(() => window.addToHistory('satimā'));
            await page.waitForTimeout(200);
            const after = await page.evaluate(() => ({
                count: window.__dgCalls.shortcuts.length,
                last: window.__dgCalls.shortcuts[window.__dgCalls.shortcuts.length - 1],
            }));
            check('a lookup pushes the launcher menu immediately', after.count > before, true);
            check('the new word leads the three slots',
                after.last && after.last.items.map((i) => i.label), ['satimā', 'kacchapa', 'dukkha']);
        }

        // Back: the panel closes first, and only a reader with nothing left behind him leaves the
        // app. Capacitor's own default is a bare WebView goBack() and nothing else.
        if (c.device === 'mobile' && c.theme === 'light') {
            const back = await page.evaluate(() => {
                const cb = window.__dgCalls.listeners.backButton;
                if (!cb) return { wired: false };
                cb({ canGoBack: false }); // panel is open from the screenshot above
                const afterPanel = {
                    open: !!document.querySelector('.panel[data-open="true"]'),
                    exits: window.__dgCalls.exits,
                };
                cb({ canGoBack: false }); // nothing left to close or go back to
                return { wired: true, afterPanel, exits: window.__dgCalls.exits };
            });
            check('back button: the app handles it itself', back.wired, true);
            check('back button: closes the open panel instead of leaving', back.afterPanel, { open: false, exits: 0 });
            check('back button: leaves the app only from the home screen', back.exits, 1);
            // That handler closed the panel, so it has to come back before the switch below can be
            // touched — which is also the check that closing it left the page usable.
            await page.click('#menubtn');
            await page.waitForSelector('#p-menu[data-open="true"]', { timeout: 5000 });
            await page.waitForTimeout(300);
        }

        // The switch: off -> the three programmed entries take the dynamic slots instead, and the
        // row stops talking about a count of words.
        if (c.device === 'mobile' && c.theme === 'light') {
            await page.uncheck('#dg-shortcuts-toggle');
            const off = await page.evaluate(() => ({
                flag: localStorage.getItem('dgDynamicShortcuts'),
                last: window.__dgCalls.shortcuts[window.__dgCalls.shortcuts.length - 1],
                note: document.getElementById('dg-shortcuts-note').textContent,
            }));
            check('switch off: flag stored', off.flag, 'off');
            check('switch off: the programmed three take the slots',
                off.last && off.last.items.map((i) => i.label),
                ['Table of Contents', 'Dharmamitra.org', 'Aksharamukha.com']);
            check('switch off: their routes are the ones the statics used',
                off.last && off.last.items.map((i) => i.route),
                ['https://dhamma.gift/toc', 'https://dharmamitra.org/', 'https://www.aksharamukha.com/converter']);
            // ...and the drawables they had while they were static, instead of the app's own mark
            // that a dynamic shortcut gets by default.
            check('switch off: each carries the icon it had as a static entry',
                off.last && off.last.items.map((i) => i.icon),
                ['shortcut_0', 'shortcut_2', 'shortcut_3']);
            check('switch off: the note stops counting words',
                /Сейчас|Right now/.test(off.note), false);
            await page.locator('#p-menu').screenshot({ path: path.join(SHOTS, 'dict-bridge-switch-off.png') });
        }

        await context.close();
    }

    await browser.close();
    fs.writeFileSync(path.join(SHOTS, 'dict-bridge-report.json'), JSON.stringify({ base: BASE, results, screens: report }, null, 2) + '\n');
    const failed = results.filter((r) => !r.pass);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed; screenshots in ${SHOTS}`);
    process.exit(failed.length ? 1 : 0);
})();
