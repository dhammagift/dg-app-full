// Takes the Uposatha calendar page and everything it loads off a running site (tools/snapshot-lib.js), so the
// app can bundle it and open with no network at all.
//
//   SITE=https://test.dhamma.gift node tools/snapshot.js [outdir]          (default outdir: snapshot/)
//
// Both languages, every tab, the settings drawer: what the page's scripts fetch on demand (the quotes, the
// zone table) is recorded too. The page itself is saved as /uposatha-calendar.html. What no script reaches
// during this visit is not in the snapshot; the app fetches such files from the site when it first needs
// them (the updater in the bridge).
const path = require('path');
const { snapshot } = require('../../tools/snapshot-lib');

snapshot({
    site: process.env.SITE || 'https://test.dhamma.gift',
    out: process.argv[2] || path.join(__dirname, '..', 'snapshot'),
    visits: ['ru', 'en'].map((lang) => ({ url: `/uposatha-calendar?app=1&lang=${lang}`, save: '/uposatha-calendar.html' })),
    skip: (p, type) => p.startsWith('/api/') || p === '/sw.js' || (type !== 'document' && p === '/uposatha-calendar'),   // API answers, the site's service worker, a script asking for the page again
    async interact(page) {
        for (const tab of ['list', 'cal', 'parts', 'home']) {
            await page.evaluate((t) => { const b = document.querySelector(`#appnav [data-tab="${t}"]`); if (b) b.click(); }, tab);
            await page.waitForTimeout(700);
        }
        await page.evaluate(() => { const m = document.querySelector('.dg-menu-btn'); if (m) m.click(); });
        await page.waitForTimeout(1200);
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(500);
    },
}).catch((e) => { console.error(e); process.exit(1); });
