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
            DgIcon: { set: (o) => { window.__calls.icon = o.items; return Promise.resolve({ phase: 4 }); } },
            DgShortcuts: { set: (o) => { window.__calls.shortcuts.push(o.items); return Promise.resolve({ count: o.items.length }); } },
            DgAlarm: {
                schedule: (o) => { window.__calls.alarms = (window.__calls.alarms || []).concat(o.items); return Promise.resolve(); },
                cancel: (o) => { window.__calls.alarmCancels = (window.__calls.alarmCancels || []).concat(o.ids); return Promise.resolve(); },
            },
            DgSound: {
                dndAccess: () => Promise.resolve({ granted: !!window.__dnd }),
                requestDndAccess: () => { window.__calls.dndAsked = (window.__calls.dndAsked || 0) + 1; return Promise.resolve(); },
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
            check('shortcuts: Calendar and the three upcoming Uposatha days pushed', items && items.length, 4);
            console.log('       shortcut labels:', JSON.stringify(items && items.map((i) => i.label)), '->', items && items[1].route);
            check('shortcuts: ids, route and icon', items && items.map((i) => [i.id, i.route, /^shortcut_moon_[0-7]$/.test(i.icon)]), [['dg-calendar', '/uposatha-calendar?app=1&tab=cal', true], ...[0, 1, 2].map((i) => ['dg-uposatha-' + i, '/uposatha-calendar?app=1&tab=list', true])]);
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
            const labels = await page.evaluate(() => (window.__calls.shortcuts.slice(-1)[0] || []).slice(1).map((i) => i.label));
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
                return [us(document.body), us(document.querySelector('h1, h2, .dg-drawer-subtitle') || document.body), us(document.querySelector('input')), us(probe('<span class="pli-lang" lang="pi">satipaṭṭhāna</span>')), us(document.querySelector('#slides') || document.body), us(probe('<b class="selectable">AN 3.37</b>')), us(probe('<b data-selectable>MN 10</b>'))];
            }), ['none', 'none', 'text', 'text', 'text', 'text', 'text']);
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
                plugin: window.__calls.channels.map((c) => c.id), native: window.__calls.native.map((c) => [c.id, c.stream, c.sound, c.bypass]),
                scheduled: [...new Set((window.__calls.scheduled.flat() || []).map((n) => n.channelId))],
                icons: [...new Set((window.__calls.scheduled.flat() || []).map((n) => n.largeIcon))],
                alarms: (window.__calls.alarms || []).map((a) => [a.sound, a.at > 0]),
            }));
            // A reminder left in the tray must not turn the next one with the same id into a silent update.
            await page.evaluate(() => { window.__delivered = [{ id: 7000 }, { id: 7990 }, { id: 1 }]; window.__calls.removed = []; return window.Capacitor.Plugins.LocalNotifications.schedule({ notifications: [{ id: 7000, title: 't', body: 'b', channelId: 'uposatha-gong-v1', schedule: { at: new Date(Date.now() + 60000) } }] }); });
            check(`stream ${stream}: what is left of ours in the tray is taken away before a new reminder`, await page.evaluate(() => window.__calls.removed), [7000, 7990]);
            const suffix = stream === 'alarm' ? '-alarm' : '';
            check(`stream ${stream}: channels are made natively on the ${stream} stream, asking to sound through Do Not Disturb`,
                got.native.some((n) => n[0] === 'uposatha-gong-v1' + (stream === 'alarm' ? '-alarm' : '') && n[1] === stream && n[2] === (stream === 'alarm' ? '' : 'gong.mp3') && n[3] === true) && got.plugin.length === 0, true);
            check(`stream ${stream}: reminders are scheduled on the ${stream} channels`, got.scheduled.length > 0 && got.scheduled.every((id) => id.endsWith('-v1' + suffix)), true);
            check(`stream ${stream}: reminders carry the mirror picture`, got.icons, ['uposatha_notification']);
            check(`stream ${stream}: the sound is played by an alarm of its own only on the alarm source (its channel is then silent)`, stream === 'alarm' ? got.alarms.length > 0 && got.alarms.every((a) => a[0] === 'gong' && a[1]) : got.alarms.length === 0, true);
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

        // 4a. Which res/raw file an alarm plays: the built-in sounds, the spoken parts, vikala.
        {
            const ctx = await ctxOf('light', 'en');
            await ctx.addInitScript(capacitorStub);
            await ctx.addInitScript(() => { localStorage.setItem('dgUposathaSoundStream', 'alarm'); });
            await ctx.addInitScript(BRIDGE);
            const page = await ctx.newPage();
            await page.goto(PAGE, { waitUntil: 'load' });
            await page.waitForTimeout(1500);
            const names = await page.evaluate(async () => {
                const LN = window.Capacitor.Plugins.LocalNotifications;
                const at = new Date(Date.now() + 90000);
                const ids = ['uposatha-gong-v1', 'uposatha-bell-v1', 'uposatha-vikala-v1', 'uposatha-part-pubbanha-v1', 'uposatha-part-majjhima-v1', 'uposatha-none-v1', 'uposatha-own-123'];
                window.__calls.alarms = [];
                await LN.schedule({ notifications: ids.map((c, i) => ({ id: 7000 + i, title: 't', body: 'b', channelId: c, schedule: { at } })) });
                return window.__calls.alarms.map((a) => a.sound);
            });
            check('alarm: which sound file each channel plays', names, ['gong', 'church', 'vikala', 'pubbanha', 'majjhima', 'own']);
            await ctx.close();
        }

        // 4a1. The launcher icon of the day: a schedule of the next weeks, a phase index for each day.
        {
            const ctx = await ctxOf('light', 'en');
            await ctx.addInitScript(capacitorStub);
            await ctx.addInitScript(BRIDGE);
            const page = await ctx.newPage();
            await page.goto(PAGE, { waitUntil: 'load' });
            await page.waitForTimeout(2500);
            const items = await page.evaluate(() => window.__calls.icon || null);
            check('launcher icon: 35 days, ascending, phases 0..7', items && [items.length, items.every((x, k) => (k === 0 || x.at > items[k - 1].at) && x.i >= 0 && x.i <= 7 && x.at > 0)], [35, true]);
            check('launcher icon: the moon changes over the month (all eight shapes appear)', items && new Set(items.map((x) => x.i)).size, 8);
            await ctx.close();
        }

        // 4a2. The status-bar icon of a reminder is the moon of its day (mirrored in the Southern Hemisphere).
        for (const [hemi, want] of [['north', 'ic_stat_moon_1'], ['south', 'ic_stat_moon_7']]) {
            const ctx = await ctxOf('light', 'en');
            await ctx.addInitScript(capacitorStub);
            await ctx.addInitScript((h) => { localStorage.setItem('dgUposathaHemisphere', h); }, hemi);
            await ctx.addInitScript(BRIDGE);
            const page = await ctx.newPage();
            await page.goto(PAGE, { waitUntil: 'load' });
            await page.waitForTimeout(1500);
            // 3 days after the new moon of 10 Oct 2026: a waxing crescent
            const got = await page.evaluate(async () => {
                window.__calls.scheduled.length = 0;
                await window.Capacitor.Plugins.LocalNotifications.schedule({ notifications: [
                    { id: 7000, title: 't', body: 'b', channelId: 'uposatha-gong-v1', schedule: { at: new Date('2026-10-13T12:00:00Z') } },
                    { id: 7001, title: 't', body: 'b', channelId: 'uposatha-gong-v1', schedule: { at: new Date('2026-09-26T18:00:00Z') } }] });
                return window.__calls.scheduled.flat().map((n) => n.smallIcon);
            });
            check(`moon icon of the reminder's day (${hemi}): waxing crescent, and the full moon of 26 Sep`, got, [want, 'ic_stat_moon_4']);
            await ctx.close();
        }

        // 4b. Do Not Disturb: with the access, channels are made again under "-dnd" ids and reminders move to them.
        {
            const ctx = await ctxOf('light', 'en');
            await ctx.addInitScript(capacitorStub);
            await ctx.addInitScript(() => {
                localStorage.setItem('dgUposathaRemind', JSON.stringify({ on: true, lead: 24, d8: true, d14: true, d15: true, sound: 'gong', ownChannel: '', ownName: '' }));
                window.__dnd = false;
            });
            await ctx.addInitScript(BRIDGE);
            const page = await ctx.newPage();
            await page.goto(PAGE, { waitUntil: 'load' });
            await page.waitForTimeout(2500);
            check('DND: without access the channels are the plain ones', await page.evaluate(() => [...new Set(window.__calls.scheduled.flat().map((n) => n.channelId))]), ['uposatha-gong-v1']);
            check('DND: with reminders on and no access, the sheet asks in plain words (once)', await page.evaluate(async () => { await new Promise((r) => setTimeout(r, 1500)); const o = document.getElementById('dgrAsk'); return [!!o, o && o.querySelector('.dgr-title').textContent, localStorage.getItem('dgDndAskedAt') !== null]; }), [true, 'So that a reminder is heard', true]);
            check('DND: its button opens the system page', await page.evaluate(() => { document.querySelector('#dgrAsk .dgr-primary').click(); return [window.__calls.dndAsked, true]; }), [1, true]);
            await page.evaluate(() => { window.__calls.dndAsked = 0; });
            check('DND: the drawer has the row and the button asks for access', await page.evaluate(() => { document.getElementById('dg-dnd-btn').click(); return [!!document.getElementById('dg-dnd-row'), window.__calls.dndAsked]; }), [true, 1]);
            await page.evaluate(() => { window.__dnd = true; window.__calls.scheduled.length = 0; document.dispatchEvent(new Event('visibilitychange')); });
            await page.waitForTimeout(1200);
            check('DND: after the access is given, the reminders move to the "-dnd" channels', await page.evaluate(() => [...new Set(window.__calls.scheduled.flat().map((n) => n.channelId))]), ['uposatha-gong-v1-dnd']);
            check('DND: and the button says it is allowed', await page.evaluate(() => document.getElementById('dg-dnd-btn').textContent.includes('Allowed')), true);
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
