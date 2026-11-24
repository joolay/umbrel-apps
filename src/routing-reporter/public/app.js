(function () {
  "use strict";
  var $ = function (s) { return document.querySelector(s); }, S = { tab: lsGet("pm.tab", "all"), sort: lsGet("pm.sort", "name"), report: null, config: {}, portal: {}, open: {}, clashes: [], official: {}, tsd: null };
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function lsGet(k, d) { try { return localStorage.getItem(k) || d; } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
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
  // Every column is always shown (for JoolzApp apps and other apps alike); a dash means the app has no such route (for Name and Public: it is not published through TSDProxy).
  var COLS = [["lan", "LAN"], ["local", ".local"], ["tailscale", "Tailscale"], ["name", "Name"], ["public", "Public"]];
  var PORTAL = '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="6.5" height="6.5" rx="1.6"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.6"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.6"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.6"/></svg>';
  var PLUS = '<svg viewBox="0 0 24 24"><path d="M12 6v12M6 12h12"/></svg>';
  // Portal column: auto = a JoolzApp app (shown by itself), locked = owner-only tool (Admin folder), on / off = any other app: tap to add its tile to the JoolzApp Store or hide it.
  // Login column: a JoolzApp app is protected by the JoolzApp account (its gate); any other app keeps its own login, or none.
  var SHIELD = '<svg viewBox="0 0 24 24"><path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.500-7-10V6z"/></svg>';
  function loginCell(a) {
    return a.joolzapp ? '<td title="Protected by the JoolzApp account (sign-in gate)"><span class="ic portal" role="img" aria-label="Protected by JoolzApp login">' + SHIELD + "</span></td>" : '<td class="na" title="Not protected by the JoolzApp account: this app keeps its own login, or has none">–</td>';
  }
  function portalCell(a) {
    var p = a.portal || { state: a.onPortal ? "auto" : "locked" };
    if (p.state === "auto") return '<td title="Shown as a tile on the JoolzApp Store home screen (a JoolzApp app)"><span class="ic portal" role="img" aria-label="On the portal">' + PORTAL + "</span></td>";
    if (p.state === "locked") return '<td class="na" title="Owner-only JoolzApp tool: lives in the Admin folder, not a tile">–</td>';
    var on = p.state === "on";
    return '<td class="pg" data-a="' + esc(a.id) + '" data-on="' + (on ? "1" : "0") + '" tabindex="0" role="switch" aria-checked="' + on + '" title="' + (on ? (p.audience === "admins" ? "On the portal, Admin: only admins can see the tile" : "On the portal for everyone with a JoolzApp account") + ", tap to hide the tile" : "Not on the JoolzApp Store, tap to add it") + '"><span class="ic ' + (on ? "portal" : "ign add") + '" role="img" aria-label="' + (on ? "On the portal" : "Not on the portal") + '">' + (on ? PORTAL : PLUS) + "</span>" + (on && p.audience === "admins" ? '<small class="adm">Admin</small>' : "") + "</td>";
  }
  // Icons instead of words: green tick = answering, red cross = down, amber arrow hitting a wall = checking / in conflict, grey dash = ignored.
  var IC = {
    up: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    down: '<svg viewBox="0 0 24 24"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg>',
    checking: '<svg viewBox="0 0 24 24"><path d="M3 12h9"/><path d="M9 8.5l3.5 3.5L9 15.5"/><path d="M18 5v14"/><path d="M15.2 9.5l-1.6 2.5 1.6 2.5"/></svg>',
    ign: '<svg viewBox="0 0 24 24"><path d="M6 12h12"/></svg>'
  }, TXT = { up: "Answering", down: "Down", checking: "Checking or in conflict", ign: "Disabled" };
  function ico(st) { return '<span class="ic ' + st + '" role="img" aria-label="' + TXT[st] + '" title="' + TXT[st] + '">' + IC[st] + "</span>"; }
  // What a tick's tooltip says: a Public/Tailscale-name tick pauses the TSDProxy proxy, the others only stop being counted.
  function swTip(x) {
    if (x.switch === "proxy") return x.control === "paused" ? "paused in TSDProxy, tap to resume" : x.control === "pending" ? "pause asked, waiting for TSDProxy (up to 15 s), tap to cancel" : x.control === "waiting" ? "switched off here, but TSDProxy control is not reachable yet, tap to cancel" : x.control === "resuming" ? "resume asked, waiting for TSDProxy" : "on, tap to pause in TSDProxy";
    return x.ignored ? "disabled here (not counted as a problem), tap to enable" : "on, tap to disable here (it is still reachable, only not counted)";
  }
  function cell(a, k) {
    var x = a.routes.filter(function (r) { return r.key === k; })[0];
    if (!x) return '<td class="na" title="' + (k === "name" || k === "public" ? "Not published through TSDProxy" : "No such route") + '">–</td>';
    var st = x.ignored ? "ign" : x.state === "up" ? "up" : x.state === "down" ? "down" : "checking";
    // Tap a tick to disable this route (grey dash, never counted as a problem); tap again to enable it.
    return '<td class="tg" data-a="' + esc(a.id) + '" data-r="' + k + '" data-i="' + (x.ignored ? "0" : "1") + '" tabindex="0" role="switch" aria-checked="' + !x.ignored + '" title="' + esc(x.url) + " - " + swTip(x) + '">' + ico(st) + (x.control === "pending" || x.control === "waiting" || x.control === "resuming" ? '<i class="wait" aria-hidden="true"></i>' : "") + "</td>";
  }
  // Details (address, speed, reason, Ignore) stay folded until the app's row is tapped.
  function detail(a, n) {
    var meta = (a.version ? "v" + a.version + " · " : "") + "port " + a.port + (a.hostPorts && a.hostPorts.length ? " · also publishes " + a.hostPorts.join(", ") : "") + (a.published === "public" ? " · public" : a.published === "tailnet" ? " · tailnet only" : " · not published through TSDProxy") + (a.onPortal ? " · tile on the JoolzApp Store" : a.joolzapp ? " · hidden from the JoolzApp Store (owner-only)" : "");
    return '<tr class="det"><td colspan="' + n + '"><div class="meta muted small">' + esc(meta) + "</div>" + a.routes.map(function (x) {
      var st = x.ignored ? "ign" : x.state === "up" ? "up" : x.state === "down" ? "down" : "checking";
      var btn = x.ignored ? '<button class="lnk" data-i="0" data-a="' + esc(a.id) + '" data-r="' + x.key + '">Enable</button>' : x.state === "down" ? '<button class="lnk" data-i="1" data-a="' + esc(a.id) + '" data-r="' + x.key + '">Disable</button>' : "";
      var open = x.openUrl ? '<a class="lnk op" target="_blank" rel="noopener" href="' + esc(x.openUrl) + '">Open</a>' : "";
      var fix = x.state === "down" && !x.ignored ? '<button class="lnk fx" data-a="' + esc(a.id) + '" data-r="' + x.key + '">Fix</button>' : "";
      var help = S.fix === a.id + "|" + x.key && x.fix ? '<div class="fixbox"><b>How to fix ' + esc(x.label) + "</b><ol>" + x.fix.map(function (t) { return "<li>" + esc(t) + "</li>"; }).join("") + '</ol><button class="btn primary rc" data-a="' + esc(a.id) + '" data-r="' + x.key + '">Recheck now</button></div>' : "";
      return '<div class="dr">' + ico(st) + "<b>" + esc(x.label) + "</b><span class=\"u\">" + esc(x.url) + "</span><span class=\"small\">" + (x.state === "up" ? (x.ms || 0) + " ms" : x.state === "down" ? esc(x.error) + " · since " + esc(when(x.since)) : "Checking") + "</span>" + open + fix + btn + "</div>" + help;
    }).join("") + "</td></tr>";
  }
  // One list per group, full width (no side-by-side grid).
  function listHtml(apps) { return tableHtml(apps); }
  function tableHtml(apps) {
    return '<div class="card tw"><table><thead><tr><th class="app">App</th><th class="pt">Port</th><th class="pc">Portal</th><th class="pc">Login</th>' + COLS.map(function (c) { return "<th>" + c[1] + "</th>"; }).join("") + "</tr></thead><tbody>" +
      apps.map(function (a) {
        var open = !!S.open[a.id];
        return '<tr class="ar' + (open ? " open" : "") + '" data-id="' + esc(a.id) + '" tabindex="0" role="button" aria-expanded="' + open + '"><th scope="row" class="app"><b>' + esc(a.name || a.id) + '</b></th><td class="pt mono">' + esc(a.port) + "</td>" + portalCell(a) + loginCell(a) + COLS.map(function (c) { return cell(a, c[0]); }).join("") + "</tr>" + (open ? detail(a, COLS.length + 4) : "");
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
  /* ---------- TSDProxy tab ---------- */
  function tsdHtml() {
    var t = S.tsd || {}, st = t.status, r = S.report, ap = {};
    if (r) r.apps.forEach(function (a) { if (a.tsdName) ap[a.tsdName] = a.name || a.id; });
    var api = st && st.api || {}, c = st && st.container || {}, up = st && st.update || {}, mine = {}; (t.paused || []).forEach(function (n) { mine[n] = 1; });
    var ver = api.version || c.version || "", ctl = !st ? ["ign", "No report from Services Manager yet. Update Services Manager to 1.3.0 or newer; it looks after TSDProxy."] : !t.fresh ? ["down", "Services Manager has not reported for over 90 seconds."] : api.reachable ? ["up", "Port Master can control TSDProxy"] : ["down", "Cannot reach TSDProxy's control port: " + (api.error || api.note || "unknown")];
    var upd = !st ? "" : up.error ? '<span class="chip down">Update check failed</span> <span class="muted small">' + esc(up.error) + "</span>" : up.available ? '<span class="chip checking">Newer image ready</span> <span class="muted small">' + esc(up.latestVersion || up.latestImage || "") + (st.settings && st.settings.autoUpdate ? " installs in the nightly window (" + esc(st.settings.time) + ")" : " (automatic update is off, use Update now in App Updater)") + "</span>" : '<span class="chip up">Up to date</span> <span class="muted small">checked ' + esc(up.checkedAt ? when(up.checkedAt) : "not yet") + "</span>";
    var last = up.last ? '<div class="small ' + (up.last.ok ? "muted" : "attn") + '">Last update: ' + esc(up.last.message) + " (" + esc(when(up.last.at)) + ")</div>" : "";
    var rows = (st && st.proxies || []).map(function (p) {
      var by = p.paused ? (mine[p.name] ? "paused by Port Master" : "paused elsewhere") : "";
      return "<tr><th scope=\"row\" class=\"app\"><b>" + esc(p.name) + "</b><div class=\"muted small\">" + esc(ap[p.name] || "") + "</div></th><td><span class=\"chip " + (p.paused ? "ign" : "up") + "\">" + esc(p.paused ? "Paused" : p.status || "Running") + "</span><div class=\"muted small\">" + esc(by) + "</div></td><td><button class=\"btn small px\" data-n=\"" + esc(p.name) + "\" data-p=\"" + (p.paused ? "0" : "1") + "\">" + (p.paused ? "Resume" : "Pause") + "</button></td></tr>";
    }).join("");
    return '<div class="card"><div class="row"><b>TSDProxy</b><span class="muted small">' + esc(ver ? "version " + ver : "version not reported") + (c.image ? " · " + esc(c.image) + (c.imageId ? " (" + esc(c.imageId) + ")" : "") : "") + '</span></div><div class="row"><span class="chip ' + ctl[0] + '">Control</span> <span class="small">' + esc(ctl[1]) + "</span></div>" + (upd ? '<div class="row">' + upd + "</div>" : "") + last +
      (t.write && t.write.ok === false ? '<div class="small attn">' + esc(t.write.error) + "</div>" : "") +
      '<p class="muted small">Auto-update and Update now are in App Updater. TSDProxy\'s own dashboard (proxy cards with Pause and Restart) only answers on the Umbrel itself, at port 8088; it is not published on your network.</p></div>' +
      namesHtml() + '<div class="group"><h2>Proxies</h2><div class="card tw">' + (rows ? "<table><thead><tr><th class=\"app\">Proxy</th><th>State</th><th></th></tr></thead><tbody>" + rows + "</tbody></table>" : '<div class="muted small">No proxies reported yet.</div>') + '</div></div><p><button class="btn" id="feat">Port Master features: now and proposed</button></p>';
  }
  /* ---------- Tailscale names (created, changed and fixed by Port Master) ---------- */
  var NS = { ok: ["up", "Named"], none: ["ign", "No name"], clash: ["down", "Clash"], unregistered: ["checking", "Waiting"] };
  function namesHtml() {
    var n = S.names; if (!n) return "";
    var rows = n.rows.slice().sort(function (a, b) { return (a.state === "ok") - (b.state === "ok") || String(a.name).localeCompare(String(b.name)); }), w = n.write || {};
    var body = rows.map(function (x) {
      var src = x.source === "names" ? "kept by Port Master" : x.source === "label" ? "from the app's own settings" : x.source === "list" ? "published by Portal Admin" : "";
      var act = x.editable ? '<button class="btn small nm" data-a="' + esc(x.appId) + '">' + (x.tsdName ? "Rename" : "Create") + "</button>" + (x.source === "names" ? ' <button class="btn small nr" data-a="' + esc(x.appId) + '">Remove</button>' : "") : '<span class="muted small">fixed</span>';
      return '<tr><th scope="row" class="app"><b>' + esc(x.name) + '</b><div class="muted small">port ' + esc(x.port) + "</div></th><td>" + (x.tsdName ? "<b>" + esc(x.tsdName) + '</b><div class="muted small src">' + esc(src) + "</div>" : '<span class="muted small">' + (x.suggestion ? "suggested: " + esc(x.suggestion) : "none") + "</span>") + '</td><td><span class="chip ' + NS[x.state][0] + '">' + NS[x.state][1] + "</span>" + (x.note ? '<div class="muted small note">' + esc(x.note) + "</div>" : "") + "</td><td>" + act + "</td></tr>";
    }).join("");
    return '<div class="group"><h2>Tailscale names</h2>' + (w.ok === false && w.error ? '<div class="card"><div class="small attn">' + esc(w.error) + '</div></div>' : '') + '<div class="card tw"><table class="nt"><thead><tr><th class="app">App</th><th>Name</th><th>State</th><th></th></tr></thead><tbody>' + body + "</tbody></table></div></div>";
  }
  function nameDialog(x) {
    var d = $("#dlg"), cur = x.tsdName || x.suggestion || "";
    d.innerHTML = "<h2>" + (x.tsdName ? "Rename" : "Name") + " " + esc(x.name) + "</h2><form id='f'><label>Tailscale name<input name='n' value='" + esc(cur) + "' maxlength='63' pattern='[A-Za-z0-9][A-Za-z0-9-]*' required></label><p class='muted small'>Letters, numbers and dashes. The app opens at <b>https://" + esc(cur || "name") + "." + esc(S.config.tailnet || "your-tailnet") + "</b> for people on your tailnet. A new name appears in TSDProxy within a minute.</p><p class='err' id='e' role='alert'></p><div class='actions'><button type='button' class='btn' id='x'>Cancel</button><button class='btn primary'>" + (x.tsdName ? "Rename" : "Create") + "</button></div></form>";
    d.showModal(); d.querySelector("#x").onclick = function () { d.close(); };
    d.querySelector("#f").onsubmit = function (ev) { ev.preventDefault(); var b = ev.target.querySelector(".primary"); b.disabled = true;
      call("POST", "api/names", { op: x.tsdName ? "rename" : "create", appId: x.appId, name: ev.target.elements.n.value }).then(function (j) { take(j); d.close(); render(); toast(x.tsdName ? "Renamed" : "Name created"); }).catch(function (e) { b.disabled = false; d.querySelector("#e").textContent = e.message; }); };
  }
  var FS = { live: ["up", "Live"], built: ["checking", "Built, waiting for your yes"], proposed: ["ign", "Proposed"] };
  function featuresDialog() {
    var d = $("#dlg"); d.innerHTML = "<h2>Port Master features</h2>" + (window.PM_FEATURES || []).map(function (g) {
      return "<h3 class=\"fh\">" + esc(g.g) + "</h3>" + g.items.map(function (i) { return "<div class=\"fi\"><span class=\"chip " + FS[i.s][0] + "\">" + FS[i.s][1] + "</span> <b>" + esc(i.t) + "</b><div class=\"muted small\">" + esc(i.d) + "</div></div>"; }).join("");
    }).join("") + "<div class='actions'><button type='button' class='btn primary' id='x'>Close</button></div>";
    d.showModal(); d.querySelector("#x").onclick = function () { d.close(); };
  }
  // Add or hide a tile for an app that does not use the JoolzApp account.
  function portalDialog(a, on) {
    var d = $("#dlg"), p = a.portal || {};
    if (on) {
      d.innerHTML = "<h2>Hide " + esc(a.name || a.id) + "</h2><p class='muted small'>The tile disappears from the JoolzApp Store for everyone. The app keeps running and you can add it again.</p><p class='err' id='e' role='alert'></p><div class='actions'><button type='button' class='btn' id='x'>Cancel</button><button class='btn primary' id='go'>Hide tile</button></div>";
      d.showModal(); d.querySelector("#x").onclick = function () { d.close(); };
      d.querySelector("#go").onclick = function () { call("POST", "api/portal-app", { appId: a.id, add: false }).then(function (j) { take(j); d.close(); render(); toast("Tile hidden"); }).catch(function (e) { d.querySelector("#e").textContent = e.message; }); };
      return;
    }
    var order = ["public", "name", "tailscale", "lan", "local"], opts = order.map(function (k) { return a.routes.filter(function (r) { return r.key === k && r.openUrl; })[0]; }).filter(Boolean), first = opts[0];
    d.innerHTML = "<h2>Add " + esc(a.name || a.id) + " to the JoolzApp Store</h2><form id='f'><label>Name on the tile<input name='name' maxlength='60' value='" + esc(a.name || a.id) + "'></label><label>Description (optional)<input name='description' maxlength='200' placeholder='What this app is'></label>" +
      (opts.length ? "<fieldset class='rt'><legend class='small muted'>Address the tile opens</legend>" + opts.map(function (r) { return "<label class='rr'><input type='radio' name='route' value='" + r.key + "'" + (r === first ? " checked" : "") + "> <b>" + esc(r.label) + "</b> <span class='muted small'>" + esc(r.url) + (r.state === "down" ? " (down now)" : "") + "</span></label>"; }).join("") + "</fieldset>" : "<p class='err'>No address people can open yet. Add your tailnet name or Tailscale address in Settings first.</p>") +
      "<fieldset class='rt'><legend class='small muted'>Who can open the tile</legend><label class='rr'><input type='radio' name='aud' value='admins' checked> <b>Admin</b> <span class='muted small'>only admins can see the tile</span></label><label class='rr'><input type='radio' name='aud' value='all'> <b>Portal</b> <span class='muted small'>everyone with a JoolzApp account sees the tile</span></label></fieldset><p class='muted small'>The tile is only a shortcut: this app is not behind the JoolzApp login (the Login column stays empty), so it keeps its own login, or has none. An address that is not public only opens for people on your network or tailnet.</p><p class='err small' id='pw' hidden>Public: anyone with the link can open this app, whatever the tile says, unless the app has a login of its own.</p>" + (p.error ? "<p class='err small'>" + esc(p.error) + "</p>" : "") + "<p class='err' id='e' role='alert'></p><div class='actions'><button type='button' class='btn' id='x'>Cancel</button><button class='btn primary'" + (opts.length ? "" : " disabled") + ">Add tile</button></div></form>";
    d.showModal(); d.querySelector("#x").onclick = function () { d.close(); };
    var warn = function () { var r = d.querySelector("input[name=route]:checked"), w = d.querySelector("#pw"); if (w) w.hidden = !(r && r.value === "public"); };
    d.querySelectorAll("input[name=route]").forEach(function (i) { i.onchange = warn; }); warn();
    d.querySelector("#f").onsubmit = function (ev) {
      ev.preventDefault(); var f = ev.target.elements, r = f.route && (f.route.value || (f.route[0] && f.route[0].value));
      call("POST", "api/portal-app", { appId: a.id, add: true, audience: d.querySelector("input[name=aud]:checked").value, name: f.name.value, description: f.description.value, route: r }).then(function (j) { take(j); d.close(); render(); toast("Added to the JoolzApp Store"); }).catch(function (e) { d.querySelector("#e").textContent = e.message; });
    };
  }
  function render() {
    var r = S.report, c = S.config, down = 0, total = 0, ign = 0, pr = r ? problems(r) : [];
    if (r) r.apps.forEach(function (a) { a.routes.forEach(function (x) { total++; if (x.ignored) ign++; else if (x.state === "down") down++; }); });
    var pt = S.portal || {}, pl = !pt.linked ? "Not linked to Portal Admin yet" : pt.ok === false ? "Report to Portal Admin failed: " + pt.error : pt.ok ? "Reported to Portal Admin " + ago(pt.at) : "Waiting for the first report";
    $("#sum").innerHTML = r ? "<b>" + (down ? down + " route" + (down === 1 ? "" : "s") + " down" : "All routes up") + '</b><span class="muted small">' + total + " routes on " + r.apps.length + " apps" + (ign ? ", " + ign + " disabled" : "") + "</span><span class=\"muted small\">Checked " + esc(when(r.at)) + " (every " + r.intervalMin + " min)</span><span class=\"small\">" + esc(pl) + "</span>" + (pr.length ? '<div class="attn">Needs attention: ' + pr.map(function (p) { return "<b>" + esc(p.name) + "</b> (" + esc(p.routes.join(", ")) + ")"; }).join(" · ") + "</div>" : "") : "<b>Checking…</b>";
    var miss = []; if (!c.tailscaleIp) miss.push("your Tailscale address (100.x.y.z)"); if (!c.tailnet) miss.push("your tailnet name (…ts.net) for the Public and Tailscale name routes");
    $("#clash").innerHTML = r ? clashHtml() : "";
    $("#warn").hidden = !miss.length; $("#warn").innerHTML = miss.length ? "Add " + miss.join(" and ") + " in Settings to test those routes." : "";
    if (!r) { $("#list").innerHTML = ""; return; }
    if (S.tab === "tsd") {
      $("#list").innerHTML = tsdHtml(); $("#clash").innerHTML = "";
      document.querySelectorAll("[data-tab]").forEach(function (b) { b.setAttribute("aria-selected", b.dataset.tab === "tsd" ? "true" : "false"); });
      var f = $("#feat"); if (f) f.onclick = featuresDialog;
      var q = function (sel, fn) { $("#list").querySelectorAll(sel).forEach(fn); }, row = function (id) { return S.names.rows.filter(function (x) { return x.appId === id; })[0]; }, names = function (b, body, msg) { b.disabled = true; call("POST", "api/names", body).then(function (j) { take(j); render(); toast(msg); }).catch(function (e) { b.disabled = false; toast(e.message); }); };
      q(".nm", function (b) { b.onclick = function () { nameDialog(row(b.dataset.a)); }; }); q(".nr", function (b) { b.onclick = function () { names(b, { op: "remove", appId: b.dataset.a }, "Name removed"); }; });
      $("#list").querySelectorAll(".px").forEach(function (b) { b.onclick = function () { b.disabled = true; call("POST", "api/proxy", { name: b.dataset.n, paused: b.dataset.p === "1" }).then(function (j) { take(j); render(); toast(b.dataset.p === "1" ? "Pausing (takes up to 15 s)" : "Resuming (takes up to 15 s)"); setTimeout(function () { load().catch(function () {}); }, 17000); }).catch(function (e) { toast(e.message); render(); }); }; });
      return;
    }
    var srt = function (l) { return l.slice().sort(function (a, b) { return S.sort === "port" ? (+a.port || 0) - (+b.port || 0) : String(a.name || a.id).localeCompare(String(b.name || b.id)); }); };
    var isDown = function (a) { return a.routes.some(function (x) { return x.state === "down" && !x.ignored; }); };
    var j = srt(r.apps.filter(function (a) { return a.joolzapp; })), o = srt(r.apps.filter(function (a) { return !a.joolzapp; })), t = S.tab;
    if (t === "down") { j = j.filter(isDown); o = o.filter(isDown); } else if (t === "joolz") o = []; else if (t === "other") j = [];
    $("#list").innerHTML = (j.length ? '<div class="group"><h2>JoolzApp apps</h2>' + listHtml(j) + "</div>" : "") + (o.length ? '<div class="group"><h2>Other apps</h2>' + listHtml(o) + "</div>" : "") + (!j.length && !o.length ? '<div class="card muted">' + (t === "down" ? "No routes are down." : "Nothing to show.") + "</div>" : "");
    document.querySelectorAll("[data-tab]").forEach(function (b) { b.setAttribute("aria-selected", b.dataset.tab === t ? "true" : "false"); });
    document.querySelectorAll("[data-sort]").forEach(function (b) { b.setAttribute("aria-selected", b.dataset.sort === S.sort ? "true" : "false"); });
    $("#sortlabel").textContent = "Sort: " + (S.sort === "port" ? "Port" : "Name");
    $("#list").querySelectorAll(".ar").forEach(function (tr) { var t = function () { S.open[tr.dataset.id] = !S.open[tr.dataset.id]; render(); }; tr.onclick = t; tr.onkeydown = function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); t(); } }; });
    $("#list").querySelectorAll("td.tg").forEach(function (td) {
      var t = function (e) { e.stopPropagation(); if (td.dataset.busy) return; td.dataset.busy = "1"; var off = td.dataset.i === "1"; call("POST", "api/route", { appId: td.dataset.a, route: td.dataset.r, enabled: !off }).then(function (j) { take(j); render(); var x = ((S.report.apps.filter(function (q) { return q.id === td.dataset.a; })[0] || { routes: [] }).routes.filter(function (q) { return q.key === td.dataset.r; })[0]) || {}; toast(x.switch === "proxy" ? (off ? "Pausing the TSDProxy proxy (takes up to 15 s)" : "Resuming the TSDProxy proxy") : (off ? "Route disabled here" : "Route enabled")); if (x.switch === "proxy") setTimeout(function () { load().catch(function () {}); }, 17000); }).catch(function (er) { delete td.dataset.busy; toast(er.message); }); };
      td.onclick = t; td.onkeydown = function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); t(e); } };
    });
    $("#list").querySelectorAll("td.pg").forEach(function (td) {
      var t = function (e) { e.stopPropagation(); var a = S.report.apps.filter(function (x) { return x.id === td.dataset.a; })[0]; if (a) portalDialog(a, td.dataset.on === "1"); };
      td.onclick = t; td.onkeydown = function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); t(e); } };
    });
    $("#list").querySelectorAll(".lnk.fx").forEach(function (b) { b.onclick = function () { var k = b.dataset.a + "|" + b.dataset.r; S.fix = S.fix === k ? "" : k; render(); }; });
    $("#list").querySelectorAll(".rc").forEach(function (b) { b.onclick = function () { b.disabled = true; b.textContent = "Checking…"; call("POST", "api/recheck", { appId: b.dataset.a, route: b.dataset.r }).then(function (j) { take(j); var a = S.report.apps.filter(function (x) { return x.id === b.dataset.a; })[0], r = a && a.routes.filter(function (x) { return x.key === b.dataset.r; })[0]; if (r && r.state === "up") S.fix = ""; render(); toast(r && r.state === "up" ? "Fixed: answering again" : "Still down"); }).catch(function (e) { toast(e.message); render(); }); }; });
    $("#list").querySelectorAll(".lnk[data-i]").forEach(function (b) { b.onclick = function () { call("POST", "api/route", { appId: b.dataset.a, route: b.dataset.r, enabled: b.dataset.i !== "1" }).then(function (j) { take(j); render(); toast(b.dataset.i === "1" ? "Route disabled" : "Route enabled"); }).catch(function (e) { toast(e.message); }); }; });
  }
  function take(j) { if (j.report) S.report = j.report; if (j.config) S.config = j.config; if (j.portal) S.portal = j.portal; if (j.clashes) S.clashes = j.clashes; if (j.official) S.official = j.official; if (j.tsd) S.tsd = j.tsd; if (j.names) S.names = j.names; }
  function load() { return call("GET", "api/state").then(function (j) { take(j); render(); }); }
  function runCheck() { var b = $("#check"); b.classList.add("spin"); return call("POST", "api/check").then(function (j) { take(j); render(); }).catch(function (e) { toast(e.message); }).then(function () { b.classList.remove("spin"); }); }
  $("#check").onclick = runCheck;
  document.querySelectorAll("[data-tab]").forEach(function (b) { b.onclick = function () { S.tab = b.dataset.tab; lsSet("pm.tab", S.tab); render(); }; });
  document.querySelectorAll("[data-sort]").forEach(function (b) { b.onclick = function () { S.sort = b.dataset.sort; lsSet("pm.sort", S.sort); render(); }; });
  $("[data-settings]").onclick = function () {
    var d = $("#dlg"), c = S.config;
    d.innerHTML = "<h2>Settings</h2><form id='f'><label>LAN address of this Umbrel<input name='lanHost' value='" + esc(c.lanHost) + "' placeholder='192.168.1.50 or umbrel.local' required></label>" +
      "<label>.local name of this Umbrel (empty to skip)<input name='localHost' value='" + esc(c.localHost) + "' placeholder='umbrel.local'></label>" +
      "<label>Tailscale address of this Umbrel<input name='tailscaleIp' value='" + esc(c.tailscaleIp) + "' placeholder='100.x.y.z'></label>" +
      "<label>Your tailnet name<input name='tailnet' value='" + esc(c.tailnet) + "' placeholder='tail1234.ts.net'></label>" +
      "<label>Tailscale names<button type='button' class='btn' id='nall2'>Create names for all apps without one</button></label><label>Check every (minutes)<input name='intervalMin' type='number' min='1' max='60' value='" + esc(c.intervalMin) + "'></label><p class='err' id='e' role='alert'></p>" +
      "<div class='actions'><button type='button' class='btn' id='x'>Cancel</button><button class='btn primary'>Save and check</button></div></form>";
    d.showModal(); d.querySelector("#x").onclick = function () { d.close(); };
    d.querySelector("#nall2").onclick = function () { var b = this; b.disabled = true; call("POST", "api/names", { op: "create-all" }).then(function (j) { take(j); d.close(); render(); toast("Names created"); }).catch(function (e) { b.disabled = false; d.querySelector("#e").textContent = e.message; }); };
    d.querySelector("#f").onsubmit = function (ev) {
      ev.preventDefault(); var f = ev.target.elements;
      call("PUT", "api/config", { lanHost: f.lanHost.value, localHost: f.localHost.value, tailscaleIp: f.tailscaleIp.value, tailnet: f.tailnet.value, intervalMin: f.intervalMin.value }).then(function (j) { take(j); d.close(); render(); toast("Saved"); }).catch(function (e) { d.querySelector("#e").textContent = e.message; });
    };
  };
  load().catch(function (e) { toast(e.message); }); setInterval(function () { load().catch(function () {}); }, 30000);
})();
