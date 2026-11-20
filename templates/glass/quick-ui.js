// JoolzApp Quick Access for an app's pages: sign in with a PIN or pattern on a device you already signed in on.
// Needs glass.css (for .btn). Each page creates it with its own request function:
//   var QA = JZQuick({ app: "project-tracker", name: "Project Pilot", request: function (method, path, body) { return Promise<json> } });   // reject with Error(message) that has .status
//   QA.has()        a PIN or pattern is set up on this device
//   QA.signIn()     shows the pad; resolves { token, user } on success, or null (cancelled / "Use password instead")
//   QA.offer()      the first-run question after a password sign-in (once per device; "Not now" is remembered)
//   QA.manage()     the settings screen: set up, change, turn off on this device
// The code is ONE code per person for every JoolzApp; each device only keeps its own id and secret (localStorage), the server checks all three.
(function () {
  "use strict";
  var KINDS = [["pin4", "4 digit PIN", "Quickest to type"], ["pin6", "6 digit PIN", "A bit harder to guess"], ["pattern", "Pattern", "Join 4 or more dots"]];
  var CSS = ".qa-dlg{border:0;padding:0;background:transparent;max-width:none;color:var(--text,#111)}.qa-dlg::backdrop{background:rgba(10,12,24,.55)}" +
    ".qa-in{position:relative;width:min(92vw,340px);padding:26px 22px 22px;border-radius:28px;background:var(--solid,var(--glass-strong,#fff));border:1px solid var(--glass-line,rgba(0,0,0,.12));box-shadow:0 24px 60px rgba(0,0,0,.35);text-align:center}" +
    ".qa-in h2{margin:0 0 4px;font-size:21px}.qa-sub{margin:0 0 14px;font-size:.85rem;opacity:.7}.qa-x{position:absolute;right:12px;top:10px;width:32px;height:32px;border-radius:50%;border:0;background:rgba(127,127,127,.18);color:inherit;font-size:20px;cursor:pointer}" +
    ".qa-dots{display:flex;justify-content:center;gap:14px;margin:6px 0 20px}.qa-dots span{width:14px;height:14px;border-radius:50%;border:2px solid currentColor;opacity:.55}.qa-dots span.on{background:currentColor;opacity:1}" +
    ".qa-keys{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;justify-items:center}.qa-keys button{width:72px;height:72px;border-radius:50%;border:1px solid var(--glass-line,rgba(0,0,0,.14));background:rgba(127,127,127,.12);color:inherit;font-size:26px;font-weight:600;cursor:pointer}.qa-keys button:active{background:rgba(127,127,127,.3)}" +
    ".qa-pat{position:relative;width:240px;height:240px;margin:6px auto 10px;display:grid;grid-template-columns:repeat(3,1fr);touch-action:none;user-select:none;-webkit-user-select:none}" +
    ".qa-lines{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}.qa-lines polyline{fill:none;stroke:var(--accent,#5b8cff);stroke-width:5;stroke-linecap:round;stroke-linejoin:round;opacity:.8}" +
    ".qa-dot{display:grid;place-items:center}.qa-dot i{width:18px;height:18px;border-radius:50%;border:2px solid currentColor;opacity:.6;transition:transform .12s,background .12s}.qa-dot.on i{background:var(--accent,#5b8cff);border-color:var(--accent,#5b8cff);opacity:1;transform:scale(1.5)}" +
    ".qa-msg{min-height:20px;margin:6px 0 0;color:#e5484d;font-size:.85rem}.qa-btns{display:flex;flex-direction:column;gap:10px;margin-top:14px}.qa-btns .btn{display:flex;flex-direction:column;align-items:center;gap:2px;width:100%}.qa-btns small{font-weight:400;opacity:.65}" +
    ".qa-in .btn{font:inherit;font-weight:600;border:1px solid var(--glass-line,rgba(0,0,0,.14));background:rgba(127,127,127,.12);color:inherit;border-radius:16px;padding:12px 14px;cursor:pointer}.qa-in .btn.primary{background:linear-gradient(145deg,var(--accent-2,#f59e0b),var(--accent,#b45309));color:var(--accent-t,#fff);border-color:transparent}"+
    ".qa-link{background:none;border:0;color:inherit;opacity:.75;text-decoration:underline;font:inherit;font-size:.85rem;margin-top:12px;cursor:pointer}.qa-p{margin:0 0 6px;line-height:1.45}";
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function kindName(k) { for (var i = 0; i < KINDS.length; i++) if (KINDS[i][0] === k) return KINDS[i][1]; return "PIN or pattern"; }

  window.JZQuick = function (cfg) {
    var KEY = "jz.quick." + cfg.app, NOPE = KEY + ".declined", css = document.getElementById("qa-css");
    if (!css) { css = document.createElement("style"); css.id = "qa-css"; css.textContent = CSS; document.head.appendChild(css); }
    function get() { try { var v = JSON.parse(localStorage.getItem(KEY) || "null"); return v && v.deviceId && v.deviceSecret ? v : null; } catch (e) { return null; } }
    function put(v) { try { if (v) localStorage.setItem(KEY, JSON.stringify(v)); else localStorage.removeItem(KEY); } catch (e) { /* private mode: it just isn't remembered */ } }
    function label() { var u = navigator.userAgent, d = /iPhone/.test(u) ? "iPhone" : /iPad/.test(u) ? "iPad" : /Android/.test(u) ? "Android" : /Mac/.test(u) ? "Mac" : /Windows/.test(u) ? "Windows" : "browser"; return (cfg.name + " on " + d).slice(0, 40); }

    // A small dialog. html goes inside; wire(dlg, close) hooks the buttons. Resolves with whatever close(value) gets (null when dismissed).
    function dialog(html, wire) {
      return new Promise(function (resolve) {
        var d = document.createElement("dialog"); d.className = "qa-dlg"; d.innerHTML = '<div class="qa-in"><button class="qa-x" type="button" aria-label="Close">×</button>' + html + "</div>";
        document.body.appendChild(d); d.showModal(); var done = false;
        function close(v) { if (done) return; done = true; try { d.close(); } catch (e) {} d.remove(); resolve(v === undefined ? null : v); }
        d.querySelector(".qa-x").onclick = function () { close(null); }; d.addEventListener("cancel", function (e) { e.preventDefault(); close(null); });
        wire(d, close);
      });
    }
    // The PIN pad / pattern pad. onCode(code) may return a promise: { done: value } closes the pad with value, { msg: "text" } shows the text and lets them try again.
    function pad(o) {
      var isPat = o.kind === "pattern", n = o.kind === "pin6" ? 6 : 4, i, keys = [1, 2, 3, 4, 5, 6, 7, 8, 9, "", 0, "⌫"], dotsHtml = "", keyHtml = "";
      for (i = 0; i < 9; i++) dotsHtml += '<span class="qa-dot" data-i="' + i + '"><i></i></span>';
      for (i = 0; i < keys.length; i++) keyHtml += keys[i] === "" ? "<span></span>" : '<button type="button" data-k="' + keys[i] + '">' + keys[i] + "</button>";
      var html = "<h2>" + esc(o.title) + '</h2><p class="qa-sub">' + esc(o.sub || "") + "</p>" +
        (isPat ? '<div class="qa-pat"><svg class="qa-lines" viewBox="0 0 300 300"><polyline points=""/></svg>' + dotsHtml + "</div>"
          : '<div class="qa-dots">' + new Array(n + 1).join("<span></span>") + '</div><div class="qa-keys">' + keyHtml + "</div>") + '<p class="qa-msg" role="alert"></p>' +
        (o.link ? '<button class="qa-link" type="button">' + esc(o.link) + "</button>" : "");
      return dialog(html, function (d, close) {
        var msg = function (t) { d.querySelector(".qa-msg").textContent = t || ""; }, busy = false;
        if (o.link) d.querySelector(".qa-link").onclick = function () { close({ link: true }); };
        function submit(code, reset) {
          if (busy) return; busy = true;
          Promise.resolve(o.onCode(code)).then(function (r) { busy = false; if (r && r.done !== undefined) close(r.done); else { msg(r && r.msg || ""); reset(); } }, function (e) { busy = false; msg(e && e.message || "That did not work."); reset(); });
        }
        if (!isPat) {
          var code = "", dots = d.querySelectorAll(".qa-dots span");
          var paint = function () { for (var k = 0; k < dots.length; k++) dots[k].classList.toggle("on", k < code.length); };
          var reset = function () { code = ""; paint(); };
          var add = function (c) { if (busy || code.length >= n) return; msg(""); code += c; paint(); if (code.length === n) { var v = code; setTimeout(function () { submit(v, reset); }, 120); } };
          d.querySelectorAll(".qa-keys button").forEach(function (b) { b.onclick = function () { if (b.dataset.k === "⌫") { code = code.slice(0, -1); paint(); } else add(b.dataset.k); }; });
          d.addEventListener("keydown", function (e) { if (/^\d$/.test(e.key)) add(e.key); else if (e.key === "Backspace") { code = code.slice(0, -1); paint(); } });
        } else {
          var pat = d.querySelector(".qa-pat"), pd = [].slice.call(pat.querySelectorAll(".qa-dot")), line = pat.querySelector("polyline"), seq = [], drawing = false;
          var centre = function (k) { var r = pd[k].getBoundingClientRect(), p = pat.getBoundingClientRect(); return [((r.left + r.width / 2 - p.left) / p.width) * 300, ((r.top + r.height / 2 - p.top) / p.height) * 300]; };
          var paintP = function (cursor) { pd.forEach(function (x, k) { x.classList.toggle("on", seq.indexOf(k) >= 0); }); line.setAttribute("points", seq.map(function (k) { return centre(k).join(","); }).concat(cursor ? [cursor.join(",")] : []).join(" ")); };
          var resetP = function () { seq = []; paintP(); };
          var hit = function (x, y) { var el = document.elementFromPoint(x, y), t = el && el.closest && el.closest(".qa-dot"); if (t && pat.contains(t)) { var k = +t.dataset.i; if (seq.indexOf(k) < 0) seq.push(k); } };
          var pos = function (e) { var p = pat.getBoundingClientRect(); return [((e.clientX - p.left) / p.width) * 300, ((e.clientY - p.top) / p.height) * 300]; };
          pat.addEventListener("pointerdown", function (e) { if (busy) return; e.preventDefault(); if (pat.setPointerCapture) pat.setPointerCapture(e.pointerId); drawing = true; seq = []; msg(""); hit(e.clientX, e.clientY); paintP(pos(e)); });
          pat.addEventListener("pointermove", function (e) { if (!drawing) return; hit(e.clientX, e.clientY); paintP(pos(e)); });
          var up = function () { if (!drawing) return; drawing = false; paintP(); if (seq.length < 4) { msg("Join at least 4 dots."); setTimeout(resetP, 500); return; } var v = "p:" + seq.join(""); setTimeout(function () { submit(v, resetP); }, 150); };
          pat.addEventListener("pointerup", up); pat.addEventListener("pointercancel", up);
        }
      });
    }
    // Ask for a new code twice. Resolves with the code, or null if they gave up.
    function newCode(kind) {
      return pad({ title: "Choose your " + kindName(kind).toLowerCase(), sub: "Draw or type it, then once more to confirm.", kind: kind, onCode: function (c1) {
        return Promise.resolve({ done: c1 });
      } }).then(function (first) {
        if (first === null) return null;
        return pad({ title: "Once more", sub: "Enter the same " + (kind === "pattern" ? "pattern" : "PIN") + " again.", kind: kind, onCode: function (c2) { return c2 === first ? { done: c2 } : { msg: "That did not match. Try again." }; } });
      });
    }
    function chooseKind(title, text) {
      var b = KINDS.map(function (k) { return '<button class="btn" type="button" data-k="' + k[0] + '">' + esc(k[1]) + "<small>" + esc(k[2]) + "</small></button>"; }).join("");
      return dialog("<h2>" + esc(title) + '</h2><p class="qa-sub">' + esc(text || "") + '</p><div class="qa-btns">' + b + "</div>", function (d, close) {
        d.querySelectorAll("[data-k]").forEach(function (x) { x.onclick = function () { close(x.dataset.k); }; });
      });
    }
    function status() { return cfg.request("GET", "api/account/quick/status").catch(function () { return { available: false, kind: null }; }); }
    function remember(r, kind) { put({ deviceId: r.deviceId, deviceSecret: r.deviceSecret, kind: r.kind || kind }); }

    // Turn Quick Access on for this device. If the person already has a code (set in the Portal or another app) it is offered first.
    function setup() {
      return status().then(function (st) {
        if (!st.available) { return dialog("<h2>Not available yet</h2><p class='qa-sub'>Quick Access needs this app to be linked to Portal Admin. Ask the admin.</p><div class='qa-btns'><button class='btn' type='button' data-k='ok'>OK</button></div>", function (d, c) { d.querySelector("[data-k]").onclick = function () { c(null); }; }).then(function () { return false; }); }
        var useOld = st.kind ? dialog("<h2>Use your " + esc(kindName(st.kind).toLowerCase()) + "?</h2><p class='qa-sub'>You already have one for your JoolzApp account. It will work on this device too.</p><div class='qa-btns'><button class='btn primary' type='button' data-k='old'>Use it on this device</button><button class='btn' type='button' data-k='new'>Choose a new one</button></div>", function (d, c) { d.querySelectorAll("[data-k]").forEach(function (b) { b.onclick = function () { c(b.dataset.k); }; }); }) : Promise.resolve("new");
        return useOld.then(function (pick) {
          if (pick === "old") return cfg.request("POST", "api/account/quick", { label: label() }).then(function (r) { remember(r, st.kind); return true; });
          if (pick !== "new") return false;
          return chooseKind("Quick Access", "Sign in with a PIN or pattern instead of your password on this device.").then(function (kind) {
            if (!kind) return false;
            return newCode(kind).then(function (code) { if (!code) return false; return cfg.request("POST", "api/account/quick", { kind: kind, code: code, label: label() }).then(function (r) { remember(r, kind); return true; }); });
          });
        });
      }).catch(function (e) { return dialog("<h2>Could not set it up</h2><p class='qa-sub'>" + esc(e.message) + "</p><div class='qa-btns'><button class='btn' type='button' data-k='ok'>OK</button></div>", function (d, c) { d.querySelector("[data-k]").onclick = function () { c(null); }; }).then(function () { return false; }); });
    }

    function signIn() {
      var q = get(); if (!q) return Promise.resolve(null);
      return pad({ title: "Welcome back", sub: "Enter your " + (q.kind === "pattern" ? "pattern" : "PIN") + " to open " + cfg.name, kind: q.kind, link: "Use my password instead", onCode: function (code) {
        return cfg.request("POST", "api/account/login", { quick: { deviceId: q.deviceId, deviceSecret: q.deviceSecret, code: code } }).then(function (j) { return { done: j }; }, function (e) {
          if (e.status === 423 || e.status === 401 && /did not work/i.test(e.message)) { put(null); return { done: { reset: e.message } }; }   // switched off (too many tries) or no longer known: use the password
          return { msg: e.message };
        });
      } }).then(function (r) { return r && r.token ? r : null; });
    }

    // First run: asked once per device, right after a password sign-in. "Not now" is remembered; Settings always has it.
    function offer() {
      try { if (get() || localStorage.getItem(NOPE)) return Promise.resolve(false); } catch (e) { return Promise.resolve(false); }
      return status().then(function (st) {
        if (!st.available) return false;
        return dialog("<h2>Sign in faster next time?</h2><p class='qa-p'>Use a PIN or pattern on this device instead of typing your password.</p><p class='qa-sub'>You can change this any time in Settings.</p><div class='qa-btns'><button class='btn primary' type='button' data-k='yes'>Set up a PIN or pattern</button><button class='btn' type='button' data-k='no'>Not now</button></div>", function (d, c) { d.querySelectorAll("[data-k]").forEach(function (b) { b.onclick = function () { c(b.dataset.k); }; }); })
          .then(function (a) { if (a === "yes") return setup(); try { if (a === "no") localStorage.setItem(NOPE, "1"); } catch (e) {} return false; });
      });
    }

    // Settings: shows whether it is on for this device and lets the person set up, change the code or turn it off here.
    function manage() {
      return status().then(function (st) {
        var q = get(), on = !!q;
        var body = on ? "<p class='qa-p'>Quick Access is <b>on</b> for this device (" + esc(kindName(q.kind).toLowerCase()) + ").</p><p class='qa-sub'>Your code is the same in every JoolzApp. Your password always works too.</p><div class='qa-btns'><button class='btn' type='button' data-k='change'>Change my PIN or pattern</button><button class='btn' type='button' data-k='off'>Turn off on this device</button></div>"
          : "<p class='qa-p'>Quick Access is <b>off</b> on this device.</p><p class='qa-sub'>" + (st.available ? "Sign in with a PIN or pattern instead of your password." : "It needs this app to be linked to Portal Admin first.") + "</p>" + (st.available ? "<div class='qa-btns'><button class='btn primary' type='button' data-k='on'>Set up a PIN or pattern</button></div>" : "");
        return dialog("<h2>Quick Access</h2>" + body, function (d, c) { d.querySelectorAll("[data-k]").forEach(function (b) { b.onclick = function () { c(b.dataset.k); }; }); }).then(function (a) {
          if (a === "on") return setup().then(function () { return manage(); });
          if (a === "change") return chooseKind("Change your code", "This changes it in every JoolzApp. If you pick a different type, your other devices switch back to the password.").then(function (kind) {
            if (!kind) return manage();
            return newCode(kind).then(function (code) { if (!code) return manage(); var old = get();
              return cfg.request("POST", "api/account/quick", { kind: kind, code: code, label: label() }).then(function (r) { remember(r, kind); if (old) cfg.request("DELETE", "api/account/quick/" + old.deviceId).catch(function () {}); }).then(function () { return manage(); }, function (e) { return dialog("<h2>Could not change it</h2><p class='qa-sub'>" + esc(e.message) + "</p><div class='qa-btns'><button class='btn' type='button' data-k='ok'>OK</button></div>", function (dd, cc) { dd.querySelector("[data-k]").onclick = function () { cc(null); }; }); }); });
          });
          if (a === "off") { var old = get(); put(null); try { localStorage.setItem(NOPE, "1"); } catch (e) {} return (old ? cfg.request("DELETE", "api/account/quick/" + old.deviceId).catch(function () {}) : Promise.resolve()).then(function () { return manage(); }); }
          return null;
        });
      });
    }
    return { has: function () { return !!get(); }, signIn: signIn, offer: offer, manage: manage };
  };
})();
