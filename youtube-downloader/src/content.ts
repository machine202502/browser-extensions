/** Кнопка в ряду действий ролика и таблица разрешений. */

export {};

type FormatRow = {
  kind: "video" | "audio";
  title: string;
  codec: string;
  size: string;
  format: string;
};

let slot: HTMLDivElement | null = null;
let panel: HTMLDivElement | null = null;
let listEl: HTMLDivElement | null = null;
let statusEl: HTMLDivElement | null = null;
let toastEl: HTMLDivElement | null = null;
let open = false;
let placedFor = "";
let placeTimer = 0;
const running = new Set<string>();
const runningText = new Map<string, string>();

function videoIdFromLocation(): string | null {
  const url = new URL(location.href);
  if (url.pathname === "/watch") {
    const id = url.searchParams.get("v");
    return id && /^[\w-]{11}$/.test(id) ? id : null;
  }
  const nested = url.pathname.match(/^\/(?:shorts|live)\/([\w-]{11})/);
  return nested ? nested[1] : null;
}

function actionsHost(): HTMLElement | null {
  return (
    document.querySelector("ytd-watch-metadata #top-level-buttons-computed") ??
    document.querySelector("ytd-watch-metadata #actions #flexible-item-buttons") ??
    document.querySelector("ytd-watch-metadata #actions")
  );
}

function setRowsDisabled(disabled: boolean): void {
  if (!listEl) return;
  for (const row of listEl.querySelectorAll(".ytdl-row")) {
    if (row instanceof HTMLButtonElement) row.disabled = disabled;
  }
}

function setStatus(text: string, isError = false): void {
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.classList.toggle("ytdl-error", isError);
}

function showToast(text: string, isError = false): void {
  if (!toastEl) return;
  toastEl.textContent = text;
  toastEl.classList.toggle("ytdl-error", isError);
  toastEl.hidden = false;
  window.setTimeout(() => {
    if (toastEl?.textContent === text) toastEl.hidden = true;
  }, 8000);
}

function closePanel(): void {
  open = false;
  if (panel) panel.hidden = true;
}

function positionPanel(): void {
  const button = document.getElementById("ytdl-btn");
  if (!panel || !button) return;
  const rect = button.getBoundingClientRect();
  const width = Math.min(440, window.innerWidth - 24);
  panel.style.width = `${width}px`;
  let left = Math.min(rect.left, window.innerWidth - width - 12);
  left = Math.max(12, left);
  let top = rect.bottom + 8;
  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
  const height = panel.offsetHeight;
  if (top + height > window.innerHeight - 12) {
    panel.style.top = `${Math.max(12, rect.top - height - 8)}px`;
  }
}

function place(): void {
  if (!slot) return;
  const id = videoIdFromLocation();
  if (!id) {
    slot.hidden = true;
    closePanel();
    placedFor = "";
    return;
  }
  slot.hidden = false;
  if (placedFor !== id) {
    closePanel();
    if (listEl) listEl.replaceChildren();
    setStatus(runningText.get(id) || "");
    setRowsDisabled(running.has(id));
    placedFor = id;
  }

  const actions = location.pathname === "/watch" ? actionsHost() : null;
  if (actions) {
    slot.classList.remove("ytdl-floating");
    if (slot.parentElement !== actions) actions.insertBefore(slot, actions.firstChild);
    return;
  }
  slot.classList.add("ytdl-floating");
  if (slot.parentElement !== document.documentElement) document.documentElement.appendChild(slot);
}

function schedulePlace(): void {
  window.clearTimeout(placeTimer);
  placeTimer = window.setTimeout(place, 150);
}

function addSection(text: string): void {
  if (!listEl) return;
  const heading = document.createElement("div");
  heading.className = "ytdl-section";
  heading.textContent = text;
  listEl.appendChild(heading);
}

function addHeader(): void {
  if (!listEl) return;
  const header = document.createElement("div");
  header.className = "ytdl-grid ytdl-grid-head";
  for (const label of ["Разрешение", "Кодек", "Размер"]) {
    const cell = document.createElement("span");
    cell.textContent = label;
    header.appendChild(cell);
  }
  listEl.appendChild(header);
}

function renderRows(rows: FormatRow[]): void {
  if (!listEl) return;
  listEl.replaceChildren();
  const videos = rows.filter((row) => row.kind === "video");
  const audios = rows.filter((row) => row.kind === "audio");
  if (videos.length > 0) {
    addSection("Видео со звуком");
    addHeader();
    for (const row of videos) listEl.appendChild(rowButton(row));
  }
  if (audios.length > 0) {
    addSection("Только звук");
    for (const row of audios) listEl.appendChild(rowButton(row));
  }
  setRowsDisabled(running.has(videoIdFromLocation() || ""));
  window.requestAnimationFrame(positionPanel);
}

function rowButton(row: FormatRow): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = row.kind === "video" ? "ytdl-row ytdl-grid" : "ytdl-row";
  if (row.kind === "video") {
    for (const value of [row.title, row.codec || "—", row.size || "—"]) {
      const cell = document.createElement("span");
      cell.textContent = value;
      button.appendChild(cell);
    }
  } else {
    const name = document.createElement("span");
    name.className = "ytdl-row-title";
    name.textContent = row.title;
    const meta = document.createElement("span");
    meta.className = "ytdl-row-meta";
    meta.textContent = [row.codec, row.size].filter(Boolean).join(" · ");
    button.append(name, meta);
  }
  button.onclick = (event) => {
    event.stopPropagation();
    void startDownload(row);
  };
  return button;
}

function startDownload(row: FormatRow): void {
  const id = videoIdFromLocation();
  if (!id || running.has(id)) return;
  running.add(id);
  runningText.set(id, `Скачиваю ${row.title}…`);
  setRowsDisabled(true);
  setStatus(runningText.get(id) || "");
  chrome.runtime.sendMessage({ type: "ytdl-download", url: location.href, format: row.format, label: row.title }, (response) => {
    const err = chrome.runtime.lastError;
    const payload = response as { ok?: boolean; error?: string; filename?: string } | undefined;
    if (!err && payload?.ok !== false) return;
    running.delete(id);
    runningText.delete(id);
    if (videoIdFromLocation() !== id) return;
    setRowsDisabled(false);
    setStatus(err?.message || payload?.error || "Не удалось скачать", true);
  });
}

function openPanel(): void {
  if (!slot || !panel || !listEl) return;
  place();
  open = true;
  panel.hidden = false;
  listEl.replaceChildren();
  setStatus("Смотрю доступные разрешения…");
  positionPanel();
  const id = videoIdFromLocation();
  chrome.runtime.sendMessage({ type: "ytdl-formats", url: location.href }, (response) => {
    if (videoIdFromLocation() !== id) return;
    const err = chrome.runtime.lastError;
    const payload = response as { ok?: boolean; error?: string; rows?: FormatRow[] } | undefined;
    if (err || !payload?.ok || !payload.rows) {
      if (listEl) listEl.replaceChildren();
      setStatus(err?.message || payload?.error || "Не удалось получить разрешения", true);
      positionPanel();
      return;
    }
    setStatus("");
    renderRows(payload.rows);
  });
}

function mount(): void {
  if (slot || !document.documentElement) return;

  slot = document.createElement("div");
  slot.id = "ytdl-slot";
  slot.hidden = true;

  const button = document.createElement("button");
  button.id = "ytdl-btn";
  button.type = "button";
  button.textContent = "Скачать";
  button.onclick = (event) => {
    event.stopPropagation();
    if (open) closePanel();
    else openPanel();
  };
  slot.appendChild(button);

  panel = document.createElement("div");
  panel.id = "ytdl-panel";
  panel.hidden = true;

  const titleEl = document.createElement("div");
  titleEl.className = "ytdl-head";
  titleEl.textContent = "Разрешение";

  const note = document.createElement("div");
  note.className = "ytdl-note";
  note.textContent = "Каждое разрешение сохраняется одним файлом, уже со звуком.";

  statusEl = document.createElement("div");
  statusEl.className = "ytdl-status";

  listEl = document.createElement("div");
  listEl.className = "ytdl-list";
  panel.append(titleEl, note, statusEl, listEl);

  toastEl = document.createElement("div");
  toastEl.id = "ytdl-toast";
  toastEl.hidden = true;

  document.documentElement.append(slot, panel, toastEl);

  document.addEventListener(
    "click",
    (event) => {
      if (!open || !slot || !panel) return;
      const path = event.composedPath();
      if (!path.includes(slot) && !path.includes(panel)) closePanel();
    },
    true,
  );
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closePanel();
  });
  window.addEventListener("resize", () => {
    if (open) positionPanel();
  });
}

function boot(): void {
  if (window.top !== window) return;
  mount();
  schedulePlace();
  document.addEventListener("yt-navigate-finish", schedulePlace);
  const observer = new MutationObserver(() => {
    const actions = actionsHost();
    if (!slot || !document.contains(slot) || (actions && slot.parentElement !== actions)) schedulePlace();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  chrome.runtime.onMessage.addListener((message: { type?: string; phase?: string; text?: string; error?: string; filename?: string; videoId?: string }) => {
    if (message?.type === "ytdl-open") {
      openPanel();
      return;
    }
    if (message?.type !== "ytdl-status" || !message.videoId) return;
    const here = message.videoId === videoIdFromLocation();
    if (message.phase === "progress") {
      running.add(message.videoId);
      runningText.set(message.videoId, message.text || "Скачиваю…");
      if (here) setStatus(message.text || "Скачиваю…");
      return;
    }
    if (message.phase !== "done" && message.phase !== "error") return;
    running.delete(message.videoId);
    runningText.delete(message.videoId);
    if (!here) return;
    setRowsDisabled(false);
    if (message.phase === "done") {
      setStatus("Файл в папке Загрузки");
      showToast(`Скачано: ${message.filename || "файл в папке Загрузки"}`);
      return;
    }
    setStatus(message.error || "Не удалось скачать", true);
    showToast(message.error || "Не удалось скачать", true);
  });
}

boot();
