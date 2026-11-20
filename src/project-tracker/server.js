// Project Tracker: lists of projects with a status, priority order, archive and recycle bin.
// Zero-dependency Node server. Sign-in is the shared JoolzApp (PocketBase) account and, for now, admins only.
// The shared "appdev" list is a JSON file in a GitHub repo, checked every few seconds while the page is open. Every other list lives in PocketBase.
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const pb = require("./pocketbase");
const L = require("./lists");
const makeGitHub = require("./github");

const PORT = +process.env.PORT || 3915;
const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_BODY = 2 * 1024 * 1024;
const DATA = "projecttracker_data";   // one collection: { owner, key, data }. owner "_config" holds the GitHub connection; a person's id holds their own lists.
const GH_LIST = "appdev", DEFAULT_REPO = process.env.TRACKER_REPO || "joolay/tracking-data", DEFAULT_FILE = "appdev.json";
const COMMIT_TTL = 15 * 60e3;

/* ---------- who may open the app ---------- */
const gateOf = u => (u.isAdmin ? { ok: true } : { ok: false, reason: "admin_only", message: "Project Tracker is for admins for now." });
const publicUser = u => ({ id: u.id, email: u.email || "", name: u.name || "", isAdmin: !!u.isAdmin, canOpen: gateOf(u).ok, gate: gateOf(u), prefs: Object.fromEntries(Object.entries((u.portal && u.portal.prefs) || {}).filter(([k]) => k !== "ai.apiKey")) });

/* ---------- sessions (same as the other JoolzApps) ---------- */
const tokenCache = new Map();
function tokensOf(req) {
  const out = [], h = String(req.headers["x-gd-token"] || "");
  if (h) out.push(h);
  const m = String(req.headers.cookie || "").match(/(?:^|;\s*)gd_token=([^;]+)/);
  if (m && m[1] !== h) out.push(m[1]);
  return out;
}
function setSessionCookie(req, res, token, remember) {
  if (remember === undefined) remember = /(?:^|;\s*)gd_rem=1/.test(String(req.headers.cookie || ""));
  const secure = String(req.headers["x-forwarded-proto"] || "").includes("https") ? "; Secure" : "", age = remember ? `; Max-Age=${90 * 86400}` : "";
  res.setHeader("set-cookie", [`gd_token=${token}; Path=/; HttpOnly; SameSite=Lax${age}${secure}`, remember ? `gd_rem=1; Path=/; HttpOnly; SameSite=Lax${age}${secure}` : `gd_rem=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`]);
}
const clearSessionCookie = res => res.setHeader("set-cookie", ["gd_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0", "gd_rem=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"]);
const activity = require("./activity");
const tokenOf = req => tokensOf(req)[0] || "";
const checking = new Map();
function verifyFresh(t, prev) {
  if (checking.has(t)) return checking.get(t);
  const p = (async () => {
    try {
      const j = await pb.verifyToken(t);
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
    if (p === "/api/account/login" && req.method === "POST") {
      if (throttled(req, "login", 10, 600e3)) return send(res, 429, { code: "slow_down", message: "Too many attempts. Try again in a few minutes." }), true;
      try { const j = await pb.login(String(body.email || "").trim().toLowerCase(), String(body.password || "")); setSessionCookie(req, res, j.token, !!body.remember); send(res, 200, { token: j.token, user: publicUser(j.record) }); }
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

/* ---------- stored data (PocketBase, this app's own limited login) ---------- */
const recs = "/api/collections/" + DATA + "/records", qs = encodeURIComponent, esc = s => String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
async function ensureStorage() {
  if (await pb.serviceCan(["/api/collections/" + DATA])) return;
  throw new pb.PBError(503, "Project Tracker's storage isn't set up yet. In Portal Admin > Changes, apply \"Project Tracker storage\".");
}
const rowOf = async (owner, key) => ((await pb.asApp("GET", recs + `?page=1&perPage=1&filter=${qs(`owner = '${esc(owner)}' && key = '${esc(key)}'`)}`)).items || [])[0] || null;
const getData = async (owner, key) => { await ensureStorage(); const r = await rowOf(owner, key); return r && r.data && typeof r.data === "object" ? r.data : null; };
async function putData(owner, key, data) {
  await ensureStorage(); const r = await rowOf(owner, key);
  if (r) await pb.asApp("PATCH", recs + "/" + r.id, { data }); else await pb.asApp("POST", recs, { owner, key, data });
}
const listRows = async owner => { await ensureStorage(); const j = await pb.asApp("GET", recs + `?page=1&perPage=200&filter=${qs(`owner = '${esc(owner)}'`)}`); return j.items || []; };

/* ---------- the GitHub list ---------- */
let ghConfig = null, ghConfigAt = 0;
async function loadGhConfig(force) {
  if (!force && ghConfig && Date.now() - ghConfigAt < 20000) return ghConfig;
  const d = (await getData("_config", "github")) || {};
  ghConfig = { repo: /^[\w.-]+\/[\w.-]+$/.test(d.repo || "") ? d.repo : DEFAULT_REPO, path: d.path && !String(d.path).includes("..") ? String(d.path).replace(/^\/+/, "") : DEFAULT_FILE, branch: /^[\w./-]*$/.test(d.branch || "") ? d.branch || "" : "", token: typeof d.token === "string" ? d.token : "", owner: typeof d.owner === "string" ? d.owner : "" };
  ghConfigAt = Date.now(); return ghConfig;
}
const gh = makeGitHub({ getConfig: () => loadGhConfig(false) });
const hashOf = s => { let h = 5381; for (const c of s) h = ((h << 5) + h + c.charCodeAt(0)) >>> 0; return h.toString(36); };
const emptyList = name => ({ version: 1, name, categories: [], projects: [], updatedAt: new Date().toISOString() });

// Days when each project was last worked on, from the newest commit under its paths (apps in your repos). Cached for 15 minutes.
async function workedMap(list) {
  const out = {}, jobs = [];
  for (const p of list.projects) if (p.state === "live" && p.status !== "closed" && p.paths.length) jobs.push((async () => {
    const days = (await Promise.all(p.paths.map(x => gh.lastCommit(x.repo, x.path, COMMIT_TTL).catch(() => null)))).filter(Boolean).sort();
    if (days.length) out[p.id] = days[days.length - 1];
  })());
  await Promise.all(jobs); return out;
}
// The shared list belongs to the first person who opens the app (the owner). Nobody else is shown it, can read it or can change its connection.
async function ghAccess(user) {
  const c = await loadGhConfig(false);
  if (c.owner) return c.owner === user.id;
  const cur = (await getData("_config", "github")) || {};
  if (cur.owner) { ghConfig = null; return cur.owner === user.id; }
  await putData("_config", "github", { ...cur, owner: user.id }); ghConfig = null; return true;
}
const noAccess = res => (send(res, 403, { code: "not_yours", message: "That list belongs to someone else." }), true);
const hasToken = async () => !!(await loadGhConfig(false)).token;

function mutateFor(name, body) {
  return cur => {
    let l = L.cleanList(cur, new Date().toISOString()) || emptyList(name);
    const ops = { ...(body.ops || {}) };
    if (body.move && typeof body.move.id === "string") ops.upsert = [...(Array.isArray(ops.upsert) ? ops.upsert : []), ...L.move(l, body.move.id, body.move.dir < 0 ? -1 : 1)];
    l = L.applyOps(l, ops);
    const gone = L.purgeBin(l); return gone.length ? L.applyOps(l, { remove: gone }) : l;   // the bin empties itself after 30 days
  };
}

async function listsRoutes(req, res, p, url, user) {
  if (p === "/api/lists" && req.method === "GET") {
    const mine = (await listRows(user.id)).map(r => ({ key: r.key, name: (r.data && r.data.name) || r.key, source: "pocketbase", count: ((r.data && r.data.projects) || []).filter(x => x.state === "live").length }));
    const owner = await ghAccess(user); let g = null;
    if (owner) {
      g = { key: GH_LIST, name: "App development", source: "github", readOnly: !(await hasToken()), count: 0 };
      try { const f = await gh.read(false); const l = f.data && L.cleanList(f.data); if (l) { g.count = l.projects.filter(x => x.state === "live").length; g.name = l.name; } } catch (e) { g.error = e.message; }
    }
    send(res, 200, { lists: g ? [g, ...mine] : mine, owner }); return true;
  }
  if (p === "/api/lists" && req.method === "POST") {
    const b = JSON.parse((await readBody(req)).toString() || "{}"), name = L.str(b.name, 80);
    if (!name) return send(res, 400, { code: "no_name", message: "Give the list a name." }), true;
    const have = new Set((await listRows(user.id)).map(r => r.key)); let key = L.slug(name), n = 2; if (key === GH_LIST) key = "list-" + key;
    while (have.has(key)) key = L.slug(name) + "-" + n++;
    await putData(user.id, key, emptyList(name)); send(res, 200, { key }); return true;
  }
  const m = p.match(/^\/api\/list\/([a-z0-9-]{1,70})(\/apply)?$/);
  if (!m) return false;
  const key = m[1], isGh = key === GH_LIST;
  if (isGh && !(await ghAccess(user))) return noAccess(res);
  if (!m[2] && req.method === "GET") {
    const since = url.searchParams.get("sha") || "";
    if (isGh) {
      const f = await gh.read(false), l = (f.data && L.cleanList(f.data)) || emptyList("App development"), worked = await workedMap(l);
      const stamp = (f.sha || "none") + ":" + hashOf(JSON.stringify(worked));
      if (since && since === stamp) return send(res, 200, { unchanged: true, sha: stamp }), true;
      send(res, 200, { sha: stamp, list: l, worked, readOnly: !(await hasToken()), source: "github" }); return true;
    }
    const d = await getData(user.id, key); if (!d) return send(res, 404, { code: "no_list", message: "That list doesn't exist." }), true;
    const l = L.cleanList(d) || emptyList(d.name || key), worked = await workedMap(l), stamp = hashOf(JSON.stringify(l) + JSON.stringify(worked));
    if (since && since === stamp) return send(res, 200, { unchanged: true, sha: stamp }), true;
    send(res, 200, { sha: stamp, list: l, worked, readOnly: false, source: "pocketbase" }); return true;
  }
  if (m[2] && req.method === "POST") {
    const b = JSON.parse((await readBody(req)).toString() || "{}");
    if (isGh) {
      try { await gh.write(mutateFor("App development", b), b.message ? L.str(b.message, 100) : "Tracker: update projects"); }
      catch (e) { if (e instanceof makeGitHub.GitHubError) return send(res, e.code === "read_only" ? 403 : e.code === "conflict" ? 409 : 502, { code: e.code, message: e.message }), true; throw e; }
      send(res, 200, { ok: true }); return true;
    }
    const d = await getData(user.id, key); if (!d) return send(res, 404, { code: "no_list", message: "That list doesn't exist." }), true;
    await putData(user.id, key, mutateFor(d.name || key, b)(d)); send(res, 200, { ok: true }); return true;
  }
  if (!m[2] && req.method === "DELETE" && !isGh) {
    const r = await rowOf(user.id, key); if (r) await pb.asApp("DELETE", recs + "/" + r.id);
    send(res, 200, { ok: true }); return true;
  }
  return false;
}

async function configRoutes(req, res, p, user) {
  if (p !== "/api/config/github") return false;
  if (!(await ghAccess(user))) return noAccess(res);
  if (req.method === "GET") {
    const c = await loadGhConfig(true); let status = "ok", message = "";
    try { await gh.read(true); } catch (e) { status = e.code || "error"; message = e.message; }
    send(res, 200, { repo: c.repo, path: c.path, branch: c.branch, hasToken: !!c.token, status, message }); return true;   // the token itself is never sent back
  }
  if (req.method === "PUT") {
    const b = JSON.parse((await readBody(req)).toString() || "{}"), cur = (await getData("_config", "github")) || {};
    const next = { repo: String(b.repo || cur.repo || DEFAULT_REPO).trim(), path: String(b.path || cur.path || DEFAULT_FILE).trim(), branch: String(b.branch == null ? cur.branch || "" : b.branch).trim(), token: b.clearToken ? "" : (typeof b.token === "string" && b.token.trim() ? b.token.trim() : cur.token || ""), owner: cur.owner || user.id };
    if (!/^[\w.-]+\/[\w.-]+$/.test(next.repo) || !next.path || next.path.includes("..") || !/^[\w./-]*$/.test(next.branch)) return send(res, 400, { code: "bad_config", message: "Check the repo (owner/name), file name and branch." }), true;
    await putData("_config", "github", next); ghConfig = null; send(res, 200, { ok: true }); return true;
  }
  return false;
}

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".webmanifest": "application/manifest+json" };
const SETUP = "<!doctype html><meta name=viewport content='width=device-width'><meta http-equiv=refresh content=5><body style='font:16px system-ui;padding:2rem;max-width:34rem;margin:auto'><h1>Waiting for PocketBase</h1><p>Project Tracker isn't connected to PocketBase yet. Open Portal Admin and sign in once; this page will carry on by itself.</p>";

const server = http.createServer(async (req, res) => {
  { const wh = res.writeHead;
    res.writeHead = function (...a) {
      const e = req._renew;
      if (e && e.fresh && !res.headersSent && !res.getHeader("set-cookie") && Date.now() - e.renewedAt > 3600e3) { e.renewedAt = Date.now(); setSessionCookie(req, res, e.fresh); }
      return wh.apply(this, a);
    }; }
  try {
    const url = new URL(req.url, "http://x"), p = decodeURIComponent(url.pathname);
    const isPage = p === "/" || p === "/index.html", isData = p.startsWith("/api/") && !p.startsWith("/api/account/") && p !== "/api/app-config";
    let user = null;
    if (isPage || isData) {
      pb.reload();
      if (!pb.enabled) { if (isPage) { res.writeHead(503, { "content-type": "text/html; charset=utf-8" }); return res.end(SETUP); } return send(res, 503, { code: "accounts_unavailable", message: "Accounts aren't set up yet." }); }
      let u = null, err = null;
      try { u = await currentUser(req); } catch (e) { err = e; }
      if (!(u && gateOf(u).ok)) {
        if (isPage) { res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); return fs.createReadStream(path.join(PUBLIC_DIR, "gate.html")).pipe(res); }
        if (err) return send(res, 503, { code: "accounts_unavailable", message: err.message });
        return u ? send(res, 403, { code: gateOf(u).reason, message: gateOf(u).message }) : send(res, 401, { code: "signin_required", message: "Sign in to continue." });
      }
      user = u;
    }
    if (p === "/api/app-config") return send(res, 200, { accounts: pb.enabled, ...(pb.enabled ? { portalUrl: await pb.portalUrl().catch(() => "") } : {}) });
    if (await accountRoutes(req, res, p)) return;
    if (p === "/api/prefs" && req.method === "PUT") {
      const b = JSON.parse((await readBody(req)).toString() || "{}"), prev = (user.portal && user.portal.prefs && user.portal.prefs["project-tracker"]) || {}, next = { ...prev };
      if (typeof b.list === "string" && /^[a-z0-9-]{1,70}$/.test(b.list)) next.list = b.list;
      if (["all", "active", "maintenance", "hiatus", "closed", "archive", "bin"].includes(b.view)) next.view = b.view;
      if (typeof b.auto === "boolean") next.auto = b.auto;   // global switch for the 3-day rule (default on)
      if (Array.isArray(b.collapsed)) next.collapsed = b.collapsed.map(x => L.str(x, 60)).slice(0, 60);
      await pb.setAppPref(user.id, next); tokenCache.clear(); return send(res, 200, { ok: true });
    }
    if (isData && await listsRoutes(req, res, p, url, user)) return;
    if (isData && await configRoutes(req, res, p, user)) return;
    if (isData) return send(res, 404, { code: "not_found" });

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
server.listen(PORT, () => console.log(`Project Tracker running on http://0.0.0.0:${PORT}`));
