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
build-assets.js          www/assets, www/reader, ... <- dg-node (incl. its built offline layer) + legacy assets + src/
build-toc-snapshot.js    www/api-snapshots/*.json <- a running dg-fastify.js
android/                 Capacitor Android project, incl. hand-written native source
test/                    the fixture, the site snapshots, and the parity checks
www/                     GENERATED, gitignored
```

## How the app works at runtime

There is no server on the device, and no Node runtime either.

`src/app.js` replaces `window.fetch` before any other script on the page can run. What answers
those calls is **dg-node's own `core/search-core.js`** — the same module the site runs — bundled
by dg-node's `npm run build-offline` and executing in its `public/offline/db-worker.js` over the same database
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
synchronous access is what lets SQLite read a ~600 MB file from storage instead of holding it in
memory, and what lets the core, written against `node:sqlite`, run unchanged.

It is **not** bundled in the APK. It is prod's own `dg.db`, published as
`dhamma.gift/mobile-data/dg.db.gz` (~216 MB) with `db-manifest.json`. The worker downloads the archive
into OPFS, continuing any interruption with a Range request, and only then unpacks it. The Android
side (DgDownloadService) keeps the process alive and shows progress in a notification.

## Building locally

Needs a dg-node checkout, the legacy `dg` asset tree, and the corpus data that dg-node's
`siteroot/data/` symlinks point at.

```bash
npm install

export DG_NODE_PATH=../dg-node          # default: /var/www/html/nodejs
export DG_LEGACY_ASSETS=../dg/assets    # default: $DG_NODE_PATH/siteroot/assets

# 1. dg-node builds its database and its offline layer, and must have run once so its
#    generated settings/*.json exist (build-assets.js copies them):
(cd "$DG_NODE_PATH" && npm run build-search-db && npm run build-offline && npm run start:fastify &)

# 2. the TOC snapshot (needs a server on :3000)
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
  added there too. Planned replacement: crawl a running dg-fastify.js and save every 200 response at
  its own URL path. The page itself no longer has this problem (`build-page.js` generates it).
- **Download on a real network** is what a phone release must still confirm: resume after a dropped
  connection and after the app is killed, then unpack (tested in Chromium by dg-node's
  `test/offline-resume.js`, both plain and gzip).
- **Updates are whole-file, not incremental.** `db-manifest.json` carries the build id, so a device
  learns about a new build for a few hundred bytes, but takes the whole archive.
- **`filterPreferredTranslators` still decides by file path**, so the core synthesises one from
  `DG_OFFLINE` and the bundle has to shim `path.join`. It should decide on the `source` column the
  database already carries.
- **The regex search path scans the whole table** — a few seconds rather than milliseconds,
  because FTS5 cannot express alternation. Marked `ponytail:` in the core.
- **`?script=` offline covers the main Pali scripts only** (dg-node's pali-script.js: Devanagari,
  Thai, Sinhala, Khmer, Burmese, Tibetan, ...). Other scripts and word-click transliteration back to
  IAST (/api/transliterate) still need the network.
- **iOS has not been started** — `npx cap add ios` has never been run. Nothing about the data
  layer is Android-specific, so this is packaging work rather than a port.
- **Parity snapshots are from 2026-09-05** (`test/snapshots/site`, a fixture database). CI compares the
  app against them and does not fail on DIFF, so text and several search answers are not proven equal
  to the current site.