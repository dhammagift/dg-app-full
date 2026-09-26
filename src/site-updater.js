// Shared by the bundled-page apps (Uposatha, Dict): the parts of their bridges that keep a page that is
// BUNDLED in the APK working and current. Pasted into each bridge by its build.js at the marker
// "// @site-updater"; the bridge defines SITE_CONFIG first and calls updateSite() when the page has loaded.
//
//   SITE_CONFIG = { site: 'https://dict.dhamma.gift', urlFor: function (path) { return path; } }
//
// Uses the bridge's Cap (window.Capacitor) and store() (localStorage read).
  // ---- no service worker ---------------------------------------------------------------------
  //
  // The site's page registers its own service worker (/sw.js, its caching for the website). In the app the
  // files come from the APK and DgSite, and a second layer of caching on top of them would decide what the
  // reader sees behind our back: registrations are swallowed here.
  if (navigator.serviceWorker && typeof navigator.serviceWorker.register === 'function') {
    navigator.serviceWorker.register = function () {
      return Promise.resolve({ scope: '/', update: function () { return Promise.resolve(); }, unregister: function () { return Promise.resolve(true); } });
    };
  }

  // ---- keeping the bundled page up to date --------------------------------------------------
  //
  // The APK holds the page as it was when it was built. When the phone is online, and at most every 12
  // hours, every file of the bundle is fetched from the site; the ones whose SHA-256 differs from what the
  // app has (the manifest of the bundle, then whatever was downloaded before) go to DgSite, which serves
  // them from the next request on — for the page itself, the next launch. A file the new page brings that
  // the bundle has never had (found in the new html / css / js) is fetched too. Nothing is ever deleted: a
  // file the site no longer has stays, harmlessly.
  // SITE_CONFIG (defined by the bridge that pastes this in): { site: where the page comes from, urlFor(path): a
  // bundled file's address on the site (a page is not served under its .html name) }
  var SITE = SITE_CONFIG.site;
  var SITE_CHECK_EVERY = 12 * 3600 * 1000;

  function bytesToBase64(bytes) {
    var out = '';
    for (var i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(out);
  }

  function hex(buf) {
    return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }

  // Local files a text file mentions: absolute paths under the site's own roots, and, in html, relative src / href
  // (resolved against the file's own directory).
  function referencedPaths(text, from) {
    var found = [], m;
    var abs = /["'(=]\s*(\/(?:assets|nodejs|offline|reader|settings|spa|static)\/[A-Za-z0-9_\-./]+\.[A-Za-z0-9]+)/g;
    while ((m = abs.exec(text))) found.push(m[1]);
    if (/\.html$/.test(from)) {
      var rel = /(?:src|href)="([A-Za-z0-9_\-./]+\.[A-Za-z0-9]+)(?:\?[^"]*)?"/g;
      var dir = from.replace(/[^/]*$/, '');
      while ((m = rel.exec(text))) {
        if (/^(?:https?:|\/\/|#)/.test(m[1])) continue;
        found.push(m[1].charAt(0) === '/' ? m[1] : dir + m[1]);
      }
    }
    return found;
  }

  function updateSite() {
    var DS = Cap.Plugins && Cap.Plugins.DgSite;
    if (!DS || navigator.onLine === false || !window.crypto || !crypto.subtle) return;
    if (Date.now() - (parseInt(store('dgSiteCheckedAt'), 10) || 0) < SITE_CHECK_EVERY) return;
    var hashes = {};
    try { hashes = JSON.parse(store('dgSiteHashes')) || {}; } catch (e) { hashes = {}; }
    fetch('/site-manifest.json', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (manifest) {
      var queue = manifest.files.slice(), seen = {}, changes = [], changed = 0, fetched = 0;
      manifest.files.forEach(function (f) { seen[f] = 1; });
      function next() {
        var path = queue.shift();
        if (!path || fetched > 400) return Promise.resolve();
        fetched++;
        return fetch(SITE + SITE_CONFIG.urlFor(path), { cache: 'no-store' }).then(function (res) {
          if (!res.ok) return null;
          return res.arrayBuffer();
        }).then(function (buf) {
          if (!buf || !buf.byteLength) return null;
          return crypto.subtle.digest('SHA-256', buf).then(function (digest) {
            var sha = hex(digest), had = hashes[path] || (manifest.hashes || {})[path];
            // A page and its stylesheets name the files they need; a script's strings name half the site's assets
            // (a first version followed those and pulled 30 MB), and what a script fetches on demand is in the bundle
            // already (the snapshot's browser ran it).
            if (/\.(html|css)$/.test(path)) {
              referencedPaths(new TextDecoder().decode(buf), path).forEach(function (p) { if (!seen[p]) { seen[p] = 1; queue.push(p); } });
            }
            if (sha === had) return null;
            changes.push({ path: path, data: bytesToBase64(new Uint8Array(buf)), sha: sha });
            return null;
          });
        }).catch(function () { /* one file that would not come: the rest still matter */ }).then(next);
      }
      // Everything is fetched before anything is stored, and the pages go last: a page that arrives before the
      // files it names would run against the old ones.
      function store1() {
        var c = changes.shift();
        if (!c) return Promise.resolve();
        return DS.put({ path: c.path, data: c.data }).then(function () { hashes[c.path] = c.sha; changed++; }, function () { /* this one stays as it was */ }).then(store1);
      }
      return next().then(function () {
        changes.sort(function (a, b) { return (/\.html$/.test(a.path) ? 1 : 0) - (/\.html$/.test(b.path) ? 1 : 0); });
        return store1();
      }).then(function () {
        try { localStorage.setItem('dgSiteHashes', JSON.stringify(hashes)); localStorage.setItem('dgSiteCheckedAt', String(Date.now())); } catch (e) { /* no storage: it is checked again next time */ }
        console.log('[dg-site] checked ' + fetched + ' files, ' + changed + ' updated');
      });
    }).catch(function (e) { console.log('[dg-site] update failed:', (e && e.message) || e); });
  }

