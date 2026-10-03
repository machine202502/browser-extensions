export {};

const statusEl = document.getElementById("status");

function show(text: string): void {
  if (statusEl) statusEl.textContent = text;
}

chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const tab = tabs[0];
  const url = tab?.url ?? "";
  if (!/^https:\/\/(www\.)?youtube\.com\//.test(url) || tab?.id == null) {
    show("Откройте ролик на youtube.com. Кнопка «Скачать» стоит в ряду с «Нравится».");
    return;
  }
  chrome.tabs.sendMessage(tab.id, { type: "ytdl-open" }, () => {
    if (chrome.runtime.lastError) {
      show("Обновите страницу ролика, затем откройте это меню ещё раз.");
      return;
    }
    window.close();
  });
});
