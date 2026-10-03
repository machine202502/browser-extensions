/** Кнопка в ряду действий ролика, пункт в меню карточки и таблица разрешений. */

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
type Target = { id: string; url: string };
type Anchor = { left: number; top: number; right: number; bottom: number; width: number; height: number };

let open = false;
let placedFor = "";
let placeTimer = 0;
let panelTarget: Target | null = null;
let panelAnchor: Anchor | null = null;
let menuTarget: Target | null = null;
let menuCard: Element | null = null;
let menuButton: HTMLButtonElement | null = null;
let menuTimer = 0;
let menuArmedUntil = 0;
let ignoreOutsideClose = false;
const running = new Set<string>();
const runningText = new Map<string, string>();

const CARD_SEL = [
  "yt-lockup-view-model",
  "ytd-rich-item-renderer",
  "ytd-rich-grid-media",
  "ytd-video-renderer",
  "ytd-compact-video-renderer",
  "ytd-grid-video-renderer",
  "ytd-playlist-video-renderer",
  "ytd-playlist-panel-video-renderer",
  "ytd-reel-item-renderer",
].join(",");

function watchUrl(id: string): string {
  return `https://www.youtube.com/watch?v=${id}`;
}

function parseVideoId(href: string): string | null {
  try {
    const url = new URL(href, location.href);
    if (url.pathname === "/watch") {
      const id = url.searchParams.get("v");
      return id && /^[\w-]{11}$/.test(id) ? id : null;
    }
    const nested = url.pathname.match(/^\/(?:shorts|live|embed)\/([\w-]{11})/);
    return nested ? nested[1] : null;
  } catch {
    return null;
  }
}

function pageTarget(): Target | null {
  const id = videoIdFromLocation();
  return id ? { id, url: watchUrl(id) } : null;
}

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
  panelTarget = null;
  panelAnchor = null;
  if (panel) panel.hidden = true;
}

function positionPanel(): void {
  if (!panel) return;
  const button = document.getElementById("ytdl-btn");
  const live = button?.getBoundingClientRect();
  const rect = panelAnchor ?? (live && live.width > 0 && live.height > 0 ? live : null);
  const width = Math.min(440, window.innerWidth - 24);
  panel.style.width = `${width}px`;
  let left = rect ? Math.min(rect.left, window.innerWidth - width - 12) : 12;
  left = Math.max(12, left);
  let top = rect ? rect.bottom + 8 : 12;
  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
  const height = panel.offsetHeight;
  if (rect && top + height > window.innerHeight - 12) {
    panel.style.top = `${Math.max(12, rect.top - height - 8)}px`;
  }
}

function place(): void {
  if (!slot) return;
  const id = videoIdFromLocation();
  if (!id) {
    slot.hidden = true;
    placedFor = "";
    return;
  }
  slot.hidden = false;
  if (placedFor !== id) {
    if (!panelTarget || panelTarget.id === placedFor) closePanel();
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
  setRowsDisabled(running.has(panelTarget?.id || ""));
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
  const target = panelTarget;
  if (!target || running.has(target.id)) return;
  const id = target.id;
  running.add(id);
  runningText.set(id, `Скачиваю ${row.title}…`);
  setRowsDisabled(true);
  setStatus(runningText.get(id) || "");
  chrome.runtime.sendMessage({ type: "ytdl-download", url: target.url, format: row.format, label: row.title }, (response) => {
    const err = chrome.runtime.lastError;
    const payload = response as { ok?: boolean; error?: string; filename?: string } | undefined;
    if (!err && payload?.ok !== false) return;
    running.delete(id);
    runningText.delete(id);
    if (panelTarget?.id !== id) return;
    setRowsDisabled(false);
    setStatus(err?.message || payload?.error || "Не удалось скачать", true);
  });
}

function openPanelFor(target: Target, anchor: Anchor | null): void {
  if (!slot || !panel || !listEl) return;
  panelTarget = target;
  panelAnchor = anchor;
  if (anchor == null && videoIdFromLocation() === target.id) place();
  open = true;
  panel.hidden = false;
  listEl.replaceChildren();
  setStatus(runningText.get(target.id) || "Смотрю доступные разрешения…");
  positionPanel();
  const id = target.id;
  chrome.runtime.sendMessage({ type: "ytdl-formats", url: target.url }, (response) => {
    if (panelTarget?.id !== id) return;
    const err = chrome.runtime.lastError;
    const payload = response as { ok?: boolean; error?: string; rows?: FormatRow[] } | undefined;
    if (err || !payload?.ok || !payload.rows) {
      if (listEl) listEl.replaceChildren();
      setStatus(err?.message || payload?.error || "Не удалось получить разрешения", true);
      positionPanel();
      return;
    }
    if (!runningText.get(id)) setStatus("");
    renderRows(payload.rows);
  });
}

function openPanel(): void {
  const target = pageTarget();
  if (!target) return;
  openPanelFor(target, null);
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
    const target = pageTarget();
    if (!target) return;
    if (open && panelTarget?.id === target.id) closePanel();
    else openPanelFor(target, null);
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
      if (!open || !slot || !panel || ignoreOutsideClose) return;
      const path = event.composedPath();
      if (!path.includes(slot) && !path.includes(panel)) closePanel();
    },
    true,
  );
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && event.isTrusted) closePanel();
  });
  window.addEventListener("resize", () => {
    if (open) positionPanel();
  });
}

function cardFromPath(path: Element[]): Element | null {
  for (const node of path) {
    if (node.matches(CARD_SEL)) return node;
  }
  return null;
}

function isMenuTrigger(path: Element[]): boolean {
  for (const node of path) {
    if (node.classList.contains("ytLockupMetadataViewModelMenuButton")) return true;
    if (node.localName === "ytd-menu-renderer" || node.localName === "yt-menu-renderer") return true;
    const label = (node.getAttribute("aria-label") || "").trim();
    if (/more actions|action menu|другие действия|другие варианты|меню действий|^ещё\b|^еще\b/i.test(label)) return true;
  }
  return false;
}

function linksDeep(root: Element): HTMLAnchorElement[] {
  const out: HTMLAnchorElement[] = [];
  const walk = (node: ParentNode): void => {
    for (const link of node.querySelectorAll("a[href]")) {
      if (link instanceof HTMLAnchorElement) out.push(link);
    }
    const nodes = node.querySelectorAll("*");
    for (const el of nodes) {
      if (el instanceof Element && el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(root);
  return out;
}

function videoFromCard(card: Element): Target | null {
  for (const link of linksDeep(card)) {
    const id = parseVideoId(link.href);
    if (id) return { id, url: watchUrl(id) };
  }
  const nodes = [card, ...card.querySelectorAll("[class*='content-id-']")];
  for (const el of nodes) {
    for (const cls of el.classList) {
      if (!cls.startsWith("content-id-")) continue;
      const id = cls.slice("content-id-".length);
      if (/^[\w-]{11}$/.test(id)) return { id, url: watchUrl(id) };
    }
  }
  return null;
}

function rememberCardMenu(event: Event): void {
  const path = event.composedPath().filter((node): node is Element => node instanceof Element);
  const card = cardFromPath(path);
  if (!card || !isMenuTrigger(path)) return;
  const target = videoFromCard(card);
  if (!target) return;
  menuTarget = target;
  menuCard = card;
  menuArmedUntil = Date.now() + 3000;
  armMenuInject();
}

function armMenuInject(): void {
  if (menuTimer) return;
  const tick = (): void => {
    injectDownloadItem();
    if (Date.now() < menuArmedUntil) menuTimer = window.setTimeout(tick, 80);
    else menuTimer = 0;
  };
  tick();
}

function isShown(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const style = getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
  const rect = el.getBoundingClientRect();
  return rect.width >= 120 && rect.width <= 480 && rect.height >= 36 && rect.height <= 640;
}

function addShadowRoots(root: Element, out: Array<Document | Element | ShadowRoot>, depth: number): void {
  const visit = (node: ParentNode, level: number): void => {
    if (level < 0) return;
    for (const el of node.querySelectorAll("*")) {
      if (!(el instanceof Element) || !el.shadowRoot) continue;
      out.push(el.shadowRoot);
      visit(el.shadowRoot, level - 1);
    }
  };
  if (root.shadowRoot) {
    out.push(root.shadowRoot);
    visit(root.shadowRoot, depth - 1);
  }
  visit(root, depth);
}

function menuSearchRoots(): Array<Document | Element | ShadowRoot> {
  const roots: Array<Document | Element | ShadowRoot> = [];
  const popup = document.querySelector("ytd-popup-container");
  if (popup) {
    roots.push(popup);
    if (popup.shadowRoot) roots.push(popup.shadowRoot);
  }
  for (const el of document.querySelectorAll(
    "tp-yt-iron-dropdown, ytd-menu-popup-renderer, yt-menu-popup-renderer, yt-menu-modern-popup-renderer, yt-list-view-model",
  )) {
    roots.push(el);
    if (el.shadowRoot) roots.push(el.shadowRoot);
  }
  if (menuCard?.isConnected) {
    roots.push(menuCard);
    addShadowRoots(menuCard, roots, 4);
  }
  if (roots.length === 0) roots.push(document);
  return roots;
}

function menuItemCount(el: Element): number {
  return [...el.children].filter(
    (kid) =>
      kid.classList.contains("ytdl-menu-item") ||
      kid.getAttribute("role") === "menuitem" ||
      kid.localName.includes("menu-service") ||
      kid.localName.includes("menu-item") ||
      kid.localName.includes("list-item"),
  ).length;
}

function looksLikeMenuList(el: Element): boolean {
  if (el.closest("#ytdl-panel")) return false;
  const role = el.getAttribute("role");
  const known =
    role === "menu" ||
    role === "listbox" ||
    el.id === "items" ||
    el.localName === "tp-yt-paper-listbox" ||
    el.localName.includes("menu-popup") ||
    el.localName.includes("list-view");
  const items = menuItemCount(el);
  if (items < 1 || (!known && items < 2)) return false;
  return isShown(el);
}

function pickMenuList(): Element | null {
  const listSel = "tp-yt-paper-listbox, #items, [role='menu'], [role='listbox'], yt-list-view-model";
  let best: Element | null = null;
  let bestArea = Infinity;
  const seen = new Set<Element>();
  const consider = (el: Element): void => {
    if (seen.has(el) || !looksLikeMenuList(el)) return;
    seen.add(el);
    const rect = el.getBoundingClientRect();
    const area = rect.width * rect.height;
    if (area < bestArea) {
      best = el;
      bestArea = area;
    }
  };
  for (const root of menuSearchRoots()) {
    for (const el of root.querySelectorAll(listSel)) {
      if (!(el instanceof Element)) continue;
      consider(el);
      const inner = el.shadowRoot?.querySelector("div, [role='menu'], [role='listbox']");
      if (inner instanceof Element) consider(inner);
      for (const node of el.shadowRoot?.querySelectorAll("div") ?? []) {
        if (node instanceof Element) consider(node);
      }
    }
  }
  return best;
}

function makeMenuButton(): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ytdl-menu-item";
  button.setAttribute("role", "menuitem");
  button.style.cssText = [
    "display:flex",
    "align-items:center",
    "gap:12px",
    "width:100%",
    "min-height:40px",
    "margin:0",
    "padding:0 16px 0 12px",
    "border:0",
    "background:transparent",
    "color:inherit",
    "font:14px/20px Roboto,Arial,sans-serif",
    "text-align:left",
    "cursor:pointer",
    "box-sizing:border-box",
    "pointer-events:auto",
  ].join(";");
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("width", "24");
  icon.setAttribute("height", "24");
  icon.setAttribute("fill", "currentColor");
  icon.setAttribute("aria-hidden", "true");
  icon.style.flex = "0 0 auto";
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M12 3a1 1 0 0 1 1 1v8.6l2.3-2.3a1 1 0 1 1 1.4 1.4l-4 4a1 1 0 0 1-1.4 0l-4-4a1 1 0 1 1 1.4-1.4L11 12.6V4a1 1 0 0 1 1-1zm-7 15a1 1 0 0 1 1-1h12a1 1 0 1 1 0 2H6a1 1 0 0 1-1-1z");
  icon.appendChild(path);
  const label = document.createElement("span");
  label.textContent = "Скачать";
  button.append(icon, label);
  button.addEventListener("pointerenter", () => {
    button.style.background = "rgba(128,128,128,0.18)";
  });
  button.addEventListener("pointerleave", () => {
    button.style.background = "transparent";
  });
  const activate = (event: Event): void => {
    event.preventDefault();
    event.stopPropagation();
    const target = menuTarget;
    if (!target) return;
    const rect = button.getBoundingClientRect();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
    window.setTimeout(() => {
      ignoreOutsideClose = true;
      openPanelFor(target, {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      });
      window.setTimeout(() => {
        ignoreOutsideClose = false;
      }, 350);
    }, 0);
  };
  button.addEventListener("click", activate);
  button.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
  });
  return button;
}

function injectDownloadItem(): void {
  if (!menuTarget) return;
  const host = pickMenuList();
  if (!host) return;
  if (!menuButton) menuButton = makeMenuButton();
  if (menuButton.parentElement !== host) host.insertBefore(menuButton, host.firstChild);
}

function boot(): void {
  if (window.top !== window) return;
  mount();
  schedulePlace();
  document.addEventListener("pointerdown", rememberCardMenu, true);
  document.addEventListener("yt-navigate-finish", () => {
    closePanel();
    menuArmedUntil = 0;
    schedulePlace();
  });
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
    const forPanel = message.videoId === panelTarget?.id;
    if (message.phase === "progress") {
      running.add(message.videoId);
      runningText.set(message.videoId, message.text || "Скачиваю…");
      if (forPanel) {
        setRowsDisabled(true);
        setStatus(message.text || "Скачиваю…");
        if (toastEl) toastEl.hidden = true;
      }
      return;
    }
    if (message.phase !== "done" && message.phase !== "error") return;
    running.delete(message.videoId);
    runningText.delete(message.videoId);
    if (forPanel) setRowsDisabled(false);
    if (message.phase === "done") {
      if (forPanel) setStatus("Файл в папке Загрузки");
      showToast(`Скачано: ${message.filename || "файл в папке Загрузки"}`);
      return;
    }
    if (forPanel) setStatus(message.error || "Не удалось скачать", true);
    showToast(message.error || "Не удалось скачать", true);
  });
}

boot();
