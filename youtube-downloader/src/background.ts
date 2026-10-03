/** Связь страницы с скрытым yt-dlp и уведомление, когда файл готов. */

export {};

type NativeReply = {
  id?: number;
  ok?: boolean;
  phase?: string;
  error?: string;
  title?: string;
  rows?: Array<{ kind: "video" | "audio"; title: string; codec: string; size: string; format: string }>;
  text?: string;
  percent?: number;
  filename?: string;
};

type PageMessage = { type?: string; url?: string; format?: string; label?: string };

const jobs = new Map<number, { tabId: number; videoId: string; resolve: (reply: NativeReply) => void }>();
let port: chrome.runtime.Port | null = null;
let seq = 0;

function videoUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const host = url.hostname.replace(/^www\./, "");
  if (host === "youtu.be") {
    const id = url.pathname.replace(/^\//, "");
    return /^[\w-]{11}$/.test(id) ? `https://www.youtube.com/watch?v=${id}` : null;
  }
  if (host !== "youtube.com" && host !== "m.youtube.com") return null;
  if (url.pathname === "/watch") {
    const id = url.searchParams.get("v");
    return id && /^[\w-]{11}$/.test(id) ? `https://www.youtube.com/watch?v=${id}` : null;
  }
  const nested = url.pathname.match(/^\/(?:shorts|live)\/([\w-]{11})/);
  return nested ? `https://www.youtube.com${url.pathname}` : null;
}

function videoIdOf(raw: string): string {
  const canonical = videoUrl(raw);
  if (!canonical) return "";
  const url = new URL(canonical);
  return url.searchParams.get("v") || url.pathname.match(/\/(?:shorts|live)\/([\w-]{11})/)?.[1] || "";
}

function displayName(name: string): string {
  const clean = name.replace(/\uFFFD/g, "").replace(/[ \t]+/g, " ").trim();
  return clean || "Файл в папке Загрузки";
}

function tell(tabId: number, payload: Record<string, unknown>): void {
  void chrome.tabs.sendMessage(tabId, payload, () => {
    void chrome.runtime.lastError;
  });
}

function safeFormat(value: string): boolean {
  return /^[A-Za-z0-9*+[\]=^.<>_,-]+$/.test(value) && value.length <= 160;
}

function connect(): chrome.runtime.Port {
  if (port) return port;
  const next = chrome.runtime.connectNative("com.youtube.downloader");
  next.onMessage.addListener((message: NativeReply) => {
    if (typeof message.id !== "number") return;
    const job = jobs.get(message.id);
    if (!job) return;
    if (message.phase === "progress") {
      tell(job.tabId, { type: "ytdl-status", phase: "progress", videoId: job.videoId, text: message.text || "Скачиваю…" });
      return;
    }
    jobs.delete(message.id);
    if (message.phase === "done" && message.ok !== false) {
      const filename = displayName(message.filename || "");
      tell(job.tabId, { type: "ytdl-status", phase: "done", videoId: job.videoId, filename });
      chrome.notifications.create(`ytdl-${message.id}`, {
        type: "basic",
        iconUrl: chrome.runtime.getURL("icon.png"),
        title: "Видео скачано",
        message: `${filename} — папка «Загрузки»`,
      });
    } else if (message.ok === false || message.phase === "error") {
      tell(job.tabId, { type: "ytdl-status", phase: "error", videoId: job.videoId, error: message.error || "Не удалось скачать" });
    }
    job.resolve(message);
  });
  next.onDisconnect.addListener(() => {
    port = null;
    const reason = chrome.runtime.lastError?.message || "yt-dlp закрылся";
    for (const [id, job] of jobs) {
      jobs.delete(id);
      job.resolve({ ok: false, error: reason.includes("not found") ? "Перезагрузите расширение: помощник yt-dlp не подключён." : reason });
      tell(job.tabId, { type: "ytdl-status", phase: "error", videoId: job.videoId, error: "Скачивание прервалось" });
    }
  });
  port = next;
  return next;
}

function ask(tabId: number, payload: Record<string, unknown>, videoId: string): Promise<NativeReply> {
  const id = ++seq;
  return new Promise((resolve) => {
    jobs.set(id, { tabId, videoId, resolve });
    try {
      connect().postMessage({ ...payload, id });
    } catch (error) {
      jobs.delete(id);
      resolve({ ok: false, error: error instanceof Error ? error.message : "Не удалось запустить yt-dlp" });
    }
  });
}

chrome.runtime.onMessage.addListener((message: PageMessage, sender, sendResponse) => {
  if ((message?.type !== "ytdl-formats" && message?.type !== "ytdl-download") || sender.tab?.id == null) return;
  const url = typeof message.url === "string" ? videoUrl(message.url) : null;
  if (!url) {
    sendResponse({ ok: false, error: "Это не ссылка на ролик." });
    return;
  }
  const tabId = sender.tab.id;
  if (message.type === "ytdl-formats") {
    void ask(tabId, { action: "formats", url }, videoIdOf(url)).then((reply) => sendResponse(reply));
    return true;
  }
  if (typeof message.format !== "string" || !safeFormat(message.format)) {
    sendResponse({ ok: false, error: "Некорректное разрешение" });
    return;
  }
  void ask(tabId, { action: "download", url, format: message.format }, videoIdOf(url)).then((reply) => {
    if (reply.phase === "done") sendResponse({ ok: true, filename: reply.filename });
    else sendResponse({ ok: reply.ok === true && !reply.error, error: reply.error, filename: reply.filename });
  });
  return true;
});
