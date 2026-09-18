// dhammagift:// — the app's own URL scheme, in one place, shared by both platforms.
//
// Android had it before iOS existed, but only as `dhammagift://auth` (the Google sign-in handoff's
// return) — see android/app/src/main/AndroidManifest.xml. iOS declared the scheme with no route
// behind it at all. This file is the route behind it, and the only implementation of the mapping:
// the native side's job is to hand over the raw URL, not to interpret it. That is deliberate — two
// platforms interpreting the same scheme is how `dhammagift://mn1` comes to mean two things.
//
// The contract, in full:
//
//   dhammagift://mn1                        the reader, at a canon text
//   dhammagift://sn56.11                    same
//   dhammagift://route/dn22:2.2             an explicit SPA route. Segments MUST use this form: a
//                                           colon in the host position ("dhammagift://dn22:2.2") is
//                                           not a parseable URL (it reads as host + port) and both
//                                           platforms refuse it before we ever see it.
//   dhammagift://route/toc                  same, for any SPA path (/toc, /4as, /settings, ...)
//   dhammagift://search?q=kacchapa&langs=ru explicit search; unknown query keys are ignored
//   dhammagift://kacchapa                   anything else is a search for that text
//   dhammagift://auth?id_token=&state=      Google sign-in return (the login page finishes it)
//   https://dhamma.gift/mn1                 a Universal Link (iOS) or a verified App Link (Android):
//                                           the path is the route, exactly as in the scheme form
//
// A canon id is "letters (and dashes) followed by a digit": dn22, mn1, sn56.11, thag1.1,
// pli-tv-bu-vb-pj1. Anything without that shape is a search term — which is why the short SPA
// routes (/4as, /4nt) must be written as `route/4as`: they start with a digit and would otherwise
// be searched for. A rule that guesses less is a rule that surprises less.
//
// Returns a path relative to the app's own origin, or null when the URL is not ours (another app's
// scheme, a bad host, or an auth return missing its token — the last one matters: answering it with
// a half-built login page would be worse than ignoring it).
(function (root) {
    'use strict';

    // The query keys the site actually reads for search. Everything else on a search URL is dropped
    // rather than forwarded, so a shared link cannot smuggle arbitrary state into the SPA.
    var SEARCH_KEYS = ['q', 'langs', 'fast', 'exact', 'scope', 'lb', 'la'];

    // The hosts whose links this app claims — the same six Android's autoVerify filter lists in
    // AndroidManifest.xml, so a link cannot behave differently on the two platforms.
    var SITE_HOSTS = /^(www\.|f\.|www\.f\.|find\.|www\.find\.)?dhamma\.gift$/i;

    function canonId(host) {
        return /^[a-z][a-z-]*\d/i.test(host);
    }

    function toLocalUrl(raw) {
        if (!raw || typeof raw !== 'string') return null;

        var url;
        try {
            url = new URL(raw);
        } catch (e) {
            return null;
        }
        // Universal Links arrive as ordinary site URLs — on iOS this event is the ONLY way one
        // arrives, on Android MainActivity has already turned it into the same load (native-bridge
        // ignores the event there so it cannot navigate twice). One mapping either way: the path IS
        // the route, which is also what Android's intent filter pairs with.
        if (url.protocol === 'https:' || url.protocol === 'http:') {
            if (!SITE_HOSTS.test(url.hostname)) return null;
            var sitePath = url.pathname + url.search + url.hash;
            // The home page is not a route: nothing to rewrite, and an empty _nativeRoute would be
            // refused by the page's own handoff anyway.
            if (sitePath === '/' || sitePath === '') return null;
            return '/?_nativeRoute=' + encodeURIComponent(sitePath);
        }

        if (url.protocol !== 'dhammagift:') return null;

        var host = url.hostname.toLowerCase();
        // A non-ASCII search term arrives percent-encoded in the host position, and URL parsing
        // leaves it that way for a non-special scheme: decoding here is what keeps
        // `dhammagift://%D1%87...` from being encoded a second time and searched for as "%25d1...".
        try { host = decodeURIComponent(host); } catch (e) { /* malformed escape: search the raw text */ }
        var params = url.searchParams;

        if (host === 'auth') {
            var token = params.get('id_token');
            var state = params.get('state');
            // Both, or nothing: the login page cannot finish a sign-in without them, and loading it
            // with a partial fragment is how you get a spinner that never resolves.
            if (!token || !state) return null;
            var page = params.get('lang') === 'ru' ? 'ru/login/index.html' : 'login/index.html';
            return '/' + page + '#dg_google=' + encodeURIComponent(token) + '&state=' + encodeURIComponent(state);
        }

        if (host === 'route') {
            var path = url.pathname + url.search + url.hash;
            if (path === '/' || path === '') return null;
            return '/?_nativeRoute=' + encodeURIComponent(path);
        }

        if (host === 'search') {
            var q = params.get('q');
            if (!q) return null;
            return '/?q=' + encodeURIComponent(q) + forwardSearchParams(params);
        }

        // A canon id opens the reader; everything else is a search for the text. A path after the id
        // is kept (dhammagift://toc/pm is a real route, and /toc/<book> is how the TOC is addressed).
        var tail = url.pathname + url.search + url.hash;
        if (canonId(host) || /^toc$/i.test(host)) {
            return '/?_nativeRoute=' + encodeURIComponent('/' + host + tail);
        }
        return '/?q=' + encodeURIComponent(host + decodeURIComponent(url.pathname)) + forwardSearchParams(params);
    }

    function forwardSearchParams(params) {
        var out = [];
        SEARCH_KEYS.forEach(function (key) {
            if (key === 'q') return;
            var value = params.get(key);
            if (value) out.push(encodeURIComponent(key) + '=' + encodeURIComponent(value));
        });
        return out.length ? '&' + out.join('&') : '';
    }

    root.dgDeepLinkToLocalUrl = toLocalUrl;
    // Also a module export, so the contract is testable in node (test/deep-link.test.js) without a
    // browser and without a device — this mapping is pure string work and has no business needing
    // either. Everywhere else in src/ is a plain browser script; this one line is the whole cost.
    if (typeof module !== 'undefined' && module.exports) module.exports = toLocalUrl;
})(typeof window !== 'undefined' ? window : globalThis);
