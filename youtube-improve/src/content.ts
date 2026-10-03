/** YouTube Improve — content script */

import {
  getCardIds,
  initBlock,
  isBlockedCard,
  queryCardsDeepOuter,
  syncBlockUi,
  syncPageNavState,
} from "./block";
import {
  downloadBackupFile,
  importBackup,
  parseBackupText,
  readBackupFromStorage,
  type ImportMode,
} from "./backup";
import {
  initViews,
  isHiddenVideo,
  onCardHovered,
  shouldSkipHover,
  syncAvailableButton,
  syncViewsUi,
} from "./views";

interface Settings {
  blur: boolean;
  hoverPlay: boolean;
  blurAvatars: boolean;
  blurLinks: boolean;
  blockEnabled: boolean;
  viewsEnabled: boolean;
  dontRecommendEnabled: boolean;
  autoHideAfter: number;
}

const DEFAULTS: Settings = {
  blur: true,
  hoverPlay: true,
  blurAvatars: true,
  blurLinks: true,
  blockEnabled: true,
  viewsEnabled: true,
  dontRecommendEnabled: true,
  autoHideAfter: 5,
};

type BoolSettingKey = Exclude<keyof Settings, "autoHideAfter">;

const TOGGLES: { key: BoolSettingKey; label: string }[] = [
  { key: "blur", label: "Блюр превью" },
  { key: "hoverPlay", label: "При наведении" },
  { key: "blurAvatars", label: "Блюр аватаров" },
  { key: "blurLinks", label: "Блюр ссылок и соцсетей" },
  { key: "blockEnabled", label: "Блокировка видео" },
  { key: "viewsEnabled", label: "Учёт просмотров" },
  { key: "dontRecommendEnabled", label: "Не рекомендовать канал (главная)" },
];

const CARD_SEL =
  "ytd-rich-item-renderer,yt-lockup-view-model,ytd-rich-grid-media,ytd-video-renderer,ytd-compact-video-renderer,ytd-watch-card-compact-video-renderer,ytd-watch-card-hero-video-renderer,ytd-universal-watch-card-renderer";
const THUMB_SEL = "yt-thumbnail-view-model,ytd-thumbnail";
const THUMB_AREA_SEL =
  "a.ytLockupViewModelContentImage,a#thumbnail,ytd-thumbnail,yt-thumbnail-view-model,yt-img-shadow," +
  "yt-touch-feedback-shape,.yti-badges-layer,.yti-hidden-badge,.yti-block-strike,.yti-thumb-shield," +
  ".yti-mount-shield,.yti-view-count,.yti-first-badge,.yti-block-wrap,.yti-block-ui,.yti-views-ui";
const AVATAR_SEL = "yt-decorated-avatar-view-model,#channel-thumbnail,#author-thumbnail";
const LINK_MARK = "yti-blur-link";
const LINK_TEXT_MARK = "yti-blur-text";

const SOCIAL_HOSTS = [
  "t.me",
  "telegram.me",
  "telegram.org",
  "instagram.com",
  "instagr.am",
  "twitter.com",
  "x.com",
  "t.co",
  "facebook.com",
  "fb.com",
  "fb.me",
  "fb.watch",
  "tiktok.com",
  "vm.tiktok.com",
  "vk.com",
  "vk.ru",
  "vk.cc",
  "discord.com",
  "discord.gg",
  "twitch.tv",
  "reddit.com",
  "redd.it",
  "linkedin.com",
  "lnkd.in",
  "wa.me",
  "whatsapp.com",
  "chat.whatsapp.com",
  "snapchat.com",
  "pinterest.com",
  "pin.it",
  "threads.net",
  "ok.ru",
  "boosty.to",
  "patreon.com",
  "onlyfans.com",
  "soundcloud.com",
  "spotify.com",
  "open.spotify.com",
  "medium.com",
  "tumblr.com",
];

const SOCIAL_AT =
  "telegram|instagram|insta|twitter|x|tiktok|vk|discord|twitch|reddit|linkedin|" +
  "facebook|fb|threads|whatsapp|snapchat|pinterest|boosty|patreon|onlyfans|" +
  "odnoklassniki|ok|soundcloud|spotify|medium|tumblr";

const SOCIAL_DOMAIN_RE = SOCIAL_HOSTS.map((d) => d.replace(/\./g, "\\.")).join("|");

const LINK_TEXT_RE = new RegExp(
  `(?:https?:\\/\\/)?(?:[\\w-]+\\.)*(?:${SOCIAL_DOMAIN_RE})[^\\s<>,]*|` +
    `@(?:${SOCIAL_AT})\\b|` +
    `https?:\\/\\/[^\\s<>,]+`,
  "gi",
);
const TEXT_CONTAINER_SEL =
  "ytd-comment-renderer #content-text, .metadata-snippet-text, ytd-expansion-panel-content, " +
  "#description-inline-expander, ytd-watch-metadata, #snippet-text, yt-attributed-string";
const PREVIEW_SEL = "#video-preview,ytd-video-preview,ytd-video-preview-loader";
const FEED_SEL = "ytd-browse,ytd-search,ytd-rich-grid-renderer,ytd-watch-next-secondary-results-renderer";
const COMMENT_SEL = "ytd-comments,ytd-comment-thread-renderer,ytd-comment-replies-renderer";
const GUIDE_TAGS = new Set([
  "YTD-MINI-GUIDE-ENTRY-RENDERER",
  "YTD-GUIDE-ENTRY-RENDERER",
  "YTD-GUIDE-COLLAPSIBLE-ENTRY-RENDERER",
]);

// ── deep DOM (YouTube рендерит ленту в shadow) ──

function queryAllDeep(selector: string): Element[] {
  const found: Element[] = [];
  const seen = new Set<Element>();

  function walk(root: Document | ShadowRoot | Element): void {
    for (const el of root.querySelectorAll(selector)) {
      if (!seen.has(el)) {
        seen.add(el);
        found.push(el);
      }
    }
    for (const node of root.querySelectorAll("*")) {
      if (node instanceof Element && node.shadowRoot) walk(node.shadowRoot);
    }
  }

  walk(document);
  return found;
}

// ── storage (без background) ──

function storageGet(cb: (s: Settings) => void): void {
  try {
    const area = chrome.storage?.local;
    if (area && typeof area.get === "function") {
      area.get(DEFAULTS, (raw: Partial<Settings>) => cb({ ...DEFAULTS, ...raw }));
      return;
    }
  } catch {
    /* ignore */
  }
  cb(readSession());
}

function storageSet(s: Settings): void {
  writeSession(s);
  try {
    const area = chrome.storage?.local;
    if (area && typeof area.set === "function") area.set(s);
  } catch {
    /* ignore */
  }
}

function readSession(): Settings {
  try {
    const raw = sessionStorage.getItem("yti");
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    /* ignore */
  }
  return { ...DEFAULTS };
}

function writeSession(s: Settings): void {
  try {
    sessionStorage.setItem("yti", JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

// ── state ──

let settings: Settings = readSession();
let cssText: string | null = null;
let btn: HTMLButtonElement | null = null;
let menu: HTMLDivElement | null = null;
let menuOpen = false;
let hoverCard: Element | null = null;
const hovered = new Set<Element>();
const watched = new WeakSet<Node>();

// ── apply settings to page ──

function apply(): void {
  const html = document.documentElement;
  html.classList.toggle("yti-no-blur", !settings.blur);
  html.classList.toggle("yti-no-hover", !settings.hoverPlay);
  html.classList.toggle("yti-no-blur-avatars", !settings.blurAvatars);
  html.classList.toggle("yti-no-blur-links", !settings.blurLinks);
  html.classList.toggle("yti-no-block", !settings.blockEnabled);
  html.classList.toggle("yti-no-views", !settings.viewsEnabled);
  html.classList.remove("yti-no-infinite");
  syncMenu();
  syncPreviews();
  syncBlurLinks();
  syncBlockUi();
  syncViewsUi();
  syncPageNavState({
    blockEnabled: settings.blockEnabled,
    viewsEnabled: settings.viewsEnabled,
    dontRecommendEnabled: settings.dontRecommendEnabled,
    isHidden: (videoId) => isHiddenVideo(videoId),
  });
}

function syncPreviews(): void {
  for (const el of document.querySelectorAll(PREVIEW_SEL)) {
    if (!(el instanceof HTMLElement)) continue;
    if (settings.hoverPlay) {
      el.style.removeProperty("display");
      el.style.removeProperty("pointer-events");
    } else {
      el.style.setProperty("display", "none", "important");
      el.style.setProperty("pointer-events", "none", "important");
      for (const v of el.querySelectorAll("video")) {
        if (v instanceof HTMLVideoElement && !v.paused) v.pause();
      }
    }
  }
}

// ── UI: кнопка «Ещё» + меню (главная и поиск) ──

function isHomePage(): boolean {
  const path = location.pathname;
  return path === "/" || path === "";
}

function isSearchPage(): boolean {
  return location.pathname === "/results";
}

function showsControls(): boolean {
  return isHomePage() || isSearchPage();
}

function updateUiVisibility(): void {
  const show = showsControls();
  if (btn) btn.style.display = show ? "flex" : "none";
  if (!show) closeMenu();
}

function mountUi(): void {
  if (!document.body) return;

  if (!btn) {
    btn = document.createElement("button");
    btn.id = "yti-btn";
    btn.type = "button";
    btn.setAttribute("aria-label", "Улучшения");
    btn.style.cssText =
      "position:fixed;z-index:2147483647;bottom:0;left:0;display:flex;flex-direction:column;" +
      "align-items:center;gap:4px;width:72px;padding:10px 4px 14px;border:0;border-top:1px solid #ccc;" +
      "border-right:1px solid #ccc;background:#fff;color:#0f0f0f;cursor:pointer;" +
      "font:500 10px/1.2 Roboto,Arial,sans-serif;box-shadow:2px 0 8px rgba(0,0,0,.2)";
    btn.innerHTML = '<span style="font-size:18px;line-height:1">⚙</span><span style="font-size:10px">Ещё</span>';
    btn.onclick = (e) => {
      e.stopPropagation();
      menuOpen ? closeMenu() : openMenu();
    };
    document.body.appendChild(btn);
  }

  if (!menu) {
    menu = document.createElement("div");
    menu.id = "yti-menu";
    menu.style.cssText =
      "position:fixed;z-index:2147483647;display:none;width:260px;padding:8px 0;" +
      "background:#fff;color:#0f0f0f;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,.3);" +
      "font:14px Roboto,Arial,sans-serif";
    const title = document.createElement("div");
    title.textContent = "Улучшения";
    title.style.cssText = "padding:8px 16px 6px;font-size:16px;font-weight:500";
    menu.appendChild(title);
    for (const t of TOGGLES) {
      const row = document.createElement("label");
      row.style.cssText = "display:flex;align-items:center;gap:10px;padding:8px 16px;cursor:pointer";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.dataset.key = t.key;
      cb.checked = settings[t.key];
      cb.onchange = () => {
        settings = { ...settings, [t.key]: cb.checked };
        storageSet(settings);
        apply();
      };
      row.appendChild(cb);
      row.appendChild(document.createTextNode(t.label));
      menu.appendChild(row);
    }
    mountAutoHideRow(menu);
    mountBackupSection(menu);
    document.body.appendChild(menu);
  }

  positionBtn();
  syncMenu();
  updateUiVisibility();
}

function syncMenu(): void {
  if (!menu) return;
  for (const cb of menu.querySelectorAll("input[type=checkbox]")) {
    if (!(cb instanceof HTMLInputElement)) continue;
    const key = cb.dataset.key as BoolSettingKey | undefined;
    if (key) cb.checked = settings[key];
  }
  const autoHide = menu.querySelector("[data-yti-auto-hide]");
  if (autoHide instanceof HTMLInputElement) autoHide.value = String(settings.autoHideAfter);
}

function clampAutoHideAfter(value: number): number {
  if (!Number.isFinite(value)) return DEFAULTS.autoHideAfter;
  return Math.min(99, Math.max(1, Math.floor(value)));
}

function mountAutoHideRow(menuEl: HTMLDivElement): void {
  const row = document.createElement("label");
  row.style.cssText =
    "display:flex;align-items:center;gap:8px;padding:8px 16px;cursor:default;font-size:13px;flex-wrap:wrap";
  const input = document.createElement("input");
  input.type = "number";
  input.min = "1";
  input.max = "99";
  input.step = "1";
  input.dataset.ytiAutoHide = "1";
  input.style.cssText =
    "width:48px;padding:4px 6px;border:1px solid #ccc;border-radius:6px;font:inherit;cursor:text";
  input.onchange = () => {
    const n = clampAutoHideAfter(parseInt(input.value, 10));
    input.value = String(n);
    settings = { ...settings, autoHideAfter: n };
    storageSet(settings);
    apply();
  };
  row.append(
    document.createTextNode("Автоскрытие после "),
    input,
    document.createTextNode(" просмотров"),
  );
  menuEl.appendChild(row);
}

function menuBackupImportMode(): ImportMode {
  const merge = menu?.querySelector('input[data-yti-import-mode="merge"]');
  if (merge instanceof HTMLInputElement && merge.checked) return "merge";
  return "replace";
}

function setMenuBackupStatus(text: string, isError = false): void {
  const el = menu?.querySelector("[data-yti-backup-status]");
  if (!(el instanceof HTMLElement)) return;
  el.textContent = text;
  el.style.color = isError ? "#c62828" : text ? "#2e7d32" : "#606060";
}

function mountBackupSection(menuEl: HTMLDivElement): void {
  const hr = document.createElement("div");
  hr.style.cssText = "margin:6px 16px 0;border-top:1px solid #e5e5e5";
  menuEl.appendChild(hr);

  const title = document.createElement("div");
  title.textContent = "База данных";
  title.style.cssText = "padding:10px 16px 4px;font-size:13px;font-weight:500;color:#606060";
  menuEl.appendChild(title);

  const btnStyle =
    "flex:1;border:0;border-radius:8px;padding:8px 10px;font:500 13px Roboto,Arial,sans-serif;" +
    "cursor:pointer;background:#f2f2f2;color:#0f0f0f";
  const actions = document.createElement("div");
  actions.style.cssText = "display:flex;gap:8px;padding:4px 16px 8px";

  const exportBtn = document.createElement("button");
  exportBtn.type = "button";
  exportBtn.textContent = "Выгрузить";
  exportBtn.style.cssText = btnStyle;
  exportBtn.onmouseenter = () => {
    exportBtn.style.background = "#e5e5e5";
  };
  exportBtn.onmouseleave = () => {
    exportBtn.style.background = "#f2f2f2";
  };
  exportBtn.onclick = (e) => {
    e.stopPropagation();
    void (async () => {
      try {
        setMenuBackupStatus("Выгрузка…");
        const data = await readBackupFromStorage();
        downloadBackupFile(data);
        setMenuBackupStatus("База сохранена в файл");
      } catch (err) {
        setMenuBackupStatus(err instanceof Error ? err.message : "Ошибка выгрузки", true);
      }
    })();
  };

  const importBtn = document.createElement("button");
  importBtn.type = "button";
  importBtn.textContent = "Загрузить";
  importBtn.style.cssText = btnStyle;
  importBtn.onmouseenter = () => {
    importBtn.style.background = "#e5e5e5";
  };
  importBtn.onmouseleave = () => {
    importBtn.style.background = "#f2f2f2";
  };

  const importFile = document.createElement("input");
  importFile.type = "file";
  importFile.accept = "application/json,.json";
  importFile.hidden = true;
  importBtn.onclick = (e) => {
    e.stopPropagation();
    importFile.value = "";
    importFile.click();
  };
  importFile.onchange = () => {
    const file = importFile.files?.[0];
    if (!file) return;
    void (async () => {
      try {
        setMenuBackupStatus("Загрузка…");
        const mode = menuBackupImportMode();
        const data = parseBackupText(await file.text());
        await importBackup(data, mode);
        setMenuBackupStatus(mode === "merge" ? "База объединена" : "База заменена");
      } catch (err) {
        setMenuBackupStatus(err instanceof Error ? err.message : "Ошибка загрузки", true);
      }
    })();
  };

  actions.append(exportBtn, importBtn);
  menuEl.append(actions, importFile);

  for (const [mode, label, checked] of [
    ["merge", "Объединить с текущей", true],
    ["replace", "Заменить полностью", false],
  ] as const) {
    const row = document.createElement("label");
    row.style.cssText = "display:flex;align-items:center;gap:10px;padding:4px 16px;cursor:pointer;font-size:13px";
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "yti-import-mode";
    radio.dataset.ytiImportMode = mode;
    radio.checked = checked;
    row.append(radio, document.createTextNode(label));
    menuEl.appendChild(row);
  }

  const status = document.createElement("div");
  status.dataset.ytiBackupStatus = "1";
  status.style.cssText = "padding:0 16px 10px;font-size:12px;line-height:1.35;color:#606060;min-height:16px";
  menuEl.appendChild(status);
}

function positionBtn(): void {
  if (!btn) return;
  const guide = document.querySelector("ytd-mini-guide-renderer");
  if (guide instanceof Element) {
    const r = guide.getBoundingClientRect();
    if (r.width > 40) btn.style.left = `${r.left}px`;
  }
}

function positionMenu(): void {
  if (!btn || !menu) return;

  const gap = 8;
  const btnRect = btn.getBoundingClientRect();
  const menuHeight = menu.offsetHeight > 0 ? menu.offsetHeight : 160;
  const menuWidth = menu.offsetWidth > 0 ? menu.offsetWidth : 260;

  // кнопка внизу экрана — меню открываем вверх
  let top = btnRect.top - menuHeight - gap;
  top = Math.max(gap, Math.min(top, window.innerHeight - menuHeight - gap));

  let left = btnRect.right + gap;
  if (left + menuWidth > window.innerWidth - gap) {
    left = btnRect.left - menuWidth - gap;
  }
  left = Math.max(gap, Math.min(left, window.innerWidth - menuWidth - gap));

  menu.style.top = `${top}px`;
  menu.style.left = `${left}px`;
  menu.style.bottom = "auto";
}

function openMenu(): void {
  if (!showsControls() || !btn || !menu) return;
  positionBtn();
  menuOpen = true;
  menu.style.display = "block";
  positionMenu();
}

function closeMenu(): void {
  if (!menu) return;
  menuOpen = false;
  menu.style.display = "none";
}

// ── blur при наведении (класс yti-hover) ──

function onPointerOver(e: PointerEvent): void {
  const path = e.composedPath().filter((n): n is Element => n instanceof Element);
  if (path.some((n) => n.localName === "ytd-player" || n.id === "player")) return;
  let card: Element | null = null;
  for (const n of path) if (n.matches(CARD_SEL)) card = n;
  if (!card) return;
  if (isBlockedCard(card) || shouldSkipHover(card)) {
    clearHover();
    return;
  }
  if (settings.viewsEnabled && showsControls()) onCardHovered(card);
  if (hoverCard && hoverCard !== card) clearHover();
  hoverCard = card;
  card.classList.add("yti-hover");
  hovered.add(card);
  for (const n of path) {
    if (n.matches(THUMB_SEL) || (settings.blurAvatars && n.matches(AVATAR_SEL))) {
      n.classList.add("yti-hover");
      hovered.add(n);
    }
  }
}

function onPointerOut(e: PointerEvent): void {
  if (!hoverCard) return;
  const card = hoverCard;
  if (e.relatedTarget instanceof Element && onCard(e.relatedTarget, card)) return;
  const { clientX: x, clientY: y } = e;
  requestAnimationFrame(() => {
    if (hoverCard !== card) return;
    const under = document.elementFromPoint(x, y);
    if (under instanceof Element && onCard(under, card)) return;
    clearHover();
    if (hoverCard === card) hoverCard = null;
  });
}

function onCard(node: Element, card: Element): boolean {
  for (let n: Element | null = node; n; n = n.parentElement) {
    if (n === card) return true;
    if (n.matches(PREVIEW_SEL)) return true;
  }
  return false;
}

function clearHover(): void {
  for (const n of hovered) n.classList.remove("yti-hover");
  hovered.clear();
}

function isExtensionControl(el: Element): boolean {
  return (
    el.closest(
      ".yti-block-ui button,.yti-views-ui button,#yti-block-modal,#yti-block-modal button,#yti-btn,#yti-menu",
    ) !== null
  );
}

function videoIdFromPath(path: Element[]): string | null {
  for (const n of path) {
    if (!(n instanceof Element)) continue;
    for (const cls of n.classList) {
      if (!cls.startsWith("content-id-")) continue;
      const id = cls.slice("content-id-".length);
      if (/^[\w-]{11}$/.test(id)) return id;
    }
  }
  for (const n of path) {
    if (!(n instanceof Element)) continue;
    const outer = queryCardsDeepOuter().find((c) => c.contains(n));
    if (!outer) continue;
    const { videoId } = getCardIds(outer);
    if (videoId) return videoId;
  }
  return null;
}

function pathHasHiddenOrBlocked(path: Element[]): boolean {
  const videoId = videoIdFromPath(path);
  if (videoId) {
    if (settings.viewsEnabled && isHiddenVideo(videoId)) return true;
    if (settings.blockEnabled) {
      for (const n of path) {
        if (!(n instanceof Element)) continue;
        const outer = queryCardsDeepOuter().find((c) => c.contains(n));
        if (outer && isBlockedCard(outer)) return true;
      }
    }
    return false;
  }
  for (const n of path) {
    if (settings.viewsEnabled && n.classList?.contains("yti-hidden")) return true;
    if (settings.blockEnabled && n.classList?.contains("yti-blocked")) return true;
  }
  return false;
}

function isMenuButtonInPath(path: Element[]): boolean {
  let hasMenuRenderer = false;
  for (const n of path) {
    if (n.classList?.contains("ytLockupMetadataViewModelMenuButton")) return true;
    if (n.localName === "ytd-menu-renderer") hasMenuRenderer = true;
    const label = n.getAttribute?.("aria-label");
    if (label === "More actions" || label === "Action menu") return true;
  }
  return hasMenuRenderer && path.some((n) => n.id === "button" || n.localName === "button");
}

function isThumbAreaInPath(path: Element[]): boolean {
  return path.some((n) => n.matches?.(THUMB_AREA_SEL));
}

function cardIsProtected(path: Element[]): boolean {
  return pathHasHiddenOrBlocked(path);
}

function shouldBlockThumbNav(e: Event): boolean {
  const path = e.composedPath().filter((n): n is Element => n instanceof Element);
  if (path.some((n) => isExtensionControl(n))) return false;
  if (isMenuButtonInPath(path)) return false;
  if (!cardIsProtected(path)) return false;
  if (!isThumbAreaInPath(path)) return false;
  return true;
}

function blockHiddenOrBlockedNav(e: Event): void {
  if (!shouldBlockThumbNav(e)) return;
  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();
}

// ── Shorts в sidebar + blur CSS в shadow DOM ──

function isShortsLink(a: HTMLAnchorElement): boolean {
  try {
    const u = new URL(a.href, location.href);
    if (u.pathname.startsWith("/shorts")) return true;
  } catch {
    /* ignore */
  }
  return a.title === "Shorts" || a.getAttribute("aria-label") === "Shorts";
}

function isShortsShelf(el: Element): boolean {
  if (el.hasAttribute("is-shorts")) return true;
  if (el.localName === "ytd-reel-shelf-renderer") return true;
  if (el.querySelector("ytm-shorts-lockup-view-model, ytm-shorts-lockup-view-model-v2, a[href*='/shorts/']")) {
    return true;
  }
  const title = el.querySelector("#title");
  if (title?.textContent?.trim() === "Shorts") return true;
  for (const node of el.querySelectorAll("[aria-label]")) {
    const label = node.getAttribute("aria-label") ?? "";
    if (/^Shorts\b/i.test(label)) return true;
  }
  return false;
}

function isYoutubeHost(host: string): boolean {
  const h = host.replace(/^www\./, "").toLowerCase();
  return h === "youtube.com" || h === "youtu.be" || h === "m.youtube.com";
}

function normalizeHost(host: string): string {
  return host.replace(/^(?:www|m|mobile)\./, "").toLowerCase();
}

function isSocialHost(host: string): boolean {
  const h = normalizeHost(host);
  return SOCIAL_HOSTS.some((social) => h === social || h.endsWith(`.${social}`));
}

function isExternalHref(href: string): boolean {
  try {
    const u = new URL(href, location.href);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    return !isYoutubeHost(u.hostname);
  } catch {
    return false;
  }
}

function shouldBlurLink(a: HTMLAnchorElement): boolean {
  if (a.closest("ytd-topbar-menu-button-renderer, #yti-menu, #yti-btn")) return false;
  if (a.matches("#video-title, .ytLockupMetadataViewModelTitle, a.ytLockupViewModelContentImage")) return false;
  try {
    const u = new URL(a.href, location.href);
    if (isSocialHost(u.hostname)) return true;
  } catch {
    /* ignore */
  }
  return isExternalHref(a.href);
}

function unwrapBlurText(): void {
  for (const span of queryAllDeep(`span.${LINK_TEXT_MARK}`)) {
    const parent = span.parentNode;
    if (!parent) continue;
    while (span.firstChild) parent.insertBefore(span.firstChild, span);
    parent.removeChild(span);
    parent.normalize();
  }
}

function clearBlurLinkMarks(): void {
  for (const el of queryAllDeep(`a.${LINK_MARK}`)) el.classList.remove(LINK_MARK);
  unwrapBlurText();
}

function wrapTextNode(textNode: Text): void {
  const parent = textNode.parentElement;
  if (!parent || parent.closest(`span.${LINK_TEXT_MARK}, a, script, style`)) return;
  if (!parent.closest(TEXT_CONTAINER_SEL)) return;

  const text = textNode.textContent ?? "";
  LINK_TEXT_RE.lastIndex = 0;
  if (!LINK_TEXT_RE.test(text)) return;
  LINK_TEXT_RE.lastIndex = 0;

  const frag = document.createDocumentFragment();
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = LINK_TEXT_RE.exec(text))) {
    if (match.index > last) frag.appendChild(document.createTextNode(text.slice(last, match.index)));
    const span = document.createElement("span");
    span.className = LINK_TEXT_MARK;
    span.textContent = match[0];
    frag.appendChild(span);
    last = match.index + match[0].length;
  }
  if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
  textNode.parentNode?.replaceChild(frag, textNode);
}

function markBlurText(): void {
  for (const root of queryAllDeep(TEXT_CONTAINER_SEL)) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n instanceof Text && n.textContent?.trim()) nodes.push(n);
    }
    for (const node of nodes) wrapTextNode(node);
  }
}

function markBlurLinks(): void {
  for (const a of queryAllDeep("a[href]")) {
    if (!(a instanceof HTMLAnchorElement)) continue;
    if (shouldBlurLink(a)) a.classList.add(LINK_MARK);
    else a.classList.remove(LINK_MARK);
  }
  markBlurText();
}

function syncBlurLinks(): void {
  if (!settings.blurLinks) {
    clearBlurLinkMarks();
    return;
  }
  markBlurLinks();
}

function hideShortsShelves(): void {
  for (const shelf of queryAllDeep("ytd-rich-shelf-renderer, ytd-reel-shelf-renderer")) {
    if (!isShortsShelf(shelf)) continue;
    if (shelf instanceof HTMLElement) shelf.style.setProperty("display", "none", "important");
    const section = shelf.closest("ytd-rich-section-renderer");
    if (section instanceof HTMLElement) section.style.setProperty("display", "none", "important");
  }
}

function hideGuideEntry(el: Element): void {
  if (!GUIDE_TAGS.has(el.tagName)) return;
  const root = el.shadowRoot ?? el;
  let hide = false;
  for (const a of root.querySelectorAll("a[href]")) {
    if (a instanceof HTMLAnchorElement && isShortsLink(a)) hide = true;
  }
  if (el instanceof HTMLElement) {
    if (hide) el.style.setProperty("display", "none", "important");
    else el.style.removeProperty("display");
  }
}

function injectShadow(root: ShadowRoot): void {
  if (!cssText || root.getElementById("yti-style")) return;
  const s = document.createElement("style");
  s.id = "yti-style";
  s.textContent = cssText;
  root.appendChild(s);
}

function walkShadow(node: Element): void {
  if (node.shadowRoot) {
    injectShadow(node.shadowRoot);
    watch(node.shadowRoot);
    hideGuideEntry(node);
    for (const c of node.shadowRoot.querySelectorAll("*")) {
      if (c instanceof Element && c.shadowRoot) walkShadow(c);
    }
  }
  if (GUIDE_TAGS.has(node.tagName)) hideGuideEntry(node);
}

function walkAllShadows(): void {
  if (!cssText) return;
  const app = document.querySelector("ytd-app");
  if (app instanceof Element) walkShadow(app);
  walkShadow(document.documentElement);
}

let scanTimer = 0;

function scheduleScan(full = false): void {
  window.clearTimeout(scanTimer);
  scanTimer = window.setTimeout(() => scan(full), full ? 0 : 250);
}

function watch(root: Node): void {
  if (watched.has(root)) return;
  watched.add(root);
  new MutationObserver(() => scheduleScan(false)).observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["href", "title", "aria-label"],
  });
}

// ── boot ──

function scan(full = false): void {
  mountUi();
  updateUiVisibility();
  syncPreviews();
  hideShortsShelves();
  syncBlurLinks();
  syncBlockUi();
  syncViewsUi();
  if (full) walkAllShadows();
}

function boot(): void {
  if (window.top !== window) return;
  document.documentElement.setAttribute("data-yti-loaded", "1");
  initViews({
    enabled: () => settings.viewsEnabled,
    feedPage: showsControls,
    onUpdate: () => scheduleScan(false),
    autoHideAfter: () => settings.autoHideAfter,
  });
  initBlock({
    enabled: () => settings.blockEnabled,
    isHidden: (videoId) => settings.viewsEnabled && isHiddenVideo(videoId),
    onUpdate: () => scheduleScan(false),
    syncExtraButtons: (ui, videoId) => {
      if (settings.viewsEnabled) syncAvailableButton(ui, videoId);
    },
  });
  apply();
  storageGet((s) => {
    settings = s;
    apply();
  });
  try {
    localStorage.removeItem("yti-infinite");
  } catch {
    /* ignore */
  }
  try {
    chrome.storage.onChanged.addListener(() => {
      storageGet((s) => {
        settings = s;
        apply();
      });
    });
  } catch {
    /* ignore */
  }
  document.addEventListener("pointerover", onPointerOver, true);
  document.addEventListener("pointerout", onPointerOut, true);
  for (const type of ["click", "pointerup", "auxclick"] as const) {
    document.addEventListener(type, blockHiddenOrBlockedNav, true);
  }
  document.addEventListener("click", (e) => {
    if (!menuOpen || !menu || !btn) return;
    const path = e.composedPath();
    if (!path.includes(menu) && !path.includes(btn)) closeMenu();
  }, true);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeMenu();
  });
  document.addEventListener("yt-navigate-finish", () => scheduleScan(true));
  window.addEventListener("resize", () => {
    positionBtn();
    if (menuOpen) positionMenu();
  });
  watch(document.documentElement);
  scheduleScan(true);
  try {
    const url = chrome.runtime.getURL("content.css");
    fetch(url)
      .then((r) => r.text())
      .then((t) => {
        cssText = t;
        scheduleScan(true);
      })
      .catch(() => undefined);
  } catch {
    /* ignore */
  }
}

boot();
