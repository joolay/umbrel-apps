(function () {
  "use strict";
  var $ = function (i) { return document.getElementById(i); };
  var state = { tvs: [], pairing: null, agentPort: 3905 }, cur = null, speed = "normal", pollTimer = null, retryTimer = null, toastTimer = null;
  var WIDTH = { slow: 640, normal: 960, fast: 960 };

  function api(path, body, cb) {
    var x = new XMLHttpRequest(); x.open(body === undefined ? "GET" : "POST", path);
    if (body !== undefined) { x.setRequestHeader("Content-Type", "application/json"); x.setRequestHeader("X-Requested-With", "tvremote"); }
    x.onload = function () { var j = {}; try { j = JSON.parse(x.responseText); } catch (e) {} cb(x.status < 300 && j.ok !== false ? null : (j.error || ("Error " + x.status)), j); };
    x.onerror = function () { cb("Cannot reach the server", {}); };
    x.send(body === undefined ? null : JSON.stringify(body));
  }
  function toast(t, bad) { var el = $("toast"); el.textContent = t; el.className = "toast" + (bad ? " err" : ""); el.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(function () { el.hidden = true; }, 3500); }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

  function drawList() {
    var h = ""; state.tvs.forEach(function (t) {
      h += '<button class="tile" data-id="' + t.id + '"><div class="tile-head"><div class="tile-ic">TV</div><div><div class="name">' + esc(t.name) + '</div><div class="muted small"><span class="dot ' + (t.online ? "on" : "") + '"></span>' + (t.online ? "Online" : "Offline") + (t.version ? " · agent " + esc(t.version) : "") + '</div></div></div></button>';
    });
    $("tiles").innerHTML = h; $("empty").hidden = state.tvs.length > 0;
  }
  function refresh(cb) {
    api("/api/state", undefined, function (err, j) {
      if (!err) { state = j; if (!cur) drawList(); updatePair(); if (cur) { var t = find(cur); if (t) { $("offline").hidden = t.online; if (!t.online) $("note").textContent = ""; } } }
      cb && cb();
    });
  }
  function find(id) { for (var i = 0; i < state.tvs.length; i++) if (state.tvs[i].id === id) return state.tvs[i]; return null; }
  function poll() { clearTimeout(pollTimer); refresh(function () { pollTimer = setTimeout(poll, $("pairDlg").open ? 1500 : 5000); }); }

  // ---- pairing
  function updatePair() {
    var d = $("pairDlg"); if (!d.open) return;
    if (!state.pairing) { d.close(); toast(state.tvs.length ? "TV added" : "Pairing closed"); return; }
    $("pairCode").textContent = state.pairing.code;
    var s = state.pairing.secondsLeft; $("pairLeft").textContent = "The code works for " + Math.floor(s / 60) + ":" + ("0" + (s % 60)).slice(-2) + " and only once.";
    $("pairAddr").textContent = location.hostname + ":" + state.agentPort;
  }
  $("addBtn").onclick = function () {
    var before = state.tvs.length;
    api("/api/pair/new", {}, function (err) { if (err) return toast(err, true); $("pairDlg").showModal(); refresh(); });
    state._before = before;
  };
  $("pairCancel").onclick = function () { api("/api/pair/cancel", {}, function () { $("pairDlg").close(); refresh(); }); };

  // ---- viewing one TV
  function setStream() {
    var im = $("screen"); clearTimeout(retryTimer);
    if (!cur) { im.removeAttribute("src"); return; }
    im.src = "/api/tv/" + cur + "/stream?speed=" + speed + "&w=" + WIDTH[speed] + "&t=" + Date.now();
  }
  $("screen").onerror = function () { if (cur) { $("offline").hidden = false; retryTimer = setTimeout(setStream, 3000); } };
  $("screen").onload = function () { $("offline").hidden = true; };
  function openTv(id) {
    var t = find(id); if (!t) return; cur = id;
    $("listView").hidden = true; $("remoteView").hidden = false; $("backBtn").hidden = false; $("addBtn").hidden = true; $("title").textContent = t.name;
    $("rename").value = t.name; $("info").textContent = "Agent " + (t.version || "?") + (t.online ? ", online." : ", offline.");
    $("offline").hidden = t.online; setStream();
  }
  function closeTv() { cur = null; setStream(); $("remoteView").hidden = true; $("listView").hidden = false; $("backBtn").hidden = true; $("addBtn").hidden = false; $("title").textContent = "TV Remote"; drawList(); }
  $("backBtn").onclick = closeTv;
  $("tiles").addEventListener("click", function (e) { var b = e.target.closest(".tile"); if (b) openTv(b.getAttribute("data-id")); });
  $("speed").addEventListener("click", function (e) {
    var b = e.target.closest("button"); if (!b) return; speed = b.getAttribute("data-s");
    [].forEach.call($("speed").querySelectorAll("button"), function (x) { x.className = x === b ? "on" : ""; }); setStream();
  });

  function send(action, body) { if (!cur) return; api("/api/tv/" + cur + "/" + action, body || {}, function (err) { if (err) toast(err, true); }); }
  document.addEventListener("click", function (e) {
    var b = e.target.closest && e.target.closest("button"); if (!b) return;
    if (b.classList.contains("k")) send("key", { name: b.getAttribute("data-k") });
    else if (b.classList.contains("app")) send("launch", { id: b.getAttribute("data-a") });
  });
  $("launch").onclick = function () { var v = $("aid").value.trim(); if (v) send("launch", { id: v }); };
  $("sendTxt").onclick = function () { var v = $("txt").value; if (v) { send("text", { text: v }); $("txt").value = ""; } };
  $("renameBtn").onclick = function () { var v = $("rename").value.trim(); if (v) api("/api/tv/" + cur + "/rename", { name: v }, function (err) { if (err) return toast(err, true); $("title").textContent = v; refresh(); }); };
  $("removeBtn").onclick = function () { if (confirm("Remove this TV? It will have to be paired again.")) api("/api/tv/" + cur + "/remove", {}, function (err) { if (err) return toast(err, true); closeTv(); refresh(); }); };
  var map = { 37: "LEFT", 38: "UP", 39: "RIGHT", 40: "DOWN", 13: "ENTER", 27: "BACK", 8: "BACK", 36: "HOME", 187: "VOLUMEUP", 107: "VOLUMEUP", 189: "VOLUMEDOWN", 109: "VOLUMEDOWN" };
  document.addEventListener("keydown", function (e) {
    if (!cur || $("pairDlg").open || /INPUT|TEXTAREA/.test(e.target.tagName || "")) return;
    var k = map[e.keyCode]; if (k) { e.preventDefault(); send("key", { name: k }); }
  });
  poll();
})();
