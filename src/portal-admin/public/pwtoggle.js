// Adds an eye button (open eye = password showing, closed eye = hidden) to every password field on the page, including fields the app adds later.
// Self-contained: no dependencies, no app code needs to change.
(function () {
  "use strict";
  var css = ".pw-wrap{position:relative;display:block;width:100%}.pw-wrap>input{width:100%;box-sizing:border-box;padding-right:46px!important}" +
    ".pw-eye{position:absolute;right:5px;top:50%;transform:translateY(-50%);width:36px;height:36px;border:0;background:none;display:grid;place-items:center;" +
    "cursor:pointer;padding:0;opacity:.65;border-radius:10px;color:inherit}.pw-eye:hover,.pw-eye:focus-visible{opacity:1;background:rgba(127,127,127,.16)}" +
    ".pw-eye svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;pointer-events:none}" +
    "input::-ms-reveal{display:none}";
  var OPEN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  var SHUT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 6A10 10 0 0 1 12 5.5C18.4 5.5 22 12 22 12a17 17 0 0 1-3.2 4"/><path d="M6.4 6.9A17 17 0 0 0 2 12s3.6 6.5 10 6.5a10 10 0 0 0 4.1-.9"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';
  var st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);

  function enhance(i) {
    if (i.dataset.pw || i.type !== "password" || !i.parentNode) return;
    i.dataset.pw = "1";
    var w = document.createElement("span"); w.className = "pw-wrap";
    i.parentNode.insertBefore(w, i); w.appendChild(i);
    var b = document.createElement("button"); b.type = "button"; b.className = "pw-eye";
    try { b.style.color = getComputedStyle(i).color; } catch (e) {}
    function sync() { var shown = i.type === "text"; b.innerHTML = shown ? OPEN : SHUT; b.setAttribute("aria-pressed", shown ? "true" : "false"); b.setAttribute("aria-label", shown ? "Hide password" : "Show password"); }
    b.onclick = function () { i.type = i.type === "password" ? "text" : "password"; sync(); i.focus(); };
    new MutationObserver(sync).observe(i, { attributes: true, attributeFilter: ["type"] });
    w.appendChild(b); sync();
  }
  function scan() { var l = document.querySelectorAll("input[type=password]"); for (var k = 0; k < l.length; k++) enhance(l[k]); }
  var pending = false;
  new MutationObserver(function () { if (pending) return; pending = true; requestAnimationFrame(function () { pending = false; scan(); }); })
    .observe(document.documentElement, { childList: true, subtree: true });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", scan); else scan();
})();
