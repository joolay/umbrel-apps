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
    var m = effective(); document.querySelectorAll("[data-theme-toggle]").forEach(function (b) { b.setAttribute("data-mode", m); b.setAttribute("aria-label", m === "dark" ? "Switch to light theme" : "Switch to dark theme"); if (b.classList.contains("jz-acct-item")) b.removeAttribute("title"); else b.title = b.getAttribute("aria-label"); b.querySelectorAll(".jz-lb").forEach(function (l) { l.textContent = m === "dark" ? "Day mode" : "Night mode"; }); });   // account-menu tile: names what it switches TO
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
    document.querySelectorAll(".jz-dock .mb-menu").forEach(function (m) { document.body.appendChild(m); });   // menus live in <body>, outside the blurred bars
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
  // Account menu: the profile icon at the far right of the top bar opens a dropdown of large icons: Settings, Day/Night mode, Install, then Log out at the bottom.
  // The old loose buttons (data-settings, data-theme-toggle, data-pwa-install inside the bar) stay in the page, hidden by floatbar.css, so every app's own handlers keep working:
  // the Settings tile clicks the app's [data-settings] button (and hides with it), Log out clicks the app's [data-logout] element (or the function given to JZBar.onLogout; with neither the tile is hidden),
  // the Day/Night and Install tiles carry data-theme-toggle / data-pwa-install themselves. Install shows only in a phone or tablet browser tab, never inside the installed app (installbtn.js decides).
  // The app names the person with JZBar.setUser({ name, initial }); without it the icon is a plain person.
  var meInfo = { name: "", initial: "" }, logoutFn = null, meBtn = null, meMenu = null;
  var SVG = function (cls, p) { return '<svg viewBox="0 0 24 24" aria-hidden="true"' + (cls ? ' class="' + cls + '"' : "") + ">" + p + "</svg>"; };
  var PERSON = SVG("", '<circle cx="12" cy="8.5" r="3.8"/><path d="M4.5 20.2a7.5 7.5 0 0 1 15 0"/>');
  var GEAR = '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3h0a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5h0a1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9v0a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>';
  function tile(key, attrs, icon, label, hint) { return '<button type="button" class="jz-acct-item" role="menuitem" data-jz="' + key + '" data-hint="' + hint + '"' + attrs + '><span class="jz-ic">' + icon + '</span><span class="jz-lb">' + label + "</span></button>"; }
  function meOpen() { return !!meMenu && !meMenu.hidden; }
  function paintMe() {
    if (!meBtn) return;
    if (meInfo.initial) { meBtn.textContent = meInfo.initial; meBtn.classList.add("has-initial"); } else { meBtn.innerHTML = PERSON; meBtn.classList.remove("has-initial"); }
    meBtn.title = meInfo.name || "Account"; meBtn.setAttribute("data-hint", (meInfo.name ? meInfo.name + " · " : "") + "Account menu"); meBtn.setAttribute("aria-label", meInfo.name ? "Account: " + meInfo.name : "Account");
    syncMe();
  }
  function syncMe() {
    if (!meMenu) return;
    var lo = meMenu.querySelector('[data-jz="logout"]'), st = meMenu.querySelector('[data-jz="settings"]'), nm = meMenu.querySelector(".jz-acct-name"), sb = document.querySelector(".topbar [data-settings]");
    lo.hidden = !(logoutFn || document.querySelector("[data-logout]"));
    st.hidden = !sb || sb.hidden; st.setAttribute("aria-pressed", sb && sb.getAttribute("aria-pressed") === "true" ? "true" : "false");
    nm.textContent = meInfo.name; nm.hidden = !meInfo.name;
  }
  function openMe() {
    if (!meMenu) return; syncMe(); meMenu.hidden = false;
    var r = meBtn.getBoundingClientRect(); meMenu.style.top = Math.round(r.bottom + 8) + "px"; meMenu.style.right = Math.max(10, Math.round(innerWidth - r.right)) + "px";
    meBtn.setAttribute("aria-expanded", "true"); closeMenu();
  }
  function closeMe(refocus) { if (!meOpen()) return; meMenu.hidden = true; meBtn.setAttribute("aria-expanded", "false"); if (refocus) meBtn.focus(); }
  function buildMe() {
    var bar = document.querySelector(".topbar"); if (!bar || bar.querySelector(".jz-me")) return;
    meBtn = document.createElement("button"); meBtn.type = "button"; meBtn.className = "tb-btn jz-me"; meBtn.setAttribute("aria-haspopup", "menu"); meBtn.setAttribute("aria-expanded", "false"); bar.appendChild(meBtn);
    meMenu = document.createElement("div"); meMenu.className = "jz-acct"; meMenu.setAttribute("role", "menu"); meMenu.hidden = true;
    meMenu.innerHTML = '<div class="jz-acct-name" hidden></div>' +
      tile("settings", "", SVG("", GEAR), "Settings", "Open this app's settings") +
      tile("theme", " data-theme-toggle", SVG("i-moon", '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/>') + SVG("i-sun", '<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4"/>'), "Night mode", "Switch between the day and night display") +
      tile("install", " data-pwa-install hidden", SVG("", '<path d="M12 4v10"/><path d="m8 10.5 4 4 4-4"/><path d="M5 17v2.5h14V17"/>'), "Install app", "Add this app to your Home Screen") +
      tile("logout", "", SVG("", '<path d="M9.5 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h3.5"/><path d="M16 8l4 4-4 4"/><path d="M20 12H9.5"/>'), "Log out", "Sign out of this app");
    document.body.appendChild(meMenu); paintMe(); paint();
  }
  // App icon: the bar shows the app's icon before its name. An app that has no <img> in .brand gets one from its apple-touch-icon (every app head carries it), so nothing to add per app.
  function brandIcon() {
    var br = document.querySelector(".topbar .brand"); if (!br || br.querySelector("img")) return;
    var l = document.querySelector('link[rel="apple-touch-icon"]'); if (!l || !l.getAttribute("href")) return;
    var im = document.createElement("img"); im.alt = ""; im.setAttribute("aria-hidden", "true"); im.src = l.getAttribute("href"); im.onerror = function () { im.remove(); }; br.insertBefore(im, br.firstChild);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", brandIcon); else brandIcon();
  document.addEventListener("click", function (e) {
    var t = e.target.closest && e.target.closest(".jz-me, .jz-acct-item");
    if (t && t.classList.contains("jz-me")) { if (meOpen()) closeMe(); else openMe(); return; }
    if (t) {
      var k = t.getAttribute("data-jz");
      if (k === "logout") { var lg = document.querySelector("[data-logout]"); closeMe(); if (lg) lg.click(); else if (logoutFn) logoutFn(); }
      else if (k === "settings") { var sb = document.querySelector(".topbar [data-settings]"); closeMe(); if (sb) sb.click(); }
      else if (k === "install") closeMe();   // installbtn.js handles the tap; Day/Night is switched by the handler above and keeps the menu open so the change is seen
      return;
    }
    if (meOpen() && !e.target.closest(".jz-acct")) closeMe();
  });
  document.addEventListener("keydown", function (e) {
    if (!meOpen()) return;
    if (e.key === "Escape") { closeMe(true); return; }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    var items = [].slice.call(meMenu.querySelectorAll(".jz-acct-item")).filter(function (b) { return !b.hidden; }), i = items.indexOf(document.activeElement);
    e.preventDefault(); if (items.length) items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length].focus();
  });
  window.addEventListener("resize", function () { closeMe(); });
  window.addEventListener("scroll", function (e) { if (meOpen() && !(e.target.nodeType === 1 && e.target.closest(".jz-acct"))) closeMe(); }, true);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", buildMe); else buildMe();
  // Hover hints (computer with a mouse only; phones and tablets never see them): pause the pointer on an icon-only button in the bars, the profile icon or an account-menu tile and a small styled hint appears
  // (data-hint, else the button's old title, else its aria-label). Menu tiles show theirs to the left of the menu, everything else just below. Hidden again on leaving, clicking, scrolling or Esc.
  var canHover = window.matchMedia && matchMedia("(hover:hover) and (pointer:fine)"), hintEl = null, hintFor = null, hintT = 0;
  function hideHint() { clearTimeout(hintT); hintFor = null; if (hintEl) { hintEl.remove(); hintEl = null; } }
  function showHint(b, text) {
    hintEl = document.createElement("div"); hintEl.className = "jz-hint"; hintEl.setAttribute("role", "tooltip"); hintEl.textContent = text; document.body.appendChild(hintEl);
    var r = b.getBoundingClientRect(), w = hintEl.offsetWidth, h = hintEl.offsetHeight, x, y;
    if (b.classList.contains("jz-acct-item") && meMenu) { var m = meMenu.getBoundingClientRect(); x = m.left - w - 10; y = r.top + (r.height - h) / 2; if (x < 8) { x = Math.max(8, r.left); y = r.bottom + 6; } }
    else { x = Math.min(innerWidth - w - 8, Math.max(8, r.left + (r.width - w) / 2)); y = r.bottom + 8; }
    hintEl.style.left = Math.round(x) + "px"; hintEl.style.top = Math.round(y) + "px";
  }
  document.addEventListener("mouseover", function (e) {
    if (!canHover || !canHover.matches) return;
    var b = e.target.closest && e.target.closest(".topbar .tb-btn, .jz-acct-item, .toolbar .tool, .menubar .mb-btn[aria-label]");
    if (b === hintFor) return; hideHint(); if (!b || b.disabled) return;
    if (b.hasAttribute("title")) { if (!b.getAttribute("data-hint")) b.setAttribute("data-hint", b.getAttribute("title")); b.removeAttribute("title"); }   // no second, native hint on top of ours
    var t = b.getAttribute("data-hint") || b.getAttribute("aria-label"); if (!t) return;
    hintFor = b; hintT = setTimeout(function () { if (hintFor === b) showHint(b, t); }, 300);
  });
  document.addEventListener("mouseout", function (e) { if (hintFor && !(e.relatedTarget && hintFor.contains(e.relatedTarget))) hideHint(); });
  document.addEventListener("click", hideHint, true); document.addEventListener("keydown", hideHint, true); window.addEventListener("scroll", hideHint, true);
  function setUser(u) { u = u || {}; var n = String(u.name || "").trim(); meInfo = { name: n, initial: String(u.initial || n.charAt(0) || "").trim().charAt(0).toUpperCase() }; paintMe(); }
  function onLogout(fn) { logoutFn = typeof fn === "function" ? fn : null; syncMe(); }
  window.JZBar = { setHome: setHome, closeMenu: closeMenu, setUser: setUser, onLogout: onLogout, closeAccount: closeMe };
  window.JZTheme = { set: set, effective: effective, paint: paint };
})();
