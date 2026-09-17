#!/usr/bin/env node
// Did the deep link actually move the app? The simulator run opens a dhammagift:// URL with
// `simctl openurl` while the app is running; the page cannot be inspected from outside the WebView,
// so it writes down its own path (test/ios-sim/selftest.js, the route watcher) and this is where
// that becomes a pass or a fail.
//
// Usage: node test/ios-sim/assert-deeplink.js .tmp/ios-ui/selftest.json /toc

const fs = require('fs');

const [, , file, expected] = process.argv;
if (!file || !fs.existsSync(file)) {
    console.error(`no self-test report at ${file || '(no path given)'}`);
    process.exit(1);
}
if (!expected) {
    console.error('usage: assert-deeplink.js <report.json> <expected path>');
    process.exit(1);
}

const report = JSON.parse(fs.readFileSync(file, 'utf8'));
const history = report.routeHistory || [];
const current = report.currentPath || '(unknown)';

console.log(`deep link: expected the app to end up on ${expected}`);
console.log(`current path: ${current}`);
console.log(`paths seen after the self-test: ${history.length ? history.join(', ') : '(none)'}`);

const hit = current === expected || history.indexOf(expected) !== -1;
if (!hit) {
    console.error('\nRESULT: FAILED — the deep link did not reach a page of its own.');
    console.error('  An app that never received the URL, or a mapping that answered it with nothing,');
    console.error('  both look exactly like this; the app console log is where they differ.');
    process.exit(1);
}

console.log('\nRESULT: OK — the app followed the deep link.');
