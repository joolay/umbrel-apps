// Top-bar helpers for every JoolzApp. One script, no dependencies (it ships inside jz.js).
//  - The sync ticks (WhatsApp-style) and the Claude-link ticks were REMOVED from the template on 26/11/2026. The full ticks version is kept, unused and
//    not built into jz.js, in templates/glass/optional/synctick.js: copy it into an app (load it last in <body>, add data-claude for the Claude link) to bring them back.
//  - Still here: the server reachability check that colours the dot on the profile icon (JZBar.setConn), and the AI sparkle:
//      JZLink.ai(true) / JZLink.ai(false)   or   JZLink.aiWhile(promise)  (a breathing spark in the top bar while the AI works; several at once are counted)
//    JZLink.sync() and JZLink.link() still exist and do nothing, so apps that call them keep working.
(function () {
  "use strict";
  var css = ".jz-ind{display:inline-flex;align-items:center;justify-content:center;flex:none;height:32px;min-width:32px;padding:0 4px;margin:0 2px;border:0;background:none;color:inherit;cursor:pointer;border-radius:10px;position:relative}" +
    ".jz-ai{color:#7F77DD;cursor:default}.jz-ai[hidden]{display:none}.jz-ai svg{width:20px;height:20px;fill:currentColor;animation:jzspark 1.6s ease-in-out infinite}@keyframes jzspark{0%,100%{transform:scale(1) rotate(0);opacity:.7}50%{transform:scale(1.25) rotate(20deg);opacity:1}}@media (prefers-reduced-motion:reduce){.jz-ai svg{animation:none;opacity:1}}"
  var st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);

  function bar() { return document.querySelector(".topbar") || document.querySelector("header") || document.querySelector("#bar"); }
  function slot(b) { return b.querySelector("[data-pwa-install]") || b.querySelector("[data-theme-toggle]") || null; }
  var AI = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l2.2 6.3L20.5 10l-6.3 1.7L12 18l-2.2-6.3L3.5 10l6.3-1.7z"/><path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z"/></svg>';
  var aiEl = null, aiN = 0;
  function aiPaint() {
    if (!aiEl) {
      var b = bar(); if (!b || aiN <= 0) return;
      aiEl = document.createElement("button"); aiEl.type = "button"; aiEl.className = "jz-ind jz-ai"; aiEl.setAttribute("aria-label", "AI is working"); aiEl.title = "AI is working"; aiEl.setAttribute("role", "status"); aiEl.innerHTML = AI;
      var ref = slot(b); if (ref) ref.parentNode.insertBefore(aiEl, ref); else b.appendChild(aiEl);
    }
    aiEl.hidden = aiN <= 0;
  }
  function ai(on) { aiN = on === false ? 0 : Math.max(1, aiN); aiPaint(); }
  function aiWhile(p) { aiN++; aiPaint(); var done = function () { aiN = Math.max(0, aiN - 1); aiPaint(); }; Promise.resolve(p).then(done, done); return p; }

  var busy = false;
  function check() {
    if (busy) return; busy = true;
    if (navigator.onLine === false) { busy = false; if (window.JZBar) JZBar.setConn(false); return; }
    var ctl = window.AbortController ? new AbortController() : null, to = setTimeout(function () { if (ctl) ctl.abort(); }, 7000);
    fetch(location.pathname || "/", { method: "HEAD", cache: "no-store", credentials: "same-origin", signal: ctl ? ctl.signal : undefined })
      .then(function () { if (window.JZBar) JZBar.setConn(true); })
      .catch(function () { if (window.JZBar) JZBar.setConn(false); })
      .then(function () { clearTimeout(to); busy = false; });
  }
  function go() { check(); setInterval(check, 10000); addEventListener("online", check); addEventListener("offline", check); document.addEventListener("visibilitychange", function () { if (!document.hidden) check(); }); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", go); else go();
  window.JZLink = { check: check, link: function () {}, sync: function () {}, ai: ai, aiWhile: aiWhile };
})();
