// Adds a Show/Hide button to every password field on the page, including fields the app adds later.
// Self-contained: no dependencies, no app code needs to change.
(function () {
  "use strict";
  var css = ".pw-wrap{position:relative;display:block;width:100%}.pw-wrap>input{padding-right:4rem!important}" +
    ".pw-eye{position:absolute;right:6px;top:50%;transform:translateY(-50%);border:0;background:none;font:inherit;font-size:.8rem;font-weight:600;" +
    "cursor:pointer;padding:6px 8px;opacity:.7;border-radius:8px;line-height:1}.pw-eye:hover,.pw-eye:focus-visible{opacity:1;text-decoration:underline}" +
    "input::-ms-reveal{display:none}";
  var st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);

  function enhance(i) {
    if (i.dataset.pw || i.type !== "password" || !i.parentNode) return;
    i.dataset.pw = "1";
    var w = document.createElement("span"); w.className = "pw-wrap";
    i.parentNode.insertBefore(w, i); w.appendChild(i);
    var b = document.createElement("button"); b.type = "button"; b.className = "pw-eye";
    try { b.style.color = getComputedStyle(i).color; } catch (e) {}
    function sync() { var shown = i.type === "text"; b.textContent = shown ? "Hide" : "Show"; b.setAttribute("aria-pressed", shown ? "true" : "false"); b.setAttribute("aria-label", shown ? "Hide password" : "Show password"); }
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
