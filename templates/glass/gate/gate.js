// JoolzApp gate v1.0: the ONE login + welcome screen for every JoolzApp app. Needs glass.css + gate.css (and pwtoggle.js for the Show/Hide password button).
// quick-ui.js is optional: when it is loaded the gate also offers PIN / pattern sign-in on devices that have it set up.
//   JZGate({
//     app: "project-tracker",              // the app slug (used for sign-up return and Quick Access)
//     name: "Project Pilot",               // shown as the title
//     tokenKey: "gd.token",                // localStorage/sessionStorage key the app's index.html reads (ShutterWorth: "sw.token")
//     tokenHeader: "x-gd-token",           // request header the app's server reads (ShutterWorth: "x-sw-token")
//     clear: ["gd_prefs"],                 // local keys to remove on sign out
//     tagline: "Track every project",      // one line under the title on the welcome slides (optional)
//     welcome: [ { icon: "account", title: "...", text: "..." } ] | false   // first-run slides; default = three generic slides; false = none
//   });
// Server contract (already served by every JoolzApp app): GET api/app-config, GET api/account/me, POST api/account/login|logout|forgot.
(function () {
  "use strict";
  var ICONS = {
    account: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1.2-4 4.4-6 8-6s6.8 2 8 6"/>',
    apps: '<rect x="3.5" y="3.5" width="7" height="7" rx="2"/><rect x="13.5" y="3.5" width="7" height="7" rx="2"/><rect x="3.5" y="13.5" width="7" height="7" rx="2"/><rect x="13.5" y="13.5" width="7" height="7" rx="2"/>',
    lock: '<rect x="5" y="10.5" width="14" height="10" rx="3"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/><circle cx="12" cy="15.5" r="1.2"/>',
    install: '<path d="M12 4v11"/><path d="m7.5 10.5 4.5 4.5 4.5-4.5"/><path d="M5 19.5h14"/>',
    spark: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/>'
  };
  window.JZGate = function (o) {
    var TOKEN = o.tokenKey || "gd.token", HEAD = o.tokenHeader || "x-gd-token", NAME = o.name || "JoolzApp", ACCT = o.account || "JoolzApp";   // o.account: another network (JoolzApp Biz) names its own accounts
    var cfg = {}, view = document.getElementById("view"), sub = document.getElementById("sub"), card = document.getElementById("card");
    document.body.classList.add("jz-gate");
    function tok() { try { return sessionStorage.getItem(TOKEN) || localStorage.getItem(TOKEN) || ""; } catch (e) { return ""; } }
    function setTok(t, remember) { try { localStorage.removeItem(TOKEN); sessionStorage.removeItem(TOKEN); if (t) (remember ? localStorage : sessionStorage).setItem(TOKEN, t); } catch (e) {} }
    function api(path, opts) {
      opts = opts || {}; var h = { "content-type": "application/json" }; if (tok()) h[HEAD] = tok();
      return fetch(path, { method: opts.method || "GET", headers: h, body: opts.body, cache: "no-store" }).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) { var e = new Error(j.message || "Something went wrong (" + r.status + ")"); e.status = r.status; throw e; } return j; });
      });
    }
    function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text) n.textContent = text; return n; }
    function field(label, type, auto) { var l = el("label", "", label), i = el("input"); i.type = type; i.autocomplete = auto; l.appendChild(i); return { l: l, i: i }; }
    function heading(show) { var h = card.querySelector(".jz-logo"), t = card.querySelector("h1"); if (h) h.hidden = !show; if (t) t.hidden = !show; }
    var QA = null;
    if (window.JZQuick) QA = JZQuick({ app: o.app, name: NAME, request: function (m, p, b) { return api(p, { method: m, body: b === undefined ? undefined : JSON.stringify(b) }); } });
    function open(u) { if (u.canOpen) location.reload(); else waiting(u); }

    // ---- Welcome slides: once per device, before the first sign-in ----
    var SEEN = "jz.welcome." + o.app;
    function seenWelcome() { try { return localStorage.getItem(SEEN) === "1"; } catch (e) { return true; } }
    function slidesFor() {
      if (o.welcome === false) return [];
      if (o.welcome && o.welcome.length) return o.welcome;
      return [
        { icon: "spark", title: "Welcome to " + NAME, text: o.tagline || "Part of your JoolzApp family of apps." },
        { icon: "account", title: "One account, every app", text: "Your " + ACCT + " account signs you in to all of your apps here. Your settings follow you." },
        { icon: "lock", title: "Quick and private", text: "After your first sign-in you can switch to a PIN or pattern on this device." }
      ];
    }
    function welcome(next) {
      var s = slidesFor(); if (!s.length || seenWelcome()) return next();
      view.textContent = ""; heading(false); sub.hidden = true;
      var box = el("div", "jz-slides"), track = el("div", "jz-track"), dots = el("div", "jz-dots"), i = 0, startX = null;
      s.forEach(function (sl, k) {
        var d = el("div", "jz-slide"), ic = el("div", "jz-ic"); ic.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' + (ICONS[sl.icon] || ICONS.spark) + "</svg>";
        d.append(ic, el("h2", "", sl.title), el("p", "", sl.text)); track.appendChild(d); dots.appendChild(el("i", k ? "" : "on"));
      });
      box.appendChild(track);
      var go = el("button", "jz-go", "Next"), skip = el("button", "jz-alt", "Skip"); go.type = skip.type = "button";
      function show() { track.style.transform = "translateX(" + (-100 * i) + "%)"; [].forEach.call(dots.children, function (x, k) { x.className = k === i ? "on" : ""; }); go.textContent = i === s.length - 1 ? "Get started" : "Next"; }
      function done() { try { localStorage.setItem(SEEN, "1"); } catch (e) {} sub.hidden = false; heading(true); next(); }
      go.onclick = function () { if (i < s.length - 1) { i++; show(); } else done(); }; skip.onclick = done;
      box.addEventListener("touchstart", function (e) { startX = e.touches[0].clientX; }, { passive: true });
      box.addEventListener("touchend", function (e) { if (startX === null) return; var dx = e.changedTouches[0].clientX - startX; startX = null; if (dx < -40 && i < s.length - 1) { i++; show(); } else if (dx > 40 && i > 0) { i--; show(); } });
      view.append(box, dots, go, skip);
    }

    // ---- Sign in ----
    function quickFirst() { QA.signIn().then(function (j) { if (j) { setTok(j.token, true); open(j.user); } else form(); }); }
    function form() {
      view.textContent = ""; heading(true); sub.hidden = false; sub.textContent = "Sign in with your " + ACCT + " account";
      var f = el("form", "jz-form"), email = field("Email", "email", "email"), pass = field("Password", "password", "current-password");
      email.i.required = true; pass.i.required = true; f.append(email.l, pass.l);
      var opts = el("div", "jz-opts"), rl = el("label", "inline"), remember = el("input"), forgot = el("a", "", "Forgot password?"), ok = el("p", "jz-ok"), err = el("p", "jz-err");
      remember.type = "checkbox"; forgot.href = "#"; err.setAttribute("role", "alert");
      // Remember me is ON unless the person unticked it on purpose ("0"): an installed app (PWA) loses a session-only sign-in every time it is closed.
      try { remember.checked = localStorage.getItem("gd.remember") !== "0"; if (remember.checked) email.i.value = localStorage.getItem("gd.email") || ""; } catch (e) { remember.checked = true; }
      rl.append(remember, document.createTextNode(" Remember me")); opts.append(rl, forgot); f.appendChild(opts);
      forgot.onclick = function (ev) {
        ev.preventDefault(); err.textContent = ""; ok.textContent = "";
        if (!email.i.value.trim()) { err.textContent = "Enter your email above first."; email.i.focus(); return; }
        api("api/account/forgot", { method: "POST", body: JSON.stringify({ email: email.i.value.trim() }) }).then(function (j) { ok.textContent = j.message; }).catch(function (e) { err.textContent = e.message; });
      };
      var go = el("button", "jz-go", "Sign in"); go.type = "submit"; f.append(err, ok, go);
      f.onsubmit = function (ev) {
        ev.preventDefault(); err.textContent = ""; go.disabled = true;
        api("api/account/login", { method: "POST", body: JSON.stringify({ email: email.i.value, password: pass.i.value, remember: remember.checked }) })
          .then(function (j) {
            setTok(j.token, remember.checked);
            try { if (remember.checked) { localStorage.setItem("gd.remember", "1"); localStorage.setItem("gd.email", email.i.value); } else { localStorage.setItem("gd.remember", "0"); localStorage.removeItem("gd.email"); } } catch (e) {}
            open(j.user);
          }).catch(function (e) { err.textContent = e.message; go.disabled = false; });
      };
      view.appendChild(f);
      // "Continue with Google": Google only knows the dashboard's public https address, so the dashboard does the Google step and hands the
      // person back to this app (its sso.html), which keeps the sign-in on this device. Hidden on LAN / Tailscale (http) addresses.
      if (cfg.portalUrl && location.protocol === "https:" && cfg.google !== false) {
        var gb = el("button", "jz-alt jz-google", "Continue with Google"); gb.type = "button";
        gb.onclick = function () { location.href = cfg.portalUrl.replace(/\/+$/, "") + "/?google=1&next=" + encodeURIComponent(location.origin + location.pathname.replace(/[^\/]*$/, "")); };
        view.appendChild(gb);
      }
      if (QA && QA.has()) { var qb = el("button", "jz-alt", "Use my PIN or pattern"); qb.type = "button"; qb.onclick = quickFirst; view.appendChild(qb); }
      if (cfg.signups !== false) {
        // One JoolzApp sign-up page, in Portal Admin. It sends the person back here when the account is made.
        var alt = el("button", "jz-alt", "Create a " + ACCT + " account"); alt.type = "button";
        alt.onclick = function () { if (cfg.portalUrl) location.href = cfg.portalUrl.replace(/\/+$/, "") + "/?signup=1&app=" + encodeURIComponent(o.app); else err.textContent = "Sign-up lives in Portal Admin, but its address isn't set yet. Ask the admin."; };
        view.appendChild(alt);
      }
    }

    // ---- Signed in, but not opened to this person yet ----
    function waiting(u) {
      view.textContent = ""; heading(true); sub.hidden = false; sub.textContent = "Almost there";
      view.appendChild(el("p", "jz-note", "You're signed in as " + (u.name || u.email) + ". " + ((u.gate && u.gate.message) || "The admin hasn't opened " + NAME + " to you yet. Ask them to give you access, then check again.")));
      var row = el("div", "jz-row"), again = el("button", "", "Check again"), out = el("button", "", "Sign out");
      again.onclick = start; out.onclick = signOut; row.append(again, out); view.appendChild(row);
      if (u.gate && u.gate.reason === "guardian_pending") {
        // Parents are approved, added or changed in Portal Admin (the one place for account settings).
        var dash = el("button", "jz-alt", "Open the JoolzApp dashboard (add a parent, see who has been asked)"); dash.type = "button";
        dash.onclick = function () { if (cfg.portalUrl) location.href = cfg.portalUrl.replace(/\/+$/, "") + "/" + (tok() ? "#sso=" + encodeURIComponent(tok()) : ""); };
        view.appendChild(dash);
      }
    }
    function signOut() { setTok("", false); try { (o.clear || ["gd_prefs"]).forEach(function (k) { localStorage.removeItem(k); }); } catch (e) {} fetch("api/account/logout", { method: "POST" }).catch(function () {}).then(function () { location.reload(); }); }
    function problem(msg) {
      view.textContent = ""; heading(true); sub.hidden = false; sub.textContent = "Can't reach the account server";
      view.appendChild(el("p", "jz-note", msg));
      var row = el("div", "jz-row"), b = el("button", "", "Try again"); b.onclick = start; row.appendChild(b); view.appendChild(row);
    }
    function start() {
      api("api/app-config").then(function (c) { cfg = c; }).catch(function () {})
        .then(function () { return api("api/account/me"); })
        .then(function (j) { open(j.user); })
        .catch(function (e) {
          if (e.status === 401 || e.status === 404) { setTok(""); welcome(function () { if (QA && QA.has()) quickFirst(); else form(); }); }
          else problem(e.message);
        });
    }
    start();
  };
})();
