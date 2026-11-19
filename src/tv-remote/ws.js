"use strict";
// Minimal WebSocket (RFC 6455) for the TV Remote: used by the Umbrel server (accepts the TV's connection) and by the TV agent (connects out).
// No dependencies, plain Node (works on the TV's Node 0.12 (webOS 4) and on Node 22). THIS FILE IS IDENTICAL in joolay/umbrel-apps (src/tv-remote/ws.js)
// and joolay/homebrew (app-remote/agent/ws.js): change both together.
var crypto = require("crypto");
var net = require("net");
var tls = require("tls");
var urlmod = require("url");
var EventEmitter = require("events").EventEmitter;

// Node 0.12 (webOS 4) has no Buffer.alloc / Buffer.from: use them when present, the old constructor otherwise.
var NEWBUF = typeof Buffer.alloc === "function";
function bAlloc(n) { if (NEWBUF) return Buffer.alloc(n); var b = new Buffer(n); b.fill(0); return b; }
function bFrom(x, enc) { return NEWBUF ? Buffer.from(x, enc) : new Buffer(x, enc); }

var GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
var MAX_PAYLOAD = 16 * 1024 * 1024;

function encode(opcode, payload, mask) {
  var p = Buffer.isBuffer(payload) ? payload : bFrom(String(payload), "utf8"), n = p.length, h, m = mask ? 0x80 : 0;
  if (n < 126) h = bFrom([0x80 | opcode, m | n]);
  else if (n < 65536) h = bFrom([0x80 | opcode, m | 126, n >> 8, n & 255]);
  else { h = bAlloc(10); h[0] = 0x80 | opcode; h[1] = m | 127; h.writeUInt32BE(0, 2); h.writeUInt32BE(n, 6); }
  if (!mask) return Buffer.concat([h, p]);
  var key = crypto.randomBytes(4), body = bAlloc(n);
  for (var i = 0; i < n; i++) body[i] = p[i] ^ key[i % 4];
  return Buffer.concat([h, key, body]);
}

// A connection: events 'message' (Buffer, isBinary) and 'close'. mask = true on the client side (clients must mask what they send).
function Conn(socket, mask) {
  EventEmitter.call(this);
  var self = this, buf = bAlloc(0), frag = null, fragBin = false, closed = false;
  this.socket = socket; this.mask = mask; this.alive = true;
  function fail() { self.close(); }
  function onFrame(fin, op, data) {
    if (op === 0x8) { try { socket.write(encode(0x8, data.slice(0, 2), mask)); } catch (e) {} return self.close(); }
    if (op === 0x9) { try { socket.write(encode(0xA, data, mask)); } catch (e) {} return; }
    if (op === 0xA) return;
    if (op === 0x1 || op === 0x2) { frag = [data]; fragBin = op === 0x2; } else if (op === 0x0 && frag) frag.push(data); else return fail();
    if (fin) { var all = Buffer.concat(frag); frag = null; self.emit("message", all, fragBin); }
  }
  this.feed = function (chunk) {
    buf = chunk && chunk.length ? Buffer.concat([buf, chunk]) : buf;
    while (buf.length >= 2) {
      var fin = (buf[0] & 0x80) !== 0, op = buf[0] & 15, masked = (buf[1] & 0x80) !== 0, len = buf[1] & 127, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; if (buf.readUInt32BE(2) !== 0) return fail(); len = buf.readUInt32BE(6); off = 10; }
      if (len > MAX_PAYLOAD) return fail();
      var need = off + (masked ? 4 : 0) + len; if (buf.length < need) return;
      var data = buf.slice(off + (masked ? 4 : 0), need);
      if (masked) { var k = buf.slice(off, off + 4), out = bAlloc(len); for (var i = 0; i < len; i++) out[i] = data[i] ^ k[i % 4]; data = out; }
      buf = buf.slice(need);
      onFrame(fin, op, data);
      if (closed) return;
    }
  };
  socket.on("data", function (d) { self.alive = true; self.feed(d); });
  socket.on("close", function () { if (!closed) { closed = true; self.emit("close"); } });
  socket.on("error", function () { try { socket.destroy(); } catch (e) {} });
  this.close = function () { if (closed) return; try { socket.end(encode(0x8, bAlloc(0), mask)); } catch (e) {} setTimeout(function () { try { socket.destroy(); } catch (e) {} }, 500); };
}
require("util").inherits(Conn, EventEmitter);
Conn.prototype.sendText = function (s) { if (!this.socket.destroyed) this.socket.write(encode(0x1, s, this.mask)); };
Conn.prototype.sendBinary = function (b) { if (!this.socket.destroyed) this.socket.write(encode(0x2, b, this.mask)); };
Conn.prototype.ping = function () { if (!this.socket.destroyed) this.socket.write(encode(0x9, bAlloc(0), this.mask)); };

// Server side: finish the upgrade of an http request. Returns a Conn.
function accept(req, socket, head) {
  var key = req.headers["sec-websocket-key"];
  if (!key || String(req.headers.upgrade || "").toLowerCase() !== "websocket") { socket.destroy(); return null; }
  var acc = crypto.createHash("sha1").update(key + GUID).digest("base64");
  socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + acc + "\r\n\r\n");
  socket.setNoDelay(true);
  var c = new Conn(socket, false);
  if (head && head.length) c.feed(head);
  return c;
}

// Client side: connect to ws:// or wss:// with extra headers. cb(err, Conn).
function connect(urlStr, headers, cb) {
  var u = urlmod.parse(urlStr), secure = u.protocol === "wss:", key = crypto.randomBytes(16).toString("base64"), done = false, raw = bAlloc(0);
  var opts = { host: u.hostname, port: Number(u.port) || (secure ? 443 : 80) };
  var s = secure ? tls.connect(opts) : net.connect(opts);
  function finish(err, conn) { if (done) return; done = true; s.setTimeout(0); if (err) { try { s.destroy(); } catch (e) {} } cb(err, conn); }
  s.setTimeout(10000, function () { finish(new Error("connection timed out")); });
  s.on("error", function (e) { finish(e); });
  s.on("close", function () { finish(new Error("connection closed")); });
  s.on(secure ? "secureConnect" : "connect", function () {
    var h = "GET " + (u.path || "/") + " HTTP/1.1\r\nHost: " + u.host + "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: " + key + "\r\nSec-WebSocket-Version: 13\r\n";
    for (var k in headers || {}) h += k + ": " + headers[k] + "\r\n";
    s.write(h + "\r\n"); s.setNoDelay(true);
  });
  function onData(d) {
    raw = Buffer.concat([raw, d]); var i = raw.toString("binary").indexOf("\r\n\r\n"); if (i < 0) return;
    s.removeListener("data", onData);
    var head = raw.slice(0, i).toString("binary"), rest = raw.slice(i + 4);
    if (!/^HTTP\/1\.1 101/.test(head)) return finish(new Error("refused: " + head.split("\r\n")[0]));
    var want = crypto.createHash("sha1").update(key + GUID).digest("base64");
    if (head.indexOf(want) < 0) return finish(new Error("bad WebSocket handshake"));
    var c = new Conn(s, true); finish(null, c); if (rest.length) c.feed(rest);
  }
  s.on("data", onData);
}

module.exports = { accept: accept, connect: connect, encode: encode, Conn: Conn, alloc: bAlloc, from: bFrom };
