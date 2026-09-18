# День аккаунта: что сделать, когда появится платный Apple Developer Program

Всё, что можно было подготовить заранее, уже сделано и проверено в CI. Ниже — короткий список,
после которого приложение уходит в TestFlight, а дальше в App Store. Порядок важен только в первых
двух пунктах: остальные можно параллельно.

## 1. Аккаунт и App ID (5 минут)

1. Apple Developer Program → **Membership** → скопировать **Team ID** (10 символов).
2. Certificates, Identifiers & Profiles → Identifiers → **+** → App IDs → App:
   - Bundle ID (explicit): `gift.dhamma.mobile`
   - Capabilities: включить **Associated Domains** (остальное не нужно).
3. Там же — Devices: добавить iPhone (UDID), если захочется ставить сборки напрямую, а не через
   TestFlight. Для TestFlight это не требуется.

## 2. Universal Links включаются одним коммитом (5 минут)

В dg-node, `configs/apple-app-site-association`: заменить `TEAMID.` на Team ID из п. 1 —
должно получиться `ABCDE12345.gift.dhamma.mobile`. Закоммитить и задеплоить сайт.

Проверка: `curl -s https://dhamma.gift/.well-known/apple-app-site-association` отдаёт JSON с вашим
Team ID (роут уже есть и проверяется в CI, ждёт только значения). После этого ссылка
`https://dhamma.gift/mn1`, отправленная себе в «Заметки», открывает приложение без диалога.

## 3. Ключ для CI и TestFlight (10 минут)

App Store Connect → Users and Access → **Integrations** → App Store Connect API → **Team Keys** →
создать ключ с ролью **App Manager**. Скачать `.p8` (даётся один раз) и положить три значения в
GitHub → Settings → Secrets and variables → Actions:

| Секрет | Что это |
|---|---|
| `ASC_KEY_ID` | Key ID (10 символов) |
| `ASC_ISSUER_ID` | Issuer ID (UUID) |
| `ASC_KEY_P8` | **содержимое** файла `.p8` целиком, включая строки BEGIN/END |

Пока их нет — джоба `ios-release` честно пишет, что пропускает архивацию, и ничего не ломает.
Как только есть: Actions → **Build App** → *Run workflow* → джоба `ios-release` соберёт Release,
подпишет с `-allowProvisioningUpdates`, загрузит в TestFlight и положит `.ipa` в артефакты.

Ещё понадобится запись приложения в App Store Connect (My Apps → **+** → New App): bundle id
`gift.dhamma.mobile`, имя `Dhamma.gift`, основной язык, SKU — любая строка. Без записи TestFlight
не примет сборку.

## 4. Проверки на телефоне — то, чего не может симулятор

Поставить сборку из TestFlight и пройти четыре пункта (каждый — минута):

| # | Что сделать | Что должно быть |
|---|---|---|
| 1 | Начать загрузку офлайн-библиотеки, **заблокировать экран** на 5 минут, разблокировать | загрузка **продолжилась** (это то, ради чего `DgDownloadPlugin` на фоновой `URLSession`) |
| 2 | В ридере нажать ▶ (озвучка) | слышно голос; кнопка закрытия закрывает плеер |
| 3 | В ридере **тапнуть по палийскому слову** | открывается встроенный словарь (в headless это не воспроизводится — см. `test/ios-sim/tour.js`) |
| 4 | Поделиться текстом из другого приложения → Dhamma.gift | приложение открывается с поиском по этому тексту |
| 5 | Долгое нажатие на иконку | четыре статических пункта + «недавно читал», если есть |
| 6 | Тап по ссылке `https://dhamma.gift/mn1` (из Заметок) | открывается приложение (только после п. 2) |

## 5. Перед отправкой в App Store

- **Скриншоты**: берутся из джобы `ios-screenshots` — iPhone 6.9″ и iPad 13″ (приложение объявлено
  для iPhone и iPad, поэтому нужны оба набора).
- **App Privacy**: приложение использует Firebase (вход Google, синхронизация) — это сбор данных,
  анкету заполнить честно; аналитики и трекинга нет.
- **Export compliance**: уже объявлено в Info.plist (`ITSAppUsesNonExemptEncryption = false`).
- **Review notes**: написать, что это офлайн-ридер канона (база скачивается один раз, работает без
  сети), донаты — ссылкой в браузере, приложение бесплатное; перечислить нативные функции
  (шорткаты, Share Extension, фоновая загрузка, озвучка), чтобы не выглядеть «обёрткой сайта».
- **iPad**: если iPad не нужен — поставить `TARGETED_DEVICE_FAMILY = "1"`, тогда iPad-скриншоты не
  требуются, но и приложение на Mac (Designed for iPad) не появится.
