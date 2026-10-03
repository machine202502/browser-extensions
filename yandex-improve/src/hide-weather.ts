/** Content script — скрытие рекламных блоков Яндекс Погоды */

(function (): void {
  const SELECTORS = [
    '[class*="AppMoney_"]',
    '[class*="AppMoneySidebar_"]',
    '[class*="AppForecastMoney_"]',
    '[class*="MainPage_moneyContainer"]',
    '[class*="MainPage_topBlockWithMoney"]',
    '[class*="Money_ecomFooter"]',
    '[id^="money-"]',
    '[id^="adv_R-I-"]',
    "#forecast_third_adv",
    "#footer_ecom_adv",
    '[data-name="adWrapper"]',
  ];

  const hide = (el: Element | null | undefined): void => {
    if (!(el instanceof HTMLElement)) return;
    if (el.dataset.azbHidden === "1") return;
    if (el === document.body || el === document.documentElement) return;
    el.dataset.azbHidden = "1";
    el.style.setProperty("display", "none", "important");
  };

  const sweep = (): void => {
    document.querySelectorAll(SELECTORS.join(",")).forEach(hide);
  };

  sweep();
  new MutationObserver(sweep).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
})();
