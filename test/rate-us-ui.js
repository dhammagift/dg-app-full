// Browser check for the "Rate Us" row added to the app's settings page.
//
// The row is injected into www/settings/index.html by build-assets.js and wired by src/native-
// bridge.js, so the honest check is the real built page with a mocked Capacitor runtime — the same
// shape as dict/test/bridge-ui.js. The static server is the repository's own serve-local.js, used
// with a non-existent dist directory: only www/ is needed here.
//
//   DG_APP_FULL=/var/www/dg-apps node test/rate-us-ui.js
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('/usr/lib/node_modules/@playwright/cli/node_modules/playwright');

const ROOT = process.env.DG_APP_FULL || path.join(__dirname, '..');
const SHOTS = process.env.DG_SHOTS || '/var/www/html/dict-app';
const PORT = +(process.env.DG_PORT || 8098);
const URL = `http://127.0.0.1:${PORT}/settings/index.html`;

const ANDROID_URL = 'https://play.google.com/store/apps/details?id=gift.dhamma.twa';
// DG_IOS_APP_ID is empty until the iOS app is on the App Store (native-bridge.js), so the row falls
// back to the App Store search for the app's name.
const IOS_URL = 'https://apps.apple.com/search?term=Dhamma.gift';

const results = [];
function check(name, actual, expected) {
    const pass = JSON.stringify(actual) === JSON.stringify(expected);
    results.push({ name, pass, actual, expected });
    console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${pass ? '' : `\n       expected ${JSON.stringify(expected)}\n       actual   ${JSON.stringify(actual)}`}`);
}

function initScript({ platform, lang }) {
    try { localStorage.setItem('dhammaLanguage', lang); } catch (e) { /* fresh origin */ }
    window.__dgCalls = { browsers: [] };
    window.Capacitor = {
        getPlatform: function () { return platform; },
        isNativePlatform: function () { return true; },
        Plugins: {
            App: { addListener: function () { return { remove: function () {} }; }, getInfo: function () { return Promise.resolve({ id: 'gift.dhamma.mobile', version: '1.17', build: '17' }); } },
            Browser: { open: function (opts) { window.__dgCalls.browsers.push(opts); return Promise.resolve(); } },
            Share: { share: function () { return Promise.resolve(); } },
        },
    };
}

(async () => {
    fs.mkdirSync(SHOTS, { recursive: true });
    const server = spawn('node', [path.join(ROOT, 'test', 'serve-local.js'), path.join(ROOT, 'www'), path.join(ROOT, 'dist-none'), String(PORT)], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 800));

    const browser = await chromium.launch({ args: ['--no-sandbox'] });
    const report = [];
    try {
        for (const platform of ['android', 'ios']) {
            for (const lang of ['en', 'ru']) {
                const context = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
                await context.addInitScript(initScript, { platform, lang });
                const page = await context.newPage();
                await page.goto(URL, { waitUntil: 'domcontentloaded' });
                await page.waitForSelector('#dgRateUsRow', { timeout: 10000 });
                await page.waitForTimeout(400);

                const t = lang === 'ru'
                    ? { title: 'Оценить приложение', note: 'Открыть страницу в магазине и оставить отзыв.' }
                    : { title: 'Rate Us', note: 'Open the store page and leave a review.' };

                const row = await page.evaluate(() => {
                    const el = document.getElementById('dgRateUsRow');
                    const btn = document.getElementById('dgRateUsBtn');
                    return {
                        exists: !!el,
                        title: document.getElementById('dgRateUsTitle').textContent.trim(),
                        note: document.getElementById('dgRateUsDesc').textContent.trim(),
                        inDataSection: !!el && el.parentElement.classList.contains('rows'),
                        // The version closes the menu, so this row must sit immediately
                        // BEFORE it (owner: "версия последний пункт меню должен быть").
                        beforeVersionRow: !!el && el.nextElementSibling && el.nextElementSibling.id === 'dgAppVersionRow',
                        // The dictionary app's own Rate Us shape: a button, not a clickable row.
                        hasButton: !!btn,
                        label: btn && btn.textContent,
                        size: btn && getComputedStyle(btn).fontSize,
                    };
                });

                check(`${platform}/${lang}: row exists`, row.exists, true);
                check(`${platform}/${lang}: title`, row.title, t.title);
                check(`${platform}/${lang}: description`, row.note, t.note);
                check(`${platform}/${lang}: sits right before the version row`, row.beforeVersionRow, true);
                check(`${platform}/${lang}: the row carries its own button`, row.hasButton, true);
                // The same three emoji the dictionary app shows, at that app's size.
                check(`${platform}/${lang}: the invite is the dictionary's three emoji`,
                    row.label, String.fromCodePoint(0x35, 0xFE0F, 0x20E3, 0x2B50, 0xFE0F, 0x1F64F));
                check(`${platform}/${lang}: the invite is 16px`, row.size, '16px');

                await page.click('#dgRateUsBtn');
                await page.waitForTimeout(200);
                const opened = await page.evaluate(() => window.__dgCalls.browsers[0] || null);
                check(`${platform}/${lang}: opens a store page`,
                    opened && opened.url,
                    platform === 'android' ? ANDROID_URL : IOS_URL);
                // Tapping is remembered for the invitation that does not exist yet, and the row
                // itself stays put (owner: "пункт Меню остаётся не исчезает").
                const afterTap = await page.evaluate(() => ({
                    flag: localStorage.getItem('dgRateUsTapped'),
                    stillThere: !!document.getElementById('dgRateUsRow'),
                }));
                check(`${platform}/${lang}: the tap is recorded for the future invitation`, afterTap.flag, '1');
                check(`${platform}/${lang}: the row itself stays`, afterTap.stillThere, true);

                const shot = path.join(SHOTS, `dg-app-full-rate-us-${platform}-${lang}.png`);
                await page.locator('#dgRateUsRow').screenshot({ path: shot });
                report.push({ platform, lang, shot });
                await context.close();
            }
        }
        // The version and shortcuts rows must still be there, in the same section.
        const context = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 3 });
        await context.addInitScript(initScript, { platform: 'android', lang: 'ru' });
        const page = await context.newPage();
        await page.goto(URL, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(800);
        const ids = await page.evaluate(() => Array.from(document.querySelectorAll('#dgDynShortcutsRow,#dgAppVersionRow,#dgRateUsRow')).map((e) => e.id));
        check('all three injected rows are present, version last', ids, ['dgDynShortcutsRow', 'dgRateUsRow', 'dgAppVersionRow']);
        await page.locator('#dgRateUsRow').scrollIntoViewIfNeeded();
        await page.locator('#dgAppVersionRow,#dgRateUsRow').first().screenshot({ path: path.join(SHOTS, 'dg-app-full-data-section.png') });
        await context.close();
    } finally {
        await browser.close();
        server.kill();
    }

    fs.writeFileSync(path.join(SHOTS, 'rate-us-report.json'), JSON.stringify({ url: URL, results, screens: report }, null, 2) + '\n');
    const failed = results.filter((r) => !r.pass);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed; screenshots in ${SHOTS}`);
    process.exit(failed.length ? 1 : 0);
})();
