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
  // The one coloured glyph in the menu, on the owner's request: the Rate Us row should read as a
  // different kind of thing from the switches around it. A plain amber yellow, legible on both the
  // dark (--dg-page #111111) and the light (#ffffff) page.
  var RATE_STAR_COLOR = '#f5c518';
  // The FILLED star. The site's own icons/star.svg is the outline glyph (it carries the inner
  // cut-out subpath), and the owner asked for "жёлтую звёздочку с полной заливкой" — a solid one.
  // This is Font Awesome Free 6's solid star, the same artwork as dg-node's
  // overrides/svg/solid-star.svg, inlined as a mask here: on dict.dhamma.gift that file sits on a
  // path this script cannot count on, and one inline path is not worth a second request.
  // Font Awesome Free 6 — Icons: CC BY 4.0, https://fontawesome.com/license/free
  var STAR_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 576 512"><path d="M316.9 18C311.6 7 300.4 0 288.1 0s-23.4 7-28.8 18L195 150.3 51.4 171.5c-12 1.8-22 10.2-25.7 21.7s-.7 24.2 7.9 32.7L137.8 329 113.2 474.7c-2 12 3 24.2 12.9 31.3s23 8 33.8 2.3l128.3-68.5 128.3 68.5c10.8 5.7 23.9 4.9 33.8-2.3s14.9-19.3 12.9-31.3L438.5 329 542.7 225.9c8.6-8.5 11.7-21.2 7.9-32.7s-13.7-19.9-25.7-21.7L381.2 150.3 316.9 18z"/></svg>';
  // The site's .gi class paints currentColor through whatever --u holds, so setting --u on the
  // element reuses that plumbing instead of duplicating the mask properties.
  var RATE_STAR_MASK = 'url("data:image/svg+xml,' + encodeURIComponent(STAR_SVG) + '")';

  function isRu() { return document.documentElement.lang === 'ru'; }

  var T = {
    en: {
      group: 'App',
      shortcuts: 'Recent words in app shortcuts',
      shortcutsNote: 'Up to ' + SHORTCUTS_MAX + ' words in the long-press menu of the app icon.',
      version: 'App version',
      rate: 'Rate Us',
      rateNote: 'Open the store page and leave a review.',
      rateBtn: 'rate'
    },
    ru: {
      group: 'Приложение',
      shortcuts: 'Недавние слова в ярлыках',
      shortcutsNote: 'До ' + SHORTCUTS_MAX + ' слов в меню долгого нажатия на значок приложения.',
      version: 'Версия приложения',
      rate: 'Оценить приложение',
      rateNote: 'Открыть страницу в магазине и оставить отзыв.',
      rateBtn: 'оценить'
    }
  };

  function openExternal(url) {
    var Browser = Cap.Plugins && Cap.Plugins.Browser;
    if (Browser && typeof Browser.open === 'function') { Browser.open({ url: url }); return; }
    window.open(url, '_blank');
  }

  // ---- launcher shortcuts ----------------------------------------------------------------

  function shortcutsOn() { return localStorage.getItem(SHORTCUTS_FLAG) !== 'off'; }

  function readHistory() {
    try { return JSON.parse(localStorage.getItem('history-list')) || []; } catch (e) { return []; }
  }

  // The site's own URL builder, so a shortcut opens the same address the history entry does
  // (including the /ru/ prefix and ?lang=ru). Only if it is missing does this fall back to the
  // plain path.
  function routeFor(word) {
    if (typeof window.dictUrl === 'function') {
      try { return window.dictUrl(word); } catch (e) { /* fall through to the plain path */ }
    }
    return '/' + encodeURIComponent(word);
  }

  function pushShortcuts() {
    var plugin = Cap.Plugins && Cap.Plugins.DgShortcuts;
    if (!plugin || typeof plugin.set !== 'function') return; // plugin missing: nothing to do
    var on = shortcutsOn();
    var items = [];
    if (on) {
      var seen = {};
      readHistory().forEach(function (word) {
        if (items.length >= SHORTCUTS_MAX) return;
        if (typeof word !== 'string' || !word) return;
        var route = routeFor(word);
        if (!route || seen[route]) return;
        seen[route] = 1;
        items.push({ id: 'dg-dict-' + items.length, label: word, route: route, rank: 10 + items.length });
      });
    }
    // Pushed even when empty ON PURPOSE: that is what clears the entries an earlier run left in
    // the launcher (dg-app-full learned this the hard way).
    Promise.resolve(plugin.set({ items: items, programmed: !on })).catch(function (e) {
      console.log('[dg-dict-shortcuts] set failed:', (e && e.message) || e);
    });
  }

  // ---- burger menu rows ------------------------------------------------------------------

  function row(id, title, note) {
    var el = document.createElement('div');
    el.className = 'set';
    el.id = id;
    var lb = document.createElement('span');
    lb.className = 'lb';
    lb.textContent = title;
    if (note) {
      var em = document.createElement('em');
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

    var sc = row('dg-shortcuts-row', t.shortcuts, t.shortcutsNote);
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
    // (2026-09-24): "версия же обычно последний пункт".
    var rate = row('dg-rate-row', t.rate, t.rateNote);
    var btn = document.createElement('button');
    btn.className = 'rb act';
    btn.type = 'button';
    btn.id = 'dg-rate-btn';
    // A filled star, painted yellow instead of inheriting the button's grey: the owner asked for
    // this one row to stand out from the rest of the menu (see RATE_STAR_MASK above for why the
    // glyph is inlined rather than the site's own i-star).
    var glyph = document.createElement('i');
    glyph.className = 'gi';
    glyph.id = 'dg-rate-star';
    glyph.style.color = RATE_STAR_COLOR;
    glyph.style.setProperty('--u', RATE_STAR_MASK);
    btn.appendChild(glyph);
    btn.appendChild(document.createTextNode(t.rateBtn));
    btn.addEventListener('click', function () { openExternal(STORE_URL); });
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

  function start() {
    inject();
    watchHistory();
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
})();
