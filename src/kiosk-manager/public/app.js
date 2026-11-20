(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var busy = false;
  function chip(el, on, yes, no) { el.textContent = on ? yes : no; el.className = "chip " + (on ? "ok" : "warn"); }
  function api(method, path, body) {
    return fetch(path, { method: method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined }).then(function (r) { return r.json(); });
  }
  function refresh() {
    return api("GET", "/api/status").then(function (s) {
      chip($("sInst"), s.installed, "Installed", "Not installed");
      chip($("sRun"), s.running, "Running", "Stopped");
      chip($("sBoot"), s.bootEnabled, "On", "Off");
      if (document.activeElement !== $("url")) $("url").value = s.config.url;
      $("logs").textContent = s.logs || "";
      $("bLoad").disabled = !s.installed || s.running;
      $("bUnload").disabled = !s.running;
      $("bBootOn").disabled = !s.installed || s.bootEnabled;
      $("bBootOff").disabled = !s.bootEnabled;
      $("bUninstall").disabled = !s.unitPresent;
      if (!s.hostReachable) $("msg").textContent = "Cannot reach the server's system. This app needs privileged host access.";
    }).catch(function () { $("msg").textContent = "Cannot reach the app."; });
  }
  function act(path, label) {
    if (busy) return; busy = true;
    $("msg").textContent = label + "… this can take a few minutes the first time.";
    api("POST", path).then(function (r) {
      $("msg").textContent = (r.ok ? "Done. " : "Failed. ") + String(r.out || "").slice(-300);
    }).catch(function () { $("msg").textContent = "Failed."; }).then(function () { busy = false; refresh(); });
  }
  $("bInst").onclick = function () { act("/api/install", "Installing"); };
  $("bLoad").onclick = function () { act("/api/load", "Loading kiosk"); };
  $("bUnload").onclick = function () { act("/api/unload", "Unloading kiosk"); };
  $("bBootOn").onclick = function () { act("/api/boot/enable", "Adding to boot"); };
  $("bBootOff").onclick = function () { act("/api/boot/disable", "Removing from boot"); };
  $("bUninstall").onclick = function () { if (confirm("Remove the kiosk service from this server?")) act("/api/uninstall", "Removing"); };
  $("bSave").onclick = function () {
    api("POST", "/api/config", { url: $("url").value.trim() }).then(function (r) { $("msg").textContent = r.out; refresh(); });
  };
  refresh(); setInterval(function () { if (!busy) refresh(); }, 5000);
})();
