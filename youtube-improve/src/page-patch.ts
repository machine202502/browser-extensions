/** MAIN world — вырезание Shorts из API и ytInitialData */

import { installDontRecommend, maybeIngestResponse } from "./dont-recommend";

(function (): void {
  const win = window as Window & { __ytiPagePatch?: boolean };
  if (win.__ytiPagePatch) return;
  win.__ytiPagePatch = true;

  // ── вырезать Shorts из JSON ответа (search + browse) ──

  function shelfTitleIsShorts(title: unknown): boolean {
    if (!title || typeof title !== "object") return false;
    const t = title as Record<string, unknown>;
    if (t.simpleText === "Shorts") return true;
    const runs = t.runs;
    if (Array.isArray(runs)) {
      for (const run of runs) {
        if (run && typeof run === "object" && (run as Record<string, unknown>).text === "Shorts") {
          return true;
        }
      }
    }
    return false;
  }

  function richShelfIsShorts(rich: Record<string, unknown>): boolean {
    if (rich.isShorts === true) return true;
    return shelfTitleIsShorts(rich.title);
  }

  function jsonLooksLikeShorts(value: unknown): boolean {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const o = value as Record<string, unknown>;
    if ("reelShelfRenderer" in o) return true;
    if ("shortsLockupViewModel" in o || "shortsLockupViewModelV2" in o) return true;
    if ("reelWatchEndpoint" in o) return true;
    const rich = o.richShelfRenderer;
    if (rich && typeof rich === "object" && richShelfIsShorts(rich as Record<string, unknown>)) {
      return true;
    }
    if ("contents" in o && richShelfIsShorts(o)) return true;
    const grid = o.gridShelfRenderer ?? o.gridShelfViewModel;
    if (grid && typeof grid === "object") {
      const g = grid as Record<string, unknown>;
      if (shelfTitleIsShorts(g.title)) return true;
      const s = JSON.stringify(grid);
      if (s.includes("shortsLockup") || s.includes("reelShelfRenderer")) return true;
    }
    return false;
  }

  /** Полка Shorts вложена в richSectionRenderer → content → richShelfRenderer.
   *  jsonLooksLikeShorts видит только сам shelf, и секция остаётся пустой оболочкой. */
  function wrapsShortsShelf(value: unknown): boolean {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const o = value as Record<string, unknown>;
    if (jsonLooksLikeShorts(o)) return true;
    const content = o.content;
    if (content && typeof content === "object" && !Array.isArray(content) && jsonLooksLikeShorts(content)) {
      return true;
    }
    const section = o.richSectionRenderer;
    if (section && typeof section === "object" && wrapsShortsShelf(section)) return true;
    const item = o.richItemRenderer;
    if (item && typeof item === "object" && wrapsShortsShelf(item)) return true;
    return false;
  }

  function stripShortsDeep(value: unknown): unknown {
    if (Array.isArray(value)) {
      const out: unknown[] = [];
      for (const item of value) {
        if (wrapsShortsShelf(item)) continue;
        const cleaned = stripShortsDeep(item);
        if (cleaned === undefined) continue;
        if (wrapsShortsShelf(cleaned)) continue;
        out.push(cleaned);
      }
      return out;
    }
    if (value && typeof value === "object") {
      if (wrapsShortsShelf(value)) return undefined;
      const src = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(src)) {
        if (k === "richShelfRenderer" && v && typeof v === "object") {
          if (richShelfIsShorts(v as Record<string, unknown>)) continue;
        }
        const cleaned = stripShortsDeep(v);
        if (cleaned !== undefined) out[k] = cleaned;
      }
      if (out.richShelfRenderer && typeof out.richShelfRenderer === "object") {
        if (richShelfIsShorts(out.richShelfRenderer as Record<string, unknown>)) return undefined;
      }
      return out;
    }
    return value;
  }

  function filterShortsResponseText(text: string, url: string): string {
    if (!url.includes("/youtubei/v1/search") && !url.includes("/youtubei/v1/browse")) {
      return text;
    }
    try {
      const json = JSON.parse(text);
      return JSON.stringify(stripShortsDeep(json));
    } catch {
      return text;
    }
  }

  function processResponseText(text: string, url: string): string {
    maybeIngestResponse(url, text);
    return filterShortsResponseText(text, url);
  }

  function maybeFilterResponse(response: Response, url: string): Promise<Response> {
    if (!response.ok) return Promise.resolve(response);
    if (!url.includes("/youtubei/v1/search") && !url.includes("/youtubei/v1/browse")) {
      return response.clone().text().then((text) => {
        maybeIngestResponse(url, text);
        return response;
      }).catch(() => response);
    }
    return response
      .clone()
      .text()
      .then((text) => {
        const filtered = processResponseText(text, url);
        if (filtered === text) return response;
        return new Response(filtered, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      })
      .catch(() => response);
  }

  function resolveUrl(input: RequestInfo | URL): string {
    if (typeof input === "string") return input;
    if (input instanceof URL) return input.href;
    return input.url;
  }

  function installFetchPatch(): void {
    const origFetch = window.fetch.bind(window);
    window.fetch = function (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> {
      const url = resolveUrl(input);
      return origFetch(input, init).then((r) => maybeFilterResponse(r, url));
    };
  }

  function installXhrPatch(): void {
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    const xhrProto = XMLHttpRequest.prototype;
    const respTextDesc = Object.getOwnPropertyDescriptor(xhrProto, "responseText");
    const respDesc = Object.getOwnPropertyDescriptor(xhrProto, "response");

    if (respTextDesc?.get) {
      Object.defineProperty(xhrProto, "responseText", {
        configurable: true,
        enumerable: true,
        get: function (this: XMLHttpRequest & { __ytiUrl?: string }): string {
          const text = respTextDesc.get!.call(this) as string;
          const url = this.__ytiUrl ?? "";
          if (!url.includes("/youtubei/v1/search") && !url.includes("/youtubei/v1/browse")) {
            maybeIngestResponse(url, text);
            return text;
          }
          return processResponseText(text, url);
        },
      });
    }

    if (respDesc?.get) {
      Object.defineProperty(xhrProto, "response", {
        configurable: true,
        enumerable: true,
        get: function (this: XMLHttpRequest & { __ytiUrl?: string }): unknown {
          const raw = respDesc.get!.call(this);
          const url = this.__ytiUrl ?? "";
          if (!url.includes("/youtubei/v1/search") && !url.includes("/youtubei/v1/browse")) return raw;
          if (typeof raw !== "string") return raw;
          return filterShortsResponseText(raw, url);
        },
      });
    }

    XMLHttpRequest.prototype.open = function (
      this: XMLHttpRequest,
      method: string,
      url: string | URL,
      async?: boolean,
      username?: string | null,
      password?: string | null,
    ): void {
      const xhr = this as XMLHttpRequest & { __ytiUrl?: string; __ytiMethod?: string };
      xhr.__ytiUrl = String(url);
      xhr.__ytiMethod = method.toUpperCase();
      return origOpen.call(this, method, url, async ?? true, username, password);
    };

    XMLHttpRequest.prototype.send = function (body?: Document | XMLHttpRequestBodyInit | null): void {
      return origSend.call(this, body);
    };
  }

  function installInitialDataHook(): void {
    const w = window as Window & {
      ytInitialData?: unknown;
      loadInitialData?: (data: unknown) => void;
    };

    let initial = w.ytInitialData;
    Object.defineProperty(w, "ytInitialData", {
      configurable: true,
      enumerable: true,
      get(): unknown {
        return initial;
      },
      set(v: unknown): void {
        initial = stripShortsDeep(v);
        maybeIngestResponse("ytInitialData", JSON.stringify(initial));
      },
    });
    if (initial !== undefined) {
      initial = stripShortsDeep(initial);
      maybeIngestResponse("ytInitialData", JSON.stringify(initial));
    }

    let loadFn = w.loadInitialData;
    Object.defineProperty(w, "loadInitialData", {
      configurable: true,
      enumerable: true,
      get(): ((data: unknown) => void) | undefined {
        return loadFn;
      },
      set(fn: ((data: unknown) => void) | undefined): void {
        if (typeof fn !== "function") {
          loadFn = fn;
          return;
        }
        loadFn = function (this: unknown, data: unknown): void {
          if (data && typeof data === "object") {
            const d = data as Record<string, unknown>;
            if (d.response !== undefined) d.response = stripShortsDeep(d.response);
          }
          return fn.call(this, data);
        };
      },
    });
  }

  // ── блокировка навигации по ID (MAIN world) — только превью, не весь lockup ──

  const YTI_MENU_SEL =
    ".ytLockupMetadataViewModelMenuButton,ytd-menu-renderer,.yt-menu-modern-item-renderer";
  const YTI_BTN_SEL = ".yti-block-ui button,.yti-views-ui button";
  const YTI_AVATAR_SEL = "yt-decorated-avatar-view-model,a.ytAttributedStringLink";
  const THUMB_AREA_SEL =
    "a.ytLockupViewModelContentImage,a#thumbnail,ytd-thumbnail,yt-thumbnail-view-model,yt-img-shadow," +
    "yt-touch-feedback-shape,.yti-badges-layer,.yti-hidden-badge,.yti-block-strike,.yti-thumb-shield," +
    ".yti-mount-shield,.yti-view-count,.yti-first-badge,.yti-block-wrap,.yti-block-ui,.yti-views-ui";

  function ytiInMenu(el: Element): boolean {
    if (el.closest(YTI_MENU_SEL)) return true;
    const label = el.getAttribute("aria-label");
    return label === "More actions" || label === "Action menu";
  }

  function ytiInExtensionBtn(el: Element): boolean {
    return el.closest(YTI_BTN_SEL) != null;
  }

  function ytiInChannelLink(el: Element): boolean {
    return el.closest(YTI_AVATAR_SEL) != null;
  }

  function getIdSet(attr: "ytiBlockedIds" | "ytiHiddenIds"): Set<string> {
    const raw = document.documentElement.dataset[attr] ?? "";
    return new Set(raw.split(",").filter(Boolean));
  }

  function parseWatchId(href: string): string | null {
    try {
      const u = new URL(href, location.href);
      if (u.pathname === "/watch") return u.searchParams.get("v");
    } catch {
      /* ignore */
    }
    return null;
  }

  function parseVideoIdFromPath(path: EventTarget[]): string | null {
    for (const node of path) {
      if (!(node instanceof Element)) continue;
      for (const cls of node.classList) {
        if (!cls.startsWith("content-id-")) continue;
        const id = cls.slice("content-id-".length);
        if (/^[\w-]{11}$/.test(id)) return id;
      }
      if (node instanceof HTMLAnchorElement) {
        const id = parseWatchId(node.href);
        if (id) return id;
      }
    }
    return null;
  }

  function isThumbAreaInPath(path: EventTarget[]): boolean {
    for (const node of path) {
      if (node instanceof Element && node.matches(THUMB_AREA_SEL)) return true;
    }
    return false;
  }

  function ytiShouldBlockNav(e: Event): boolean {
    const path = e.composedPath();
    const target = path[0];
    if (!(target instanceof Element)) return false;
    if (ytiInMenu(target)) return false;
    if (ytiInExtensionBtn(target)) return false;
    if (ytiInChannelLink(target)) return false;
    if (!isThumbAreaInPath(path)) return false;
    const videoId = parseVideoIdFromPath(path);
    if (!videoId) return false;
    return getIdSet("ytiBlockedIds").has(videoId) || getIdSet("ytiHiddenIds").has(videoId);
  }

  function shouldBlockWatchUrl(url: string): boolean {
    const id = parseWatchId(url);
    if (!id) return false;
    return getIdSet("ytiBlockedIds").has(id) || getIdSet("ytiHiddenIds").has(id);
  }

  function installNavGuard(): void {
    const block = (e: Event): void => {
      if (!ytiShouldBlockNav(e)) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    };
    for (const type of ["click", "pointerup", "auxclick"] as const) {
      document.addEventListener(type, block, true);
    }
  }

  function installSpaGuard(): void {
    const origPush = history.pushState.bind(history);
    history.pushState = function (
      state: unknown,
      title: string,
      url?: string | URL | null,
    ): void {
      if (url != null && shouldBlockWatchUrl(String(url))) return;
      return origPush(state, title, url);
    };
    const origReplace = history.replaceState.bind(history);
    history.replaceState = function (
      state: unknown,
      title: string,
      url?: string | URL | null,
    ): void {
      if (url != null && shouldBlockWatchUrl(String(url))) return;
      return origReplace(state, title, url);
    };
  }

  installFetchPatch();
  installXhrPatch();
  installInitialDataHook();
  installNavGuard();
  installSpaGuard();
  installDontRecommend();
})();
