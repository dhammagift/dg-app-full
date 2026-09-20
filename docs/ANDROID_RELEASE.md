# Выкладка Android без ручной загрузки

CI умеет сам отправлять подписанный AAB в Google Play — так же, как iOS-билд уходит в TestFlight.
Джоба `android-release` в `.github/workflows/build-app.yml`.

Пока нет секрета `PLAY_SERVICE_ACCOUNT_JSON`, джоба **ничего не делает и честно пишет об этом**
в сводке рана: зелёная галочка без загрузки — худшее, что может случиться с релизным пайплайном.

## Что настроить один раз (это может сделать только владелец аккаунта)

1. **Play Console → Setup → API access.** Привязать проект Google Cloud (если ещё не привязан).
2. Там же **Create service account** → уводит в Google Cloud Console → создать сервисный аккаунт →
   **Keys → Add key → JSON** → скачается файл. Роли в Cloud не нужны, права выдаются в Play.
3. **Play Console → Users and permissions → Invite new user** → email сервисного аккаунта
   (вида `…@….iam.gserviceaccount.com`) → **App permissions** → выбрать `gift.dhamma.twa` →
   право **Release apps to testing tracks**. Больше ничего не давать: этого хватает для
   внутреннего трека и не хватает, чтобы что-то выкатить на читателей.
4. **GitHub → Settings → Secrets and variables → Actions → New repository secret**
   → имя `PLAY_SERVICE_ACCOUNT_JSON`, значение — **содержимое JSON-файла целиком**.

Правило Play «первую сборку загрузите вручную» нас не касается: пакет `gift.dhamma.twa` в консоли
уже есть, он заменил листинг TWA.

## Как отправлять

**Руками:** Actions → **Build App** → Run workflow → включить галочку **release**.
**Тегом:** пуш тега — джоба отрабатывает без галочки, как и iOS.

Обычный пуш в ветку ничего никуда не отправляет.

## Куда именно приезжает

**Internal track.** Не production, и это осознанно:

- доезжает до устройства за минуты, без ревью;
- видят только тестировщики, перечисленные в консоли;
- на продакшен всё равно нужен **promote** в Play Console — то есть автоматическая загрузка
  физически не может выкатить что-то читателям сама.

Повышение internal → production остаётся ручным решением. Это ровно та часть, которую никто не
просил автоматизировать.

## Что уезжает

Артефакт `dg-app-full-aab-release-<run>` из той же сборки — не пересборка. То есть в Play уезжают
ровно те байты, против которых прогнались проверки и которые лежат в артефактах рана.

`versionCode` = номер рана, `applicationId` = `gift.dhamma.twa`, подпись — релизный ключ из
секретов (`ANDROID_KEYSTORE_*`). Если ключа нет, `build` не соберёт AAB, и загружать будет нечего —
это видно в сводке.

## Если что-то пошло не так

| Сообщение | Причина |
|---|---|
| `Missing repository secret: PLAY_SERVICE_ACCOUNT_JSON` | секрет не задан — см. шаг 4 |
| `The caller does not have permission` | сервисный аккаунт не приглашён в консоль или ему не выдано право на это приложение (шаг 3) |
| `Version code N has already been used` | ран с таким номером уже загружали; следующий ран возьмёт новый номер |
| `APK specifies a version code that has already been used` | то же самое |
