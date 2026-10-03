# Yandex Improve

Блокирует рекламу на Яндекс Почте и Яндекс Погоде (Chrome / Chromium / Яндекс Браузер).

## Разработка

```bash
# из корня репозитория
npm install
npm run build -w yandex-improve
```

Загрузите в браузер папку `yandex-improve/dist/`.

## Структура

| Путь | Назначение |
|---|---|
| `src/inject.ts` | MAIN world: Ya.Context / fetch / XHR |
| `src/hide-mail.ts` | Скрытие слотов в почте |
| `src/hide-weather.ts` | Скрытие слотов на погоде |
| `public/rules.json` | declarativeNetRequest |
| `public/*.css` | CSS hide-rules |
| `dist/` | Сборка для «Load unpacked» |

## Установка

1. Соберите расширение (`npm run build -w yandex-improve`) или скачайте релиз
2. Откройте `chrome://extensions` / `browser://tune`
3. Режим разработчика → «Загрузить распакованное» → `yandex-improve/dist`
4. Откройте почту или погоду и обновите страницу (Ctrl+F5)
