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

    // Owner: the consent sheet showed the language set as "RU+EN", which reads like a build flag
    // rather than like something offered to a reader. These are the names people use. Unknown
    // codes fall back to the bare code rather than being dropped — a language nobody named here
    // should still be visible in the figure.
    var LANG_NAMES = {
        ru: { ru: 'русский', en: 'Russian' },
        en: { ru: 'английский', en: 'English' },
        pli: { ru: 'пали', en: 'Pali' },
        de: { ru: 'немецкий', en: 'German' },
    };
    function languageList(langs, ru) {
        var names = String(langs || '').split(',').map(function (code) {
            var key = code.trim().toLowerCase();
            var entry = LANG_NAMES[key];
            return entry ? entry[ru ? 'ru' : 'en'] : key.toUpperCase();
        }).filter(Boolean);
        if (!names.length) return ru ? 'русский и английский' : 'Russian and English';
        if (names.length === 1) return names[0];
        var last = names.pop();
        return names.join(', ') + (ru ? ' и ' : ' and ') + last;
    }

    function formatMb(bytes) {
        var mb = bytes / 1048576;
        return (mb < 10 ? mb.toFixed(1) : Math.round(mb));
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
        #dgConsentSheet .dgc-fig-wide { grid-column: 1 / -1; }
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
        /* The language figure carries words now, not a "RU+EN" flag, so it gets its own scale
           and is allowed to wrap rather than being clipped by the number-sized rule above. */
        #dgConsentSheet .dgc-fig-wide dd {
            font-size: 13.5px; font-weight: 500; line-height: 1.35;
            font-variant-numeric: normal;
        }

        /* Download progress. Owner asked for a real bar, not a line of text — this is the same
           surface, radius and accent as the consent sheet above so the two read as one thing,
           and it is deliberately NOT interactive: nothing here can be clicked, so it never eats
           a tap meant for the page underneath. */
        #dgDlCard {
            position: fixed; left: 50%; bottom: 14px; transform: translate(-50%, 14px);
            width: min(420px, calc(100% - 28px)); z-index: 10001;
            --dgc-surface: #fff; --dgc-sunk: #f1f5f4; --dgc-rule: #dde5e2;
            --dgc-ink: #141a18; --dgc-muted: #5b6b66; --dgc-faint: #8a9994; --dgc-accent: #136857;
            background: var(--dgc-surface); color: var(--dgc-ink);
            border: 1px solid var(--dgc-rule); border-radius: 18px; padding: 14px 16px 15px;
            box-shadow: 0 18px 48px -14px rgba(9, 30, 25, .38);
            display: flex; flex-direction: column; gap: 9px;
            font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
            opacity: 0; pointer-events: none;
            transition: opacity .18s ease, transform .2s cubic-bezier(.2,.8,.3,1);
        }
        #dgDlCard.show { opacity: 1; transform: translate(-50%, 0); }
        [data-bs-theme="dark"] #dgDlCard {
            --dgc-surface: #171f1d; --dgc-sunk: #101816; --dgc-rule: #27332f;
            --dgc-ink: #e8efec; --dgc-muted: #9aaba6; --dgc-faint: #6d7f7a; --dgc-accent: #3f9d86;
            box-shadow: 0 18px 48px -14px rgba(0, 0, 0, .65);
        }
        #dgDlCard .dgdl-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
        #dgDlCard .dgdl-title { font-size: 13.5px; font-weight: 600; }
        #dgDlCard .dgdl-pct {
            font-size: 13.5px; font-weight: 600; color: var(--dgc-accent);
            font-variant-numeric: tabular-nums;
        }
        #dgDlCard .dgdl-track {
            height: 6px; border-radius: 999px; background: var(--dgc-sunk); overflow: hidden;
        }
        #dgDlCard .dgdl-fill {
            height: 100%; width: 0; border-radius: 999px; background: var(--dgc-accent);
            transition: width .25s ease;
        }
        /* Before Content-Length is known there is no fraction to show, so the bar says "working"
           rather than lying about a position. */
        #dgDlCard.indeterminate .dgdl-fill {
            width: 35%; animation: dgDlSlide 1.1s ease-in-out infinite alternate;
        }
        @keyframes dgDlSlide { from { margin-left: 0; } to { margin-left: 65%; } }
        #dgDlCard .dgdl-sub {
            font-size: 11.5px; color: var(--dgc-muted); font-variant-numeric: tabular-nums;
        }
        #dgDlCard .dgdl-hint {
            font-size: 11.5px; line-height: 1.4; color: var(--dgc-faint);
            border-top: 1px solid var(--dgc-rule); padding-top: 8px; margin-top: 1px;
        }
        /* A failed download keeps the card, turned into the reason, until the reader dismisses
           it. It used to be a toast for nine seconds over a bar that then sat there forever
           saying "Downloading" — the one word that was no longer true. */
        #dgDlCard.failed { pointer-events: auto; }
        #dgDlCard.failed .dgdl-fill { background: #b3261e; width: 100%; }
        #dgDlCard.failed .dgdl-pct { color: #b3261e; }
        #dgDlCard .dgdl-actions { display: none; gap: 9px; margin-top: 2px; }
        #dgDlCard.failed .dgdl-actions { display: flex; }
        #dgDlCard .dgdl-actions button {
            flex: 1; font: inherit; font-size: 13px; font-weight: 600;
            padding: 9px 12px; border-radius: 11px; cursor: pointer;
            border: 1px solid var(--dgc-rule); background: transparent; color: var(--dgc-muted);
        }
        #dgDlCard .dgdl-actions .dgdl-retry { background: var(--dgc-accent); color: #fff; border-color: transparent; }
        @media (prefers-reduced-motion: reduce) {
            #dgConsent, #dgConsentSheet, #dgDlCard, #dgDlCard .dgdl-fill { transition: none; }
            #dgDlCard.indeterminate .dgdl-fill { animation: none; }
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

    // Owner: "очень хорошо было бы иметь прогресс бар загрузки". The download is 170MB — a line
    // of text saying "50%" gives no sense of whether it is moving, and this is the longest wait
    // the app ever asks anyone to sit through.
    var dlCard = null;
    var dlHideTimer = null;
    function ensureDlCard() {
        if (dlCard) return dlCard;
        dlCard = document.createElement('div');
        dlCard.id = 'dgDlCard';
        dlCard.setAttribute('role', 'status');
        dlCard.setAttribute('aria-live', 'polite');
        dlCard.innerHTML =
            '<div class="dgdl-head"><span class="dgdl-title"></span><span class="dgdl-pct"></span></div>' +
            '<div class="dgdl-track"><div class="dgdl-fill"></div></div>' +
            '<div class="dgdl-sub"></div>' +
            '<div class="dgdl-hint" hidden></div>' +
            '<div class="dgdl-actions">' +
              '<button type="button" class="dgdl-dismiss"></button>' +
              '<button type="button" class="dgdl-retry"></button>' +
            '</div>';
        dlCard.querySelector('.dgdl-dismiss').addEventListener('click', function () { hideCard(); });
        dlCard.querySelector('.dgdl-retry').addEventListener('click', function () {
            hideCard();
            // Wrapped below, so the new attempt's ending reaches this card too.
            if (typeof window.dgRetryOfflineDownload === 'function') window.dgRetryOfflineDownload();
        });
        document.body.appendChild(dlCard);
        return dlCard;
    }

    function hideCard() {
        if (!dlCard) return;
        dlCard.classList.remove('show');
        dlCard.classList.remove('failed');
    }

    // What the card says once the whole thing is over — either way. The progress events cannot
    // carry this: the last of them is "the bytes arrived", and the library is ready only after the
    // worker has opened and verified the file, or is not ready because it could not.
    function showCardResult(ok, message) {
        var ru = isRuLang();
        var card = ensureDlCard();
        clearTimeout(dlHideTimer);
        card.classList.remove('indeterminate');
        card.querySelector('.dgdl-hint').hidden = true;
        if (ok) {
            card.classList.remove('failed');
            card.querySelector('.dgdl-title').textContent = ru ? 'Библиотека готова' : 'Library ready';
            card.querySelector('.dgdl-pct').textContent = '100%';
            card.querySelector('.dgdl-fill').style.width = '100%';
            card.classList.add('show');
            dlHideTimer = setTimeout(hideCard, 2500);
            return;
        }
        card.classList.add('failed');
        card.querySelector('.dgdl-title').textContent = ru ? 'Не удалось скачать библиотеку' : 'Could not download the library';
        card.querySelector('.dgdl-pct').textContent = '';
        card.querySelector('.dgdl-sub').textContent = message || (ru ? 'неизвестная ошибка' : 'unknown error');
        card.querySelector('.dgdl-dismiss').textContent = ru ? 'Закрыть' : 'Dismiss';
        card.querySelector('.dgdl-retry').textContent = ru ? 'Повторить' : 'Retry';
        card.classList.add('show');
    }

    window.addEventListener('dg:dl-progress', function (e) {
        var detail = e.detail || {};
        var loaded = detail.loaded || 0;
        var total = detail.total || 0;
        var ru = isRuLang();
        var card = ensureDlCard();
        var pct = total ? Math.min(100, Math.round((loaded / total) * 100)) : null;

        // Two phases now, and they deserve different words: Android's DownloadManager brings the
        // file over the network (backgroundable, resumable, its own notification), then the worker
        // reads it into OPFS. The second is fast and local, and a reader watching a bar restart
        // from zero without being told why would reasonably think something went wrong.
        card.classList.remove('failed');
        var importing = detail.phase === 'import';
        var title = importing
            ? (ru ? 'Подготовка библиотеки' : 'Preparing the library')
            : (ru ? 'Загрузка офлайн-библиотеки' : 'Downloading the offline library');
        // DownloadManager queues before it runs, and pauses to wait for a connection.
        if (detail.waiting && !importing) title = ru ? 'Ожидание сети' : 'Waiting for the network';
        card.querySelector('.dgdl-title').textContent = title;
        card.querySelector('.dgdl-pct').textContent = pct === null ? '' : pct + '%';
        card.classList.toggle('indeterminate', pct === null);
        if (pct !== null) card.querySelector('.dgdl-fill').style.width = pct + '%';
        card.querySelector('.dgdl-sub').textContent = total
            ? (ru ? formatMb(loaded) + ' МБ из ' + formatMb(total) + ' МБ'
                  : formatMb(loaded) + ' MB of ' + formatMb(total) + ' MB')
            : (ru ? formatMb(loaded) + ' МБ' : formatMb(loaded) + ' MB');
        var hint = card.querySelector('.dgdl-hint');
        hint.textContent = (detail.native && !importing)
            ? (ru ? 'Можно свернуть приложение — загрузка продолжится, прогресс виден в шторке.'
                  : 'You can leave the app — the download continues, with progress in the shade.')
            : '';
        hint.hidden = !hint.textContent;
        card.classList.add('show');

        // The last progress event arrives when the stream ends, so completion is visible here
        // rather than needing its own signal from the worker.
        clearTimeout(dlHideTimer);
        // Only the import phase finishing means the library is usable; the download finishing is
        // the halfway point, and saying "done" there would be a lie the next bar contradicts.
        if (total && loaded >= total && (importing || !detail.native)) {
            card.querySelector('.dgdl-title').textContent = ru ? 'Библиотека готова' : 'Library ready';
            dlHideTimer = setTimeout(function () { card.classList.remove('show'); }, 2500);
        }
    });

    // app.js dispatches this (and awaits the resolve it carries) only when a download is
    // actually needed AND the connection isn't Wi-Fi — never on a fully-cached return visit.
    //
    // The figure comes from the published manifest, which app.js fetches before asking — so the
    // dialog states the file that is actually about to cross the connection, not a number compiled
    // in months ago.
    //
    // Two figures again: what crosses the connection and what the file occupies afterwards. The
    // published file is gzip-compressed now (build-app-db.js writes the .gz beside the .db, the
    // worker inflates it on the way into OPFS), so the two differ, and both matter — the first to
    // someone on mobile data, the second to someone short on storage. Both come from the manifest;
    // FALLBACK_MB is only for a server old enough to publish none.
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
        var storedMb = sizeMb((detail && detail.stored_bytes) || (detail && detail.bytes));
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
                    (ru ? 'Один файл, сжатый для передачи. Сейчас соединение не через Wi-Fi; загрузку можно отложить и запустить позже в Настройках. Если связь оборвётся, докачается с того же места.'
                        : 'One file, compressed for transfer. You are not on Wi-Fi right now; you can postpone this and start it later from Settings. If the connection drops, it resumes where it stopped.') +
                  '</p>' +
                  '<dl class="dgc-figures">' +
                    '<div class="dgc-fig"><dt>' + (ru ? 'Скачать' : 'Download') + '</dt>' +
                      '<dd>' + approx + mb + '<span>' + (ru ? 'МБ' : 'MB') + '</span></dd></div>' +
                    '<div class="dgc-fig"><dt>' + (ru ? 'На устройстве' : 'On device') + '</dt>' +
                      '<dd>' + approx + storedMb + '<span>' + (ru ? 'МБ' : 'MB') + '</span></dd></div>' +
                    '<div class="dgc-fig dgc-fig-wide"><dt>' + (ru ? 'Языки' : 'Languages') + '</dt>' +
                      '<dd>' + languageList(langs, ru) + '</dd></div>' +
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

    function watchReady(promise) {
        if (!promise || typeof promise.then !== 'function') return;
        promise.then(function () {
            // Nothing was ever shown — already fully cached, ready resolved near-instantly.
            // Stay silent, exactly as the owner asked ("полоска не должна даже мелькать").
            if (dlCard && dlCard.classList.contains('show')) showCardResult(true);
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

            // A failed download is the card, turned into the reason, with a retry — whether it
            // failed at 477MB or before the first byte. The reason is the one thing worth
            // reading, and a toast is gone before it is; the bar it used to leave behind said
            // "Downloading" forever, the one word that was no longer true.
            if (!declined) {
                showCardResult(false, err && err.message);
                return;
            }
            hideCard();

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
    watchReady(window.dgOfflineReady);

    // Settings' "Download now" and the update path go through dgRetryOfflineDownload /
    // dgUpdateOfflineData, which replace window.dgOfflineReady; each new attempt gets the same
    // ending as the first one.
    var realRetry = window.dgRetryOfflineDownload;
    if (typeof realRetry === 'function') {
        window.dgRetryOfflineDownload = function () {
            var p = realRetry.apply(this, arguments);
            watchReady(p);
            return p;
        };
    }
    var realUpdate = window.dgUpdateOfflineData;
    if (typeof realUpdate === 'function') {
        window.dgUpdateOfflineData = function () {
            var p = realUpdate.apply(this, arguments);
            watchReady(p);
            return p;
        };
    }
})();
