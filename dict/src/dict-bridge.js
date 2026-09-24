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

    // Filled from the value MainActivity prepends to this script (versionName + versionCode), so
    // the row never depends on the site knowing anything about the app.
    var ver = row('dg-version-row', t.version, window.__DG_APP_VERSION__ || '');
    out.push(ver);

    var rate = row('dg-rate-row', t.rate, t.rateNote);
    var btn = document.createElement('button');
    btn.className = 'rb act';
    btn.type = 'button';
    btn.id = 'dg-rate-btn';
    // Same shape as the site's own action buttons (a glyph, then the label) so the row does not
    // look bolted on.
    var glyph = document.createElement('i');
    glyph.className = 'gi i-fa-arrow-up-right-from-square';
    btn.appendChild(glyph);
    btn.appendChild(document.createTextNode(t.rateBtn));
    btn.addEventListener('click', function () { openExternal(STORE_URL); });
    rate.appendChild(btn);
    out.push(rate);

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

  function start() {
    inject();
    pushShortcuts();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  // The history is only complete once the reader is done with the app, and pushing on every lookup
  // would rewrite the launcher menu constantly.
  var App = Cap.Plugins && Cap.Plugins.App;
  if (App && typeof App.addListener === 'function') {
    App.addListener('appStateChange', function (state) { if (!state.isActive) pushShortcuts(); });
  }
  window.addEventListener('pagehide', pushShortcuts);
})();
