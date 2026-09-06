// Exercises the native download path with DgDownloader.java replaced by a stub.
//
// The Java cannot run here, and it will not run in CI either — but the JavaScript half is real
// code and carries the parts that actually go wrong: polling the system downloader to completion,
// rejoining a download already in flight from an earlier launch, handing the finished file to the
// worker through Capacitor.convertFileSrc, deleting the temporary copy afterwards, and telling the
// two phases apart in the UI so a bar restarting from zero is explained rather than alarming.
//
// The stub answers exactly what DownloadManager answers: pending, then running with byte counts,
// then done with a filesystem path. What it cannot check is that Android behaves that way — that
// is a device test — but everything downstream of those answers is checked here.
//
// Usage: node test/native-download.js        (needs test/serve-local.js www dist 8097)

const fs = require('fs');
const path = require('path');

const PLAYWRIGHT = process.env.DG_PLAYWRIGHT || '/home/user/dg-node/node_modules/playwright-core';
const { chromium } = require(PLAYWRIGHT);
const BROWSER = process.env.DG_CHROMIUM
    || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : '/usr/bin/google-chrome');
const BASE = process.env.DG_BASE_URL || 'http://localhost:8097';

let bad = 0;
function chk(label, ok, extra) {
    if (!ok) bad++;
    console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (extra !== undefined ? '  -> ' + extra : ''));
}

(async () => {
    const browser = await chromium.launch({ executablePath: BROWSER, args: ['--no-sandbox'] });
    const page = await browser.newPage();

    await page.addInitScript(() => {
        window.DG_DIST_BASE = '/mobile-data';
        const calls = { start: null, statusPolls: 0, cleared: null, converted: null };
        window.__calls = calls;
        window.Capacitor = {
            // The system wrote the compressed file under the .db name — DownloadManager keeps
            // whatever name it was given — so the worker has to tell gzip from SQLite by
            // content, not by extension. Pointing the stub at the .gz is what checks that.
            convertFileSrc(p) { calls.converted = p; return '/mobile-data/dg-mobile.db.gz'; },
            Plugins: {
                DgDownloader: {
                    async start(options) { calls.start = options; return { id: 42 }; },
                    async status() {
                        calls.statusPolls++;
                        if (calls.statusPolls === 1) return { state: 'pending', loaded: 0, total: 0 };
                        if (calls.statusPolls === 2) return { state: 'running', loaded: 45056, total: 90112 };
                        return { state: 'done', loaded: 90112, total: 90112, path: '/data/app/files/dg-mobile.db' };
                    },
                    async clear({ id }) { calls.cleared = id; },
                },
                // Wi-Fi, so the consent dialog stays out of the way — it has its own coverage.
                Network: { async getStatus() { return { connectionType: 'wifi' }; } },
            },
        };
        window.__phases = [];
        window.addEventListener('dg:dl-progress', (e) => {
            window.__phases.push({ phase: e.detail.phase, native: !!e.detail.native, loaded: e.detail.loaded });
        });
    });

    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    const opened = await page.evaluate(async () => {
        try { return { ok: true, value: await window.dgOfflineReady }; }
        catch (e) { return { ok: false, error: e.message }; }
    });
    chk('the database opens through the native path', opened.ok, JSON.stringify(opened.value || opened.error));

    const calls = await page.evaluate(() => window.__calls);
    // The manifest names the file — the compressed one, when it publishes one — and the page must
    // ask for that, not for a name compiled in. This used to be a hardcoded dg-mobile.db, which
    // 404s against a server publishing under any other name.
    const manifest = await page.evaluate(async () => (await fetch('/mobile-data/db-manifest.json')).json());
    const expected = '/mobile-data/' + (manifest.file_gz || manifest.file);
    chk('the system downloader was asked for the file the manifest publishes',
        !!calls.start && calls.start.url === expected, (calls.start && calls.start.url) + ' vs ' + expected);
    chk('it was polled until done', calls.statusPolls >= 3, calls.statusPolls);
    chk('the finished file was converted for the WebView',
        calls.converted === '/data/app/files/dg-mobile.db', calls.converted);
    // Leaving it would mean carrying the 170MB library twice for the life of the install.
    chk('the temporary copy was cleared', calls.cleared === 42, calls.cleared);

    const phases = await page.evaluate(() => window.__phases);
    chk('progress is reported as a native download, then a local import',
        phases.some(p => p.phase === 'download' && p.native) && phases.some(p => p.phase === 'import'),
        JSON.stringify(phases.map(p => p.phase + (p.native ? '/native' : ''))));

    const title = await page.evaluate(() => {
        const el = document.querySelector('#dgDlCard .dgdl-title');
        return el && el.textContent;
    });
    chk('the card ends on the library being ready, not on the download finishing',
        /ready|готова/i.test(title || ''), title);

    // The point of all of it: the data layer answers afterwards.
    const search = await page.evaluate(async () => {
        const response = await fetch('/search?q=kacchapa&langs=ru,en');
        const body = await response.json();
        return { status: response.status, files: body.metadata.totalFiles };
    });
    chk('search answers from the imported database', search.status === 200 && search.files > 0,
        JSON.stringify(search));

    await browser.close();
    console.log(bad ? `\n${bad} FAILED` : '\nthe native download path holds end to end');
    process.exit(bad ? 1 : 0);
})();
