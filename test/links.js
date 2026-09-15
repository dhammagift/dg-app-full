// Link crawler for the BUILT app: opens the home page, search results, the reader (several modes),
// the TOC and Settings, then really clicks every link one by one and records where it went.
// Needs test/serve-local.js (which answers paths the way Capacitor does) on DG_BASE_URL.
//
// A link FAILS when it:
//   - loads a page the device cannot serve (404 = ERR_INVALID_RESPONSE on the tablet),
//   - opens a folder link that Capacitor turns into the home page (/memo/ -> search for "memo"),
//   - opens a second window (the app has none; the reader got stuck in one before),
//   - hands https://localhost to the outside browser,
//   - goes to a legacy reader (/read/, /r/, /d/, /ml/, /mt/, /memorize/, /th/, /history.php, /read.php;
//     /rev/ and /frev/ are current),
//   - throws a JS error while handling the click.
// NOOP (nothing happened) is reported but does not fail: tabs and toggles legitimately do that.
//
//   node test/serve-local.js www <mobile-data> 8097 &
//   node test/links.js            # DG_LINK_PAGES="/,/dn22" to crawl other pages
const fs = require('fs');
const path = require('path');
const os = require('os');

const { chromium } = require(process.env.DG_PLAYWRIGHT || 'playwright-core');
const BROWSER = process.env.DG_CHROMIUM || chromium.executablePath();
const BASE = process.env.DG_BASE_URL || 'http://localhost:8097';
const WWW = process.env.DG_WWW || path.join(__dirname, '..', 'www');
const PROFILE = process.env.DG_PROFILE_DIR || path.join(os.tmpdir(), 'dg-app-e2e-profile');
const PAGES = (process.env.DG_LINK_PAGES ||
    '/,/?q=kacchapa,/dn22,/dn22?mode=memorize,/sn56.11?lang=ru,/toc,/settings/index.html').split(',');
const SETTLE = +(process.env.DG_LINK_SETTLE || 2500);

const LEGACY = /^\/(ru\/)?(read|r|d|ml|mt|multi|mlth|memorize|th)(\/|$)|^\/(ru\/)?(read|history)\.php$/;

function verdict(link, o) {
    // Links that exist only in some state of the page (an opened sheet) cannot be clicked from a clean load.
    if (o.error === 'link no longer on the page') return ['SKIP', o.error];
    if (o.error) return ['FAIL', 'probe error: ' + o.error];
    if (o.pageErrors.length) return ['FAIL', 'JS error: ' + o.pageErrors[0]];
    if (o.popups.length) return ['FAIL', 'opened a second window: ' + o.popups[0]];
    const outside = o.opened.concat(o.externalNav);
    if (outside.length) {
        const u = new URL(outside[0]);
        if (/^(localhost|127\.)/.test(u.hostname)) return ['FAIL', 'app address sent outside: ' + u.href];
        if (/(^|\.)dhamma\.gift$/.test(u.hostname) && LEGACY.test(u.pathname)) return ['FAIL', 'legacy reader: ' + u.href];
        return ['OK', 'outside -> ' + u.href];
    }
    for (const n of o.docs) {
        const u = new URL(n.url);
        if (n.status !== 200) return ['FAIL', `device cannot load ${u.pathname}${u.search} (${n.status || n.failure})`];
        const dir = u.pathname.replace(/\/+$/, '');
        if (dir && !path.extname(dir) && fs.existsSync(path.join(WWW, dir, 'index.html'))) {
            return ['FAIL', `folder link ${u.pathname} opens the home page on the device (link ${dir}/index.html)`];
        }
    }
    const after = new URL(o.after);
    if (LEGACY.test(after.pathname)) return ['FAIL', 'legacy reader route: ' + after.pathname];
    if (o.docs.length) return ['OK', 'loads ' + after.pathname + after.search];
    if (o.after !== o.before) return ['OK', 'in app -> ' + after.pathname + after.search + after.hash];
    return ['NOOP', 'nothing happened'];
}

async function ready(page, url) {
    // A dotted route (/sn56.11) cannot be loaded directly on the device either: open it the way
    // MainActivity does, through the root with _nativeRoute (native-bridge.js).
    const last = url.split('?')[0].replace(/\/+$/, '').split('/').pop();
    const target = BASE + (last.includes('.') && !/\.html?$/.test(last) ? '/?_nativeRoute=' + encodeURIComponent(url) : url);
    // A clicked link may still be reloading the page: that navigation interrupts ours, so go again.
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 })
        .catch((e) => /interrupted by another navigation/.test(e.message)
            ? page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 })
            : Promise.reject(e));
    await page.evaluate(() => window.dgOfflineLibrary).catch(() => {});
    await page.waitForTimeout(SETTLE);
}

(async () => {
    const ctx = await chromium.launchPersistentContext(PROFILE, {
        executablePath: BROWSER, args: ['--no-sandbox', '--disable-dev-shm-usage'], viewport: { width: 412, height: 915 },
    });
    await ctx.addInitScript(() => {
        window.DG_DIST_BASE = '/mobile-data';
        window.__opened = [];
        window.Capacitor = { Plugins: { Browser: { open: (o) => { window.__opened.push(o.url); return Promise.resolve(); } } } };
    });
    const local = new URL(BASE).host;
    let rec = null; // the probe currently recording
    await ctx.route('**/*', (route) => {
        const req = route.request();
        if (new URL(req.url()).host === local) return route.continue();
        if (rec && req.isNavigationRequest()) rec.externalNav.push(req.url());
        return route.abort(); // no real network: outside destinations are only recorded
    });
    ctx.on('page', (p) => { if (rec) rec.popups.push(p.url()); p.close().catch(() => {}); });

    function attach(p) {
        p.on('pageerror', (e) => { if (rec) rec.pageErrors.push(String(e.message).slice(0, 160)); });
        p.on('response', (r) => {
            if (rec && r.request().isNavigationRequest() && r.frame() === p.mainFrame()) rec.docs.push({ url: r.url(), status: r.status() });
        });
        p.on('requestfailed', (r) => {
            if (rec && r.isNavigationRequest() && r.frame() === p.mainFrame() && new URL(r.url()).host === local) {
                rec.docs.push({ url: r.url(), status: 0, failure: r.failure() && r.failure().errorText });
            }
        });
        return p;
    }
    let page = attach(ctx.pages()[0] || await ctx.newPage());

    const seen = new Set();
    const counts = { OK: 0, NOOP: 0, SKIP: 0, FAIL: 0 };
    const fails = [];
    for (const pageUrl of PAGES) {
        await ready(page, pageUrl);
        const links = await page.evaluate(() => [...document.querySelectorAll('a[href]')].map((a) => ({
            href: a.getAttribute('href'), target: a.getAttribute('target') || '', text: (a.textContent || a.title || '').trim().slice(0, 40),
        })));
        const todo = links.filter((l) => {
            const key = l.href + ' ' + l.target;
            if (!l.href || l.href.charAt(0) === '#' || /^(mailto|tel|intent):/i.test(l.href) || seen.has(key)) return false;
            seen.add(key);
            return true;
        });
        console.log(`\n== ${pageUrl}: ${links.length} links, ${todo.length} new`);
        for (const link of todo) {
            rec = { opened: [], externalNav: [], popups: [], docs: [], pageErrors: [], before: page.url() };
            await page.evaluate(() => { window.__opened.length = 0; });
            const click = ({ href, target }) => {
                const a = [...document.querySelectorAll('a[href]')]
                    .find((x) => x.getAttribute('href') === href && (x.getAttribute('target') || '') === target);
                if (!a) return false;
                a.click();
                return true;
            };
            try {
                let found = await page.evaluate(click, link);
                if (!found) { // an earlier click re-rendered part of the page (a sheet, the drawer): start clean
                    rec = null;
                    await ready(page, pageUrl);
                    rec = { opened: [], externalNav: [], popups: [], docs: [], pageErrors: [], before: page.url() };
                    found = await page.evaluate(click, link);
                }
                if (!found) rec.error = 'link no longer on the page';
                await page.waitForTimeout(800);
                if (rec.docs.length) await page.waitForLoadState('domcontentloaded').catch(() => {});
                rec.opened = await page.evaluate(() => window.__opened.slice()).catch(() => []);
            } catch (e) {
                if (!/Execution context was destroyed/.test(e.message)) rec.error = e.message.split('\n')[0];
            }
            if (page.isClosed()) { // the click closed the WebView's only page: fail it and carry on
                rec.error = rec.error || 'the click closed the app page';
                rec.after = rec.before;
                page = attach(await ctx.newPage());
            } else {
                rec.after = page.url();
            }
            const o = rec;
            rec = null;
            const [kind, detail] = verdict(link, o);
            counts[kind]++;
            const line = `${kind.padEnd(4)}  ${link.href}${link.target ? ' [' + link.target + ']' : ''}  "${link.text}"  ${detail}`;
            console.log(line);
            if (kind === 'FAIL') fails.push(`${pageUrl}  ${line}`);
            if (o.docs.length || o.after !== o.before || o.popups.length) await ready(page, pageUrl);
        }
    }

    // Back to a dotted reader route from another document (Log in) reloads that entry: on the
    // device /sn56.11 itself cannot be loaded, so it must come back through the root.
    await ready(page, '/sn56.11');
    await page.evaluate(() => { location.href = '/login/index.html'; });
    await page.waitForURL(/\/login\//);
    const back = await page.goBack({ waitUntil: 'domcontentloaded' }).catch((e) => ({ status: () => e.message }));
    const backPath = new URL(page.url()).pathname;
    if (!back || back.status() !== 200 || backPath !== '/sn56.11') {
        fails.push(`Back from /login to /sn56.11  FAIL  status ${back && back.status()}, landed on ${backPath}`);
    } else {
        console.log('\nOK    Back from /login to /sn56.11');
    }
    await ctx.close();
    console.log(`\n${counts.OK} ok, ${counts.NOOP} did nothing, ${counts.SKIP} skipped, ${counts.FAIL} failed`);
    if (fails.length) console.log('\nFAILED:\n' + fails.join('\n'));
    process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('links.js crashed:', e); process.exit(1); });
