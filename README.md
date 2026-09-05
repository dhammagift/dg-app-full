# dg-app-full — Dhamma.gift offline app (Android, iOS planned)

Offline Pāli-canon search and reader: the **real dhamma.gift frontend** running in a Capacitor
WebView, with local SQLite standing in for the server's search API.

> **The UI is not maintained in this repository.** It is generated at build time from a checkout
> of [dg-node](https://github.com/dhammagift/dg-node) — the website. This repo holds only what is
> genuinely app-specific.

## Why it is built this way

The app used to live as a `mobile/` folder inside dg-node, and it duplicated the site: 215
committed copies of the frontend, an `index.html` that had no build script at all and had drifted
147 lines behind `search/index.html`, and a hand-maintained list of ~120 assets that had to be
edited every time the site gained a `<script>`.

Nothing here is a committed copy any more. `www/` is generated and gitignored; if the site
changes, the next build picks the change up.

## Layout

```
src/                     the app's own web files (committed)
  app.js                 installs the fetch shim: /search, /api/text, /api/nav answered from SQLite
  native-bridge.js       external links via Custom Tabs, Android back button
  offline-status.js      database download progress
  offline-library-settings.js
paths.js                 where dg-node and the legacy asset tree live (DG_NODE_PATH)
build-page.js            www/index.html   <- dg-node's search/index.html + 2 declarative edits
build-assets.js          www/assets, www/reader, ... <- dg-node + legacy assets + src/ + sql.js
build-toc-snapshot.js    www/api-snapshots/*.json <- a running dg-light.js
build-offline-db.js      dist/core.db, dist/lang_<code>.db  <- the corpus
lib/translation-sources.js  translator selection (a fork of dg-light.js's — see "Known debt")
android/                 Capacitor Android project, incl. hand-written native source
www/                     GENERATED, gitignored
dist/                    GENERATED, gitignored (hundreds of MB)
```

## How the app works at runtime

There is no server on the device, and no Node runtime either.

`src/app.js` replaces `window.fetch` before any other script on the page can run, and answers the
site's own API calls from local SQLite. The frontend does not know the difference — it issues the
same `fetch('/search?q=…')` it issues on the web.

| Request | Answered by |
|---|---|
| `/search`, `/search/:keyword`, `/search/enrich` | SQLite FTS |
| `/api/text/:id`, `/api/nav/:id` | SQLite |
| `/api/toc`, `/api/toc/book/:code` | build-time snapshots in `www/api-snapshots/` |
| `/api/patimokkha-fragment/:side` | bundled HTML, URL remap |
| everything else | the real fetch (local files) |

The databases are **not** bundled in the APK (which is ~4.5 MB). They are downloaded on first
launch from `test.dhamma.gift/mobile-data/` and cached on the device.

## Building locally

Needs a dg-node checkout, the legacy `dg` asset tree, and the corpus data that dg-node's
`siteroot/data/` symlinks point at.

```bash
npm install

export DG_NODE_PATH=../dg-node          # default: /var/www/html/nodejs
export DG_LEGACY_ASSETS=../dg/assets    # default: $DG_NODE_PATH/siteroot/assets

# 1. dg-node builds its skeleton, and must have run once so its generated
#    settings/*.json exist (build-assets.js copies them):
(cd "$DG_NODE_PATH" && npm run build-db && npm start &)

# 2. offline databases + TOC snapshot (needs dg-light.js listening on :3000)
npm run build-offline-db
npm run build-toc-snapshot

# 3. the web bundle: page first, then everything it references
npm run build

# 4. the APK
npm run sync-android
(cd android && ./gradlew assembleDebug)
```

`npm run serve-dist` serves `dist/` on :8090 for testing the database download without a device.

CI does exactly this — see `.github/workflows/build-app.yml`. Which dg-node commit it builds from
is pinned in **`DG_NODE_REF`** (a branch name or tag); a `workflow_dispatch` run can override it.

## Known debt

- **`lib/translation-sources.js` is a hand-maintained fork** of dg-light.js's `SOURCE_PRIORITY` /
  `findTranslationFiles` / `filterPreferredTranslators`. It has to be re-synced by hand when the
  server's logic changes. The plan is to replace it, along with `src/app.js`'s reimplementation of
  the search/text/nav endpoints, with a shared module owned by dg-node.
- **`build-assets.js`'s asset list is hand-maintained** — a new `<script>` on the site must be
  added there too. Planned replacement: crawl a running dg-light.js and save every 200 response at
  its own URL path.
- **`@capacitor-community/sqlite` is a dependency and is linked into the APK, but no JavaScript
  calls it.** The runtime uses `sql.js` (WASM) instead, which is why the databases are cached in
  IndexedDB rather than kept as files, and why the FTS index is FTS4 (prebuilt sql.js has no FTS5).
- **No cache versioning:** an updated corpus on the server will never re-download on a device that
  already has one.
- **iOS has not been started** — `npx cap add ios` has never been run.
- **Never tested on a real device or emulator.** All verification so far has been Playwright over
  a local static server.
