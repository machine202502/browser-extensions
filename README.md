# Browser Extensions

Монорепозиторий браузерных расширений (Manifest V3, TypeScript).

| Пакет | Описание | Load unpacked |
| --- | --- | --- |
| [`yandex-improve/`](./yandex-improve) | Реклама в Яндекс Почте и Погоде | `yandex-improve/dist` |
| [`youtube-improve/`](./youtube-improve) | Shorts, блюр, блокировка, просмотры | `youtube-improve/dist` |

## Сборка

```bash
npm install
npm run build
```

## Установка в браузер

1. `chrome://extensions` или `browser://tune`
2. Режим разработчика → **Загрузить распакованное**
3. Укажи папку `*/dist` нужного расширения

## Структура пакета

```
<extension>/
  src/        # TypeScript
  public/     # manifest, CSS, HTML, rules
  dist/       # результат сборки (load unpacked)
  package.json
```

Общий скрипт сборки: [`scripts/build-extension.mjs`](./scripts/build-extension.mjs).
