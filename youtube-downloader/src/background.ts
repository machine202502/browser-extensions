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

type Job = {
  tabId: number;
  videoId: string;
  action: string;
  url: string;
  format: string;
  resolve: (reply: NativeReply) => void;
};

type DownloadRetry = {
  url: string;
  format: string;
  tabId: number;
  videoId: string;
};

const jobs = new Map<number, Job>();
let port: chrome.runtime.Port | null = null;
let seq = 0;
let retrySeq = 0;

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

function notifyFailure(job: Job, error: string): void {
  if (job.action !== "download" || !job.url || !job.format || error === "Загрузка отменена") return;
  const notificationId = `ytdl-retry-${Date.now()}-${++retrySeq}`;
  const retry: DownloadRetry = { url: job.url, format: job.format, tabId: job.tabId, videoId: job.videoId };
  const message = error.replace(/\s+/g, " ").trim().slice(0, 180) || "Не удалось скачать";
  void chrome.storage.session.set({ [notificationId]: retry }).then(() => {
    chrome.notifications.create(notificationId, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icon.png"),
      title: "Не удалось скачать",
      message,
      buttons: [{ title: "Попробовать ещё раз" }],
      requireInteraction: true,
    });
  });
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
      const error = message.error || "Не удалось скачать";
      tell(job.tabId, { type: "ytdl-status", phase: "error", videoId: job.videoId, error });
      notifyFailure(job, error);
    }
    job.resolve(message);
  });
  next.onDisconnect.addListener(() => {
    port = null;
    const reason = chrome.runtime.lastError?.message || "yt-dlp закрылся";
    const error = reason.includes("not found") ? "Перезагрузите расширение: помощник yt-dlp не подключён." : "Скачивание прервалось";
    for (const [id, job] of jobs) {
      jobs.delete(id);
      job.resolve({ ok: false, error: reason.includes("not found") ? error : reason });
      tell(job.tabId, { type: "ytdl-status", phase: "error", videoId: job.videoId, error });
      notifyFailure(job, error);
    }
  });
  port = next;
  return next;
}

function ask(tabId: number, payload: Record<string, unknown>, videoId: string): Promise<NativeReply> {
  const id = ++seq;
  const action = typeof payload.action === "string" ? payload.action : "";
  const url = typeof payload.url === "string" ? payload.url : "";
  const format = typeof payload.format === "string" ? payload.format : "";
  return new Promise((resolve) => {
    jobs.set(id, { tabId, videoId, action, url, format, resolve });
    try {
      connect().postMessage({ ...payload, id });
    } catch (error) {
      jobs.delete(id);
      resolve({ ok: false, error: error instanceof Error ? error.message : "Не удалось запустить yt-dlp" });
    }
  });
}

function beginDownload(tabId: number, url: string, format: string): Promise<NativeReply> {
  const videoId = videoIdOf(url);
  tell(tabId, { type: "ytdl-status", phase: "progress", videoId, text: "Скачиваю…" });
  return ask(tabId, { action: "download", url, format }, videoId);
}

chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
  if (buttonIndex !== 0 || !notificationId.startsWith("ytdl-retry-")) return;
  void chrome.storage.session.get(notificationId).then((stored) => {
    const retry = stored[notificationId] as DownloadRetry | undefined;
    void chrome.storage.session.remove(notificationId);
    void chrome.notifications.clear(notificationId);
    if (!retry || typeof retry.url !== "string" || typeof retry.format !== "string" || typeof retry.tabId !== "number" || !safeFormat(retry.format)) return;
    void beginDownload(retry.tabId, retry.url, retry.format);
  });
});

chrome.notifications.onClosed.addListener((notificationId) => {
  if (notificationId.startsWith("ytdl-retry-")) void chrome.storage.session.remove(notificationId);
});

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
  void beginDownload(tabId, url, message.format).then((reply) => {
    if (reply.phase === "done") sendResponse({ ok: true, filename: reply.filename });
    else sendResponse({ ok: reply.ok === true && !reply.error, error: reply.error, filename: reply.filename });
  });
  return true;
});
