// Non-blocking status for the first-run offline DB download (see app.js's fetchDbBytes/
// hasNetworkConsent — this file only renders what those dispatch, no download logic of its
// own). Deliberately NOT a blocking overlay/wizard — owner: "не блокировать, показывать
// строку, чтобы юзер уже мог пользоваться мультитулом или настройками". Reuses the existing
// toast's `.bubble-notification` class (settings.js's showBubbleNotification(), see
// extrastyles.css) rather than inventing new visual style — that class already has
// pointer-events:none, so it never eats clicks meant for the rest of the page.
//
// Loaded on index.html only, next to native-bridge.js — keeps app.js a pure data+events shim
// (no DOM code), same separation of concerns already used for native-bridge.js.
(function () {
    function isRuLang() {
        return (localStorage.getItem('dhammaLanguage') || localStorage.getItem('siteLanguage') || 'en') === 'ru';
    }

    function labelFor(name, ru) {
        // One file now: the app reads a language slice of the server's own dg.db rather than the
        // core/lang split it used to build for itself.
        if (name === 'dg-mobile.db') return ru ? 'тексты и переводы' : 'texts and translations';
        return name;
    }

    // Self-colored (like .bubble-notification above), no dark/light variant needed — visible on
    // either theme the same way the existing toast is.
    const style = document.createElement('style');
    style.textContent = `
        #dgApiLoadingDot {
            position: fixed; right: 16px; bottom: 16px; width: 28px; height: 28px;
            border-radius: 50%; background: rgba(0,0,0,0.7); z-index: 10001;
            opacity: 0; transition: opacity 0.15s ease; pointer-events: none;
        }
        #dgApiLoadingDot.show { opacity: 1; }
        #dgApiLoadingDot::after {
            content: ""; position: absolute; inset: 5px; border-radius: 50%;
            border: 2px solid rgba(255,255,255,0.35); border-top-color: #fff;
            animation: dgApiLoadingSpin 0.7s linear infinite;
        }
        @keyframes dgApiLoadingSpin { to { transform: rotate(360deg); } }

        /* extrastyles.css gives .bubble-notification white-space:nowrap with max-width:80%.
           Every toast the site itself raises is short enough to fit, so it never showed — but a
           download error carries the reason ("core.db: HTTP 404"), and nowrap clipped exactly
           the part worth reading. Wrapping only changes messages that were being truncated. */
        .bubble-notification { white-space: normal; }

        /* Consent sheet. Replaces window.confirm(), which Android draws as an AppCompat
           AlertDialog: square-ish, uppercase buttons, and the page origin ("https://localhost")
           as its title — it reads as a browser warning about the app rather than as the app
           asking a question. It is also blocking, so nothing behind it can render meanwhile.
           Colours come from the site's own accent (#136857, same as .bubble-notification) and
           follow Bootstrap's data-bs-theme, which themeswitch.js already sets on <html>. */
        #dgConsent {
            position: fixed; inset: 0; z-index: 10002;
            display: flex; align-items: flex-end; justify-content: center;
            background: rgba(8, 20, 17, .5);
            opacity: 0; transition: opacity .18s ease;
        }
        #dgConsent.show { opacity: 1; }
        #dgConsentSheet {
            --dgc-surface: #fff; --dgc-sunk: #f1f5f4; --dgc-rule: #dde5e2;
            --dgc-ink: #141a18; --dgc-muted: #5b6b66; --dgc-faint: #8a9994; --dgc-accent: #136857;
            width: min(420px, calc(100% - 28px)); margin: 0 0 14px;
            background: var(--dgc-surface); color: var(--dgc-ink);
            border: 1px solid var(--dgc-rule); border-radius: 20px;
            padding: 20px 18px 16px;
            box-shadow: 0 24px 64px -16px rgba(9, 30, 25, .45);
            display: flex; flex-direction: column; gap: 12px;
            transform: translateY(14px); transition: transform .2s cubic-bezier(.2,.8,.3,1);
            font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
        }
        #dgConsent.show #dgConsentSheet { transform: translateY(0); }
        [data-bs-theme="dark"] #dgConsentSheet {
            --dgc-surface: #171f1d; --dgc-sunk: #101816; --dgc-rule: #27332f;
            --dgc-ink: #e8efec; --dgc-muted: #9aaba6; --dgc-faint: #6d7f7a; --dgc-accent: #3f9d86;
            box-shadow: 0 24px 64px -16px rgba(0, 0, 0, .7);
        }
        #dgConsentSheet .dgc-eyebrow {
            font-size: 10.5px; letter-spacing: .1em; text-transform: uppercase;
            font-weight: 600; color: var(--dgc-accent);
        }
        #dgConsentSheet .dgc-title { font-size: 16.5px; font-weight: 600; line-height: 1.3; margin: -4px 0 0; }
        #dgConsentSheet .dgc-body { font-size: 13.5px; line-height: 1.5; color: var(--dgc-muted); margin: 0; }
        #dgConsentSheet .dgc-figures {
            display: grid; grid-template-columns: 1fr 1fr; gap: 1px;
            background: var(--dgc-rule); border-radius: 12px; overflow: hidden; margin: 0;
        }
        #dgConsentSheet .dgc-fig { background: var(--dgc-sunk); padding: 10px 12px; }
        #dgConsentSheet .dgc-fig dt {
            font-size: 10.5px; letter-spacing: .06em; text-transform: uppercase;
            color: var(--dgc-faint); margin: 0 0 2px;
        }
        #dgConsentSheet .dgc-fig dd {
            margin: 0; font-size: 16px; font-weight: 600;
            font-variant-numeric: tabular-nums; color: var(--dgc-ink);
        }
        #dgConsentSheet .dgc-fig dd span { font-size: 11.5px; font-weight: 400; color: var(--dgc-muted); margin-left: 2px; }
        #dgConsentSheet .dgc-actions { display: flex; gap: 9px; margin-top: 2px; }
        #dgConsentSheet button {
            flex: 1; font: inherit; font-size: 14px; font-weight: 600;
            padding: 11px 14px; border-radius: 13px; cursor: pointer;
            border: 1px solid transparent; transition: background .16s ease, border-color .16s ease;
        }
        #dgConsentSheet .dgc-ghost { background: transparent; border-color: var(--dgc-rule); color: var(--dgc-muted); }
        #dgConsentSheet .dgc-ghost:hover { background: var(--dgc-sunk); }
        #dgConsentSheet .dgc-primary { background: var(--dgc-accent); color: #fff; }
        #dgConsentSheet .dgc-primary:hover { filter: brightness(1.08); }
        #dgConsentSheet button:focus-visible { outline: 2px solid var(--dgc-accent); outline-offset: 2px; }
        @media (prefers-reduced-motion: reduce) {
            #dgConsent, #dgConsentSheet { transition: none; }
        }
    `;
    document.head.appendChild(style);

    let bar = null;
    function ensureBar() {
        if (bar) return bar;
        bar = document.createElement('div');
        bar.id = 'dgOfflineStatus';
        bar.className = 'bubble-notification info';
        document.body.appendChild(bar);
        return bar;
    }

    window.addEventListener('dg:dl-progress', function (e) {
        const { name, step, totalSteps, loaded, total } = e.detail;
        const ru = isRuLang();
        const pct = total ? Math.round((loaded / total) * 100) : null;
        const stepLabel = ru ? `Загрузка (${step}/${totalSteps})` : `Downloading (${step}/${totalSteps})`;
        const el = ensureBar();
        el.textContent = pct !== null
            ? `${stepLabel}: ${labelFor(name, ru)} ${pct}%`
            : `${stepLabel}: ${labelFor(name, ru)}`;
        el.classList.add('show');
    });

    // app.js dispatches this (and awaits the resolve it carries) only when a download is
    // actually needed AND the connection isn't Wi-Fi — never on a fully-cached return visit.
    //
    // The figure comes from the published manifest, which app.js fetches before asking — so the
    // dialog states the file that is actually about to cross the connection, not a number compiled
    // in months ago.
    //
    // It used to quote two: "~60MB downloaded, ~260MB stored", from when the library was three
    // files and dg-light.js's gzip made the wire cost a fraction of the stored size. Neither half
    // survives. It is one file now, and its bulk is the trigram index, which is high-entropy and
    // does not compress — measured on a comparable slice, gzip turned 168MB into 177MB, i.e. made
    // it bigger. Wire cost and storage cost are therefore the same number, and promising 60MB
    // before pulling 168MB over someone's mobile data is precisely what this dialog exists to
    // prevent. FALLBACK_MB is only for a server old enough to publish no manifest.
    const FALLBACK_MB = 170;
    function sizeMb(bytes) { return bytes ? Math.round(bytes / 1048576) : FALLBACK_MB; }
    window.addEventListener('dg:need-consent', function (e) {
        e.detail.resolve(askConsent(isRuLang(), e.detail));
    });

    // Returns a Promise<boolean>, which is what app.js's hasNetworkConsent() awaits — the same
    // contract window.confirm() had, minus the blocking. Anything that dismisses without
    // choosing (Esc, tapping outside) counts as "not now": declining is recoverable from
    // Settings, while starting a ~170MB transfer nobody asked for is not.
    function askConsent(ru, detail) {
        var mb = sizeMb(detail && detail.bytes);
        var approx = (detail && detail.bytes) ? '' : '~';
        var langs = (detail && detail.langs) || 'ru,en';
        return new Promise(function (resolve) {
            var previouslyFocused = document.activeElement;
            var overlay = document.createElement('div');
            overlay.id = 'dgConsent';
            overlay.innerHTML =
                '<div id="dgConsentSheet" role="alertdialog" aria-modal="true"' +
                     ' aria-labelledby="dgConsentTitle" aria-describedby="dgConsentBody">' +
                  '<div class="dgc-eyebrow">' + (ru ? 'Офлайн-библиотека' : 'Offline library') + '</div>' +
                  '<p class="dgc-title" id="dgConsentTitle">' +
                    (ru ? 'Скачать тексты для работы без сети?' : 'Download the texts for offline use?') +
                  '</p>' +
                  '<p class="dgc-body" id="dgConsentBody">' +
                    (ru ? 'Это один файл — столько же скачается, столько же займёт на устройстве: он почти не сжимается. Сейчас соединение не через Wi-Fi; загрузку можно отложить и запустить позже в Настройках.'
                        : 'It is a single file, so that is both what downloads and what it occupies — it barely compresses. You are not on Wi-Fi right now; you can postpone this and start it later from Settings.') +
                  '</p>' +
                  '<dl class="dgc-figures">' +
                    '<div class="dgc-fig"><dt>' + (ru ? 'Размер' : 'Size') + '</dt>' +
                      '<dd>' + approx + mb + '<span>' + (ru ? 'МБ' : 'MB') + '</span></dd></div>' +
                    '<div class="dgc-fig"><dt>' + (ru ? 'Языки' : 'Languages') + '</dt>' +
                      '<dd>' + langs.split(',').join('+').toUpperCase() + '</dd></div>' +
                  '</dl>' +
                  '<div class="dgc-actions">' +
                    '<button type="button" class="dgc-ghost">' + (ru ? 'Не сейчас' : 'Not now') + '</button>' +
                    '<button type="button" class="dgc-primary">' + (ru ? 'Скачать' : 'Download') + '</button>' +
                  '</div>' +
                '</div>';
            document.body.appendChild(overlay);
            // Next frame, so the .show transition has an initial state to animate from.
            requestAnimationFrame(function () { overlay.classList.add('show'); });

            var buttons = overlay.querySelectorAll('button');
            var settled = false;
            function close(answer) {
                if (settled) return;
                settled = true;
                document.removeEventListener('keydown', onKey, true);
                overlay.classList.remove('show');
                setTimeout(function () { overlay.remove(); }, 200);
                if (previouslyFocused && previouslyFocused.focus) previouslyFocused.focus();
                resolve(answer);
            }
            function onKey(ev) {
                if (ev.key === 'Escape') { ev.preventDefault(); close(false); return; }
                if (ev.key !== 'Tab') return;
                // Two focusable elements, so a manual wrap is enough to keep focus in the sheet.
                ev.preventDefault();
                var idx = ev.shiftKey ? 0 : 1;
                buttons[document.activeElement === buttons[idx] ? (idx ? 0 : 1) : idx].focus();
            }
            buttons[0].addEventListener('click', function () { close(false); });
            buttons[1].addEventListener('click', function () { close(true); });
            overlay.addEventListener('click', function (ev) { if (ev.target === overlay) close(false); });
            document.addEventListener('keydown', onKey, true);
            buttons[1].focus();
        });
    }

    // Owner: "добавь спиннер даже на открытие текстов, чтобы юзер понимал что уже нажал" — a
    // small persistent dot in the corner, not a bubble/toast: text opens are usually fast (see
    // app.js's withLoadingEvent + the index fix in build-offline-db.js), so this should read as
    // "working" for a beat, not steal the screen like the download banner does.
    let loadingDot = null;
    let loadingTimer = null;
    window.addEventListener('dg:api-loading', function (e) {
        if (e.detail.active) {
            // Delayed show — after the index/batching fix (build-offline-db.js,
            // buildApiTextResponse) most opens resolve well under this, so the common case is no
            // flash at all; only genuinely slow ones (first run, big sutta) show it.
            loadingTimer = setTimeout(function () {
                if (!loadingDot) {
                    loadingDot = document.createElement('div');
                    loadingDot.id = 'dgApiLoadingDot';
                    document.body.appendChild(loadingDot);
                }
                loadingDot.classList.add('show');
            }, 150);
        } else {
            clearTimeout(loadingTimer);
            if (loadingDot) loadingDot.classList.remove('show');
        }
    });

    if (window.dgOfflineReady && typeof window.dgOfflineReady.then === 'function') {
        window.dgOfflineReady.then(function () {
            // Nothing was ever shown — already fully cached, ready resolved near-instantly.
            // Stay silent, exactly as the owner asked ("полоска не должна даже мелькать").
            if (!bar) return;
            bar.classList.remove('show');
            if (typeof window.showBubbleNotification === 'function') {
                window.showBubbleNotification(
                    isRuLang() ? 'Офлайн-библиотека готова' : 'Offline library ready', 2500, 'success'
                );
            }
        }).catch(function (err) {
            // Two very different outcomes used to share one message. Declining the cellular-data
            // prompt is a CHOICE; a failed request is a FAULT — and telling someone they
            // postponed a download that never got the chance to start sends them to a retry
            // button that cannot fix a server with no file to serve. That is exactly how a
            // missing https://<DIST_BASE>/core.db presented: "download postponed", instantly,
            // with nothing to retry.
            //
            // loadData() marks the choice explicitly ('offline-data-download-declined'), so
            // anything else is a real failure and now says what went wrong — fetchDbBytes throws
            // "<file>: HTTP <status>", which points straight at the server rather than the user.
            var declined = err && err.message === 'offline-data-download-declined';
            if (!declined) console.error('[dg-offline] database download failed:', err);

            // Owner: a permanent banner just sits there forever after declining — a few-second
            // heads-up is enough (same toast the success path already uses below); Settings'
            // own "Offline library" row (offline-library-settings.js) is the persistent, always-
            // visible reminder/retry point, this doesn't need to duplicate that by staying up.
            // A real error gets longer on screen: unlike a decline, it isn't something the
            // reader already knows they did.
            var text = declined
                ? (isRuLang() ? 'Скачивание отложено — повторите в Настройках'
                              : 'Download postponed — retry from Settings')
                : (isRuLang() ? 'Не удалось скачать данные: ' : 'Could not download data: ') +
                  ((err && err.message) || (isRuLang() ? 'неизвестная ошибка' : 'unknown error'));

            if (typeof window.showBubbleNotification === 'function') {
                window.showBubbleNotification(text, declined ? 4000 : 9000, declined ? 'info' : 'error');
            }
        });
    }
})();
