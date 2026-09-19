# App Store скриншоты и превью (iOS)

`screenshots/` и `previews/` — материалы для страницы приложения в App Store Connect. Реальные
снимки/видео симулятора (`test/ios-sim/drive.sh --tour`), не макеты.

## screenshots/iphone-6.7in-1284x2778/

Прогон 156, сборка `4d0f2cc`, эталонный набор без повторов — тема light, локаль en.

1284×2778 — принимается в слот **iPhone 6.5" Display** в App Store Connect (наряду с
1242×2688). Порядок и состав — по `docs/APP_STORE_LISTING.md`:

1. `01-search.png` — поиск с подсветкой
2. `02-reader.png` — текст с переводом
3. `03-dictionary.png` — словарь
4. `04-favorites-history.png` — избранное/история
5. `05-settings.png` — настройки
6. `06-home.png` — стартовый экран

Показываются в листинге первые 3 — их порядок продаёт приложение, менять с осторожностью.

Другие темы/локали (dark-en, dark-ru) и набор 6.9" (`1320×2868`, неполный: нет search/reader/
favorites-history/settings в light-en) — в `docs/ios-review/tour-156/`.

`screenshots/iphone-6.7in-1284x2778/latest-tour/`, `screenshots/iphone-6.9in-1320x2868/`,
`screenshots/ipad-13in/` — сырой вывод
джобы `ios-screenshots` (`.github/workflows/build-app.yml`), она сама коммитит их сюда после
каждого прогона (см. ниже почему не через артефакт). iPad раньше не собирался (баг в
`drive.sh`, чинили в run 158+) — теперь собирается, кадры появятся после первого прогона с этим
изменением.

## App Previews (видео) — `previews/iphone-6.7in-1284x2778/`

3 клипа (`preview-1-search.mov`, `preview-2-reader.mov`, `preview-3-dictionary.mov`), 1284×2778,
H.264, без звука, каждый ≤29с. Не отдельная постановочная съёмка — это один и тот же light-en
прогон тура (`drive.sh --tour --record`), нарезанный по временным меткам стадий
(`test/ios-sim/make-previews.js`) на 3 куска: home→reader, reader→dictionary,
dictionary→done (dictionary+favorites-history+toc). Экран каждый раз настоящий: то же самое
приложение, тот же поиск/ридер/словарь, что и на скриншотах.

## Почему тут появляется CI-коммит, а не только артефакт

Артефакт джобы (`dg-app-ios-screenshots-<run>`) лежит на `productionresultssa19.blob.core.windows.net`
— это не `github.com`, и в этой сессии такой хост заблокирован сетевой политикой (см. run 174,
скачать не удалось). Поэтому джоба сама коммитит скриншоты и превью в эту ветку последним шагом
(`git push`, `[skip ci]`, чтобы не зациклить сборку) — их можно забрать обычным `git pull`, без
похода за артефактом.
