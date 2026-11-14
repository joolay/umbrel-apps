// ListSnap: checklists that follow your JoolzApp account.
// Zero-dependency Node server. Sign-in is the shared JoolzApp (PocketBase) account; each person's lists are one JSON file in the data folder.
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const pb = require("./pocketbase");
const guardians = require("./guardians");

const PORT = +process.env.PORT || 3895;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, "data"));
const PUBLIC_DIR = path.join(__dirname, "public");
const USERS_DIR = path.join(DATA_DIR, "users");
const REQUIRE_ACCOUNTS = /^(1|true|yes)$/i.test(process.env.REQUIRE_ACCOUNTS || "");
const MAX_BODY = 5 * 1024 * 1024;
fs.mkdirSync(USERS_DIR, { recursive: true });

/* ---------- who may open the app ---------- */
function gateOf(u) {
  if (u.isAdmin) return { ok: true };
  if (u.guard && u.guard.minor && !u.guard.approved) return { ok: false, reason: "guardian_pending", message: "Waiting for approval of your account. Ask a parent or guardian to approve you on the JoolzApp dashboard (Portal Admin), or wait for an admin. Then check again here." };
  if (!u.portal) return u.access ? { ok: true } : { ok: false, reason: "no_access", message: "The admin hasn't opened ListSnap to you yet. Ask them to give you access, then check again." };
  const a = u.portal.app;
  if (a && a.enabled === false) return { ok: false, reason: "disabled", message: "ListSnap is switched off right now." };
  if (a && a.maintenance) return { ok: false, reason: "maintenance", message: a.message || "ListSnap is under maintenance. Try again soon." };
  if (!u.portal.access) return { ok: false, reason: "no_access", message: "You need approval to use ListSnap. Open Portal Admin, request access to ListSnap, then check again here." };
  return { ok: true };
}
const publicUser = u => ({ id: u.id, email: u.email || "", name: u.name || "", isAdmin: !!u.isAdmin, dob: u.dob || "", age: guardians.ageOf(u.dob), minor: !!(u.guard ? u.guard.minor : guardians.isMinor(u)), canOpen: gateOf(u).ok, gate: gateOf(u), prefs: Object.fromEntries(Object.entries((u.portal && u.portal.prefs) || {}).filter(([k]) => k !== "ai.apiKey")) });

/* ---------- sessions ---------- */
const tokenCache = new Map();
function tokenOf(req) {
  const h = String(req.headers["x-gd-token"] || ""); if (h) return h;
  const m = String(req.headers.cookie || "").match(/(?:^|;\s*)gd_token=([^;]+)/); return m ? m[1] : "";
}
// "Remember me" keeps the sign-in for 14 days; otherwise the cookie lasts until the browser closes.
function setSessionCookie(req, res, token, remember) {
  if (remember === undefined) remember = /(?:^|;\s*)gd_rem=1/.test(String(req.headers.cookie || ""));
  const secure = String(req.headers["x-forwarded-proto"] || "").includes("https") ? "; Secure" : "", age = remember ? `; Max-Age=${14 * 86400}` : "";
  res.setHeader("set-cookie", [`gd_token=${token}; Path=/; HttpOnly; SameSite=Lax${age}${secure}`, remember ? `gd_rem=1; Path=/; HttpOnly; SameSite=Lax${age}${secure}` : `gd_rem=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`]);
}
const clearSessionCookie = res => res.setHeader("set-cookie", ["gd_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0", "gd_rem=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"]);
async function withGuard(u) { if (u) u.guard = await guardians.statusOf(u).catch(() => ({ minor: guardians.isMinor(u), approved: !guardians.isMinor(u) })); return u; }
async function currentUser(req) {
  const t = tokenOf(req); if (!t) return null;
  const c = tokenCache.get(t); if (c && Date.now() - c.at < 15000) return c.user;
  try {
    const j = await pb.verifyToken(t);
    await withGuard(j.record);
    tokenCache.set(t, { user: j.record, at: Date.now() });
    if (tokenCache.size > 200) tokenCache.delete(tokenCache.keys().next().value);
    return j.record;
  } catch (e) { if (e instanceof pb.PBError && [400, 401, 403, 404].includes(e.status)) return null; throw e; }
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
      const u = await currentUser(req);
      if (!u) return send(res, 401, { code: "signin_required", message: "Sign in to continue." }), true;
      setSessionCookie(req, res, tokenOf(req));
      send(res, 200, { user: { ...publicUser(await withGuard(await pb.getUser(u.id))), portalUrl: await pb.portalUrl().catch(() => "") } }); return true;
    }
    if (p === "/api/account/logout" && req.method === "POST") { clearSessionCookie(res); send(res, 200, { ok: true }); return true; }
    send(res, 404, { code: "not_found" }); return true;
  } catch (e) {
    if (e instanceof pb.PBError) { console.error("PocketBase:", e.message); send(res, e.status === 0 ? 503 : 502, { code: "accounts_unavailable", message: e.message }); return true; }
    throw e;
  }
}

/* ---------- saved lists, one file per person ---------- */
const ownerKey = u => (u && u.id ? String(u.id).replace(/[^A-Za-z0-9]/g, "") : "local") || "local";
const stateFile = u => path.join(USERS_DIR, ownerKey(u) + ".json");
function readState(u) { try { return JSON.parse(fs.readFileSync(stateFile(u), "utf8")); } catch { return null; } }
function writeState(u, s) { const f = stateFile(u), t = f + ".tmp"; fs.writeFileSync(t, JSON.stringify(s)); fs.renameSync(t, f); }
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function cleanState(d) {
  if (!d || !Array.isArray(d.lists)) return null;
  const lists = d.lists.slice(0, 100).filter(l => l && typeof l.name === "string" && Array.isArray(l.items)).map(l => ({
    id: String(l.id || "").slice(0, 40), name: l.name.slice(0, 60) || "Untitled list", sample: !!l.sample,
    date: typeof l.date === "string" && DATE_RE.test(l.date) ? l.date : "",
    items: l.items.filter(i => i && typeof i.text === "string" && i.text.trim()).slice(0, 2000).map(i => ({ id: String(i.id || "").slice(0, 40), text: i.text.slice(0, 300), done: !!i.done }))
  })).filter(l => l.id);
  if (!lists.length) return null;
  return { lists, activeId: lists.some(l => l.id === d.activeId) ? d.activeId : lists[0].id, at: Date.now() };
}

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json" };
const SETUP = "<!doctype html><meta name=viewport content='width=device-width'><body style='font:16px system-ui;padding:2rem;max-width:34rem;margin:auto'><h1>ListSnap isn't set up yet</h1><p>Accounts are required but PocketBase isn't connected. Add <code>pocketbase.env</code> to the app's data folder (POCKETBASE_SUPERUSER_EMAIL and POCKETBASE_SUPERUSER_PASSWORD), or open Portal Admin and connect PocketBase.</p></body>";

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    const p = decodeURIComponent(url.pathname);
    const isPage = p === "/" || p === "/index.html";
    const isData = p === "/api/state";

    // Only signed-in people the admin has let in can open the app (Umbrel's own login is off, so this is the lock).
    let user = null;
    if (isPage || isData) {
      if (!pb.enabled) {
        if (REQUIRE_ACCOUNTS) {
          if (isPage) { res.writeHead(503, { "content-type": "text/html; charset=utf-8" }); return res.end(SETUP); }
          return send(res, 503, { code: "accounts_unavailable", message: "Accounts aren't set up yet." });
        }
      } else {
        let u = null, err = null;
        try { u = await currentUser(req); } catch (e) { err = e; }
        if (!(u && gateOf(u).ok)) {
          if (isPage) { res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); return fs.createReadStream(path.join(PUBLIC_DIR, "gate.html")).pipe(res); }
          if (err) return send(res, 503, { code: "accounts_unavailable", message: err.message });
          return u ? send(res, 403, { code: gateOf(u).reason || "no_access", message: gateOf(u).message }) : send(res, 401, { code: "signin_required", message: "Sign in to continue." });
        }
        user = u;
      }
    }

    if (p === "/api/app-config") return send(res, 200, { accounts: pb.enabled, ...(pb.enabled ? { signups: await pb.signupsOpen().catch(() => true), portalUrl: await pb.portalUrl().catch(() => "") } : {}) });
    if (await accountRoutes(req, res, p)) return;

    if (p === "/api/state" && req.method === "GET") return send(res, 200, { state: readState(user), user: user ? { name: user.name || "", email: user.email || "" } : null });
    if (p === "/api/state" && req.method === "PUT") {
      const s = cleanState(JSON.parse((await readBody(req)).toString() || "{}"));
      if (!s) return send(res, 400, { code: "bad_state", message: "That isn't a ListSnap save." });
      writeState(user, s); return send(res, 200, { ok: true, at: s.at });
    }

    // static files
    let f = p === "/" ? "/index.html" : p;
    f = path.normalize(path.join(PUBLIC_DIR, f));
    if (!f.startsWith(PUBLIC_DIR) || !fs.existsSync(f) || fs.statSync(f).isDirectory() || path.basename(f) === "gate.html") { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "content-type": TYPES[path.extname(f)] || "application/octet-stream", "cache-control": "no-cache" });
    fs.createReadStream(f).pipe(res);
  } catch (e) {
    console.error(e);
    if (e instanceof pb.PBError) { if (!res.headersSent) send(res, e.status === 0 ? 503 : 502, { code: "accounts_unavailable", message: e.message }); else res.end(); return; }
    if (!res.headersSent) send(res, 500, { code: "server_error", message: e.message }); else res.end();
  }
});
server.listen(PORT, () => console.log(`ListSnap running on http://0.0.0.0:${PORT}`));
