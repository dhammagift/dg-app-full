// The one place that decides whether a self-test report is good, shared by the two things that
// produce one: the simulator run (assert.js, reading a file out of the app container) and the local
// check (local-check.js, reading the same report out of a Chromium console line). Prints everything
// it looked at either way — a red check with no detail is how a real failure gets mistaken for
// flakiness.

function judge(report) {
    console.log('--- the WebView this ran in ---');
    console.log(`origin            ${report.origin}`);
    console.log(`secure context    ${report.isSecureContext}   (OPFS needs one; capacitor://localhost is one)`);
    console.log(`navigator.storage ${report.hasOpfs ? 'present' : 'MISSING — OPFS is unavailable, the offline layer cannot work'}`);
    console.log(`library origin    ${report.distBase}`);
    console.log(`online origin     ${report.onlineOrigin}  (deliberately dead: an answer below can only be local)`);

    if (report.wakeLock) {
        console.log(`screen wake lock  api=${report.wakeLock.api} via=${report.wakeLock.how} requested=${report.wakeLock.requests} released=${report.wakeLock.releases}`);
    }

    console.log('--- the offline library ---');
    console.log(`present           ${report.libraryPresent}`);
    console.log(`waited            ${report.waitedMs} ms`);
    console.log(`state             ${JSON.stringify(report.state)}`);
    if (report.progress && report.progress.length) {
        const last = report.progress[report.progress.length - 1];
        console.log(`progress events   ${report.progress.length}, last ${JSON.stringify(last)}`);
    }

    if (report.speech) {
        console.log('--- speech and the native progress plugin ---');
        console.log(`speech engine     ${report.speech.engine} (plugin = src/tts.js's shim over DgTts; native = the WebView's own)`);
        console.log(`speechSynthesis   api=${report.speech.api} voices=${report.speech.voices} speaks=${report.speech.speaks}`);
        const pp = report.progressPlugin || {};
        console.log(`DgProgress        present=${pp.present} awake=${pp.awake}${pp.error ? ' error=' + pp.error : ''}`);
        const dp = report.downloadPlugin;
        if (dp) console.log(`DgDownload        present=${dp.present} archive=${dp.found ? dp.path : 'none yet'}${dp.error ? ' error=' + dp.error : ''}`);
        const tp = report.ttsPlugin;
        if (tp) console.log(`DgTts             present=${tp.present} voices=${tp.voices} speak=${tp.speak}${tp.error ? ' error=' + tp.error : ''}${tp.sample ? ' [' + tp.sample.join(', ') + ']' : ''}`);
    }

    if (report.deepLinksSeen) {
        console.log(`deep links seen   ${report.deepLinksSeen.length ? report.deepLinksSeen.join(', ') : '(none)'}`);
    }

    if (report.viewport) {
        const v = report.viewport;
        console.log(`viewport          inner ${v.innerWidth}x${v.innerHeight} of screen ${v.screenWidth}x${v.screenHeight}, visual offsetTop ${v.visualOffsetTop}`);
    }

    if (report.linkCheck) {
        const l = report.linkCheck;
        console.log(`--- links, resolved inside the WebView ---`);
        if (l.views) console.log(`views crawled ${JSON.stringify(l.views)}`);
        if (l.pageStatus) console.log(`pages ${JSON.stringify(l.pageStatus)}`);
        console.log(`checked ${l.checked} same-origin links, ${l.external} external (opened by the device browser), ${l.failed.length} failed`);
        for (const f of l.failed.slice(0, 12)) console.log(`  FAIL ${f.href} — ${f.why}`);
        if (l.spaFallbacks && l.spaFallbacks.length) {
            console.log(`  routes served as the SPA shell (expected): ${l.spaFallbacks.slice(0, 8).join(', ')}${l.spaFallbacks.length > 8 ? ', …' : ''}`);
        }
    }

    if (report.pageChecks) {
        const p = report.pageChecks;
        console.log(`--- mandatory functionality, page by page ---`);
        console.log(`areas ${JSON.stringify(p.byArea)}`);
        for (const f of p.failed) console.log(`  FAIL [${f.area}] ${f.url} — ${f.why}`);
        if (report.dictionaryModes) console.log(`dictionary modes  ${report.dictionaryModes.ok ? 'ok (' + report.dictionaryModes.keys + ' keys)' : 'FAIL — ' + report.dictionaryModes.why}`);
        if (report.dictionaryCode) console.log(`dictionary code   ${report.dictionaryCode.ok ? 'ok — ' + report.dictionaryCode.how : 'FAIL — ' + report.dictionaryCode.why}`);
        if (report.signInUrl) console.log(`sign-in URL       ${report.signInUrl.ok ? 'ok' : 'FAIL — ' + report.signInUrl.why}${report.signInUrl.url ? '\n                  ' + report.signInUrl.url : ''}`);
    }

    console.log('--- answers, asked from inside the app ---');
    let failed = 0;
    for (const c of report.cases || []) {
        const mark = c.ok ? 'ok  ' : 'FAIL';
        if (!c.ok) failed++;
        console.log(`${mark} ${c.name.padEnd(22)} status=${c.status} bytes=${String(c.bytes).padStart(6)} expect=${c.expect === null ? '(no hits)' : c.expect}`);
        if (!c.ok) console.log(`     ${c.url}\n     ${String(c.sample).split('\n')[0].slice(0, 200)}`);
    }

    const problems = [];
    if (!report.isSecureContext) problems.push('the page is not a secure context');
    if (!report.hasOpfs) problems.push('navigator.storage.getDirectory is missing (no OPFS)');
    if (!report.libraryPresent) problems.push(`the library never opened${report.error ? ': ' + report.error : ''}`);
    if (!report.cases || report.cases.length === 0) problems.push('no case ran');
    if (failed) problems.push(`${failed} case(s) answered wrongly`);
    if (report.pageChecks && report.pageChecks.failed.length) {
        problems.push(`${report.pageChecks.failed.length} page(s) of the mandatory functionality do not open in the app`);
    }
    if (report.dictionaryModes && !report.dictionaryModes.ok) problems.push('the dictionary mode table is missing: ' + report.dictionaryModes.why);
    if (report.dictionaryCode && !report.dictionaryCode.ok) problems.push('the dictionary code cannot be loaded or refuses silently: ' + report.dictionaryCode.why);
    if (report.signInUrl && !report.signInUrl.ok) problems.push('the Google sign-in URL is wrong: ' + report.signInUrl.why);
    if (report.linkCheck && report.linkCheck.failed.length) {
        problems.push(`${report.linkCheck.failed.length} link(s) the device cannot serve (the reader would get the home page)`);
    }
    // Speech is informational (it decides whether a TTS plugin is ever needed). The progress plugin
    // is not: it ships in the app and is what keeps the screen awake during the download.
    if (report.progressPlugin && report.progressPlugin.present === false && report.progressPlugin.capacitor) {
        problems.push('the native DgProgress plugin is not registered (screen will lock mid-download)');
    }
    if (report.ttsPlugin && report.ttsPlugin.present === false && report.ttsPlugin.capacitor) {
        problems.push('the native DgTts plugin is not registered (the reader cannot speak)');
    }
    // The layer must ask for a screen wake lock while a transfer runs (dg-node's
    // offline-status.js). Asserted only where the API exists: the code is written to do nothing at
    // all without it, and a WebView that does not expose navigator.wakeLock is not a failure of ours
    // — but where it does exist and nothing was requested, the transfer would stall on a sleeping
    // screen, which is exactly the iPhone behaviour this was added for.
    if (report.wakeLock && report.wakeLock.api && report.libraryPresent && !report.wakeLock.requests) {
        problems.push('a download ran but the screen wake lock was never requested');
    }
    if (report.downloadPlugin && report.downloadPlugin.present === false && report.downloadPlugin.capacitor) {
        problems.push('the native DgDownload plugin is not registered (the 216 MB download dies in the background)');
    }
    // In the app the plugin-backed shim is the only engine that speaks: the WebView's own throws.
    if (report.speech && report.speech.engine === 'native' && report.progressPlugin && report.progressPlugin.capacitor) {
        problems.push("the reader would use the WebView's own speechSynthesis (WKWebView throws on speak)");
    }

    if (problems.length) {
        console.error('\nRESULT: FAILED');
        for (const p of problems) console.error(`  - ${p}`);
        return 1;
    }

    console.log(`\nRESULT: OK — the offline library opened and answered ${report.cases.length}/${report.cases.length} requests from the local database.`);
    return 0;
}

module.exports = { judge };
