/** Блокировка видео и каналов (chrome.storage.local) */

export interface BlockData {
  videos: string[];
  channels: string[];
}

export type BlockReason = "video" | "channel";

const STORAGE_KEY = "yti-blocks";
const EMPTY: BlockData = { videos: [], channels: [] };

const BLOCK_CARD_SEL =
  "ytd-rich-item-renderer,yt-lockup-view-model,ytd-video-renderer,ytd-compact-video-renderer," +
  "ytd-grid-video-renderer,ytd-watch-card-compact-video-renderer,ytd-universal-watch-card-renderer";
const ANCHOR_HOST_SEL = "a.ytLockupViewModelContentImage,a#thumbnail";
const THUMB_MOUNT_SEL = ".ytLockupViewModelHost,#dismissible,.yti-block-wrap";
const THUMB_TARGET_SEL = "yt-thumbnail-view-model,ytd-thumbnail,yt-img-shadow";
type ThumbArea = { top: number; left: number; width: number; height: number };
const META_TARGET_SEL =
  ".ytLockupMetadataViewModelTitle,.ytLockupMetadataViewModelMetadata,#video-title," +
  "ytd-channel-name,yt-content-metadata-view-model,.metadata-snippet-text,#metadata-line,#description-text";
const THUMB_MARK = "yti-blocked-thumb";
const META_MARK = "yti-blocked-meta";

let videos = new Set<string>();
let channels = new Set<string>();
let loaded = false;
let modalOpen = false;

type ChangeCb = () => void;
let onChange: ChangeCb = () => undefined;
let isEnabled: () => boolean = () => false;
let checkHidden: (videoId: string | null) => boolean = () => false;
let syncExtraButtons: ((ui: HTMLElement, videoId: string) => void) | undefined;

export function initBlock(opts: {
  enabled: () => boolean;
  onUpdate: ChangeCb;
  isHidden?: (videoId: string | null) => boolean;
  syncExtraButtons?: (ui: HTMLElement, videoId: string) => void;
}): void {
  isEnabled = opts.enabled;
  onChange = opts.onUpdate;
  checkHidden = opts.isHidden ?? (() => false);
  syncExtraButtons = opts.syncExtraButtons;
  loadBlocks();
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes[STORAGE_KEY]) return;
      applyData(changes[STORAGE_KEY].newValue as BlockData | undefined);
      onChange();
    });
  } catch {
    /* ignore */
  }
}

function loadBlocks(): void {
  try {
    chrome.storage.local.get(STORAGE_KEY, (raw) => {
      applyData(raw[STORAGE_KEY] as BlockData | undefined);
      loaded = true;
      onChange();
    });
  } catch {
    loaded = true;
  }
}

function applyData(raw: BlockData | undefined): void {
  const data = raw ?? EMPTY;
  videos = new Set(data.videos.filter(Boolean));
  channels = new Set(data.channels.filter(Boolean).map(normalizeChannelKey));
}

function saveBlocks(): void {
  const data: BlockData = { videos: [...videos], channels: [...channels] };
  try {
    chrome.storage.local.set({ [STORAGE_KEY]: data });
  } catch {
    /* ignore */
  }
  syncBlockUi();
  onChange();
}

export function parseVideoId(href: string): string | null {
  try {
    const u = new URL(href, location.href);
    if (u.pathname === "/watch") return u.searchParams.get("v");
    if (u.pathname.startsWith("/shorts/")) {
      const id = u.pathname.split("/")[2];
      return id || null;
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function parseChannelKey(href: string): string | null {
  try {
    const u = new URL(href, location.href);
    if (u.pathname.startsWith("/@")) return u.pathname;
    const m = u.pathname.match(/^\/channel\/([^/?#]+)/);
    if (m) return `/channel/${m[1]}`;
    const c = u.pathname.match(/^\/c\/([^/?#]+)/);
    if (c) return `/c/${c[1]}`;
  } catch {
    /* ignore */
  }
  return null;
}

function normalizeChannelKey(key: string): string {
  if (key.startsWith("/@")) return key.toLowerCase();
  return key;
}

function queryLinksDeep(card: Element): HTMLAnchorElement[] {
  return queryInCard(card, "a[href]").filter((el): el is HTMLAnchorElement => el instanceof HTMLAnchorElement);
}

export function getCardChannelIds(card: Element): string[] {
  const ids = new Set<string>();
  for (const a of queryLinksDeep(card)) {
    const key = parseChannelKey(a.href);
    if (key) ids.add(normalizeChannelKey(key));
  }
  return [...ids];
}

function parseContentIdVideo(card: Element): string | null {
  for (const el of queryInCard(card, "[class*='content-id-']")) {
    for (const cls of el.classList) {
      if (!cls.startsWith("content-id-")) continue;
      const id = cls.slice("content-id-".length);
      if (/^[\w-]{11}$/.test(id)) return id;
    }
  }
  return null;
}

export function getCardIds(card: Element): { videoId: string | null; channelIds: string[] } {
  let videoId: string | null = null;
  const channelIds = new Set<string>();
  for (const a of queryLinksDeep(card)) {
    if (!videoId) videoId = parseVideoId(a.href);
    const key = parseChannelKey(a.href);
    if (key) channelIds.add(normalizeChannelKey(key));
  }
  if (!videoId) videoId = parseContentIdVideo(card);
  return { videoId, channelIds: [...channelIds] };
}

export function getBlockReason(videoId: string | null, channelIds: string[]): BlockReason | null {
  if (videoId && videos.has(videoId)) return "video";
  if (channelIds.some((id) => channels.has(id))) return "channel";
  return null;
}

function expandChannelGroup(seedIds: string[]): Set<string> {
  const group = new Set(seedIds.filter(Boolean));
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const card of queryCardsDeepOuter()) {
      const ids = getCardChannelIds(card);
      if (!ids.some((id) => group.has(id))) continue;
      for (const id of ids) {
        if (!group.has(id)) {
          group.add(id);
          expanded = true;
        }
      }
    }
  }
  return group;
}

function blockChannelFromCard(card: Element): void {
  const group = expandChannelGroup(getCardChannelIds(card));
  for (const id of group) channels.add(id);
  saveBlocks();
  const { videoId } = getCardIds(card);
  document.dispatchEvent(
    new CustomEvent("yti-block-channel", {
      detail: { channelIds: [...group], contentId: videoId ?? parseContentIdVideo(card) },
    }),
  );
}

function unblockChannelFromCard(card: Element): void {
  const group = expandChannelGroup(getCardChannelIds(card));
  for (const id of group) channels.delete(id);
  saveBlocks();
  document.dispatchEvent(new CustomEvent("yti-unblock-channel", { detail: { channelIds: [...group] } }));
}

function blockVideo(id: string): void {
  videos.add(id);
  saveBlocks();
}


function unblockVideo(id: string): void {
  videos.delete(id);
  saveBlocks();
}


function btnStyle(extra = ""): string {
  return (
    "border:0;border-radius:8px;padding:6px 10px;font:500 12px Roboto,Arial,sans-serif;" +
    "cursor:pointer;pointer-events:auto;white-space:nowrap;" +
    extra
  );
}

export function showConfirm(
  title: string,
  message: string,
  opts?: { confirmLabel?: string; confirmBg?: string },
): Promise<boolean> {
  if (modalOpen) return Promise.resolve(false);
  const confirmLabel = opts?.confirmLabel ?? "Заблокировать";
  const confirmBg = opts?.confirmBg ?? "#c62828";
  return new Promise((resolve) => {
    modalOpen = true;
    const backdrop = document.createElement("div");
    backdrop.id = "yti-block-modal";
    backdrop.style.cssText =
      "position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.55);" +
      "display:flex;align-items:center;justify-content:center;font:14px Roboto,Arial,sans-serif";

    const box = document.createElement("div");
    box.style.cssText =
      "background:#fff;color:#0f0f0f;border-radius:12px;padding:20px 22px;max-width:340px;" +
      "box-shadow:0 8px 32px rgba(0,0,0,.35)";

    const h = document.createElement("div");
    h.textContent = title;
    h.style.cssText = `font-size:16px;font-weight:500;${message ? "margin-bottom:8px" : "margin-bottom:16px"}`;

    const p = document.createElement("div");
    if (message) {
      p.textContent = message;
      p.style.cssText = "margin-bottom:16px;line-height:1.45;color:#333";
    }

    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;gap:8px;justify-content:flex-end";

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Отмена";
    cancel.style.cssText = btnStyle("background:#f2f2f2;color:#0f0f0f");

    const ok = document.createElement("button");
    ok.type = "button";
    ok.textContent = confirmLabel;
    ok.style.cssText = btnStyle(`background:${confirmBg};color:#fff`);

    function close(result: boolean): void {
      modalOpen = false;
      backdrop.remove();
      resolve(result);
    }

    cancel.onclick = (e) => {
      e.stopPropagation();
      close(false);
    };
    ok.onclick = (e) => {
      e.stopPropagation();
      close(true);
    };
    backdrop.onclick = (e) => {
      if (e.target === backdrop) close(false);
    };

    actions.appendChild(cancel);
    actions.appendChild(ok);
    box.appendChild(h);
    if (message) box.appendChild(p);
    box.appendChild(actions);
    backdrop.appendChild(box);
    document.body.appendChild(backdrop);
  });
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

function setBlockedMarks(card: Element, blocked: boolean): void {
  for (const el of queryInCard(card, THUMB_TARGET_SEL)) {
    el.classList.toggle(THUMB_MARK, blocked);
  }
  for (const el of queryInCard(card, META_TARGET_SEL)) {
    el.classList.toggle(META_MARK, blocked);
  }
}

export function findAnchorHost(card: Element): HTMLElement | null {
  for (const el of queryInCard(card, ANCHOR_HOST_SEL)) return el;
  return null;
}

function findAnchorForThumb(thumb: HTMLElement): HTMLElement | null {
  let el: HTMLElement | null = thumb.parentElement;
  while (el) {
    if (el.matches("a.ytLockupViewModelContentImage,a#thumbnail")) return el;
    if (el.matches("ytd-thumbnail,yt-thumbnail-view-model,yt-lockup-view-model,ytd-video-renderer")) break;
    el = el.parentElement;
  }
  return null;
}

function wrapThumb(thumb: HTMLElement): HTMLElement {
  const parent = thumb.parentElement;
  if (parent?.classList.contains("yti-block-wrap")) return parent;
  if (!parent) return thumb;

  const wrap = document.createElement("div");
  wrap.className = "yti-block-wrap";
  wrap.style.cssText = "position:relative;display:inline-block;max-width:100%;vertical-align:top;";
  parent.insertBefore(wrap, thumb);
  wrap.appendChild(thumb);
  return wrap;
}

function cleanupLegacyOverlays(card: Element): void {
  for (const el of queryInCard(card, `${THUMB_TARGET_SEL},${ANCHOR_HOST_SEL}`)) {
    el.querySelector(".yti-block-strike")?.remove();
    el.querySelector(".yti-block-ui")?.remove();
    el.classList.remove("yti-has-block-ui");
    delete (el as HTMLElement).dataset.ytiBlockUiBound;
  }
}

/** Overlay host must sit outside blurred thumbnail nodes (filter blurs all descendants). */
export function findOverlayHost(card: Element): HTMLElement | null {
  const existing = queryInCard(card, ".yti-block-wrap")[0];
  if (existing) return existing;

  const thumb = queryInCard(card, THUMB_TARGET_SEL)[0] ?? null;
  if (!thumb) return findAnchorHost(card);

  const anchor = findAnchorForThumb(thumb);
  if (anchor && !thumb.matches("ytd-thumbnail")) return anchor;

  if (thumb.matches("ytd-thumbnail,yt-thumbnail-view-model,yt-img-shadow")) return wrapThumb(thumb);

  return thumb.parentElement instanceof HTMLElement ? thumb.parentElement : null;
}

function ensureHostPosition(host: HTMLElement): void {
  if (getComputedStyle(host).position === "static") host.style.position = "relative";
}

function clearStrike(host: HTMLElement): void {
  host.querySelector(".yti-block-strike")?.remove();
}

function mountStrike(host: HTMLElement): void {
  ensureHostPosition(host);
  if (host.querySelector(":scope > .yti-block-strike")) return;
  const strike = document.createElement("div");
  strike.className = "yti-block-strike";
  strike.setAttribute("aria-hidden", "true");
  bindStrikeShield(strike);
  host.appendChild(strike);
}

function bindClickShield(el: HTMLElement): void {
  if (el.dataset.ytiClickShield) return;
  el.dataset.ytiClickShield = "1";
  const block = (e: Event) => {
    if ((e.target as Element | null)?.closest(".yti-block-ui button,.yti-views-ui button")) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  };
  for (const type of ["click", "pointerdown", "pointerup", "auxclick"] as const) {
    el.addEventListener(type, block, true);
  }
}

export function findThumbMount(card: Element): HTMLElement | null {
  for (const el of queryInCard(card, THUMB_MOUNT_SEL)) return el;
  return findOverlayHost(card);
}

export function thumbAreaOnMount(card: Element, mount: HTMLElement): ThumbArea | null {
  const mountRect = mount.getBoundingClientRect();
  for (const sel of [ANCHOR_HOST_SEL, THUMB_TARGET_SEL, "ytd-thumbnail"]) {
    for (const el of queryInCard(card, sel)) {
      if (!(el instanceof HTMLElement)) continue;
      const elRect = el.getBoundingClientRect();
      let width = elRect.width || el.clientWidth;
      let height = elRect.height || el.clientHeight;
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

export function layoutOnThumb(
  el: HTMLElement,
  mount: HTMLElement,
  card: Element,
  zIndex: number,
  extra = "",
): void {
  ensureHostPosition(mount);
  const area = thumbAreaOnMount(card, mount);
  el.style.cssText = area
    ? `position:absolute;z-index:${zIndex};top:${area.top}px;left:${area.left}px;` +
      `width:${area.width}px;height:${area.height}px;${extra}`
    : `position:absolute;inset:0;z-index:${zIndex};${extra}`;
}

/** Снимает href с превью — page-patch блокирует навигацию по ID из dataset. */
export function syncCardNavGuard(card: Element, block: boolean): void {
  syncThumbLinks(card, block);
}

export function getBlockedChannelKeys(): string[] {
  return [...channels];
}

/** Списки ID для MAIN world (page-patch) — без data-атрибутов на карточках. */
export function syncPageNavState(opts: {
  blockEnabled: boolean;
  viewsEnabled: boolean;
  dontRecommendEnabled: boolean;
  isHidden: (videoId: string) => boolean;
}): void {
  const blocked: string[] = [];
  const hidden: string[] = [];
  const channelBlockedCards: string[] = [];
  for (const card of queryCardsDeepOuter()) {
    const { videoId, channelIds } = getCardIds(card);
    if (!videoId) continue;
    const reason = opts.blockEnabled ? getBlockReason(videoId, channelIds) : null;
    if (reason) blocked.push(videoId);
    if (reason === "channel") channelBlockedCards.push(videoId);
    if (opts.viewsEnabled && opts.isHidden(videoId)) hidden.push(videoId);
  }
  document.documentElement.dataset.ytiBlockedIds = blocked.join(",");
  document.documentElement.dataset.ytiHiddenIds = hidden.join(",");
  document.documentElement.dataset.ytiBlockedChannels = getBlockedChannelKeys().join(",");
  document.documentElement.dataset.ytiChannelBlockedCards = channelBlockedCards.join(",");
  document.documentElement.dataset.ytiBlockEnabled = opts.blockEnabled ? "1" : "0";
  document.documentElement.dataset.ytiDontRecommendEnabled = opts.dontRecommendEnabled ? "1" : "0";
  for (const el of document.querySelectorAll("[data-yti-no-nav]")) {
    el.removeAttribute("data-yti-no-nav");
  }
  document.dispatchEvent(new CustomEvent("yti-sync-blocks"));
}

/** Снимает href с превью — YouTube SPA иногда игнорирует stopPropagation. */
export function syncThumbLinks(card: Element, block: boolean): void {
  for (const el of queryInCard(card, ANCHOR_HOST_SEL)) {
    if (!(el instanceof HTMLAnchorElement)) continue;
    if (block) {
      const href = el.getAttribute("href");
      if (href && !el.dataset.ytiSavedHref) el.dataset.ytiSavedHref = href;
      el.removeAttribute("href");
      el.setAttribute("tabindex", "-1");
    } else {
      const saved = el.dataset.ytiSavedHref;
      if (saved) el.setAttribute("href", saved);
      delete el.dataset.ytiSavedHref;
      el.removeAttribute("tabindex");
    }
  }
}

function markBlockedHosts(card: Element, blocked: boolean): void {
  for (const sel of [".ytLockupViewModelHost", "yt-lockup-view-model", "#dismissible", ".yti-block-wrap"]) {
    for (const el of queryInCard(card, sel)) el.classList.toggle("yti-blocked-host", blocked);
  }
}

export function syncMountClickBlock(card: Element, active: boolean): void {
  const mount = findThumbMount(card);
  if (!mount) return;
  if (!active) {
    mount.querySelector(":scope > .yti-mount-shield")?.remove();
    return;
  }
  let shield = mount.querySelector(":scope > .yti-mount-shield") as HTMLElement | null;
  if (!shield) {
    shield = document.createElement("div");
    shield.className = "yti-mount-shield";
    shield.setAttribute("aria-hidden", "true");
    bindClickShield(shield);
  }
  layoutOnThumb(
    shield,
    mount,
    card,
    50,
    "pointer-events:auto;cursor:default;border-radius:12px;background:transparent;",
  );
  const before = mount.querySelector(":scope > .yti-views-ui, :scope > .yti-block-ui, :scope > .yti-badges-layer");
  if (before) mount.insertBefore(shield, before);
  else mount.appendChild(shield);
}

function clearMountOverlay(mount: HTMLElement): void {
  mount.querySelector(":scope > .yti-block-ui")?.remove();
  mount.classList.remove("yti-has-block-ui");
  delete mount.dataset.ytiBlockUiBound;
}

function mountOverlayOnMount(mount: HTMLElement, card: Element): HTMLElement {
  clearMountOverlay(mount);
  let ui = document.createElement("div");
  ui.className = "yti-block-ui";
  mount.appendChild(ui);
  layoutOnThumb(
    ui,
    mount,
    card,
    100,
    "display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:center;align-content:flex-end;" +
      "gap:6px;padding:8px;pointer-events:none;" +
      "background:linear-gradient(transparent 40%,rgba(0,0,0,.45));opacity:0;transition:opacity .15s;border-radius:12px;",
  );
  mount.appendChild(ui);
  mount.classList.add("yti-has-block-ui");
  if (!mount.dataset.ytiBlockUiBound) {
    mount.dataset.ytiBlockUiBound = "1";
    mount.addEventListener("mouseenter", () => {
      for (const el of mount.querySelectorAll(":scope > .yti-block-ui")) {
        if (el instanceof HTMLElement) el.style.opacity = "1";
      }
    });
    mount.addEventListener("mouseleave", () => {
      for (const el of mount.querySelectorAll(":scope > .yti-block-ui")) {
        if (el instanceof HTMLElement) el.style.opacity = "0";
      }
    });
  }
  return ui;
}

function bindStrikeShield(el: HTMLElement): void {
  bindClickShield(el);
}

/** Прозрачный щит поверх превью — блокирует переход по ссылке (кнопки выше, z-index 100). */
export function syncHostShield(host: HTMLElement | null, active: boolean): void {
  if (!host) return;
  if (!active) {
    host.querySelector(":scope > .yti-thumb-shield")?.remove();
    return;
  }
  ensureHostPosition(host);
  let shield = host.querySelector(":scope > .yti-thumb-shield") as HTMLElement | null;
  if (!shield) {
    shield = document.createElement("div");
    shield.className = "yti-thumb-shield";
    shield.setAttribute("aria-hidden", "true");
    bindClickShield(shield);
  }
  shield.style.cssText =
    "position:absolute;inset:0;z-index:40;pointer-events:auto;cursor:default;border-radius:inherit;";
  const before = host.querySelector(":scope > .yti-block-ui, :scope > .yti-views-ui, :scope > .yti-block-strike");
  if (before) host.insertBefore(shield, before);
  else host.appendChild(shield);
}

function mountOverlay(host: HTMLElement): HTMLElement {
  let ui = host.querySelector(":scope > .yti-block-ui") as HTMLElement | null;
  if (ui) return ui;
  ensureHostPosition(host);
  ui = document.createElement("div");
  ui.className = "yti-block-ui";
  ui.style.cssText =
    "position:absolute;inset:0;z-index:100;display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:center;" +
    "align-content:flex-end;gap:6px;padding:8px;pointer-events:none;" +
    "background:linear-gradient(transparent 40%,rgba(0,0,0,.45));opacity:0;transition:opacity .15s;border-radius:inherit";
  host.appendChild(ui);
  host.classList.add("yti-has-block-ui");
  if (!host.dataset.ytiBlockUiBound) {
    host.dataset.ytiBlockUiBound = "1";
    host.addEventListener("mouseenter", () => {
      const el = host.querySelector(":scope > .yti-block-ui") as HTMLElement | null;
      if (el) el.style.opacity = "1";
    });
    host.addEventListener("mouseleave", () => {
      const el = host.querySelector(":scope > .yti-block-ui") as HTMLElement | null;
      if (el) el.style.opacity = "0";
    });
  }
  return ui;
}

function unwrapIfEmpty(host: HTMLElement): void {
  if (!host.classList.contains("yti-block-wrap")) return;
  if (host.querySelector(".yti-block-ui") || host.querySelector(".yti-block-strike")) return;
  const thumb = host.firstElementChild;
  const parent = host.parentElement;
  if (thumb && parent) {
    parent.insertBefore(thumb, host);
    host.remove();
  }
}

function clearOverlay(host: HTMLElement): void {
  host.querySelector(".yti-block-ui")?.remove();
  host.querySelector(".yti-thumb-shield")?.remove();
  clearStrike(host);
  host.classList.remove("yti-has-block-ui");
  delete host.dataset.ytiBlockUiBound;
  unwrapIfEmpty(host);
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

function syncCard(card: Element): void {
  if (!(card instanceof HTMLElement)) return;

  const { videoId, channelIds } = getCardIds(card);
  const reason = getBlockReason(videoId, channelIds);
  cleanupLegacyOverlays(card);
  const host = findOverlayHost(card);

  if (!isEnabled()) {
    card.classList.remove("yti-blocked");
    delete card.dataset.ytiBlockReason;
    setBlockedMarks(card, false);
    syncCardNavGuard(card, false);
    markBlockedHosts(card, false);
    syncMountClickBlock(card, false);
    if (host) clearOverlay(host);
    const mount = findThumbMount(card);
    if (mount) clearMountOverlay(mount);
    return;
  }

  if (reason) {
    card.classList.add("yti-blocked");
    card.dataset.ytiBlockReason = reason;
    setBlockedMarks(card, true);
    syncCardNavGuard(card, true);
    markBlockedHosts(card, true);
    const mount = findThumbMount(card);
    syncMountClickBlock(card, true);
    if (host) {
      syncHostShield(host, true);
      host.querySelector(":scope > .yti-block-ui")?.remove();
      mountStrike(host);
    }
    if (!mount) return;
    const ui = mountOverlayOnMount(mount, card);
    ui.replaceChildren();
    ui.style.opacity = "0";
    const label = reason === "channel" ? "Разблокировать канал" : "Разблокировать видео";
    ui.appendChild(
      makeBtn(label, "#2e7d32", "#fff", async () => {
        if (reason === "channel" && channelIds.length > 0) {
          const ok = await showConfirm(
            "Разблокировать канал?",
            "Видео этого канала снова будут показываться в ленте на этом браузере.",
            { confirmLabel: "Разблокировать", confirmBg: "#2e7d32" },
          );
          if (ok) unblockChannelFromCard(card);
        } else if (videoId) {
          const ok = await showConfirm(
            "Разблокировать видео?",
            "Это видео снова будет показываться в ленте на этом браузере.",
            { confirmLabel: "Разблокировать", confirmBg: "#2e7d32" },
          );
          if (ok) unblockVideo(videoId);
        }
      }),
    );
    return;
  }

  card.classList.remove("yti-blocked");
  delete card.dataset.ytiBlockReason;
  setBlockedMarks(card, false);
  syncCardNavGuard(card, false);
  markBlockedHosts(card, false);

  syncMountClickBlock(card, false);
  const mount = findThumbMount(card);
  if (mount) clearMountOverlay(mount);

  if (!host) return;

  if (videoId && checkHidden(videoId)) {
    syncHostShield(host, false);
    return;
  }

  syncHostShield(host, false);
  clearStrike(host);
  const ui = mountOverlay(host);
  ui.replaceChildren();
  ui.style.opacity = "0";
  if (videoId) {
    ui.appendChild(
      makeBtn("Блок видео", "rgba(0,0,0,.72)", "#fff", async () => {
        const ok = await showConfirm("Заблокировать видео?", "Это видео будет скрыто в ленте на этом браузере.");
        if (ok) blockVideo(videoId);
      }),
    );
  }
  if (channelIds.length > 0) {
    ui.appendChild(
      makeBtn("Блок канала", "rgba(198,40,40,.9)", "#fff", async () => {
        const ok = await showConfirm(
          "Заблокировать канал?",
          "Все видео этого канала будут скрыты в ленте на этом браузере.",
        );
        if (ok) blockChannelFromCard(card);
      }),
    );
  }
  if (videoId) syncExtraButtons?.(ui, videoId);
  if (!videoId && channelIds.length === 0) clearOverlay(host);
}

function queryCardsDeep(): Element[] {
  const found: Element[] = [];
  const seen = new Set<Element>();
  function walk(root: Document | ShadowRoot | Element): void {
    for (const el of root.querySelectorAll(BLOCK_CARD_SEL)) {
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

/** Skip nested cards (e.g. yt-lockup inside ytd-rich-item) to avoid double sync/cleanup. */
export function queryCardsDeepOuter(): Element[] {
  const all = queryCardsDeep();
  return all.filter((card) => !all.some((other) => other !== card && other.contains(card)));
}

export function syncBlockUi(): void {
  if (!loaded && !isEnabled()) return;
  for (const card of queryCardsDeepOuter()) syncCard(card);
}

export function isBlockedCard(card: Element): boolean {
  if (!isEnabled()) return false;
  const outer =
    card.matches(BLOCK_CARD_SEL) && queryCardsDeepOuter().includes(card)
      ? card
      : queryCardsDeepOuter().find((c) => c.contains(card)) ?? card;
  const { videoId, channelIds } = getCardIds(outer);
  return getBlockReason(videoId, channelIds) !== null;
}
