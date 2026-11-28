// JoolzApp Biz (JAB): the private dashboard for the dental practice's apps. Zero-dependency Node server.
// JAB is its own network: its people, roles, passwords, PIN/pattern codes and preferences live in this app's data folder (accounts.js), never in
// the JoolzApp (PocketBase) accounts, and nothing else is shared with the family apps except the look (the Glass template).
// People are added and managed in JAB Admin (admin.js, same image, same data folder). The practice name, groups and app tiles are in <data>/jab.json.
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, "data"));
const accounts = require("./accounts")({ dataDir: DATA_DIR });
const store = require("./config")(DATA_DIR);

const PORT = +process.env.PORT || 3927;
const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_BODY = 256 * 1024;

/* ---------- sessions: a signed token, sent as a header by the page and kept as a cookie too ---------- */
function tokensOf(req) {
  const out = [], h = String(req.headers["x-gd-token"] || "");
  if (h) out.push(h);
  const m = String(req.headers.cookie || "").match(/(?:^|;\s*)jab_token=([^;]+)/);
  if (m && m[1] !== h) out.push(m[1]);
  return out;
}
// "Remember me" keeps the sign-in until 90 days after you last used the app (the cookie is renewed as you use it); otherwise the cookie lasts until the browser closes.
function setSessionCookie(req, res, token, remember) {
  if (remember === undefined) remember = /(?:^|;\s*)jab_rem=1/.test(String(req.headers.cookie || ""));
  const secure = String(req.headers["x-forwarded-proto"] || "").includes("https") ? "; Secure" : "", age = remember ? `; Max-Age=${90 * 86400}` : "";
  res.setHeader("set-cookie", [`jab_token=${token}; Path=/; HttpOnly; SameSite=Lax${age}${secure}`, remember ? `jab_rem=1; Path=/; HttpOnly; SameSite=Lax${age}${secure}` : `jab_rem=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`]);
}
const clearSessionCookie = res => res.setHeader("set-cookie", ["jab_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0", "jab_rem=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"]);
function currentUser(req) {
  for (const t of tokensOf(req)) { const v = accounts.verify(t); if (v) { req._session = v; accounts.touch(v.user.id); return v.user; } }
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
function readBody(req) {
  return new Promise((ok, bad) => {
    const chunks = []; let size = 0;
    req.on("data", c => { size += c.length; if (size > MAX_BODY) { bad(new Error("too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => ok(Buffer.concat(chunks))); req.on("error", bad);
  });
}
const send = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(obj)); };
const sendErr = (res, e) => send(res, e.status || 500, { code: e.status === 401 || e.status === 423 ? "bad_login" : "error", message: e.status ? e.message : "Something went wrong.", left: e.left });

/* ---------- sign-in and account routes (the contract the shared gate and Quick Access screens expect) ---------- */
async function accountRoutes(req, res, p) {
  if (!p.startsWith("/api/account/")) return false;
  try {
    const body = req.method === "GET" ? {} : JSON.parse((await readBody(req)).toString() || "{}");
    const issue = (u, remember) => { const token = accounts.mint(u.id); setSessionCookie(req, res, token, remember); return token; };
    if (p === "/api/account/register") return send(res, 410, { code: "signup_moved", message: "Ask the practice admin to add you to JoolzApp Biz." }), true;
    if (p === "/api/account/login" && req.method === "POST") {
      if (body.quick && typeof body.quick === "object") {
        if (throttled(req, "quick", 40, 600e3)) return send(res, 429, { code: "slow_down", message: "Too many attempts. Try again in a few minutes." }), true;
        const u = accounts.qLogin(body.quick); send(res, 200, { token: issue(u, true), user: accounts.publicUser(u) }); return true;
      }
      if (throttled(req, "login", 10, 600e3)) return send(res, 429, { code: "slow_down", message: "Too many attempts. Try again in a few minutes." }), true;
      const u = accounts.login(String(body.email || ""), String(body.password || ""));
      send(res, 200, { token: issue(u, !!body.remember), user: accounts.publicUser(u) }); return true;
    }
    if (p === "/api/account/forgot" && req.method === "POST") {   // there is no email in JAB: the admin sets a new password in JAB Admin
      if (throttled(req, "forgot", 5, 3600e3)) return send(res, 429, { code: "slow_down", message: "Too many attempts. Try again later." }), true;
      send(res, 200, { ok: true, message: "Ask the practice admin to set a new password for you in JAB Admin." }); return true;
    }
    if (p === "/api/account/logout" && req.method === "POST") { clearSessionCookie(res); send(res, 200, { ok: true }); return true; }
    const u = currentUser(req);
    if (!u) return send(res, 401, { code: "signin_required", message: "Sign in to continue." }), true;
    if (p === "/api/account/me" && req.method === "GET") {
      setSessionCookie(req, res, accounts.mint(u.id));
      send(res, 200, { user: { ...accounts.publicUser(u), portalUrl: "" } }); return true;
    }
    if (p === "/api/account/password" && req.method === "POST") {
      if (throttled(req, "pw", 10, 600e3)) return send(res, 429, { code: "slow_down", message: "Too many attempts. Try again in a few minutes." }), true;
      accounts.changeOwnPassword(u.id, String(body.current || ""), String(body.password || ""));
      send(res, 200, { ok: true, token: issue(u) }); return true;   // every other sign-in was ended, this one carries on
    }
    // Quick Access: one PIN or pattern per person; each device that turns it on gets its own id and secret.
    if (p === "/api/account/quick/status" && req.method === "GET") return send(res, 200, accounts.qStatus(u)), true;
    if (p === "/api/account/quick" && req.method === "GET") return send(res, 200, { devices: accounts.qList(u) }), true;
    if (p === "/api/account/quick" && req.method === "POST") return send(res, 201, accounts.qSetup(u.id, { kind: String(body.kind || ""), code: String(body.code || ""), label: String(body.label || "This device") })), true;
    const m = /^\/api\/account\/quick\/([\w-]{22})$/.exec(p);
    if (m && req.method === "DELETE") return send(res, 200, accounts.qRemove(u.id, m[1])), true;
    send(res, 404, { code: "not_found" }); return true;
  } catch (e) {
    if (e && e.status) { sendErr(res, e); return true; }
    throw e;
  }
}

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".webmanifest": "application/manifest+json" };
const PREF_KEYS = { theme: ["light", "dark", ""], collapsed: "obj" };
const slug = x => (typeof x === "string" && /^[a-z0-9][a-z0-9-]{0,40}$/.test(x) ? x : "");

const server = http.createServer(async (req, res) => {
  { const wh = res.writeHead;     // keep people signed in: renew the cookie (at most once an hour) while they use the app
    res.writeHead = function (...a) {
      const s = req._session;
      if (s && !res.headersSent && !res.getHeader("set-cookie") && Date.now() - s.iat > 3600e3) setSessionCookie(req, res, accounts.mint(s.user.id));
      return wh.apply(this, a);
    }; }
  try {
    const url = new URL(req.url, "http://x"), p = decodeURIComponent(url.pathname);
    if (p === "/healthz" || p === "/api/link") { res.writeHead(200, { "content-type": "text/plain" }); return res.end("ok"); }
    const isPage = p === "/" || p === "/index.html", isData = p.startsWith("/api/") && !p.startsWith("/api/account/") && p !== "/api/app-config";
    if (p === "/api/app-config") return send(res, 200, { accounts: true, signups: false, google: false, portalUrl: "", setup: accounts.count() === 0 });
    if (await accountRoutes(req, res, p)) return;

    let user = null;
    if (isPage || isData) {
      user = currentUser(req);
      if (!user) {
        if (isPage) { res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); return fs.createReadStream(path.join(PUBLIC_DIR, "gate.html")).pipe(res); }
        return send(res, 401, { code: "signin_required", message: "Sign in to continue." });
      }
    }
    if (p === "/api/jab" && req.method === "GET") {
      const cfg = store.load(), admin = user.role === "admin";
      return send(res, 200, { config: admin ? cfg : { ...cfg, apps: cfg.apps.filter(a => !a.adminOnly) }, me: { ...accounts.publicUser(user), adminUrl: admin ? store.adminUrl() : "" } });
    }
    if (p === "/api/jab" && req.method === "PUT") {   // admin only: the apps and groups are saved in one go (the practice name is kept from the file: JAB Admin owns it)
      if (user.role !== "admin") return send(res, 403, { code: "admin_only", message: "Only an admin can change the dashboard." });
      const b = JSON.parse((await readBody(req)).toString() || "{}"), c = b.config || b, cur = store.load();
      return send(res, 200, { ok: true, config: store.save({ ...c, practice: cur.practice }) });
    }
    if (p === "/api/prefs" && req.method === "PUT") {   // settings live on the person's account, never only on the device
      const b = JSON.parse((await readBody(req)).toString() || "{}"), next = { ...(user.prefs || {}) };
      for (const [k, t] of Object.entries(PREF_KEYS)) {
        if (!(k in b)) continue;
        if (t === "obj") { if (b[k] && typeof b[k] === "object" && !Array.isArray(b[k])) { const o = {}; for (const [kk, vv] of Object.entries(b[k]).slice(0, 40)) if (slug(kk) && typeof vv === "boolean") o[kk] = vv; next[k] = o; } }
        else if (t.includes(b[k])) next[k] = b[k];
      }
      accounts.setPrefs(user.id, next); return send(res, 200, { ok: true, prefs: next });
    }
    if (isData) return send(res, 404, { code: "not_found" });

    let f = p === "/" ? "/index.html" : p;
    f = path.normalize(path.join(PUBLIC_DIR, f));
    if (!f.startsWith(PUBLIC_DIR) || !fs.existsSync(f) || fs.statSync(f).isDirectory() || path.basename(f) === "gate.html" || path.basename(f).startsWith("admin")) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "content-type": TYPES[path.extname(f)] || "application/octet-stream", "cache-control": "no-cache" });
    fs.createReadStream(f).pipe(res);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, e.status || 500, { code: "server_error", message: e.status ? e.message : "Something went wrong." }); else res.end();
  }
});
if (require.main === module) server.listen(PORT, () => console.log(`JoolzApp Biz (JAB) running on http://0.0.0.0:${PORT}`));
module.exports = { server, accounts, store };
