# Dict.Dhamma.Gift — Capacitor app

The dictionary (`gift.dhamma.pali`) as a Capacitor Android app. It replaces the Bubblewrap Trusted
Web Activity that used to live in `dg-twa/dict-app`; that module still exists there but is
superseded by this one.

## What it is

A thin shell. `capacitor.config.json` sets `server.url` to `https://dict.dhamma.gift/`, so the site
IS the app's interface — the same UI a browser gets, with no second copy to keep in step. What the
app adds is only what a web page cannot do.

Nothing is bundled offline here; the dictionary's offline mode is a separate, much larger project
(see ddg-ui#7).

## Why Capacitor and not the TWA

Both reports the migration answers come from what a TWA actually is — Chrome's Custom Tab, which the
app does not own:

- **standalone didn't work**: a Custom Tab still shows Chrome's own chrome and follows Chrome's
  display mode, not the app's.
- **the burger panel "flew away"**: it is a bottom sheet positioned against a viewport that Chrome
  resizes as its URL bar hides and shows.
- **no history in the launcher shortcuts**: a web manifest's shortcuts are static, and a TWA cannot
  reach `ShortcutManager` at all.

A WebView this app owns has none of those limits, and `DgShortcutsPlugin` can put the reader's own
lookup history into the long-press menu.

## Layout

| Path | Committed | What it is |
|---|---|---|
| `src/` | yes | The app's own web sources: `dict-bridge.js` (see below) and the no-connection `index.html`. |
| `www/` | no (build output) | `src/` copied here by `build.js`; `cap sync` packages it into the APK. |
| `android/` | yes | The Capacitor Android project: `MainActivity`, `DgShortcutsPlugin`, `DgDictTileService`, the manifest, `res/xml/shortcuts.xml`, the icons carried over from the TWA. |
| `test/bridge-ui.js` | yes | Browser check for the injected rows (see below). |

## App-only UI

`src/dict-bridge.js` is not part of the website. `MainActivity` injects it into the loaded page with
`WebViewCompat.addDocumentStartJavaScript` (and, on WebViews older than Chrome 105, through a
`WebViewListener` on every page load), so it only ever exists inside the app — opened in a browser,
it returns immediately because there is no Capacitor runtime.

It appends three rows to the end of the site's own burger panel (`#p-menu .pb`), styled with the
site's own classes so they do not look bolted on:

- **Recent words in app shortcuts** — the switch that decides whether the launcher's long-press menu
  shows the four programmed shortcuts (`res/xml/shortcuts.xml`) or Favorites & History plus three
  recent words. Off by default, like the reader app's equivalent.
- **App version** — `versionName (versionCode)`, prepended to the injected script by `MainActivity`
  (the site has no way to know it).
- **Rate Us** — opens the Play listing. Its button is `5️⃣⭐️🙏` — three emoji at one size, smaller
  than the 22px switch beside it (emoji render taller than their font size, so 16px sits below it):
  a masked glyph next to an emoji cannot be made to match, and 11.5px, the site's own action-button
  size, was reported first as too small and then as too large at 22px.
  Tapping it sets `dgRateUsTapped` in localStorage but **does not hide the row** — the row is
  permanent. The flag is for the "please rate us five stars" invitation, which does not exist yet in
  this app or in the reader one; it is written now so that prompt has an answer ready, and it must
  be the thing that decides, not a second flag invented later.

## Launcher shortcuts

**Exactly one** static shortcut ships in `res/xml/shortcuts.xml`: DG Favorites & History.

That is the whole trick, and it is the part the migration got wrong twice. The launcher's long-press
menu holds four entries, and it counts what the manifest DECLARES against that budget **even when a
declared shortcut is disabled at runtime**. The reader app learned this first (`dg-apps` adcd32d:
"four static shortcuts left room for two 'recently read' texts, not three"), then went back to four
declared statics while hiding three with `disableShortcuts()` (3b08f69) — and the dictionary app
copied that shape, which is why the owner counted two history entries out of three while the row
itself said "Сейчас: 3".

So everything else is dynamic, and `DgShortcutsPlugin` pushes whichever set the switch asks for:

| switch | dynamic entries | plus the static |
|---|---|---|
| on (default) | up to three recent words from `history-list` | DG Favorites & History |
| off | Table of Contents, Dharmamitra.org, Aksharamukha.com | DG Favorites & History |

Four entries either way, and the plugin no longer disables anything — there is nothing to disable.

Icons: a dynamic shortcut must be handed a drawable, so the page names one per entry — `shortcut_0`,
`_2`, `_3` for the three programmed entries, which is the artwork they had while they were static,
resolved by `DgShortcutsPlugin.iconFor()` at runtime. A recent word names none and gets the app's
own mark.

History **only**: the dictionary has no favourites in this set (owner: "не нужно брать избранное. в
словаре только история слов"). Each route comes from the site's `dictUrl()`, so a shortcut opens
exactly the address the history entry does.

Pushes happen on page load, once four seconds later (the reader app's own belt: the first visit of a
session has nothing in history yet), on every lookup — the bridge wraps the site's `addToHistory()` —
and when the app is backgrounded (`appStateChange` *and* `visibilitychange`, since either can be the
only one that fires on a given device). The switch's row states how many entries the app is handing
over, and adds what Android accepted when the two disagree.

Favorites & History carries the full wording in BOTH labels — "DG Favorites & History" — because the
launcher renders the SHORT label: an abbreviated one is all a reader ever sees. `DG ` is there because
the reader app declares a shortcut with exactly that name, both apps can sit on one phone and both
open dhamma.gift/4as.

## The system bars

`capacitor.config.json` sets `plugins.SystemBars.style = "DARK"` — dark bars, therefore LIGHT icons,
in both themes. Capacitor's default (`DEFAULT`) takes the icon colour from the SYSTEM night mode,
which is the bug this answers (owner, 2026-09-24: "часы батарейка не видны. темный фон на темном"):
on a phone in light mode the clock and battery were drawn dark on the site's dark header and were
invisible — the same failure dg-app-full hit with the old StatusBar plugin. The strip itself is
`@color/dg_navbar` (#111111), the dictionary's own dark page colour, so a strip that does show reads
as part of the page rather than as a band of a slightly different black.

## The back gesture

Capacitor's own default, with no listener registered, is a bare `WebView.goBack()` and nothing else —
so from the dictionary's home screen a reader presses Back and the app simply sits there, and with
the burger panel open it does not close either. `dict-bridge.js` registers a `backButton` listener
and takes the three steps in order: close an open panel, else `history.back()` when there is anywhere
to go, else leave the app. The reader app wires the same thing for its own modal
(`src/native-bridge.js`).

## Building

Needs JDK 21 (Capacitor 8 / AGP 8.13) and the Android SDK.

```bash
npm install
npm run sync-android                      # src/ -> www/ -> android/.../assets/public
cd android
JAVA_HOME=/path/to/jdk-21 ./gradlew assembleDebug      # adb install app-debug.apk
JAVA_HOME=/path/to/jdk-21 ./gradlew assembleRelease    # unsigned unless ANDROID_KEYSTORE_* is set
```

`versionCode` is 3 — the first code Play has not already seen for `gift.dhamma.pali` (the TWA
shipped 2). Override it with `-PdgVersionCode=N`.

Release signing uses the same environment variables as the reader app
(`ANDROID_KEYSTORE_PATH`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`);
with none of them set the release build is simply unsigned.

## Checking the app-only rows

```bash
node test/bridge-ui.js
```

Loads the real site with a mocked Capacitor runtime (recording what `DgShortcuts.set` and
`Browser.open` are called with), injects the real `dict-bridge.js`, and asserts the rows, their
wording in both languages, their position at the end of the panel, the routed history handed to the
plugin, the switch's effect on it, and the store URL Rate Us opens. Screenshots land in
`/var/www/html/dict-app` (served at http://old.dhamma.gift/dict-app/) unless `DG_SHOTS` says otherwise. It cannot run a WebView or a
launcher, so the APK itself still needs a real device.

## Continuous integration

Two jobs in `.github/workflows/build-app.yml`, deliberately separate from the reader app's `build`
job: that one exists to produce the offline library (a dg-node checkout, a ~213MB database built on
the runner, the TOC snapshot) and none of it is needed here — the dictionary's UI is the live site,
so there is no `www/` to generate.

- **`dict-build`** — `npm ci`, `npm run sync-android`, then the Gradle tasks. Runs on every tag and
  on every manual run. Uploads three artifacts: `dg-dict-apk-<run>` (debug, installable straight
  away), `dg-dict-apk-release-<run>` and `dg-dict-aab-release-<run>`. `versionCode` is the run
  number (`-PdgVersionCode`), like the reader app — it must only ever climb, and the TWA last
  uploaded 2 under this package id.
- **`dict-release`** — the same gate as the reader app's `android-release`: a tag, or a manual run
  with `release: play` / `both`. Uploads `gift.dhamma.pali` to the **internal** track of Google
  Play. With `release: none` (the default) it does not run, so a manual run never burns a
  versionCode in the console. Promoting internal → production stays a human decision.

Both jobs use the secrets that are already in the repository, under the same names the reader app
uses (`ANDROID_KEYSTORE_BASE64 || KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD || KEYSTORE_PASSWORD`,
`ANDROID_KEY_ALIAS || KEYSTORE_ALIAS`, `ANDROID_KEY_PASSWORD || KEY_PASSWORD`,
`PLAY_SERVICE_ACCOUNT_JSON`), and the same Play service account — it already holds "Release apps to
testing tracks" on `gift.dhamma.pali`, because dg-twa's workflow uploaded this package with it. The
release assets are not attached to the reader app's GitHub release on purpose: that page already has
two Android files that are easy to confuse.

## Not done here

- **Nothing is published to any store by hand.** The Play path above is dormant unless someone picks
  `release: play` or pushes a tag.
- **iOS**: this project is Android-only. The App Store build does not exist yet, which is also why
  the Rate Us row in the reader app has an empty `DG_IOS_APP_ID` and falls back to an App Store
  search.
- **The old TWA module** (`dg-twa/dict-app`) and its CI job still exist; retiring it from Play is a
  separate decision. Both apps currently share one package id, so whichever uploads last wins —
  nothing should be promoted to production on `gift.dhamma.pali` until the TWA job stops running.
