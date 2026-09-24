# Передача задачи: iOS-приложение (состояние на 19.09.2026, вечер; дополнено 19.09 утром UTC)

Ветка `claude/ponytail-full-9vo71m` = `main`, head `565d09f` (19.09, 16:10 UTC).

## Задачи на следующую сессию (записано 20.09, ночь)

### 1. Офлайн в Share Extension через App Group — главная

Замысел владельца, и он правильный: **качать `dg.db` сразу в контейнер App Group обычным файлом, и
читать этот один read-only файл из обоих процессов** — из приложения и из расширения. Отдельная база
расширению не нужна, OPFS уходит совсем.

Что это чинит разом:

- **Офлайн в шторке.** Сейчас расширение грузит страницу с сайта, без сети там надпись «сайт
  недоступен». Причина: поиск живёт в SQLite-WASM внутри веб-вью и читает OPFS, а OPFS привязан к
  процессу — другой процесс его не видит. App Group шарит файлы, не OPFS.
- **Лишние 206 МБ.** На iOS база сейчас лежит дважды: архив `dg.db.gz` (206 МБ, качает
  `DgDownloadPlugin` фоновой `URLSession` — иначе закачка не переживает блокировку экрана) и
  распакованная копия в OPFS (584 МБ). Архив не удаляется: у плагина есть только `existing`,
  `start`, `cancel`. На Android этой беды нет — там `DgDownloadService.java` только держит процесс
  и шлёт прогресс, а веб-вью качает прямо в OPFS, одна копия.
  **Никакой отдельной «уборки архива» делать не надо** — в новой схеме архив распаковывается в общий
  файл и удаляется сразу, а не живёт вечно.

Где шов, благодаря которому логику поиска переписывать не придётся
(`/var/www/dg-node-test/public/offline/db-worker.js`, ~строка 102):

```js
// dg-node's core was written against node:sqlite's prepare().all()/.get()
prepare(sql) { all: (...params) => oo1db.selectObjects(sql, params) }
```

Всё ядро поиска разговаривает с базой через этот адаптер. Подменить под ним sqlite-wasm+OPFS на
нативный SQLite, читающий общий файл, — и ядро не трогается.

Главная сложность: **ядро вызывает `.all()` синхронно**, а вызов нативного плагина асинхронный.
Рабочий путь — синхронный XHR из воркера в обработчик схемы Capacitor, который выполняет запрос
нативно и возвращает строки; контракт остаётся синхронным. Открывать файл как
`SQLITE_OPEN_READONLY` (+`immutable=1`), чтобы SQLite не пытался создавать `-wal`/`-shm` в общей
папке.

Порядок работ:

1. Включить App Group (`group.gift.dhamma.mobile`) на App ID и в entitlements обоих таргетов — это
   действие владельца в кабинете разработчика.
2. `DgDownloadPlugin`: качать в контейнер группы, распаковывать в `dg.db`, архив удалять.
3. Нативный исполнитель SQL + обработчик схемы; адаптер `prepare()` в `db-worker.js` переводится на
   него (правки в офлайн-слое dg-node — согласовать с владельцем, он просил его не трогать).
4. Миграция для тех, кто уже скачал: проще всего — предложить перекачать, копию в OPFS удалить.
5. Расширение: поднять в нём тот же офлайн-слой поверх общего файла.
6. Android не ломать: там остаётся OPFS-путь, либо переводится тем же адаптером отдельно.

### 2. Довести первый релиз

- Сборка **1.17 (215)** в TestFlight — кандидат. Шаринг в ней онлайновый: шторка показывает страницу
  результатов поиска (`dhamma.gift/?q=…`), ссылка на dhamma.gift открывает сам текст. Проверено
  браузером по трём запросам («океан» → 98 текстов, «mn6» → сутта, мусор → «не нашлось»);
  **на живом телефоне не проверено** — шторка должна показать наш пункт и открыть экран.
- Ручные проверки на телефоне (§6) и карточка в App Store Connect по `docs/APP_STORE_LISTING.md`.

### 3. Тест шторки — только XCUITest

Проверка на Maestro удалена (`caa7f97`): она утверждала «приложение поднялось», то есть ровно то, от
чего отказались. Восемь прогонов ушли на Safari в iOS 26 и ни разу не дошли до нашего расширения.
Причина: Maestro не видит системные кнопки ни по `id`, ни по подписи (имя лежит в
`accessibilityText`), и — хуже — считает выполненным тап по элементу, которого нет на экране. Если
проверку автоматизировать, то XCUITest: он видит дерево доступности целиком и падает честно. Таргет
можно не добавлять в `App.xcodeproj` — отдельный маленький проект через `xcodegen` драйвит уже
установленное приложение.

## Состояние на вечер 19.09 — что НЕ закрыто

### Шаринг (Share Extension) — не победили, ждём проверку сборки 195 на телефоне

Симптом на телефоне (iOS 18+): Share → Dhamma.gift, шторка мигает и исчезает, приложение не
открывается. Это не крэш — расширение штатно закрывается, потому что не смогло открыть приложение.

| Сборка | Способ открыть приложение из расширения | Итог |
|---|---|---|
| 170–186 | `extensionContext.open(url)` | всегда false: метод работает только в Today/iMessage-расширениях |
| 190 | цепочка responder → селектор `openURL:` | iOS 18 принудительно возвращает NO («BUG IN CLIENT OF UIKIT … migrate to open(_:options:completionHandler:)») |
| 193 | `(responder as? UIApplication).open(…)` + `APPLICATION_EXTENSION_API_ONLY = NO` | Xcode 26 отказывается собирать расширение без этого флага |
| **195** | IMP селектора `openURL:options:completionHandler:` с C-сигнатурой и блоком (`ShareViewController.swift`, `openHostApp`) | компилируется; **на телефоне не проверено** |

В 195 любая неудача показывает алерт «Dhamma.gift could not open: <причина>» вместо тихого закрытия.
Три исхода проверки: открылось → готово; алерт → скриншот даёт причину; исчезло молча → крэш,
лог у тестера: Настройки → Конфиденциальность → Аналитика → Данные аналитики (`ShareExtension-…ips`).

Если 195 не открывает приложение — официально поддерживаемый путь один: расширение сохраняет текст в
App Group и показывает локальное уведомление «Искать в Dhamma.gift», тап по нему открывает приложение
(App Group = entitlement `group.gift.dhamma.mobile` у App и ShareExtension + capability на App ID;
чтение при старте в `native-bridge.js` через плагин). Это надёжно, но с лишним тапом.
Источники: developer.apple.com/forums/thread/764570, /763568, /776488.

**Apple Books: расширения там не будет, и это не наш баг.** Шторку «Поделиться» в Books обслуживает
закрытый список приложений — сторонний Share Extension туда не попадает ни с каким
`NSExtensionActivationRule`, хоть `TRUEPREDICATE`: «There are a predefined set of apps allowed to
receive data from Books… not achievable with our presently shipped configurations» (Apple, radar
FB15013575). Поэтому в Books пункта Dhamma.gift нет, и целей для шаринга там заметно меньше, чем в
Safari — Books вообще отдаёт данные только своим. В Safari всё штатно: правило расширения принимает
текст, web-URL и веб-страницу, поэтому оно и висит в шторке (иконкой в верхнем ряду и строкой в
списке действий).
Источники: developer.apple.com/forums/thread/762784, stackoverflow.com/q/78895358.

### Остальные нюансы перед подачей

- **Проверки на телефоне** (§6): тап по слову → словарь (починен в коде, на телефоне не видели),
  озвучка, ссылка `https://dhamma.gift/mn1` из Заметок (AASA обновлён 19.09, CDN Apple кэширует до суток),
  быстрые действия с иконки, прогулка по плиткам главной на iPhone и **iPad** (universal → ревьюер откроет
  на iPad).
- **Карточка App Store Connect**: всё по `docs/APP_STORE_LISTING.md` (описание, ключевые слова, App
  Privacy, Notes для ревью, галочка Sign-in required снята). Скриншоты iPhone 6.7″ **и** iPad 13″ — из
  артефактов `dg-app-ios-screenshots-<прогон>`; кадр `reader` брать из прогона ≥169 (без красной плашки).
- **Ревью-риски, что осталось**: 4.2 (обёртка сайта) — закрыт текстом Notes; 2.3.10 (Android) — текст
  словаря исправлен (ddg-ui `4df60ea`); 4.8 (Google) — кнопка скрыта на iOS; 5.1.1(v) — кнопка
  «Delete account & cloud data» (dg-node `0577c0e`). Content Rights — «да, есть права» (SuttaCentral, DPD).
- **UI-долг (не блокер)**: в ридере при прокрутке текст уходит под часы/Dynamic Island; файлы `-ru` тура
  показывают английский интерфейс.
- **Прод dg-node**: после каждого коммита в dg-node main владелец делает
  `git -C /var/www/html/nodejs pull --ff-only origin main` (песочница агента это блокирует).
- **Рабочая папка**: в `/var/www/dg-apps` параллельно работает другая сессия на ветке
  `claude/dg-ios-apple-preview-screenshots-f6f478`; на её локальной ветке лежит незапушенный дубликат
  `b568769` (то же содержимое, что `dd564fe` в main) — безвреден. Коммиты этой смены делались
  plumbing-ом (`read-tree`/`commit-tree`), не переключая её checkout.
- **TestFlight**: сборки 170–195 все в ASC; тестерам ставить последнюю (195). Внутренняя группа «Dg test»,
  автораздача включена.

## Итог второй смены (19.09, 03:20–05:00 UTC)

- **TestFlight летит.** Прогон 170 (`35420942792`): archive → export → `Upload succeeded`; в App Store
  Connect сборка **1.17 (170)**, статус Ready to Submit. Что решило: в команде не было ни одного
  устройства, а Xcode при Automatic подписывает *архив* development-профилем (distribution
  накладывается на экспорте) — без устройства Apple такой профиль не выдаёт. Владелец зарегистрировал
  одно устройство (Devices → +), Release вернули на Automatic (`f62145c`). Manual (167) без имени
  профиля отвечает «requires a provisioning profile». Fallback-шаг altool удалён (`45cb037`):
  `destination=upload` не пишет IPA на диск, шаг падал с «no IPA was produced» уже после успешной
  загрузки; теперь экспорт проверяет строку `Upload succeeded` в своём логе.
- **Словарь починен.** «Request url is not HTTP/HTTPS» — это Cache API WebKit, не сеть:
  `cache.put('/assets/…')` резолвился в `capacitor://localhost/...`, а Cache API принимает только
  http(s)-ключи (Android с `https://localhost` этого не показывал). Ключ теперь `origin + src`
  (`src/native-bridge.js`). Доказательство — прогон 169, `docs/ios-review/tour-169/app-console.log`:
  `dpd_i2h.js -> 200 5831804B`, ни одного `[dg-dict] fetch failed`, ридер без красной плашки
  (`ios-reader-dark-en.png`). Побочно: Android один раз перекачает словарь (ключ сменился).
- **AASA уже на проде**: `curl -H "Host: dhamma.gift" http://127.0.0.1:3000/.well-known/apple-app-site-association`
  отдаёт `7MXRJUJ7C3.gift.dhamma.mobile` (снаружи с сервера curl к dhamma.gift не ходит — это
  особенность сервера, не сайта). `test.dhamma.gift` отдаёт заглушку `TEAMID` — Apple туда не смотрит.
- **Осталось:** merge в `main` (§5) и шесть проверок на телефоне (§6). Из UI-замечаний по снимкам:
  в ридере при прокрутке текст уходит под часы/Dynamic Island (статус-бар без подложки); файлы
  `-ru` тура показывают английский интерфейс (тур меняет только `langs=ru,en` поиска).

Репозитории: `dg-app-full` (это приложение: Capacitor-обёртка + CI), `dg-node` (сайт, отдаёт AASA и
данные). **Android ломать нельзя** — джобы `build`/APK/AAB в каждом прогоне должны оставаться зелёными.

## 0. Что осталось, коротко

| # | Задача | Состояние |
|---|---|---|
| 1 | Сборка уходит в TestFlight | **сделано** — 1.17 (170) в TestFlight; см. «Итог второй смены» |
| 2 | Встроенный словарь в ридере (`Couldn't load the dictionary`) | **сделано** — ключ Cache API, `f62145c`; проверка на телефоне: тап по слову (§6, п. 3) |
| 3 | Задеплой `dg-node`, чтобы прод отдал AASA с `7MXRJUJ7C3` | **сделано** — прод уже отдаёт |
| 4 | Merge ветки в `main` | `main` отстаёт; `ios-release`/`ios-screenshots` есть только в ветке |

## 1. Что уже проверено и работает (доказательства в прогонах)

- `build` — APK/AAB, база, `www`: зелёный в 156, 157, 160, 162, 164 (Android не задет).
- `ios-build`, `ios-ui` — сборка под симулятор и офлайн-самопроверка приложения: зелёные. Отчёт
  `selftest.json` (прогон 157, лежит в `docs/ios-review/selftest-157/`): `capacitor://localhost`,
  secure context, OPFS, 8/8 локальных ответов, `linkCheck` 4/33/23 и 0 ошибок, `pageChecks` 12 страниц
  / 7 областей и 0 ошибок, речь `plugin` (68 голосов), `DgDownload` нашёл архив в Application Support,
  `DgShortcuts` отдал динамический шорткат на `/dn22:2.2`, `signInUrl` с `&plat=ios`,
  `viewport inner 402x812 of screen 402x874` (safe area).
- `ios-screenshots` — тур по приложению на 6.7″ и 6.9″ (прогоны 160, 164/167): зелёный, включая
  планшетный проход (был сломан, см. §11). Снимки: `docs/ios-review/tour-156/`.
- Подпись: **не** работает. Ниже подробно, потому что это единственное, что мешает TestFlight.

## 2. Задача №1: подпись и TestFlight

Что уже пробовали (все — `xcodebuild archive` в джобе `ios-release`, с ключом ASC и
`-allowProvisioningUpdates`):

| Прогон | Конфигурация Release | Ответ Apple/Xcode |
|---|---|---|
| 156 | `CODE_SIGN_IDENTITY = "iPhone Developer"` (как в шаблоне Capacitor, в обеих конфигурациях) | «Your team has no devices from which to generate a provisioning profile» + «No profiles for 'gift.dhamma.mobile' were found: … iOS App Development» |
| 160 | identity флагом командной строки `CODE_SIGN_IDENTITY="Apple Distribution"` при `CODE_SIGN_STYLE=Automatic` | «has conflicting provisioning settings … automatically signed for development, but a conflicting code signing identity Apple Distribution has been manually specified» |
| 162 | то же значение в конфигурации Release | та же ошибка |
| 164 | identity убрана совсем | снова «no devices … iOS App Development» (значит без identity automatic signing берёт Apple Development) |
| **167** | `CODE_SIGN_IDENTITY = "Apple Distribution"` **+** `CODE_SIGN_STYLE = Manual` в Release (Debug остался Automatic) | ожидание: `-allowProvisioningUpdates` создаёт distribution-сертификат и App Store профиль |

Логи: `docs/ios-review/logs/ios-archive-run*.log` (156, 160, 162, 164 — в репозитории; свежие
скачиваются артефактом `ios-release-logs-<run>`).

**Смотреть в 167 в первую очередь** новый шаг `What signing does Xcode resolve?` — он печатает
identities в keychain и настройки, которые Xcode разрешает для Release и Debug:

```bash
TOKEN=$(tr -d '\n\r' < /root/.secrets/github-token)
curl -sS -L -H "Authorization: Bearer $TOKEN" -H "User-Agent: agent" \
  "https://api.github.com/repos/dhammagift/dg-app-full/actions/jobs/<job_id>/logs" | grep -A 20 "What signing"
```

**Если 167 снова упал** — следующий шаг по убыванию вероятности:

1. Посмотреть в логе, какой `CODE_SIGN_IDENTITY` и `CODE_SIGN_STYLE` реально применены к таргетам, и
   какой профиль Xcode ищет (`No profiles for 'gift.dhamma.mobile' were found: … iOS Distribution`).
2. Добавить в `ExportOptions.plist`/архивацию явный `PROVISIONING_PROFILE_SPECIFIER` — но имя профиля
   надо узнать: либо из лога, либо создать профиль самим через App Store Connect API
   (`POST /v1/bundleIds` → `POST /v1/certificates` (нужен CSR, `openssl req -new`) →
   `POST /v1/profiles` c `IOS_APP_STORE`), сертификат положить в keychain раннера.
3. Крайний вариант, который точно обходит валидацию таргетов: `archive` с
   `CODE_SIGNING_ALLOWED=NO`, затем `-exportArchive` с `signingStyle=automatic` и
   `-allowProvisioningUpdates` — распределительную подпись делает уже экспорт.
4. Проверить, что ключ — **Team**-ключ с ролью **App Manager** (Individual-ключ не имеет доступа к
   provisioning-эндпоинтам): App Store Connect → Users and Access → Integrations → Team Keys.

Секреты (уже сохранены владельцем, `APPLE_TEAM_ID` = `7MXRJUJ7C3` — две J): `ASC_KEY_ID`,
`ASC_ISSUER_ID`, `ASC_KEY_P8` (содержимое `.p8` с BEGIN/END), `APPLE_TEAM_ID`.

После успешной загрузки: сборка появляется в TestFlight через 5–15 минут (сначала «Processing»), в
App Store Connect должна быть создана запись приложения (bundle id `gift.dhamma.mobile`).

## 3. Задача №2: словарь в ридере

Симптом на скриншоте ридера: красная плашка «Couldn't load the dictionary. Try again.», статьи DPD
не открываются и во вкладке Dict (видна только вводная страница).

Что уже известно (прогон 164, онлайновый тур):

```
[dg-net] origin=capacitor://localhost caches=object onLine=true dictScript=function
[dg-net] https://dhamma.gift/manifest.json -> 200 4605B in 696ms
[dg-net] https://dhamma.gift/config/ai-search.json -> 404 31881B in 411ms   ← тело доехало целиком
[dg-dict] fetch failed for https://dhamma.gift/assets/js/standalone-dpd/dpd_i2h.js:
          Request url is not HTTP/HTTPS (onLine=true)
```

То есть: обычные https-запросы из `capacitor://localhost` работают, падает именно запрос за DPD;
сообщение `Request url is not HTTP/HTTPS` — от WebKit (в бандле приложения и в Capacitor его нет) и
виновника не называет. Серверная часть в порядке: прод отдаёт `/assets/js/standalone-dpd/*` с `200` и
`access-control-allow-origin: *` (проверено `curl -H "Host: dhamma.gift"` на самом сервере).

В прогоне 167 зонд спрашивает ещё два URL — `pali-lookup-standalone.js` (10 КБ) и `dpd_i2h.js` (6 МБ)
из одного каталога. Читать в `app-console.log` артефакта `dg-app-ios-screenshots-167`:

- маленький 200, большой падает → дело в размере ответа (тогда: качать нативно через `DgDownloadPlugin`
  или `CapacitorHttp`, а не `fetch`; плитка «словарь» грузится фоном, как библиотека);
- оба падают → дело в пути/схеме (тогда смотреть, чем этот запрос отличается от `manifest.json`:
  тем же `fetch`, но другим URL — например, проверить тот же URL с диска/из Cache API);
- оба 200 → значит в 167 словарь вообще не падал, и тогда смотреть, что было в прогоне 164 (время,
  параллельность: три файла по 6–10 МБ одновременно).

Правки диагностики живут в `src/native-bridge.js` (`console.warn('[dg-dict] …')`) и
`test/ios-sim/tour.js` (`networkProbe`). Логика загрузки самого словаря — в dg-node:
`public/overrides/js/paliLookup.js` (`lazyLoadStandaloneScripts`, вызов из
`settings-bundle.js` по событию `suttaRenderedCentral`, когда выбран режим standalone).

## 4. Задача №3: AASA

В `dg-node` (`main`, коммит `dcdb772`) файл `configs/apple-app-site-association` содержит
`7MXRJUJ7C3.gift.dhamma.mobile`. Нужен обычный деплой сайта, затем проверка:

```bash
curl -s https://dhamma.gift/.well-known/apple-app-site-association
```

Ожидается JSON с `7MXRJUJ7C3.gift.dhamma.mobile` и путями. Если отдаётся старый `7MXRJU7C3` —
значит прод не подтянул коммит. Universal Links работают только на сборке, подписанной этой же
командой, и только после этого шага (проверка №6 на телефоне).

## 5. Задача №4: merge в `main`

`main` содержит merge `9f50af9` и отстаёт от ветки; джобы `ios-release` и `ios-screenshots` есть
только в ветке. После зелёного TestFlight: `git checkout main && git merge claude/ponytail-full-9vo71m`
и прогнать прогон от `main`. Ветка `claude/...` — рабочая, `main` — то, что деплоится/показывается.

## 6. После успешного TestFlight: 6 проверок на телефоне

Каждая — минута, всё это симулятор воспроизвести не может (`docs/IOS_ACCOUNT_DAY.md`):

1. Загрузка офлайн-библиотеки → **блокировка экрана** на 5 минут → разблокировать: загрузка
   продолжилась (ради этого `DgDownloadPlugin` на фоновой `URLSession`).
2. В ридере ▶ (озвучка): слышно голос, кнопка закрытия закрывает плеер.
3. В ридере **тап по палийскому слову**: открывается встроенный словарь (см. задачу №2 — вероятно,
   здесь и вылезет та же ошибка).
4. Поделиться текстом из другого приложения → Dhamma.gift: приложение открывается с поиском.
5. Долгое нажатие на иконку: четыре статических пункта + «недавно читал».
6. Тап по `https://dhamma.gift/mn1` из Заметок: открывается приложение (только после задачи №3).

## 7. Магазин: что уже готово

- `docs/APP_STORE_LISTING.md` — подзаголовок, промо-текст, ключевые слова, описание, App Privacy,
  размеры и порядок скриншотов (проверено по актуальным правилам, включая 4.2/4.2.3(ii)/3.2.2(iv)).
- Скриншоты: `docs/ios-review/tour-156/6.7-inch/` (1284×2778 — принимаемый размер) и `6.9-inch/`
  (1320×2868). Выбрать три: поиск, ридер, словарь/настройки — и загрузить в App Store Connect.
- Имя продавца у Individual-аккаунта — личное имя владельца (название приложения остаётся
  «Dhamma.gift»); если нужен юрлицо-продавец — потребуется Organization-аккаунт (D-U-N-S).

## 8. Мелкие решения и долги

- **Четыре быстрых действия** — предел iOS для статических шорткатов; если динамические («недавно
  читал») вытесняют статические, решить, что оставить (сейчас в `Info.plist` 4 статических).
- Локализация названий статических шорткатов (ru) — не сделана.
- Решить, публиковать ли как iPhone-only или universal (сейчас `TARGETED_DEVICE_FAMILY = "1,2"`).
- Тест «библиотека потеряна → повторный импорт» (в CI не покрыт).
- Веб-харнесс WebKitGTK — вытеснен симулятором, не нужен.

## 9. Как работать с CI

```bash
cd /var/www/dg-apps
TOKEN=$(tr -d '\n\r' < /root/.secrets/github-token)     # fine-grained PAT, Issues: RW, только для API

# запустить полный прогон (в нём будет и ios-release) — только workflow_dispatch, push его не запускает
curl -sS -X POST -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
  -H "User-Agent: agent" -d '{"ref":"claude/ponytail-full-9vo71m"}' \
  https://api.github.com/repos/dhammagift/dg-app-full/actions/workflows/build-app.yml/dispatches

# вердикты + артефакты (скрипт печатает статусы, качает всё в .tmp/release-artifacts/)
bash .tmp/wait-release.sh <run_id>

# отменить дубли, если push тоже запустил прогон (он без ios-release)
curl -sS -X POST -H "Authorization: Bearer $TOKEN" -H "User-Agent: agent" \
  https://api.github.com/repos/dhammagift/dg-app-full/actions/runs/<run_id>/cancel
```

Один прогон ≈ 18–22 минуты (сборка `www`+APK ~15, потом archive/export/upload ~5). `git push` иногда
отвечает «Please make sure you have the correct access rights» — это транзиентно, повтор помогает.

Правила репозитория (AGENTS.md): перед правкой файла делать копию в `~/claudeBak/<имя>`; комментарии
и логи в коде — по-английски; в чат — по-русски; UI-правки без скриншотов не принимаются.

## 10. Грабли, которые уже стоили прогонов

- `drive.sh` искал симулятор через `grep -E`, а имя `iPad Pro 13-inch (M5)` содержит скобки: под
  `set -o pipefail` падал сам `UDID=$(…)` — планшетный проход умирал за секунду без вывода. Нужен
  `grep -F` (исправлено).
- `FILES`/`DG_ONLINE_ORIGIN`: в офлайновом self-test origin — мёртвый `127.0.0.1:59999` (порт 9
  нельзя, `ERR_UNSAFE_PORT`), в туре — `https://dhamma.gift`.
- Фикстура базы без таблицы `meta` → worker считает архив неполным (`make-fixture-db.js` теперь пишет
  `meta`).
- Само-тест перезагружал страницу по кругу → `DONE_KEY` пишется один раз (иначе на скриншотах была
  полузагруженная страница).
- Safe area: `ios.contentInset: "always"` (правильный отступ проверен: `inner 402x812 of screen
  402x874`); снимки «до» лежат в `ios-screenshots/before-fix/`.
- Team ID: `7MXRJUJ7C3` (две J). В первой редакции документов и в AASA стояло `7MXRJU7C3` — я неверно
  прочитал скриншот страницы App ID; увеличенный фрагмент того же скриншота подтвердил `…JUJ7C3`.

## 11. Журнал (что менялось по прогонам)

| Коммит | Что |
|---|---|
| `4d0f2cc` | тур по приложению вместо само-теста для скриншотов |
| `555fbdd`, `2d4e100`, `7ca3157` | `TOUR` по умолчанию, текст листинга, чеклист аккаунта |
| `2bd98c0` | `grep -F` в `drive.sh` + строки `[dg-dict]` |
| `73324e8` | папка `docs/ios-review/` (снимки, отчёт, логи) для владельца |
| `2861078` | identity убрана из проекта + сетевой зонд в туре |
| `25b8806` | Team ID `7MXRJUJ7C3` в документах |
| `372869d` | Release: `Apple Distribution` + `CODE_SIGN_STYLE = Manual`; шаг с настройками подписи; зонд на 10 КБ/6 МБ |
| dg-node `756482b` → `dcdb772` | AASA: команда `7MXRJUJ7C3` |
