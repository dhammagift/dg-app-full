// Android System WebView has no window.speechSynthesis, so the site's voice player (read/js/voice.js)
// had nothing to speak with and threw on its first call: no sound, and a close button that never
// closed. This stands in for the part of Web Speech that player uses (speak/cancel/getVoices/
// voiceschanged; utterance text/lang/rate/voice/onend/onerror) over Android's TextToSpeech
// (DgTtsPlugin). A browser that has the real API keeps it.
// Its own file, loaded before voice.js on every page that has the player (index.html via build-page.js,
// memo and the rest via build-assets.js): in platform.js it existed on the home page only, and Memo threw
// "Cannot set properties of undefined (setting 'onvoiceschanged')".
(function () {
    var P = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.DgTts;
    if (!P) return;
    // In an app the plugin IS the engine, and neither WebView's own speech is worth trusting:
    // Android System WebView has no speechSynthesis at all, and WKWebView's is a trap — it reports
    // voices (68 of them, measured in a simulator) and then throws on speak() ("Argument 1
    // ('utterance') to SpeechSynthesis.speak must be an instance of SpeechSynthesisUtterance"), so
    // the player got no sound AND no end event, and its close button never closed. A real browser
    // keeps its own implementation.
    var inApp = !!(window.Capacitor && window.Capacitor.getPlatform && window.Capacitor.getPlatform() !== 'web');
    if (!inApp && window.speechSynthesis && (window.speechSynthesis.getVoices() || []).length) return;
    // Marked on the object, not on a hopeful global: a readonly IDL attribute can swallow the
    // assignment below, and then "the shim is installed" would be a claim nobody verified.
    var voices = [], pending = {}, seq = 0, listeners = [];
    // Both styles Web Speech callers use: utterance.onend = … (voice.js) and
    // utterance.addEventListener('start', …) (memo.js — "addEventListener is not a function" on Play).
    function fire(u, type, ev) {
        ev.type = type;
        if (typeof u['on' + type] === 'function') u['on' + type].call(u, ev);
        (u._listeners[type] || []).slice().forEach(function (f) { f.call(u, ev); });
    }
    P.addListener('tts', function (e) {
        var u = pending[e.id];
        if (!u) return; // cancelled: Web Speech callers null their handlers before cancel anyway
        delete pending[e.id];
        fire(u, e.type === 'end' ? 'end' : 'error', { utterance: u, error: e.error });
    });
    window.SpeechSynthesisUtterance = function (text) {
        this.text = text || ''; this.lang = ''; this.rate = 1; this.voice = null;
        this.onstart = null; this.onend = null; this.onerror = null;
        this._listeners = {};
    };
    window.SpeechSynthesisUtterance.prototype.addEventListener = function (type, f) {
        (this._listeners[type] = this._listeners[type] || []).push(f);
    };
    window.SpeechSynthesisUtterance.prototype.removeEventListener = function (type, f) {
        this._listeners[type] = (this._listeners[type] || []).filter(function (x) { return x !== f; });
    };
    var synth = {
        // The self-test reads this off the object the page actually got, so a shim that failed to
        // install cannot report itself as installed.
        __dgTtsPlugin: true,
        onvoiceschanged: null,
        getVoices: function () { return voices; },
        speak: function (u) {
            var id = 'u' + (++seq);
            pending[id] = u;
            P.speak({ id: id, text: u.text, lang: u.lang, rate: u.rate, voice: u.voice && u.voice.name })
                .catch(function (err) {
                    if (!pending[id]) return;
                    delete pending[id];
                    fire(u, u.onerror, { utterance: u, error: (err && err.message) || String(err) });
                });
        },
        cancel: function () { pending = {}; P.cancel(); },
        addEventListener: function (type, f) { if (type === 'voiceschanged') listeners.push(f); },
        removeEventListener: function (type, f) { listeners = listeners.filter(function (x) { return x !== f; }); },
    };
    // NOT `window.speechSynthesis = synth`: in WKWebView speechSynthesis is a readonly IDL attribute,
    // so that assignment is a silent no-op in sloppy mode and the player kept the native engine —
    // which has voices and THROWS on speak() (measured: the shim "installed", speak still threw the
    // native error). defineProperty replaces it whatever the attribute says.
    try {
        Object.defineProperty(window, 'speechSynthesis', { configurable: true, writable: true, value: synth });
    } catch (e) {
        window.speechSynthesis = synth;
    }
    // The lock screen. voice.js already says what is playing through navigator.mediaSession — title,
    // artwork, play/pause handlers — and in a browser that is the whole job. In the app those lines
    // reached nobody: the PWA showed a player on the lock screen and the app, built from the same
    // code, showed nothing at all.
    //
    // The first attempt gated this on `!('mediaSession' in navigator)`, on the assumption that
    // WebView simply has no such API. It HAS one — Blink defines it, so the check is false and the
    // stand-in never installed — and it goes nowhere: WebView has no media notification of its own
    // to put the metadata in (crbug 40765779). An API that exists and does nothing is worse than a
    // missing one, because every feature test passes. So the platform decides, not the presence of
    // a property: on Android the plugin IS the media session, exactly as it is already the speech
    // engine a dozen lines above. WKWebView's implementation is real, so iOS keeps its own.
    var isAndroidApp = !!(window.Capacitor && window.Capacitor.getPlatform
                          && window.Capacitor.getPlatform() === 'android');
    if (isAndroidApp && typeof P.setPlaybackState === 'function') {
        var handlers = {}, meta = null, playback = 'none';
        var media = {
            setActionHandler: function (action, fn) { handlers[action] = fn; },
            // Speech is not a seekable track, and nothing asks for a scrubber.
            setPositionState: function () { },
        };
        Object.defineProperty(media, 'metadata', {
            get: function () { return meta; },
            set: function (m) {
                meta = m;
                var art = m && m.artwork && m.artwork[0] && m.artwork[0].src;
                P.setMediaMetadata({ title: (m && m.title) || '', artist: (m && m.artist) || '', artwork: art || '' });
            },
        });
        Object.defineProperty(media, 'playbackState', {
            get: function () { return playback; },
            set: function (s) { playback = s; P.setPlaybackState({ state: s }); },
        });
        // A press on the notification or the lock screen comes back here, and the handler voice.js
        // registered decides what it means — this side never guesses.
        P.addListener('media', function (e) {
            var f = handlers[e && e.action];
            if (typeof f === 'function') f();
        });
        try {
            Object.defineProperty(navigator, 'mediaSession', { configurable: true, value: media });
        } catch (e) {
            navigator.mediaSession = media;
        }
        if (!window.MediaMetadata) {
            window.MediaMetadata = function (init) {
                init = init || {};
                this.title = init.title || '';
                this.artist = init.artist || '';
                this.album = init.album || '';
                this.artwork = init.artwork || [];
            };
        }
    }

    P.getVoices().then(function (r) {
        voices = (r && r.voices) || [];
        var ev = { type: 'voiceschanged' };
        if (typeof synth.onvoiceschanged === 'function') synth.onvoiceschanged(ev);
        listeners.forEach(function (f) { f(ev); });
    }).catch(function (e) { console.log('[dg-tts] getVoices failed:', (e && e.message) || e); });
})();
