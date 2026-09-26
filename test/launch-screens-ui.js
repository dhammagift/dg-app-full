// Browser check for the launch splash and the "no connection" screens (src/launch-screens.js):
// the main app's real www/index.html, the dictionary's real www/index.html (its offline page) and
// its real bridge. Screenshots land in DG_SHOTS.
//
//   npm run build (or DG_NODE_PATH=... node build-page.js && node build-assets.js) and
//   (cd dict && node build.js) first, then:  node test/launch-screens-ui.js
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('/usr/lib/node_modules/@playwright/cli/node_modules/playwright');

const ROOT = process.env.DG_APP_ROOT || path.join(__dirname, '..');
const SHOTS = process.env.DG_SHOTS || '/var/www/html/dict-app';
const PORT = +(process.env.DG_PORT || 8103);
const DICT_PORT = PORT + 1;

const results = [];
function check(name, actual, expected) {
    const pass = JSON.stringify(actual) === JSON.stringify(expected);
    results.push(pass);
    console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${pass ? '' : `\n       expected ${JSON.stringify(expected)}\n       actual   ${JSON.stringify(actual)}`}`);
}

(async () => {
    fs.mkdirSync(SHOTS, { recursive: true });
    const servers = [
        spawn('node', [path.join(ROOT, 'test', 'serve-local.js'), path.join(ROOT, 'www'), path.join(ROOT, 'dist-none'), String(PORT)], { stdio: 'ignore' }),
        spawn('python3', ['-m', 'http.server', String(DICT_PORT), '--bind', '127.0.0.1', '--directory', path.join(ROOT, 'dict', 'www')], { stdio: 'ignore' }),
    ];
    await new Promise((r) => setTimeout(r, 1200));
    const browser = await chromium.launch({ args: ['--no-sandbox'] });
    const ctxOf = (theme, lang, extra) => browser.newContext({
        viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
        colorScheme: theme, locale: lang === 'ru' ? 'ru-RU' : 'en-US', ...(extra || {}),
    });
    // A screenshot takes longer than the splash's own minimum: keep the splash up (the timer that would make it leave never fires) so it can be caught.
    const HOLD = () => { const st = window.setTimeout; window.setTimeout = (f, ms, ...a) => st(f, typeof f === 'function' && String(f).includes('leave(el)') ? 60000 : ms, ...a); };
    const present = (page) => page.evaluate(() => !!document.querySelector('.dgls'));
    try {
        // 1. Main app: the splash plays once per launch, then leaves; it does not replay on the next visit.
        {
            const ctx = await ctxOf('light', 'ru');
            await ctx.addInitScript(HOLD);
            const page = await ctx.newPage();
            await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'commit' });
            await page.waitForSelector('.dgls-splash .dgls-name', { state: 'attached' });
            check('main: splash is up at the first frame', await present(page), true);
            await page.waitForTimeout(850);    // the mark has all but assembled; the splash leaves at ~1.4 s
            check('main: the page under the splash does not scroll', await page.evaluate(() => getComputedStyle(document.documentElement).overflow), 'hidden');
            check('main: name is Dhamma.Gift', await page.evaluate(() => (document.querySelector('.dgls-name') || {}).textContent), 'Dhamma.Gift');
            await page.screenshot({ path: path.join(SHOTS, 'launch-dg-splash-light.png') });
            await page.evaluate(() => { window.__hold = 0; });
            await ctx.close();
            const free = await ctxOf('light', 'ru');
            const fp = await free.newPage();
            await fp.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'commit' });
            await fp.waitForTimeout(3600);
            const page2 = fp;
            check('main: splash has left', await present(page2), false);
            check('main: scrolling is back', await page2.evaluate(() => getComputedStyle(document.documentElement).overflow !== 'hidden'), true);
            await page2.reload({ waitUntil: 'domcontentloaded' });
            await page2.waitForTimeout(400);
            check('main: no replay in the same launch', await present(page2), false);
            await free.close();
            const dark = await ctxOf('dark', 'en');
            await dark.addInitScript(HOLD);
            const p2 = await dark.newPage();
            await p2.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'commit' });
            await p2.waitForSelector('.dgls-splash .dgls-name', { state: 'attached' });
            await p2.waitForTimeout(850);
            await p2.screenshot({ path: path.join(SHOTS, 'launch-dg-splash-dark.png') });
            await dark.close();
        }

        // 2. Main app error screen: three states, both themes and languages; Try again shows "checking".
        for (const [theme, lang, state] of [['light', 'ru', 'none'], ['dark', 'en', 'down']]) {
            const ctx = await ctxOf(theme, lang);
            await ctx.addInitScript((l) => { try { localStorage.setItem('dhammaLanguage', l); } catch (e) { /* first paint */ } }, lang);
            const page = await ctx.newPage();
            await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'domcontentloaded' });
            await page.waitForTimeout(3600);   // the splash first
            await page.evaluate(([s]) => { window.__retries = 0; window.dgLaunch.error('dg', s, { retry: () => { window.__retries++; return Promise.resolve(false); } }); }, [state]);
            await page.waitForTimeout(1600);
            const txt = await page.evaluate(() => ({ h: document.querySelector('#dglsErr .dgls-h').textContent, b: document.querySelector('#dglsErr .dgls-hd').textContent, btn: document.querySelector('#dglsErr button').textContent, foot: document.querySelector('.dgls-st').textContent }));
            check(`main error ${state} ${lang}: text`, txt, lang === 'ru'
                ? { h: 'Dhamma.Gift', b: 'Нет соединения.', btn: 'Повторить', foot: 'Повторим сами, когда сеть появится' }
                : { h: 'Dhamma.Gift', b: 'The site isn’t responding.', btn: 'Try again', foot: '' });
            await page.screenshot({ path: path.join(SHOTS, `launch-dg-error-${state}-${lang}-${theme}.png`) });
            await page.click('#dglsErr button');
            await page.waitForTimeout(150);
            check(`main error ${state}: busy while checking`, await page.evaluate(() => ({ off: document.querySelector('#dglsErr button').disabled, spin: !!document.querySelector('.dgls-spin') })), { off: true, spin: true });
            await page.screenshot({ path: path.join(SHOTS, `launch-dg-error-retry-${lang}-${theme}.png`) });
            await page.waitForTimeout(1200);
            check(`main error ${state}: back to the message after a failed retry`, await page.evaluate(() => ({ off: document.querySelector('#dglsErr button').disabled, retries: window.__retries })), { off: false, retries: 1 });
            await ctx.close();
        }

        // 3. Dictionary offline page: the site cannot be reached from here, so Try again ends in "down";
        //    with the network off it opens as "none".
        for (const [theme, lang, offline] of [['dark', 'en', true], ['light', 'ru', false]]) {
            const ctx = await ctxOf(theme, lang);
            const page = await ctx.newPage();
            await page.route('https://dict.dhamma.gift/**', (r) => r.abort('internetdisconnected'));
            // Loopback goes down with setOffline, so "no network" is the page's own view of it.
            if (offline) await ctx.addInitScript(() => Object.defineProperty(navigator, 'onLine', { get: () => false }));
            await page.goto(`http://127.0.0.1:${DICT_PORT}/index.html`, { waitUntil: 'domcontentloaded' });
            await page.waitForTimeout(1700);
            check(`dict error ${offline ? 'offline' : 'online'} ${lang}: state`, await page.evaluate(() => document.querySelector('#dglsErr .dgls-hd').textContent),
                offline ? 'No connection.' : 'Сайт не отвечает.');
            check(`dict error ${lang}: title`, await page.evaluate(() => document.querySelector('#dglsErr .dgls-h').textContent), 'Dict.Dhamma.Gift');
            await page.screenshot({ path: path.join(SHOTS, `launch-dict-error-${offline ? 'none' : 'down'}-${lang}-${theme}.png`) });
            await page.click('#dglsErr button');
            await page.waitForTimeout(2200);
            check(`dict error ${lang}: a failed probe leaves the screen up`, await page.evaluate(() => !!document.getElementById('dglsErr')), true);
            await ctx.close();
        }

        // 4. Dictionary splash: the real bridge, injected the way MainActivity does (at document start),
        //    over a stand-in for the live site.
        {
            const DICT = require(path.join(ROOT, 'dict', 'build.js')).bridgeSource();
            for (const [theme, lang] of [['dark', 'ru'], ['light', 'en']]) {
                const ctx = await ctxOf(theme, lang);
                await ctx.addInitScript(() => { window.Capacitor = { getPlatform: () => 'android', isNativePlatform: () => true, Plugins: {} }; });
                await ctx.addInitScript(HOLD);
                await ctx.addInitScript(DICT);
                const page = await ctx.newPage();
                await page.route('https://dict.dhamma.gift/', (r) => r.fulfill({ contentType: 'text/html', body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><body style="margin:0;background:Canvas;color:CanvasText">site</body>' }));
                await page.goto('https://dict.dhamma.gift/', { waitUntil: 'commit' });
                await page.waitForSelector('.dgls-splash .dgls-name', { state: 'attached' });
                await page.waitForTimeout(850);
                if (theme === 'dark') check('dict: splash is up', await page.evaluate(() => (document.querySelector('.dgls-splash .dgls-name') || {}).textContent), 'Dict');
                await page.screenshot({ path: path.join(SHOTS, `launch-dict-splash-${theme}.png`) });
                await ctx.close();
            }
        }
    } finally {
        await browser.close();
        servers.forEach((s) => s.kill());
    }
    console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
    process.exit(results.every(Boolean) ? 0 : 1);
})();
