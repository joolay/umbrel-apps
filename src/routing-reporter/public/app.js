(function () {
  "use strict";
  var $ = function (s) { return document.querySelector(s); }, S = { report: null, config: {}, portal: {}, open: {}, clashes: [], official: {} };
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
  var COLS = [["lan", "LAN"], ["local", ".local"], ["tailscale", "Tailscale"], ["name", "Name"], ["public", "Public"]];
  // Icons instead of words: green tick = answering, red cross = down, amber arrow hitting a wall = checking / in conflict, grey dash = ignored.
  var IC = {
    up: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    down: '<svg viewBox="0 0 24 24"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg>',
    checking: '<svg viewBox="0 0 24 24"><path d="M3 12h9"/><path d="M9 8.5l3.5 3.5L9 15.5"/><path d="M18 5v14"/><path d="M15.2 9.5l-1.6 2.5 1.6 2.5"/></svg>',
    ign: '<svg viewBox="0 0 24 24"><path d="M6 12h12"/></svg>'
  }, TXT = { up: "Answering", down: "Down", checking: "Checking or in conflict", ign: "Ignored" };
  function ico(st) { return '<span class="ic ' + st + '" role="img" aria-label="' + TXT[st] + '" title="' + TXT[st] + '">' + IC[st] + "</span>"; }
  function cell(a, k) {
    var x = a.routes.filter(function (r) { return r.key === k; })[0];
    if (!x) return '<td class="na">–</td>';
    var st = x.ignored ? "ign" : x.state === "up" ? "up" : x.state === "down" ? "down" : "checking";
    return '<td title="' + esc(x.url) + '">' + ico(st) + "</td>";
  }
  // Details (address, speed, reason, Ignore) stay folded until the app's row is tapped.
  function detail(a, n) {
    var meta = (a.version ? "v" + a.version + " · " : "") + "port " + a.port + (a.published === "public" ? " · public" : a.published === "tailnet" ? " · tailnet only" : "");
    return '<tr class="det"><td colspan="' + n + '"><div class="meta muted small">' + esc(meta) + "</div>" + a.routes.map(function (x) {
      var st = x.ignored ? "ign" : x.state === "up" ? "up" : x.state === "down" ? "down" : "checking";
      var btn = x.ignored ? '<button class="lnk" data-i="0" data-a="' + esc(a.id) + '" data-r="' + x.key + '">Unignore</button>' : x.state === "down" ? '<button class="lnk" data-i="1" data-a="' + esc(a.id) + '" data-r="' + x.key + '">Ignore</button>' : "";
      return '<div class="dr">' + ico(st) + "<b>" + esc(x.label) + "</b><span class=\"u\">" + esc(x.url) + "</span><span class=\"small\">" + (x.state === "up" ? (x.ms || 0) + " ms" : x.state === "down" ? esc(x.error) + " · since " + esc(when(x.since)) : "Checking") + "</span>" + btn + "</div>";
    }).join("") + "</td></tr>";
  }
  // On a tablet or wider the list is split into two cards side by side (same columns in both), so it fills the screen instead of leaving big gaps.
  function wide() { return window.innerWidth >= 700; }
  function listHtml(apps) {
    if (!wide() || apps.length < 6) return tableHtml(apps, apps);
    var h = Math.ceil(apps.length / 2);
    return '<div class="pair">' + tableHtml(apps.slice(0, h), apps) + tableHtml(apps.slice(h), apps) + "</div>";
  }
  function tableHtml(apps, all) {
    var cols = COLS.filter(function (c) { return all.some(function (a) { return a.routes.some(function (r) { return r.key === c[0]; }); }); });
    return '<div class="card tw"><table><thead><tr><th>App</th>' + cols.map(function (c) { return "<th>" + c[1] + "</th>"; }).join("") + "</tr></thead><tbody>" +
      apps.map(function (a) {
        var open = !!S.open[a.id];
        return '<tr class="ar' + (open ? " open" : "") + '" data-id="' + esc(a.id) + '" tabindex="0" role="button" aria-expanded="' + open + '"><th scope="row"><b>' + esc(a.name || a.id) + "</b></th>" + cols.map(function (c) { return cell(a, c[0]); }).join("") + "</tr>" + (open ? detail(a, cols.length + 1) : "");
      }).join("") + "</tbody></table></div>";
  }
  function problems(r) { var out = []; r.apps.forEach(function (a) { var l = a.routes.filter(function (x) { return x.state === "down" && !x.ignored; }).map(function (x) { return x.label; }); if (l.length) out.push({ name: a.name || a.id, routes: l }); }); return out; }
  var SRC = { official: "official Umbrel app", other: "other store app", joolzapp: "JoolzApp app" };
  function who(p) { return "<b>" + esc(p.name) + "</b> <span class=\"muted\">(" + SRC[p.source] + (p.installed ? "" : ", not installed") + ")</span>"; }
  // Port clashes: the official app keeps the port, the other app is flagged for change with a free port to move to.
  function clashHtml() {
    var cl = S.clashes || [], o = S.official || {}, note = !o.count ? "The official Umbrel port list has not loaded yet" + (o.error ? " (" + esc(o.error) + ")" : "") + ", so only your installed apps are compared." : "Compared with " + o.count + " official Umbrel apps, installed or not (list fetched " + esc(when(o.at)) + ")" + (o.error ? "; the last refresh failed: " + esc(o.error) : "") + ".";
    if (!cl.length) return '<div class="card clash ok"><b>No port clashes</b><span class="muted small">' + note + "</span></div>";
    return '<div class="card clash bad"><b>' + cl.length + " port clash" + (cl.length === 1 ? "" : "es") + '</b><span class="muted small">' + note + "</span>" + cl.map(function (c) {
      return '<div class="cl"><span class="pt">Port ' + c.port + "</span><div>Keeps it: " + c.keep.map(who).join(", ") + "</div>" + c.change.map(function (p) {
        return '<div class="chg">Change: ' + who(p) + (p.kind === "published" ? " (a published port)" : "") + (p.suggestedPort ? " &rarr; free port <b>" + p.suggestedPort + "</b>" : "") + "</div>";
      }).join("") + "</div>";
    }).join("") + "</div>";
  }
  function render() {
    var r = S.report, c = S.config, down = 0, total = 0, ign = 0, pr = r ? problems(r) : [];
    if (r) r.apps.forEach(function (a) { a.routes.forEach(function (x) { total++; if (x.ignored) ign++; else if (x.state === "down") down++; }); });
    var pt = S.portal || {}, pl = !pt.linked ? "Not linked to Portal Admin yet" : pt.ok === false ? "Report to Portal Admin failed: " + pt.error : pt.ok ? "Reported to Portal Admin " + ago(pt.at) : "Waiting for the first report";
    $("#sum").innerHTML = r ? "<b>" + (down ? down + " route" + (down === 1 ? "" : "s") + " down" : "All routes up") + '</b><span class="muted small">' + total + " routes on " + r.apps.length + " apps" + (ign ? ", " + ign + " ignored" : "") + "</span><span class=\"muted small\">Checked " + esc(when(r.at)) + " (every " + r.intervalMin + " min)</span><span class=\"small\">" + esc(pl) + "</span>" + (pr.length ? '<div class="attn">Needs attention: ' + pr.map(function (p) { return "<b>" + esc(p.name) + "</b> (" + esc(p.routes.join(", ")) + ")"; }).join(" · ") + "</div>" : "") : "<b>Checking…</b>";
    var miss = []; if (!c.tailscaleIp) miss.push("your Tailscale address (100.x.y.z)"); if (!c.tailnet) miss.push("your tailnet name (…ts.net) for the Public and Tailscale name routes");
    $("#clash").innerHTML = r ? clashHtml() : "";
    $("#warn").hidden = !miss.length; $("#warn").innerHTML = miss.length ? "Add " + miss.join(" and ") + " in Settings to test those routes." : "";
    if (!r) { $("#list").innerHTML = ""; return; }
    var j = r.apps.filter(function (a) { return a.joolzapp; }), o = r.apps.filter(function (a) { return !a.joolzapp; });
    $("#list").innerHTML = (j.length ? '<div class="group"><h2>JoolzApp apps</h2>' + listHtml(j) + "</div>" : "") + (o.length ? '<div class="group"><h2>Other apps</h2>' + listHtml(o) + "</div>" : "");
    $("#list").querySelectorAll(".ar").forEach(function (tr) { var t = function () { S.open[tr.dataset.id] = !S.open[tr.dataset.id]; render(); }; tr.onclick = t; tr.onkeydown = function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); t(); } }; });
    $("#list").querySelectorAll(".lnk").forEach(function (b) { b.onclick = function () { call("POST", "api/ignore", { appId: b.dataset.a, route: b.dataset.r, ignore: b.dataset.i === "1" }).then(function (j) { take(j); render(); toast(b.dataset.i === "1" ? "Ignored" : "Back on"); }).catch(function (e) { toast(e.message); }); }; });
  }
  function take(j) { if (j.report) S.report = j.report; if (j.config) S.config = j.config; if (j.portal) S.portal = j.portal; if (j.clashes) S.clashes = j.clashes; if (j.official) S.official = j.official; }
  function load() { return call("GET", "api/state").then(function (j) { take(j); render(); }); }
  function runCheck() { var b = $("#check"); b.classList.add("spin"); return call("POST", "api/check").then(function (j) { take(j); render(); }).catch(function (e) { toast(e.message); }).then(function () { b.classList.remove("spin"); }); }
  $("#check").onclick = runCheck;
  $("#settings").onclick = function () {
    var d = $("#dlg"), c = S.config;
    d.innerHTML = "<h2>Settings</h2><form id='f'><label>LAN address of this Umbrel<input name='lanHost' value='" + esc(c.lanHost) + "' placeholder='192.168.1.50 or umbrel.local' required></label>" +
      "<label>.local name of this Umbrel (empty to skip)<input name='localHost' value='" + esc(c.localHost) + "' placeholder='umbrel.local'></label>" +
      "<label>Tailscale address of this Umbrel<input name='tailscaleIp' value='" + esc(c.tailscaleIp) + "' placeholder='100.x.y.z'></label>" +
      "<label>Your tailnet name<input name='tailnet' value='" + esc(c.tailnet) + "' placeholder='tail1234.ts.net'></label>" +
      "<label>Check every (minutes)<input name='intervalMin' type='number' min='1' max='60' value='" + esc(c.intervalMin) + "'></label><p class='err' id='e' role='alert'></p>" +
      "<div class='actions'><button type='button' class='btn' id='x'>Cancel</button><button class='btn primary'>Save and check</button></div></form>";
    d.showModal(); d.querySelector("#x").onclick = function () { d.close(); };
    d.querySelector("#f").onsubmit = function (ev) {
      ev.preventDefault(); var f = ev.target.elements;
      call("PUT", "api/config", { lanHost: f.lanHost.value, localHost: f.localHost.value, tailscaleIp: f.tailscaleIp.value, tailnet: f.tailnet.value, intervalMin: f.intervalMin.value }).then(function (j) { take(j); d.close(); render(); toast("Saved"); }).catch(function (e) { d.querySelector("#e").textContent = e.message; });
    };
  };
  var wasWide = wide(); window.addEventListener("resize", function () { if (wide() !== wasWide) { wasWide = wide(); render(); } });
  load().catch(function (e) { toast(e.message); }); setInterval(function () { load().catch(function () {}); }, 30000);
})();
