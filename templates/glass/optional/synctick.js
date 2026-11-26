// Top-bar connection icons for every JoolzApp. One script, no dependencies: <script src="linkstatus.js"></script> at the end of <body>.
//  1. Sync ticks (every app, WhatsApp style, replaces the old dot):
//       red crossed tick   = not connected (server did not answer, device offline, or the last save failed)
//       grey tick          = saving: the latest change is not recorded yet (or it is kept on this device only)
//       one green tick     = recorded to PocketBase (your JoolzApp account)
//       second tick amber  = recorded, and read by some but not all of the parties the data is shared with
//       two green ticks    = recorded and read by all shared parties (data nobody else shares counts as read once recorded)
//     An app that says nothing shows one green tick while its server answers (reachable). An app that keeps data on the account tells the ticks how it is doing:
//       JZLink.sync({ saved: "saving" | "saved" | "error" | "local", parties: <how many others share this data>, read: <how many of them have read the latest>, note: "optional text" })
//     Reachability is checked every 15 s and on online/offline.
//  2. Claude link (only apps that talk to Claude: add the attribute  data-claude ): NO separate icon any more, the same sync ticks show it:
//       two green ticks    = the last change was read by the other side (app and Claude are in step)
//       one green tick     = this app wrote something Claude has not read yet
//       second tick amber  = Claude wrote something this app has not read yet
//       red cross          = broken: a report the app should have made has not come through
//     It reads GET api/link on the app's own server (see src/app-updater/status-feed.js: link()). An app that reports its own state with JZLink.sync() keeps that, except that a broken Claude link always shows the red cross.
//  3. AI sparkle (any app with AI features): a spark that breathes and tilts, shown beside the ticks ONLY while the AI is working, gone when it finishes.
//       JZLink.ai(true) / JZLink.ai(false)   or   JZLink.aiWhile(promise)  (shows while the promise is pending; several at once are counted)
//     Respects "reduce motion" (then it just glows, no movement).
// The ticks go into the bar (.topbar, else the first <header>) just before the Install / theme buttons.
(function () {
  "use strict";
  var me = (window.JZ_SCRIPT || document.currentScript), claude = !!(me && me.hasAttribute("data-claude"));
  var css = ".jz-ind{display:inline-flex;align-items:center;justify-content:center;flex:none;height:32px;min-width:32px;padding:0 4px;margin:0 2px;border:0;background:none;color:inherit;cursor:pointer;border-radius:10px;position:relative}" +
    ".jz-ind svg{display:block;overflow:visible}.jz-ind:focus-visible{outline:2px solid currentColor;outline-offset:1px}" +
    ".jz-conn svg{fill:none;stroke:#9aa3b2;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round}.jz-conn .jz-t1,.jz-conn .jz-t2,.jz-conn .jz-cut{transition:stroke .3s,opacity .3s}.jz-conn .jz-t2,.jz-conn .jz-cut{opacity:0}" +
    ".jz-conn[data-s=rec] .jz-t1,.jz-conn[data-s=part] .jz-t1,.jz-conn[data-s=read] .jz-t1,.jz-conn[data-s=read] .jz-t2{stroke:#22c55e}.jz-conn[data-s=part] .jz-t2{opacity:1;stroke:#f59e0b}.jz-conn[data-s=read] .jz-t2{opacity:1}" +
    ".jz-conn[data-s=off] .jz-t1{opacity:0}.jz-conn[data-s=off] .jz-cut{opacity:1;stroke:#ef4444}.jz-conn[data-s=rec] .jz-t2{opacity:.22;stroke:#22c55e}.jz-conn[data-s=pend] .jz-t1{animation:jzp 1.2s ease-in-out infinite}@keyframes jzp{50%{opacity:.35}}.jz-conn[data-s=pend] .jz-t1,.jz-conn[data-s=local] .jz-t1{stroke:#9aa3b2}" +

    "@media (max-width:480px){.topbar{gap:4px!important;padding-left:10px!important;padding-right:10px!important}.topbar .jz-ind{margin:0;padding:0 1px;min-width:26px}.topbar .tb-btn{width:34px;height:34px}.topbar .iconbtn{width:34px;height:34px}}" +
    ".jz-ai{color:#7F77DD;cursor:default}.jz-ai[hidden]{display:none}.jz-ai svg{width:20px;height:20px;fill:currentColor;animation:jzspark 1.6s ease-in-out infinite}@keyframes jzspark{0%,100%{transform:scale(1) rotate(0);opacity:.7}50%{transform:scale(1.25) rotate(20deg);opacity:1}}@media (prefers-reduced-motion:reduce){.jz-ai svg{animation:none;opacity:1}}" +
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

  // two overlapping ticks (the second one only shows once the data has been read) and a slash for "not connected"
  var WIFI = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path class="jz-t1" d="M2 13l4 4 8-9"/><path class="jz-t2" d="M7 13l4 4 8-9"/><path class="jz-cut" d="M7 7l10 10M17 7L7 17"/></svg>';

  var AI = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l2.2 6.3L20.5 10l-6.3 1.7L12 18l-2.2-6.3L3.5 10l6.3-1.7z"/><path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z"/></svg>';
  var aiEl = null, aiN = 0;
  function aiPaint() {
    if (!aiEl) { if (!bar() || !conn) return; aiEl = make("jz-ai", "AI is working", AI); aiEl.title = "AI is working"; aiEl.setAttribute("role", "status"); aiEl.hidden = true; conn.parentNode.insertBefore(aiEl, conn); }
    aiEl.hidden = aiN <= 0;
  }
  function ai(on) { aiN = on === false ? 0 : Math.max(1, aiN); aiPaint(); }
  function aiWhile(p) { aiN++; aiPaint(); var done = function () { aiN = Math.max(0, aiN - 1); aiPaint(); }; Promise.resolve(p).then(done, done); return p; }
  var conn = null, cl = null;   // cl: the Claude link state from api/link
  function mount() {
    var b = bar(); if (!b || b.querySelector(".jz-ind")) return !!(b && b.querySelector(".jz-ind"));
    var ref = slot(b);
    function put(el) { if (ref) ref.parentNode.insertBefore(el, ref); else b.appendChild(el); }
    conn = make("jz-conn", "Sync status", WIFI); conn.setAttribute("data-s", "wait"); put(conn); paint(); if (aiN > 0) aiPaint();
    conn.addEventListener("click", function () { tip(conn, conn._label || ""); check(); });
    return true;
  }

  var reach = null, rep = null;   // reach: does the server answer? rep: what the app said through JZLink.sync()
  function paint() {
    if (!conn) return;
    if (reach === false) return set(conn, { "data-s": "off" }, navigator.onLine === false ? "Not connected: this device is offline." : "Not connected: the server did not answer.");
    if (reach === null && !rep && !cl) return set(conn, { "data-s": "wait" }, "Checking the connection\u2026");
    if (claude && cl && cl.s === "broken") return set(conn, { "data-s": "off" }, cl.txt);
    if (!rep && claude && cl) return set(conn, { "data-s": cl.s === "both" ? "read" : cl.s === "ai" ? "part" : "rec" }, cl.txt);
    if (!rep) return set(conn, { "data-s": "rec" }, "Connected: the server answered.");
    var n = rep.note ? " " + rep.note : "";
    if (rep.saved === "error") return set(conn, { "data-s": "off" }, "Not saved: the last change could not be recorded. It will be tried again." + n);
    if (rep.saved === "saving") return set(conn, { "data-s": "pend" }, "Saving\u2026 the latest change is not recorded yet." + n);
    if (rep.saved === "local") return set(conn, { "data-s": "local" }, "Kept on this device only: this app is not signed in to your account." + n);
    var parties = Math.max(0, +rep.parties || 0), read = Math.max(0, +rep.read || 0);
    if (!parties || read >= parties) return set(conn, { "data-s": "read" }, (parties ? "Recorded and read by everyone it is shared with." : "Recorded to your account.") + n);
    if (read > 0) return set(conn, { "data-s": "part" }, "Recorded. Read by " + read + " of " + parties + " it is shared with." + n);
    return set(conn, { "data-s": "rec" }, "Recorded to your account. Not read by the others yet." + n);
  }
  function sync(o) { rep = o && typeof o === "object" ? o : null; paint(); }

  var busy = false;
  function check() {
    if (!conn || busy) return; busy = true;
    if (navigator.onLine === false) { busy = false; reach = false; if (window.JZBar) JZBar.setConn(false); return paint(); }
    var ctl = window.AbortController ? new AbortController() : null, to = setTimeout(function () { if (ctl) ctl.abort(); }, 7000);
    fetch(location.pathname || "/", { method: "HEAD", cache: "no-store", credentials: "same-origin", signal: ctl ? ctl.signal : undefined })
      .then(function () { reach = true; if (window.JZBar) JZBar.setConn(true); paint(); })
      .catch(function () { reach = false; if (window.JZBar) JZBar.setConn(false); paint(); })
      .then(function () { clearTimeout(to); busy = false; });
  }
  function link() {
    if (!claude) return;
    fetch("api/link", { cache: "no-store", credentials: "same-origin" }).then(function (r) { if (!r.ok) throw 0; return r.json(); }).then(function (j) {
      var s = j && ["both", "device", "ai", "broken"].indexOf(j.state) >= 0 ? j.state : "broken";
      var txt = s === "both" ? "Claude has read the last change: app and Claude are in step." : s === "device" ? "This app changed something; Claude has not read it yet." : s === "ai" ? "Claude changed something; this app has not read it yet." : "Link to Claude broken: " + (j && j.note ? j.note : "a report did not come through.");
      cl = { s: s, txt: txt }; paint();
    }).catch(function () { cl = { s: "broken", txt: "Link to Claude broken: the app's server did not answer." }; paint(); });
  }

  function start() { if (!mount()) { var n = 0, t = setInterval(function () { if (mount() || ++n > 40) { clearInterval(t); if (conn) go(); } }, 250); return; } go(); }
  function go() { check(); link(); setInterval(check, 10000); setInterval(link, 30000); addEventListener("online", check); addEventListener("offline", check); document.addEventListener("visibilitychange", function () { if (!document.hidden) { check(); link(); } }); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
  window.JZLink = { check: check, link: link, sync: sync, ai: ai, aiWhile: aiWhile };
})();
