// Browser check for the Uposatha app's bridge (src/uposatha-bridge.js) and its launch screens: the
// real bridge, injected at document start over the real calendar page of a dg-node checkout, with the
// Capacitor plugins replaced by recorders. Nothing here can tell whether a notification arrives on a
// phone — that needs a device (the reminders are LocalNotifications, scheduled by the page).
//
//   (cd uposatha && node build.js) then:  node uposatha/test/bridge-ui.js
//   DG_SITE=http://localhost:3003 (dg-node-test) by default; screenshots go to DG_SHOTS.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('/usr/lib/node_modules/@playwright/cli/node_modules/playwright');

const ROOT = path.join(__dirname, '..');
const SITE = process.env.DG_SITE || 'http://localhost:3003';
const SHOTS = process.env.DG_SHOTS || '/var/www/html/dict-app';
const PAGE = SITE + '/uposatha-calendar?app=1';
const { bridgeSource } = require(path.join(ROOT, 'build.js'));

const results = [];
function check(name, actual, expected) {
    const pass = JSON.stringify(actual) === JSON.stringify(expected);
    results.push(pass);
    console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${pass ? '' : `\n       expected ${JSON.stringify(expected)}\n       actual   ${JSON.stringify(actual)}`}`);
}

// The plugins, as recorders. window.__calls collects what the app asked of them.
function capacitorStub() {
    window.__calls = { shortcuts: [], channels: [], scheduled: [], picks: 0, exit: 0 };
    window.__back = null;
    window.Capacitor = {
        getPlatform: () => 'android',
        isNativePlatform: () => true,
        Plugins: {
            App: { addListener: (n, cb) => { if (n === 'backButton') window.__back = cb; return { remove() {} }; }, exitApp: () => { window.__calls.exit++; } },
            DgShortcuts: { set: (o) => { window.__calls.shortcuts.push(o.items); return Promise.resolve({ count: o.items.length }); } },
            DgSound: { pick: () => { window.__calls.picks++; return Promise.resolve({ channelId: 'uposatha-own-1', name: 'My bell' }); } },
            LocalNotifications: {
                requestPermissions: () => Promise.resolve({ display: 'granted' }),
                createChannel: (c) => { window.__calls.channels.push(c); return Promise.resolve(); },
                getPending: () => Promise.resolve({ notifications: [] }),
                cancel: () => Promise.resolve(),
                schedule: (o) => { window.__calls.scheduled.push(o.notifications); return Promise.resolve(); },
            },
        },
    };
}

(async () => {
    fs.mkdirSync(SHOTS, { recursive: true });
    const errorServer = spawn('python3', ['-m', 'http.server', '8106', '--bind', '127.0.0.1', '--directory', path.join(ROOT, 'www')], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 900));
    const browser = await chromium.launch({ args: ['--no-sandbox'] });
    const BRIDGE = bridgeSource();
    const ctxOf = (theme, lang, opts = {}) => browser.newContext({
        viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
        colorScheme: theme, locale: lang === 'ru' ? 'ru-RU' : 'en-US', ...opts,
    });
    try {
        // 1. Splash, then the page: tabs, sound option from the DgSound plugin, shortcuts pushed.
        {
            const ctx = await ctxOf('light', 'ru');
            await ctx.addInitScript(capacitorStub);
            await ctx.addInitScript(() => { window.__DG_APP_VERSION__ = 'test'; });
            await ctx.addInitScript(() => { const st = window.setTimeout; window.setTimeout = (f, ms, ...a) => st(f, typeof f === 'function' && String(f).includes('leave(el)') ? 60000 : ms, ...a); });
            await ctx.addInitScript(BRIDGE);
            const page = await ctx.newPage();
            const errors = [];
            page.on('pageerror', (e) => errors.push(e.message));
            await page.goto(PAGE, { waitUntil: 'commit' });
            await page.waitForSelector('.dgls-splash .dgls-name', { state: 'attached' });
            await page.waitForTimeout(850);
            check('splash: the Uposatha mark and name', await page.evaluate(() => [!!document.querySelector('.dgls-splash .dgls-up'), document.querySelector('.dgls-name').textContent]), [true, 'Uposatha']);
            await page.screenshot({ path: path.join(SHOTS, 'launch-upo-splash-light.png') });
            await page.evaluate(() => { document.querySelectorAll('.dgls-splash').forEach((e) => e.remove()); });
            await page.waitForLoadState('load');
            await page.waitForTimeout(2500);
            const items = await page.evaluate(() => window.__calls.shortcuts.slice(-1)[0] || null);
            check('shortcuts: two upcoming Uposatha days pushed', items && items.length, 2);
            console.log('       shortcut labels:', JSON.stringify(items && items.map((i) => i.label)), '->', items && items[0].route);
            check('shortcuts: ids, route and icon', items && items.map((i) => [i.id, i.route, i.icon]), [['dg-uposatha-0', '/uposatha-calendar?app=1&tab=list', 'shortcut_moon'], ['dg-uposatha-1', '/uposatha-calendar?app=1&tab=list', 'shortcut_moon']]);
            check('page: no script errors', errors, []);
            // Back: drawer first, then a non-home tab goes home, then the app exits.
            await page.evaluate(() => document.querySelector('#appnav [data-tab="cal"]').click());
            await page.waitForTimeout(300);
            check('tab cal is open', await page.evaluate(() => document.body.getAttribute('data-app-tab')), 'cal');
            await page.evaluate(() => window.__back({ canGoBack: false }));
            await page.waitForTimeout(300);
            check('Back on a tab goes to the first tab', await page.evaluate(() => document.body.getAttribute('data-app-tab')), 'home');
            await page.evaluate(() => window.__back({ canGoBack: false }));
            check('Back on the first tab leaves the app', await page.evaluate(() => window.__calls.exit), 1);
            await page.screenshot({ path: path.join(SHOTS, 'launch-upo-home-light.png') });
            await ctx.close();
        }

        // 2. A shortcut's tab: ?tab=cal opens the calendar tab from a cold start.
        {
            const ctx = await ctxOf('dark', 'en');
            await ctx.addInitScript(capacitorStub);
            await ctx.addInitScript(BRIDGE);
            const page = await ctx.newPage();
            await page.goto(PAGE + '&tab=cal', { waitUntil: 'load' });
            await page.waitForTimeout(1500);
            check('shortcut ?tab=cal opens the calendar tab', await page.evaluate(() => [document.body.getAttribute('data-app-tab'), localStorage.getItem('dgUposathaView')]), ['cal', 'cal']);
            check('own sound: the picker plugin makes "own" an option', await page.evaluate(() => [...document.querySelectorAll('#rem-sound option')].some((o) => o.value === 'own')), true);
            await page.screenshot({ path: path.join(SHOTS, 'launch-upo-cal-dark.png') });
            await ctx.close();
        }

        // 3. The rating invitation appears on the calendar page only (day 61, never shown).
        {
            const ctx = await ctxOf('light', 'en');
            await ctx.addInitScript(capacitorStub);
            await ctx.addInitScript(() => { localStorage.setItem('dgFirstRunAt', String(Date.now() - 61 * 86400000)); localStorage.removeItem('dgRatePromptShown'); });
            await ctx.addInitScript(BRIDGE);
            const page = await ctx.newPage();
            await page.goto(PAGE, { waitUntil: 'load' });
            await page.waitForTimeout(4200);
            check('rating invitation on day 61: the store link is the Uposatha listing', await page.evaluate(() => { const a = document.querySelector('#dgrAsk .dgr-primary'); return a && a.getAttribute('href'); }), 'https://play.google.com/store/apps/details?id=gift.dhamma.uposatha');
            await page.evaluate(() => window.__back({ canGoBack: false }));
            await page.waitForTimeout(400);
            check('Back closes the invitation and the app stays', await page.evaluate(() => [!document.getElementById('dgrAsk'), window.__calls.exit]), [true, 0]);
            await ctx.close();
        }

        // 4. The offline page: the "no connection" screen with the extra line about the reminders.
        for (const [theme, lang] of [['light', 'ru'], ['dark', 'en']]) {
            const ctx = await ctxOf(theme, lang);
            await ctx.addInitScript((l) => { try { localStorage.setItem('dhammaLanguage', l); } catch (e) { /* first paint */ } }, lang);
            const page = await ctx.newPage();
            await page.route(/test\.dhamma\.gift|localhost:3003/, (r) => r.abort('internetdisconnected'));
            await page.goto('http://127.0.0.1:8106/index.html', { waitUntil: 'domcontentloaded' });
            await page.waitForTimeout(1800);
            const txt = await page.evaluate(() => ({ h: document.querySelector('#dglsErr .dgls-h').textContent, ex: document.querySelector('#dglsErr .dgls-ex').textContent, up: !!document.querySelector('#dglsErr .dgls-up') }));
            check(`offline page ${lang}: title, the reminders line, the mark`, txt, { h: 'Uposatha', ex: lang === 'ru' ? 'Напоминания уже стоят на телефоне и придут без сети.' : 'Your reminders are set on this phone and will arrive without it.', up: true });
            await page.screenshot({ path: path.join(SHOTS, `launch-upo-error-${lang}-${theme}.png`) });
            await ctx.close();
        }
    } finally {
        await browser.close();
        errorServer.kill();
    }
    console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
    process.exit(results.every(Boolean) ? 0 : 1);
})();
