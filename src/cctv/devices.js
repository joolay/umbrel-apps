// Talks to Hikvision and Dahua recorders/cameras: HTTP Digest login, channel lists, and the RTSP address of each camera.
// No dependencies. A "site" is one recorder (or one stand-alone camera) at one place; its cameras are numbered channels.
"use strict";
const http = require("http");
const crypto = require("crypto");

const md5 = s => crypto.createHash("md5").update(s).digest("hex");
const tag = (xml, name) => { const m = new RegExp("<" + name + "(?:\\s[^>]*)?>([^<]*)</" + name + ">", "i").exec(xml || ""); return m ? m[1].trim() : ""; };
const blocks = (xml, name) => { const out = [], re = new RegExp("<" + name + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + name + ">", "gi"); let m; while ((m = re.exec(xml || ""))) out.push(m[1]); return out; };
const cleanHost = h => typeof h === "string" && /^[A-Za-z0-9]([A-Za-z0-9.\-]{0,251}[A-Za-z0-9])?$/.test(h) ? h : null;
const cleanPort = n => { n = Number(n); return n >= 1 && n <= 65535 && n === Math.floor(n) ? n : null; };
const VENDORS = { hikvision: "Hikvision", dahua: "Dahua", rtsp: "Other (RTSP address)" };

/* ---------- HTTP Digest (MD5), with a guard against locking the recorder ---------- */
function parseChallenge(h) {
  if (!/^\s*Digest\s/i.test(h || "")) return null;
  const o = {}, re = /(\w+)=(?:"([^"]*)"|([^\s,]+))/g; let m;
  while ((m = re.exec(h))) o[m[1].toLowerCase()] = m[2] !== undefined ? m[2] : m[3];
  return o.nonce && o.realm ? o : null;
}
function digestHeader(ch, method, uri, user, pass, nc, cnonce) {
  const ha1 = md5(user + ":" + ch.realm + ":" + pass), ha2 = md5(method + ":" + uri), qop = /auth/.test(ch.qop || "") ? "auth" : "";
  const nch = ("00000000" + nc.toString(16)).slice(-8);
  const resp = qop ? md5(ha1 + ":" + ch.nonce + ":" + nch + ":" + cnonce + ":" + qop + ":" + ha2) : md5(ha1 + ":" + ch.nonce + ":" + ha2);
  return `Digest username="${user}", realm="${ch.realm}", nonce="${ch.nonce}", uri="${uri}", response="${resp}"` + (qop ? `, qop=auth, nc=${nch}, cnonce="${cnonce}"` : "") + (ch.opaque ? `, opaque="${ch.opaque}"` : "") + ", algorithm=MD5";
}
function rawGet(host, port, path, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    const req = http.get({ host, port, path, headers: headers || {}, agent: false }, res => {
      const chunks = []; let size = 0;
      res.on("data", c => { size += c.length; if (size > 2e6) { req.destroy(); if (!done) { done = true; reject(new Error("Answer too large")); } return; } chunks.push(c); });
      res.on("end", () => { if (!done) { done = true; resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }); } });
      res.on("error", e => { if (!done) { done = true; reject(e); } });
    });
    req.setTimeout(timeoutMs || 8000, () => { req.destroy(); if (!done) { done = true; reject(new Error("Timed out talking to " + host)); } });
    req.on("error", e => { if (!done) { done = true; reject(e); } });
  });
}
// A wrong password is tried once and never again (recorders lock the account for ~30 minutes after a few bad logins).
function makeClient(dev, opts = {}) {
  let ch = null, nc = 0, bad = false;
  const send = async (path, fresh) => {
    const h = { "User-Agent": "joolay-cctv" };
    if (ch) { nc++; h.Authorization = digestHeader(ch, "GET", path, dev.user, dev.pass, nc, crypto.randomBytes(8).toString("hex")); }
    const r = await rawGet(dev.host, dev.httpPort || 80, path, h, opts.timeoutMs);
    if (r.status !== 401) return r;
    const c = parseChallenge(r.headers["www-authenticate"] || "");
    if (!c) throw Object.assign(new Error("The device refused the request (HTTP 401)"), { code: "AUTH" });
    if (fresh) { bad = true; ch = null; throw Object.assign(new Error("Wrong user name or password (not tried again, to avoid locking the device)"), { code: "AUTH" }); }
    ch = c; nc = 0; return send(path, true);
  };
  return {
    async get(path) {
      if (bad) throw Object.assign(new Error("Wrong user name or password. Fix it on the site."), { code: "AUTH" });
      const r = await send(path, false);
      if (r.status === 404) throw Object.assign(new Error("Not found on the device: " + path), { code: "NOTFOUND" });
      if (r.status >= 400) throw new Error("The device answered HTTP " + r.status);
      return r;
    },
  };
}

/* ---------- reading a recorder ---------- */
const parseChannelsXml = (xml, item) => blocks(xml, item).map(b => { const id = parseInt(tag(b, "id"), 10); return { channel: id, name: tag(b, "name") || ("Camera " + id) }; }).filter(c => c.channel > 0);

async function probeHikvision(dev) {
  const c = makeClient(dev);
  const info = (await c.get("/ISAPI/System/deviceInfo")).body.toString("utf8");
  const model = tag(info, "model"), name = tag(info, "deviceName");
  let ch = [];
  try { ch = parseChannelsXml((await c.get("/ISAPI/ContentMgmt/InputProxy/channels")).body.toString("utf8"), "InputProxyChannel"); } catch (e) { if (e.code === "AUTH") throw e; }
  if (!ch.length) { try { ch = parseChannelsXml((await c.get("/ISAPI/System/Video/inputs/channels")).body.toString("utf8"), "VideoInputChannel"); } catch (e) { if (e.code === "AUTH") throw e; } }
  return { model, name, channels: ch.length ? ch : [{ channel: 1, name: "Camera 1" }] };
}
async function probeDahua(dev) {
  const c = makeClient(dev);
  const kv = t => { const o = {}; String(t).split(/\r?\n/).forEach(l => { const i = l.indexOf("="); if (i > 0) o[l.slice(0, i).trim()] = l.slice(i + 1).trim(); }); return o; };
  const t = kv((await c.get("/cgi-bin/magicBox.cgi?action=getDeviceType")).body.toString("utf8"));
  let ch = [];
  try {
    const titles = kv((await c.get("/cgi-bin/configManager.cgi?action=getConfig&name=ChannelTitle")).body.toString("utf8"));
    for (const k of Object.keys(titles)) { const m = /^table\.ChannelTitle\[(\d+)\]\.Name$/.exec(k); if (m) ch.push({ channel: +m[1] + 1, name: titles[k] || ("Camera " + (+m[1] + 1)) }); }
  } catch (e) { if (e.code === "AUTH") throw e; }
  ch.sort((a, b) => a.channel - b.channel);
  return { model: t.type || "", name: "", channels: ch.length ? ch : [{ channel: 1, name: "Camera 1" }] };
}
// Checks the login and lists the cameras. For "Other (RTSP address)" there is nothing to ask the device.
async function probe(site) {
  if (site.vendor === "hikvision") return probeHikvision(site);
  if (site.vendor === "dahua") return probeDahua(site);
  return { model: "", name: "", channels: [] };
}

/* ---------- RTSP addresses ---------- */
// quality "main" = full size stream, "sub" = small stream (what the wall uses).
function rtspUrl(site, cam, quality) {
  const sub = quality !== "main";
  if (site.vendor === "rtsp") {
    const u = String(sub ? (cam.rtspSub || cam.rtsp) : cam.rtsp || "");
    if (!/^rtsps?:\/\//i.test(u)) throw new Error("This camera has no RTSP address");
    return u;
  }
  const auth = encodeURIComponent(site.user) + ":" + encodeURIComponent(site.pass) + "@", base = "rtsp://" + auth + site.host + ":" + (site.rtspPort || 554);
  const ch = cam.channel | 0;
  if (!(ch > 0 && ch < 1000)) throw new Error("Bad channel");
  if (site.vendor === "hikvision") return base + "/Streaming/Channels/" + (ch * 100 + (sub ? 2 : 1));
  if (site.vendor === "dahua") return base + "/cam/realmonitor?channel=" + ch + "&subtype=" + (sub ? 1 : 0);
  throw new Error("Unknown make");
}
const maskUrl = u => String(u).replace(/\/\/[^/@]*@/, "//***@");

module.exports = { VENDORS, cleanHost, cleanPort, parseChallenge, digestHeader, makeClient, probe, rtspUrl, maskUrl, md5 };
