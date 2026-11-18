// JoolzCCTV: live Hikvision and Dahua cameras from any number of recorders and sites, on one wall, for the JoolzApp viewers you choose.
// Zero-dependency Node server (ffmpeg does the video). Sign-in is the shared JoolzApp (PocketBase) account. Recorder passwords stay in
// <data>/cctv.json; each person's saved views live on their JoolzApp account. With accounts off (local testing only) everyone is an admin.
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const pb = require("./pocketbase");
const guardians = require("./guardians");
const dev = require("./devices");
const wsLib = require("./ws");
const { createStore } = require("./store");
const { createStreams } = require("./streams");

const PORT = +process.env.PORT || 3902;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, "data"));
const PUBLIC_DIR = path.join(__dirname, "public");
const REQUIRE_ACCOUNTS = /^(1|true|yes)$/i.test(process.env.REQUIRE_ACCOUNTS || "");
const MAX_BODY = 1024 * 1024;
fs.mkdirSync(DATA_DIR, { recursive: true });
const store = createStore(DATA_DIR);
const hooks = {};   // tests only: lets them point a camera at a local file instead of a real RTSP stream
const streams = createStreams({
  ffmpegPath: process.env.FFMPEG || "ffmpeg", maxProcs: +process.env.CCTV_MAX_STREAMS || 24, log: m => console.log("[stream] " + m),
  urlFor: (camId, quality) => { const cam = store.rawCamera(camId); if (!cam) throw new Error("Unknown camera"); return (hooks.urlFor || dev.rtspUrl)(store.rawSite(cam.site), cam, quality); },
});

/* ---------- who may open the app ---------- */
function gateOf(u) {
  if (u.isAdmin) return { ok: true };
  if (u.guard && u.guard.minor && !u.guard.approved) return { ok: false, reason: "guardian_pending", message: "Waiting for approval of your account. Ask a parent or guardian to approve you on the JoolzApp dashboard (Portal Admin), or wait for an admin. Then check again here." };
  if (!u.portal) return u.access ? { ok: true } : { ok: false, reason: "no_access", message: "The admin hasn't opened JoolzCCTV to you yet. Ask them to give you access, then check again." };
  const a = u.portal.app;
  if (a && a.enabled === false) return { ok: false, reason: "disabled", message: "JoolzCCTV is switched off right now." };
  if (a && a.maintenance) return { ok: false, reason: "maintenance", message: a.message || "JoolzCCTV is under maintenance. Try again soon." };
  if (!u.portal.access) return { ok: false, reason: "no_access", message: "You need approval to use JoolzCCTV. Open Portal Admin, request access to JoolzCCTV, then check again here." };
  return { ok: true };
}
const publicUser = u => ({ id: u.id, email: u.email || "", name: u.name || "", isAdmin: !!u.isAdmin, dob: u.dob || "", age: guardians.ageOf(u.dob), minor: !!(u.guard ? u.guard.minor : guardians.isMinor(u)), canOpen: gateOf(u).ok, gate: gateOf(u), prefs: Object.fromEntries(Object.entries((u.portal && u.portal.prefs) || {}).filter(([k]) => k !== "ai.apiKey")) });

/* ---------- sessions ---------- */
const tokenCache = new Map();
// Header first (the page sends it), then the cookie. If the header copy has gone stale the cookie, which is renewed as you use the app, still works.
function tokensOf(req) {
  const out = [], h = String(req.headers["x-gd-token"] || "");
  if (h) out.push(h);
  const m = String(req.headers.cookie || "").match(/(?:^|;\s*)gd_token=([^;]+)/);
  if (m && m[1] !== h) out.push(m[1]);
  return out;
}
// "Remember me" keeps the sign-in until 90 days after you last used the app; otherwise the cookie lasts until the browser closes.
function setSessionCookie(req, res, token, remember) {
  if (remember === undefined) remember = /(?:^|;\s*)gd_rem=1/.test(String(req.headers.cookie || ""));
  const secure = String(req.headers["x-forwarded-proto"] || "").includes("https") ? "; Secure" : "", age = remember ? `; Max-Age=${90 * 86400}` : "";
  res.setHeader("set-cookie", [`gd_token=${token}; Path=/; HttpOnly; SameSite=Lax${age}${secure}`, remember ? `gd_rem=1; Path=/; HttpOnly; SameSite=Lax${age}${secure}` : `gd_rem=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`]);
}
const clearSessionCookie = res => res.setHeader("set-cookie", ["gd_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0", "gd_rem=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"]);
async function withGuard(u) { if (u) u.guard = await guardians.statusOf(u).catch(() => ({ minor: guardians.isMinor(u), approved: !guardians.isMinor(u) })); return u; }
const activity = require("./activity");
// "Signed in for 90 days since you last used the app": every time PocketBase checks a token it hands back a fresh one, and the cookie is renewed
// with it (at most once an hour). PocketBase's own token lifetime for the users collection is set to 90 days by Portal Admin > Changes.
const tokenOf = req => tokensOf(req)[0] || "";
// Checking a sign-in with PocketBase takes several round trips, so the answer is reused: as it is for 15 seconds, and for up to 10 minutes
// while a fresh check runs in the background, so pages open straight away. Requests arriving together share one check.
// Admin actions and "who am I" pass strict and always get an answer no older than 15 seconds.
const checking = new Map();
function verifyFresh(t, prev) {
  if (checking.has(t)) return checking.get(t);
  const p = (async () => {
    try {
      const j = await pb.verifyToken(t);
      await withGuard(j.record);
      activity.touch(j.record.id);
      const e = { user: j.record, at: Date.now(), fresh: j.token, renewedAt: prev && prev.renewedAt || 0 };
      tokenCache.set(t, e);
      if (tokenCache.size > 200) tokenCache.delete(tokenCache.keys().next().value);
      return e;
    } catch (e) {
      if (e instanceof pb.PBError && [400, 401, 403, 404].includes(e.status)) { const n = { user: null, at: Date.now() }; tokenCache.set(t, n); return n; }
      throw e;
    } finally { checking.delete(t); }
  })();
  checking.set(t, p); return p;
}
async function currentUser(req, strict) {
  let failure = null;
  for (const t of tokensOf(req)) {
    let c = tokenCache.get(t); const age = c ? Date.now() - c.at : Infinity;
    if (c && age < 15000) { if (c.user) { req._renew = c; return c.user; } continue; }
    if (c && c.user && !strict && age < 600000) { verifyFresh(t, c).catch(() => {}); req._renew = c; return c.user; }
    try { c = await verifyFresh(t, c); if (c.user) { req._renew = c; return c.user; } }
    catch (e) { failure = failure || e; }
  }
  if (failure) throw failure;
  return null;
}
const attempts = new Map();
function throttled(req, key, max, windowMs) {
  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  const k = key + ":" + ip, now = Date.now();
  const a = (attempts.get(k) || []).filter(t => now - t < windowMs); a.push(now); attempts.set(k, a);
  if (attempts.size > 2000) attempts.clear();
  return a.length > max;
}
const validEmail = e => typeof e === "string" && e.length <= 200 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

function readBody(req) {
  return new Promise((ok, bad) => {
    const chunks = []; let size = 0;
    req.on("data", c => { size += c.length; if (size > MAX_BODY) { bad(new Error("too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => ok(Buffer.concat(chunks))); req.on("error", bad);
  });
}
const send = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(obj)); };

async function accountRoutes(req, res, p) {
  if (!p.startsWith("/api/account/")) return false;
  if (!pb.enabled) { send(res, 404, { code: "accounts_off", message: "Accounts aren't switched on for this server." }); return true; }
  try {
    const body = req.method === "GET" ? {} : JSON.parse((await readBody(req)).toString() || "{}");
    // One JoolzApp sign-up page (in Portal Admin) for every app. Nothing is created here.
    if (p === "/api/account/register") return send(res, 410, { code: "signup_moved", message: "Create your JoolzApp account on the JoolzApp sign-up page (Portal Admin).", portalUrl: await pb.portalUrl().catch(() => "") }), true;
    if (p === "/api/account/login" && req.method === "POST") {
      if (throttled(req, "login", 10, 600e3)) return send(res, 429, { code: "slow_down", message: "Too many attempts. Try again in a few minutes." }), true;
      try { const j = await pb.login(String(body.email || "").trim().toLowerCase(), String(body.password || "")); setSessionCookie(req, res, j.token, !!body.remember); send(res, 200, { token: j.token, user: publicUser(await withGuard(j.record)) }); }
      catch (e) { if (e instanceof pb.PBError && e.status === 400) return send(res, 400, { code: "bad_login", message: "That email and password don't match." }), true; throw e; }
      return true;
    }
    if (p === "/api/account/forgot" && req.method === "POST") {
      if (throttled(req, "forgot", 5, 3600e3)) return send(res, 429, { code: "slow_down", message: "Too many attempts. Try again later." }), true;
      const email = String(body.email || "").trim().toLowerCase();
      if (validEmail(email)) { try { await pb.requestPasswordReset(email); } catch {} }
      send(res, 200, { ok: true, message: "If that account exists, a password reset email has been sent." }); return true;
    }
    if (p === "/api/account/me" && req.method === "GET") {
      const u = await currentUser(req, true);
      if (!u) return send(res, 401, { code: "signin_required", message: "Sign in to continue." }), true;
      setSessionCookie(req, res, (req._renew && req._renew.fresh) || tokenOf(req));
      send(res, 200, { user: { ...publicUser(u), portalUrl: await pb.portalUrl().catch(() => "") } }); return true;
    }
    if (p === "/api/account/logout" && req.method === "POST") { clearSessionCookie(res); send(res, 200, { ok: true }); return true; }
    send(res, 404, { code: "not_found" }); return true;
  } catch (e) {
    if (e instanceof pb.PBError) { console.error("PocketBase:", e.message); send(res, e.status === 0 ? 503 : 502, { code: "accounts_unavailable", message: e.message }); return true; }
    throw e;
  }
}


/* ---------- who is asking (accounts on, or local test mode) ---------- */
const LOCAL = { id: "local", email: "", name: "Local", isAdmin: true };
async function whoIs(req, strict) {
  pb.reload();
  if (!pb.enabled) {
    if (REQUIRE_ACCOUNTS) return { err: { status: 503, code: "accounts_unavailable", message: "Accounts aren't set up yet." } };
    return { user: LOCAL };
  }
  let u = null;
  try { u = await currentUser(req, strict); } catch (e) { return { err: { status: 503, code: "accounts_unavailable", message: e.message } }; }
  if (!u) return { err: { status: 401, code: "signin_required", message: "Sign in to continue." } };
  const g = gateOf(u); if (!g.ok) return { err: { status: 403, code: g.reason || "no_access", message: g.message }, user: u };
  return { user: u };
}

/* ---------- saved views: a few named layouts per person, kept on the JoolzApp account ---------- */
const LAYOUTS = [1, 2, 4, 6, 9, 12, 16];
const VIEWS_FILE = path.join(DATA_DIR, "local-views.json");
function cleanViews(b) {
  const views = (Array.isArray(b && b.views) ? b.views : []).slice(0, 30).map(v => {
    const layout = LAYOUTS.includes(+v.layout) ? +v.layout : 4;
    const slots = Array.from({ length: layout }, (_, i) => (Array.isArray(v.slots) && typeof v.slots[i] === "string" && /^[a-f0-9]{10}$/.test(v.slots[i]) ? v.slots[i] : null));
    return { id: String(v.id || "").replace(/[^A-Za-z0-9]/g, "").slice(0, 16) || Math.random().toString(36).slice(2, 10), name: String(v.name || "View").trim().slice(0, 40) || "View", layout, slots };
  });
  return { views, last: String((b && b.last) || "").replace(/[^A-Za-z0-9]/g, "").slice(0, 16) };
}
const readViews = user => {
  if (!pb.enabled) { try { return cleanViews(JSON.parse(fs.readFileSync(VIEWS_FILE, "utf8"))); } catch { return { views: [], last: "" }; } }
  const v = user.portal && user.portal.prefs && user.portal.prefs.cctv; return cleanViews(v && typeof v === "object" ? v : {});
};
async function writeViews(user, v) {
  if (!pb.enabled) { fs.writeFileSync(VIEWS_FILE, JSON.stringify(v)); return; }
  await pb.setAppPref(user.id, v);
  const c = [...tokenCache.values()].find(x => x.user && x.user.id === user.id); if (c) { c.user.portal = { ...(c.user.portal || {}), prefs: { ...((c.user.portal && c.user.portal.prefs) || {}), cctv: v } }; }
}

/* ---------- live connections (one WebSocket per open wall) ---------- */
const conns = new Set();
function onSocket(req, socket, user) {
  if (!wsLib.accept(req, socket)) return;
  const subs = new Array(16).fill(null);
  const c = { user, api: null };
  const drop = i => { if (subs[i]) { subs[i].off(); subs[i] = null; } };
  const api = wsLib.wrap(socket, {
    onText(t) {
      let m; try { m = JSON.parse(t); } catch { return; }
      if (!m || m.t !== "watch" || !Array.isArray(m.slots)) return;
      for (let i = 0; i < 16; i++) {
        const w = m.slots[i], cam = w && typeof w.cam === "string" ? w.cam : null, q = w && w.q === "main" ? "main" : "sub";
        if (subs[i] && (!cam || subs[i].cam !== cam || subs[i].q !== q)) drop(i);
        if (!cam || subs[i]) continue;
        if (!store.canWatch(c.user, cam)) { api.sendText(JSON.stringify({ t: "state", slot: i, s: "error", m: "You don't have access to this camera" })); continue; }
        const slot = i;
        const off = streams.subscribe(cam, q,
          frame => { if (api.closed || api.backlog() > 600000) return; api.sendBinary(Buffer.concat([Buffer.from([slot]), frame])); },
          (s, msg) => api.sendText(JSON.stringify({ t: "state", slot, s, m: msg })));
        subs[i] = { cam, q, off };
      }
    },
    onClose() { for (let i = 0; i < 16; i++) drop(i); conns.delete(c); },
  });
  c.api = api; conns.add(c);
}
const kickUser = uid => { for (const c of conns) if (c.user.id === uid) c.api.close(); };
const kickAll = () => { for (const c of conns) c.api.close(); };

/* ---------- admin: sites, cameras, viewers ---------- */
const admin = {
  async overview(req) {
    let users = [];
    if (pb.enabled) {
      try { users = (await (pb.withToken ? pb.withToken(tokenOf(req)) : pb).listUsers()).map(u => ({ id: u.id, name: u.name || "", email: u.email || "", isAdmin: !!u.isAdmin })); } catch (e) { console.error("users:", e.message); }
    }
    return { sites: store.sites(), cameras: store.cameras(), grants: store.allGrants(), users, accounts: pb.enabled };
  },
  async addSite(b) {
    const cand = store.cleanSite(b);
    const found = await dev.probe(cand).catch(e => { throw Object.assign(new Error(e.message), { status: e.code === "AUTH" ? 400 : 502 }); });
    store.insertSite(cand);
    const added = store.importChannels(cand.id, found.channels);
    return { site: store.sites().find(s => s.id === cand.id), model: found.model, added };
  },
  async updateSite(id, b) {
    const ex = store.rawSite(id); if (!ex) throw Object.assign(new Error("Unknown site"), { status: 404 });
    const cand = store.cleanSite(b, ex);
    await dev.probe(cand).catch(e => { throw Object.assign(new Error(e.message), { status: e.code === "AUTH" ? 400 : 502 }); });
    store.updateSite(id, b); streams.reset(cid => { const c = store.rawCamera(cid); return c && c.site === id; });
    return { site: store.sites().find(s => s.id === id) };
  },
  async refreshSite(id) {
    const s = store.rawSite(id); if (!s) throw Object.assign(new Error("Unknown site"), { status: 404 });
    const found = await dev.probe(s).catch(e => { throw Object.assign(new Error(e.message), { status: e.code === "AUTH" ? 400 : 502 }); });
    return { added: store.importChannels(id, found.channels), model: found.model };
  },
};
async function adminRoutes(req, res, p, user) {
  if (!p.startsWith("/api/admin/")) return false;
  if (!user.isAdmin) return send(res, 403, { code: "admin_only", message: "Only an admin can change cameras and viewers." }), true;
  const m = req.method, body = m === "GET" || m === "DELETE" ? {} : JSON.parse((await readBody(req)).toString() || "{}");
  let r;
  if ((r = /^\/api\/admin\/site\/([a-f0-9]+)\/refresh$/.exec(p)) && m === "POST") return send(res, 200, await admin.refreshSite(r[1])), true;
  if ((r = /^\/api\/admin\/site\/([a-f0-9]+)$/.exec(p))) {
    if (m === "PUT") return send(res, 200, await admin.updateSite(r[1], body)), true;
    if (m === "DELETE") { const gone = store.removeSite(r[1]); streams.reset(c => gone.includes(c)); return send(res, 200, { ok: true }), true; }
  }
  if (p === "/api/admin/overview" && m === "GET") return send(res, 200, await admin.overview(req)), true;
  if (p === "/api/admin/site" && m === "POST") return send(res, 200, await admin.addSite(body)), true;
  if (p === "/api/admin/camera" && m === "POST") { const c = store.addRtspCamera(String(body.site || ""), body); return send(res, 200, { camera: store.publicCam(c) }), true; }
  if ((r = /^\/api\/admin\/camera\/([a-f0-9]+)$/.exec(p))) {
    if (m === "PUT") { const c = store.updateCamera(r[1], body); streams.reset(x => x === r[1]); return send(res, 200, { camera: c }), true; }
    if (m === "DELETE") { store.removeCamera(r[1]); streams.reset(x => x === r[1]); return send(res, 200, { ok: true }), true; }
  }
  if ((r = /^\/api\/admin\/grant\/([A-Za-z0-9]+)$/.exec(p)) && m === "PUT") { store.setGrant(r[1], body); kickUser(r[1]); return send(res, 200, { grant: store.grantOf(r[1]) }), true; }
  return send(res, 404, { code: "not_found" }), true;
}

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".webmanifest": "application/manifest+json" };
const SETUP = "<!doctype html><meta name=viewport content='width=device-width'><meta http-equiv=refresh content=5><body style='font:16px system-ui;padding:2rem;max-width:34rem;margin:auto'><h1>Waiting for PocketBase</h1><p>JoolzCCTV isn't connected to PocketBase yet. Open Portal Admin and sign in when it asks; this page then starts on its own within a few seconds.</p></body>";

const server = http.createServer(async (req, res) => {
  { // renew the sign-in cookie when this request proved who the person is
    const wh = res.writeHead;
    res.writeHead = function (...a) {
      const e = req._renew;
      if (e && e.fresh && !res.headersSent && !res.getHeader("set-cookie") && Date.now() - e.renewedAt > 3600e3) { e.renewedAt = Date.now(); setSessionCookie(req, res, e.fresh); }
      return wh.apply(this, a);
    };
  }
  try {
    const url = new URL(req.url, "http://x");
    const p = decodeURIComponent(url.pathname);
    if (p === "/healthz") return send(res, 200, { ok: true });
    if (p === "/" || p === "/index.html") {
      pb.reload();
      if (!pb.enabled && REQUIRE_ACCOUNTS) { res.writeHead(503, { "content-type": "text/html; charset=utf-8" }); return res.end(SETUP); }
    }
    if (p === "/api/app-config") { pb.reload(); return send(res, 200, { accounts: pb.enabled, ...(pb.enabled ? { signups: await pb.signupsOpen().catch(() => true), portalUrl: await pb.portalUrl().catch(() => "") } : {}) }); }
    if (await accountRoutes(req, res, p)) return;

    if (p.startsWith("/api/")) {
      const w = await whoIs(req, p.startsWith("/api/admin/"));
      if (w.err) return send(res, w.err.status, { code: w.err.code, message: w.err.message });
      const user = w.user;
      if (await adminRoutes(req, res, p, user)) return;
      if (p === "/api/cctv/config" && req.method === "GET") {
        const v = readViews(user);
        return send(res, 200, { user: user.id === "local" ? { id: "local", name: "Local", isAdmin: true } : publicUser(user), cameras: store.visibleTo(user).map(store.publicCam), views: v.views, last: v.last, layouts: LAYOUTS });
      }
      if (p === "/api/cctv/views" && req.method === "PUT") {
        const v = cleanViews(JSON.parse((await readBody(req)).toString() || "{}"));
        await writeViews(user, v); return send(res, 200, { ok: true });
      }
      return send(res, 404, { code: "not_found" });
    }

    let f = p === "/" ? "/index.html" : p;
    f = path.normalize(path.join(PUBLIC_DIR, f));
    if (!f.startsWith(PUBLIC_DIR) || !fs.existsSync(f) || fs.statSync(f).isDirectory() || path.basename(f) === "gate.html") { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "content-type": TYPES[path.extname(f)] || "application/octet-stream", "cache-control": "no-cache" });
    fs.createReadStream(f).pipe(res);
  } catch (e) {
    if (!(e && e.status < 500) && !/^\/api\/admin\//.test(req.url)) console.error(e);
    if (e instanceof pb.PBError) { if (!res.headersSent) send(res, e.status === 0 ? 503 : 502, { code: "accounts_unavailable", message: e.message }); else res.end(); return; }
    if (!res.headersSent) send(res, e.status && e.status < 500 ? e.status : e instanceof SyntaxError || /^\/api\/admin\//.test(req.url) ? 400 : 500, { code: "server_error", message: e.message }); else res.end();
  }
});
server.on("upgrade", async (req, socket) => {
  try {
    if (new URL(req.url, "http://x").pathname !== "/ws") return socket.destroy();
    const w = await whoIs(req, false);
    if (w.err) { socket.end(`HTTP/1.1 ${w.err.status === 401 ? 401 : 403} Forbidden\r\n\r\n`); return; }
    onSocket(req, socket, w.user);
  } catch { try { socket.destroy(); } catch {} }
});
module.exports = { server, store, streams, kickAll, hooks };
if (require.main === module) {
  server.listen(PORT, () => console.log(`JoolzCCTV running on http://0.0.0.0:${PORT}`));
  const bye = () => { streams.stopAll(); process.exit(0); }; process.on("SIGTERM", bye); process.on("SIGINT", bye);
}
