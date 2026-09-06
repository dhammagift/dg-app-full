// The worker's download, in a real browser, against a server that misbehaves on request.
//
// test/db-download.test.js proves the streaming module in Node. This is the other half: the same
// module inside db-worker.js, feeding Chromium's own DecompressionStream into the SAH pool's
// importDb(), with app.js and offline-status.js on the page doing what they do on the device. It
// needs no dg-node checkout — the core bundle is stubbed to the two calls open() makes — so it
// runs anywhere test/e2e-browser.js cannot, and it checks what that test does not: a compressed
// file, a dropped connection, a missing file, and what the reader sees at the end of each.
//
// Usage: node test/worker-download.js            (builds its own fixture slice)

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const PLAYWRIGHT = process.env.DG_PLAYWRIGHT || path.join(REPO, 'node_modules', 'playwright-core');
const { chromium } = require(PLAYWRIGHT);
const BROWSER = process.env.DG_CHROMIUM
    || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : '/usr/bin/google-chrome');

let bad = 0;
function chk(label, ok, extra) {
    if (!ok) bad++;
    console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (extra !== undefined ? '  -> ' + extra : ''));
}

// A page that is only the app's own three scripts. offline-status.js draws the card, app.js
// starts the worker, and nothing else on the real page takes part in the download.
const INDEX_HTML = `<!doctype html><html><head><meta charset="utf-8">
<script>window.DG_DIST_BASE = '/mobile-data';</script>
<script src="app.js"></script>
<script src="/offline-status.js"></script>
</head><body><p>worker download test</p></body></html>`;

// What open() needs from the core and nothing more. The real bundle is built from dg-node; the
// search itself is checked by e2e-browser.js, which has it.
const CORE_STUB = `export default {
    init() {},
    setSkeleton() {},
};`;

function buildWww(root) {
    const www = path.join(root, 'www');
    fs.mkdirSync(path.join(www, 'vendor', 'sqlite-wasm'), { recursive: true });
    for (const name of ['app.js', 'offline-status.js', 'db-worker.js', 'db-download.js']) {
        fs.copyFileSync(path.join(REPO, 'src', name), path.join(www, name));
    }
    fs.writeFileSync(path.join(www, 'index.html'), INDEX_HTML);
    fs.writeFileSync(path.join(www, 'core-bundle.js'), CORE_STUB);
    // The same three files build-assets.js ships, under the same names.
    const from = path.join(REPO, 'node_modules', '@sqlite.org', 'sqlite-wasm', 'dist');
    for (const [src, as] of [['index.mjs', 'index.js'], ['sqlite3.wasm', 'sqlite3.wasm'],
                             ['sqlite3-opfs-async-proxy.js', 'sqlite3-opfs-async-proxy.js']]) {
        fs.copyFileSync(path.join(from, src), path.join(www, 'vendor', 'sqlite-wasm', as));
    }
    return www;
}

function buildDist(root) {
    const dist = path.join(root, 'dist');
    const fixture = path.join(root, 'fixture.db');
    const quiet = { stdio: ['ignore', 'ignore', 'inherit'] };
    execFileSync(process.execPath, [path.join(REPO, 'test', 'make-fixture-db.js'), fixture], quiet);
    execFileSync(process.execPath, [path.join(REPO, 'build-app-db.js'),
        `--from=${fixture}`, '--langs=ru,en', `--out=${path.join(dist, 'dg-mobile.db')}`], quiet);
    return dist;
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm' };

// serve-local.js, plus a way to misbehave: `mode.cut` closes the connection after that many bytes
// of the database, once; `mode.missing` answers 404 for it; `mode.nolength` withholds
// Content-Length. Range requests are honoured the way nginx honours them for a static file.
function serve(www, dist, mode) {
    return new Promise(resolve => {
        const hits = { db: 0, ranges: [] };
        const server = http.createServer((req, res) => {
            const u = decodeURIComponent(req.url.split('?')[0]);
            const isData = u.startsWith('/mobile-data/');
            let file = isData ? path.join(dist, u.slice('/mobile-data/'.length)) : path.join(www, u);
            if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(www, 'index.html');
            const isDb = isData && /\.db(\.gz)?$/.test(u);

            if (isDb && mode.missing) { res.writeHead(404); res.end('gone'); return; }
            const size = fs.statSync(file).size;
            let start = 0, status = 200;
            const headers = { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' };
            const range = req.headers.range && /^bytes=(\d+)-$/.exec(req.headers.range);
            if (isDb) {
                hits.db++;
                if (range) {
                    start = Number(range[1]);
                    status = 206;
                    hits.ranges.push(start);
                    headers['Content-Range'] = `bytes ${start}-${size - 1}/${size}`;
                }
            }
            if (!(isDb && mode.nolength)) headers['Content-Length'] = size - start;
            res.writeHead(status, headers);

            const cutAt = isDb && mode.cut && hits.db === 1 ? mode.cut : null;
            const stream = fs.createReadStream(file, { start, highWaterMark: 4096 });
            let sent = 0;
            stream.on('data', chunk => {
                if (cutAt !== null && sent + chunk.length > cutAt) {
                    res.write(chunk.subarray(0, Math.max(0, cutAt - sent)));
                    stream.destroy();
                    res.destroy();
                    return;
                }
                sent += chunk.length;
                res.write(chunk);
            });
            stream.on('end', () => res.end());
        });
        server.listen(0, '127.0.0.1', () => resolve({ server, hits, base: `http://127.0.0.1:${server.address().port}` }));
    });
}

(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-worker-'));
    const www = buildWww(root);
    const dist = buildDist(root);
    const manifest = JSON.parse(fs.readFileSync(path.join(dist, 'db-manifest.json'), 'utf8'));
    chk('the slice is published compressed', !!manifest.file_gz && manifest.bytes_gz < manifest.bytes,
        `${manifest.bytes_gz} of ${manifest.bytes} bytes`);

    const mode = {};
    const { server, hits, base } = await serve(www, dist, mode);
    const browser = await chromium.launch({ executablePath: BROWSER, args: ['--no-sandbox'] });

    // Each run is a fresh profile, so OPFS starts empty and the download actually happens.
    async function openApp() {
        const context = await browser.newContext();
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', e => errors.push(String(e).slice(0, 200)));
        await page.addInitScript(() => {
            window.__progress = [];
            window.addEventListener('dg:dl-progress', e => window.__progress.push({ ...e.detail }));
        });
        await page.goto(base + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
        const opened = await page.evaluate(async () => {
            try { return { ok: true, value: await window.dgOfflineReady }; }
            catch (e) { return { ok: false, error: e.message }; }
        });
        // The card's last word arrives after ready settles; give the DOM a frame.
        await page.waitForTimeout(150);
        const card = await page.evaluate(() => {
            const el = document.getElementById('dgDlCard');
            return el && {
                title: el.querySelector('.dgdl-title').textContent,
                sub: el.querySelector('.dgdl-sub').textContent,
                failed: el.classList.contains('failed'),
                shown: el.classList.contains('show'),
            };
        });
        const progress = await page.evaluate(() => window.__progress);
        return { page, context, opened, card, progress, errors };
    }

    // 1. The published .gz, well-behaved server.
    let r = await openApp();
    chk('the compressed database opens', r.opened.ok && r.opened.value.build_id === manifest.build_id,
        JSON.stringify(r.opened));
    const last = r.progress[r.progress.length - 1];
    chk('progress ran to the compressed size, which the bar can finish on',
        !!last && last.total === manifest.bytes_gz && last.loaded === manifest.bytes_gz, JSON.stringify(last));
    chk('the card ends on the library being ready', !!r.card && /ready|готова/i.test(r.card.title), r.card && r.card.title);
    chk('no page errors', r.errors.length === 0, r.errors.join(' | '));
    await r.context.close();

    // 2. No Content-Length: the manifest's figure stands in.
    hits.db = 0; hits.ranges.length = 0; mode.nolength = true;
    r = await openApp();
    chk('without Content-Length the database still opens and the total comes from the manifest',
        r.opened.ok && r.progress.every(p => p.total === manifest.bytes_gz), JSON.stringify(r.progress.slice(-1)));
    await r.context.close();
    delete mode.nolength;

    // 3. The connection drops partway: the rest is fetched with a Range request, once.
    hits.db = 0; hits.ranges.length = 0; mode.cut = Math.floor(manifest.bytes_gz / 2);
    r = await openApp();
    chk('a dropped connection is resumed and the database opens', r.opened.ok, JSON.stringify(r.opened));
    chk('the resume asked for the remainder', hits.ranges.length === 1 && hits.ranges[0] >= 1 && hits.ranges[0] <= mode.cut,
        JSON.stringify(hits.ranges));
    await r.context.close();
    delete mode.cut;

    // 4. The file is missing: a failure the reader can see and retry, not a bar left saying
    //    "Downloading" forever.
    mode.missing = true;
    r = await openApp();
    chk('a missing file rejects with the status', !r.opened.ok && /HTTP 404/.test(r.opened.error), r.opened.error);
    chk('the card turns into the reason, with a retry', !!r.card && r.card.failed && r.card.shown && /404/.test(r.card.sub),
        JSON.stringify(r.card));
    delete mode.missing;
    const retried = await r.page.evaluate(async () => {
        document.querySelector('#dgDlCard .dgdl-retry').click();
        try { return { ok: true, value: await window.dgOfflineReady }; }
        catch (e) { return { ok: false, error: e.message }; }
    });
    await r.page.waitForTimeout(150);
    const cardAfter = await r.page.evaluate(() => {
        const el = document.getElementById('dgDlCard');
        return { title: el.querySelector('.dgdl-title').textContent, failed: el.classList.contains('failed') };
    });
    chk('retry from the card downloads and opens', retried.ok && retried.value.build_id === manifest.build_id,
        JSON.stringify(retried));
    chk('and the card ends on ready', !cardAfter.failed && /ready|готова/i.test(cardAfter.title), cardAfter.title);
    await r.context.close();

    await browser.close();
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
    console.log(bad ? `\n${bad} FAILED` : '\nthe worker downloads, resumes, inflates and reports — in a browser');
    process.exit(bad ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
