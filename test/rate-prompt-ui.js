// Browser check for the rating invitation: when it appears, when it must not, and what its buttons
// do. The real page, the real src/native-bridge.js, and localStorage seeded to stand at a given day
// after the first run — the only way to reach "day 180" without waiting half a year.
//
//   node test/rate-prompt-ui.js
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('/usr/lib/node_modules/@playwright/cli/node_modules/playwright');

const ROOT = process.env.DG_APP_ROOT || path.join(__dirname, '..');
const SHOTS = process.env.DG_SHOTS || '/var/www/html/dict-app';
const PORT = +(process.env.DG_PORT || 8102);
const BRIDGE = fs.readFileSync(path.join(ROOT, 'src', 'native-bridge.js'), 'utf8');
const DAY = 86400000;

const results = [];
function check(name, actual, expected) {
    const pass = JSON.stringify(actual) === JSON.stringify(expected);
    results.push({ name, pass, actual, expected });
    console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${pass ? '' : `\n       expected ${JSON.stringify(expected)}\n       actual   ${JSON.stringify(actual)}`}`);
}

function initScript({ firstRunDaysAgo, shown, tapped, lang }) {
    try {
        if (firstRunDaysAgo != null) localStorage.setItem('dgFirstRunAt', String(Date.now() - firstRunDaysAgo * 86400000));
        else localStorage.removeItem('dgFirstRunAt');
        if (shown != null) localStorage.setItem('dgRatePromptShown', shown); else localStorage.removeItem('dgRatePromptShown');
        if (tapped) localStorage.setItem('dgRateUsTapped', '1'); else localStorage.removeItem('dgRateUsTapped');
        localStorage.setItem('dhammaLanguage', lang || 'ru');
    } catch (e) { /* first paint */ }
    window.Capacitor = {
        getPlatform: function () { return 'android'; },
        isNativePlatform: function () { return true; },
        Plugins: {
            DgShortcuts: { set: function () { return Promise.resolve({ count: 0 }); } },
            App: { addListener: function () { return { remove: function () {} }; }, getInfo: function () { return Promise.resolve({ id: 'gift.dhamma.mobile' }); } },
            Browser: { open: function () { return Promise.resolve(); } },
            Share: { share: function () { return Promise.resolve(); } },
        },
    };
}

(async () => {
    fs.mkdirSync(SHOTS, { recursive: true });
    const server = spawn('node', [path.join(ROOT, 'test', 'serve-local.js'), path.join(ROOT, 'www'), path.join(ROOT, 'dist-none'), String(PORT)], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 900));
    const browser = await chromium.launch({ args: ['--no-sandbox'] });

    // Loads /index.html with the given history and waits past the prompt's own delay.
    async function open(seed, theme) {
        const context = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, colorScheme: theme || 'dark' });
        await context.addInitScript(initScript, seed);
        const page = await context.newPage();
        await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(900);
        await page.evaluate(BRIDGE);          // the bridge the app injects into its own pages
        await page.waitForTimeout(1900);      // its own 1500ms delay, plus slack
        return { context, page };
    }
    const box = (page) => page.evaluate(() => {
        const el = document.getElementById('dgrAsk');
        if (!el) return null;
        const a = el.querySelector('.dgr-primary');
        return {
            title: el.querySelector('.dgr-title').textContent,
            ghost: el.querySelector('.dgr-ghost').textContent,
            stars: el.querySelector('.dgr-stars').textContent,
            figs: Array.from(el.querySelectorAll('.dgr-fig')).map((f) => f.querySelector('dt').textContent + ': ' + f.querySelector('dd').textContent),
            href: a.getAttribute('href'),
            target: a.getAttribute('target'),
        };
    });

    try {
        // 1. First ever run: the app only writes the start of the clock, and asks nothing.
        {
            const { context, page } = await open({ firstRunDaysAgo: null });
            const state = await page.evaluate(() => ({ ask: !!document.getElementById('dgrAsk'), first: !!localStorage.getItem('dgFirstRunAt') }));
            check('first run: nothing is asked', state.ask, false);
            check('first run: the clock starts', state.first, true);
            await context.close();
        }

        // 2. Day 61, never shown: the day-60 sheet, Russian, with the "later" button.
        {
            const { context, page } = await open({ firstRunDaysAgo: 61, shown: '0', lang: 'ru' });
            const b = await box(page);
            check('day 61: the sheet appears', !!b, true);
            check('day 61: title', b && b.title, 'Как вам Dhamma.Gift?');
            check('day 61: the star row is there', b && b.stars, '★★★★★');
            check('day 61: figures', b && b.figs,
                ['Займёт: 30 сек – 2 мин', 'Где: Google Play', 'Что оставить: звёзды и комментарий']);
            check('day 61: the button offers "later"', b && b.ghost, 'Позже');
            check('day 61: the primary is a top-frame link to Play', b && [b.href, b.target],
                ['https://play.google.com/store/apps/details?id=gift.dhamma.twa', '_top']);
            if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'rate-prompt-real-ru-dark.png') });

            await page.click('#dgrAsk .dgr-ghost');
            await page.waitForTimeout(400);
            const after = await page.evaluate(() => ({
                ask: !!document.getElementById('dgrAsk'),
                shown: localStorage.getItem('dgRatePromptShown'),
            }));
            check('day 61: "later" closes it', after.ask, false);
            check('day 61: and marks the day-180 chance as the one left', after.shown, '1');
            await context.close();
        }

        // 3. Day 181 with the day-60 showing behind us: the last one, and it says so.
        {
            const { context, page } = await open({ firstRunDaysAgo: 181, shown: '1', lang: 'en' });
            const b = await box(page);
            check('day 181: the sheet appears again', !!b, true);
            check('day 181: English title', b && b.title, 'How is Dhamma.Gift for you?');
            check('day 181: the last chance does not offer "later"', b && b.ghost, "Don't ask");
            if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'rate-prompt-real-en-dark.png') });
            await page.click('#dgrAsk .dgr-ghost');
            await page.waitForTimeout(400);
            check('day 181: dismissing it ends the asking', await page.evaluate(() => localStorage.getItem('dgRatePromptShown')), '2');
            await context.close();
        }

        // 3b. The same last chance in Russian — its button is the one the owner renamed by hand.
        {
            const { context, page } = await open({ firstRunDaysAgo: 181, shown: '1', lang: 'ru' });
            const b = await box(page);
            check('day 181 (ru): the last chance says "не спрашивать"', b && b.ghost, 'Не спрашивать');
            await context.close();
        }

        // 4. After the last showing: never again, however old the install.
        {
            const { context, page } = await open({ firstRunDaysAgo: 400, shown: '2' });
            check('day 400 after both showings: silence', await page.evaluate(() => !!document.getElementById('dgrAsk')), false);
            await context.close();
        }

        // 5. Rate Us already tapped in settings: silence, even on day 400 with nothing shown yet.
        {
            const { context, page } = await open({ firstRunDaysAgo: 400, shown: '0', tapped: true });
            check('tapped in settings: silence', await page.evaluate(() => !!document.getElementById('dgrAsk')), false);
            await context.close();
        }

        // 6. The primary button: the store link opens AND the app stops asking for good.
        {
            const { context, page } = await open({ firstRunDaysAgo: 61, shown: '0', lang: 'ru' });
            const after = await page.evaluate(() => {
                const a = document.querySelector('#dgrAsk .dgr-primary');
                a.addEventListener('click', (e) => e.preventDefault(), { once: true });   // stand in for the WebView
                a.click();
                return { tapped: localStorage.getItem('dgRateUsTapped'), shown: localStorage.getItem('dgRatePromptShown') };
            });
            check('"Rate" records the tap', after.tapped, '1');
            check('"Rate" ends the asking', after.shown, '2');
            await context.close();
        }
        // 6b. The way in without a console: five taps on the App version row in settings arm it.
        {
            const context = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, colorScheme: 'dark' });
            await context.addInitScript(initScript, { firstRunDaysAgo: null, lang: 'ru' });
            const page = await context.newPage();
            await page.goto(`http://127.0.0.1:${PORT}/settings/index.html`, { waitUntil: 'domcontentloaded' });
            await page.waitForTimeout(700);
            await page.evaluate(BRIDGE);
            await page.waitForTimeout(400);
            const armed = await page.evaluate(async () => {
                const row = document.getElementById('dgAppVersionRow');
                for (let i = 0; i < 5; i++) { row.click(); await new Promise((r) => setTimeout(r, 60)); }
                const first = parseInt(localStorage.getItem('dgFirstRunAt') || '0', 10);
                return {
                    days: Math.round((Date.now() - first) / 86400000),
                    shown: localStorage.getItem('dgRatePromptShown'),
                    tapped: localStorage.getItem('dgRateUsTapped'),
                };
            });
            check('five taps on the version row arm it for sixty days back', armed.days, 61);
            check('arming clears both flags', [armed.shown, armed.tapped], [null, null]);
            await context.close();
        }

        // 7. The dictionary app has its own bridge and its own copy of the sheet: same rules, its
        //    own package in the store link. Its page is the live site, served here by the test host.
        {
            const DICT = fs.readFileSync(path.join(ROOT, 'dict', 'src', 'dict-bridge.js'), 'utf8');
            const context = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, colorScheme: 'dark' });
            await context.addInitScript(initScript, { firstRunDaysAgo: 61, shown: '0', lang: 'ru' });
            const page = await context.newPage();
            // The dictionary's language is the PAGE's (its own /ru/ path), not the reader's localStorage key.
            await page.goto(process.env.DG_DICT_URL || 'http://test.dhamma.gift/dict/ru/', { waitUntil: 'domcontentloaded' });
            await page.waitForTimeout(900);
            await page.evaluate(DICT);
            await page.waitForTimeout(1900);
            const d = await page.evaluate(() => {
                const el = document.getElementById('dgrAsk');
                if (!el) return null;
                return {
                    title: el.querySelector('.dgr-title').textContent,
                    ghost: el.querySelector('.dgr-ghost').textContent,
                    href: el.querySelector('.dgr-primary').getAttribute('href'),
                };
            });
            check('dictionary: the sheet appears on day 61', !!d, true);
            check('dictionary: same copy', d && [d.title, d.ghost], ['Как вам Dhamma.Gift?', 'Позже']);
            check('dictionary: its own store listing', d && d.href, 'https://play.google.com/store/apps/details?id=gift.dhamma.pali');
            if (SHOTS && d) await page.screenshot({ path: path.join(SHOTS, 'rate-prompt-real-dict-ru-dark.png') });
            await context.close();
        }
    } finally {
        await browser.close();
        server.kill();
    }

    fs.writeFileSync(path.join(SHOTS, 'rate-prompt-report.json'), JSON.stringify({ results }, null, 2) + '\n');
    const failed = results.filter((r) => !r.pass);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    process.exit(failed.length ? 1 : 0);
})();
