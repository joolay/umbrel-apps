(function () {
  "use strict";
  var $ = function (s) { return document.querySelector(s); }, S = { report: null, config: {}, portal: {} };
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function p2(n) { return n < 10 ? "0" + n : "" + n; }
  // Dates follow the South African default: DD/MM/YYYY and 24 hour time.
  function when(t) { if (!t) return ""; var d = new Date(t); return p2(d.getDate()) + "/" + p2(d.getMonth() + 1) + "/" + d.getFullYear() + " " + p2(d.getHours()) + ":" + p2(d.getMinutes()); }
  function ago(t) { var s = Math.max(0, Math.round((Date.now() - t) / 1000)); return s < 90 ? "just now" : s < 5400 ? Math.round(s / 60) + " min ago" : s < 172800 ? Math.round(s / 3600) + " h ago" : Math.round(s / 86400) + " days ago"; }
  function toast(m) { var t = $("#toast"); t.textContent = m; t.hidden = false; clearTimeout(toast.h); toast.h = setTimeout(function () { t.hidden = true; }, 3500); }
  function call(method, path, body) {
    return fetch(path, { method: method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined, cache: "no-store" }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.message || "Something went wrong (" + r.status + ")"); return j; });
    });
  }
  function rtHtml(x) {
    var st = x.state === "up" ? "up" : x.state === "down" ? "down" : "checking";
    var label = st === "up" ? "OK " + (x.ms || 0) + " ms" : st === "down" ? "DOWN" : "Checking";
    return '<div class="rt ' + st + '"><div class="h"><span>' + esc(x.label) + '</span><span class="chip ' + st + '">' + label + '</span></div><div class="u">' + esc(x.url) + "</div>" +
      (st === "down" ? '<div class="e">' + esc(x.error) + " · since " + esc(when(x.since)) + "</div>" : st === "checking" ? '<div class="e muted">' + esc(x.error) + "</div>" : "") + "</div>";
  }
  function appHtml(a) {
    return '<div class="card app"><div class="t"><b>' + esc(a.name || a.id) + '</b><span class="muted small">' + esc(a.version ? "v" + a.version + " · " : "") + "port " + a.port + (a.published === "public" ? " · public" : a.published === "tailnet" ? " · tailnet only" : "") + '</span></div><div class="rts">' + a.routes.map(rtHtml).join("") + "</div></div>";
  }
  function render() {
    var r = S.report, c = S.config, down = 0, total = 0;
    if (r) r.apps.forEach(function (a) { a.routes.forEach(function (x) { total++; if (x.state === "down") down++; }); });
    var pt = S.portal || {}, pl = !pt.linked ? "Not linked to Portal Admin yet" : pt.ok === false ? "Report to Portal Admin failed: " + pt.error : pt.ok ? "Reported to Portal Admin " + ago(pt.at) : "Waiting for the first report";
    $("#sum").innerHTML = r ? "<b>" + (down ? down + " route" + (down === 1 ? "" : "s") + " down" : "All routes up") + '</b><span class="muted small">' + total + " routes on " + r.apps.length + " apps</span><span class=\"muted small\">Checked " + esc(when(r.at)) + " (every " + r.intervalMin + " min)</span><span class=\"small\">" + esc(pl) + "</span>" : "<b>Checking…</b>";
    var miss = []; if (!c.tailscaleIp) miss.push("your Tailscale address (100.x.y.z)"); if (!c.tailnet) miss.push("your tailnet name (…ts.net) for the Public and Tailscale name routes");
    $("#warn").hidden = !miss.length; $("#warn").innerHTML = miss.length ? "Add " + miss.join(" and ") + " in Settings to test those routes." : "";
    if (!r) { $("#list").innerHTML = ""; return; }
    var j = r.apps.filter(function (a) { return a.joolzapp; }), o = r.apps.filter(function (a) { return !a.joolzapp; });
    $("#list").innerHTML = (j.length ? '<div class="group"><h2>JoolzApp apps</h2>' + j.map(appHtml).join("") + "</div>" : "") + (o.length ? '<div class="group"><h2>Other apps</h2>' + o.map(appHtml).join("") + "</div>" : "");
  }
  function load() { return call("GET", "api/state").then(function (j) { S.report = j.report; S.config = j.config; S.portal = j.portal; render(); }); }
  function runCheck() { var b = $("#check"); b.classList.add("spin"); return call("POST", "api/check").then(function (j) { S.report = j.report; S.portal = j.portal; render(); }).catch(function (e) { toast(e.message); }).then(function () { b.classList.remove("spin"); }); }
  $("#check").onclick = runCheck;
  $("#settings").onclick = function () {
    var d = $("#dlg"), c = S.config;
    d.innerHTML = "<h2>Settings</h2><form id='f'><label>LAN address of this Umbrel<input name='lanHost' value='" + esc(c.lanHost) + "' placeholder='192.168.1.50 or umbrel.local' required></label>" +
      "<label>Tailscale address of this Umbrel<input name='tailscaleIp' value='" + esc(c.tailscaleIp) + "' placeholder='100.x.y.z'></label>" +
      "<label>Your tailnet name<input name='tailnet' value='" + esc(c.tailnet) + "' placeholder='tail1234.ts.net'></label>" +
      "<label>Check every (minutes)<input name='intervalMin' type='number' min='1' max='60' value='" + esc(c.intervalMin) + "'></label><p class='err' id='e' role='alert'></p>" +
      "<div class='actions'><button type='button' class='btn' id='x'>Cancel</button><button class='btn primary'>Save and check</button></div></form>";
    d.showModal(); d.querySelector("#x").onclick = function () { d.close(); };
    d.querySelector("#f").onsubmit = function (ev) {
      ev.preventDefault(); var f = ev.target.elements;
      call("PUT", "api/config", { lanHost: f.lanHost.value, tailscaleIp: f.tailscaleIp.value, tailnet: f.tailnet.value, intervalMin: f.intervalMin.value }).then(function (j) { S.config = j.config; S.report = j.report; S.portal = j.portal; d.close(); render(); toast("Saved"); }).catch(function (e) { d.querySelector("#e").textContent = e.message; });
    };
  };
  load().catch(function (e) { toast(e.message); }); setInterval(function () { load().catch(function () {}); }, 30000);
})();
