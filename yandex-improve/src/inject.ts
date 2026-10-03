/** MAIN world — глушим Ya.Context / AdFox / VMAP до загрузки рекламных SDK */

interface AdvManager {
  render(): void;
  renderTo(): void;
  destroy(): void;
}

interface YaContext {
  AdvManager?: AdvManager;
  [key: string]: unknown;
}

interface YaNamespace {
  Context?: YaContext;
  [key: string]: unknown;
}

interface AdXhr extends XMLHttpRequest {
  __azbAdUrl?: string | URL;
}

interface YandexWindow extends Window {
  yaContextCb?: unknown;
  yaContext0Gimmeamoney?: { state: number };
  Ya?: YaNamespace;
}

(function (): void {
  const win = window as YandexWindow;
  const emptyCb: unknown[] & { push: () => number } = [] as unknown as unknown[] & {
    push: () => number;
  };
  emptyCb.push = () => 0;

  const noopMgr: AdvManager = {
    render() {},
    renderTo() {},
    destroy() {},
  };

  const lockAdvManager = (ctx: YaContext): void => {
    try {
      Object.defineProperty(ctx, "AdvManager", {
        configurable: true,
        get() {
          return noopMgr;
        },
        set() {},
      });
    } catch {
      ctx.AdvManager = noopMgr;
    }
  };

  const lockContext = (ya: YaNamespace): YaNamespace => {
    let ctx: YaContext =
      ya.Context && typeof ya.Context === "object" ? ya.Context : {};
    lockAdvManager(ctx);
    try {
      Object.defineProperty(ya, "Context", {
        configurable: true,
        get() {
          return ctx;
        },
        set(value: unknown) {
          ctx = value && typeof value === "object" ? (value as YaContext) : {};
          lockAdvManager(ctx);
        },
      });
    } catch {
      ya.Context = ctx;
    }
    return ya;
  };

  try {
    Object.defineProperty(win, "yaContextCb", {
      configurable: true,
      get() {
        return emptyCb;
      },
      set() {},
    });
  } catch {
    win.yaContextCb = emptyCb;
  }

  try {
    Object.defineProperty(win, "yaContext0Gimmeamoney", {
      configurable: true,
      get() {
        return { state: 3 };
      },
      set() {},
    });
  } catch {
    win.yaContext0Gimmeamoney = { state: 3 };
  }

  let ya = lockContext(win.Ya && typeof win.Ya === "object" ? win.Ya : {});
  try {
    Object.defineProperty(win, "Ya", {
      configurable: true,
      get() {
        return ya;
      },
      set(value: unknown) {
        ya = lockContext(value && typeof value === "object" ? (value as YaNamespace) : {});
      },
    });
  } catch {
    win.Ya = ya;
  }

  const isAdUrl = (url: unknown): boolean => {
    if (!url) return false;
    const value = String(url);
    return (
      value.includes("yandex.ru/ads/") ||
      value.includes("ads.adfox.ru") ||
      value.includes("yastatic.net/pcode/adfox") ||
      value.includes("yastatic.net/safeframe") ||
      value.includes("static-mon.yandex.net")
    );
  };

  const emptyVmap =
    '<?xml version="1.0" encoding="UTF-8"?><vmap:VMAP xmlns:vmap="http://www.iab.net/videosuite/vmap" version="1"></vmap:VMAP>';

  const fakeAdResponse = (url: unknown): Response => {
    const value = String(url || "");
    if (value.includes("/ads/vmap") || value.includes("/ads/meta")) {
      return new Response(emptyVmap, {
        status: 200,
        headers: { "Content-Type": "text/xml" },
      });
    }
    return new Response("{}", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const origFetch = win.fetch.bind(win);
  win.fetch = function (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (isAdUrl(url)) return Promise.resolve(fakeAdResponse(url));
    return origFetch(input, init);
  };

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (
    this: AdXhr,
    method: string,
    url: string | URL,
    async?: boolean,
    username?: string | null,
    password?: string | null
  ): void {
    this.__azbAdUrl = url;
    return origOpen.call(this, method, url, async ?? true, username, password);
  };

  XMLHttpRequest.prototype.send = function (
    this: AdXhr,
    body?: Document | XMLHttpRequestBodyInit | null
  ): void {
    if (isAdUrl(this.__azbAdUrl)) {
      try {
        this.abort();
      } catch {
        /* ignore */
      }
      return;
    }
    return origSend.call(this, body);
  };
})();
