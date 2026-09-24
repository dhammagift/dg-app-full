// Browser check for the launcher-shortcut sets the main application pushes.
//
// Two things the owner reported and this pins: with the settings switch OFF the menu must show the
// three PROGRAMMED entries with their own drawables ("если опция выключена то были правильные
// иконки ... псевдо статические иконки"), and never a mixture of sets. The icons matter because a
// dynamic shortcut must be handed one — without a name in the item, DgShortcutsPlugin falls back to
// the app's own mark, which is what the programmed trio used to get.
//
// The page is the real settings page from www/, the runtime is a mocked Capacitor recording what
// DgShortcuts.set receives, and the injected script is the real src/native-bridge.js. What this
// cannot see is the launcher itself, so the APK still needs a device.
//
//   node test/shortcuts-ui.js
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('/usr/lib/node_modules/@playwright/cli/node_modules/playwright');

const ROOT = process.env.DG_APP_ROOT || path.join(__dirname, '..');
const SHOTS = process.env.DG_SHOTS || '/var/www/html/dict-app';
const PORT = +(process.env.DG_PORT || 8099);
const BRIDGE = fs.readFileSync(path.join(ROOT, 'src', 'native-bridge.js'), 'utf8');

// Three texts, newest first, in the shape settings-bundle.js writes: [displayText, url, timestamp].
const HISTORY = [
    ['SN 56.11', 'https://dhamma.gift/sn56.11', 3],
    ['DN 22', 'https://dhamma.gift/dn22', 2],
    ['MN 1', 'https://dhamma.gift/mn1', 1],
];

const results = [];
function check(name, actual, expected) {
    const pass = JSON.stringify(actual) === JSON.stringify(expected);
    results.push({ name, pass, actual, expected });
    console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${pass ? '' : `\n       expected ${JSON.stringify(expected)}\n       actual   ${JSON.stringify(actual)}`}`);
}

function initScript({ history }) {
    try {
        localStorage.setItem('localSearchHistory', JSON.stringify(history));
        localStorage.removeItem('dgDynamicShortcuts');
    } catch (e) { /* first paint: storage may be unavailable */ }
    window.__dgCalls = { shortcuts: [] };
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
            App: { addListener: function () { return { remove: function () {} }; }, getInfo: function () { return Promise.resolve({ id: 'gift.dhamma.mobile', version: '1.17', build: '17' }); } },
            Browser: { open: function () { return Promise.resolve(); } },
            Share: { share: function () { return Promise.resolve(); } },
        },
    };
}

(async () => {
    fs.mkdirSync(SHOTS, { recursive: true });
    const server = spawn('node', [path.join(ROOT, 'test', 'serve-local.js'), path.join(ROOT, 'www'), path.join(ROOT, 'dist-none'), String(PORT)], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 800));
    const browser = await chromium.launch({ args: ['--no-sandbox'] });
    try {
        const context = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
        await context.addInitScript(initScript, { history: HISTORY });
        const page = await context.newPage();
        await page.goto(`http://127.0.0.1:${PORT}/settings/index.html`, { waitUntil: 'domcontentloaded' });

        // --- the switch is on (default): up to three "recently read" -----------------------
        await page.evaluate(BRIDGE);
        await page.waitForTimeout(400);
        const on = await page.evaluate(() => (window.__dgCalls.shortcuts[window.__dgCalls.shortcuts.length - 1] || null));
        check('switch on: the three recent texts, in order',
            on && on.items.map((i) => i.label), ['SN 56.11', 'DN 22', 'MN 1']);
        check('switch on: each opens its own text',
            on && on.items.map((i) => i.route), ['/sn56.11', '/dn22', '/mn1']);
        check('switch on: none of them names an icon (they get the app mark)',
            on && on.items.map((i) => i.icon), [undefined, undefined, undefined]);
        check('switch on: no "programmed" flag is sent any more', on && 'programmed' in on, false);

        // --- the switch off: the three programmed entries, each with its static drawable ----
        await page.evaluate(() => localStorage.setItem('dgDynamicShortcuts', 'off'));
        await page.evaluate(BRIDGE);
        await page.waitForTimeout(300);
        const off = await page.evaluate(() => (window.__dgCalls.shortcuts[window.__dgCalls.shortcuts.length - 1] || null));
        check('switch off: the three programmed entries',
            off && off.items.map((i) => i.label), ['Table of Contents', 'Memo', 'Dictionary']);
        check('switch off: with their own routes',
            off && off.items.map((i) => i.route), ['/toc', '/memo', '/dict']);
        // The point of the change: shortcut_2/_3/_1 are the drawables these had while they were
        // static entries in res/xml/shortcuts.xml.
        check('switch off: each carries the icon it had as a static entry',
            off && off.items.map((i) => i.icon), ['shortcut_2', 'shortcut_3', 'shortcut_1']);
        check('switch off: three entries, never a mixture',
            off && off.items.length, 3);

        await context.close();
    } finally {
        await browser.close();
        server.kill();
    }

    fs.writeFileSync(path.join(SHOTS, 'shortcuts-report.json'), JSON.stringify({ results }, null, 2) + '\n');
    const failed = results.filter((r) => !r.pass);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    process.exit(failed.length ? 1 : 0);
})();
