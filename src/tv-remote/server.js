"use strict";
// TV Remote (Umbrel side). The TV's agent connects OUT to this server (agent port, token-authenticated WebSocket); people use the web page here
// (behind Umbrel's own login). The TV only works when someone is watching: this server asks it for one screenshot at a time, shares each frame
// with every viewer, slows down when the picture is not changing, and stops completely when nobody is looking.
var http = require("http");
var fs = require("fs");
var path = require("path");
var crypto = require("crypto");
var urlmod = require("url");
var ws = require("./ws");

var VERSION = require("./package.json").version;
var DATA = process.env.DATA_DIR || "/data";
var UI_PORT = Number(process.env.PORT) || 3000;
var actualAgentPort = null;
var AGENT_PORT = Number(process.env.AGENT_PORT) || 3905;
var PUB = path.join(__dirname, "public");
var STORE = path.join(DATA, "tvs.json");

var SPEEDS = { slow: 1500, normal: 700, fast: 300 };
var MAX_IDLE_WAIT = 3000;          // when the picture stops changing, the gap between screenshots grows up to this
var KEEPALIVE_MS = 8000;           // a viewer is sent the same frame again after this long, so proxies do not close the stream
var PAIR_MS = 10 * 60 * 1000, PAIR_MAX_WRONG = 5;
var KEYS = /^(LEFT|RIGHT|UP|DOWN|ENTER|BACK|HOME|EXIT|MENU|INFO|DASH|ASTERISK|RED|GREEN|YELLOW|BLUE|VOLUMEUP|VOLUMEDOWN|MUTE|CHANNELUP|CHANNELDOWN|PLAY|PAUSE|STOP|REWIND|FASTFORWARD|[0-9])$/;

// ---- stored TVs (only a hash of each TV's token is kept) --------------------------------------------------------------
var tvs = [];                       // { id, name, tokenHash, createdAt }
function load() { try { var j = JSON.parse(fs.readFileSync(STORE, "utf8")); tvs = Array.isArray(j.tvs) ? j.tvs : []; } catch (e) { tvs = []; } }
function save() {
  try { fs.mkdirSync(DATA, { recursive: true }); var t = STORE + ".tmp"; fs.writeFileSync(t, JSON.stringify({ tvs: tvs }), { mode: 384 }); fs.renameSync(t, STORE); } catch (e) { console.error("could not save:", e.message); }
}
function sha(s) { return crypto.createHash("sha256").update(String(s)).digest("hex"); }
function findByToken(tok) {
  var h = Buffer.from(sha(tok)), found = null;
  for (var i = 0; i < tvs.length; i++) { var b = Buffer.from(tvs[i].tokenHash); if (b.length === h.length && crypto.timingSafeEqual(b, h)) found = tvs[i]; }
  return found;
}
function cleanName(n) { n = String(n == null ? "" : n).replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 40); return n || "LG TV"; }

// ---- runtime state per TV ----------------------------------------------------------------------------------------------
var rts = {};
function rt(id) { return rts[id] || (rts[id] = { id: id, conn: null, online: false, version: "", lastSeen: 0, pending: {}, seq: 1, viewers: [], latest: null, same: 0, timer: null, loopOn: false, lastError: "" }); }

function request(id, msg, timeout) {
  var r = rt(id);
  return new Promise(function (resolve, reject) {
    if (!r.online || !r.conn) return reject(new Error("TV is offline"));
    var n = r.seq++; if (r.seq > 2000000000) r.seq = 1; msg.id = n;
    var t = setTimeout(function () { delete r.pending[n]; reject(new Error("The TV did not answer")); }, timeout || 10000);
    r.pending[n] = { resolve: resolve, reject: reject, timer: t };
    try { r.conn.sendText(JSON.stringify(msg)); } catch (e) { clearTimeout(t); delete r.pending[n]; reject(e); }
  });
}
function settle(r, n, err, val) { var p = r.pending[n]; if (!p) return; clearTimeout(p.timer); delete r.pending[n]; err ? p.reject(err) : p.resolve(val); }

// ---- the screen loop: only while someone watches -----------------------------------------------------------------------
function viewerInterval(r) { var m = 99999; r.viewers.forEach(function (v) { m = Math.min(m, SPEEDS[v.speed] || SPEEDS.normal); }); return m; }
function viewerWidth(r) { var m = 320; r.viewers.forEach(function (v) { m = Math.max(m, v.w); }); return Math.min(m, 1280); }
function hashOf(b) { return crypto.createHash("md5").update(b).digest("hex"); }
function writeFrame(v, buf) {
  if (v.res.writableLength > 2 * 1024 * 1024) return;        // a slow viewer skips frames instead of piling them up
  try { v.res.write("--frame\r\nContent-Type: image/jpeg\r\nContent-Length: " + buf.length + "\r\n\r\n"); v.res.write(buf); v.res.write("\r\n"); } catch (e) {}
}
function push(r) {
  if (!r.latest) return;
  var now = Date.now();
  r.viewers.forEach(function (v) { if (v.hash !== r.latest.hash || now - v.sent >= KEEPALIVE_MS) { v.hash = r.latest.hash; v.sent = now; writeFrame(v, r.latest.buf); } });
}
function startLoop(r) { if (r.loopOn) return; r.loopOn = true; r.same = 0; tick(r); }
function tick(r) {
  r.timer = null;
  if (!r.online || !r.viewers.length) { r.loopOn = false; return; }
  var t0 = Date.now(), failed = false;
  request(r.id, { cmd: "shot", w: viewerWidth(r) }, 9000).then(function (res) {
    if (!res.buf) throw new Error(res.error || "no picture");
    var h = hashOf(res.buf); r.same = r.latest && r.latest.hash === h ? r.same + 1 : 0;
    r.latest = { buf: res.buf, hash: h, at: Date.now() }; r.lastError = ""; push(r);
  }).catch(function (e) { failed = true; r.lastError = e.message; }).then(function () {
    var base = viewerInterval(r), mult = r.same >= 4 ? Math.min(8, 1 << Math.min(3, r.same - 3)) : 1;
    var wait = failed ? 2500 : Math.max(0, Math.min(MAX_IDLE_WAIT, base * mult) - (Date.now() - t0));
    r.timer = setTimeout(function () { tick(r); }, wait);
  });
}
function wake(r) {                  // something was just done on the TV: look again soon and at full speed
  r.same = 0;
  if (r.timer) { clearTimeout(r.timer); r.timer = setTimeout(function () { tick(r); }, 250); }
}

// ---- pairing (a 4-digit code the owner makes here and types on the TV) ---------------------------------------------------
var pairing = null;                 // { code, expires, wrong }
function newPairing() { var c = ""; for (var i = 0; i < 4; i++) c += crypto.randomInt(0, 10); pairing = { code: c, expires: Date.now() + PAIR_MS, wrong: 0 }; return pairing; }
function pairingActive() { if (pairing && pairing.expires <= Date.now()) pairing = null; return pairing; }

// ---- helpers -------------------------------------------------------------------------------------------------------------
function sendJson(res, code, obj) { res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(obj)); }
function readBody(req, cb) {
  var n = 0, ch = [], dead = false;
  req.on("data", function (d) { n += d.length; if (n > 8192) { dead = true; req.destroy(); return; } ch.push(d); });
  req.on("end", function () { if (dead) return; var j = {}; try { j = JSON.parse(Buffer.concat(ch).toString("utf8") || "{}"); } catch (e) { return cb(null); } cb(j && typeof j === "object" ? j : {}); });
}
var MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "application/javascript", ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json" };
function serveStatic(req, res, p) {
  if (p === "/") p = "/index.html";
  var f = path.normalize(path.join(PUB, p)); if (f.indexOf(PUB + path.sep) !== 0) return sendJson(res, 404, { ok: false });
  fs.readFile(f, function (e, b) { if (e) return sendJson(res, 404, { ok: false, error: "Not found" }); res.writeHead(200, { "Content-Type": MIME[path.extname(f)] || "application/octet-stream", "Cache-Control": "no-cache" }); res.end(b); });
}
function tvView(t) { var r = rt(t.id); return { id: t.id, name: t.name, online: r.online, lastSeen: r.lastSeen || null, version: r.version, viewers: r.viewers.length, error: r.lastError || "" }; }

// ---- the web page's API (reached through Umbrel's login) ---------------------------------------------------------------
function uiHandler(req, res) {
  var u = urlmod.parse(req.url, true), p = u.pathname, m = req.method;
  if (p === "/api/health") return sendJson(res, 200, { ok: true, version: VERSION });
  if (m === "GET" && !/^\/api\//.test(p)) return serveStatic(req, res, p);
  if (m === "GET" && p === "/api/state") {
    var pa = pairingActive();
    return sendJson(res, 200, { ok: true, version: VERSION, agentPort: actualAgentPort || AGENT_PORT, tvs: tvs.map(tvView), pairing: pa ? { code: pa.code, secondsLeft: Math.ceil((pa.expires - Date.now()) / 1000) } : null });
  }
  var mm = /^\/api\/tv\/([a-f0-9]{6})\/(stream|frame)$/.exec(p);
  if (m === "GET" && mm) {
    var tv = tvs.filter(function (t) { return t.id === mm[1]; })[0]; if (!tv) return sendJson(res, 404, { ok: false, error: "No such TV" });
    var r = rt(tv.id); if (!r.online) return sendJson(res, 503, { ok: false, error: "TV is offline" });
    if (mm[2] === "frame") return r.latest ? (res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "no-store" }), res.end(r.latest.buf)) : sendJson(res, 404, { ok: false, error: "No picture yet" });
    var v = { res: res, speed: SPEEDS[u.query.speed] ? u.query.speed : "normal", w: Math.max(320, Math.min(1280, Number(u.query.w) || 960)), hash: "", sent: 0 };
    res.writeHead(200, { "Content-Type": "multipart/x-mixed-replace; boundary=frame", "Cache-Control": "no-store", "X-Accel-Buffering": "no", Connection: "keep-alive" });
    r.viewers.push(v);
    req.on("close", function () { var i = r.viewers.indexOf(v); if (i >= 0) r.viewers.splice(i, 1); });
    if (r.latest && Date.now() - r.latest.at < 3000) { v.hash = r.latest.hash; v.sent = Date.now(); writeFrame(v, r.latest.buf); }
    return startLoop(r);
  }
  if (m !== "POST") return sendJson(res, 404, { ok: false, error: "Not found" });
  // Browsers cannot add this header from another site without our permission, so other sites cannot make the page's owner press buttons.
  if (req.headers["x-requested-with"] !== "tvremote") return sendJson(res, 403, { ok: false, error: "Forbidden" });
  readBody(req, function (b) {
    if (!b) return sendJson(res, 400, { ok: false, error: "Bad request" });
    if (p === "/api/pair/new") { var np = newPairing(); return sendJson(res, 200, { ok: true, code: np.code, secondsLeft: Math.ceil(PAIR_MS / 1000) }); }
    if (p === "/api/pair/cancel") { pairing = null; return sendJson(res, 200, { ok: true }); }
    var cm = /^\/api\/tv\/([a-f0-9]{6})\/(rename|remove|key|move|click|launch|text)$/.exec(p);
    if (!cm) return sendJson(res, 404, { ok: false, error: "Not found" });
    var tv2 = tvs.filter(function (t) { return t.id === cm[1]; })[0]; if (!tv2) return sendJson(res, 404, { ok: false, error: "No such TV" });
    var r2 = rt(tv2.id), act = cm[2];
    if (act === "rename") { tv2.name = cleanName(b.name); save(); return sendJson(res, 200, { ok: true }); }
    if (act === "remove") { tvs = tvs.filter(function (t) { return t !== tv2; }); save(); if (r2.conn) r2.conn.close(); delete rts[tv2.id]; return sendJson(res, 200, { ok: true }); }
    var msg;
    if (act === "key") { if (typeof b.name !== "string" || !KEYS.test(b.name)) return sendJson(res, 400, { ok: false, error: "Unknown key" }); msg = { cmd: "key", name: b.name }; }
    else if (act === "move") msg = { cmd: "move", dx: Math.max(-300, Math.min(300, Math.round(Number(b.dx) || 0))), dy: Math.max(-300, Math.min(300, Math.round(Number(b.dy) || 0))) };
    else if (act === "click") msg = { cmd: "click" };
    else if (act === "launch") {
      if (typeof b.id !== "string" || !/^[A-Za-z0-9._-]{1,100}$/.test(b.id)) return sendJson(res, 400, { ok: false, error: "Bad app id" });
      msg = { cmd: "launch", app: b.id, params: b.params && typeof b.params === "object" && JSON.stringify(b.params).length < 1000 ? b.params : {} };
    } else { if (typeof b.text !== "string" || b.text.length > 200) return sendJson(res, 400, { ok: false, error: "Bad text" }); msg = { cmd: "text", text: b.text }; }
    request(tv2.id, msg, 10000).then(function (rep) { wake(r2); rep.ok ? sendJson(res, 200, { ok: true }) : sendJson(res, 502, { ok: false, error: rep.error || "The TV refused" }); },
      function (e) { sendJson(res, 502, { ok: false, error: e.message }); });
  });
}

// ---- the TV's side: pairing and the agent connection -----------------------------------------------------------------------
function agentHandler(req, res) {
  var p = urlmod.parse(req.url).pathname;
  if (req.method === "POST" && p === "/agent/pair") {
    return readBody(req, function (b) {
      var pa = pairingActive();
      if (!b || typeof b.code !== "string") return sendJson(res, 400, { ok: false, error: "Bad request" });
      if (!pa) return sendJson(res, 403, { ok: false, error: "Pairing is not open. Press Add TV in the Umbrel app first." });
      var a = Buffer.from(sha(b.code)), c = Buffer.from(sha(pa.code));
      if (!crypto.timingSafeEqual(a, c)) {
        pa.wrong++; if (pa.wrong >= PAIR_MAX_WRONG) { pairing = null; return sendJson(res, 403, { ok: false, error: "Too many wrong codes. Make a new code in the Umbrel app." }); }
        return sendJson(res, 403, { ok: false, error: "Wrong code" });
      }
      pairing = null;
      var token = crypto.randomBytes(24).toString("hex"), tv = { id: crypto.randomBytes(3).toString("hex"), name: cleanName(b.name), tokenHash: sha(token), createdAt: Date.now() };
      tvs.push(tv); save();
      sendJson(res, 200, { ok: true, token: token, id: tv.id });
    });
  }
  sendJson(res, 404, { ok: false });
}
function onAgentUpgrade(req, socket, head) {
  var p = urlmod.parse(req.url).pathname, m = /^Bearer ([a-f0-9]{48})$/.exec(req.headers.authorization || "");
  var tv = p === "/agent/ws" && m ? findByToken(m[1]) : null;
  if (!tv) { socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n"); return socket.destroy(); }
  var conn = ws.accept(req, socket, head); if (!conn) return;
  var r = rt(tv.id);
  if (r.conn) { try { r.conn.close(); } catch (e) {} }
  r.conn = conn; r.online = true; r.lastSeen = Date.now(); r.lastError = "";
  var ping = setInterval(function () { try { conn.ping(); } catch (e) {} }, 25000);
  conn.on("message", function (data, isBin) {
    r.lastSeen = Date.now();
    if (isBin) { if (data.length > 4) settle(r, data.readUInt32BE(0), null, { ok: true, buf: data.slice(4) }); return; }
    var j; try { j = JSON.parse(data.toString("utf8")); } catch (e) { return; }
    if (j.hello) { r.version = String(j.version || "").slice(0, 20); return; }
    if (typeof j.id === "number") settle(r, j.id, null, j);
  });
  conn.on("close", function () {
    clearInterval(ping);
    if (r.conn === conn) { r.conn = null; r.online = false; Object.keys(r.pending).forEach(function (k) { settle(r, Number(k), new Error("TV went offline")); }); }
  });
}

function start(opts) {
  opts = opts || {};
  load();
  var ui = http.createServer(uiHandler), ag = http.createServer(agentHandler);
  ag.on("upgrade", onAgentUpgrade);
  [ui, ag].forEach(function (s) { s.on("clientError", function (e, sock) { try { sock.destroy(); } catch (x) {} }); });
  ui.listen(opts.uiPort != null ? opts.uiPort : UI_PORT, opts.host || "0.0.0.0");
  ag.listen(opts.agentPort != null ? opts.agentPort : AGENT_PORT, opts.host || "0.0.0.0");
  ag.on("listening", function () { actualAgentPort = ag.address().port; });
  ui.on("listening", function () { console.log("TV Remote " + VERSION + " page on " + ui.address().port + ", TV agents on " + ag.address().port); });
  return { ui: ui, agent: ag };
}

module.exports = { start: start, rts: rts, tvs: function () { return tvs; }, SPEEDS: SPEEDS };
if (require.main === module) start();
