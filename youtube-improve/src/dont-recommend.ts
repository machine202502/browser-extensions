/** MAIN world — «Don't recommend channel» через /youtubei/v1/feedback */

const tokenByContentId = new Map<string, string>();
const pendingContentIds = new Set<string>();
const submittedContentIds = new Set<string>();
const failedContentIds = new Set<string>();

type YtCfg = {
  data_?: {
    INNERTUBE_API_KEY?: string;
    INNERTUBE_CONTEXT?: {
      client?: {
        visitorData?: string;
        clientName?: string | number;
      };
    };
    INNERTUBE_CLIENT_VERSION?: string;
    INNERTUBE_CLIENT_NAME?: string;
    VISITOR_DATA?: string;
    DATASYNC_ID?: string;
  };
};

function getCookie(name: string): string | null {
  const m = document.cookie.match(new RegExp(`(?:^|; )${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : null;
}

async function sha1Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function buildAuthorizationHeader(cfg: NonNullable<YtCfg["data_"]>): Promise<string | null> {
  const sapisid =
    getCookie("SAPISID") ??
    getCookie("__Secure-1PAPISID") ??
    getCookie("__Secure-3PAPISID");
  if (!sapisid) return null;

  const origin = "https://www.youtube.com";
  const timestamp = Math.floor(Date.now() / 1000);
  const datasyncId = cfg.DATASYNC_ID?.split("||")[0] ?? "";
  const input = datasyncId
    ? [datasyncId, String(timestamp), sapisid, origin].join(" ")
    : [String(timestamp), sapisid, origin].join(" ");
  const digest = await sha1Hex(input);
  const token = `${timestamp}_${digest}${datasyncId ? "_u" : ""}`;
  return `SAPISIDHASH ${token} SAPISID1PHASH ${token} SAPISID3PHASH ${token}`;
}

function clientNameHeader(cfg: NonNullable<YtCfg["data_"]>): string {
  const fromContext = cfg.INNERTUBE_CONTEXT?.client?.clientName;
  if (fromContext === "WEB" || fromContext === 1 || fromContext === "1") return "1";
  if (typeof fromContext === "number") return String(fromContext);
  if (cfg.INNERTUBE_CLIENT_NAME === "WEB") return "1";
  return cfg.INNERTUBE_CLIENT_NAME ?? "1";
}

async function buildInnertubeHeaders(cfg: NonNullable<YtCfg["data_"]>): Promise<Record<string, string>> {
  const visitorId = cfg.VISITOR_DATA ?? cfg.INNERTUBE_CONTEXT?.client?.visitorData ?? "";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Youtube-Client-Name": clientNameHeader(cfg),
    "X-Youtube-Client-Version": cfg.INNERTUBE_CLIENT_VERSION ?? "",
    "X-Origin": "https://www.youtube.com",
  };
  if (visitorId) headers["X-Goog-Visitor-Id"] = visitorId;
  const auth = await buildAuthorizationHeader(cfg);
  if (auth) headers.Authorization = auth;
  return headers;
}

function normalizeChannelKey(key: string): string {
  if (key.startsWith("/@")) return key.toLowerCase();
  return key;
}

function parseChannelKey(href: string): string | null {
  try {
    const u = new URL(href, location.href);
    if (u.pathname.startsWith("/@")) return normalizeChannelKey(u.pathname);
    const m = u.pathname.match(/^\/channel\/([^/?#]+)/);
    if (m) return `/channel/${m[1]}`;
    const c = u.pathname.match(/^\/c\/([^/?#]+)/);
    if (c) return `/c/${c[1]}`;
  } catch {
    /* ignore */
  }
  return null;
}

function isDontRecommendTitle(title: string): boolean {
  const t = title.toLowerCase();
  if (t.includes("recommend") && t.includes("channel")) return true;
  if (t.includes("рекоменд") && t.includes("канал")) return true;
  return false;
}

function readTitle(title: unknown): string | null {
  if (!title || typeof title !== "object") return null;
  const o = title as Record<string, unknown>;
  if (typeof o.content === "string") return o.content;
  if (typeof o.simpleText === "string") return o.simpleText;
  const runs = o.runs;
  if (Array.isArray(runs)) {
    const parts: string[] = [];
    for (const run of runs) {
      if (run && typeof run === "object" && typeof (run as Record<string, unknown>).text === "string") {
        parts.push((run as Record<string, unknown>).text as string);
      }
    }
    if (parts.length) return parts.join("");
  }
  return null;
}

function indexListItem(item: Record<string, unknown>): void {
  const vm = item.listItemViewModel;
  if (!vm || typeof vm !== "object") return;
  const title = readTitle((vm as Record<string, unknown>).title);
  if (!title || !isDontRecommendTitle(title)) return;

  const ctx = (vm as Record<string, unknown>).rendererContext;
  if (!ctx || typeof ctx !== "object") return;
  const cmdCtx = (ctx as Record<string, unknown>).commandContext;
  if (!cmdCtx || typeof cmdCtx !== "object") return;
  const onTap = (cmdCtx as Record<string, unknown>).onTap;
  if (!onTap || typeof onTap !== "object") return;
  const innertube = (onTap as Record<string, unknown>).innertubeCommand;
  if (!innertube || typeof innertube !== "object") return;
  const ep = (innertube as Record<string, unknown>).feedbackEndpoint;
  if (!ep || typeof ep !== "object") return;

  const token = (ep as Record<string, unknown>).feedbackToken;
  const contentId = (ep as Record<string, unknown>).contentId;
  if (typeof token === "string" && typeof contentId === "string" && contentId.length > 0) {
    const prev = tokenByContentId.get(contentId);
    tokenByContentId.set(contentId, token);
    if (prev !== token) failedContentIds.delete(contentId);
  }
}

function walkFeedbackTokens(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) walkFeedbackTokens(item);
    return;
  }
  if (!value || typeof value !== "object") return;
  const obj = value as Record<string, unknown>;
  if ("listItemViewModel" in obj) indexListItem(obj);
  for (const v of Object.values(obj)) walkFeedbackTokens(v);
}

/** Только лента на youtube.com/ — не поиск, не /watch, не /feed/... */
function isHomeFeedPage(): boolean {
  const path = location.pathname;
  return path === "/" || path === "";
}

function shouldIngestUrl(url: string): boolean {
  if (!dontRecommendFeatureEnabled() || !isHomeFeedPage()) return false;
  return url.includes("/youtubei/v1/browse") || url.includes("/youtubei/v1/next");
}

function getBlockedChannels(): Set<string> {
  const raw = document.documentElement.dataset.ytiBlockedChannels ?? "";
  return new Set(raw.split(",").filter(Boolean));
}

function dontRecommendFeatureEnabled(): boolean {
  return document.documentElement.dataset.ytiDontRecommendEnabled !== "0";
}

function parseContentIdFromClassList(classList: DOMTokenList): string | null {
  for (const cls of classList) {
    if (!cls.startsWith("content-id-")) continue;
    const id = cls.slice("content-id-".length);
    if (id.length > 0) return id;
  }
  return null;
}

function getCardChannelKeys(contentId: string): string[] {
  const sel = `.content-id-${CSS.escape(contentId)}`;
  const host = document.querySelector(sel);
  if (!host) return [];
  const root =
    host.closest(
      "ytd-rich-item-renderer,yt-lockup-view-model,ytd-video-renderer,ytd-compact-video-renderer",
    ) ?? host;
  const keys = new Set<string>();
  for (const a of root.querySelectorAll("a[href]")) {
    if (!(a instanceof HTMLAnchorElement)) continue;
    const key = parseChannelKey(a.href);
    if (key) keys.add(key);
  }
  return [...keys];
}

function channelBlockedCardsFromDataset(): string[] {
  const raw = document.documentElement.dataset.ytiChannelBlockedCards ?? "";
  return raw.split(",").filter(Boolean);
}

function collectBlockedContentIds(blocked: Set<string>): Set<string> {
  const ids = new Set<string>(channelBlockedCardsFromDataset());
  for (const el of document.querySelectorAll("[class*='content-id-']")) {
    const contentId = parseContentIdFromClassList(el.classList);
    if (!contentId) continue;
    const channels = getCardChannelKeys(contentId);
    if (channels.some((ch) => blocked.has(ch))) ids.add(contentId);
  }
  return ids;
}

function hideCardByContentId(contentId: string): void {
  const host = document.querySelector(`.content-id-${CSS.escape(contentId)}`);
  const item = host?.closest("ytd-rich-item-renderer,ytd-video-renderer,ytd-compact-video-renderer");
  if (item instanceof HTMLElement) item.style.display = "none";
}

async function sendFeedback(token: string): Promise<boolean> {
  const cfg = (window as Window & { ytcfg?: YtCfg }).ytcfg?.data_;
  const apiKey = cfg?.INNERTUBE_API_KEY;
  const context = cfg?.INNERTUBE_CONTEXT;
  if (!apiKey || !context || !cfg) {
    console.warn("[YouTube Improve] don't recommend: нет ytcfg (страница ещё не готова?)");
    return false;
  }
  try {
    const headers = await buildInnertubeHeaders(cfg);
    const res = await fetch(`https://www.youtube.com/youtubei/v1/feedback?key=${encodeURIComponent(apiKey)}`, {
      method: "POST",
      credentials: "include",
      headers,
      body: JSON.stringify({
        context,
        feedbackTokens: [token],
        isFeedbackTokenUnencrypted: false,
        shouldMerge: false,
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.warn(
        "[YouTube Improve] don't recommend: HTTP",
        res.status,
        detail.slice(0, 200) || res.statusText,
      );
    }
    return res.ok;
  } catch (err) {
    console.warn("[YouTube Improve] don't recommend: запрос feedback не прошёл", err);
    return false;
  }
}

async function submitDontRecommend(contentId: string, token: string): Promise<void> {
  if (
    submittedContentIds.has(contentId) ||
    pendingContentIds.has(contentId) ||
    failedContentIds.has(contentId)
  ) {
    return;
  }
  pendingContentIds.add(contentId);
  try {
    const ok = await sendFeedback(token);
    if (ok) {
      submittedContentIds.add(contentId);
      hideCardByContentId(contentId);
      console.info("[YouTube Improve] don't recommend: отправлено для", contentId);
    } else {
      failedContentIds.add(contentId);
      console.warn("[YouTube Improve] don't recommend: feedback отклонён для", contentId);
    }
  } finally {
    pendingContentIds.delete(contentId);
  }
}

async function processBlockedChannels(preferContentId?: string | null): Promise<void> {
  if (!dontRecommendFeatureEnabled() || !isHomeFeedPage()) return;
  const blocked = getBlockedChannels();
  if (!blocked.size) return;

  const contentIds = collectBlockedContentIds(blocked);
  if (preferContentId) contentIds.add(preferContentId);
  for (const [contentId] of tokenByContentId) {
    if (getCardChannelKeys(contentId).some((ch) => blocked.has(ch))) contentIds.add(contentId);
  }

  for (const contentId of contentIds) {
    const token = tokenByContentId.get(contentId);
    if (!token) continue;
    const channels = getCardChannelKeys(contentId);
    if (!channels.some((ch) => blocked.has(ch))) continue;
    await submitDontRecommend(contentId, token);
  }
}

function scheduleProcess(preferContentId?: string | null): void {
  if (!dontRecommendFeatureEnabled() || !isHomeFeedPage()) return;
  const run = (): void => {
    void processBlockedChannels(preferContentId);
  };
  run();
  requestAnimationFrame(() => {
    run();
    setTimeout(run, 150);
    setTimeout(run, 600);
  });
}

export function ingestYoutubeJson(json: unknown): void {
  if (!dontRecommendFeatureEnabled() || !isHomeFeedPage()) return;
  walkFeedbackTokens(json);
  scheduleProcess();
}

export function installDontRecommend(): void {
  const w = window as Window & { ytInitialData?: unknown };
  if (dontRecommendFeatureEnabled() && isHomeFeedPage() && w.ytInitialData) {
    walkFeedbackTokens(w.ytInitialData);
  }

  document.addEventListener("yti-sync-blocks", () => {
    scheduleProcess();
  });

  document.addEventListener("yti-block-channel", (e) => {
    const detail = (e as CustomEvent<{ contentId?: string | null }>).detail;
    scheduleProcess(detail?.contentId ?? null);
  });

  new MutationObserver(() => {
    scheduleProcess();
  }).observe(document.documentElement, {
    attributes: true,
    attributeFilter: [
      "data-yti-blocked-channels",
      "data-yti-channel-blocked-cards",
      "data-yti-dont-recommend-enabled",
    ],
  });

  scheduleProcess();
}

export function maybeIngestResponse(url: string, text: string): void {
  if (!shouldIngestUrl(url)) return;
  try {
    ingestYoutubeJson(JSON.parse(text));
  } catch {
    /* ignore */
  }
}
