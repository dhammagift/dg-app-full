// Takes the Uposatha calendar page and everything it loads off a running site, into a directory laid out
// the way the site serves it (/assets/css/x.css -> <out>/assets/css/x.css), so the app can bundle it and
// open with no network at all.
//
//   SITE=https://test.dhamma.gift node tools/snapshot.js [outdir]          (default outdir: snapshot/)
//
// A real browser loads the page (both languages, every tab, the settings drawer), and every same-origin
// GET it makes is recorded — including what the page's scripts fetch on their own (the quotes, the zone
// table). Query strings are dropped: ?v=hash is a cache-buster and the file is the same. The page itself
// is saved as /uposatha-calendar.html. What no script reaches during this visit is not in the snapshot;
// the app fetches such files from the site when it first needs them (see DgSite / the updater).
const fs = require('fs');
const path = require('path');
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');

const SITE = (process.env.SITE || 'https://test.dhamma.gift').replace(/\/$/, '');
const OUT = path.resolve(process.argv[2] || path.join(__dirname, '..', 'snapshot'));

(async () => {
    fs.rmSync(OUT, { recursive: true, force: true });
    fs.mkdirSync(OUT, { recursive: true });
    const browser = await chromium.launch({ args: ['--no-sandbox'] });
    const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, ignoreHTTPSErrors: true });
    const got = new Map();      // path -> Buffer
    const skipped = [];
    ctx.on('response', async (res) => {
        try {
            const req = res.request();
            if (req.method() !== 'GET') return;
            const u = new URL(res.url());
            if (u.origin !== new URL(SITE).origin) { skipped.push(u.href); return; }
            if (res.status() !== 200) { if (res.status() !== 304) skipped.push(res.status() + ' ' + u.pathname); return; }
            let p = decodeURIComponent(u.pathname);
            if (req.resourceType() === 'document') p = '/uposatha-calendar.html';
            else if (p === '/' || p.endsWith('/')) return;
            if (req.resourceType() !== 'document' && p === '/uposatha-calendar') return;   // a script asking for the page again: the page is saved once, as .html
            if (p.startsWith('/api/') || p === '/sw.js') return;   // answers of the site's own APIs and its service worker are not part of a page
            if (req.resourceType() === 'document' && !/uposatha-calendar/.test(u.pathname)) return;
            got.set(p, await res.body());
        } catch (e) { /* a response that went away with its page */ }
    });
    const page = await ctx.newPage();
    for (const lang of ['ru', 'en']) {
        await page.goto(`${SITE}/uposatha-calendar?app=1&lang=${lang}`, { waitUntil: 'networkidle' });
        await page.waitForTimeout(1500);
        for (const tab of ['list', 'cal', 'parts', 'home']) {
            await page.evaluate((t) => { const b = document.querySelector(`#appnav [data-tab="${t}"]`); if (b) b.click(); }, tab);
            await page.waitForTimeout(700);
        }
        await page.evaluate(() => { const m = document.querySelector('.dg-menu-btn'); if (m) m.click(); });
        await page.waitForTimeout(1200);
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(500);
    }
    await browser.close();
    let bytes = 0;
    const failed = [];
    for (const [p, body] of got) {
        const file = path.join(OUT, p);
        try {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, body);
            bytes += body.length;
        } catch (e) { failed.push(p + ' (' + e.code + ')'); }   // a path that is both a file and a directory: an API answer, not a page asset
    }
    console.log(`snapshot: ${got.size} files, ${(bytes / 1048576).toFixed(2)} MB from ${SITE} -> ${OUT}`);
    console.log([...got.keys()].sort().join('\n'));
    if (failed.length) console.log('\nnot saved:\n' + failed.join('\n'));
    if (skipped.length) console.log('\nnot recorded:\n' + [...new Set(skipped)].sort().join('\n'));
})();
