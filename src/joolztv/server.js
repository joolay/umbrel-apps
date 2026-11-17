// JoolzTV: a TV-style front end for the Stremio streaming server that follows your JoolzApp accounts.
// Zero-dependency Node server.
//  - The household (up to 12 profiles) is stored here; every profile is one JoolzApp (PocketBase) account.
//  - Each profile's My List and watch progress live in <data>/users/<accountId>.json.
//  - The streaming server is never published: video goes through /s/<stream-token>/..., which only a signed-in profile can obtain.
//  - Serves the UI: a modern build for browsers and a compat build (Chromium 53 / LG webOS 4) picked from the User-Agent.
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const test = process.env.NODE_ENV === "test";
const pb = test && process.env.JTV_PB ? require(path.resolve(process.env.JTV_PB)) : require("./pocketbase");
const guardians = test && process.env.JTV_PB ? { ageOf: () => null, isMinor: () => false, statusOf: async () => ({ minor: false, approved: true }) } : require("./guardians");
const activity = test && process.env.JTV_PB ? { touch() {} } : require("./activity");

const PORT = +process.env.PORT || 3900;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, "data"));
const UI_DIR = path.resolve(process.env.UI_DIR || path.join(__dirname, "ui"));
const DIST_DIR = path.resolve(process.env.UI_DIST || path.join(__dirname, "dist"));
const UPSTREAM = new URL(process.env.STREAM_UPSTREAM || "http://server:11470");
const INTERNAL = process.env.STREAM_INTERNAL || "http://127.0.0.1:11470";   // how the streaming server reaches itself (for transcoding)
const REQUIRE_ACCOUNTS = !/^(0|false|no)$/i.test(process.env.REQUIRE_ACCOUNTS || "1");
const APP_NAME = process.env.POCKETBASE_APP_NAME || "JoolzTV";
const MAX_PROFILES = 12, MAX_BODY = 2 * 1024 * 1024, MAX_RESUME = 200, MAX_LIST = 500, STREAM_TTL = 12 * 3600e3;
const USERS_DIR = path.join(DATA_DIR, "users");
fs.mkdirSync(USERS_DIR, { recursive: true });

/* ---------- small helpers ---------- */
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".webmanifest": "application/manifest+json", ".ico": "image/x-icon", ".woff2": "font/woff2" };
const send = (res, code, obj, extra) => { res.writeHead(code, Object.assign({ "content-type": "application/json", "cache-control": "no-store" }, extra || {})); res.end(JSON.stringify(obj)); };
function readBody(req, max = MAX_BODY) {
  return new Promise((ok, bad) => {
    const chunks = []; let size = 0;
    req.on("data", c => { size += c.length; if (size > max) { bad(new Error("too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => ok(Buffer.concat(chunks))); req.on("error", bad);
  });
}
async function jsonBody(req) { const t = (await readBody(req)).toString(); if (!t) return {}; try { return JSON.parse(t); } catch { throw Object.assign(new Error("bad json"), { status: 400 }); } }
const attempts = new Map();
function throttled(req, key, max, windowMs) {
  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  const k = key + ":" + ip, now = Date.now();
  const a = (attempts.get(k) || []).filter(t => now - t < windowMs); a.push(now); attempts.set(k, a);
  if (attempts.size > 2000) attempts.clear();
  return a.length > max;
}
const validEmail = e => typeof e === "string" && e.length <= 200 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
function writeJson(file, obj) { const tmp = file + "." + process.pid + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(obj)); fs.renameSync(tmp, file); }
function readJson(file, dflt) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return dflt; } }

/* ---------- who may open the app (same rules as every JoolzApp app) ---------- */
function gateOf(u) {
  if (u.isAdmin) return { ok: true };
  if (u.guard && u.guard.minor && !u.guard.approved) return { ok: false, reason: "guardian_pending", message: "Waiting for approval of your account. Ask a parent or guardian to approve you on the JoolzApp dashboard." };
  if (!u.portal) return u.access ? { ok: true } : { ok: false, reason: "no_access", message: "The admin hasn't opened " + APP_NAME + " to you yet. Ask them to give you access, then try again." };
  const a = u.portal.app;
  if (a && a.enabled === false) return { ok: false, reason: "disabled", message: APP_NAME + " is switched off right now." };
  if (a && a.maintenance) return { ok: false, reason: "maintenance", message: a.message || APP_NAME + " is under maintenance. Try again soon." };
  if (!u.portal.access) return { ok: false, reason: "no_access", message: "You need approval to use " + APP_NAME + ". Open the JoolzApp dashboard, request access, then try again." };
  return { ok: true };
}
const publicUser = u => ({ id: u.id, email: u.email || "", name: u.name || "", isAdmin: !!u.isAdmin });
async function withGuard(u) { if (u) u.guard = await guardians.statusOf(u).catch(() => ({ minor: guardians.isMinor(u), approved: !guardians.isMinor(u) })); return u; }

/* ---------- sessions: header token, 90-day sign-in renewed on use ---------- */
const tokenCache = new Map(), checking = new Map();
const tokenOf = req => String(req.headers["x-jtv-token"] || "").trim();
function verifyFresh(t, prev) {
  if (checking.has(t)) return checking.get(t);
  const p = (async () => {
    try {
      const j = await pb.verifyToken(t);
      await withGuard(j.record);
      activity.touch(j.record.id);
      const e = { user: j.record, at: Date.now(), fresh: j.token, renewedAt: prev && prev.renewedAt || 0 };
      tokenCache.set(t, e); if (tokenCache.size > 300) tokenCache.delete(tokenCache.keys().next().value);
      return e;
    } catch (e) {
      if (e instanceof pb.PBError && [400, 401, 403, 404].includes(e.status)) { const n = { user: null, at: Date.now() }; tokenCache.set(t, n); return n; }
      throw e;
    } finally { checking.delete(t); }
  })();
  checking.set(t, p); return p;
}
async function currentUser(req) {
  const t = tokenOf(req); if (!t) return null;
  let c = tokenCache.get(t); const age = c ? Date.now() - c.at : Infinity;
  if (c && age < 15000) { if (c.user) req._renew = c; return c.user; }
  if (c && c.user && age < 600000) { verifyFresh(t, c).catch(() => {}); req._renew = c; return c.user; }
  c = await verifyFresh(t, c); if (c.user) req._renew = c; return c.user;
}
/* returns the signed-in user, or answers 401/403/503 itself and returns null */
async function requireUser(req, res) {
  if (!pb.enabled) { send(res, 503, { code: "accounts_unavailable", message: "Accounts aren't set up yet." }); return null; }
  let u; try { u = await currentUser(req); } catch (e) { send(res, e instanceof pb.PBError && e.status === 0 ? 503 : 502, { code: "accounts_unavailable", message: e.message }); return null; }
  if (!u) { send(res, 401, { code: "signin_required", message: "Sign in to continue." }); return null; }
  const g = gateOf(u); if (!g.ok) { send(res, 403, { code: g.reason, message: g.message }); return null; }
  return u;
}

/* ---------- household: up to 12 profiles, one JoolzApp account each ---------- */
const HH_FILE = path.join(DATA_DIR, "household.json");
const hh = () => { const h = readJson(HH_FILE, { profiles: {} }); if (!h.profiles) h.profiles = {}; return h; };
const live = h => Object.keys(h.profiles).map(k => h.profiles[k]).filter(p => !p.deleted).sort((a, b) => (a.created || 0) - (b.created || 0));
const profileOf = (h, userId) => live(h).filter(p => p.userId === userId)[0] || null;
const COLORS = ["#0a84ff", "#30d158", "#ff9f0a", "#bf5af2", "#ff375f", "#64d2ff", "#ffd60a", "#ac8e68", "#5e5ce6", "#32ade6", "#ff6482", "#63e6be"];
const pubProfile = (p, selfId) => ({ id: p.id, name: p.name, color: p.color, owner: !!p.owner, self: p.userId === selfId });

async function householdRoutes(req, res, p) {
  const h = hh(), list = live(h);
  if (p === "/api/household" && req.method === "GET") {
    if (!list.length) return send(res, 200, { empty: true, max: MAX_PROFILES, profiles: [] });
    const u = await requireUser(req, res); if (!u) return;
    if (!profileOf(h, u.id) && !u.isAdmin) return send(res, 403, { code: "not_in_household", message: "This account isn't part of this household. Ask a household member to add you." });
    return send(res, 200, { empty: false, max: MAX_PROFILES, profiles: list.map(x => pubProfile(x, u.id)) });
  }
  if (p === "/api/household/profiles" && req.method === "POST") {
    if (throttled(req, "addprofile", 20, 600e3)) return send(res, 429, { code: "slow_down", message: "Too many attempts. Try again in a few minutes." });
    const body = await jsonBody(req);
    let caller = null;
    if (list.length) { caller = await requireUser(req, res); if (!caller) return; if (!profileOf(h, caller.id) && !caller.isAdmin) return send(res, 403, { code: "not_in_household", message: "Only household members can add profiles." }); }
    if (list.length >= MAX_PROFILES) return send(res, 409, { code: "household_full", message: "A household can have up to " + MAX_PROFILES + " profiles." });
    const email = String(body.email || "").trim().toLowerCase();
    if (!validEmail(email) || !body.password) return send(res, 400, { code: "bad_login", message: "Enter that person's JoolzApp email and password." });
    let j;
    try { j = await pb.login(email, String(body.password)); await withGuard(j.record); }
    catch (e) { if (e instanceof pb.PBError && e.status === 400) return send(res, 400, { code: "bad_login", message: "That email and password don't match a JoolzApp account." }); throw e; }
    const g = gateOf(j.record); if (!g.ok) return send(res, 403, { code: g.reason, message: g.message });
    if (profileOf(h, j.record.id)) return send(res, 409, { code: "already_member", message: "That account already has a profile in this household." });
    const now = Date.now(), id = crypto.randomBytes(5).toString("hex");
    const name = String(body.name || j.record.name || email.split("@")[0]).trim().slice(0, 16) || "Profile";
    const used = list.map(x => x.color), color = /^#[0-9a-f]{6}$/i.test(body.color || "") ? body.color : (COLORS.filter(c => used.indexOf(c) < 0)[0] || COLORS[list.length % COLORS.length]);
    h.profiles[id] = { id, userId: j.record.id, name, color, owner: !list.length, created: now, ts: now };
    writeJson(HH_FILE, h);
    return send(res, 201, { profile: pubProfile(h.profiles[id], j.record.id), token: j.token, user: publicUser(j.record), profiles: live(h).map(x => pubProfile(x, j.record.id)) });
  }
  const m = /^\/api\/household\/profiles\/([a-f0-9]{4,20})$/.exec(p);
  if (m && (req.method === "PATCH" || req.method === "DELETE")) {
    const u = await requireUser(req, res); if (!u) return;
    const target = h.profiles[m[1]]; if (!target || target.deleted) return send(res, 404, { code: "not_found", message: "No such profile." });
    const me = profileOf(h, u.id);
    if (!(u.isAdmin || target.userId === u.id || (me && me.owner))) return send(res, 403, { code: "forbidden", message: "Only that person or the household owner can change this profile." });
    if (req.method === "PATCH") {
      const body = await jsonBody(req);
      if (typeof body.name === "string" && body.name.trim()) target.name = body.name.trim().slice(0, 16);
      if (/^#[0-9a-f]{6}$/i.test(body.color || "")) target.color = body.color;
      target.ts = Date.now(); writeJson(HH_FILE, h);
      return send(res, 200, { profile: pubProfile(target, u.id) });
    }
    target.deleted = true; target.ts = Date.now();
    const rest = live(h); if (target.owner && rest.length) { rest[0].owner = true; } target.owner = false;
    writeJson(HH_FILE, h);
    try { fs.unlinkSync(path.join(USERS_DIR, target.userId.replace(/[^a-zA-Z0-9_-]/g, "") + ".json")); } catch {}
    return send(res, 200, { ok: true, profiles: rest.map(x => pubProfile(x, u.id)) });
  }
  return send(res, 404, { code: "not_found" });
}

/* ---------- per-account data: My List + watch progress (newest entry wins) ---------- */
const userFile = id => path.join(USERS_DIR, String(id).replace(/[^a-zA-Z0-9_-]/g, "") + ".json");
const validEntry = e => e && typeof e === "object" && !Array.isArray(e) && typeof e.ts === "number" && isFinite(e.ts);
function mergeMap(cur, src, cap) {
  Object.keys(src || {}).forEach(id => { if (id.length <= 64 && validEntry(src[id]) && (!cur[id] || src[id].ts > (cur[id].ts || 0))) cur[id] = src[id]; });
  const ids = Object.keys(cur);
  if (ids.length > cap) ids.sort((a, b) => (cur[b].ts || 0) - (cur[a].ts || 0)).slice(cap).forEach(id => { delete cur[id]; });
  return cur;
}
function userData(id) { const d = readJson(userFile(id), {}); return { resume: d.resume || {}, list: d.list || {} }; }
function syncRoutes(req, res, p, u) {
  if (p === "/api/state" && req.method === "GET") return send(res, 200, { state: userData(u.id) });
  return (async () => {
    const body = await jsonBody(req), st = body.state || {}, d = userData(u.id);
    mergeMap(d.resume, st.resume, MAX_RESUME); mergeMap(d.list, st.list, MAX_LIST);
    writeJson(userFile(u.id), d);
    send(res, 200, { state: d });
  })();
}

/* ---------- streaming server behind the sign-in ---------- */
const SECRET_FILE = path.join(DATA_DIR, "secret.key");
let SECRET = (() => { try { const s = fs.readFileSync(SECRET_FILE, "utf8").trim(); if (s.length >= 32) return s; } catch {} const s = crypto.randomBytes(32).toString("hex"); fs.writeFileSync(SECRET_FILE, s, { mode: 0o600 }); return s; })();
const b64u = b => Buffer.from(b).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
const mac = s => b64u(crypto.createHmac("sha256", SECRET).update(s).digest()).slice(0, 27);
function mintStream(userId) { const exp = Date.now() + STREAM_TTL, body = b64u(userId) + "." + exp.toString(36); return { st: body + "." + mac(body), exp }; }
function checkStream(st) {
  const parts = String(st || "").split(".");
  if (parts.length !== 3) return false;
  const body = parts[0] + "." + parts[1], good = mac(body);
  if (parts[2].length !== good.length || !crypto.timingSafeEqual(Buffer.from(parts[2]), Buffer.from(good))) return false;
  return parseInt(parts[1], 36) > Date.now();
}
const ALLOWED_UPSTREAM = /^\/(?:[0-9a-fA-F]{40}\/|hlsv2\/|settings$|stats\.json$)/;
const HOP = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-authenticate", "proxy-authorization", "te", "trailer"]);
function proxyStream(req, res, st, rest) {
  if (!checkStream(st)) return send(res, 401, { code: "stream_token", message: "Stream session expired. Reload the title." });
  const pathOnly = rest.split("?")[0];
  if (pathOnly === "/opensubHash") {   // subtitle fingerprint of a torrent file the streaming server already serves; never an arbitrary URL
    const vu = new URLSearchParams(rest.split("?")[1] || "").get("videoUrl") || "";
    if (vu.indexOf(INTERNAL + "/") !== 0 || !/^[0-9a-fA-F]{40}\/-?\d+(\?|$)/.test(vu.slice(INTERNAL.length + 1))) return send(res, 400, { code: "bad_request", message: "Not a file this server streams." });
  } else if (!ALLOWED_UPSTREAM.test(pathOnly)) return send(res, 404, { code: "not_found" });
  if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { code: "method" });
  const headers = {};
  ["range", "accept", "accept-encoding", "user-agent", "if-range", "if-none-match", "if-modified-since"].forEach(k => { if (req.headers[k]) headers[k] = req.headers[k]; });
  const wantsText = /\.m3u8(\?|$)/.test(rest); if (wantsText) delete headers["accept-encoding"];
  const up = http.request({ hostname: UPSTREAM.hostname, port: UPSTREAM.port || 80, path: rest, method: req.method, headers }, ur => {
    const ct = String(ur.headers["content-type"] || "");
    if (/mpegurl|m3u8/i.test(ct) || wantsText) {      // playlists: keep every URL inside the signed-in prefix
      const chunks = []; ur.on("data", c => chunks.push(c));
      ur.on("end", () => {
        const base = "/s/" + st;
        const text = Buffer.concat(chunks).toString("utf8").split(/\r?\n/).map(l => {
          if (!l || l[0] === "#") return l.replace(/URI="(\/[^"]*)"/g, (m, u) => 'URI="' + base + u + '"');
          return l[0] === "/" ? base + l : l.replace(/^https?:\/\/(?:127\.0\.0\.1|localhost|server)(?::\d+)?/, base);
        }).join("\n");
        const h2 = {}; Object.keys(ur.headers).forEach(k => { if (!HOP.has(k) && k !== "content-length" && k !== "content-encoding") h2[k] = ur.headers[k]; });
        h2["content-length"] = Buffer.byteLength(text); h2["cache-control"] = "no-store";
        res.writeHead(ur.statusCode, h2); res.end(text);
      });
      return;
    }
    const h2 = {}; Object.keys(ur.headers).forEach(k => { if (!HOP.has(k)) h2[k] = ur.headers[k]; });
    res.writeHead(ur.statusCode, h2); ur.pipe(res);
    res.on("close", () => ur.destroy());
  });
  up.on("error", e => { if (!res.headersSent) send(res, 502, { code: "stream_server_down", message: "The streaming server isn't reachable (" + (e.code || e.message) + ")." }); else res.destroy(); });
  req.on("close", () => up.destroy());
  up.end();
}

/* ---------- the UI: compat build for old TVs, modern build for everything else ---------- */
function wantsCompat(req, url) {
  const q = url.searchParams;
  if (q.get("modern") === "1") return false;
  if (q.get("compat") === "1" || q.get("tv") === "1") return true;
  const ua = String(req.headers["user-agent"] || "");
  if (/Web0S|webOS|SMART-TV|SmartTV|NetCast|HbbTV/i.test(ua)) return true;
  const m = /(?:Chrome|Chromium)\/(\d+)/.exec(ua);
  return !!m && +m[1] < 70;
}
function uiRoot(compat) {
  const d = path.join(DIST_DIR, compat ? "compat" : "modern");
  return fs.existsSync(d) ? d : UI_DIR;       // no build (local dev): serve the source, which is written to run on old browsers
}
function serveStatic(req, res, pathname, root) {
  if (pathname === "/") pathname = "/index.html";
  const file = path.normalize(path.join(root, pathname));
  if (file !== root && file.indexOf(root + path.sep) !== 0) { res.writeHead(403); return res.end("Forbidden"); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { "content-type": "text/plain" }); return res.end("Not found"); }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { "content-type": TYPES[ext] || "application/octet-stream", "cache-control": ext === ".png" || ext === ".svg" ? "public, max-age=3600" : "no-cache", "content-length": st.size, "vary": "User-Agent" });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(file).pipe(res);
  });
}
const configJs = () => "window.FLIX_CONFIG = " + JSON.stringify({ internalServerUrl: INTERNAL, appName: APP_NAME, accounts: REQUIRE_ACCOUNTS }) + ";\nwindow.JTV = { backend: true, maxProfiles: " + MAX_PROFILES + " };\n";

/* ---------- account routes (public, throttled) ---------- */
async function accountRoutes(req, res, p) {
  if (!pb.enabled) return send(res, 503, { code: "accounts_unavailable", message: "Accounts aren't set up yet. Ask the admin to connect PocketBase in Portal Admin." });
  try {
    if (p === "/api/account/login" && req.method === "POST") {
      if (throttled(req, "login", 10, 600e3)) return send(res, 429, { code: "slow_down", message: "Too many attempts. Try again in a few minutes." });
      const body = await jsonBody(req);
      try {
        const j = await pb.login(String(body.email || "").trim().toLowerCase(), String(body.password || ""));
        await withGuard(j.record);
        const g = gateOf(j.record); if (!g.ok) return send(res, 403, { code: g.reason, message: g.message });
        return send(res, 200, { token: j.token, user: publicUser(j.record) });
      } catch (e) { if (e instanceof pb.PBError && e.status === 400) return send(res, 400, { code: "bad_login", message: "That email and password don't match." }); throw e; }
    }
    if (p === "/api/account/forgot" && req.method === "POST") {
      if (throttled(req, "forgot", 5, 3600e3)) return send(res, 429, { code: "slow_down", message: "Too many attempts. Try again later." });
      const email = String((await jsonBody(req)).email || "").trim().toLowerCase();
      if (validEmail(email)) { try { await pb.requestPasswordReset(email); } catch {} }
      return send(res, 200, { ok: true, message: "If that account exists, a password reset email has been sent." });
    }
    if (p === "/api/account/me" && req.method === "GET") {
      const u = await requireUser(req, res); if (!u) return;
      return send(res, 200, { user: publicUser(u) });
    }
    return send(res, 404, { code: "not_found" });
  } catch (e) {
    if (e instanceof pb.PBError) { console.error("PocketBase:", e.message); return send(res, e.status === 0 ? 503 : 502, { code: "accounts_unavailable", message: e.message }); }
    throw e;
  }
}

const server = http.createServer(async (req, res) => {
  { // hand back a renewed token when this request proved who the person is (keeps "90 days since you last used it" going)
    const wh = res.writeHead;
    res.writeHead = function (...a) {
      const e = req._renew;
      if (e && e.fresh && e.fresh !== tokenOf(req) && !res.headersSent && Date.now() - e.renewedAt > 3600e3) { e.renewedAt = Date.now(); res.setHeader("x-jtv-renew", e.fresh); res.setHeader("access-control-expose-headers", "x-jtv-renew"); }
      return wh.apply(this, a);
    };
  }
  try {
    const url = new URL(req.url, "http://x"), p = decodeURIComponent(url.pathname);
    if (p === "/healthz") { res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "no-store" }); return res.end(JSON.stringify({ ok: true, app: "joolztv" })); }
    if (p === "/config.js") { res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" }); return res.end(configJs()); }
    const sm = /^\/s\/([^/]+)(\/.*)$/.exec(url.pathname);
    if (sm) return proxyStream(req, res, sm[1], sm[2] + url.search);
    if (p.startsWith("/api/")) {
      if (p.startsWith("/api/account/")) return await accountRoutes(req, res, p);
      if (p.startsWith("/api/household")) return await householdRoutes(req, res, p);
      const u = await requireUser(req, res); if (!u) return;
      if (!profileOf(hh(), u.id) && !u.isAdmin) return send(res, 403, { code: "not_in_household", message: "This account isn't part of this household." });
      if ((p === "/api/state" && req.method === "GET") || (p === "/api/sync" && req.method === "POST")) return await syncRoutes(req, res, p, u);
      if (p === "/api/stream-token" && req.method === "POST") { const m = mintStream(u.id); return send(res, 200, { st: m.st, exp: m.exp }); }
      return send(res, 404, { code: "not_found" });
    }
    if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); return res.end(); }
    return serveStatic(req, res, p, uiRoot(wantsCompat(req, url)));
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, e.status || 500, { code: "error", message: e.status === 400 ? "Bad request." : "Something went wrong." }); else res.destroy();
  }
});
server.listen(PORT, "0.0.0.0", () => console.log(APP_NAME + " listening on :" + PORT + ", UI " + UI_DIR + ", data " + DATA_DIR + ", streaming upstream " + UPSTREAM.origin));
process.on("SIGTERM", () => process.exit(0));
