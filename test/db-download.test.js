// Exercises src/db-download.js against a real HTTP server that misbehaves on request.
//
// The failures this covers are the ones a device produced and nothing in the repo could reproduce:
// a connection that drops mid-file, one that goes silent without closing, a response with no
// Content-Length, a server that ignores Range. Each is a mode of the server below, and the check is
// always the same — the bytes that reach the consumer are exactly the bytes that were published,
// and progress reports a total the UI can finish on.
//
// Runs on Node's own fetch/streams, the same WHATWG API the worker uses; the browser-side
// integration (OPFS, the SAH pool, a real DecompressionStream in Chromium) is test/worker-download.js.
//
// Usage: node test/db-download.test.js

const http = require('http');
const zlib = require('zlib');
const crypto = require('crypto');
const path = require('path');
const { pathToFileURL } = require('url');

let bad = 0;
function chk(label, ok, extra) {
    if (!ok) bad++;
    console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (extra !== undefined ? '  -> ' + extra : ''));
}

// Something that looks enough like a database to matter: a header, then text that compresses and
// a run of pseudo-random bytes that does not — the real file has both kinds of page.
function makePayload() {
    const parts = [Buffer.from('SQLite format 3\0')];
    let seed = 7;
    for (let i = 0; i < 6000; i++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        parts.push(Buffer.from(`row ${i} evaṁ me sutaṁ ekaṁ samayaṁ bhagavā ${seed % 977}\n`));
        if (i % 50 === 0) parts.push(crypto.createHash('sha256').update(String(seed)).digest());
    }
    let buf = Buffer.concat(parts);
    // SQLite files are page multiples; keep the analogy so a 512 check would pass.
    buf = buf.subarray(0, buf.length - (buf.length % 512));
    return buf;
}

const PAYLOAD = makePayload();
const PAYLOAD_GZ = zlib.gzipSync(PAYLOAD);
const attempts = new Map();

function serve() {
    return new Promise(resolve => {
        const server = http.createServer((req, res) => {
            const url = new URL(req.url, 'http://x');
            const mode = Object.fromEntries(url.searchParams);
            const key = url.pathname + url.search;
            const n = (attempts.get(key) || 0) + 1;
            attempts.set(key, n);

            if (url.pathname === '/missing.db') { res.writeHead(404); res.end('no'); return; }
            const body = mode.gz ? PAYLOAD_GZ : PAYLOAD;

            let start = 0;
            const range = req.headers.range && /^bytes=(\d+)-$/.exec(req.headers.range);
            if (range && !mode.norange) {
                start = Number(range[1]);
                res.writeHead(206, {
                    'Content-Type': 'application/octet-stream',
                    'Content-Length': body.length - start,
                    'Content-Range': `bytes ${start}-${body.length - 1}/${body.length}`,
                });
            } else {
                const headers = { 'Content-Type': 'application/octet-stream' };
                if (!mode.nolength) headers['Content-Length'] = body.length;
                res.writeHead(200, headers);
            }

            // First attempt only: stop after `cut` bytes — close the socket (cut) or leave it
            // open and silent (stall). Later attempts serve in full, as a recovered network does.
            const misbehave = n === 1 && (mode.cut || mode.stall);
            const limit = misbehave ? start + Number(mode.cut || mode.stall) : body.length;
            const chunkSize = 16384;
            let pos = start;
            const pump = () => {
                while (pos < limit) {
                    const end = Math.min(limit, pos + chunkSize);
                    const ok = res.write(body.subarray(pos, end));
                    pos = end;
                    if (!ok) { res.once('drain', pump); return; }
                }
                if (pos >= body.length) { res.end(); return; }
                if (mode.cut) res.destroy();
                // stall: neither end nor destroy — the connection just stops carrying data.
            };
            pump();
        });
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

async function collect(next) {
    const chunks = [];
    for (;;) {
        const chunk = await next();
        if (chunk === undefined) break;
        chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
}

(async () => {
    const { openDatabaseStream } = await import(pathToFileURL(path.join(__dirname, '..', 'src', 'db-download.js')));
    const server = await serve();
    const base = `http://127.0.0.1:${server.address().port}`;

    async function run(query, options = {}) {
        const progress = [];
        const next = await openDatabaseStream(`${base}/dg-mobile.db${query}`, {
            name: 'dg-mobile.db',
            stallMs: 400,
            onProgress: (loaded, total) => progress.push([loaded, total]),
            ...options,
        });
        const bytes = await collect(next);
        return { bytes, progress, last: progress[progress.length - 1] };
    }

    // Plain file, well-behaved server.
    let r = await run('');
    chk('a plain file arrives intact', r.bytes.equals(PAYLOAD), r.bytes.length);
    chk('progress ends at the Content-Length total', r.last && r.last[0] === PAYLOAD.length && r.last[1] === PAYLOAD.length,
        JSON.stringify(r.last));

    // gzip, detected by magic bytes rather than by the URL.
    r = await run('?gz=1');
    chk('a gzip-compressed file is inflated on the way in', r.bytes.equals(PAYLOAD), r.bytes.length);
    chk('progress counts bytes on the wire, not after inflation',
        r.last && r.last[0] === PAYLOAD_GZ.length && r.last[1] === PAYLOAD_GZ.length, JSON.stringify(r.last));

    // No Content-Length: the manifest's figure is the total.
    r = await run('?nolength=1', { total: PAYLOAD.length });
    chk('without Content-Length the manifest total is used', r.bytes.equals(PAYLOAD) && r.last[1] === PAYLOAD.length,
        JSON.stringify(r.last));

    // Connection dropped mid-file: resumed with Range, bytes intact.
    r = await run('?cut=200000');
    chk('a dropped connection is resumed and the file is intact', r.bytes.equals(PAYLOAD), r.bytes.length);
    chk('the resume asked for the rest, not the whole file', attempts.get('/dg-mobile.db?cut=200000') === 2,
        attempts.get('/dg-mobile.db?cut=200000'));

    // Dropped mid-file AND gzip: the inflater sees one continuous stream.
    r = await run('?gz=1&cut=20000');
    chk('resume works through the inflater', r.bytes.equals(PAYLOAD), r.bytes.length);

    // Connection silent, not closed: the watchdog abandons it and resumes.
    const t = Date.now();
    r = await run('?stall=150000');
    chk('a silent connection is abandoned and resumed', r.bytes.equals(PAYLOAD), `${Date.now() - t}ms`);

    // Server that ignores Range: cannot be resumed against, must say so rather than restart.
    let err = null;
    try { await run('?cut=100000&norange=1'); } catch (e) { err = e; }
    chk('a server that ignores Range fails with a reason', !!err && /does not support resuming/.test(err.message),
        err && err.message);

    // A 404 is a 404, immediately, not after minutes of retries.
    err = null;
    const t404 = Date.now();
    try {
        const next = await openDatabaseStream(`${base}/missing.db`, { name: 'dg-mobile.db', stallMs: 400 });
        await collect(next);
    } catch (e) { err = e; }
    chk('a missing file fails at once with the status', !!err && /HTTP 404/.test(err.message) && Date.now() - t404 < 2000,
        err && err.message);

    // A local file that goes silent is not resumed (Capacitor's server does no ranges) — it fails.
    err = null;
    try { await run('?stall=100000', { resumable: false }); } catch (e) { err = e; }
    chk('a non-resumable source that stalls fails instead of retrying', !!err && /no data for/.test(err.message),
        err && err.message);

    server.close();
    console.log(bad ? `\n${bad} FAILED` : '\ndb-download.js holds against a misbehaving server');
    process.exit(bad ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
