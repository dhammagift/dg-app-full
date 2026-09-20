# Как проверить App Actions и голосовой сценарий

Три уровня. Первые два проверяются за минуту и не требуют ничего, кроме телефона с APK.
Голос — третий, и у него есть условие, из-за которого он **не заработает сразу на сайдлоаде**.

## 0. Фулфилмент (работает всегда, Ассистент не нужен)

Ассистент в итоге делает ровно один `ACTION_VIEW` с URL из `<url-template>`. Этот шаг — и есть
проверка нашей половины:

```bash
adb shell am start -a android.intent.action.VIEW -d "dhammagift://search?q=kacchapa"
adb shell am start -a android.intent.action.VIEW -d "dhammagift://search?q=каччапа"
adb shell am start -a android.intent.action.VIEW -d "dhammagift://route/toc"
adb shell am start -a android.intent.action.VIEW -d "dhammagift://route/dict"
```

Приложение должно открыться уже на поиске / на оглавлении / в словаре. Если этот шаг проходит, а
голос — нет, дело не в приложении, а в превью (см. п.2).

Тот же контракт без устройства вообще: `node test/deep-link.test.js`.

## 1. Шорткаты в системном поиске

1. Открыть в приложении пару текстов (например `mn1`, `sn56.11`) и свернуть его — список
   отдаётся при уходе в фон (`native-bridge.js`, `appStateChange`).
2. Долгий тап по иконке — тексты должны быть в меню (это работало и раньше).
3. **Новое:** поиск в приложении Google на телефоне по названию текста — там должен появиться
   ярлык с иконкой Dhamma.gift.

Шаг 3 зависит от `core-google-shortcuts` и `setLongLived(true)`; индекс обновляется не мгновенно,
дать минуту.

## 2. Голос

**Условие:** Ассистент берёт `<capability>` только у приложения, опубликованного в Play, — или у
того, для которого создано *превью* в App Actions Test Tool. На отладочном APK без превью фраза
уйдёт в веб-поиск, и это не баг приложения.

Превью (один раз, ~сутки живёт):

1. Android Studio → `Tools > Google Assistant > App Actions Test Tool` (плагин «Google Assistant»).
2. Тот же Google-аккаунт: в Android Studio, в приложении Google на телефоне и в Ассистенте.
3. Locale в тулзе = язык Ассистента на устройстве, **точно** (`ru-RU` или `en-US`, не «оба»).
4. `Create Preview`.

Фразы после этого:

| Язык | Фраза |
|---|---|
| ru | «Окей Гугл, найди каччапа в Dhamma.gift» |
| ru | «Окей Гугл, открой оглавление в Dhamma.gift» |
| en | "Hey Google, search for kacchapa on Dhamma.gift" |
| en | "Hey Google, open contents on Dhamma.gift" |

Название приложения Ассистент берёт из `@string/app_name`, поэтому произносить надо его, а не
«дхамма гифт» на слух.

Без Android Studio остаётся дождаться релиза в Play: у опубликованной сборки capability
подхватываются сами, превью не нужно.

## Где взять APK

Каждый push собирает его в CI (`.github/workflows/build-app.yml`): вкладка Actions → нужный run →
артефакт `dg-app-full-apk-<run>`. Это debug-сборка с `applicationId gift.dhamma.mobile`, так что
она ставится рядом с релизной и ничего не затирает.
