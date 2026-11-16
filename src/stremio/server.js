// Stremio soft-sync layer. Zero dependencies.
// Sits in front of the unmodified Stremio image and ALWAYS lets Stremio through (Umbrel's own login still protects the app).
// It only does two extra things:
//   1. injects one small script into Stremio Web's HTML, and
//   2. serves /_jz/* so that script can save the Stremio login (auth key) on the person's JoolzApp account and restore it
//      after the browser forgets it.
// Nothing here can stall Stremio: no PocketBase lookup happens on the proxy path, every /_jz call has a short timeout, a missing
// pocketbase.env just means "sync is off", and the process never exits to wait for config.
"use strict";
const http = require("http");
const net = require("net");
const fs = require("fs");
const path = require("path");
const pb = require("./pocketbase");

const PORT = +process.env.PORT || 3897;
const UP = new URL(process.env.UPSTREAM || "http://stremio:8080");
const COOKIE = "jz_token";
const MAX_AGE = 90 * 24 * 3600;   // signed in until 90 days after the app was last used (the cookie is renewed with a fresh token, see /_jz/state)
const PB_TIMEOUT = 3000;
const SYNC_JS = fs.readFileSync(path.join(__dirname, "sync.js"));
const TAG = '<script src="/_jz/sync.js" defer></script>';

const within = (ms, p) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error("PocketBase timed out"), { timeout: true })), ms))]);
const readCookie = req => { const m = String(req.headers.cookie || "").match(new RegExp("(?:^|;\\s*)" + COOKIE + "=([^;]+)")); return m ? m[1] : ""; };
const secure = req => /https/i.test(String(req.headers["x-forwarded-proto"] || "")) ? "; Secure" : "";
const setCookie = (req, res, token) => res.setHeader("set-cookie", `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE}${secure(req)}`);
const clearCookie = res => res.setHeader("set-cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
const json = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(obj)); };
async function body(req, max = 20000) {
  let raw = ""; for await (const c of req) { raw += c; if (raw.length > max) throw Object.assign(new Error("too big"), { status: 413 }); }
  try { return JSON.parse(raw || "{}"); } catch { throw Object.assign(new Error("bad json"), { status: 400 }); }
}

/* ---------- login throttle ---------- */
const hits = new Map();
function throttled(req) {
  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  const now = Date.now(); const a = (hits.get(ip) || []).filter(t => now - t < 600e3); a.push(now); hits.set(ip, a);
  if (hits.size > 5000) hits.clear();
  return a.length > 10;
}

/* ---------- who is this (only used by /_jz/*, never by the proxy) ---------- */
const activity = require("./activity");
const cache = new Map();
async function userFor(token) {
  if (!token) return null;
  const c = cache.get(token);
  if (c && Date.now() - c.at < 60e3) return c.u;
  let u = null;
  let fresh = "";
  try { const j = await within(PB_TIMEOUT, pb.verifyToken(token)); u = j.record; fresh = j.token || ""; }
  catch (e) { if (!(e instanceof pb.PBError) || ![400, 401, 403, 404].includes(e.status)) throw e; }
  if (cache.size > 500) cache.clear();
  cache.set(token, { u, at: Date.now(), fresh });
  if (u) activity.touch(u.id);
  return u;
}
const mayUse = u => !!u && (u.isAdmin || !u.portal || u.portal.access !== false);

/* ---------- /_jz/* ---------- */
async function jz(req, res, p) {
  if (p === "/_jz/sync.js") { res.writeHead(200, { "content-type": "application/javascript; charset=utf-8", "cache-control": "no-cache" }); return res.end(SYNC_JS); }
  if (!pb.reload()) return json(res, 200, { enabled: false });   // sync is simply off until pocketbase.env exists
  try {
    const token = readCookie(req);
    if (p === "/_jz/state") {
      let u; try { u = await userFor(token); } catch { return json(res, 200, { enabled: true, store: false }); }   // PocketBase unreachable: try again later
      { const c = cache.get(token); if (u && c && c.fresh && Date.now() - (c.renewedAt || 0) > 3600e3) { c.renewedAt = Date.now(); setCookie(req, res, c.fresh); } }   // slide the 90 days forward
      return json(res, 200, { enabled: true, store: true, signedIn: mayUse(u), name: u ? (u.name || u.email || "") : "" });
    }
    if (p === "/_jz/login" && req.method === "POST") {
      if (throttled(req)) return json(res, 429, { message: "Too many attempts. Try again in a few minutes." });
      const b = await body(req);
      try {
        const j = await within(5000, pb.login(String(b.email || "").trim().toLowerCase(), String(b.password || "")));
        if (!mayUse(j.record)) return json(res, 403, { message: "Your JoolzApp account doesn't have access to Stremio yet." });
        setCookie(req, res, j.token); return json(res, 200, { ok: true });
      } catch (e) {
        if (e instanceof pb.PBError && e.status === 400) return json(res, 400, { message: "That email and password don't match." });
        throw e;
      }
    }
    if (p === "/_jz/logout") { clearCookie(res); return json(res, 200, { ok: true }); }
    if (p === "/_jz/auth") {
      const u = await userFor(token);
      if (!mayUse(u)) return json(res, 401, { message: "Sign in with your JoolzApp account." });
      if (req.method === "GET") { const v = await within(PB_TIMEOUT, pb.getAppPref(u.id)); return json(res, 200, { auth: (v && v.auth) || null }); }
      if (req.method === "PUT") {
        const b = await body(req); const a = b.auth;
        if (a === null) { await within(PB_TIMEOUT, pb.clearAppPref(u.id)); return json(res, 200, { ok: true }); }
        if (!a || typeof a.key !== "string" || a.key.length < 8 || a.key.length > 200) return json(res, 400, { message: "Bad auth key." });
        const user = a.user && typeof a.user === "object" && JSON.stringify(a.user).length < 4000 ? a.user : null;
        await within(PB_TIMEOUT, pb.setAppPref(u.id, { auth: { key: a.key, user }, savedAt: new Date().toISOString() }));
        return json(res, 200, { ok: true });
      }
    }
    return json(res, 404, { message: "Not found." });
  } catch (e) {
    if (e.status === 413 || e.status === 400) return json(res, e.status, { message: e.message });
    console.error("[sync]", e.message);
    return json(res, 503, { message: "JoolzApp sync is not available right now." });   // Stremio itself is unaffected
  }
}

/* ---------- transparent proxy to Stremio Web (adds one <script> to HTML pages) ---------- */
function inject(html) {
  if (html.includes("/_jz/sync.js")) return html;
  const i = html.lastIndexOf("</body>");
  if (i >= 0) return html.slice(0, i) + TAG + html.slice(i);
  const h = html.lastIndexOf("</head>");
  return h >= 0 ? html.slice(0, h) + TAG + html.slice(h) : html + TAG;
}
function proxy(req, res) {
  const wantsHtml = req.method === "GET" && /text\/html/.test(String(req.headers.accept || ""));
  const headers = { ...req.headers, host: UP.host };
  if (wantsHtml) headers["accept-encoding"] = "identity";   // so the HTML can be edited; assets keep their compression
  const o = http.request({ host: UP.hostname, port: UP.port || 80, method: req.method, path: req.url, headers }, r => {
    const html = wantsHtml && r.statusCode === 200 && /text\/html/i.test(String(r.headers["content-type"] || "")) && !r.headers["content-encoding"];
    if (!html) { res.writeHead(r.statusCode, r.headers); return r.pipe(res); }
    const chunks = []; let n = 0;
    r.on("data", c => { n += c.length; chunks.push(c); });
    r.on("end", () => {
      const out = Buffer.from(inject(Buffer.concat(chunks).toString("utf8")), "utf8");
      const h = { ...r.headers, "content-length": out.length }; delete h["transfer-encoding"];
      res.writeHead(200, h); res.end(out);
    });
    r.on("error", () => res.destroy());
  });
  res.on("close", () => { if (!res.writableFinished) o.destroy(); });   // viewer went away mid-stream (common when seeking): free the upstream too
  o.on("error", () => { if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" }); res.end("Stremio is still starting. Try again in a moment."); });
  req.pipe(o);
}

const server = http.createServer((req, res) => {
  const p = req.url.split("?")[0];
  if (p.startsWith("/_jz/")) return void jz(req, res, p);
  proxy(req, res);
});

// WebSocket / upgrade requests go straight through.
server.on("upgrade", (req, socket, head) => {
  const up = net.connect(UP.port || 80, UP.hostname, () => {
    const h = { ...req.headers, host: UP.host };
    up.write(`${req.method} ${req.url} HTTP/1.1\r\n` + Object.entries(h).map(([k, v]) => `${k}: ${v}`).join("\r\n") + "\r\n\r\n");
    if (head && head.length) up.write(head);
    socket.pipe(up).pipe(socket);
  });
  up.on("error", () => socket.destroy()); socket.on("error", () => up.destroy());
});

if (require.main === module) server.listen(PORT, () => console.log(`Stremio sync on :${PORT} -> ${UP.origin} (JoolzApp sync ${pb.reload() ? "on" : "off until pocketbase.env exists; Stremio is never blocked"})`));
module.exports = { server, inject };
