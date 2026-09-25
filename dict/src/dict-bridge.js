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

  function start() {
    inject();
    watchHistory();
    wireBackButton();
    pushShortcuts();
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
