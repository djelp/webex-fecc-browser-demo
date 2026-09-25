/**
 * Light / dark / system theme. Load in <head> (not deferred) so the theme is set before first paint.
 * Any element with [data-theme-switch] containing buttons with data-theme-value="system|light|dark"
 * becomes a working switch; the choice is remembered in this browser.
 */
(function () {
  const KEY = "fecc.theme";
  const root = document.documentElement;

  function read() {
    try {
      const v = localStorage.getItem(KEY);
      return v === "light" || v === "dark" ? v : "system";
    } catch {
      return "system";
    }
  }

  function apply(pref) {
    if (pref === "light" || pref === "dark") root.dataset.theme = pref;
    else delete root.dataset.theme;
    document.querySelectorAll("[data-theme-switch] [data-theme-value]").forEach((btn) => {
      btn.setAttribute("aria-pressed", String(btn.dataset.themeValue === pref));
    });
  }

  function set(pref) {
    try {
      if (pref === "system") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, pref);
    } catch {}
    apply(pref);
  }

  apply(read());

  document.addEventListener("DOMContentLoaded", () => {
    apply(read());
    document.querySelectorAll("[data-theme-switch] [data-theme-value]").forEach((btn) => {
      btn.addEventListener("click", () => set(btn.dataset.themeValue));
    });
  });
})();
