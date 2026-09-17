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
    // "Has the API" is not "can speak": WKWebView exposes speechSynthesis with ZERO voices and a
    // speak() that never starts (measured in a simulator), which is worse than Android's honest
    // absence — the player got no sound AND no end event, so its close button never closed. Install
    // over it when there is not a single voice to speak with. Android (no API at all) and any real
    // browser with voices are unaffected.
    if (window.speechSynthesis && (window.speechSynthesis.getVoices() || []).length) return;
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
    var synth = window.speechSynthesis = {
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
    P.getVoices().then(function (r) {
        voices = (r && r.voices) || [];
        var ev = { type: 'voiceschanged' };
        if (typeof synth.onvoiceschanged === 'function') synth.onvoiceschanged(ev);
        listeners.forEach(function (f) { f(ev); });
    }).catch(function (e) { console.log('[dg-tts] getVoices failed:', (e && e.message) || e); });
})();
