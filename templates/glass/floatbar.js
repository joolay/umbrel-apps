// JoolzApp floating top bar helpers: the Home button and the light/dark theme toggle.
// Home: any button with data-home (the first thing in the bar) stays hidden until the JoolzApp Store's address is known, then opens it. floatbar.js asks the app's own
// GET api/app-config for { portalUrl } by itself; an app that learns the address another way calls JZBar.setHome(url).
// Theme toggle: Load in <head> (it sets the theme before the page paints, so there is no flash).
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
  // Dock: when the app has a menu bar and/or toolbar, wrap the top bar, menu bar and toolbar in ONE fixed .jz-dock so they always stay together.
  function dock() {
    var bar = document.querySelector(".topbar"); if (!bar) return;
    var mb = document.querySelector(".menubar"), tb = document.querySelector(".toolbar"), d = bar.parentNode.classList.contains("jz-dock") ? bar.parentNode : null;
    if (!d && !mb && !tb) return;
    if (!d) { d = document.createElement("div"); d.className = "jz-dock"; bar.parentNode.insertBefore(d, bar); d.appendChild(bar); }
    if (mb && mb.parentNode !== d) d.appendChild(mb);
    if (tb && tb.parentNode !== d) d.appendChild(tb);
    if (mb && tb && mb.nextElementSibling !== tb) d.appendChild(tb);
    document.querySelectorAll(".menubar .mb-menu").forEach(function (m) { document.body.appendChild(m); });   // menus live in <body>, outside the blurred bar
  }
  // Keep the page below the fixed bar (or the whole dock): an in-flow spacer as tall as it, kept right as the bar wraps or the screen turns. --dock-h = that height, for sticky bars under it.
  function spacer() {
    var bar = document.querySelector(".jz-dock") || document.querySelector(".topbar"); if (!bar) return;
    var sp = bar.nextElementSibling; if (!sp || !sp.classList.contains("topbar-spacer")) { sp = document.createElement("div"); sp.className = "topbar-spacer"; sp.setAttribute("aria-hidden", "true"); bar.parentNode.insertBefore(sp, bar.nextSibling); }
    sp.style.height = bar.offsetHeight + "px"; root.style.setProperty("--dock-h", bar.offsetHeight + "px");
  }
  document.addEventListener("DOMContentLoaded", dock); document.addEventListener("DOMContentLoaded", spacer); window.addEventListener("resize", spacer); window.addEventListener("load", spacer);
  if (window.ResizeObserver) document.addEventListener("DOMContentLoaded", function () { var b = document.querySelector(".jz-dock") || document.querySelector(".topbar"); if (b) new ResizeObserver(spacer).observe(b); });
  // Menu bar: a button with data-menu="x" opens the .mb-menu[data-menu-for="x"]; choosing an item (or tapping outside, Esc, scrolling) closes it. Items are ordinary buttons the app listens to.
  var openBtn = null;
  function menuOf(b) { return document.querySelector('.mb-menu[data-menu-for="' + b.getAttribute("data-menu") + '"]'); }
  function closeMenu() { if (!openBtn) return; var m = menuOf(openBtn); if (m) m.hidden = true; openBtn.setAttribute("aria-expanded", "false"); openBtn = null; }
  function openMenu(b) {
    closeMenu(); var m = menuOf(b); if (!m) return; m.hidden = false;
    var r = b.getBoundingClientRect(); m.style.top = (r.bottom + 4) + "px"; m.style.left = Math.max(8, Math.min(r.left, window.innerWidth - m.offsetWidth - 8)) + "px";
    b.setAttribute("aria-expanded", "true"); openBtn = b;
  }
  document.addEventListener("click", function (e) {
    var b = e.target.closest && e.target.closest("[data-menu]");
    if (b) { if (openBtn === b) closeMenu(); else openMenu(b); return; }
    if (!e.target.closest(".mb-menu") || e.target.closest(".mb-item")) closeMenu();
  });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeMenu(); });
  window.addEventListener("resize", closeMenu); window.addEventListener("scroll", closeMenu, true);
  var homeUrl = "";
  function paintHome() { document.querySelectorAll("[data-home]").forEach(function (b) { b.hidden = !homeUrl; }); }
  function setHome(u) { homeUrl = typeof u === "string" && /^https?:\/\//i.test(u) ? u : ""; paintHome(); }
  document.addEventListener("click", function (e) { var b = e.target.closest && e.target.closest("[data-home]"); if (b && homeUrl) location.href = homeUrl; });
  document.addEventListener("DOMContentLoaded", function () {
    if (!document.querySelector("[data-home]")) return;
    try { fetch("api/app-config", { cache: "no-store" }).then(function (r) { return r.ok ? r.json() : {}; }).then(function (c) { if (c && c.portalUrl) setHome(c.portalUrl); }).catch(function () {}); } catch (e) {}
  });
  window.JZBar = { setHome: setHome, closeMenu: closeMenu };
  window.JZTheme = { set: set, effective: effective, paint: paint };
})();
