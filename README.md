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
  app.js                 the fetch shim: parses the query string, asks the worker, answers
  db-worker.js           the database and the site's search core; everything SQL happens here
  native-bridge.js       external links via Custom Tabs, Android back button
  offline-status.js      download progress, the consent sheet, error reporting
  offline-library-settings.js
paths.js                 where dg-node and the legacy asset tree live (DG_NODE_PATH)
build-page.js            www/index.html      <- dg-node's search/index.html + 2 declarative edits
build-core-bundle.js     www/core-bundle.mjs <- dg-node's core/search-core.js, made WebView-loadable
build-assets.js          www/assets, www/reader, ... <- dg-node + legacy assets + src/ + sqlite-wasm
build-toc-snapshot.js    www/api-snapshots/*.json <- a running dg-light.js
build-app-db.js          dist/dg-mobile.db   <- a language slice of dg-node's dg.db
android/                 Capacitor Android project, incl. hand-written native source
test/                    the fixture, the site snapshots, and the parity checks
www/                     GENERATED, gitignored
dist/                    GENERATED, gitignored (~170 MB)
```

## How the app works at runtime

There is no server on the device, and no Node runtime either.

`src/app.js` replaces `window.fetch` before any other script on the page can run. What answers
those calls is **dg-node's own `core/search-core.js`** — the same module the site runs — bundled
by `build-core-bundle.js` and executing in `src/db-worker.js` over a slice of the same database
the server queries. The frontend cannot tell the difference, and neither can a diff:
`test/e2e-browser.js` compares 24 responses against captures from the live site.

| Request | Answered by |
|---|---|
| `/search`, `/search/:keyword`, `/search/enrich` | the site's core, over local SQLite |
| `/api/text/:id`, `/api/nav/:id` | the site's core, over local SQLite |
| `/api/toc`, `/api/toc/book/:code` | build-time snapshots in `www/api-snapshots/` |
| `/api/patimokkha-fragment/:side` | bundled HTML, URL remap |
| everything else | the real fetch (local files) |

The database lives in a Worker because OPFS hands out synchronous access handles only there — and
synchronous access is what lets SQLite read a ~170 MB file from storage instead of holding it in
memory, and what lets the core, written against `node:sqlite`, run unchanged.

It is **not** bundled in the APK (~12 MB). On first launch it is streamed from
`dhamma.gift/mobile-data/dg-mobile.db` straight into OPFS, chunk by chunk, and stays there.

The name is deliberate: the server's own database is `dg.db` and sits on the same machine. Calling
the app's slice by the same name is how a symlink ends up pointing every language at a phone.

## Building locally

Needs a dg-node checkout, the legacy `dg` asset tree, and the corpus data that dg-node's
`siteroot/data/` symlinks point at.

```bash
npm install

export DG_NODE_PATH=../dg-node          # default: /var/www/html/nodejs
export DG_LEGACY_ASSETS=../dg/assets    # default: $DG_NODE_PATH/siteroot/assets

# 1. dg-node builds its skeleton and its database, and must have run once so its
#    generated settings/*.json exist (build-assets.js copies them):
(cd "$DG_NODE_PATH" && npm run build-db && npm run build-search-db && npm start &)

# 2. the app's slice of that database, and the TOC snapshot (needs a server on :3000)
npm run build-app-db -- --langs=ru,en
npm run build-toc-snapshot

# 3. the web bundle: page, then the core, then everything they reference
npm run build

# 4. the APK
npm run sync-android
(cd android && ./gradlew assembleDebug)
```

## Checking it still matches the site

Neither check needs the corpus, a device, or production.

```bash
# a database in dg.db's real schema, small enough to read
node test/make-fixture-db.js "$DG_NODE_PATH/dg.db"

# capture what the SITE answers — dg-fastify.js runs on the fixture, so this is the site itself
(cd "$DG_NODE_PATH" && PORT=3000 npm run start:fastify &)
node test/capture.js --base=http://localhost:3000 --out=test/snapshots/site

# the same core the site just used, run the way the app runs it
npm run test-parity

# and the whole app, in a browser: its worker downloads the database into OPFS and answers
node test/serve-local.js www dist 8097 &
npm run test-e2e
```

Both compare against `test/snapshots/site` and print a per-case SAME/DIFF. A DIFF is either a bug
or a decision someone has to make on purpose — which is the point of having the files.

CI does exactly this — see `.github/workflows/build-app.yml`. Which dg-node commit it builds from
is pinned in **`DG_NODE_REF`** (a branch name or tag); a `workflow_dispatch` run can override it.

## Known debt

- **`build-assets.js`'s asset list is hand-maintained** — a new `<script>` on the site must be
  added there too. Planned replacement: crawl a running dg-light.js and save every 200 response at
  its own URL path. The page itself no longer has this problem (`build-page.js` generates it).
- **First install now needs room for two copies.** The download lands as a file (Android's
  DownloadManager writes it) and is then imported into OPFS, so the peak is ~340MB before the
  temporary copy is deleted. The streaming path that went straight into OPFS still exists and is
  what runs in a browser; it costs half the disk and cannot survive the app being backgrounded,
  which is why it is the fallback rather than the default.
- **Updates are whole-file, not incremental.** Every published database now records what it
  contains — a `meta` table with a `build_id`, and a `chunks` table hashing each
  (sutta, kind, lang, translator) — and `db-manifest.json` is published beside it, so a device asks
  "is there anything new for me?" for a few hundred bytes and is offered the current build through
  Settings. What it cannot yet do is take just the difference: the `chunks` tables of two builds
  are exactly the patch, and computing one needs neither the old 170MB file nor the corpus, but
  nothing builds or applies them yet. `manifest.patches` is the empty list they will arrive in.
- **`filterPreferredTranslators` still decides by file path**, so the core synthesises one from
  `DG_OFFLINE` and the bundle has to shim `path.join`. It should decide on the `source` column the
  database already carries.
- **The regex search path scans the whole table** — a few seconds rather than milliseconds,
  because FTS5 cannot express alternation. Marked `ponytail:` in the core.
- **`?script=` (Devanagari, Thai, …) does not work offline** — it needs Aksharamukha, which runs
  Python under Pyodide on the server. This was already true before.
- **iOS has not been started** — `npx cap add ios` has never been run. Nothing about the data
  layer is Android-specific, so this is packaging work rather than a port.
- **Never run on a real device or emulator.** Everything above is verified in Chromium on a
  desktop. OPFS behaviour in Capacitor's WebView, storage limits, and the App Shortcuts are the
  open questions a first install answers.
