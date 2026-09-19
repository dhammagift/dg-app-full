# iOS: материалы для просмотра (прогоны 156–160)

Папка-выгрузка: всё, что снято и сломано в последних прогонах, чтобы смотреть файлами, а не в чате.
Скриншоты — не макеты, а снимки **симулятора** (снаружи, `xcrun simctl io … screenshot`), сделанные в
тот момент, когда страница сама сказала «я на этом экране» (`test/ios-sim/drive.sh --tour`).

## Скриншоты тура, прогон 156 (онлайн, сборка `4d0f2cc`)

| Папка | Устройство | Размер PNG | Годится в App Store? |
|---|---|---|---|
| `tour-156/6.7-inch/` | `DG-6.7` из iPhone 16/17 Pro Max | 1284×2778 | да, это принимаемый размер 6.7″ |
| `tour-156/6.9-inch/` | iPhone 17 Pro Max | 1320×2868 | да, принимаемый размер 6.9″ |

По 7 экранов в темах/языках (`light-en`, `dark-en`, `dark-ru`): `home` (стартовый поиск с
результатами по `kacchapa`), `search`, `reader` (`dn22:2.2`), `settings` (шторка настроек),
`dictionary` (быстрый модал, вкладка **Dict**), `favorites-history`, `toc`.

- `tour-156/app-console.log` — лог приложения за тур: `DgShortcuts set` → `{"count":0}` на старте и
  `{"count":1}` после открытия сутты (динамические шорткаты наполняются из истории).
- На 6.9″ две картинки повторяют предыдущий экран (`reader-dark-en` = `settings-dark-en`,
  `dictionary-dark-ru` = `favorites-history-dark-ru`) — в том проходе шторка и вкладка Dict не
  открылись. На 6.7″ повторов нет, этот набор эталонный.

## Самопроверка в офлайн-симуляторе, прогон 157 (`selftest-157/`)

`selftest.json` — отчёт самого приложения (не мой пересказ): `capacitor://localhost`, secure context,
OPFS, библиотека импортирована (`local: true`, `build_id 714f58cdbdebdfe5`), 8/8 локальных ответов,
`linkCheck` 4 проверенных / 33 внешних / 23 маршрута, 0 ошибок, `pageChecks` 12 страниц в 7 областях,
0 ошибок, движок речи `plugin` (68 голосов, `speaks ended`), `DgDownload` нашёл архив в Application
Support, `DgShortcuts` отдал динамический шорткат на `/dn22:2.2`, `signInUrl` с `&plat=ios`,
`viewport inner 402x812 of screen 402x874` (safe area на месте).
`ios-light-en.png`, `ios-dark-en.png`, `ios-dark-ru.png` — стартовая страница в этих темах.

## Почему TestFlight ещё не залился: четыре последовательных отказа

| Прогон | Что сказал Xcode | Причина | Лог |
|---|---|---|---|
| 156 | «Your team has no devices from which to generate a provisioning profile» + «No profiles … iOS App Development» | в конфигурации Release стоял `CODE_SIGN_IDENTITY = "iPhone Developer"` → просили development-профиль, а он перечисляет UDID устройств, которых у нового аккаунта нет | `logs/ios-archive-run156.log` |
| 160 | «has conflicting provisioning settings … automatically signed for development, but a conflicting code signing identity Apple Distribution has been manually specified» | попытка №1: подменить identity флагом командной строки при automatic signing | `logs/ios-archive-run160.log` |
| 162 | то же самое | попытка №2: та же identity, но в конфигурации Release — Xcode отвергает явную identity при `CODE_SIGN_STYLE = Automatic` в любом виде | `logs/ios-archive-run162.log` |
| 164 | снова «no devices … iOS App Development» | попытка №3: identity убрана совсем — и automatic signing снова выбрал development-профиль, то есть без identity это и есть значение по умолчанию | `logs/ios-archive-run164.log` |
| 165 (идёт) | — | попытка №4, ровно то, что советует сам текст ошибки: `CODE_SIGN_IDENTITY = "Apple Distribution"` **вместе с** `CODE_SIGN_STYLE = Manual` в Release (Debug остался Automatic), `-allowProvisioningUpdates` создаёт профиль | — |

Team ID команды — `7MXRJUJ7C3` (две J подряд). В первой редакции этих документов и в AASA на сайте
стояло `7MXRJU7C3`: я неверно прочитал скриншот страницы App ID, владелец поправил секрет дважды, и
увеличенный фрагмент того же скриншота подтвердил `…JUJ7C3`. AASA в dg-node исправлена на
`7MXRJUJ7C3.gift.dhamma.mobile` и ждёт деплоя сайта.

## Словарь: сеть у приложения есть, ломается именно этот запрос

Прогон 164 добавил в тур зонд, и он ответил: `origin=capacitor://localhost`, `caches=object`,
`onLine=true`, `dictScript=function`, `https://dhamma.gift/manifest.json -> 200 4605B`, а
`config/ai-search.json` приходит как 404 вместе с телом на 31 КБ (то есть ответ доезжает целиком).
При этом запросы за DPD падают с `Request url is not HTTP/HTTPS` — сообщение WebKit, которое не
называет виновника. В прогоне 165 зонд спрашивает ещё и маленький файл из того же каталога
(`pali-lookup-standalone.js`, 10 КБ) рядом с большим `dpd_i2h.js` (6 МБ): если маленький придёт, а
большой упадёт — дело в размере ответа, а не в схеме или пути.

## Что ещё изменилось из-за этих прогонов

- `test/ios-sim/drive.sh` — планшетный проход падал за секунду без вывода: имя `iPad Pro 13-inch (M5)`
  уходило в `grep -E`, скобки становились группой регулярки, а под `set -o pipefail` падал сам
  `UDID=$(…)`. Теперь `grep -F`, и промах печатает имя плюс список доступных устройств.
- `src/native-bridge.js` — ридер показывает «Couldn't load the dictionary. Try again.» даже в
  онлайновом прогоне, а у одной надписи три разные причины (нет `CacheStorage`; `navigator.onLine`
  false; упавший fetch). Добавлены три строки `console.warn('[dg-dict] …')`, чтобы следующий
  `app-console.log` назвал причину. Это же касается жалобы «словарь офлайн с ошибками».

## Что осталось

1. Прогон с фиксом подписи → IPA в TestFlight, затем 6 проверок на устройстве
   (список в `docs/IOS_ACCOUNT_DAY.md`).
2. Задеплоить dg-node, чтобы прод отдавал AASA с `7MXRJUJ7C3`
   (`curl -s https://dhamma.gift/.well-known/apple-app-site-association`).
3. Выбрать из `tour-156/6.7-inch/` три картинки для страницы App Store (порядок в
   `docs/APP_STORE_LISTING.md`).

Папка `ios-screenshots/` (в git не попадает) остаётся рабочей копией; эта папка — то же самое, но
зафиксировано в репозитории. После выбора скриншотов для магазина её можно удалить.
