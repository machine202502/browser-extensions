# YouTube Downloader

Кнопка «Скачать» стоит в ряду с «Нравится». В таблице можно выбрать разрешение: каждое сохраняется одним файлом, уже со звуком. yt-dlp запускается скрыто, без окна консоли. Когда файл готов, браузер показывает уведомление, а сам файл лежит в папке «Загрузки». Пока идёт загрузка, в трее виден список файлов и пункт «Отменить».

Трей один и тот же на Windows, Linux и macOS: скрипт на Python. Нужны пакеты `pystray` и `pillow` (`pip install pystray pillow`). Без них скачивание работает, просто без значка в трее.

Нужны [yt-dlp](https://github.com/yt-dlp/yt-dlp) и ffmpeg. На Windows они ставятся так:

```bash
winget install yt-dlp.yt-dlp
```

На Linux ffmpeg берётся из дистрибутива, yt-dlp — официальным файлом:

```bash
sudo apt install ffmpeg
sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
sudo chmod a+rx /usr/local/bin/yt-dlp
```

На Fedora вместо `apt` — `sudo dnf install ffmpeg`, на Arch — `sudo pacman -S ffmpeg`. Команды `curl` и `chmod` те же.

Связка расширения с yt-dlp регистрируется один раз. Скрипт сам подставляет путь к Node и к папке расширения и записывает его в реестр Chrome. Файлы `host.cmd` и `host-manifest.json` из-за этого привязаны к компьютеру и в репозиторий не входят:

```bash
node youtube-downloader/native/install.mjs
npm run build -w youtube-downloader
```

После этого перезагрузите расширение в `chrome://extensions` и укажите папку `youtube-downloader/dist`.
