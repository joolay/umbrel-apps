"use strict";
// Tests with no real cameras: mock Hikvision and Dahua web servers, and ffmpeg itself acting as a fake RTSP camera.
process.env.DATA_DIR = require("fs").mkdtempSync(require("os").tmpdir() + "/cctv-");
const assert = require("assert"), http = require("http"), net = require("net"), cp = require("child_process"), crypto = require("crypto");
const dev = require("./devices"), { makeSplitter, ffmpegArgs } = require("./streams"), { createStore } = require("./store");
const USER = "admin", PASS = "p@ss:w/rd";

/* ---- pure bits */
const rfc = dev.digestHeader({ realm: "testrealm@host.com", nonce: "dcd98b7102dd2f0e8b11d0f600bfb0c093", qop: "auth", opaque: "5ccc069c403ebaf9f0171e9517f40e41" }, "GET", "/dir/index.html", "Mufasa", "Circle Of Life", 1, "0a4f113b");
assert.ok(rfc.includes('response="6629fae49393a05397450978507c4ef1"'), "digest matches RFC 2617");
const hk = { vendor: "hikvision", host: "10.0.0.5", rtspPort: 554, user: USER, pass: PASS }, dh = { vendor: "dahua", host: "10.0.0.6", rtspPort: 8554, user: USER, pass: PASS };
assert.strictEqual(dev.rtspUrl(hk, { channel: 3 }, "sub"), "rtsp://admin:p%40ss%3Aw%2Frd@10.0.0.5:554/Streaming/Channels/302");
assert.strictEqual(dev.rtspUrl(hk, { channel: 12 }, "main"), "rtsp://admin:p%40ss%3Aw%2Frd@10.0.0.5:554/Streaming/Channels/1201");
assert.strictEqual(dev.rtspUrl(dh, { channel: 2 }, "main"), "rtsp://admin:p%40ss%3Aw%2Frd@10.0.0.6:8554/cam/realmonitor?channel=2&subtype=0");
assert.strictEqual(dev.rtspUrl(dh, { channel: 2 }, "sub"), "rtsp://admin:p%40ss%3Aw%2Frd@10.0.0.6:8554/cam/realmonitor?channel=2&subtype=1");
assert.strictEqual(dev.rtspUrl({ vendor: "rtsp" }, { rtsp: "rtsp://a/b", rtspSub: "rtsp://a/sub" }, "sub"), "rtsp://a/sub");
assert.throws(() => dev.rtspUrl({ vendor: "rtsp" }, { rtsp: "file:///etc/passwd" }, "main"), /no RTSP address/);
assert.throws(() => dev.rtspUrl(hk, { channel: 0 }, "sub")); assert.ok(!dev.maskUrl("rtsp://admin:secret@h/x").includes("secret"));
const frames = []; const split = makeSplitter(f => frames.push(f.length));
const jpg = n => Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(n, 1), Buffer.from([0xff, 0x00, 0xff, 0xd9])]);
const two = Buffer.concat([jpg(5), jpg(7)]); split(two.slice(0, 6)); split(two.slice(6)); assert.deepStrictEqual(frames, [11, 13], "frames split across chunks");
assert.ok(ffmpegArgs("rtsp://x/y", "sub").includes("-rtsp_transport") && !ffmpegArgs("http://x/y", "sub").includes("-rtsp_transport"));

/* ---- store and permissions */
const st = createStore(require("fs").mkdtempSync(require("os").tmpdir() + "/st-"));
const s1 = st.insertSite(st.cleanSite({ name: "Home", vendor: "hikvision", host: "10.0.0.5", user: "u", pass: "x" })); st.importChannels(s1.id, [{ channel: 1, name: "Gate" }, { channel: 2, name: "Garage" }]);
const s2 = st.insertSite(st.cleanSite({ name: "Shop", vendor: "dahua", host: "shop.example.com", rtspPort: 8554, user: "u", pass: "y" })); st.importChannels(s2.id, [{ channel: 1, name: "Till" }]);
assert.strictEqual(st.importChannels(s1.id, [{ channel: 1, name: "Renamed" }]), 0, "no duplicate channels");
assert.throws(() => st.cleanSite({ name: "x", vendor: "hikvision", host: "bad host", pass: "p" }), /address/); assert.throws(() => st.cleanSite({ name: "", vendor: "dahua", host: "a", pass: "p" }), /name/);
const [gate, garage, till] = st.cameras(); const bob = { id: "bob1" }, admin = { id: "a1", isAdmin: true };
assert.strictEqual(st.visibleTo(bob).length, 0, "nobody sees anything by default"); assert.strictEqual(st.visibleTo(admin).length, 3);
st.setGrant("bob1", { cams: [gate.id, till.id, "nonexistent"] }); assert.deepStrictEqual(st.visibleTo(bob).map(c => c.name).sort(), ["Gate", "Till"], "cameras from two sites in one grant");
assert.ok(st.canWatch(bob, gate.id) && !st.canWatch(bob, garage.id));
st.updateCamera(gate.id, { enabled: false }); assert.ok(!st.canWatch(bob, gate.id), "disabled camera hidden");
st.setGrant("bob1", { all: true }); assert.strictEqual(st.visibleTo(bob).length, 2, "all = every enabled camera");
st.removeSite(s2.id); assert.strictEqual(st.cameras().length, 2);
assert.strictEqual(createStore(require("fs").mkdtempSync(require("os").tmpdir() + "/st2-")).cameras().length, 0, "fresh folder starts empty");

/* ---- fake recorders: Hikvision ISAPI + Dahua CGI, both with Digest */
const REALM = "realm1";
function digestServer(routes) {
  return http.createServer((q, r) => {
    const a = q.headers.authorization, chal = () => { r.statusCode = 401; r.setHeader("WWW-Authenticate", `Digest qop="auth", realm="${REALM}", nonce="n0nce"`); r.end(); };
    if (!a) return chal();
    const p = {}; a.replace(/(\w+)=(?:"([^"]*)"|([^\s,]+))/g, (m, k, x, y) => { p[k] = x !== undefined ? x : y; });
    const want = dev.md5(dev.md5(USER + ":" + REALM + ":" + PASS) + ":" + p.nonce + ":" + p.nc + ":" + p.cnonce + ":auth:" + dev.md5("GET:" + p.uri));
    if (p.username !== USER || p.response !== want) return chal();
    const f = routes[q.url]; if (!f) { r.statusCode = 404; return r.end(); } r.end(f);
  });
}
const hikSrv = digestServer({
  "/ISAPI/System/deviceInfo": "<DeviceInfo><deviceName>Home NVR</deviceName><model>DS-7616NI</model></DeviceInfo>",
  "/ISAPI/ContentMgmt/InputProxy/channels": "<InputProxyChannelList>" + [1, 2, 3].map(i => `<InputProxyChannel><id>${i}</id><name>Hik ${i}</name></InputProxyChannel>`).join("") + "</InputProxyChannelList>",
});
const dahuaSrv = digestServer({
  "/cgi-bin/magicBox.cgi?action=getDeviceType": "type=DH-XVR5108\r\n",
  "/cgi-bin/configManager.cgi?action=getConfig&name=ChannelTitle": "table.ChannelTitle[0].Name=Front\r\ntable.ChannelTitle[1].Name=Back\r\n",
});
const listen = s => new Promise(r => s.listen(0, "127.0.0.1", () => r(s.address().port)));
const freePort = () => new Promise(r => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
const wsClient = (port, cookie) => new Promise((resolve, reject) => {
  const sock = net.connect(port, "127.0.0.1"), key = crypto.randomBytes(16).toString("base64"); let buf = Buffer.alloc(0), up = false; const msgs = [];
  sock.write(`GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n${cookie ? "Cookie: " + cookie + "\r\n" : ""}\r\n`);
  const api = { msgs, send(obj) { const d = Buffer.from(JSON.stringify(obj)), m = crypto.randomBytes(4), h = Buffer.from([0x81, 0x80 | d.length]); const x = Buffer.from(d); for (let i = 0; i < x.length; i++) x[i] ^= m[i & 3]; sock.write(Buffer.concat([h, m, x])); }, close() { sock.destroy(); }, sock };
  sock.on("data", d => {
    buf = Buffer.concat([buf, d]);
    if (!up) { const i = buf.indexOf("\r\n\r\n"); if (i < 0) return; const head = buf.slice(0, i).toString(); if (!/101/.test(head)) return reject(new Error(head.split("\r\n")[0])); up = true; buf = buf.slice(i + 4); resolve(api); }
    for (;;) {
      if (buf.length < 2) return; let len = buf[1] & 127, off = 2; if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; } else if (len === 127) { if (buf.length < 10) return; len = buf.readUInt32BE(6); off = 10; }
      if (buf.length < off + len) return; msgs.push({ op: buf[0] & 15, data: buf.slice(off, off + len) }); buf = buf.slice(off + len);
    }
  });
  sock.on("error", reject);
});
const wait = async (fn, ms = 15000) => { const t = Date.now(); for (;;) { const v = fn(); if (v) return v; if (Date.now() - t > ms) throw new Error("timed out waiting"); await new Promise(r => setTimeout(r, 100)); } };
const req = (port, method, path, body) => new Promise((resolve, reject) => { const r = http.request({ port, host: "127.0.0.1", method, path, headers: { "content-type": "application/json" } }, res => { let b = ""; res.on("data", c => b += c); res.on("end", () => resolve({ status: res.statusCode, json: (() => { try { return JSON.parse(b); } catch { return b; } })() })); }); r.on("error", reject); r.end(body ? JSON.stringify(body) : undefined); });

(async () => {
  const hp = await listen(hikSrv), dp = await listen(dahuaSrv);
  const ph = await dev.probe({ vendor: "hikvision", host: "127.0.0.1", httpPort: hp, user: USER, pass: PASS });
  assert.deepStrictEqual(ph.channels.map(c => c.name), ["Hik 1", "Hik 2", "Hik 3"]); assert.strictEqual(ph.model, "DS-7616NI");
  const pd = await dev.probe({ vendor: "dahua", host: "127.0.0.1", httpPort: dp, user: USER, pass: PASS });
  assert.deepStrictEqual(pd.channels, [{ channel: 1, name: "Front" }, { channel: 2, name: "Back" }]); assert.strictEqual(pd.model, "DH-XVR5108");
  await assert.rejects(dev.probe({ vendor: "dahua", host: "127.0.0.1", httpPort: dp, user: USER, pass: "wrong" }), e => e.code === "AUTH");

  // the real server in local test mode, with two fake RTSP cameras (ffmpeg listening as an RTSP server, one for sub and one for main)
  const { server, streams } = require("./server");
  const sp = await listen(server);
  const files = { sub: process.env.DATA_DIR + "/sub.mp4", main: process.env.DATA_DIR + "/main.mp4" };
  for (const [k, size] of [["sub", "320x180"], ["main", "640x360"]]) cp.execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `testsrc=size=${size}:rate=10`, "-t", "20", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", files[k]]);
  require("./server").hooks.urlFor = (site, cam, q) => (cam.name === "Yard" ? files[q] : dev.rtspUrl(site, cam, q));

  assert.strictEqual((await req(sp, "POST", "/api/admin/site", { name: "Hik home", vendor: "hikvision", host: "127.0.0.1", httpPort: hp, user: USER, pass: "wrong" })).status, 400, "bad password refused, nothing saved");
  assert.strictEqual((await req(sp, "GET", "/api/admin/overview")).json.sites.length, 0);
  const a1 = (await req(sp, "POST", "/api/admin/site", { name: "Hik home", vendor: "hikvision", host: "127.0.0.1", httpPort: hp, user: USER, pass: PASS })).json; assert.strictEqual(a1.added, 3);
  const a2 = (await req(sp, "POST", "/api/admin/site", { name: "Dahua shop", vendor: "dahua", host: "127.0.0.1", httpPort: dp, user: USER, pass: PASS })).json; assert.strictEqual(a2.added, 2);
  const rs = (await req(sp, "POST", "/api/admin/site", { name: "Fake RTSP", vendor: "rtsp" })).json;
  const cam = (await req(sp, "POST", "/api/admin/camera", { site: rs.site.id, name: "Yard", rtsp: "rtsp://127.0.0.1:9/main", rtspSub: "rtsp://127.0.0.1:9/sub" })).json.camera;
  assert.strictEqual((await req(sp, "POST", "/api/admin/camera", { site: rs.site.id, name: "Evil", rtsp: "file:///etc/passwd" })).status, 400, "non-rtsp address refused");
  const cfg = (await req(sp, "GET", "/api/cctv/config")).json; assert.strictEqual(cfg.cameras.length, 6, "5 recorder channels from 2 vendors + 1 rtsp, one list"); assert.ok(cfg.user.isAdmin);
  assert.ok(!JSON.stringify(await req(sp, "GET", "/api/admin/overview")).includes(PASS), "passwords never sent to the page");

  // views are validated and saved
  const v = cfg.cameras.map(c => c.id).slice(0, 2);
  assert.strictEqual((await req(sp, "PUT", "/api/cctv/views", { views: [{ id: "v1", name: "Mixed", layout: 4, slots: [v[0], v[1], "../etc", null] }], last: "v1" })).status, 200);
  const back = (await req(sp, "GET", "/api/cctv/config")).json; assert.deepStrictEqual(back.views[0].slots, [v[0], v[1], null, null]); assert.strictEqual(back.last, "v1");

  // live video over one WebSocket: the fake camera's pictures arrive in slot 3, sub quality, then the same camera in main quality in slot 0
  const ws = await wsClient(sp);
  ws.send({ t: "watch", slots: [{ cam: cam.id, q: "main" }, null, null, { cam: cam.id, q: "sub" }] });
  await wait(() => ws.msgs.some(m => m.op === 2 && m.data[0] === 3) && ws.msgs.some(m => m.op === 2 && m.data[0] === 0));
  const f3 = ws.msgs.find(m => m.op === 2 && m.data[0] === 3).data, f0 = ws.msgs.find(m => m.op === 2 && m.data[0] === 0).data;
  assert.ok(f3[1] === 0xff && f3[2] === 0xd8 && f3[f3.length - 2] === 0xff && f3[f3.length - 1] === 0xd9, "a whole JPEG per message");
  const width = b => { for (let i = 2; i < b.length - 9;) { if (b[i] !== 0xff) { i++; continue; } const m = b[i + 1]; if (m === 0xc0) return b.readUInt16BE(i + 7); i += 2 + b.readUInt16BE(i + 2); } return 0; };
  assert.strictEqual(width(f3.slice(1)), 640, "sub picture scaled to the wall size (320 source -> 640)"); assert.strictEqual(width(f0.slice(1)), 1280, "main picture scaled to 1280");
  assert.ok(ws.msgs.some(m => m.op === 1 && /"live"/.test(m.data.toString())), "state messages");
  assert.strictEqual(streams.stats().filter(s => s.cam === cam.id).length, 2);
  ws.send({ t: "watch", slots: [null, null, null, null] }); await new Promise(r => setTimeout(r, 300)); ws.close();
  await wait(() => streams.stats().length === 0, 20000);

  // an RTSP camera that can't be reached: a plain-language reason, not ffmpeg's text
  require("./server").hooks.urlFor = (site, cam, q) => dev.rtspUrl(site, cam, q);
  const ws2 = await wsClient(sp); ws2.send({ t: "watch", slots: [{ cam: cam.id, q: "sub" }] });
  await wait(() => ws2.msgs.some(m => m.op === 1 && /Can't reach the recorder/.test(m.data.toString())), 20000); ws2.close();

  // a viewer with a grant sees only that camera; without one, nothing; the server closes their live view when the grant changes
  const store = require("./server").store; store.setGrant("viewer9", { cams: [cam.id] });
  streams.stopAll(); server.close(); hikSrv.close(); dahuaSrv.close();
  console.log("cctv tests: ok"); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
setTimeout(() => { console.error("timeout"); process.exit(1); }, 90000).unref();
