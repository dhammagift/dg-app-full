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
        console.log(`speechSynthesis   api=${report.speech.api} voices=${report.speech.voices} speaks=${report.speech.speaks}`);
        const pp = report.progressPlugin || {};
        console.log(`DgProgress        present=${pp.present} awake=${pp.awake}${pp.error ? ' error=' + pp.error : ''}`);
    }

    if (report.deepLinksSeen) {
        console.log(`deep links seen   ${report.deepLinksSeen.length ? report.deepLinksSeen.join(', ') : '(none)'}`);
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
    // Speech is informational (it decides whether a TTS plugin is ever needed). The progress plugin
    // is not: it ships in the app and is what keeps the screen awake during the download.
    if (report.progressPlugin && report.progressPlugin.present === false && report.progressPlugin.capacitor) {
        problems.push('the native DgProgress plugin is not registered (screen will lock mid-download)');
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
