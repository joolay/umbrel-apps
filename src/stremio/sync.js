/* Stremio login sync (JoolzApp). Injected into Stremio Web by the sync layer.
   Stremio Web keeps the login in localStorage "profile" -> auth {key, user}. Browsers (especially iOS) clear that, and then you have to
   sign in again. This script saves the auth key on your JoolzApp account and puts it back when the browser forgets it.
   Everything is async with timeouts and wrapped in try/catch: if anything here fails, Stremio just carries on as normal. */
(function () {
  "use strict";
  if (window.__jzSync) return; window.__jzSync = 1;
  var PROFILE = "profile", SEEN = "jz_seen_auth", LAST = "jz_last_saved", HIDE = "jz_hide_until", TRIED = "jz_restore_tried";
  var DAY = 864e5, host, root, shadow;

  function get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function del(k) { try { localStorage.removeItem(k); } catch (e) {} }
  function profile() { try { return JSON.parse(get(PROFILE) || "null"); } catch (e) { return null; } }
  function authOf(p) { return p && p.auth && typeof p.auth.key === "string" && p.auth.key ? p.auth : null; }

  function api(path, opt) {
    var c = new AbortController(), t = setTimeout(function () { c.abort(); }, 4000);
    opt = opt || {}; opt.signal = c.signal; opt.credentials = "same-origin";
    if (opt.json !== undefined) { opt.method = opt.method || "POST"; opt.headers = { "content-type": "application/json" }; opt.body = JSON.stringify(opt.json); delete opt.json; }
    return fetch("/_jz/" + path, opt).then(function (r) {
      clearTimeout(t);
      return r.json().catch(function () { return {}; }).then(function (j) { return { status: r.status, ok: r.ok, j: j }; });
    }).catch(function () { clearTimeout(t); return null; });
  }

  /* ---------- tiny glass UI in a shadow root, so it can't touch Stremio's styles ---------- */
  var CSS = ':host{all:initial;--accent:#5b3fd1;--accent-2:#7b5bf5;--accent-t:#fff;--text:#1b2233;--muted:#6b7488;--glass:rgba(255,255,255,.78);--line:rgba(255,255,255,.65);--danger:#d64545;--ok:#1f9d63;font:15px/1.4 system-ui,-apple-system,sans-serif}' +
    '@media (prefers-color-scheme:dark){:host{--text:#e6eaf3;--muted:#8d97ad;--glass:rgba(32,39,58,.78);--line:rgba(255,255,255,.12)}}' +
    '.w{position:fixed;right:max(14px,env(safe-area-inset-right));bottom:max(14px,env(safe-area-inset-bottom));z-index:2147483000;color:var(--text);display:flex;flex-direction:column;align-items:flex-end;gap:10px}' +
    '.card,.chip,.toast{background:var(--glass);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);border:1px solid var(--line);box-shadow:0 8px 30px rgba(0,0,0,.28);border-radius:18px}' +
    '.chip{display:flex;align-items:center;gap:8px;padding:9px 14px;border-radius:99px;cursor:pointer;font-weight:600;font-size:14px;color:var(--text)}' +
    '.dot{width:9px;height:9px;border-radius:50%;background:linear-gradient(135deg,var(--accent),var(--accent-2))}' +
    '.card{width:min(320px,calc(100vw - 28px));padding:18px}h3{margin:0 0 4px;font-size:17px}p{margin:0 0 12px;color:var(--muted);font-size:14px}' +
    'input{box-sizing:border-box;width:100%;padding:12px;margin:0 0 10px;border-radius:12px;border:1px solid var(--line);background:rgba(127,127,127,.12);color:var(--text);font:inherit;font-size:16px}' +
    'button{font:inherit;border:0;cursor:pointer}.go{width:100%;padding:12px;border-radius:99px;background:linear-gradient(135deg,var(--accent),var(--accent-2));color:var(--accent-t);font-weight:600}' +
    '.later{background:none;color:var(--muted);width:100%;padding:10px 0 0;font-size:14px}.err{color:var(--danger);font-size:14px;min-height:18px;margin:0 0 6px}' +
    '.toast{padding:10px 14px;border-radius:14px;font-size:14px;color:var(--text)}';
  function ui() {
    if (shadow) return shadow;
    host = document.createElement("div"); document.body.appendChild(host);
    shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = "<style>" + CSS + "</style><div class='w'></div>";
    root = shadow.querySelector(".w"); return shadow;
  }
  function clear() { if (root) root.innerHTML = ""; }
  function toast(msg) {
    try { ui(); var t = document.createElement("div"); t.className = "toast"; t.textContent = msg; root.appendChild(t); setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 4500); } catch (e) {}
  }
  function chip() {
    var until = +get(HIDE) || 0; if (Date.now() < until) return;
    ui(); clear();
    var c = document.createElement("div"); c.className = "chip"; c.innerHTML = "<span class='dot'></span>Keep my Stremio login";
    c.onclick = panel; root.appendChild(c);
  }
  function panel() {
    ui(); clear();
    var d = document.createElement("div"); d.className = "card";
    d.innerHTML = "<h3>Keep your Stremio login</h3><p>Sign in with your JoolzApp account and Stremio will remember you, even if this browser forgets.</p>" +
      "<div class='err'></div><input type='email' placeholder='Email' autocomplete='username'><input type='password' placeholder='Password' autocomplete='current-password'>" +
      "<button class='go'>Sign in</button><button class='later'>Not now</button>";
    var err = d.querySelector(".err"), em = d.querySelectorAll("input")[0], pw = d.querySelectorAll("input")[1];
    function submit() {
      err.textContent = "";
      api("login", { json: { email: em.value, password: pw.value } }).then(function (r) {
        if (r && r.ok) { clear(); start(true); }
        else err.textContent = (r && r.j && r.j.message) || "Couldn't sign in. Try again.";
      });
    }
    d.querySelector(".go").onclick = submit; pw.onkeydown = function (e) { if (e.key === "Enter") submit(); };
    d.querySelector(".later").onclick = function () { set(HIDE, String(Date.now() + 7 * DAY)); clear(); };
    root.appendChild(d);
  }

  /* ---------- the sync itself ---------- */
  function save(a, quiet) {
    if (get(LAST) === a.key) return;
    api("auth", { method: "PUT", json: { auth: { key: a.key, user: a.user || null } } }).then(function (r) {
      if (r && r.ok) { var first = !get(LAST); set(LAST, a.key); if (!quiet && first) toast("Stremio login saved to your JoolzApp account"); }
    });
  }
  function check() {   // runs on load and every 20 s: keep the saved copy in step with this browser
    var a = authOf(profile());
    if (a) { set(SEEN, "1"); save(a); return; }
    if (get(SEEN)) {   // this browser had a login and now it's gone because you signed out in Stremio: forget the saved copy too
      api("auth", { method: "PUT", json: { auth: null } }).then(function (r) { if (r && r.ok) { del(SEEN); del(LAST); } });
    }
  }
  var restoring = false, listening = false;
  function restore() {   // fresh browser or cleared data: wait for Stremio to create its blank profile, put the saved login in it, reload once
    try { if (sessionStorage.getItem(TRIED)) return; } catch (e) {}
    if (restoring) return; restoring = true;
    api("auth").then(function (r) {
      var saved = r && r.ok && r.j && r.j.auth; if (!saved || !saved.key) { restoring = false; return; }
      var n = 0, t = setInterval(function () {
        n++; var p = profile();
        if (authOf(p)) { clearInterval(t); restoring = false; return; }   // you signed in yourself meanwhile
        if (p && typeof p === "object") {
          clearInterval(t); p.auth = saved; set(PROFILE, JSON.stringify(p)); set(SEEN, "1"); set(LAST, saved.key);
          try { sessionStorage.setItem(TRIED, "1"); sessionStorage.setItem("jz_toast", "1"); } catch (e) {}
          location.reload();
        } else if (n > 40) { clearInterval(t); restoring = false; }
      }, 500);
    });
  }

  var timer, tries = 0;
  function start(justSignedIn) {
    api("state").then(function (r) {
      if (!r || !r.j || !r.j.enabled || !r.j.store) { if (++tries < 30) setTimeout(start, 60000); return; }   // sync off or PocketBase busy: Stremio is untouched, look again later
      if (!r.j.signedIn) { chip(); return; }
      try { if (sessionStorage.getItem("jz_toast")) { sessionStorage.removeItem("jz_toast"); toast("Stremio login restored from your JoolzApp account"); } } catch (e) {}
      if (justSignedIn) toast("Signed in to JoolzApp");
      if (authOf(profile()) || get(SEEN)) check(); else restore();
      if (!timer) timer = setInterval(function () { if (authOf(profile()) || get(SEEN)) check(); else restore(); }, 20000);
      if (!listening) { listening = true; document.addEventListener("visibilitychange", function () { if (document.visibilityState === "hidden") check(); }); }
    });
  }

  function boot() { try { start(); } catch (e) {} }
  if (document.body) boot(); else document.addEventListener("DOMContentLoaded", boot);
})();
