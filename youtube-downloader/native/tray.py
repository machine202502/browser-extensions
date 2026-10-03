#!/usr/bin/env python3
"""Один трей для Windows, Linux и macOS. Строки JSON по TCP, как раньше у tray.ps1."""

import json
import socket
import sys
import threading

import pystray
from PIL import Image


class TrayClient:
    def __init__(self, port):
        self.sock = socket.create_connection(("127.0.0.1", int(port)))
        self.incoming = self.sock.makefile("r", encoding="utf-8", newline="\n")
        self.lock = threading.Lock()

    def lines(self):
        for line in self.incoming:
            yield line

    def cancel(self, item_id):
        payload = json.dumps({"cancel": str(item_id)}, ensure_ascii=False) + "\n"
        with self.lock:
            self.sock.sendall(payload.encode("utf-8"))


def self_cancel(client, item_id):
    def cancel(_icon, _item):
        client.cancel(item_id)

    return cancel


def parse_items(line):
    message = json.loads(line)
    return list(message.get("items") or [])


def main():
    port = sys.argv[1]
    icon_path = sys.argv[2]
    client = TrayClient(port)
    state = {"items": []}
    state_lock = threading.Lock()
    image = Image.open(icon_path)

    def menu():
        with state_lock:
            items = list(state["items"])
        entries = []
        for index, item in enumerate(items):
            if index:
                entries.append(pystray.Menu.SEPARATOR)
            entries.append(
                pystray.MenuItem(
                    f"{item.get('status', '')}  {item.get('title', '')}",
                    lambda *_args: None,
                    enabled=False,
                )
            )
            entries.append(pystray.MenuItem("Отменить", self_cancel(client, str(item.get("id")))))
        if not entries:
            entries.append(pystray.MenuItem("Нет загрузок", lambda *_args: None, enabled=False))
        return tuple(entries)

    icon = pystray.Icon("youtube-downloader", image, "Загрузки YouTube", pystray.Menu(menu))
    icon.visible = False

    def apply(items):
        with state_lock:
            state["items"] = items
        icon.visible = bool(items)
        icon.title = f"Загрузки YouTube ({len(items)})" if items else "Загрузки YouTube"
        try:
            icon.update_menu()
        except AttributeError:
            pass

    def reader():
        try:
            for line in client.lines():
                text = line.strip()
                if text:
                    apply(parse_items(text))
        finally:
            icon.stop()

    icon.run(lambda _icon: threading.Thread(target=reader, daemon=True).start())


if __name__ == "__main__":
    sys.exit(main())
