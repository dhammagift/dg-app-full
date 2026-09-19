#!/usr/bin/env node
// Cuts the light-en tour recording (drive.sh --record) into the 3 App Store previews Apple accepts
// per screenshot size. There is no second scripted run for this: the recording already shows the
// real app, at the real device resolution, doing real navigation — stages-light-en.log has a wall-
// clock timestamp for every view tour.js announced, so a clip boundary is "the moment the view
// changed", not a guessed second count. ffmpeg does the cutting because that is the tool for it, not
// because anything here depends on its internals beyond -ss/-t.
//
// Usage: node make-previews.js --video <mov> --stages <stages-light-en.log> --start <record-start.txt> --out <dir>

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function arg(name, fallback) {
    const i = process.argv.indexOf('--' + name);
    return i >= 0 ? process.argv[i + 1] : fallback;
}

const VIDEO = arg('video');
const STAGES = arg('stages');
const START = arg('start');
const OUT = arg('out');
const MAX_CLIP_SECONDS = 29; // Apple's App Preview cap is 30s; stay a second under it.

if (!VIDEO || !STAGES || !START || !OUT) {
    console.error('usage: make-previews.js --video <mov> --stages <log> --start <record-start.txt> --out <dir>');
    process.exit(2);
}

if (!fs.existsSync(VIDEO) || !fs.existsSync(STAGES) || !fs.existsSync(START)) {
    console.log('make-previews: missing input (video/stages/start) — nothing recorded, nothing to cut');
    process.exit(0);
}

try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
} catch (e) {
    console.log('::warning::ffmpeg not available on this runner — skipping preview cuts');
    process.exit(0);
}

const recordStart = parseFloat(fs.readFileSync(START, 'utf8').trim());
const stageAt = {};
fs.readFileSync(STAGES, 'utf8').trim().split('\n').forEach(function (line) {
    if (!line) return;
    const sp = line.indexOf(' ');
    const t = parseFloat(line.slice(0, sp));
    const name = line.slice(sp + 1).trim();
    // The tour re-announces "done" once if it stops early; the first timestamp for a name is the
    // real one, later ones are just the log fed again by a retry that never happens in practice.
    if (!(name in stageAt)) stageAt[name] = t;
});

// [from, until) per clip — the view named `from` through just before the view named `until` takes
// over, i.e. exactly what was on screen between those two announcements.
const CLIPS = [
    { file: 'preview-1-search.mov', from: 'home', until: 'reader' },
    { file: 'preview-2-reader.mov', from: 'reader', until: 'dictionary' },
    { file: 'preview-3-dictionary.mov', from: 'dictionary', until: 'done' },
];

fs.mkdirSync(OUT, { recursive: true });

CLIPS.forEach(function (clip) {
    if (!(clip.from in stageAt) || !(clip.until in stageAt)) {
        console.log('make-previews: skipping ' + clip.file + ' — stage "' + clip.from + '" or "' + clip.until + '" was never reached');
        return;
    }
    const start = Math.max(0, stageAt[clip.from] - recordStart);
    const duration = Math.min(MAX_CLIP_SECONDS, stageAt[clip.until] - stageAt[clip.from]);
    if (duration <= 0.5) {
        console.log('make-previews: skipping ' + clip.file + ' — computed duration ' + duration.toFixed(1) + 's is too short');
        return;
    }
    const dest = path.join(OUT, clip.file);
    execFileSync('ffmpeg', [
        '-y',
        '-ss', start.toFixed(2),
        '-i', VIDEO,
        '-t', duration.toFixed(2),
        '-an',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
        dest,
    ], { stdio: 'inherit' });
    console.log('make-previews: ' + dest + ' (' + duration.toFixed(1) + 's from ' + clip.from + ')');
});
