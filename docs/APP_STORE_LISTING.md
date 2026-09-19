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
The texts come from SuttaCentral and from the Dhamma.gift translation project. Dhamma.gift is a non-commercial project: no advertising, no tracking, and no account required — signing in with Google is optional and only syncs favourites and notes between your devices.

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
| Contact Info → Email address | только если человек вошёл через Google (Firebase Auth) | да | App Functionality (синхронизация избранного и заметок) | нет |
| User Content → Other user content (избранное, заметки) | только при входе | да | App Functionality | нет |
| Identifiers → User ID | только при входе (Firebase uid) | да | App Functionality | нет |

Всё остальное — «Data Not Collected»: аналитики нет, рекламы нет, геолокации нет, контактов нет,
трекинга нет (`NSPrivacyTracking = false`). Если решим не декларировать ничего, единственный способ —
убрать вход Google, но он нужен для синхронизации.

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
