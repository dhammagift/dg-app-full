// Uposatha app-only additions to the site's calendar page.
//
// NOT part of the website. This file ships inside the Android app and MainActivity injects it into
// the page at document start (WebViewCompat.addDocumentStartJavaScript, with a WebViewListener
// re-inject on page load for WebViews older than Chrome 105). The page is bundled in the APK (www/ is
// a snapshot of the site's calendar page, taken at build time), so there is nothing to patch at build
// time; this reaches into the running page, and without the Capacitor runtime (the same page in a
// browser) it returns at once.
//
// The page draws its own app layer (?app=1: tabs, the Rate Us row, the version row). What is here is
// only what a page cannot do: the back button, the launcher shortcuts, the tab a shortcut asks for,
// the sound source, keeping the bundled page up to date, and the rating invitation. The reminders themselves are the page's own
// (LocalNotifications, scheduled from uposatha-calendar.js); this file has no part in them.
(function () {
  'use strict';

  var Cap = window.Capacitor;
  if (!Cap || typeof Cap.getPlatform !== 'function' || Cap.getPlatform() !== 'android') return;

  // The launch splash is native on Android (the animated mark of the system splash screen, res/drawable/
  // dg_splash_icon.xml), so nothing is drawn here: a web splash on top of it made the app slower to open and
  // the page under it showed a scroll strip.

  var STORE_URL = 'https://play.google.com/store/apps/details?id=gift.dhamma.uposatha';
  // Set when the reader taps Rate Us (the page's own row, #up-rate) or "Rate" in the invitation: whoever
  // has tapped it is never invited again.
  var RATE_FLAG = 'dgRateUsTapped';
  var SHORTCUTS_MAX = 3;   // the launcher's menu holds four entries; the static Calendar one is declared in res/xml/shortcuts.xml

  // The page is bundled, so it is at the app's own origin: /, /index.html, /uposatha-calendar (and .html).
  var CALENDAR_PATH = /^\/(uposatha-calendar(\.html)?\/?|index\.html)?$/;
  var onCalendar = CALENDAR_PATH.test(location.pathname);

  // The page's own rule (uposatha-calendar.js: ?lang=, then the stored dhammaLanguage, then the phone's
  // language) — not <html lang>, which the page sets late.
  function isRu() {
    var m = /[?&]lang=(\w\w)/.exec(location.search);
    var l = (m && m[1]) || '';
    if (!l) { try { l = localStorage.getItem('dhammaLanguage') || ''; } catch (e) { /* no storage */ } }
    return /^ru/i.test(l || navigator.language || '');
  }

  // ---- the page's own splash --------------------------------------------------------------------
  //
  // The page's app layer (app-refresh.js) draws a splash of its own once per session when it finds itself in an
  // app. Android draws the launch splash natively (the animated system splash), so the reader saw two, one
  // after the other. The page shows its splash only when sessionStorage.upSplash is unset: it is set here,
  // before the page's scripts run.
  if (onCalendar) { try { sessionStorage.setItem('upSplash', '1'); } catch (e) { /* no storage: the page draws its own */ } }

  // ---- the bundled page: no service worker, kept up to date -------------------------------------
  var SITE_CONFIG = {
    site: 'https://test.dhamma.gift',   // where the page comes from: test for now, https://dhamma.gift later
    // The page's file in the bundle is /uposatha-calendar.html; on the site it is /uposatha-calendar.
    urlFor: function (path) { return path === '/uposatha-calendar.html' ? '/uposatha-calendar' : path; }
  };
  // @site-updater (inlined from src/site-updater.js by uposatha/build.js)

  // ---- an app, not a page ----------------------------------------------------------------------
  //
  // A web page lets the reader select anything with a long press, flashes a tap highlight and offers
  // the browser's menu on links; an app does none of it. Text can be selected only where it is text to
  // take away: the quotes of the slideshow, any Pali (the page marks Pali with .pli-lang / lang="pi"), sutta names
  // and anything else the page marks with class="selectable" (or data-selectable), and the fields. Everything else is not selectable. Only on the calendar page: the other pages of
  // the site the app may pass through (dhamma.gift/4as) are the reader's own business.
  if (onCalendar) {
    var feel = document.createElement('style');
    feel.id = 'dg-native-feel';
    feel.textContent = 'html{-webkit-tap-highlight-color:transparent;-webkit-touch-callout:none}'
      + 'html body,html body *{-webkit-user-select:none;user-select:none}'
      + 'html body input,html body textarea,html body [contenteditable],html body .pli-lang,html body [lang="pi"],'
      + 'html body .selectable,html body [data-selectable],html body .selectable *,html body [data-selectable] *,'
      + 'html body #slides,html body #slides *{-webkit-user-select:text;user-select:text;-webkit-touch-callout:default}';
    (function put() {
      if (document.documentElement) document.documentElement.appendChild(feel);
      else new MutationObserver(function (m, mo) { if (document.documentElement) { mo.disconnect(); put(); } }).observe(document, { childList: true });
    })();
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

  // ---- launcher shortcuts: the next three Uposatha days ------------------------------------------
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
    var tomorrow = C.ymdAdd(today, 1), yesterday = C.ymdAdd(today, -1);
    var out = [];
    data.rows.forEach(function (r) {
      if (out.length >= SHORTCUTS_MAX || !r.uposatha) return;
      // By the suttas an Uposatha begins in the evening of its date, so the row of YESTERDAY is the one
      // that is in force today; either way "today" and "tomorrow" are named as such, and never left out.
      var when;
      if (r.ymd === today || (sutta && r.ymd === yesterday)) when = lang === 'ru' ? 'Сегодня' : 'Today';
      else if (r.ymd === tomorrow) when = lang === 'ru' ? 'Завтра' : 'Tomorrow';
      else if (r.ymd > today) {
        var parts = r.ymd.split('-').map(Number);
        when = new Intl.DateTimeFormat(lang, { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(parts[0], parts[1] - 1, parts[2])));
      } else return;
      // Which day it is, short (the launcher clips a label at ~25 characters): "Day 14/15", "14/15-й день" by the
      // suttas, the phase ("Full moon") in the modern scheme.
      var kind = '';
      try {
        var nums = sutta && r.names ? r.names.map(C.dayNo) : [];
        kind = nums.length ? (lang === 'ru' ? nums.join('/') + '-й день' : 'Day ' + nums.join('/')) : C.nameOf(names, r, sutta);
      } catch (e) { /* the date alone will do */ }
      out.push({
        id: 'dg-uposatha-' + out.length,
        label: kind ? when + ' · ' + kind : when,
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

  // ---- the sound source: the alarm stream or the notification stream --------------------------
  //
  // A channel plays its sound on an audio stream fixed when the channel is created, and
  // LocalNotifications creates every channel on the NOTIFICATION stream: with the notification volume
  // down, or the phone on silent, the reminder arrives and the gong does not. The same sound on the ALARM
  // stream plays at the alarm volume, like a clock. So the app keeps a setting (localStorage
  // dgUposathaSoundStream: 'notification' by default, or 'alarm'), and every sound has a second channel
  // with the suffix "-alarm" (DgSoundPlugin). The page creates channels and schedules notifications
  // through LocalNotifications without knowing about any of this; here the two calls are wrapped:
  // createChannel is made natively on the chosen stream, and schedule's channelId gets the suffix.
  var STREAM_KEY = 'dgUposathaSoundStream';
  function alarmStream() { return store(STREAM_KEY) === 'alarm'; }

  var NATIVE_ID_BASE = 7000;   // the page's ids for its reminders (uposatha-calendar.js: NATIVE_ID_BASE + list index; the test reminder is 7990)

  function clearDeliveredOurs(LN) {
    if (!LN || typeof LN.getDeliveredNotifications !== 'function') return Promise.resolve();
    return LN.getDeliveredNotifications().then(function (d) {
      var ours = ((d && d.notifications) || []).filter(function (n) { return n.id >= NATIVE_ID_BASE && n.id < NATIVE_ID_BASE + 1000; }).map(function (n) { return { id: n.id }; });
      return ours.length ? LN.removeDeliveredNotifications({ notifications: ours }) : null;
    }).catch(function () { /* the tray could not be read: schedule anyway */ });
  }

  // What the page last asked of the plugin, so a change of the source can be applied without reloading the page:
  // the channels it made (by their own id) and the reminders it scheduled (as it passed them, unmapped).
  var lastChannels = {};
  var lastSchedule = null;

  // Do Not Disturb: reminders should sound through it. Only the reader can allow that (a system page the app opens);
  // while the access is not there the channels are the plain ones, and when it arrives they are made again under other
  // ids (a channel's override cannot be changed afterwards): "-dnd".
  var dndGranted = false;
  function refreshDnd() {
    var DS = Cap.Plugins && Cap.Plugins.DgSound;
    if (!DS || typeof DS.dndAccess !== 'function') return Promise.resolve();
    return DS.dndAccess().then(function (r) {
      var granted = !!(r && r.granted);
      var changed = granted !== dndGranted;
      dndGranted = granted;
      paintDndRow();
      return changed ? restream() : null;
    }).catch(function () { /* the plugin cannot tell: the plain channels */ });
  }

  // ---- asking for the access -------------------------------------------------------------------
  //
  // A reminder that arrives with no sound is a note nobody hears, so the access is asked for, in plain words, when
  // reminders are on and it is not there: a sheet (the rating invitation's design) with a button to the system page.
  // Not on every start: once a week until it is given, once per session at most. The settings row stays.
  var DND_ASK_EVERY = 7 * 86400000;
  var dndAskedThisSession = false;

  function maybeAskDnd() {
    if (dndAskedThisSession || dndGranted || document.getElementById('dgrAsk')) return;
    var DS = Cap.Plugins && Cap.Plugins.DgSound;
    if (!DS || typeof DS.requestDndAccess !== 'function') return;
    if (Date.now() - (parseInt(store('dgDndAskedAt'), 10) || 0) < DND_ASK_EVERY) return;
    dndAskedThisSession = true;
    try { localStorage.setItem('dgDndAskedAt', String(Date.now())); } catch (e) { /* asked again next time */ }
    var ru = isRu();
    var style = document.createElement('style');
    style.textContent = RATE_PROMPT_CSS;
    document.head.appendChild(style);
    var overlay = document.createElement('div');
    overlay.id = 'dgrAsk';   // the rating sheet's styles, and its Back-button handling (closeRatePrompt)
    overlay.innerHTML = '<div class="dgr-sheet" role="alertdialog" aria-modal="true" aria-labelledby="dgrTitle">'
      + '<div class="dgr-eyebrow"></div><p class="dgr-title" id="dgrTitle"></p><p class="dgr-body"></p>'
      + '<div class="dgr-actions"><button type="button" class="dgr-ghost"></button><button type="button" class="dgr-primary"></button></div></div>';
    overlay.querySelector('.dgr-eyebrow').textContent = ru ? 'Напоминания' : 'Reminders';
    overlay.querySelector('.dgr-title').textContent = ru ? 'Чтобы напоминание было слышно' : 'So that a reminder is heard';
    overlay.querySelector('.dgr-body').textContent = ru
      ? 'Пока включён режим «Не беспокоить», напоминание приходит без звука. Разрешите Uposatha звучать в этом режиме: откроются настройки Android, включите переключатель для Uposatha и вернитесь.'
      : 'While Do Not Disturb is on, a reminder arrives with no sound. Allow Uposatha to sound in it: Android settings open, switch it on for Uposatha and come back.';
    overlay.querySelector('.dgr-ghost').textContent = ru ? 'Позже' : 'Later';
    overlay.querySelector('.dgr-primary').textContent = ru ? 'Разрешить' : 'Allow';
    document.body.appendChild(overlay);
    requestAnimationFrame(function () { overlay.classList.add('show'); });
    function close() { overlay.classList.remove('show'); setTimeout(function () { overlay.remove(); }, 200); }
    overlay.querySelector('.dgr-ghost').addEventListener('click', close);
    overlay.addEventListener('click', function (ev) { if (ev.target === overlay) close(); });
    overlay.querySelector('.dgr-primary').addEventListener('click', function () { DS.requestDndAccess(); close(); });
  }

  function wrapLocalNotifications() {
    var plugins = Cap.Plugins;
    var LN = plugins && plugins.LocalNotifications;
    if (!LN || LN.__dgWrapped) return;
    var sound = function () { return plugins.DgSound; };
    var suffixed = function (id) {
      if (!id || id.indexOf('uposatha-') !== 0 || /-(alarm|dnd)$/.test(id)) return id;
      // The reader's own sound has both streams made by DgSound at the pick; the built-in ones are made here.
      var own = id.indexOf('uposatha-own-') === 0;
      return id + (alarmStream() ? '-alarm' : '') + (dndGranted && !own ? '-dnd' : '');
    };
    plugins.LocalNotifications = new Proxy(LN, {
      get: function (target, key) {
        if (key === '__dgWrapped') return true;
        if (key === 'createChannel') {
          return function (ch) {
            lastChannels[ch.id] = ch;
            if (!sound() || typeof sound().channel !== 'function') return target.createChannel(ch);
            // Made natively, on the stream the reader chose, asking to sound through Do Not Disturb.
            return sound().channel({ id: suffixed(ch.id), name: ch.name + (alarmStream() ? (isRu() ? ' (будильник)' : ' (alarm)') : ''), sound: ch.sound || '',
              importance: ch.importance, vibration: !!ch.vibration, stream: alarmStream() ? 'alarm' : 'notification', bypass: true });
          };
        }
        if (key === 'schedule') {
          return function (o) {
            lastSchedule = o;
            // The picture of the reminders (docs/launch-screens/uposatha-notification.png: the mirror, the bowl, the brush),
            // shown at the right of the notification; the sound channel is the reader's.
            var list = ((o && o.notifications) || []).map(function (n) { return Object.assign({ largeIcon: 'uposatha_notification' }, n, { channelId: suffixed(n.channelId) }); });
            // The plugin posts every notification "alert once": one that REPLACES a notification of the same id still in the
            // tray makes no sound and no vibration. The page's ids are their place in the list (the next reminder is always
            // 7000, and the test reminder is 7990), so a reminder that fires after another has been left in the tray would
            // arrive silent. Whatever of ours is still in the tray is taken away before new ones are set.
            return clearDeliveredOurs(target).then(function () { return target.schedule(Object.assign({}, o, { notifications: list })); }).then(function (res) {
              if (list.length) setTimeout(function () { refreshDnd().then(maybeAskDnd); }, 2500);   // the page has settled; is the access there?
              return res;
            });
          };
        }
        var v = target[key];
        return typeof v === 'function' ? v.bind(target) : v;
      }
    });
  }

  // The source changed: make the channels of the other stream, take back the reminders that are set and set them again on
  // those channels — no reload of the page. (The page schedules only when its own reminders change, so it would never do
  // this itself.) What the page has asked of the plugin since it started is what is replayed; it asks at every start.
  function restream() {
    var LN = Cap.Plugins && Cap.Plugins.LocalNotifications;
    if (!LN) return Promise.resolve();
    return Promise.all(Object.keys(lastChannels).map(function (id) { return LN.createChannel(lastChannels[id]); }))
      .then(function () { return LN.getPending(); })
      .then(function (p) {
        var ours = ((p && p.notifications) || []).filter(function (n) { return n.id >= NATIVE_ID_BASE && n.id < NATIVE_ID_BASE + 100; }).map(function (n) { return { id: n.id }; });
        return ours.length ? LN.cancel({ notifications: ours }) : null;
      })
      .then(function () { return lastSchedule && lastSchedule.notifications && lastSchedule.notifications.length ? LN.schedule(lastSchedule) : null; })
      .catch(function (e) { console.log('[dg-uposatha-stream] could not move the reminders:', (e && e.message) || e); });
  }

  // At once, before the page's own scripts reach for the plugin (start() below tries again should Capacitor not have registered it yet).
  if (onCalendar) wrapLocalNotifications();

  // The setting itself, in the settings drawer under the page's own sound row. Changing it moves the reminders
  // to the other channels at once (restream above), without reloading the page.
  //
  // The page may rebuild or clone its drawer (a language switch redraws it), and a listener on the
  // select would be lost with the node: the change is caught at the document instead, and the row is
  // put back whenever the page's sound row is there without it.
  function streamRow() {
    var ru = isRu();
    var row = document.createElement('div');
    row.id = 'dg-stream-row';
    row.innerHTML = '<p class="dg-drawer-subtitle"></p><select class="dg-field-input" id="dg-stream"></select>'
      + '<p class="dg-drawer-subtitle dg-stream-note" style="font-weight:400;opacity:.75;margin-top:6px"></p>';
    row.querySelector('.dg-drawer-subtitle').textContent = ru ? 'Источник звука' : 'Sound source';
    var select = row.querySelector('select');
    [['notification', ru ? 'Уведомления' : 'Notifications'], ['alarm', ru ? 'Будильник' : 'Alarm']].forEach(function (o) {
      var opt = document.createElement('option');
      opt.value = o[0];
      opt.textContent = o[1];
      select.appendChild(opt);
    });
    select.value = alarmStream() ? 'alarm' : 'notification';
    row.querySelector('.dg-stream-note').textContent = ru
      ? 'Будильник звучит громкостью будильника, даже если звук уведомлений выключен.'
      : 'The alarm plays at the alarm volume, even when the notification sound is off.';
    return row;
  }

  function dndRow() {
    var ru = isRu();
    var row = document.createElement('div');
    row.id = 'dg-dnd-row';
    row.innerHTML = '<p class="dg-drawer-subtitle"></p><button type="button" class="pillbtn" id="dg-dnd-btn"></button>'
      + '<p class="dg-drawer-subtitle dg-dnd-note" style="font-weight:400;opacity:.75;margin-top:6px"></p>';
    row.querySelector('.dg-drawer-subtitle').textContent = ru ? 'Звук при «Не беспокоить»' : 'Sound in Do Not Disturb';
    row.querySelector('.dg-dnd-note').textContent = ru
      ? 'Иначе при включённом «Не беспокоить» напоминание придёт без звука. Разрешить может только владелец телефона, в настройках Android.'
      : 'Without it, a reminder arrives with no sound while Do Not Disturb is on. Only the phone\'s owner can allow it, in Android settings.';
    return row;
  }

  function paintDndRow() {
    var btn = document.getElementById('dg-dnd-btn');
    if (!btn) return;
    var ru = isRu();
    btn.textContent = dndGranted ? (ru ? 'Разрешено ✓' : 'Allowed ✓') : (ru ? 'Разрешить в настройках' : 'Allow in settings');
    btn.disabled = false;
  }

  function ensureStreamRow() {
    var anchor = document.getElementById('rem-sound-row');
    if (!anchor || document.getElementById('dg-stream-row')) return;
    var stream = streamRow();
    anchor.parentNode.insertBefore(stream, anchor.nextSibling);
    stream.parentNode.insertBefore(dndRow(), stream.nextSibling);
    paintDndRow();
  }

  function watchStreamRow() {
    document.addEventListener('change', function (e) {
      var t = e.target;
      if (!t || t.id !== 'dg-stream') return;
      try { localStorage.setItem(STREAM_KEY, t.value); } catch (err) { /* no storage: the choice is lost */ }
      restream();
    }, true);
    document.addEventListener('click', function (e) {
      var b = e.target && e.target.closest && e.target.closest('#dg-dnd-btn');
      var DS = Cap.Plugins && Cap.Plugins.DgSound;
      if (b && DS && typeof DS.requestDndAccess === 'function') DS.requestDndAccess();
    }, true);
    // Back from the system's settings page: has the access been given?
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') refreshDnd(); });
    refreshDnd();
    ensureStreamRow();
    new MutationObserver(ensureStreamRow).observe(document.documentElement, { childList: true, subtree: true });
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
  var RATE_HOME = CALENDAR_PATH;

  // @rate-prompt (inlined from src/native-bridge.js by uposatha/build.js)

  function start() {
    if (!onCalendar) { wireBackButton(); return; }
    wireBackButton();
    wrapLocalNotifications();
    watchStreamRow();
    // The page's own Rate Us row: note the tap, so the invitation never asks someone who has been.
    document.addEventListener('click', function (e) {
      var a = e.target && e.target.closest && e.target.closest('#up-rate');
      if (a) { try { localStorage.setItem(RATE_FLAG, '1'); } catch (err) { /* no storage */ } }
    }, true);
    // UposathaCore is loaded by the page: give it until the page has finished loading.
    function afterLoad() { pushShortcuts(); setTimeout(updateSite, 6000); }
    if (document.readyState === 'complete') afterLoad();
    else window.addEventListener('load', afterLoad, { once: true });
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') pushShortcuts(); });
    maybeAskForRating();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
