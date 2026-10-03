/** Учёт загрузок, автоскрытие и «Сделать доступным» */

import {
  findAnchorHost,
  findOverlayHost,
  getBlockReason,
  getCardIds,
  queryCardsDeepOuter,
  layoutOnThumb,
  showConfirm,
  syncHostShield,
  syncCardNavGuard,
  syncMountClickBlock,
} from "./block";

const VIEWS_KEY = "yti-views";
const AVAILABLE_KEY = "yti-available";
const DEFAULT_AUTO_HIDE_AFTER = 5;

const THUMB_TARGET_SEL = "yt-thumbnail-view-model,ytd-thumbnail,yt-img-shadow";
const ANCHOR_SEL = "a.ytLockupViewModelContentImage,a#thumbnail";
const BADGES_MOUNT_SEL = ".ytLockupViewModelHost,#dismissible,.yti-block-wrap";
const BADGE_VISIBLE =
  "display:block !important;visibility:visible !important;opacity:1 !important;";
const META_TARGET_SEL =
  ".ytLockupMetadataViewModelTitle,.ytLockupMetadataViewModelMetadata,#video-title," +
  "ytd-channel-name,yt-content-metadata-view-model,.metadata-snippet-text,#metadata-line,#description-text";
const THUMB_MARK = "yti-hidden-thumb";
const META_MARK = "yti-hidden-meta";

interface ViewEntry {
  count: number;
  noFirst?: boolean;
}

type ViewsMap = Record<string, ViewEntry>;

type ChangeCb = () => void;

let views: ViewsMap = {};
let available = new Set<string>();
let loaded = false;
let onChange: ChangeCb = () => undefined;
let isEnabled: () => boolean = () => false;
let isFeedPage: () => boolean = () => false;
let getAutoHideAfter: () => number = () => DEFAULT_AUTO_HIDE_AFTER;
let pendingBadgesTimer = 0;
const pendingBadgeCards = new Set<HTMLElement>();
const cardObserver = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      if (entry.target instanceof HTMLElement) syncViewsCard(entry.target);
    }
  },
  { root: null, rootMargin: "120px", threshold: 0 },
);

export function initViews(opts: {
  enabled: () => boolean;
  feedPage: () => boolean;
  onUpdate: ChangeCb;
  autoHideAfter: () => number;
}): void {
  isEnabled = opts.enabled;
  isFeedPage = opts.feedPage;
  onChange = opts.onUpdate;
  getAutoHideAfter = opts.autoHideAfter;
  document.getElementById("yti-badges-root")?.remove();
  loadViews();
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes[VIEWS_KEY]) applyViews(changes[VIEWS_KEY].newValue as ViewsMap | undefined);
      if (changes[AVAILABLE_KEY]) {
        available = new Set((changes[AVAILABLE_KEY].newValue as string[] | undefined) ?? []);
      }
      if (changes[VIEWS_KEY] || changes[AVAILABLE_KEY]) onChange();
    });
  } catch {
    /* ignore */
  }
}

function loadViews(): void {
  try {
    chrome.storage.local.get({ [VIEWS_KEY]: {}, [AVAILABLE_KEY]: [] }, (raw) => {
      applyViews(raw[VIEWS_KEY] as ViewsMap | undefined);
      available = new Set((raw[AVAILABLE_KEY] as string[] | undefined) ?? []);
      loaded = true;
      onChange();
    });
  } catch {
    loaded = true;
  }
}

function applyViews(raw: ViewsMap | undefined): void {
  views = raw ?? {};
}

function persistViews(): void {
  try {
    chrome.storage.local.set({ [VIEWS_KEY]: views });
  } catch {
    /* ignore */
  }
}

function saveViews(): void {
  persistViews();
  syncViewsUi();
  onChange();
}

function saveAvailable(): void {
  try {
    chrome.storage.local.set({ [AVAILABLE_KEY]: [...available] });
  } catch {
    /* ignore */
  }
  syncViewsUi();
  onChange();
}

function getEntry(videoId: string): ViewEntry {
  return views[videoId] ?? { count: 0 };
}

function setEntry(videoId: string, entry: ViewEntry): void {
  views[videoId] = entry;
}

export function isAvailableVideo(videoId: string | null): boolean {
  return videoId != null && available.has(videoId);
}

export function isHiddenVideo(videoId: string | null): boolean {
  if (!videoId || !isEnabled() || !isFeedPage()) return false;
  if (available.has(videoId)) return false;
  return getEntry(videoId).count > getAutoHideAfter();
}

export function shouldSkipHover(card: Element): boolean {
  if (!isEnabled() || !isFeedPage()) return false;
  const outer = resolveOuterCard(card);
  const { videoId, channelIds } = getCardIds(outer);
  if (getBlockReason(videoId, channelIds)) return false;
  return isHiddenVideo(videoId);
}

function resolveOuterCard(card: Element): Element {
  const outer = queryCardsDeepOuter();
  return outer.find((c) => c === card || c.contains(card)) ?? card;
}

function recordView(card: HTMLElement, videoId: string): number {
  if (card.dataset.ytiViewRecorded === videoId) return getEntry(videoId).count;
  const entry = getEntry(videoId);
  entry.count += 1;
  setEntry(videoId, entry);
  card.dataset.ytiViewRecorded = videoId;
  persistViews();
  syncViewsCard(card);
  return entry.count;
}

/** Счётчик растёт только после наведения на карточку (один раз за появление в ленте). */
export function onCardHovered(card: Element): void {
  if (!loaded || !isEnabled() || !isFeedPage()) return;
  const outer = resolveOuterCard(card);
  if (!(outer instanceof HTMLElement)) return;
  const { videoId, channelIds } = getCardIds(outer);
  if (!videoId) return;
  if (!getBlockReason(videoId, channelIds) && !isHiddenVideo(videoId)) recordView(outer, videoId);
}

function revealVideo(videoId: string): void {
  setEntry(videoId, { count: 1, noFirst: true });
  saveViews();
}

function makeAvailable(videoId: string): void {
  available.add(videoId);
  saveAvailable();
}

function queryInCard(card: Element, selector: string): HTMLElement[] {
  const found: HTMLElement[] = [];
  const seen = new Set<Element>();
  function walk(root: Document | ShadowRoot | Element): void {
    for (const el of root.querySelectorAll(selector)) {
      if (el instanceof HTMLElement && !seen.has(el)) {
        seen.add(el);
        found.push(el);
      }
    }
    for (const node of root.querySelectorAll("*")) {
      if (node instanceof Element && node.shadowRoot) walk(node.shadowRoot);
    }
  }
  if (card.shadowRoot) walk(card.shadowRoot);
  else walk(card);
  return found;
}

function setHiddenMarks(card: Element, hidden: boolean): void {
  for (const el of queryInCard(card, THUMB_TARGET_SEL)) el.classList.toggle(THUMB_MARK, hidden);
  for (const el of queryInCard(card, META_TARGET_SEL)) el.classList.toggle(META_MARK, hidden);
}

function btnStyle(extra = ""): string {
  return (
    "border:0;border-radius:8px;padding:6px 10px;font:500 12px Roboto,Arial,sans-serif;" +
    "cursor:pointer;pointer-events:auto;white-space:nowrap;" + extra
  );
}

function makeBtn(label: string, bg: string, fg: string, onClick: (e: MouseEvent) => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.style.cssText = btnStyle(`background:${bg};color:${fg}`);
  const run = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    void onClick(e as MouseEvent);
  };
  b.addEventListener("pointerup", run, true);
  b.addEventListener("click", run, true);
  return b;
}

/** Добавляет «Сделать доступным» в панель кнопок превью (вызывается из block.ts). */
export function syncAvailableButton(ui: HTMLElement, videoId: string): void {
  const existing = ui.querySelector(".yti-available-btn");
  if (!isEnabled() || !isFeedPage() || isAvailableVideo(videoId)) {
    existing?.remove();
    return;
  }
  if (existing instanceof HTMLButtonElement && existing.dataset.ytiVideoId === videoId) return;
  existing?.remove();
  const btn = makeBtn("Сделать доступным", "rgba(46,125,50,.92)", "#fff", async () => {
    const ok = await showConfirm(
      "Сделать доступным?",
      "Видео снова будет показываться в ленте и не будет автоматически скрываться.",
      { confirmLabel: "Сделать доступным", confirmBg: "#2e7d32" },
    );
    if (ok) makeAvailable(videoId);
  });
  btn.className = "yti-available-btn";
  btn.dataset.ytiVideoId = videoId;
  ui.appendChild(btn);
}

function mountFirstBadge(layer: HTMLElement, card: HTMLElement): void {
  if (layer.querySelector(".yti-first-badge")) return;
  setBadgesVisible(card, true);
  const badge = document.createElement("div");
  badge.className = "yti-first-badge";
  badge.textContent = "Первый";
  badge.setAttribute("aria-hidden", "true");
  badge.style.cssText =
    `${BADGE_VISIBLE}position:absolute;top:8px;right:8px;z-index:1;padding:2px 8px;` +
    "font:700 11px/1.3 Roboto,Arial,sans-serif;letter-spacing:.03em;text-transform:uppercase;" +
    "color:#fff;background:rgba(46,125,50,.95);border-radius:4px;" +
    "box-shadow:0 1px 4px rgba(0,0,0,.35);pointer-events:none";
  layer.appendChild(badge);
}

function clearFirstBadge(layer: HTMLElement, card: HTMLElement): void {
  layer.querySelector(".yti-first-badge")?.remove();
  if (!layer.childElementCount) setBadgesVisible(card, false);
}

function ensureHostPosition(host: HTMLElement): void {
  if (getComputedStyle(host).position === "static") host.style.position = "relative";
}

function findViewsHost(card: Element): HTMLElement | null {
  return findOverlayHost(card) ?? findAnchorHost(card);
}

type ThumbArea = { top: number; left: number; width: number; height: number };

function findBadgesMount(card: Element): HTMLElement | null {
  for (const el of queryInCard(card, BADGES_MOUNT_SEL)) return el;
  const host = findOverlayHost(card) ?? findAnchorHost(card);
  if (!host) return null;
  if (host.matches("a.ytLockupViewModelContentImage,a#thumbnail")) {
    return host.parentElement instanceof HTMLElement ? host.parentElement : host;
  }
  return host;
}

function cardBadgeId(card: HTMLElement): string {
  if (!card.dataset.ytiBadgeId) card.dataset.ytiBadgeId = `b${Math.random().toString(36).slice(2, 11)}`;
  return card.dataset.ytiBadgeId;
}

function badgeLayerKey(videoId: string, card: HTMLElement): string {
  return `${videoId}:${cardBadgeId(card)}`;
}

function areaFromElement(el: HTMLElement): ThumbArea | null {
  const rect = el.getBoundingClientRect();
  let width = rect.width || el.offsetWidth || el.clientWidth;
  let height = rect.height || el.offsetHeight || el.clientHeight;
  if (width >= 8 && height < 8) height = Math.round((width * 9) / 16);
  if (height >= 8 && width < 8) width = Math.round((height * 16) / 9);
  if (width < 8 || height < 8) return null;
  return { top: rect.top, left: rect.left, width, height };
}

function thumbHostArea(card: HTMLElement, mount: HTMLElement): ThumbArea | null {
  const mountRect = mount.getBoundingClientRect();
  for (const sel of [ANCHOR_SEL, THUMB_TARGET_SEL, "ytd-thumbnail"]) {
    for (const el of queryInCard(card, sel)) {
      if (!(el instanceof HTMLElement)) continue;
      const elRect = el.getBoundingClientRect();
      let width = elRect.width || el.offsetWidth || el.clientWidth;
      let height = elRect.height || el.offsetHeight || el.clientHeight;
      if (width >= 8 && height < 8) height = Math.round((width * 9) / 16);
      if (width >= 8 && height >= 8) {
        return {
          top: elRect.top - mountRect.top,
          left: elRect.left - mountRect.left,
          width,
          height,
        };
      }
    }
  }
  const width = mount.clientWidth || mountRect.width;
  if (width < 8) return null;
  return { top: 0, left: 0, width, height: Math.round(width * (9 / 16)) };
}

function findBadgeLayer(videoId: string, card: HTMLElement): HTMLElement | null {
  const key = badgeLayerKey(videoId, card);
  for (const layer of queryInCard(card, `.yti-badges-layer[data-yti-badge-key="${key}"]`)) {
    return layer;
  }
  return null;
}

function queueBadgeRetry(card: HTMLElement): void {
  pendingBadgeCards.add(card);
  if (pendingBadgesTimer) return;
  pendingBadgesTimer = window.setTimeout(() => {
    pendingBadgesTimer = 0;
    const batch = [...pendingBadgeCards];
    pendingBadgeCards.clear();
    for (const c of batch) syncViewsCard(c);
    if (pendingBadgeCards.size > 0) queueBadgeRetry(batch[0]!);
  }, 120);
}

function layoutHostLayer(layer: HTMLElement, area: ThumbArea): void {
  const sig = `${area.top},${area.left},${area.width},${area.height}`;
  if (layer.dataset.ytiArea === sig) return;
  layer.dataset.ytiArea = sig;
  layer.style.cssText =
    `${BADGE_VISIBLE}position:absolute;z-index:50;overflow:visible;pointer-events:none;border-radius:12px;` +
    `top:${area.top}px;left:${area.left}px;width:${area.width}px;height:${area.height}px;`;
}

function getBadgeLayer(card: HTMLElement, videoId: string): HTMLElement | null {
  const mount = findBadgesMount(card);
  if (!mount) return null;
  const area = thumbHostArea(card, mount);
  if (!area) return null;

  ensureHostPosition(mount);
  mount.style.setProperty("overflow", "visible", "important");
  card.classList.add("yti-has-view-badges");
  mount.classList.add("yti-has-view-badges");

  const key = badgeLayerKey(videoId, card);
  let layer = mount.querySelector(`:scope > .yti-badges-layer[data-yti-badge-key="${key}"]`) as HTMLElement | null;
  if (!layer) {
    layer = document.createElement("div");
    layer.className = "yti-badges-layer";
    layer.dataset.ytiBadgeKey = key;
    layer.dataset.ytiVideoId = videoId;
    layer.setAttribute("aria-hidden", "true");
    mount.appendChild(layer);
  }
  layoutHostLayer(layer, area);
  const before = mount.querySelector(":scope > .yti-views-ui, :scope > .yti-block-ui");
  if (layer.parentElement !== mount || layer.nextElementSibling !== before) {
    if (before) mount.insertBefore(layer, before);
    else mount.appendChild(layer);
  }
  return layer;
}

function setBadgesVisible(card: HTMLElement, visible: boolean): void {
  card.classList.toggle("yti-has-view-badges", visible);
  const mount = findBadgesMount(card);
  mount?.classList.toggle("yti-has-view-badges", visible);
}

function observeCard(card: HTMLElement): void {
  try {
    cardObserver.observe(card);
  } catch {
    /* ignore */
  }
}

function cleanupOrphanBadges(): void {
  const liveKeys = new Set<string>();
  for (const card of queryCardsDeepOuter()) {
    if (!(card instanceof HTMLElement)) continue;
    const { videoId } = getCardIds(card);
    if (videoId) liveKeys.add(badgeLayerKey(videoId, card));
  }
  for (const card of queryCardsDeepOuter()) {
    for (const layer of queryInCard(card, ".yti-badges-layer[data-yti-badge-key]")) {
      const key = layer.dataset.ytiBadgeKey;
      if (!key || !liveKeys.has(key)) layer.remove();
    }
  }
}

function clearCountBadge(layer: HTMLElement, card: HTMLElement): void {
  layer.querySelector(".yti-view-count")?.remove();
  if (!layer.childElementCount) setBadgesVisible(card, false);
}

function mountHiddenBadge(layer: HTMLElement, card: HTMLElement): void {
  if (layer.querySelector(".yti-hidden-badge")) return;
  setBadgesVisible(card, true);
  const badge = document.createElement("div");
  badge.className = "yti-hidden-badge";
  badge.textContent = "Скрыто";
  badge.setAttribute("aria-hidden", "true");
  badge.style.cssText =
    `${BADGE_VISIBLE}position:absolute;top:8px;left:8px;z-index:1;padding:2px 8px;` +
    "font:700 11px/1.3 Roboto,Arial,sans-serif;letter-spacing:.03em;text-transform:uppercase;" +
    "color:#fff;background:rgba(21,101,192,.92);border-radius:4px;" +
    "box-shadow:0 1px 4px rgba(0,0,0,.35);pointer-events:auto;cursor:default";
  bindBadgeShield(badge);
  layer.appendChild(badge);
}

function bindBadgeShield(el: HTMLElement): void {
  if (el.dataset.ytiClickShield) return;
  el.dataset.ytiClickShield = "1";
  const block = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  };
  for (const type of ["click", "auxclick"] as const) {
    el.addEventListener(type, block, true);
  }
}

function clearHiddenBadge(layer: HTMLElement): void {
  layer.querySelector(".yti-hidden-badge")?.remove();
}

function viewsOnlyUi(card: HTMLElement): HTMLElement | null {
  const host = findViewsHost(card);
  if (!host || host.querySelector(":scope > .yti-block-ui")) return null;
  return mountViewsUi(host);
}

function bindViewsUiHover(mount: HTMLElement): void {
  mount.dataset.ytiViewsUiBound = "1";
}

function mountThumbViewsUi(card: HTMLElement, mount: HTMLElement): HTMLElement {
  ensureHostPosition(mount);
  let ui = mount.querySelector(":scope > .yti-views-ui") as HTMLElement | null;
  if (!ui) {
    ui = document.createElement("div");
    ui.className = "yti-views-ui";
    mount.appendChild(ui);
  }
  layoutOnThumb(
    ui,
    mount,
    card,
    100,
    "display:flex;align-items:flex-end;justify-content:center;gap:6px;padding:8px;pointer-events:none;" +
      "background:linear-gradient(transparent 55%,rgba(0,0,0,.35));opacity:0;transition:opacity .15s;border-radius:12px;",
  );
  mount.appendChild(ui);
  mount.classList.add("yti-has-views-ui");
  bindViewsUiHover(mount);
  return ui;
}

function mountViewsUi(host: HTMLElement): HTMLElement {
  let ui = host.querySelector(":scope > .yti-views-ui") as HTMLElement | null;
  if (ui) return ui;
  ensureHostPosition(host);
  ui = document.createElement("div");
  ui.className = "yti-views-ui";
  ui.style.cssText =
    "position:absolute;inset:0;z-index:100;display:flex;align-items:flex-end;justify-content:center;" +
    "gap:6px;padding:8px;pointer-events:none;background:linear-gradient(transparent 55%,rgba(0,0,0,.35));" +
    "opacity:0;transition:opacity .15s;border-radius:inherit";
  host.appendChild(ui);
  host.classList.add("yti-has-views-ui");
  bindViewsUiHover(host);
  return ui;
}

function clearViewsBadges(card: HTMLElement, videoId?: string | null): void {
  if (videoId) findBadgeLayer(videoId, card)?.remove();
  for (const layer of queryInCard(card, ".yti-badges-layer")) layer.remove();
  card.classList.remove("yti-has-view-badges");
  findBadgesMount(card)?.classList.remove("yti-has-view-badges");
}

function applyCardBadges(
  card: HTMLElement,
  videoId: string,
  entry: ViewEntry,
  hidden: boolean,
): void {
  const count = entry.count;
  const showFirst = !entry.noFirst && count <= 1;
  const existing = findBadgeLayer(videoId, card);

  if (hidden) {
    if (existing) {
      clearFirstBadge(existing, card);
      clearCountBadge(existing, card);
    }
    const layer = getBadgeLayer(card, videoId);
    if (layer) mountHiddenBadge(layer, card);
    else queueBadgeRetry(card);
    return;
  }

  if (existing) clearHiddenBadge(existing);

  const layer = getBadgeLayer(card, videoId);
  if (!layer) {
    queueBadgeRetry(card);
    return;
  }
  if (showFirst) mountFirstBadge(layer, card);
  else clearFirstBadge(layer, card);
  clearCountBadge(layer, card);
}

function clearViewsUi(card: HTMLElement): void {
  const host = findViewsHost(card);
  const mount = findBadgesMount(card);
  if (host) {
    host.querySelector(".yti-available-btn")?.remove();
    if (!host.querySelector(":scope > .yti-block-ui")) {
      host.querySelector(":scope > .yti-views-ui")?.remove();
      host.classList.remove("yti-has-views-ui");
      delete host.dataset.ytiViewsUiBound;
    }
  }
  if (mount) {
    mount.querySelector(":scope > .yti-views-ui")?.remove();
    mount.classList.remove("yti-has-views-ui");
    delete mount.dataset.ytiViewsUiBound;
  }
  clearViewsBadges(card, getCardIds(card).videoId);
}

function syncViewsCard(card: Element): void {
  if (!(card instanceof HTMLElement)) return;

  const { videoId, channelIds } = getCardIds(card);
  observeCard(card);

  if (!isEnabled() || !isFeedPage() || !videoId) {
    card.classList.remove("yti-hidden");
    setHiddenMarks(card, false);
    if (!getBlockReason(videoId, channelIds)) {
      syncCardNavGuard(card, false);
      syncMountClickBlock(card, false);
      syncHostShield(findViewsHost(card), false);
    }
    clearViewsUi(card);
    delete card.dataset.ytiViewCount;
    return;
  }

  if (getBlockReason(videoId, channelIds)) {
    card.classList.remove("yti-hidden");
    setHiddenMarks(card, false);
    clearViewsUi(card);
    return;
  }

  const entry = getEntry(videoId);
  const count = entry.count;
  const hidden = isHiddenVideo(videoId);
  card.dataset.ytiViewCount = String(count);

  if (hidden) {
    card.classList.add("yti-hidden");
    setHiddenMarks(card, true);
    syncCardNavGuard(card, true);
    applyCardBadges(card, videoId, entry, true);
    syncHostShield(findViewsHost(card), true);
    syncMountClickBlock(card, true);
    const mount = findBadgesMount(card);
    findViewsHost(card)?.querySelector(":scope > .yti-views-ui")?.remove();
    if (mount) {
      const ui = mountThumbViewsUi(card, mount);
      const key = `show|${videoId}`;
      if (ui.dataset.ytiActions !== key) {
        ui.dataset.ytiActions = key;
        ui.replaceChildren();
        ui.appendChild(
          makeBtn("Показать", "#1565c0", "#fff", async () => {
            const ok = await showConfirm(
              "Показать видео?",
              "Видео снова станет видимым в ленте.",
              { confirmLabel: "Показать", confirmBg: "#1565c0" },
            );
            if (ok) revealVideo(videoId);
          }),
        );
      }
    }
    return;
  }

  card.classList.remove("yti-hidden");
  setHiddenMarks(card, false);
  syncCardNavGuard(card, false);
  syncMountClickBlock(card, false);
  syncHostShield(findViewsHost(card), false);
  applyCardBadges(card, videoId, entry, false);

  const ui = viewsOnlyUi(card);
  if (ui) syncAvailableButton(ui, videoId);
}

function resyncAllCards(): void {
  for (const card of queryCardsDeepOuter()) syncViewsCard(card);
  cleanupOrphanBadges();
}

export function syncViewsUi(): void {
  if (!loaded || !isEnabled()) return;
  if (!isFeedPage()) {
    for (const card of queryCardsDeepOuter()) {
      if (!(card instanceof HTMLElement)) continue;
      card.classList.remove("yti-hidden");
      clearViewsUi(card);
    }
    return;
  }
  resyncAllCards();
  requestAnimationFrame(() => {
    requestAnimationFrame(() => resyncAllCards());
  });
}
