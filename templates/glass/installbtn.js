// JoolzApp "Install" icon for the top bar. Load install-help.js first, then this file (at the end of <body>).
// Put <button data-pwa-install hidden aria-label="Install app" title="Install app">(icon)</button> in the bar; this script shows it only while the
// app runs in a normal browser tab (never once installed). Chrome, Edge, Samsung Internet and Opera give a real one-tap install
// (beforeinstallprompt); everywhere else (iPhone, iPad, Safari, Firefox) the icon opens a small sheet with the steps for that device.
(function () {
  "use strict";
  var H = window.InstallHelp, deferred = null, installed = false;
  function standalone() { return (window.matchMedia && matchMedia("(display-mode: standalone)").matches) || (window.matchMedia && matchMedia("(display-mode: window-controls-overlay)").matches) || navigator.standalone === true; }
  function secure() { return window.isSecureContext !== false && location.protocol === "https:"; }   // browsers only install from https
  function buttons() { return document.querySelectorAll("[data-pwa-install]"); }
  function paint() { var show = !installed && !standalone() && secure(); buttons().forEach(function (b) { b.hidden = !show; }); }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function sheet() {
    var d = H.detect({ ua: navigator.userAgent, platform: navigator.platform, touch: navigator.maxTouchPoints, standalone: standalone() });
    var steps = H.steps(d).filter(function (s) { return !/^(Tap|Click) Open below/.test(s) && !/Tap Install again/.test(s); });   // we are already on the app's own page
    var dlg = document.getElementById("pwa-install-dlg");
    if (!dlg) { dlg = document.createElement("dialog"); dlg.id = "pwa-install-dlg"; dlg.style.cssText = "max-width:min(92vw,420px);border:1px solid var(--glass-line,#ccc);border-radius:22px;background:var(--solid,var(--glass-strong,#fff));color:var(--text,#111);padding:20px"; document.body.appendChild(dlg); }
    dlg.innerHTML = '<h2 style="margin:0 0 8px;font-size:1.15rem">Install ' + esc(document.title) + '</h2><ol style="margin:0 0 10px;padding-left:20px;line-height:1.5">' + steps.map(function (s) { return "<li>" + esc(s) + "</li>"; }).join("") + "</ol>" +
      (H.signInNote(d) ? '<p style="margin:0 0 10px;font-size:.85rem;opacity:.75">' + esc(H.signInNote(d)) + "</p>" : "") + '<button class="btn primary" style="width:100%" id="pwa-close">Got it</button>';
    dlg.querySelector("#pwa-close").onclick = function () { dlg.close(); };
    dlg.showModal();
  }
  document.addEventListener("click", function (e) {
    var b = e.target.closest && e.target.closest("[data-pwa-install]"); if (!b) return;
    e.preventDefault();
    if (deferred) { var p = deferred; deferred = null; p.prompt(); p.userChoice.then(function (r) { if (r && r.outcome === "accepted") { installed = true; paint(); } else paint(); }, paint); }
    else sheet();
  });
  window.addEventListener("beforeinstallprompt", function (e) { e.preventDefault(); deferred = e; paint(); });
  window.addEventListener("appinstalled", function () { installed = true; deferred = null; paint(); });
  if (window.matchMedia) { var mq = matchMedia("(display-mode: standalone)"); (mq.addEventListener ? mq.addEventListener.bind(mq, "change") : mq.addListener.bind(mq))(paint); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", paint); else paint();
})();
