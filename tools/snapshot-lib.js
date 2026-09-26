// The part the bundled-page apps (Uposatha, Dict) share: take a page and everything it loads off a running
// site, with a real browser, into a directory laid out the way the site serves it.
//
//   await snapshot({ site, out, prefix, visits: [{ url, save }], interact(page), skip(path, type) })
//
//   site      the origin (https://dict.dhamma.gift)
//   out       the directory to write (emptied first)
//   prefix    a path the site keeps the page under that the app must not (a dev copy at /dict/); stripped
//   visits    pages to load: url is a path on the site, save is where the DOCUMENT is stored (the rest are
//             stored at their own paths, query strings dropped: ?v=hash is a cache-buster)
//   interact  what to do on a loaded page so its scripts fetch what they fetch on demand
//   skip      (path, resourceType) => true for what is not part of the page (API answers, service worker)
//   extras    paths on the site to take as they are: what the page fetches only on an action the crawl does not make
//
// Every same-origin GET the page makes is recorded, including what its scripts fetch on their own.
const fs = require('fs');
const path = require('path');
// playwright is a dependency of the package that runs this (uposatha/, dict/), not of the repository root: look in
// the working directory first.
const { chromium } = require(process.env.PLAYWRIGHT || require.resolve('playwright', { paths: [process.cwd(), __dirname] }));

async function snapshot({ site, out, prefix = '', visits, interact, skip, extras = [] }) {
    site = site.replace(/\/$/, '');
    out = path.resolve(out);
    fs.rmSync(out, { recursive: true, force: true });
    fs.mkdirSync(out, { recursive: true });
    const origin = new URL(site).origin;
    const browser = await chromium.launch({ args: ['--no-sandbox'] });
    const got = new Map();
    const skipped = [];
    let current = null;      // the visit being made: its document is saved under visit.save
    let page = null;
    const onResponse = async (res) => {
        try {
            const req = res.request();
            if (req.method() !== 'GET') return;
            const u = new URL(res.url());
            if (u.origin !== origin) { skipped.push(u.href); return; }
            if (res.status() !== 200) { if (res.status() !== 304) skipped.push(res.status() + ' ' + u.pathname); return; }
            let p = decodeURIComponent(u.pathname);
            if (prefix && p.startsWith(prefix)) p = p.slice(prefix.length) || '/';
            const type = req.resourceType();
            if (type === 'document') {
                if (req.frame() !== page.mainFrame() || !current) return;
                const wanted = new URL(current.url, 'http://x').pathname;
                if (p !== wanted.replace(prefix, '') && p !== wanted) return;   // a redirect target or a frame: not the visit itself
                p = current.save;
            } else if (p === '/' || p.endsWith('/')) return;
            if (skip && skip(p, type)) return;
            const body = await res.body();
            // A response served from the browser's cache can come back with an empty body: never let it replace a good one.
            if (body.length === 0 && got.has(p)) return;
            if (body.length === 0) { skipped.push('empty ' + u.pathname); return; }
            got.set(p, body);
        } catch (e) { /* a response that went away with its page */ }
    };
    for (const visit of visits) {
        // A fresh browser context per visit: its own cache, so every file really comes over the wire.
        // serviceWorkers: 'block': the site's own service worker answers most requests after the first second, and
        // Playwright reports what a service worker answered with an EMPTY body (a first version saved half the page's
        // scripts and stylesheets as empty files).
        const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, ignoreHTTPSErrors: true, serviceWorkers: 'block' });
        ctx.on('response', onResponse);
        page = await ctx.newPage();
        current = visit;
        await page.goto(site + (prefix ? prefix : '') + visit.url, { waitUntil: 'networkidle' });
        await page.waitForTimeout(1500);
        if (interact) await interact(page, visit);
        await ctx.close();
    }
    // Extras: fetched directly, not through a page.
    for (const extra of extras) {
        const res = await fetch(site + prefix + extra).catch(() => null);
        if (!res || !res.ok) { skipped.push('extra ' + (res ? res.status : 'failed') + ' ' + extra); continue; }
        const body = Buffer.from(await res.arrayBuffer());
        if (body.length) got.set(extra, body);
    }
    await browser.close();
    const failed = [];
    let bytes = 0;
    for (const [p, body] of got) {
        const file = path.join(out, p);
        try {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, body);
            bytes += body.length;
        } catch (e) { failed.push(p + ' (' + e.code + ')'); }   // a path that is both a file and a directory: an API answer, not a page asset
    }
    console.log(`snapshot: ${got.size} files, ${(bytes / 1048576).toFixed(2)} MB from ${site}${prefix} -> ${out}`);
    console.log([...got.keys()].sort().join('\n'));
    if (failed.length) console.log('\nnot saved:\n' + failed.join('\n'));
    if (skipped.length) console.log('\nnot recorded:\n' + [...new Set(skipped)].sort().join('\n'));
    return got;
}

module.exports = { snapshot };
