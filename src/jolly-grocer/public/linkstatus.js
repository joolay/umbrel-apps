// Top-bar connection icons for every JoolzApp. One script, no dependencies: <script src="linkstatus.js"></script> at the end of <body>.
//  1. Connected icon (every app): a plain dot. Green = the server answered a moment ago, red = it did not (or the device is offline), grey = not checked yet. Checked every 15 s and on online/offline.
//  2. Link icon (only apps that talk to Claude: add the attribute  data-claude ): a chain link, still (no animation, no device or AI badges).
//       green = the last change was read by the other side (app and Claude are in step)
//       amber = a change was written (by the app or by Claude) and has not been read yet
//       grey, struck through in red = broken: a report the app should have made has not come through
//     It reads GET api/link on the app's own server (see src/app-updater/status-feed.js: link()).
// The icons go into the bar (.topbar, else the first <header>) just before the Install / theme buttons.
(function () {
  "use strict";
  var me = document.currentScript, claude = !!(me && me.hasAttribute("data-claude"));
  var css = ".jz-ind{display:inline-flex;align-items:center;justify-content:center;flex:none;height:32px;min-width:32px;padding:0 4px;margin:0 2px;border:0;background:none;color:inherit;cursor:pointer;border-radius:10px;position:relative}" +
    ".jz-ind svg{display:block;overflow:visible}.jz-ind:focus-visible{outline:2px solid currentColor;outline-offset:1px}" +
    ".jz-conn .jz-dot{fill:#9aa3b2;transition:fill .3s}.jz-conn[data-s=on] .jz-dot{fill:#22c55e}.jz-conn[data-s=off] .jz-dot{fill:#ef4444}" +
    ".jz-hs svg{fill:none;stroke:#9aa3b2;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;transition:stroke .3s}.jz-hs[data-s=both] svg{stroke:#22c55e}.jz-hs[data-s=device] svg,.jz-hs[data-s=ai] svg{stroke:#f59e0b}" +
    ".jz-hs .jz-cut{opacity:0}.jz-hs[data-s=broken] .jz-cut{opacity:1;stroke:#ef4444}" +
    "@media (max-width:480px){.topbar{gap:4px!important;padding-left:10px!important;padding-right:10px!important}.topbar .jz-ind{margin:0;padding:0 1px;min-width:26px}.topbar .jz-hs svg{width:22px;height:22px}.topbar .tb-btn{width:34px;height:34px}.topbar .iconbtn{width:34px;height:34px}}" +
    ".jz-tip{position:fixed;z-index:2147483000;max-width:260px;padding:8px 10px;border-radius:10px;font:500 12px/1.35 system-ui,sans-serif;color:#fff;background:rgba(15,20,35,.92);box-shadow:0 6px 20px rgba(0,0,0,.3);pointer-events:none}";
  var st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);

  function bar() { return document.querySelector(".topbar") || document.querySelector("header") || document.querySelector("#bar"); }
  function slot(b) { return b.querySelector("[data-pwa-install]") || b.querySelector("[data-theme-toggle]") || null; }
  function make(cls, label, html) { var e = document.createElement("button"); e.type = "button"; e.className = "jz-ind " + cls; e.setAttribute("aria-label", label); e.innerHTML = html; return e; }
  var tipEl = null, tipT = 0;
  function tip(el, text) {
    clearTimeout(tipT); if (tipEl) tipEl.remove();
    tipEl = document.createElement("div"); tipEl.className = "jz-tip"; tipEl.setAttribute("role", "status"); tipEl.textContent = text; document.body.appendChild(tipEl);
    var r = el.getBoundingClientRect(); tipEl.style.top = Math.min(innerHeight - tipEl.offsetHeight - 8, r.bottom + 8) + "px"; tipEl.style.left = Math.max(8, Math.min(innerWidth - tipEl.offsetWidth - 8, r.right - tipEl.offsetWidth)) + "px";
    tipT = setTimeout(function () { if (tipEl) { tipEl.remove(); tipEl = null; } }, 4500);
  }
  function set(el, attrs, label) { for (var k in attrs) el.setAttribute(k, attrs[k]); el.title = label; el.setAttribute("aria-label", label); el._label = label; }

  var WIFI = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><circle class="jz-dot" cx="12" cy="12" r="6"/></svg>';
  // a chain link (still). Colour shows the state, see the header.
  var HS = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/><path class="jz-cut" d="M4 4l16 16" stroke-width="2"/></svg>';

  var conn = null, hs = null;
  function mount() {
    var b = bar(); if (!b || b.querySelector(".jz-ind")) return !!(b && b.querySelector(".jz-ind"));
    var ref = slot(b);
    function put(el) { if (ref) ref.parentNode.insertBefore(el, ref); else b.appendChild(el); }
    if (claude) { hs = make("jz-hs", "Connection to Claude", HS); hs.setAttribute("data-s", "broken"); hs.setAttribute("data-shake", "off"); put(hs); hs.addEventListener("click", function () { tip(hs, hs._label || ""); }); }
    conn = make("jz-conn", "Connection to the server", WIFI); conn.setAttribute("data-s", "wait"); put(conn);
    conn.addEventListener("click", function () { tip(conn, conn._label || ""); check(); });
    return true;
  }

  var busy = false;
  function check() {
    if (!conn || busy) return; busy = true;
    if (navigator.onLine === false) { busy = false; return set(conn, { "data-s": "off" }, "Not connected: this device is offline."); }
    var ctl = window.AbortController ? new AbortController() : null, to = setTimeout(function () { if (ctl) ctl.abort(); }, 7000);
    fetch(location.pathname || "/", { method: "HEAD", cache: "no-store", credentials: "same-origin", signal: ctl ? ctl.signal : undefined })
      .then(function () { set(conn, { "data-s": "on" }, "Connected to the server."); })
      .catch(function () { set(conn, { "data-s": "off" }, "Not connected: the server did not answer."); })
      .then(function () { clearTimeout(to); busy = false; });
  }
  function link() {
    if (!hs) return;
    fetch("api/link", { cache: "no-store", credentials: "same-origin" }).then(function (r) { if (!r.ok) throw 0; return r.json(); }).then(function (j) {
      var s = j && ["both", "device", "ai", "broken"].indexOf(j.state) >= 0 ? j.state : "broken", shake = s !== "broken" && j.shaking !== false;
      var txt = s === "both" ? "Link to Claude: the last change was read by the other side." : s === "device" ? "Link to Claude: this app changed something; Claude has not read it yet." : s === "ai" ? "Link to Claude: Claude changed something; this app has not read it yet." : "Link to Claude broken: " + (j && j.note ? j.note : "nothing has come through from the app.");
      set(hs, { "data-s": s, "data-shake": shake ? "on" : "off" }, txt);
    }).catch(function () { set(hs, { "data-s": "broken", "data-shake": "off" }, "Link to Claude broken: the app's server did not answer."); });
  }

  function start() { if (!mount()) { var n = 0, t = setInterval(function () { if (mount() || ++n > 40) { clearInterval(t); if (conn) go(); } }, 250); return; } go(); }
  function go() { check(); link(); setInterval(check, 15000); setInterval(link, 30000); addEventListener("online", check); addEventListener("offline", check); document.addEventListener("visibilitychange", function () { if (!document.hidden) { check(); link(); } }); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
  window.JZLink = { check: check, link: link };
})();
