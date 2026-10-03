/** Content script — скрытие рекламных слотов в Яндекс Почте */

(function (): void {
  const PROTECTED = [
    "toolbar",
    "messages",
    "search",
    "compose",
    "left-column",
    "page-layout",
    "content-header",
  ];

  const isProtected = (el: Element | null): boolean => {
    if (!el || el === document.body || el === document.documentElement) return true;
    if (
      el.matches(
        '[data-testid="toolbar-layout_container"], [data-react-focus-root="toolbar"], [role="menubar"]'
      )
    ) {
      return true;
    }
    if (
      el.querySelector(
        '[data-testid="toolbar-layout_container"], [data-react-focus-root="toolbar"], [role="menubar"]'
      )
    ) {
      return true;
    }
    const testid = `${el.getAttribute("data-testid") || ""} ${el.getAttribute("data-react-focus-root") || ""}`;
    return PROTECTED.some((key) => testid.includes(key));
  };

  const hide = (el: Element | null | undefined): void => {
    if (!(el instanceof HTMLElement)) return;
    if (el.dataset.mailAdHidden === "1" || isProtected(el)) return;
    el.dataset.mailAdHidden = "1";
    el.style.setProperty("display", "none", "important");
  };

  const looksLikeAdSlot = (el: Element | null | undefined): boolean => {
    if (!(el instanceof HTMLElement) || isProtected(el)) return false;
    const cls = el.className || "";
    if (typeof cls === "string" && cls.toLowerCase().includes("portal")) return true;
    if ([...el.attributes].some((attr) => attr.name.startsWith("data-r-i-"))) return true;
    if (
      el.querySelector(
        '[data-name="banner-layout"], [data-container-type="smart-tile-container"]'
      )
    ) {
      return true;
    }
    const hasUi = el.querySelector("button, a, input, [role='menubar'], [role='button']");
    return !hasUi && el.childElementCount <= 3;
  };

  const SELECTORS = [
    '[data-testid="aside_promo_carousel_banner"]',
    ".promozavr-anchor-carousel-banner",
    '[data-name="banner-layout"]',
    '[data-container-type="smart-tile-container"]',
    'div[style*="--rc-adaptive-width"]',
    "#js-neuroexpert-button",
    '[class*="NeuroexpertButton-m__withPromo"]',
  ];

  const sweep = (): void => {
    document.querySelectorAll(SELECTORS.join(",")).forEach(hide);

    const portal = document.querySelector(
      '[data-testid="yagpt-neurofilter-banner-portal"]'
    );
    const afterPortal = portal?.nextElementSibling;
    if (looksLikeAdSlot(afterPortal)) hide(afterPortal);

    document.querySelectorAll("*").forEach((el) => {
      if ([...el.attributes].some((attr) => attr.name.startsWith("data-r-i-"))) {
        hide(el);
      }
    });
  };

  sweep();
  new MutationObserver(sweep).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
})();
