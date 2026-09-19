# App Store: тексты для листинга (готово к копированию)

Основной язык листинга — English (U.S.) (как выбрано в App Store Connect). Все лимиты проверены
скриптом: подзаголовок ≤30, промо-текст ≤170, ключевые слова ≤100, описание ≤4000.

## Подзаголовок (Subtitle, 28/30)

```
Pāli Canon reader and search
```

## Промо-текст (Promotional Text, 142/170)

Его можно менять без ревью — удобно для текущих новостей.

```
Read and search the Pāli Canon offline: Suttas and Vinaya with Russian and English translations, tap-to-look-up dictionary and text-to-speech.
```

## Ключевые слова (Keywords, 84/100)

Без пробелов после запятых — пробелы съедают лимит.

```
pali,canon,sutta,vinaya,tipitaka,theravada,buddhism,dhamma,reader,dictionary,offline
```

## Описание (Description, 1490/4000)

```
Dhamma.gift is a free reader and search for the Pāli Canon — the Suttas and the Vinaya — in Pāli with Russian and English translations.

SEARCH
Full-text search over the whole canon: infix matches (kacchapa finds mahākacchapānaṁ), diacritics optional, word variants, filters by collection and by translator, and a match context that opens straight in the reader.

READER
Read a text beside its translation, switch reading modes, change the script (Devanagari, Thai, Sinhala, Burmese and more), and listen to the text with the built-in voice. Favourites, reading history and notes stay on the device.

OFFLINE
The complete offline library — the search database and the texts — can be downloaded once (about 216 MB), after which search, reading, the table of contents and the dictionary work without any connection. Until then the app works online, exactly like the website.

DICTIONARY
Tap any Pāli word while reading to look it up in the built-in dictionary.

TOOLS
Pāḷi study tools along the way: line-by-line reading, word lists, list comparison, edition abbreviations, declension and conjugation tables, and a memorisation view.

LANGUAGES
Pāli, Russian and English.

WHERE THE TEXTS COME FROM
The texts come from SuttaCentral and from the Dhamma.gift translation project. Dhamma.gift is a non-commercial project: no advertising, no tracking, and no account required — signing in is optional and only syncs favourites and notes between your devices.

May all beings be happy.
```

## Ссылки и поля

| Поле | Значение |
|---|---|
| Support URL | `https://dhamma.gift/docs/` |
| Marketing URL | `https://dhamma.gift/` |
| Privacy Policy URL | `https://dhamma.gift/docs/policies` (файл `assets/common/privacy.html` ведёт именно туда) |
| Copyright | `Dhamma.gift` |
| Category | Primary: Education · Secondary: Books (или Reference) |
| Age rating | 4+ (нет пользовательского контента, нет рекламы) |
| Price | Free |

## App Privacy (анкета)

Приложение само по себе ничего не отправляет: избранное, история и настройки лежат на устройстве.
Что декларировать честно:

| Данные | Когда | Связь с личностью | Использование | Трекинг |
|---|---|---|---|---|
| User Content → Other user content (избранное, заметки) | только при входе по кодовой фразе | да | App Functionality | нет |
| Identifiers → User ID | только при входе (Firebase uid) | да | App Functionality | нет |

Всё остальное — «Data Not Collected»: аналитики нет, рекламы нет, геолокации нет, контактов нет,
трекинга нет (`NSPrivacyTracking = false`). Email не собирается: в iOS-сборке кнопка входа через
Google скрыта (`src/native-bridge.js`, Guideline 4.8 — сторонний вход требует Sign in with Apple
рядом), остаётся только анонимный вход по кодовой фразе.

## App Review Information

**Sign-in required — снять галочку.** Вход необязателен, все функции работают без аккаунта; ревьюеру
логин не нужен.

**Notes** (поле под Contact Information; вставлять как есть):

```
Dhamma.gift is a free, offline-first reader and search engine for the Pali Canon (the Buddhist
suttas and Vinaya) with a built-in Pali dictionary and text-to-speech. No account is required.

The app's core is a text library that lives on the device: after a one-time download, search, the
table of contents, every text, its translations and the dictionary work with no network at all.
Online mode is the fallback for people who have no space for the library or are always connected:
the same search and reader then run against our server (dhamma.gift).

NATIVE APP FEATURES (not available in the browser version)
- Offline library: a ~200 MB download (~590 MB on the device) with the whole canon and its
  translations, fetched through a background URLSession — the download survives the app being
  backgrounded and the screen being locked. Search runs on the device against that database.
- Pali dictionary (Digital Pali Dictionary): tap any Pali word in a text; the dictionary is cached
  on the device after the first use and works offline.
- Text-to-speech via AVSpeechSynthesizer: tap any Pali or English paragraph — it gets highlighted
  and a play button appears in the lower right corner.
- Share Extension: select text or a link in any other app → Share → Dhamma.gift, and the app opens
  a search for it — instant lookup of a passage from any site or app.
- Home-screen quick actions: four fixed items (table of contents, favorites & history, memo,
  dictionary) plus the texts read most recently.
- Universal Links: https://dhamma.gift/mn1 tapped in Notes or Messages opens the text in the app.

BASIC TEST — OFFLINE (5–15 minutes, depends on network speed; this is the core of the app)
1. Launch the app. On the home screen, tap "Download the offline library" in the notice under the
   search field (also: burger menu → Settings → Offline library → Download). Progress is shown in
   the app; the download continues in the background and while the screen is locked.
2. When it finishes, turn on Airplane Mode.
3. Type "kacchapa" in the search field and press Search. Results come from the local database.
4. Tap any result to open it in the reader; switch the Pali/translation view, scroll the text.
5. Tap a Pali word: the dictionary popup opens, still offline.
6. Tap a paragraph and press the play button: the text is read aloud.
7. Turn Airplane Mode off. The library can be deleted at any time: Settings → Offline library →
   Delete.

BASIC TEST — ONLINE (about 1 minute)
Cancel or skip the download and repeat steps 3–6: search results and texts then come from
dhamma.gift, so everything can also be checked without waiting for the download.

SIGN-IN
Signing in is optional and is not needed for any feature. It only turns on syncing favorites and
notes between devices, with an anonymous passphrase — no email, no third-party sign-in, no
personal data.

CONTENT
Pali texts and translations come from SuttaCentral and the project's own translations; the
dictionary is the Digital Pali Dictionary (DPD). All are used under their respective open
licenses. The app is free, all content is included, there are no in-app purchases, no ads, no
analytics and no tracking.
```

Цифры (размер базы, число голосов) при отправке сверить с текущей сборкой: `selftest.json` в
`docs/ios-review/` даёт число голосов; размер базы — артефакт `dg-app-full-db-<прогон>`.

## Скриншоты

App Store Connect для этого приложения принимает (iPhone): **1242×2688** или **1284×2778**
(портрет). Кадр 6.9″ (1320×2868) в этом слоте не примут, поэтому тур снимает дополнительно на
**iPhone 13 Pro Max** (1284×2778) — размер из списка. iPad: **iPad Pro 13″** (нужен, потому что
приложение объявлено для iPhone и iPad).

Показываются **первые три** кадра каждого размера — они и должны продавать:

1. `search` — результаты поиска с подсветкой
2. `reader` — текст с переводом
3. `dictionary` — вкладка словаря (или `settings`, если кадр словаря окажется пустым)
4. дальше: `favorites-history`, `settings`, `toc`, `home`

Файлы лежат в артефактах джобы `ios-screenshots` (`dg-app-ios-screenshots-<номер прогона>`).
