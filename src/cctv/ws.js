// A very small WebSocket server (RFC 6455), no dependencies. One connection carries every tile of a viewer's wall, so sixteen cameras need
// one connection, not sixteen (browsers allow only six plain HTTP connections per address).
"use strict";
const crypto = require("crypto");
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function accept(req, socket) {
  const key = req.headers["sec-websocket-key"];
  if (!key || String(req.headers.upgrade || "").toLowerCase() !== "websocket") { socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"); return false; }
  socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + crypto.createHash("sha1").update(key + GUID).digest("base64") + "\r\n\r\n");
  socket.setNoDelay(true);
  return true;
}
function encode(opcode, payload) {
  const n = payload.length, head = n < 126 ? Buffer.from([0x80 | opcode, n]) : n < 65536 ? Buffer.from([0x80 | opcode, 126, n >> 8, n & 255]) : (() => { const b = Buffer.alloc(10); b[0] = 0x80 | opcode; b[1] = 127; b.writeUInt32BE(Math.floor(n / 4294967296), 2); b.writeUInt32BE(n >>> 0, 6); return b; })();
  return Buffer.concat([head, payload]);
}

// Wraps an upgraded socket. Handlers: onText(string), onClose(). Methods: sendText, sendBinary, backlog, close.
function wrap(socket, h) {
  let buf = Buffer.alloc(0), frag = null, closed = false;
  const end = () => { if (closed) return; closed = true; try { socket.destroy(); } catch {} h.onClose && h.onClose(); };
  const api = {
    sendText: s => { if (!closed) socket.write(encode(1, Buffer.from(s))); },
    sendBinary: b => { if (!closed) socket.write(encode(2, b)); },
    backlog: () => socket.writableLength,
    close: () => { if (!closed) { try { socket.write(encode(8, Buffer.alloc(0))); } catch {} setTimeout(end, 200); } },
    get closed() { return closed; },
  };
  socket.on("data", d => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (buf.length < 2) return;
      const fin = !!(buf[0] & 0x80), op = buf[0] & 15, masked = !!(buf[1] & 0x80); let len = buf[1] & 127, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = buf.readUInt32BE(2) * 4294967296 + buf.readUInt32BE(6); off = 10; }
      if (len > 65536 || !masked) return end();                       // clients only send small commands, and always masked
      if (buf.length < off + 4 + len) return;
      const mask = buf.slice(off, off + 4), data = Buffer.from(buf.slice(off + 4, off + 4 + len));
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
      buf = buf.slice(off + 4 + len);
      if (op === 8) { try { socket.write(encode(8, Buffer.alloc(0))); } catch {} return end(); }
      if (op === 9) { socket.write(encode(10, data)); continue; }
      if (op === 10) continue;
      if (op === 1 || op === 2) frag = { op, parts: [data] }; else if (op === 0 && frag) frag.parts.push(data); else return end();
      if (fin) { const full = Buffer.concat(frag.parts); const o = frag.op; frag = null; if (o === 1 && h.onText) h.onText(full.toString("utf8")); }
    }
  });
  socket.on("close", end); socket.on("error", end);
  socket.setTimeout(0);
  return api;
}
module.exports = { accept, wrap, encode };
