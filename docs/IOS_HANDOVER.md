# Передача задачи: iOS-приложение (состояние на 19.09.2026, вечер)

Ветка `claude/ponytail-full-9vo71m`, head `372869d`. Прогон **167** (`35418255474`, dispatch) шёл на
момент передачи: джоб `build` ещё собирался, `ios-release` не начинался. Запущен фоновый watcher
(`bash-30`, `.tmp/wait-release.sh 35418255474`), он печатает вердикты и скачивает артефакты.

Репозитории: `dg-app-full` (это приложение: Capacitor-обёртка + CI), `dg-node` (сайт, отдаёт AASA и
данные). **Android ломать нельзя** — джобы `build`/APK/AAB в каждом прогоне должны оставаться зелёными.

## 0. Что осталось, коротко

| # | Задача | Состояние |
|---|---|---|
| 1 | Сборка уходит в TestFlight | 4 попытки, все упираются в подпись; в прогоне 167 — вариант «manual + Apple Distribution» |
| 2 | Встроенный словарь в ридере (`Couldn't load the dictionary`) | сеть у приложения есть, падает именно запрос за DPD; в 167 зонд сузит причину |
| 3 | Задеплой `dg-node`, чтобы прод отдал AASA с `7MXRJUJ7C3` | файл поправлен (`dcdb772` в `main`), нужен деплой сайта |
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
cd /var/www/dg-app-full
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
