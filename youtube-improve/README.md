# YouTube Improve

Расширение для YouTube: скрытие Shorts, блюр превью, блокировка видео/каналов, учёт просмотров и автоскрытие.

## Разработка

```bash
# из корня репозитория
npm install
npm run build -w youtube-improve
```

Загрузите в браузер папку `youtube-improve/dist/`.

## Структура

| Путь | Назначение |
|---|---|
| `src/` | TypeScript (content, page-patch, popup, …) |
| `public/` | `manifest.json`, CSS, HTML |
| `dist/` | Сборка для «Load unpacked» |

## Возможности

- Скрытие Shorts (DOM + API patch в MAIN world)
- Блюр превью / аватаров / ссылок
- Блокировка видео и каналов
- Учёт просмотров и автоскрытие
- «Не рекомендовать канал» на главной
- Экспорт / импорт базы
