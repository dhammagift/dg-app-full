// Takes the dictionary's page (both languages) and everything it loads off a running site
// (tools/snapshot-lib.js), so the app can bundle it and open with no network at all.
//
//   SITE=https://dict.dhamma.gift node tools/snapshot.js [outdir]           (default outdir: snapshot/)
//   SITE=http://localhost:3003 PREFIX=/dict node tools/snapshot.js          (a dev copy that keeps the page under /dict)
//
// What the page's scripts fetch on their own at load (the word list for the search box) is recorded too. A
// word's own page (/dhamma) is made by the server and is not part of the bundle: the app asks the site for it.
const path = require('path');
const { snapshot } = require('../../tools/snapshot-lib');

snapshot({
    site: process.env.SITE || 'https://dict.dhamma.gift',
    prefix: process.env.PREFIX || '',
    out: process.argv[2] || path.join(__dirname, '..', 'snapshot'),
    visits: [
        { url: '/', save: '/index.html' },
        { url: '/ru/', save: '/ru/index.html' },
    ],
    skip: (p, type) => p === '/sw.js' || p.startsWith('/api/'),
    async interact(page) {
        await page.evaluate(() => { const m = document.querySelector('.burger, #menu, [aria-label=menu]'); if (m) m.click(); });
        await page.waitForTimeout(800);
    },
}).catch((e) => { console.error(e); process.exit(1); });
