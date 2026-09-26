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
    window.__calls = { shortcuts: [], channels: [], native: [], scheduled: [], picks: 0, exit: 0 };
    window.__back = null;
    window.Capacitor = {
        getPlatform: () => 'android',
        isNativePlatform: () => true,
        Plugins: {
            App: { addListener: (n, cb) => { if (n === 'backButton') window.__back = cb; return { remove() {} }; }, exitApp: () => { window.__calls.exit++; } },
            DgShortcuts: { set: (o) => { window.__calls.shortcuts.push(o.items); return Promise.resolve({ count: o.items.length }); } },
            DgSound: {
                pick: () => { window.__calls.picks++; return Promise.resolve({ channelId: 'uposatha-own-1', name: 'My bell' }); },
                channel: (c) => { window.__calls.native.push(c); return Promise.resolve(); },
            },
            LocalNotifications: {
                requestPermissions: () => Promise.resolve({ display: 'granted' }),
                createChannel: (c) => { window.__calls.channels.push(c); return Promise.resolve(); },
                getPending: () => Promise.resolve({ notifications: [] }),
                getDeliveredNotifications: () => Promise.resolve({ notifications: window.__delivered || [] }),
                removeDeliveredNotifications: (o) => { window.__calls.removed = (window.__calls.removed || []).concat(o.notifications.map((n) => n.id)); return Promise.resolve(); },
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
            await ctx.addInitScript(BRIDGE);
            const page = await ctx.newPage();
            const errors = [];
            page.on('pageerror', (e) => errors.push(e.message));
            await page.goto(PAGE, { waitUntil: 'load' });
            await page.waitForTimeout(2500);
            check('no web splash (Android draws its own, natively)', await page.evaluate(() => !document.querySelector('.dgls')), true);
            const items = await page.evaluate(() => window.__calls.shortcuts.slice(-1)[0] || null);
            check('shortcuts: three upcoming Uposatha days pushed', items && items.length, 3);
            console.log('       shortcut labels:', JSON.stringify(items && items.map((i) => i.label)), '->', items && items[0].route);
            check('shortcuts: ids, route and icon', items && items.map((i) => [i.id, i.route, i.icon]), [0, 1, 2].map((i) => ['dg-uposatha-' + i, '/uposatha-calendar?app=1&tab=list', 'shortcut_moon']));
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

        // 1b. Today and tomorrow are named as such (time zone UTC: the 8th day's Uposatha begins on the evening of Oct 2).
        for (const [iso, first] of [['2026-10-01T09:00:00Z', 'Завтра · 8-й день'], ['2026-10-02T09:00:00Z', 'Сегодня · 8-й день']]) {
            const ctx = await ctxOf('light', 'ru');
            await ctx.addInitScript(capacitorStub);
            await ctx.addInitScript(() => { localStorage.setItem('dgUposathaTz', 'UTC'); });
            await ctx.addInitScript(BRIDGE);
            const page = await ctx.newPage();
            await page.clock.install({ time: new Date(iso) });
            await page.goto(PAGE, { waitUntil: 'load' });
            await page.waitForTimeout(2500);
            const labels = await page.evaluate(() => (window.__calls.shortcuts.slice(-1)[0] || []).map((i) => i.label));
            console.log('       labels at', iso, JSON.stringify(labels));
            // The page decides its language itself (and the neighbour is editing it): the day words are what matter.
            const norm = (s) => String(s).replace('Tomorrow', 'Завтра').replace('Today', 'Сегодня').replace('Day', '').replace('-й день', '').replace(/\s+/g, ' ').replace(' 8', ' 8').trim();
            check(`shortcuts on ${iso.slice(0, 10)}: the first is ${first}`, norm(labels[0]).replace(/[^0-9А-Яа-я·]/g, ''), norm(first).replace(/[^0-9А-Яа-я·]/g, ''));
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
            check('text is not selectable on the page, but is in a field, a quote and a Pali word', await page.evaluate(() => {
                const us = (el) => getComputedStyle(el).userSelect;
                const probe = (html) => { const d = document.createElement('div'); d.innerHTML = html; document.body.appendChild(d); return d.firstElementChild; };
                return [us(document.body), us(document.querySelector('h1, h2, .dg-drawer-subtitle') || document.body), us(document.querySelector('input')), us(probe('<span class="pli-lang" lang="pi">satipaṭṭhāna</span>')), us(document.querySelector('#slides') || document.body)];
            }), ['none', 'none', 'text', 'text', 'text']);
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

        // 4. The sound source: the alarm stream or the notification stream, per the setting.
        for (const stream of ['notification', 'alarm']) {
            const ctx = await ctxOf('light', 'ru');
            await ctx.addInitScript(capacitorStub);
            await ctx.addInitScript((st) => {
                if (sessionStorage.getItem('seeded')) return;   // once: a reload must keep what the page set
                sessionStorage.setItem('seeded', '1');
                localStorage.setItem('dgUposathaRemind', JSON.stringify({ on: true, lead: 24, d8: true, d14: true, d15: true, sound: 'gong', ownChannel: '', ownName: '' }));
                if (st === 'alarm') localStorage.setItem('dgUposathaSoundStream', 'alarm'); else localStorage.removeItem('dgUposathaSoundStream');
            }, stream);
            await ctx.addInitScript(BRIDGE);
            const page = await ctx.newPage();
            await page.goto(PAGE, { waitUntil: 'load' });
            await page.waitForTimeout(2500);
            const got = await page.evaluate(() => ({
                plugin: window.__calls.channels.map((c) => c.id), native: window.__calls.native.map((c) => [c.id, c.stream, c.sound]),
                scheduled: [...new Set((window.__calls.scheduled.flat() || []).map((n) => n.channelId))],
                icons: [...new Set((window.__calls.scheduled.flat() || []).map((n) => n.largeIcon))],
            }));
            // A reminder left in the tray must not turn the next one with the same id into a silent update.
            await page.evaluate(() => { window.__delivered = [{ id: 7000 }, { id: 7990 }, { id: 1 }]; window.__calls.removed = []; return window.Capacitor.Plugins.LocalNotifications.schedule({ notifications: [{ id: 7000, title: 't', body: 'b', channelId: 'uposatha-gong-v1', schedule: { at: new Date(Date.now() + 60000) } }] }); });
            check(`stream ${stream}: what is left of ours in the tray is taken away before a new reminder`, await page.evaluate(() => window.__calls.removed), [7000, 7990]);
            const suffix = stream === 'alarm' ? '-alarm' : '';
            check(`stream ${stream}: channels are made ${stream === 'alarm' ? 'natively on the alarm stream' : 'by the plugin, as before'}`,
                stream === 'alarm' ? got.native.some((n) => n[0] === 'uposatha-gong-v1-alarm' && n[1] === 'alarm' && n[2] === 'gong.mp3') && got.plugin.length === 0
                    : got.plugin.includes('uposatha-gong-v1') && got.native.length === 0, true);
            check(`stream ${stream}: reminders are scheduled on the ${stream} channels`, got.scheduled.length > 0 && got.scheduled.every((id) => id.endsWith('-v1' + suffix)), true);
            check(`stream ${stream}: reminders carry the mirror picture`, got.icons, ['uposatha_notification']);
            check(`stream ${stream}: the settings drawer has the source row`, await page.evaluate(() => [!!document.getElementById('dg-stream-row'), document.getElementById('dg-stream').value]), [true, stream]);
            if (stream === 'notification') {
                // The page redraws its drawer (a clone has none of the old listeners): the row must still work.
                await page.evaluate(() => { const d = document.getElementById('dg-drawer'); const c = d.cloneNode(true); d.parentNode.replaceChild(c, d); });
                await page.waitForTimeout(400);
                check('the source row comes back after the page redraws its drawer', await page.evaluate(() => !!document.getElementById('dg-stream')), true);
                await page.evaluate(() => { window.__marker = 'same page'; window.__calls.cancelled = 0; window.__calls.scheduled.length = 0; });
                await page.evaluate(() => document.querySelector('.dg-menu-btn').click());
                await page.waitForTimeout(700);
                await page.selectOption('#dg-stream', 'alarm');
                await page.waitForTimeout(1200);
                check('changing the source moves the reminders to the alarm channels, on the same page (no reload)', await page.evaluate(() => [window.__marker, localStorage.getItem('dgUposathaSoundStream'), window.__calls.scheduled.length > 0 && window.__calls.scheduled.flat().every((n) => n.channelId.endsWith('-alarm')), window.__calls.native.some((c) => c.stream === 'alarm')]), ['same page', 'alarm', true, true]);
                await page.evaluate(() => document.getElementById('dg-stream-row').scrollIntoView());
                await page.screenshot({ path: path.join(SHOTS, 'launch-upo-stream-row-light.png') });
            }
            await ctx.close();
        }

        // 5. The offline page: the "no connection" screen with the extra line about the reminders.
        for (const [theme, lang] of [['light', 'ru'], ['dark', 'en']]) {
            const ctx = await ctxOf(theme, lang);
            await ctx.addInitScript((l) => { try { localStorage.setItem('dhammaLanguage', l); } catch (e) { /* first paint */ } }, lang);
            const page = await ctx.newPage();
            await page.route(/test\.dhamma\.gift|localhost:3003/, (r) => r.abort('internetdisconnected'));
            await page.goto('http://127.0.0.1:8106/error.html', { waitUntil: 'domcontentloaded' });
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
