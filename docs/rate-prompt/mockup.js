// Mockups for the "rate us in the store" prompt — the design to agree on before any of it is built.
//
// Renders the REAL app page (www/index.html) from the real serve-local.js, injects the prompt using
// the offline-library download consent's own markup and classes (#dgConsent / .dgc-*), which is the
// sheet the owner asked to reuse ("рекомендую переиспользовать проект закачки офлайн библиотеки"),
// and screenshots it in both themes and both languages.
//
//   node docs/rate-prompt/mockup.js
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('/usr/lib/node_modules/@playwright/cli/node_modules/playwright');

const ROOT = path.join(__dirname, '..', '..');
const SHOTS = process.env.DG_SHOTS || '/var/www/html/dict-app';
const PORT = +(process.env.DG_PORT || 8101);

// The same five glyphs in both languages; only the words change.
const STARS = '★★★★★';

const COPY = {
    ru: {
        eyebrow: 'Оценить приложение',
        title: 'Нравится Dhamma.Gift?',
        body: 'Поставьте пять звёзд в Google Play. Это бесплатно и занимает полминуты, а по рейтингу приложение находят другие.',
        figs: [['Оценка', STARS], ['Займёт', '~30 сек'], ['Где', 'Google Play']],
        later: 'Позже',
        go: 'Оценить',
    },
    en: {
        eyebrow: 'Rate this app',
        title: 'Enjoying Dhamma.Gift?',
        body: 'Give it five stars on Google Play. It is free, takes half a minute, and the rating is how other readers find the app.',
        figs: [['Rating', STARS], ['Takes', '~30 sec'], ['Where', 'Google Play']],
        later: 'Later',
        go: 'Rate',
    },
};

function sheet(t, variant) {
    const figs = t.figs.map(function (f, i) {
        const wide = i === t.figs.length - 1 ? ' dgc-fig-wide' : '';
        return '<div class="dgc-fig' + wide + '"><dt>' + f[0] + '</dt><dd>' + f[1] + '</dd></div>';
    }).join('');
    // Variant 2 leads with the stars themselves — the same sheet, one line taller, for comparison.
    const stars = variant === 2
        ? '<div style="display:flex;gap:6px;font-size:26px;line-height:1;color:#f5c518;letter-spacing:2px">'
            + STARS.split('').map(function (s) { return '<span>' + s + '</span>'; }).join('') + '</div>'
        : '';
    return '<div id="dgConsent"><div id="dgConsentSheet" role="alertdialog" aria-modal="true">'
        + '<div class="dgc-eyebrow">' + t.eyebrow + '</div>'
        + stars
        + '<p class="dgc-title">' + t.title + '</p>'
        + '<p class="dgc-body">' + t.body + '</p>'
        + '<dl class="dgc-figures">' + figs + '</dl>'
        + '<div class="dgc-actions">'
        + '<button type="button" class="dgc-ghost">' + t.later + '</button>'
        + '<button type="button" class="dgc-primary">' + t.go + '</button>'
        + '</div></div></div>';
}

(async () => {
    fs.mkdirSync(SHOTS, { recursive: true });
    const server = spawn('node', [path.join(ROOT, 'test', 'serve-local.js'), path.join(ROOT, 'www'), path.join(ROOT, 'dist-none'), String(PORT)], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 900));
    const browser = await chromium.launch({ args: ['--no-sandbox'] });
    const made = [];
    try {
        for (const lang of ['ru', 'en']) {
            for (const theme of ['light', 'dark']) {
                for (const variant of [1, 2]) {
                    // Variant 2 only in one theme per language: the two differ by the star row alone.
                    if (variant === 2 && theme === 'light') continue;
                    const context = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, colorScheme: theme });
                    const page = await context.newPage();
                    await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'domcontentloaded' });
                    await page.waitForTimeout(700);
                    await page.evaluate(([html, th]) => {
                        document.documentElement.setAttribute('data-bs-theme', th);
                        document.body.insertAdjacentHTML('beforeend', html);
                        requestAnimationFrame(() => document.getElementById('dgConsent').classList.add('show'));
                    }, [sheet(COPY[lang], variant), theme]);
                    await page.waitForTimeout(500);
                    const shot = path.join(SHOTS, `rate-prompt-v${variant}-${lang}-${theme}.png`);
                    await page.screenshot({ path: shot });
                    made.push(shot);
                    await context.close();
                }
            }
        }
    } finally {
        await browser.close();
        server.kill();
    }
    console.log(made.join('\n'));
})();
