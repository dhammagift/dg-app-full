// The launch screens of the Dhamma.Gift and Dict apps: the splash (the mark assembles, then leaves)
// and the "no connection" screen (the same mark, a line of text, a "Try again" button).
//
// Design: docs/launch-screens/ (owner's handoff, 2026-09-26). One file for both apps: the main app
// loads it as /launch-screens.js, the dictionary app gets it pasted into dict-bridge.js and into its
// offline page by dict/build.js (the @launch-screens markers there) — the same one-source rule as the
// rating sheet.
//
// Theme and language follow the system (handoff), except that the main app's own language setting
// wins when it exists. Motion: one curve, cubic-bezier(.05,.7,.1,1); the mark assembles in about a
// second, leaves in 300 ms; with prefers-reduced-motion everything is still.
(function () {
    'use strict';
    if (window.dgLaunch) return;

    var EASE = 'cubic-bezier(.05,.7,.1,1)';
    var MIN_SPLASH_MS = 1400;   // the mark needs ~1.1 s to assemble; a screen that flashes is worse than none
    var MAX_SPLASH_MS = 6000;   // never hold the app hostage to a page that does not finish loading
    var SPLASH_KEY = 'dgSplashShown';

    var CSS = [
        '.dgls{--p:#fff;--t:#1b1d19;--t2:#5c6058;--tm:#6e716a;--a:#149c7c;--ab:#dff3ec;--aob:#0c6a55;--ni:#2f4a63;',
        'position:fixed;inset:0;z-index:2147483000;display:flex;flex-direction:column;align-items:center;justify-content:center;',
        'box-sizing:border-box;padding:0 28px;text-align:center;background:var(--p);color:var(--t);',
        'font-family:Lato,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}',
        '@media (prefers-color-scheme:dark){.dgls{--p:#111;--t:#ddd;--t2:#a8a8a8;--tm:#7c7c7c;--a:#136857;--ab:#12241f;--aob:#16b394;--ni:#a9c4dc}}',
        '.dgls.out{opacity:0;transform:scale(1.04);transition:opacity .3s ' + EASE + ',transform .3s ' + EASE + ';pointer-events:none}',
        '.dgls-mk{display:grid;place-items:center;margin-bottom:20px}',
        '.dgls .dgls-name{font-size:23px;font-weight:600;line-height:1.3;letter-spacing:-.015em;color:var(--t);animation:dgls-word 3.2s ' + EASE + ' 1 both}',
        // The main app's mark: one whole image, revealed by a circle growing from the book upwards, then a sheen.
        '.dgls-dg{position:relative;width:190px;height:110px}',
        '.dgls-dg img{position:absolute;inset:0;width:100%;height:100%;display:block;',
        '-webkit-mask:radial-gradient(circle at 50% 100%,#000 var(--dgr),transparent calc(var(--dgr) + 28%));',
        'mask:radial-gradient(circle at 50% 100%,#000 var(--dgr),transparent calc(var(--dgr) + 28%));',
        'animation:dgls-rise 3.2s cubic-bezier(.22,.61,.36,1) 1 both}',
        // Light theme: the mark is light grey and is never inverted, only outlined thinly.
        '@media (prefers-color-scheme:light){.dgls-dg{filter:drop-shadow(0 0 .5px rgba(27,29,25,.55)) drop-shadow(0 0 .5px rgba(27,29,25,.55))}}',
        '.dgls-dg::after{content:"";position:absolute;inset:0;',
        'background:linear-gradient(105deg,transparent 40%,rgba(255,255,255,.75) 50%,transparent 60%);background-size:260% 100%;',
        '-webkit-mask:var(--dgmark) center/100% 100% no-repeat;mask:var(--dgmark) center/100% 100% no-repeat;',
        'animation:dgls-sheen 3.2s ease-in-out 1 both}',
        '@property --dgr{syntax:"<percentage>";inherits:false;initial-value:0%}',
        '@keyframes dgls-rise{0%{--dgr:0%;opacity:0;transform:translateY(8px) scale(.96)}8%{opacity:1}34%,100%{--dgr:130%;opacity:1;transform:none}}',
        '@keyframes dgls-sheen{0%,32%{background-position:120% 0}48%,100%{background-position:-30% 0}}',
        '@keyframes dgls-word{0%,16%{opacity:0;transform:translateY(8px)}32%,100%{opacity:1;transform:none}}',
        // The dictionary's mark: hook draws, the dot drops, the stair grows from it, the teal line last.
        '.dgls-dc{width:130px;height:116px;overflow:visible}',
        '.dgls-dc .hk,.dgls-dc .st,.dgls-dc .ul{stroke-dasharray:1;stroke-dashoffset:1}',
        '.dgls-dc .hk{animation:dgls-d1 3.2s ' + EASE + ' 1 both}',
        '.dgls-dc .st{animation:dgls-d2 3.2s ' + EASE + ' 1 both}',
        '.dgls-dc .ul{animation:dgls-d3 3.2s ' + EASE + ' 1 both}',
        '.dgls-dc .dt{transform-box:fill-box;transform-origin:50% 50%;animation:dgls-dot 3.2s ' + EASE + ' 1 both}',
        '@keyframes dgls-d1{0%{stroke-dashoffset:1}24%,100%{stroke-dashoffset:0}}',
        '@keyframes dgls-d2{0%,14%{stroke-dashoffset:1}32%,100%{stroke-dashoffset:0}}',
        '@keyframes dgls-d3{0%,26%{stroke-dashoffset:1}40%,100%{stroke-dashoffset:0}}',
        '@keyframes dgls-dot{0%,8%{transform:translateY(-40px) scale(.4);opacity:0}18%{transform:translateY(3px) scale(1.1);opacity:1}22%,100%{transform:none;opacity:1}}',
        // The Uposatha app's mark: the moon rises from under the cloud, then the strokes of the cloud draw.
        '.dgls-up{width:118px;height:94px;overflow:visible}',
        '.dgls-up .mn{animation:dgls-rs 3.2s ' + EASE + ' 1 both}',
        '.dgls-up .cl{stroke-dasharray:1;stroke-dashoffset:1;animation:dgls-d1 3.2s ' + EASE + ' 1 both}',
        '.dgls-up .cl.b{animation-delay:.12s}.dgls-up .cl.c{animation-delay:.24s}',
        '@keyframes dgls-rs{0%{transform:translateY(16px);opacity:0}32%,100%{transform:none;opacity:1}}',
        // The error screen: mark, name, phrase, button, each 100 ms after the last.
        '.dgls-err .dgls-mk{height:120px;margin-bottom:22px}',
        '.dgls-err .dgls-dg{width:180px;height:104px}',
        '.dgls-err .dgls-dc{width:104px;height:90px}',
        '.dgls-err .dgls-up{width:104px;height:83px}',
        '.dgls-err .dgls-h,.dgls-err .dgls-tx,.dgls-err .dgls-bt,.dgls-err .dgls-st{animation:dgls-in .5s ' + EASE + ' both}',
        '.dgls .dgls-h{margin:0 0 10px;font-size:22px;font-weight:600;line-height:1.3;letter-spacing:-.01em;color:var(--t);animation-delay:.75s}',
        '.dgls .dgls-tx{margin:0;font-size:15px;line-height:1.5;font-weight:400;color:var(--t2);animation-delay:.85s}',
        '.dgls .dgls-hd{display:block;color:var(--t);font-weight:600;margin-bottom:2px}',
        '.dgls .dgls-bt{margin:26px 0 0;min-width:152px;height:44px;padding:0 22px;border-radius:999px;border:0;background:var(--a);color:#fff;text-transform:none;letter-spacing:normal;box-shadow:none;',
        'font-weight:700;font-size:15px;line-height:1;font-family:inherit;display:inline-flex;align-items:center;justify-content:center;gap:10px;cursor:pointer;',
        'animation-delay:.95s;transition:opacity .2s}',
        '.dgls-bt[disabled]{cursor:default;opacity:.6}',
        '.dgls-bt:focus-visible{outline:2px solid var(--a);outline-offset:3px}',
        '.dgls .dgls-ex{display:block;margin-top:12px;padding:10px 14px;border-radius:14px;background:var(--ab);color:var(--aob);font-size:14px;line-height:1.4}',
        '.dgls .dgls-st{position:absolute;left:0;right:0;bottom:22px;font-size:12px;color:var(--tm);animation-delay:1.1s}',
        '.dgls-spin{width:16px;height:16px;border-radius:50%;border:2px solid currentColor;border-right-color:transparent;animation:dgls-spin .8s linear infinite}',
        '@keyframes dgls-in{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}',
        '@keyframes dgls-spin{to{transform:rotate(360deg)}}',
        '@media (prefers-reduced-motion:reduce){.dgls *,.dgls *::after{animation:none!important}.dgls-dc .hk,.dgls-dc .st,.dgls-dc .ul,.dgls-up .cl{stroke-dashoffset:0}',
        '.dgls-dg img{-webkit-mask:none;mask:none}.dgls-dg::after{display:none}.dgls-dc .dt{opacity:1}.dgls.out{transition:none}}',
    ].join('');

    var TEXT = {
        ru: {
            none: ['Нет соединения.', 'Проверьте интернет и повторите.'],
            down: ['Сайт не отвечает.', 'Попробуйте чуть позже — сервер сейчас недоступен.'],
            retry: ['Проверяем соединение…', 'Это займёт несколько секунд.'],
            btn: 'Повторить', busy: 'Проверяем…', auto: 'Повторим сами, когда сеть появится',
            upo: 'Напоминания уже стоят на телефоне и придут без сети.',
        },
        en: {
            none: ['No connection.', 'Check the internet and try again.'],
            down: ['The site isn’t responding.', 'Try again shortly — the server is unavailable right now.'],
            retry: ['Checking the connection…', 'This takes a few seconds.'],
            btn: 'Try again', busy: 'Checking…', auto: 'We’ll retry by ourselves once you’re online',
            upo: 'Your reminders are set on this phone and will arrive without it.',
        },
    };

    var DICT_SVG = '<svg class="dgls-dc" viewBox="240 262 660 590" aria-hidden="true">'
        + '<g fill="none" stroke="currentColor" stroke-width="48" stroke-linejoin="miter">'
        + '<path class="hk" pathLength="1" d="M410 381H282V600C282 690 330 721 372 721C420 721 462 690 462 612"/>'
        + '<path class="st" pathLength="1" d="M608 690V545H738V380H855V292"/></g>'
        + '<circle class="dt" cx="608" cy="712" r="38" fill="currentColor"/>'
        + '<path class="ul" pathLength="1" d="M258 822H879" stroke="var(--a)" stroke-width="22"/></svg>';

    var UPO_SVG = '<svg class="dgls-up" viewBox="2 7.5 54.5 43.5" aria-hidden="true">'
        + '<mask id="dglsUpoMask" maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64"><rect width="64" height="64" fill="#fff"/>'
        + '<path d="M6,37 H31 M15,47 H43" stroke="#000" stroke-width="13" stroke-linecap="round"/></mask>'
        + '<g mask="url(#dglsUpoMask)"><circle class="mn" cx="39" cy="25" r="17" fill="var(--ni)"/></g>'
        + '<g stroke="var(--tm)" stroke-width="7" stroke-linecap="round" fill="none">'
        + '<path class="cl a" pathLength="1" d="M6,37 H31"/><path class="cl b" pathLength="1" d="M15,47 H43"/><path class="cl c" pathLength="1" d="M50,47 H53"/></g></svg>';

    function lang() {
        var saved = '';
        try { saved = localStorage.getItem('dhammaLanguage') || localStorage.getItem('siteLanguage') || ''; } catch (e) { /* no storage */ }
        if (saved === 'ru' || saved === 'en') return saved;
        return /^ru/i.test(navigator.language || '') ? 'ru' : 'en';
    }

    function addStyle() {
        if (document.getElementById('dglsStyle')) return;
        var s = document.createElement('style');
        s.id = 'dglsStyle';
        s.textContent = CSS;
        (document.head || document.documentElement).appendChild(s);
    }

    // app: 'dg' | 'dict'. The mark of the main app is an image the host serves (opts.markUrl).
    function build(app, opts, extraClass) {
        addStyle();
        var el = document.createElement('div');
        el.className = 'dgls ' + (extraClass || '');
        var mark;
        if (app === 'dict') {
            mark = DICT_SVG;
        } else if (app === 'upo') {
            mark = UPO_SVG;
        } else {
            var url = (opts && opts.markUrl) || '/launch-dg-full.png';
            el.style.setProperty('--dgmark', 'url("' + url + '")');
            mark = '<div class="dgls-dg"><img src="' + url + '" alt=""></div>';
        }
        el.innerHTML = '<div class="dgls-mk">' + mark + '</div>';
        return el;
    }

    function mount(el) {
        // documentElement, not body: the splash has to exist before the parser reaches <body>.
        (document.body || document.documentElement).appendChild(el);
    }

    function leave(el) {
        el.classList.add('out');
        setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 320);
    }

    // The splash, once per launch of the app (sessionStorage lives as long as the WebView's process):
    // going back to the home page later must not replay it. Leaves after MIN_SPLASH_MS and the page's
    // load, or after MAX_SPLASH_MS whatever happens.
    // At document start (the dictionary's bridge is injected there) there is no <html> yet: wait for it.
    function onRoot(fn) {
        if (document.documentElement) { fn(); return; }
        var mo = new MutationObserver(function () {
            if (document.documentElement) { mo.disconnect(); fn(); }
        });
        mo.observe(document, { childList: true });
    }

    function splash(app, opts) {
        try {
            if (sessionStorage.getItem(SPLASH_KEY)) return null;
            sessionStorage.setItem(SPLASH_KEY, '1');
        } catch (e) { /* no storage: a splash every time beats none */ }
        var started = Date.now(), gone = false, el = null;
        function go() { gone = true; if (el) leave(el); }
        onRoot(function () {
            if (gone) return;
            el = build(app, opts, 'dgls-splash');
            var name = document.createElement('div');
            name.className = 'dgls-name';
            name.textContent = app === 'dict' ? 'Dict' : app === 'upo' ? 'Uposatha' : 'Dhamma.Gift';
            el.appendChild(name);
            mount(el);
        });
        function whenLoaded() { setTimeout(go, Math.max(0, MIN_SPLASH_MS - (Date.now() - started))); }
        if (document.readyState === 'complete') whenLoaded();
        else window.addEventListener('load', whenLoaded, { once: true });
        setTimeout(go, MAX_SPLASH_MS);
        return { hide: go };
    }

    // The "no connection" screen. state: 'none' (offline) | 'down' (online, but no answer). opts.retry()
    // returns a promise: true = it worked (the host navigates on its own), false = still failing.
    function error(app, state, opts) {
        opts = opts || {};
        var existing = document.getElementById('dglsErr');
        if (existing) return existing.__dgls;
        var t = TEXT[lang()];
        var el = build(app, opts, 'dgls-err');
        el.id = 'dglsErr';
        el.setAttribute('role', 'alert');
        var title = app === 'dict' ? 'Dict.Dhamma.Gift' : app === 'upo' ? 'Uposatha' : 'Dhamma.Gift';
        el.insertAdjacentHTML('beforeend',
            '<div class="dgls-h"></div><div class="dgls-tx"><span class="dgls-hd"></span><span class="dgls-bd"></span>'
            + (app === 'upo' ? '<span class="dgls-ex"></span>' : '') + '</div>'
            + '<button type="button" class="dgls-bt"></button><div class="dgls-st"></div>');
        el.querySelector('.dgls-h').textContent = title;
        var head = el.querySelector('.dgls-hd'), body = el.querySelector('.dgls-bd');
        var btn = el.querySelector('button'), foot = el.querySelector('.dgls-st');
        var busy = false;

        function show(st) {
            var pair = t[st];
            head.textContent = pair[0];
            body.textContent = pair[1];
            btn.disabled = st === 'retry';
            btn.innerHTML = '';
            if (st === 'retry') {
                var sp = document.createElement('span');
                sp.className = 'dgls-spin';
                btn.appendChild(sp);
                btn.appendChild(document.createTextNode(t.busy));
            } else {
                btn.textContent = t.btn;
            }
            foot.textContent = st === 'none' ? t.auto : '';
        }
        function again() {
            if (busy) return;
            busy = true;
            show('retry');
            var started = Date.now();
            Promise.resolve(opts.retry ? opts.retry() : (location.reload(), true)).catch(function () { return false; }).then(function (ok) {
                // Long enough to read "Checking…": an instant flicker looks like the button did nothing.
                setTimeout(function () {
                    busy = false;
                    if (!ok) show(navigator.onLine === false ? 'none' : 'down');
                }, Math.max(0, 800 - (Date.now() - started)));
            });
        }
        btn.addEventListener('click', again);
        window.addEventListener('online', function () { if (document.getElementById('dglsErr')) again(); });
        if (app === 'upo') el.querySelector('.dgls-ex').textContent = t.upo;   // the reminders do not need the network
        show(state === 'down' ? 'down' : 'none');
        mount(el);
        el.__dgls = { retry: again };
        return el.__dgls;
    }

    window.dgLaunch = { splash: splash, error: error };
})();
