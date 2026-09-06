// How the database's bytes get from a URL to the worker, one chunk at a time.
//
// db-worker.js used to do this in ten lines: fetch(), getReader(), hand each chunk to the SAH
// pool's importDb(). On a phone those ten lines are where the app died. A connection that drops
// mid-transfer leaves reader.read() pending forever — no error, no timeout, a bar frozen at
// whatever figure it last drew — and a response without Content-Length (a proxy that chunks, nginx
// compressing on the fly) left the bar with no total, so even a download that finished never said
// so. Owner, on a device: "просто висит на 477".
//
// So this file owns three things the plain fetch did not:
//
//   1. A stall watchdog. A read that produces nothing for STALL_MS is abandoned, the connection is
//      dropped, and a new request asks for the rest with a Range header. Progress already in OPFS
//      is kept — importDb() writes sequentially and this stream simply continues feeding it. A
//      server that answers a Range request with 200 cannot be resumed against, and says so
//      instead of restarting 500MB in silence.
//
//   2. The total, from the response when it says one (Content-Length, or Content-Range on a
//      resumed request) and from the manifest when it does not. The bar therefore always has a
//      denominator, which is also what lets the UI know the download has actually finished.
//
//   3. gzip. The published file may be compressed — its bulk is text, and text compresses. It is
//      detected by the two magic bytes rather than by the URL, because the copy Android's
//      DownloadManager writes keeps the .db name whatever it holds. Decompression is the browser's
//      own DecompressionStream, streaming, so a compressed file costs no more memory than a plain
//      one. Progress counts bytes on the wire (what the reader is waiting for), not bytes after
//      inflation.
//
// It is a plain ES module with no dependency on the worker so it can be tested in Node against a
// real HTTP server (test/db-download.test.js) — the failure modes above are reproducible there and
// were not reproducible anywhere before.

export const STALL_MS = 30000;
const MAX_RETRIES = 12;
const MAX_BACKOFF_MS = 30000;

function isGzip(bytes) {
    return bytes.byteLength >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// Total length of the resource, as far as this response says. A 206 carries the full size in
// Content-Range; a 200 carries it in Content-Length. Either can be missing — cross-origin, a
// server has to expose Content-Range explicitly — and then the caller's figure is used instead.
function totalFrom(response, offset) {
    const range = response.headers.get('Content-Range');
    if (range) {
        const m = /\/(\d+)\s*$/.exec(range);
        if (m) return Number(m[1]);
    }
    const length = Number(response.headers.get('Content-Length'));
    return length > 0 ? offset + length : 0;
}

class HttpError extends Error {
    constructor(name, status, retryable) {
        super(`${name}: HTTP ${status}`);
        this.status = status;
        this.retryable = retryable;
    }
}

// The raw bytes of `url` as a ReadableStream that survives the connection not surviving.
function resumableStream(url, opts) {
    const { name, fetchImpl, stallMs, resumable, onProgress } = opts;
    let total = opts.total || 0;
    let offset = 0;
    let reader = null;
    let controller = null;
    let attempts = 0;

    async function connect() {
        controller = new AbortController();
        const headers = {};
        if (offset > 0) headers.Range = `bytes=${offset}-`;
        let response;
        try {
            response = await fetchImpl(url, { headers, signal: controller.signal, cache: 'no-store' });
        } catch (e) {
            // A network failure before any byte arrived is retried like any other; the URL being
            // unreachable at all shows up as the retries running out.
            e.retryable = true;
            throw e;
        }
        if (offset > 0) {
            if (response.status === 206) {
                // fine
            } else if (response.status === 200) {
                // The server ignored the Range. The bytes already written cannot be un-written,
                // so the only honest outcome is a failure the reader can retry from scratch.
                try { controller.abort(); } catch (_) { /* ignore */ }
                throw new Error(`${name}: the server does not support resuming (got 200 for bytes=${offset}-)`);
            } else {
                throw new HttpError(name, response.status, response.status >= 500 || response.status === 429);
            }
        } else if (!response.ok) {
            throw new HttpError(name, response.status, response.status >= 500 || response.status === 429);
        }
        if (!total) total = totalFrom(response, offset);
        if (!response.body) throw new Error(`${name}: the response carries no body`);
        reader = response.body.getReader();
    }

    // reader.read() that gives up after stallMs of silence. Aborting the controller settles the
    // original promise (rejected), so nothing is left pending.
    function readWithWatchdog() {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                const e = new Error(`${name}: no data for ${Math.round(stallMs / 1000)}s at ${offset} bytes`);
                e.retryable = true;
                try { controller.abort(); } catch (_) { /* ignore */ }
                reject(e);
            }, stallMs);
            reader.read().then(
                result => { clearTimeout(timer); resolve(result); },
                err => { clearTimeout(timer); err.retryable = true; reject(err); });
        });
    }

    function dropConnection() {
        if (reader) { try { reader.cancel().catch(() => {}); } catch (_) { /* ignore */ } }
        if (controller) { try { controller.abort(); } catch (_) { /* ignore */ } }
        reader = null;
        controller = null;
    }

    return new ReadableStream({
        async pull(ctrl) {
            for (;;) {
                try {
                    if (!reader) await connect();
                    const { done, value } = await readWithWatchdog();
                    if (done) {
                        // A stream that ends short of the announced size is a dropped connection
                        // that happened to close cleanly. Treated the same as one that did not.
                        if (total && offset < total) {
                            const e = new Error(`${name}: connection closed at ${offset} of ${total} bytes`);
                            e.retryable = true;
                            throw e;
                        }
                        ctrl.close();
                        return;
                    }
                    offset += value.byteLength;
                    attempts = 0;
                    onProgress(offset, total);
                    ctrl.enqueue(value);
                    return;
                } catch (e) {
                    dropConnection();
                    // Nothing written yet means nothing to resume: a 404 or a refused connection
                    // on the first request is reported as is, after the retries a network fault
                    // deserves. Once bytes are on disk, only a server that cannot resume ends it.
                    const canRetry = e.retryable && attempts < MAX_RETRIES && (offset === 0 || resumable);
                    if (!canRetry) { ctrl.error(e); throw e; }
                    const wait = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempts);
                    attempts++;
                    await sleep(wait);
                }
            }
        },
        cancel() { dropConnection(); },
    });
}

// Wraps a byte stream so that a gzip member is inflated and anything else passes through. The
// decision is made on the first chunk, which is why this cannot be a plain pipeThrough.
async function inflateIfGzip(stream) {
    const reader = stream.getReader();
    const first = await reader.read();
    if (first.done) return new ReadableStream({ start(ctrl) { ctrl.close(); } });

    const rest = new ReadableStream({
        start(ctrl) { ctrl.enqueue(first.value); },
        async pull(ctrl) {
            const { done, value } = await reader.read();
            if (done) ctrl.close(); else ctrl.enqueue(value);
        },
        cancel(reason) { return reader.cancel(reason); },
    });
    if (!isGzip(first.value)) return rest;
    if (typeof DecompressionStream !== 'function') {
        throw new Error('the published database is gzip-compressed and this WebView cannot inflate it');
    }
    return rest.pipeThrough(new DecompressionStream('gzip'));
}

// Returns the callback pool.importDb() takes: each call yields the next chunk of the database, or
// undefined at the end. `total` is the size on the wire when known from the manifest; onProgress
// receives (bytesOnTheWire, totalOnTheWire) and is called for every chunk that arrives.
//
// `resumable` should be false for a local file (the copy DownloadManager wrote, reached through
// Capacitor's own server): that server does not do ranges, and a read from local storage that
// stalls is not a network fault to wait out.
export async function openDatabaseStream(url, options = {}) {
    const opts = {
        name: options.name || 'dg-mobile.db',
        fetchImpl: options.fetch || ((u, init) => fetch(u, init)),
        stallMs: options.stallMs || STALL_MS,
        resumable: options.resumable !== false,
        total: options.total || 0,
        onProgress: options.onProgress || (() => {}),
    };
    const inflated = await inflateIfGzip(resumableStream(url, opts));
    const reader = inflated.getReader();
    return async function next() {
        const { done, value } = await reader.read();
        return done ? undefined : value;
    };
}
