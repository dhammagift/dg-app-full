#!/usr/bin/env node
// Reads the self-test report the simulator run pulled out of the app container and judges it.
//
// Usage: node test/ios-sim/assert.js .tmp/ios-ui/selftest.json

const fs = require('fs');
const { judge } = require('./judge');

const file = process.argv[2];
if (!file || !fs.existsSync(file)) {
    console.error(`no self-test report at ${file || '(no path given)'}`);
    process.exit(1);
}

let report;
try {
    report = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch (e) {
    console.error(`the self-test report is not JSON: ${e.message}`);
    console.error(fs.readFileSync(file, 'utf8').slice(0, 2000));
    process.exit(1);
}

process.exit(judge(report));
