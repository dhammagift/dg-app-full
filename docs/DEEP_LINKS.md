# dhammagift:// — deep links into the app

Одна схема, одна реализация маппинга на обе платформы: `src/deep-link.js`.
Нативная сторона только передаёт сырой URL, а решает всегда этот файл — иначе
`dhammagift://mn1` на Android и iOS значил бы разное.

## Контракт

| Ссылка | Что открывается |
|---|---|
| `dhammagift://mn1` | ридер на тексте (`/mn1`) |
| `dhammagift://sn56.11` | то же, для любого id канона |
| `dhammagift://route/dn22:2.2` | явный маршрут SPA (сегменты — только так) |
| `dhammagift://route/toc` | любой маршрут: `/toc`, `/4as`, `/settings`, `/toc/pli-tv-bu-pm` |
| `dhammagift://search?q=kacchapa&langs=ru,en` | поиск |
| `dhammagift://kacchapa` | всё, что не похоже на id канона — поиск по этому тексту |
| `dhammagift://auth?id_token=…&state=…` | возврат Google-логина (страница логина внутри приложения) |
| `dhammagift://search?q=…` | **Share Extension**: сюда приходит текст, которым с тобой поделились из другого приложения |

Правило «похоже на id канона»: буквы (и дефисы), затем цифра — `dn22`, `mn1`, `sn56.11`,
`thag1.1`, `pli-tv-bu-vb-pj1`. Всё остальное — поисковый запрос. Поэтому короткие маршруты
(`/4as`, `/4nt`) пишутся как `route/4as`: они начинаются с цифры и иначе стали бы поиском.

Из query для поиска переносятся только ключи самого сайта: `langs`, `fast`, `exact`, `scope`,
`lb`, `la`. Остальное отбрасывается.

**`dhammagift://dn22:2.2` работать не будет** и это не недоделка: двоеточие в позиции хоста
превращает `2.2` в порт, и URL не парсится ни в JS, ни в Android, ни в iOS. Для сегментов есть
`dhammagift://route/dn22:2.2`.

## Как это вызывается

```bash
# iOS (симулятор или устройство с установленным приложением)
xcrun simctl openurl booted "dhammagift://mn1"

# Android
adb shell am start -a android.intent.action.VIEW -d "dhammagift://mn1"

# из браузера или другого приложения — обычной ссылкой
<a href="dhammagift://kacchapa">искать каччапу</a>
```

## Как это доезжает до страницы

| Платформа | Механизм |
|---|---|
| Android, холодный старт и работа | `MainActivity.handleIntent` → `https://localhost/?_deepLink=<url>` (asset-сервер не может открыть `/mn1` напрямую), затем `native-bridge.js` переписывает адрес до старта SPA |
| Android, Google-логин | остаётся как было: токен приходит extras'ами intent'а, а не в URL |
| iOS | `CFBundleURLTypes` (Info.plist) → SceneDelegate → Capacitor App plugin → событие `appUrlOpen` → `location.replace()` |
| Android/iOS, пока приложение уже открыто | то же событие `appUrlOpen` |

## Что делает сама iOS (и это не наш баг)

Ссылку `dhammagift://…` на iOS, открытую **извне приложения** (Safari, чужое приложение, `simctl
openurl`), система сначала показывает диалогом «Open in "Dhamma.gift"?» — нужен один тап. Это
поведение SpringBoard для кастомных схем, обойти его нельзя; на Android ссылка открывается сразу
(или через стандартный выбор приложения). Первый прогон проверки в CI упал именно на этом: приложение
не получало URL без тапа, а тапнуть в headless-симуляторе нечем.

Поэтому проверка в симуляторе открывает схему **из самой страницы** (`dhammagift://route/toc`) —
это та же цепочка (CFBundleURLTypes → SceneDelegate → appUrlOpen → маппинг), но без диалога системы.
Внешний сценарий с тапом проверяется руками на устройстве.

## Проверки

| Что | Где |
|---|---|
| Контракт целиком (25 случаев, включая отказы) | `node test/deep-link.test.js` — без браузера и устройства, гоняется в CI на ubuntu |
| Живой диплинк в приложении | `test/ios-sim/drive.sh`: `simctl openurl` → страница пишет свой путь в отчёт → `node test/ios-sim/assert-deeplink.js` |
| Сборка Android с новым фильтром | CI, job `build` (assembleDebug/assembleRelease) |

Ещё не проверено на устройстве вручную: поведение ссылки из чужого приложения и из браузера
(Android — диалог «открыть в приложении», iOS — без диалога, схема зарегистрирована).
