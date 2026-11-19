"use strict";
// Tests for the TV Remote server: pairing with the 4-digit code, the TV's token-authenticated connection, relaying keys, and the screen loop
// (it only runs while someone watches, shares one capture between viewers, and slows down when the picture stops changing).
var fs = require("fs"), os = require("os"), path = require("path"), http = require("http");
var tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tvr-srv-"));
process.env.DATA_DIR = tmp;
var ws = require("../ws"), S = require("../server.js");
var servers = S.start({ uiPort: 0, agentPort: 0, host: "127.0.0.1" });
var results = [], failed = 0;
function ok(c, m) { results.push((c ? "ok   " : "FAIL ") + m); if (!c) failed++; }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function call(port, method, p, body, headers) {
  return new Promise(function (resolve) {
    var data = body === undefined ? null : JSON.stringify(body);
    var r = http.request({ host: "127.0.0.1", port: port, path: p, method: method, headers: Object.assign({ "Content-Type": "application/json" }, headers || {}) }, function (res) {
      var ch = []; res.on("data", function (d) { ch.push(d); }); res.on("end", function () { var b = Buffer.concat(ch), j = null; try { j = JSON.parse(b.toString()); } catch (e) {} resolve({ status: res.statusCode, json: j, buf: b }); });
    }); if (data) r.write(data); r.end();
  });
}
var X = { "X-Requested-With": "tvremote" };

Promise.all([new Promise(function (r) { servers.ui.on("listening", r); }), new Promise(function (r) { servers.agent.on("listening", r); })]).then(async function () {
  var UI = servers.ui.address().port, AG = servers.agent.address().port;
  // --- the page: needs the custom header for every POST
  var h = await call(UI, "GET", "/api/health"); ok(h.status === 200 && h.json.ok, "health answers");
  var idx = await call(UI, "GET", "/"); ok(idx.status === 200 && /TV Remote/.test(idx.buf.toString()), "the page loads");
  var trav = await call(UI, "GET", "/../server.js"); ok(trav.status === 404, "path traversal refused");
  var csrf = await call(UI, "POST", "/api/pair/new", {}); ok(csrf.status === 403, "a POST without the custom header is refused (cross-site safety)");
  var st0 = await call(UI, "GET", "/api/state"); ok(st0.json.tvs.length === 0 && st0.json.pairing === null && st0.json.agentPort === AG, "starts with no TVs and no open pairing");

  // --- pairing
  var closed = await call(AG, "POST", "/agent/pair", { code: "1234", name: "x" }); ok(closed.status === 403 && /not open/.test(closed.json.error), "the TV cannot pair while pairing is closed");
  var np = await call(UI, "POST", "/api/pair/new", {}, X); var code = np.json.code; ok(/^\d{4}$/.test(code) && np.json.secondsLeft === 600, "a 4-digit code valid for 10 minutes is made");
  var wrong = code === "0000" ? "1111" : "0000";
  for (var i = 0; i < 4; i++) { var w = await call(AG, "POST", "/agent/pair", { code: wrong, name: "TV" }); if (i === 0) ok(w.status === 403 && w.json.error === "Wrong code", "a wrong code is refused"); }
  var good = await call(AG, "POST", "/agent/pair", { code: code, name: "Lounge TV" });
  ok(good.json.ok && /^[a-f0-9]{48}$/.test(good.json.token) && /^[a-f0-9]{6}$/.test(good.json.id), "the right code (after 4 wrong tries) gives a long random token");
  var token = good.json.token, tvId = good.json.id;
  var again = await call(AG, "POST", "/agent/pair", { code: code, name: "Again" }); ok(again.status === 403, "a code works only once");
  var stored = fs.readFileSync(path.join(tmp, "tvs.json"), "utf8"); ok(stored.indexOf(token) < 0 && /tokenHash/.test(stored), "only a hash of the token is stored");
  await call(UI, "POST", "/api/pair/new", {}, X); var code2 = (await call(UI, "GET", "/api/state")).json.pairing.code, wr2 = code2 === "0000" ? "1111" : "0000", last;
  for (var j = 0; j < 5; j++) last = await call(AG, "POST", "/agent/pair", { code: wr2, name: "Evil" });
  ok(last.status === 403 && /Too many/.test(last.json.error), "5 wrong codes cancel the code");
  var after = await call(AG, "POST", "/agent/pair", { code: code2, name: "Evil" }); ok(after.status === 403 && /not open/.test(after.json.error), "so even the right code is then refused until a new one is made");

  // --- the TV's connection
  var bad = await new Promise(function (resolve) { ws.connect("ws://127.0.0.1:" + AG + "/agent/ws", { Authorization: "Bearer " + "a".repeat(48) }, function (e) { resolve(e); }); });
  ok(bad && /401/.test(bad.message), "a wrong token cannot connect");
  var shots = 0, frames = [], keysSeen = [], mode = "static";
  function jpeg(n) { return Buffer.from([0xff, 0xd8, 0xff, n & 255, 1, 2, 3, 0xff, 0xd9]); }
  var tv = await new Promise(function (resolve, reject) { ws.connect("ws://127.0.0.1:" + AG + "/agent/ws", { Authorization: "Bearer " + token }, function (e, c) { e ? reject(e) : resolve(c); }); });
  tv.sendText(JSON.stringify({ hello: true, version: "0.2.0" }));
  tv.on("message", function (data) {
    var m = JSON.parse(data.toString());
    if (m.cmd === "shot") { shots++; var head = Buffer.alloc(4); head.writeUInt32BE(m.id, 0); tv.sendBinary(Buffer.concat([head, jpeg(mode === "static" ? 7 : shots)])); }
    else { keysSeen.push(m); tv.sendText(JSON.stringify(m.app === "fail.app" ? { id: m.id, ok: false, error: "nope" } : { id: m.id, ok: true })); }
  });
  await sleep(200);
  var st1 = (await call(UI, "GET", "/api/state")).json; ok(st1.tvs.length === 1 && st1.tvs[0].online && st1.tvs[0].name === "Lounge TV" && st1.tvs[0].version === "0.2.0", "the TV shows as online with its name and version");

  // --- nobody watching: no work for the TV
  await sleep(500); ok(shots === 0, "no screenshots are taken while nobody is watching");

  // --- viewers
  function view(speed) {
    return new Promise(function (resolve) {
      var count = 0, req = http.get({ host: "127.0.0.1", port: UI, path: "/api/tv/" + tvId + "/stream?speed=" + speed + "&w=640" }, function (res) {
        var buf = Buffer.alloc(0); res.on("data", function (d) { buf = Buffer.concat([buf, d]); count = (buf.toString("latin1").match(/--frame/g) || []).length; });
        resolve({ res: res, req: req, count: function () { return count; } });
      });
    });
  }
  var v1 = await view("fast"), v2 = await view("fast"); await sleep(1500);
  ok(v1.res.headers["content-type"].indexOf("multipart/x-mixed-replace") === 0, "the stream is a multipart picture stream");
  var shotsStatic = shots; ok(shotsStatic > 0 && v1.count() >= 1 && v2.count() >= 1, "both viewers get pictures");
  ok(shotsStatic <= 6, "an unchanging picture slows the TV down (" + shotsStatic + " shots in 1.5 s with 2 viewers, fast mode)");
  mode = "moving"; shots = 0; var key = await call(UI, "POST", "/api/tv/" + tvId + "/key", { name: "ENTER" }, X);
  ok(key.json.ok && keysSeen.some(function (k) { return k.cmd === "key" && k.name === "ENTER"; }), "a key press reaches the TV and is acknowledged");
  await sleep(1500); ok(shots >= 3, "after a key press it looks at the screen quickly again (" + shots + " shots in 1.5 s)");
  ok(shots / 1.5 < 12, "and shots are shared: two viewers do not double the TV's work");
  var kk = await call(UI, "POST", "/api/tv/" + tvId + "/key", { name: "rm -rf" }, X); ok(kk.status === 400, "unknown key names refused");
  var fk = await call(UI, "POST", "/api/tv/" + tvId + "/launch", { id: "fail.app" }, X); ok(fk.status === 502 && fk.json.error === "nope", "an error from the TV is passed back");
  var la = await call(UI, "POST", "/api/tv/" + tvId + "/launch", { id: "netflix", params: { contentTarget: "source_type=4&m=https://www.netflix.com/watch/80057281" } }, X);
  ok(la.json.ok && keysSeen.some(function (k) { return k.cmd === "launch" && k.app === "netflix" && /watch\/80057281/.test(k.params.contentTarget); }), "launch carries the app id and link");
  var la2 = await call(UI, "POST", "/api/tv/" + tvId + "/launch", { id: "x; reboot" }, X); ok(la2.status === 400, "app ids with shell characters refused");
  var tx = await call(UI, "POST", "/api/tv/" + tvId + "/text", { text: "hello" }, X); ok(tx.json.ok, "text is relayed");
  v1.req.destroy(); v2.req.destroy(); await sleep(300); var after1 = shots; await sleep(1500); ok(shots - after1 <= 1, "when the last viewer leaves, screenshots stop");

  // --- rename, offline, remove
  var rn = await call(UI, "POST", "/api/tv/" + tvId + "/rename", { name: "Bedroom <b>TV</b>" }, X); ok(rn.json.ok, "rename is accepted");
  var nm = (await call(UI, "GET", "/api/state")).json.tvs[0].name; ok(nm.indexOf("<") < 0 && nm.indexOf(">") < 0, "angle brackets are stripped from names");
  tv.close(); await sleep(600);
  ok(!(await call(UI, "GET", "/api/state")).json.tvs[0].online, "the TV shows offline when it disconnects");
  var off = await call(UI, "GET", "/api/tv/" + tvId + "/stream"); ok(off.status === 503, "viewing an offline TV says so");
  var offk = await call(UI, "POST", "/api/tv/" + tvId + "/key", { name: "UP" }, X); ok(offk.status === 502 && /offline/.test(offk.json.error), "keys to an offline TV say it is offline");
  var rm = await call(UI, "POST", "/api/tv/" + tvId + "/remove", {}, X); ok(rm.json.ok && (await call(UI, "GET", "/api/state")).json.tvs.length === 0, "removing a TV forgets it");
  var gone = await new Promise(function (resolve) { ws.connect("ws://127.0.0.1:" + AG + "/agent/ws", { Authorization: "Bearer " + token }, function (e) { resolve(e); }); }); ok(gone && /401/.test(gone.message), "a removed TV's token stops working");

  console.log(results.join("\n")); console.log(failed ? "FAILED " + failed : "ALL PASSED (" + results.length + ")");
  fs.rmSync(tmp, { recursive: true, force: true }); process.exit(failed ? 1 : 0);
}).catch(function (e) { console.log(results.join("\n")); console.error("ERROR", e); process.exit(1); });
