// JoolzApp theme toggle for the floating top bar. Load in <head> (it sets the theme before the page paints, so there is no flash).
// Any button with data-theme-toggle switches between light and dark. The choice is kept on the device; an app that keeps the person's
// preferences on their JoolzApp account also listens for the "jz-theme" event (detail = "light" | "dark" | "") and saves it there.
(function () {
  "use strict";
  var KEY = "jz.theme", root = document.documentElement;
  function stored() { try { return localStorage.getItem(KEY) || ""; } catch (e) { return ""; } }
  function effective() { var t = root.getAttribute("data-theme"); if (t === "light" || t === "dark") return t; return window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"; }
  function paint() {
    var m = effective(); document.querySelectorAll("[data-theme-toggle]").forEach(function (b) { b.setAttribute("data-mode", m); b.setAttribute("aria-label", m === "dark" ? "Switch to light theme" : "Switch to dark theme"); b.title = b.getAttribute("aria-label"); });
    var meta = document.querySelector('meta[name="theme-color"]'); if (meta && root.getAttribute("data-theme")) meta.setAttribute("content", m === "dark" ? "#0a0f1f" : "#f4f6fa");
  }
  function apply(v) { if (v === "light" || v === "dark") root.setAttribute("data-theme", v); else root.removeAttribute("data-theme"); paint(); }
  function set(v, quiet) { v = v === "light" || v === "dark" ? v : ""; try { if (v) localStorage.setItem(KEY, v); else localStorage.removeItem(KEY); } catch (e) {} apply(v); if (!quiet) window.dispatchEvent(new CustomEvent("jz-theme", { detail: v })); }
  apply(stored());
  document.addEventListener("click", function (e) { var b = e.target.closest && e.target.closest("[data-theme-toggle]"); if (b) set(effective() === "dark" ? "light" : "dark"); });
  document.addEventListener("DOMContentLoaded", paint);
  // Keep the page below the fixed bar: an in-flow spacer as tall as the bar (+ its top gap), kept right as the bar wraps or the screen turns.
  function spacer() {
    var bar = document.querySelector(".topbar"); if (!bar) return;
    var sp = bar.nextElementSibling; if (!sp || !sp.classList.contains("topbar-spacer")) { sp = document.createElement("div"); sp.className = "topbar-spacer"; sp.setAttribute("aria-hidden", "true"); bar.parentNode.insertBefore(sp, bar.nextSibling); }
    sp.style.height = (bar.offsetHeight + 8 + 8) + "px";
  }
  document.addEventListener("DOMContentLoaded", spacer); window.addEventListener("resize", spacer); window.addEventListener("load", spacer);
  if (window.ResizeObserver) document.addEventListener("DOMContentLoaded", function () { var b = document.querySelector(".topbar"); if (b) new ResizeObserver(spacer).observe(b); });
  window.JZTheme = { set: set, effective: effective, paint: paint };
})();
