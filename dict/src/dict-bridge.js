// Dict.Dhamma.Gift app-only additions to the site's burger menu.
//
// NOT part of the website. This file ships inside the Android app and MainActivity injects it into
// https://dict.dhamma.gift at document start (WebViewCompat.addDocumentStartJavaScript, with a
// WebViewListener re-inject on page load for WebViews older than Chrome 105). The app loads the
// site from the network — capacitor.config.json's server.url — so there is no bundled copy of the
// page to patch the way dg-app-full patches its own; this patches the live DOM instead, and every
// row it adds disappears when the same page is opened in a browser, because without the Capacitor
// runtime it returns at once.
//
// Owner, 2026-09-24 ("нет истории в шорткатах... опцию вкл выкл... версию приложения... и Rate
// Us"): the TWA could do none of this. Its launcher entries were whatever the web manifest
// declared (no history at all, and a web manifest's shortcuts are static), it could not tell the
// reader which build they were running, and it had no way to reach the store listing.
(function () {
  'use strict';

  var Cap = window.Capacitor;
  if (!Cap || typeof Cap.getPlatform !== 'function' || Cap.getPlatform() !== 'android') return;

  // Same flag name dg-app-full uses for its own switch. Different origin, so no collision — and
  // the same default: anything but 'off' means on.
  var SHORTCUTS_FLAG = 'dgDynamicShortcuts';
  var SHORTCUTS_MAX = 3;
  // The Play listing for this app id. https rather than market://: play.google.com is an App Link,
  // so Android opens the Play app when it is installed and a browser when it is not, while a
  // market:// intent fails outright on a device without Play.
  var STORE_URL = 'https://play.google.com/store/apps/details?id=gift.dhamma.pali';
  // Set when the reader taps Rate Us. This is NOT what hides the row — the row is permanent (owner:
  // "пункт никуда не нужно скрывать он остаётся на месте"), and tapping a store link is not proof
  // that a review was written. What it is for is the invitation we have not built yet, in this app
  // or in the reader one ("приглашение поставить нам 5 звёзд"): whoever already tapped it should
  // never be asked by that prompt. Kept as a flag now so the prompt has an answer ready on the day
  // it exists.
  var RATE_FLAG = 'dgRateUsTapped';
  // The invite itself, as three emoji at one size: the owner asked for "5⃣⭐🙏" and then for all of
  // it to be emoji and the same size, because a masked glyph next to the 🙏 rendered visibly
  // smaller (emoji are drawn with their own metrics, so mixing the two cannot be made to match).
  // Emoji need no colour or artwork of ours, which is why this replaced the inlined solid star.
  var RATE_LABEL = '5️⃣⭐️🙏';
  // Smaller than the site's own action buttons at 11.5px would be unreadable and larger reads as a
  // second toggle: the owner's second pass was "нужно чтобы они были помельче, сейчас это крупнее
  // чем переключатели даже" (the switch is 22px tall). Emoji render taller than their font size, so
  // this sits visibly below the switch rather than beside it.
  var RATE_LABEL_SIZE = '16px';

  function isRu() { return document.documentElement.lang === 'ru'; }

  var T = {
    en: {
      group: 'App',
      shortcuts: 'Recent words in app shortcuts',
      version: 'App version',
      rate: 'Rate Us',
      rateNote: 'Open the store page and leave a review.'
    },
    ru: {
      group: 'Приложение',
      shortcuts: 'Недавние слова в ярлыках',
      version: 'Версия приложения',
      rate: 'Оценить приложение',
      rateNote: 'Открыть страницу в магазине и оставить отзыв.'
    }
  };

  // ---- launcher shortcuts ----------------------------------------------------------------

  function shortcutsOn() { return localStorage.getItem(SHORTCUTS_FLAG) !== 'off'; }

  function readJson(key) {
    try { return JSON.parse(localStorage.getItem(key)) || []; } catch (e) { return []; }
  }

  function readHistory() { return readJson('history-list'); }

  // The site's own URL builder, so a shortcut opens the same address the history entry does
  // (including the /ru/ prefix and ?lang=ru). Only if it is missing does this fall back to the
  // plain path.
  function routeFor(word) {
    if (typeof window.dictUrl === 'function') {
      try { return window.dictUrl(word); } catch (e) { /* fall through to the plain path */ }
    }
    return '/' + encodeURIComponent(word);
  }

  // The three entries the switch turns off when it is on. They used to be static shortcuts in
  // res/xml/shortcuts.xml, and three statics there cost exactly the slots the history needs: the
  // launcher counts DECLARED shortcuts against its four-entry menu even when they are disabled at
  // runtime, which is why the reader app shows three "recently read" entries and this app showed
  // two. One static (Favorites & History) plus these three as dynamic is four either way.
  // Each carries the drawable it had while it was static (res/drawable-*/shortcut_N.png, the same
  // files the TWA used — see the plugin's iconFor): a dynamic shortcut must be handed an icon, and
  // without this every entry got the app's own mark, which is the owner's report that the
  // programmed entries looked exactly like the recent words.
  var PROGRAMMED = [
    { id: 'toc', label: 'Table of Contents', route: 'https://dhamma.gift/toc', icon: 'shortcut_0' },
    { id: 'dharmamitra', label: 'Dharmamitra.org', route: 'https://dharmamitra.org/', icon: 'shortcut_2' },
    { id: 'aksharamukha', label: 'Aksharamukha.com', route: 'https://www.aksharamukha.com/converter', icon: 'shortcut_3' }
  ];

  // The words that make it into the launcher. One function so the menu row's own note and the list
  // handed to the plugin can never disagree.
  //
  // History only — the owner was explicit (2026-09-24: "не нужно брать избранное. в словаре только
  // история слов"): favourites are a different errand and have their own entry in the menu above.
  // The reader app mixes the two because its history is a list of texts it can rank; the dictionary
  // has one list, and it is this one.
  function collectShortcuts() {
    if (!shortcutsOn()) {
      return PROGRAMMED.map(function (p, i) {
        return { id: 'dg-dict-programmed-' + p.id, label: p.label, route: p.route, icon: p.icon, rank: i };
      });
    }
    var items = [];
    var seen = {};
    readHistory().forEach(function (word) {
      if (items.length >= SHORTCUTS_MAX) return;
      if (typeof word !== 'string' || !word) return;
      var route = routeFor(word);
      if (!route || seen[route]) return;
      seen[route] = 1;
      items.push({ id: 'dg-dict-' + items.length, label: word, route: route, rank: 10 + items.length });
    });
    return items;
  }

  // The row's note carries the CURRENT number, not just the cap. The owner installed a build,
  // long-pressed the icon and counted two entries where the set holds three; without this the
  // difference between "the history has two words" and "the launcher dropped one" is invisible from
  // the outside, and both look like the same bug from a screenshot. `accepted` is what the plugin
  // reports back after Android has taken the list — shown only when it disagrees with what was sent.
  function shortcutsNote(sent, accepted) {
    var base = isRu()
      ? 'До ' + SHORTCUTS_MAX + ' слов в меню долгого нажатия на значок приложения.'
      : 'Up to ' + SHORTCUTS_MAX + ' words in the long-press menu of the app icon.';
    // With the switch off the menu holds the programmed set, not words, so the count means nothing
    // there — the sentence would be describing a list that is not on screen.
    if (!shortcutsOn()) return base;
    var tail = (accepted == null || accepted === sent) ? '' : (isRu() ? ' (ярлыков ' + accepted + ')' : ' (shortcuts ' + accepted + ')');
    return base + (isRu() ? ' Сейчас: ' : ' Right now: ') + sent + tail + '.';
  }

  function pushShortcuts() {
    var items = collectShortcuts();
    var note = document.getElementById('dg-shortcuts-note');
    if (note) note.textContent = shortcutsNote(items.length);
    var plugin = Cap.Plugins && Cap.Plugins.DgShortcuts;
    if (!plugin || typeof plugin.set !== 'function') return; // plugin missing: nothing to do
    // Pushed even when empty ON PURPOSE: that is what clears the entries an earlier run left in
    // the launcher (dg-app-full learned this the hard way). No "programmed" flag any more: the one
    // static shortcut is always visible and never disabled, and everything else is this list.
    Promise.resolve(plugin.set({ items: items })).then(function (result) {
      // DgShortcutsPlugin resolves with the number of shortcuts it actually built. A smaller number
      // than we sent means Android refused some of them, and that is worth saying out loud rather
      // than leaving the reader to count entries in the launcher.
      var accepted = result && typeof result.count === 'number' ? result.count : null;
      if (note && accepted != null && accepted !== items.length) note.textContent = shortcutsNote(items.length, accepted);
    }).catch(function (e) {
      console.log('[dg-dict-shortcuts] set failed:', (e && e.message) || e);
    });
  }

  // ---- burger menu rows ------------------------------------------------------------------

  function row(id, title, note, noteId) {
    var el = document.createElement('div');
    el.className = 'set';
    el.id = id;
    var lb = document.createElement('span');
    lb.className = 'lb';
    lb.textContent = title;
    if (note) {
      var em = document.createElement('em');
      if (noteId) em.id = noteId;
      em.textContent = note;
      lb.appendChild(em);
    }
    el.appendChild(lb);
    return el;
  }

  function buildRows(t) {
    var out = [];

    var grp = document.createElement('div');
    grp.className = 'grp';
    grp.id = 'dg-app-grp';
    grp.textContent = t.group;
    out.push(grp);

    var sc = row('dg-shortcuts-row', t.shortcuts, shortcutsNote(collectShortcuts().length), 'dg-shortcuts-note');
    var box = document.createElement('input');
    box.className = 'sw';
    box.type = 'checkbox';
    box.id = 'dg-shortcuts-toggle';
    box.checked = shortcutsOn();
    box.addEventListener('change', function () {
      localStorage.setItem(SHORTCUTS_FLAG, box.checked ? 'on' : 'off');
      pushShortcuts();
    });
    sc.appendChild(box);
    out.push(sc);

    // Rate Us sits ABOVE the version, and the version closes the menu — the owner's own rule
    // (2026-09-24): "версия же обычно последний пункт". The row itself is PERMANENT: it stays after
    // a tap (owner: "пункт никуда не нужно скрывать он остаётся на месте").
    var rate = row('dg-rate-row', t.rate, t.rateNote);
    // A real link, not a plugin call: navigating the top frame to the store host is what Capacitor
    // turns into "hand this to Play" (shouldOverrideUrlLoading -> launchIntent), and a Browser
    // plugin call is what did nothing in the main application's equivalent row (owner, 2026-09-25:
    // "не работает кнопка rate us... не открывается store").
    var btn = document.createElement('a');
    btn.className = 'rb act';
    btn.id = 'dg-rate-btn';
    btn.href = STORE_URL;
    btn.target = '_top';
    btn.rel = 'noopener';
    // "5️⃣⭐️🙏", not the word "rate" (owner: "может вместо ⭐rate? А то там rate итак написано в
    // rate us"), and all three emoji at one size (owner: "сделай [их] в виде эмодзи и чтобы они
    // были одного размера, сейчас руки как будто больше" — a masked star next to an emoji cannot
    // be made to match, emoji carry their own metrics).
    btn.style.fontSize = RATE_LABEL_SIZE;
    btn.appendChild(document.createTextNode(RATE_LABEL));
    btn.addEventListener('click', function () {
      // Only a note for the future invitation (RATE_FLAG above) — no preventDefault, the
      // navigation is what opens the store. The row itself stays where it is.
      try { localStorage.setItem(RATE_FLAG, '1'); } catch (e) { /* private mode: the prompt asks later */ }
    });
    rate.appendChild(btn);
    out.push(rate);

    // Filled from the value MainActivity prepends to this script (versionName + versionCode), so
    // the row never depends on the site knowing anything about the app. Last row on purpose.
    var ver = row('dg-version-row', t.version, window.__DG_APP_VERSION__ || '');
    out.push(ver);

    return out;
  }

  function inject() {
    var pb = document.querySelector('#p-menu .pb');
    if (!pb || document.getElementById('dg-app-grp')) return false;
    // At the very end of the panel, after the site's own "Data" section — the owner asked for the
    // new rows at the bottom of the menu.
    buildRows(T[isRu() ? 'ru' : 'en']).forEach(function (el) { pb.appendChild(el); });
    return true;
  }

  // The site records every lookup through this one global (extra.js, loaded after this script, so
  // this can only be wired from start()). Wrapping it is how the launcher hears about a new word
  // the moment it is looked up, instead of at whatever app-state change comes next: the owner
  // looked up words, long-pressed the icon and still saw two entries, which is exactly what a push
  // that happened once at page load looks like.
  function watchHistory() {
    if (typeof window.addToHistory !== 'function' || window.addToHistory.__dgWrapped) return;
    var original = window.addToHistory;
    var wrapped = function () {
      var result = original.apply(this, arguments);
      pushShortcuts();
      return result;
    };
    wrapped.__dgWrapped = true;
    window.addToHistory = wrapped;
  }

  // Back (Android's gesture / button). Capacitor's default with NO listener is a bare
  // WebView.goBack() and nothing else: from the dictionary's home screen a reader presses back and
  // the app just sits there, and with a panel open it does not close either. The reader app wires
  // the same three steps for the same reason (src/native-bridge.js, its quick modal).
  function wireBackButton() {
    var App = Cap.Plugins && Cap.Plugins.App;
    if (!App || typeof App.addListener !== 'function') return;
    App.addListener('backButton', function (ev) {
      // The burger/history panel is an overlay, so closing it is what "back" means while it is up.
      var open = document.querySelector('.panel[data-open="true"]');
      if (open && typeof window.closePanels === 'function') { window.closePanels(); return; }
      if (ev && ev.canGoBack) { window.history.back(); return; }
      App.exitApp();
    });
  }

  // -----------------------------------------------------------------------------------------
  // The rating invitation (owner, 2026-09-25 — the same sheet the main application shows;
  // mockups agreed first: docs/rate-prompt/)
  // -----------------------------------------------------------------------------------------
  // Day 60 after the FIRST RUN, once more on day 180 if "later" was chosen, never after that, and
  // never at all once Rate Us has been tapped. Days count from the first run, not the install: an
  // app cannot read its install date, and the sheet only exists in a process that has run.
  var RATE_FIRST_RUN = 'dgFirstRunAt';
  var RATE_SHOWN = 'dgRatePromptShown';   // absent/'0' = never shown, '1' = day-60 done, '2' = done
  var RATE_DAY_FIRST = 60;
  var RATE_DAY_LAST = 180;

  // The offline-library download consent's design, with its own styles rather than the offline
  // layer's classes: these pages are the live dictionary site's and carry no such stylesheet.
  var RATE_PROMPT_CSS = [
    '#dgrAsk{position:fixed;inset:0;z-index:10002;display:flex;align-items:flex-end;justify-content:center;',
    'background:rgba(8,20,17,.5);opacity:0;transition:opacity .18s ease}',
    '#dgrAsk.show{opacity:1}',
    '#dgrAsk .dgr-sheet{--s:#fff;--sunk:#f1f5f4;--rule:#dde5e2;--ink:#141a18;--muted:#5b6b66;--faint:#8a9994;--accent:#136857;',
    'width:min(420px,calc(100% - 28px));margin:0 0 14px;background:var(--s);color:var(--ink);',
    'border:1px solid var(--rule);border-radius:20px;padding:20px 18px 16px;box-shadow:0 24px 64px -16px rgba(9,30,25,.45);',
    'display:flex;flex-direction:column;gap:12px;transform:translateY(14px);transition:transform .2s cubic-bezier(.2,.8,.3,1);',
    'font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}',
    '#dgrAsk.show .dgr-sheet{transform:translateY(0)}',
    '[data-bs-theme="dark"] #dgrAsk .dgr-sheet,body.dark-mode #dgrAsk .dgr-sheet{--s:#171f1d;--sunk:#101816;--rule:#27332f;',
    '--ink:#e8efec;--muted:#9aaba6;--faint:#6d7f7a;--accent:#3f9d86;box-shadow:0 24px 64px -16px rgba(0,0,0,.7)}',
    '#dgrAsk .dgr-eyebrow{font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;font-weight:600;color:var(--accent)}',
    '#dgrAsk .dgr-stars{font-size:26px;line-height:1;letter-spacing:3px;color:#f5c518}',
    '#dgrAsk .dgr-title{margin:0;font-size:17px;font-weight:600;line-height:1.3}',
    '#dgrAsk .dgr-body{margin:0;font-size:13.5px;line-height:1.45;color:var(--muted)}',
    '#dgrAsk .dgr-figs{display:grid;grid-template-columns:1fr 1fr;gap:1px;margin:0;background:var(--rule);',
    'border:1px solid var(--rule);border-radius:14px;overflow:hidden}',
    '#dgrAsk .dgr-fig{background:var(--sunk);padding:10px 12px}',
    '#dgrAsk .dgr-fig dt{font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--faint);margin:0 0 2px}',
    '#dgrAsk .dgr-fig dd{margin:0;font-size:13.5px;font-weight:500;line-height:1.35;color:var(--ink)}',
    '#dgrAsk .dgr-fig-wide{grid-column:1/-1}',
    '#dgrAsk .dgr-actions{display:flex;gap:9px;margin-top:2px}',
    '#dgrAsk .dgr-actions button,#dgrAsk .dgr-actions a{flex:1;font:inherit;font-size:14px;font-weight:600;padding:11px 14px;',
    'border-radius:13px;cursor:pointer;border:1px solid transparent;text-align:center;text-decoration:none;',
    'display:flex;align-items:center;justify-content:center;transition:background .16s ease,border-color .16s ease}',
    '#dgrAsk .dgr-ghost{background:transparent;border-color:var(--rule);color:var(--muted)}',
    '#dgrAsk .dgr-primary{background:var(--accent);color:#fff}',
    '#dgrAsk button:focus-visible,#dgrAsk a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}',
  ].join('');

  function ratePromptCopy(ru) {
    return {
      eyebrow: ru ? 'Оценить приложение' : 'Rate this app',
      title: ru ? 'Как вам Dhamma.Gift?' : 'How is Dhamma.Gift for you?',
      body: ru
        ? 'Нам важно ваше мнение: по обратной связи мы понимаем, что вам нравится, а что улучшить. Рейтинг и комментарии помогают приложению.'
        : 'Your opinion matters to us: feedback tells us what you like and what to improve. Ratings and comments help the app.',
      figs: ru
        ? [['Займёт', '30 сек – 2 мин'], ['Где', 'Google Play'], ['Что оставить', 'звёзды и комментарий']]
        : [['Takes', '30 sec – 2 min'], ['Where', 'Google Play'], ['What to leave', 'stars and a comment']],
      later: ru ? 'Позже' : 'Later',
      laterLast: ru ? 'Не спрашивать' : "Don't ask",
      go: ru ? 'Оценить' : 'Rate',
    };
  }

  // 0 = nothing due (too early, or finished with), 1 = the day-60 showing, 2 = the day-180 one.
  function ratePromptDue(now) {
    try {
      if (localStorage.getItem(RATE_FLAG) === '1') return 0;
      var first = parseInt(localStorage.getItem(RATE_FIRST_RUN) || '0', 10);
      if (!first) {
        localStorage.setItem(RATE_FIRST_RUN, String(now));
        return 0;
      }
      var shown = parseInt(localStorage.getItem(RATE_SHOWN) || '0', 10);
      var days = (now - first) / 86400000;
      if (shown === 0 && days >= RATE_DAY_FIRST) return 1;
      if (shown === 1 && days >= RATE_DAY_LAST) return 2;
    } catch (e) { /* private mode: no storage, no prompt */ }
    return 0;
  }

  function showRatePrompt(showing) {
    if (document.getElementById('dgrAsk')) return;
    var t = ratePromptCopy(isRu());
    var style = document.createElement('style');
    style.textContent = RATE_PROMPT_CSS;
    document.head.appendChild(style);

    var figs = t.figs.map(function (f, i) {
      return '<div class="dgr-fig' + (i === t.figs.length - 1 ? ' dgr-fig-wide' : '') + '">'
        + '<dt>' + f[0] + '</dt><dd>' + f[1] + '</dd></div>';
    }).join('');
    var overlay = document.createElement('div');
    overlay.id = 'dgrAsk';
    overlay.innerHTML =
      '<div class="dgr-sheet" role="alertdialog" aria-modal="true" aria-labelledby="dgrTitle">'
      + '<div class="dgr-eyebrow">' + t.eyebrow + '</div>'
      + '<div class="dgr-stars" aria-hidden="true">★★★★★</div>'
      + '<p class="dgr-title" id="dgrTitle">' + t.title + '</p>'
      + '<p class="dgr-body">' + t.body + '</p>'
      + '<dl class="dgr-figs">' + figs + '</dl>'
      + '<div class="dgr-actions">'
      + '<button type="button" class="dgr-ghost">' + (showing === 2 ? t.laterLast : t.later) + '</button>'
      + '<a class="dgr-primary" href="' + STORE_URL + '" target="_top" rel="noopener">' + t.go + '</a>'
      + '</div></div>';
    document.body.appendChild(overlay);
    requestAnimationFrame(function () { overlay.classList.add('show'); });

    var settled = false;
    function close(mark) {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey, true);
      try { localStorage.setItem(RATE_SHOWN, mark); } catch (e) { /* private mode */ }
      overlay.classList.remove('show');
      setTimeout(function () { overlay.remove(); }, 200);
    }
    function onKey(ev) {
      if (ev.key === 'Escape') { ev.preventDefault(); close(showing === 2 ? '2' : '1'); }
    }
    overlay.addEventListener('click', function (ev) { if (ev.target === overlay) close(showing === 2 ? '2' : '1'); });
    overlay.querySelector('.dgr-ghost').addEventListener('click', function () { close(showing === 2 ? '2' : '1'); });
    document.addEventListener('keydown', onKey, true);
    overlay.querySelector('.dgr-primary').addEventListener('click', function () {
      // No preventDefault: the top-frame navigation is what opens the store (see the Rate Us row).
      try { localStorage.setItem(RATE_FLAG, '1'); } catch (e) { /* private mode */ }
      close('2');
    });
    var primary = overlay.querySelector('.dgr-primary');
    if (primary && primary.focus) primary.focus();
  }

  function maybeAskForRating() {
    // Only the dictionary's own first screen: a nudge in the middle of a word entry is the reason
    // these things get a bad name.
    if (!/\/(index\.html)?$/.test(location.pathname)) return;
    var showing = ratePromptDue(Date.now());
    if (showing) setTimeout(function () { showRatePrompt(showing); }, 1500);
  }

  function start() {
    inject();
    watchHistory();
    wireBackButton();
    pushShortcuts();
    maybeAskForRating();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  // Backgrounding the app. The App plugin's own event when it is there, and the page's visibility
  // as well: either can be the only one that fires on a given device, and a menu that lags one
  // lookup behind is what a missed push looks like.
  var App = Cap.Plugins && Cap.Plugins.App;
  if (App && typeof App.addListener === 'function') {
    App.addListener('appStateChange', function (state) { if (!state.isActive) pushShortcuts(); });
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') pushShortcuts();
  });
  window.addEventListener('pagehide', pushShortcuts);
  // The reader app's own belt (src/native-bridge.js): the first visit of a session has nothing in
  // history yet, so an app-state change is the only thing that would ever push — and if that event
  // never arrives, the launcher stays empty for the whole session. One delayed push costs nothing.
  setTimeout(pushShortcuts, 4000);
})();
