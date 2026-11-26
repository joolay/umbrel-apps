// Gym Guru: counts your reps with the phone's camera (pose tracking runs in the browser, no video leaves the phone).
// Zero-dependency Node server. Sign-in is the shared JoolzApp (PocketBase) account; any signed-in person can use it (it is a public app).
// A person's workout sets and their learned machines live in one PocketBase record each, private to them, in gymguru_data (this app's own limited login only).
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const pb = require("./pocketbase");
const quick = require("./quick-server")({ pb, dataDir: process.env.DATA_DIR || path.join(__dirname, "data") });   // PIN / pattern sign-in on a device that signed in before

const PORT = +process.env.PORT || 3925;
const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_BODY = 1024 * 1024;
const DATA = "gymguru_data";   // one collection: { owner, key, data }. owner = the person's id, key = "state".
const MAX_SETS = 5000, MAX_MACHINES = 100;

// Everyone with a JoolzApp account can use Gym Guru; what they save is private to them.
// Everyone with a JoolzApp account. What is owner-only (the GitHub-backed App development list and its connection) is guarded by ghAccess below.
const gateOf = u => ({ ok: !!u });
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
      const qs = quick.parse(t);           // a session made by Quick Access (PIN or pattern), not a PocketBase token
      if (qs) {
        const u = await pb.getUser(qs.id);
        if (!u || quick.stale(u, qs)) { const n = { user: null, at: Date.now() }; tokenCache.set(t, n); return n; }
        activity.touch(u.id);
        const e = { user: u, at: Date.now(), fresh: t, renewedAt: prev && prev.renewedAt || 0 };
        tokenCache.set(t, e); return e;
      }
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
    if (p === "/api/account/login" && req.method === "POST" && body.quick && typeof body.quick === "object") {
      if (throttled(req, "quick", 40, 600e3)) return send(res, 429, { code: "slow_down", message: "Too many attempts. Try again in a few minutes." }), true;
      let rec; try { rec = await quick.login(body.quick); } catch (e) { if (e && [401, 423, 429, 503, 504].includes(e.status)) return send(res, e.status, { code: "bad_login", message: e.message }), true; throw e; }
      const token = quick.mint(rec.id); setSessionCookie(req, res, token, true); send(res, 200, { token, user: publicUser(rec) });
      return true;
    }
    if (p === "/api/account/quick" || p.startsWith("/api/account/quick/")) { const u = await currentUser(req, true); if (await quick.handle(req, res, p, u, body, send)) return true; }
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
  throw new pb.PBError(503, "Gym Guru's storage isn't set up yet. In Portal Admin > Changes, apply \"Gym Guru storage\".");
}
const rowOf = async (owner, key) => ((await pb.asApp("GET", recs + `?page=1&perPage=1&filter=${qs(`owner = '${esc(owner)}' && key = '${esc(key)}'`)}`)).items || [])[0] || null;

/* ---------- what a saved workout looks like (cleaned on every write) ---------- */
const str = (s, n) => String(s == null ? "" : s).replace(/[\u0000-\u001f]/g, " ").trim().slice(0, n);
const num = (x, lo, hi) => { const v = typeof x === "number" ? x : parseFloat(x); return isFinite(v) ? Math.max(lo, Math.min(hi, v)) : null; };
const id = x => (typeof x === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(x) ? x : "");
function cleanSet(s) {
  if (!s || typeof s !== "object" || !id(s.id)) return null;
  const at = typeof s.at === "string" && !isNaN(Date.parse(s.at)) ? new Date(s.at).toISOString() : new Date().toISOString();
  return { id: s.id, ex: str(s.ex, 40), name: str(s.name, 60), reps: Math.round(num(s.reps, 0, 999) || 0), kg: num(s.kg, 0, 1000), secs: Math.round(num(s.secs, 0, 7200) || 0), at, fixed: Math.round(num(s.fixed, -999, 999) || 0) };
}
function cleanProfile(p) {
  if (!p || typeof p !== "object") return null;
  const o = { v: 1, idx: Math.round(num(p.idx, 0, 32) ?? -1), axis: p.axis === "x" ? "x" : p.axis === "y" ? "y" : "", startHigh: !!p.startHigh, lo: num(p.lo, -50, 50), hi: num(p.hi, -50, 50), amp: num(p.amp, 0, 100), near: num(p.near, 0, 100) };
  return o.idx >= 0 && o.axis && o.lo != null && o.hi != null && o.hi > o.lo ? o : null;
}
function cleanMachine(m) {
  if (!m || typeof m !== "object" || !id(m.id)) return null;
  const profile = cleanProfile(m.profile); if (!profile) return null;
  return { id: m.id, name: str(m.name, 60) || "Machine", profile, at: typeof m.at === "string" && !isNaN(Date.parse(m.at)) ? new Date(m.at).toISOString() : new Date().toISOString() };
}
const cleanState = d => ({ v: 1, sets: (d && Array.isArray(d.sets) ? d.sets : []).map(cleanSet).filter(Boolean).slice(-MAX_SETS), machines: (d && Array.isArray(d.machines) ? d.machines : []).map(cleanMachine).filter(Boolean).slice(0, MAX_MACHINES) });
async function loadState(owner) { await ensureStorage(); const r = await rowOf(owner, "state"); return { row: r, state: cleanState(r && r.data) }; }
// Read, change, write back: a set saved on one device never wipes what another device saved a moment ago.
async function changeState(owner, fn) {
  const { row, state } = await loadState(owner); fn(state);
  const data = cleanState(state);
  if (row) await pb.asApp("PATCH", recs + "/" + row.id, { data }); else await pb.asApp("POST", recs, { owner, key: "state", data });
  return data;
}

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".webmanifest": "application/manifest+json", ".wasm": "application/wasm", ".task": "application/octet-stream" };
const SETUP = "<!doctype html><meta name=viewport content='width=device-width'><meta http-equiv=refresh content=5><body style='font:16px system-ui;padding:2rem;max-width:34rem;margin:auto'><h1>Waiting for PocketBase</h1><p>Gym Guru isn't connected to PocketBase yet. Open Portal Admin and sign in once; this page will carry on by itself.</p>";

const PREF_KEYS = { voice: "bool", beep: "bool", mirror: "bool", haptic: "bool", countdown: [0, 3, 5, 10], sens: ["easy", "normal", "strict"], camera: ["user", "environment"], ex: "slug", mode: "obj", kg: "obj", theme: ["light", "dark", ""] };

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
      pb.reload();   // picks up pocketbase.env as soon as Portal Admin writes it, with no restart
      if (!pb.enabled) { if (isPage) { res.writeHead(503, { "content-type": "text/html; charset=utf-8" }); return res.end(SETUP); } return send(res, 503, { code: "accounts_unavailable", message: "Accounts aren't set up yet." }); }
      let u = null, err = null;
      try { u = await currentUser(req); } catch (e) { err = e; }
      if (!(u && gateOf(u).ok)) {
        if (isPage) { res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); return fs.createReadStream(path.join(PUBLIC_DIR, "gate.html")).pipe(res); }
        if (err) return send(res, 503, { code: "accounts_unavailable", message: err.message });
        return send(res, 401, { code: "signin_required", message: "Sign in to continue." });
      }
      user = u;
    }
    if (p === "/api/app-config") return send(res, 200, { accounts: pb.enabled, ...(pb.enabled ? { portalUrl: await pb.portalUrl().catch(() => "") } : {}) });
    if (await accountRoutes(req, res, p)) return;

    if (p === "/api/state" && req.method === "GET") { const { state } = await loadState(user.id); return send(res, 200, state); }
    if (p === "/api/set" && req.method === "POST") {   // save one finished set
      const s = cleanSet(JSON.parse((await readBody(req)).toString() || "{}"));
      if (!s || !s.ex) return send(res, 400, { code: "bad_set", message: "That isn't a workout set." });
      const out = await changeState(user.id, st => { st.sets = st.sets.filter(x => x.id !== s.id).concat(s); }); return send(res, 200, { ok: true, sets: out.sets.length });
    }
    if (p === "/api/set" && req.method === "DELETE") {
      const sid = id(url.searchParams.get("id") || ""); if (!sid) return send(res, 400, { code: "bad_id", message: "Bad set id." });
      await changeState(user.id, st => { st.sets = st.sets.filter(x => x.id !== sid); }); return send(res, 200, { ok: true });
    }
    if (p === "/api/machine" && req.method === "POST") {   // save (or rename) a machine the camera learned
      const m = cleanMachine(JSON.parse((await readBody(req)).toString() || "{}"));
      if (!m) return send(res, 400, { code: "bad_machine", message: "That isn't a learned machine." });
      await changeState(user.id, st => { st.machines = st.machines.filter(x => x.id !== m.id).concat(m); }); return send(res, 200, { ok: true });
    }
    if (p === "/api/machine" && req.method === "DELETE") {
      const mid = id(url.searchParams.get("id") || ""); if (!mid) return send(res, 400, { code: "bad_id", message: "Bad machine id." });
      await changeState(user.id, st => { st.machines = st.machines.filter(x => x.id !== mid); }); return send(res, 200, { ok: true });
    }
    if (p === "/api/prefs" && req.method === "PUT") {   // settings live on the person's account, never only on the device
      const b = JSON.parse((await readBody(req)).toString() || "{}"), prev = (user.portal && user.portal.prefs && user.portal.prefs["gym-guru"]) || {}, next = { ...prev };
      for (const [k, t] of Object.entries(PREF_KEYS)) {
        if (!(k in b)) continue;
        if (t === "bool") { if (typeof b[k] === "boolean") next[k] = b[k]; }
        else if (t === "slug") { if (typeof b[k] === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(b[k])) next[k] = b[k]; }
        else if (t === "obj") { if (b[k] && typeof b[k] === "object" && !Array.isArray(b[k])) { const o = {}; for (const [kk, vv] of Object.entries(b[k]).slice(0, 120)) if (/^[A-Za-z0-9_-]{1,40}$/.test(kk) && (typeof vv === "string" || typeof vv === "number")) o[kk] = typeof vv === "string" ? vv.slice(0, 12) : vv; next[k] = o; } }
        else if (t.includes(b[k])) next[k] = b[k];
      }
      await pb.setAppPref(user.id, next); tokenCache.clear(); return send(res, 200, { ok: true, prefs: next });
    }
    if (isData) return send(res, 404, { code: "not_found" });

    let f = p === "/" ? "/index.html" : p;
    f = path.normalize(path.join(PUBLIC_DIR, f));
    if (!f.startsWith(PUBLIC_DIR) || !fs.existsSync(f) || fs.statSync(f).isDirectory() || path.basename(f) === "gate.html") { res.writeHead(404); return res.end("Not found"); }
    // The camera model is big and never changes under the same name: let the browser keep it.
    const heavy = /\/vendor\//.test(f);
    res.writeHead(200, { "content-type": TYPES[path.extname(f)] || "application/octet-stream", "cache-control": heavy ? "public, max-age=604800" : "no-cache" });
    fs.createReadStream(f).pipe(res);
  } catch (e) {
    console.error(e);
    if (e instanceof pb.PBError) { if (!res.headersSent) send(res, e.status === 0 ? 503 : 502, { code: "accounts_unavailable", message: e.message }); else res.end(); return; }
    if (!res.headersSent) send(res, 500, { code: "server_error", message: e.message }); else res.end();
  }
});
// Portal Admin links an app once its data folder exists, so make it on start.
try { fs.mkdirSync(process.env.DATA_DIR || path.join(__dirname, "data"), { recursive: true }); } catch { /* ignore */ }
if (require.main === module) server.listen(PORT, () => console.log(`Gym Guru running on http://0.0.0.0:${PORT}`));
module.exports = { server, cleanState, cleanSet, cleanMachine };
