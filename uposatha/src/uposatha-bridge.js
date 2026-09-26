// Uposatha app-only additions to the site's calendar page.
//
// NOT part of the website. This file ships inside the Android app and MainActivity injects it into
// the page at document start (WebViewCompat.addDocumentStartJavaScript, with a WebViewListener
// re-inject on page load for WebViews older than Chrome 105). The app loads the site from the
// network — capacitor.config.json's server.url — so there is nothing bundled to patch; this reaches
// into the live page, and without the Capacitor runtime (the same page in a browser) it returns at
// once.
//
// The page draws its own app layer (?app=1: tabs, the Rate Us row, the version row). What is here is
// only what a page cannot do: the splash, the back button, the launcher shortcuts, the tab a
// shortcut asks for, and the rating invitation. The reminders themselves are the page's own
// (LocalNotifications, scheduled from uposatha-calendar.js); this file has no part in them.
(function () {
  'use strict';

  var Cap = window.Capacitor;
  if (!Cap || typeof Cap.getPlatform !== 'function' || Cap.getPlatform() !== 'android') return;

  // The launch splash and the "no connection" screen, pasted in from src/launch-screens.js by
  // uposatha/build.js; the splash goes up now, at document start, and leaves once the page has loaded.
  // @launch-screens (inlined from src/launch-screens.js by uposatha/build.js)
  if (window.dgLaunch) window.dgLaunch.splash('upo');

  var STORE_URL = 'https://play.google.com/store/apps/details?id=gift.dhamma.uposatha';
  // Set when the reader taps Rate Us (the page's own row, #up-rate) or "Rate" in the invitation: whoever
  // has tapped it is never invited again.
  var RATE_FLAG = 'dgRateUsTapped';
  var SHORTCUTS_MAX = 2;   // the launcher's menu holds four entries; the two static ones are declared in res/xml/shortcuts.xml

  var onCalendar = /^\/uposatha-calendar\/?$/.test(location.pathname);

  function isRu() {
    var l = document.documentElement.lang || '';
    if (!l) { try { l = localStorage.getItem('dhammaLanguage') || localStorage.getItem('siteLanguage') || ''; } catch (e) { /* no storage */ } }
    return /^ru/i.test(l || navigator.language || '');
  }

  // ---- the tab a launcher shortcut asks for ------------------------------------------------
  //
  // A shortcut opens /uposatha-calendar?app=1&tab=cal. The page keeps its current tab in
  // localStorage (dgUposathaTab, and dgUposathaView for the two views of the calendar) and reads it
  // when it starts, so setting it here, before the page's own scripts run, is all it takes.
  (function () {
    if (!onCalendar) return;
    var m = /[?&]tab=(home|list|cal|parts)\b/.exec(location.search);
    if (!m) return;
    try {
      localStorage.setItem('dgUposathaTab', m[1]);
      if (m[1] === 'list' || m[1] === 'cal') localStorage.setItem('dgUposathaView', m[1]);
    } catch (e) { /* no storage: the page opens on its last tab */ }
  })();

  // ---- launcher shortcuts: the next Uposatha days ------------------------------------------
  //
  // The page's own calendar code (UposathaCore, loaded by the page) works the days out for the
  // settings the reader made — time zone, scheme, place — which live in the page's localStorage.
  // Pushed when the page has loaded and again when the app goes to the background (the day may have
  // changed since); pushed even when empty, which is what clears an earlier run's entries.

  function store(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }

  function nextUposathas() {
    var C = window.UposathaCore;
    if (!C || typeof C.dataset !== 'function') return [];
    var lang = isRu() ? 'ru' : 'en';
    var tz = store('dgUposathaTz') || (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
    var sutta = store('dgUposathaSutta') !== '0';
    var loc = null;
    try { loc = JSON.parse(store('dgUposathaLoc')); } catch (e) { /* no place set */ }
    var today = C.localDay(new Date(), tz);
    var data = C.dataset(C.ymdAdd(today, -1), C.ymdAdd(today, 75), { tz: tz, sutta: sutta, loc: loc });
    var names = C.NAMES[lang];
    var out = [];
    data.rows.forEach(function (r) {
      if (out.length >= SHORTCUTS_MAX || !r.uposatha || r.ymd < today) return;
      var parts = r.ymd.split('-').map(Number);
      var date = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
      var day = new Intl.DateTimeFormat(lang, { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(date);
      // Short: the launcher clips a label at ~25 characters. By the suttas the days themselves ("Day 14/15",
      // "14/15-й день"), in the modern scheme the phase ("Full moon").
      var kind = '';
      try {
        var nums = sutta && r.names ? r.names.map(C.dayNo) : [];
        kind = nums.length ? (lang === 'ru' ? nums.join('/') + '-й день' : 'Day ' + nums.join('/')) : C.nameOf(names, r, sutta);
      } catch (e) { /* the date alone will do */ }
      out.push({
        id: 'dg-uposatha-' + out.length,
        label: kind ? day + ' · ' + kind : day,
        route: '/uposatha-calendar?app=1&tab=list',
        icon: 'shortcut_moon',
        rank: 10 + out.length
      });
    });
    return out;
  }

  function pushShortcuts() {
    var plugin = Cap.Plugins && Cap.Plugins.DgShortcuts;
    if (!plugin || typeof plugin.set !== 'function') return;
    var items = [];
    try { items = nextUposathas(); } catch (e) { console.log('[dg-uposatha-shortcuts] failed to work out the days:', (e && e.message) || e); }
    Promise.resolve(plugin.set({ items: items })).catch(function (e) {
      console.log('[dg-uposatha-shortcuts] set failed:', (e && e.message) || e);
    });
  }

  // ---- Back --------------------------------------------------------------------------------
  //
  // Capacitor's default with no listener is a bare WebView.goBack() and nothing else: on the
  // page's first screen Back does nothing at all. Steps, in order: the rating sheet; the settings
  // drawer; any tab but the first goes back to the first; browser history; leave the app.
  function wireBackButton() {
    var App = Cap.Plugins && Cap.Plugins.App;
    if (!App || typeof App.addListener !== 'function') return;
    App.addListener('backButton', function (ev) {
      if (closeRatePrompt()) return;
      if (document.body.classList.contains('dg-drawer-open')) {
        var close = document.querySelector('#dg-drawer .dg-drawer-close');
        if (close) { close.click(); return; }
      }
      var tab = document.body.getAttribute('data-app-tab');
      if (tab && tab !== 'home') {
        var home = document.querySelector('#appnav [data-tab="home"]');
        if (home) { home.click(); return; }
      }
      if (ev && ev.canGoBack) { window.history.back(); return; }
      App.exitApp();
    });
  }

  function rateUsUrl() { return STORE_URL; }
  // The calendar page only: the invitation must not appear on a page of the site the app merely
  // passed through (a shortcut can open dhamma.gift/4as inside this WebView).
  var RATE_HOME = /^\/uposatha-calendar\/?$/;

  // @rate-prompt (inlined from src/native-bridge.js by uposatha/build.js)

  function start() {
    if (!onCalendar) { wireBackButton(); return; }
    wireBackButton();
    // The page's own Rate Us row: note the tap, so the invitation never asks someone who has been.
    document.addEventListener('click', function (e) {
      var a = e.target && e.target.closest && e.target.closest('#up-rate');
      if (a) { try { localStorage.setItem(RATE_FLAG, '1'); } catch (err) { /* no storage */ } }
    }, true);
    // UposathaCore is loaded by the page: give it until the page has finished loading.
    if (document.readyState === 'complete') pushShortcuts();
    else window.addEventListener('load', pushShortcuts, { once: true });
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') pushShortcuts(); });
    maybeAskForRating();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
