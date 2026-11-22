// Project Pilot: lists of projects with a status, priority order, archive and recycle bin.
// Zero-dependency Node server. Sign-in is the shared JoolzApp (PocketBase) account; any signed-in person can use it (it is a public app).
// The "appdev" list (App development) is a JSON file in the owner's GitHub repo, checked every few seconds while the page is open. Only the owner ever sees it.
// Every other list lives in PocketBase, private to the person who made it unless they share it (by email, view or edit).
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const pb = require("./pocketbase");
const L = require("./lists");
const makeAi = require("./ai"), helper = require("./helper"), aiClient = makeAi();
const makeGitHub = require("./github");
const quick = require("./quick-server")({ pb, dataDir: process.env.DATA_DIR || path.join(__dirname, "data") });   // PIN / pattern sign-in on a device that signed in before

const PORT = +process.env.PORT || 3915;
const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_BODY = 2 * 1024 * 1024;
const DATA = "projecttracker_data";   // one collection: { owner, key, data }. owner "_config" holds the GitHub connection; a person's id holds their own lists.
const GH_LIST = "appdev", DEFAULT_REPO = process.env.TRACKER_REPO || "joolay/tracking-data", DEFAULT_FILE = "appdev.json";
const COMMIT_TTL = 15 * 60e3;

/* ---------- who may open the app ---------- */
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
  throw new pb.PBError(503, "Project Pilot's storage isn't set up yet. In Portal Admin > Changes, apply \"Project Pilot storage\".");
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
async function workedMap(list, anon) {
  const out = {}, jobs = [];
  for (const p of list.projects) if (p.state === "live" && p.status !== "closed" && p.paths.length) jobs.push((async () => {
    const days = (await Promise.all(p.paths.map(x => gh.lastCommit(x.repo, x.path, COMMIT_TTL, anon).catch(() => null)))).filter(Boolean).sort();
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
  if (!user.isAdmin) return false;   // the app is public now: only an admin can ever claim the GitHub list
  await putData("_config", "github", { ...cur, owner: user.id }); ghConfig = null; return true;
}
const noAccess = res => (send(res, 403, { code: "not_yours", message: "That list belongs to someone else." }), true);
const hasToken = async () => !!(await loadGhConfig(false)).token;

function mutateFor(name, body) {
  return cur => {
    let l = L.cleanList(cur, new Date().toISOString()) || emptyList(name);
    const ops = { ...(body.ops || {}) };
    if (body.move && typeof body.move.id === "string") ops.upsert = [...(Array.isArray(ops.upsert) ? ops.upsert : []), ...L.move(l, body.move.id, body.move.dir < 0 ? -1 : 1)];
    return L.applyOps(l, ops);   // the bin never empties itself: the app asks every month (Complete / Abandoned / Delete are chosen on the tile)
  };
}

/* ---------- sharing ---------- */
// A list can be shared by email, as "view" or "edit". The share lives in the list itself (data.shares), which is the only thing that grants access.
// The person it is shared with finds it through a small pointer row (owner "inv:<hash of their email>"), so nobody has to scan every list, and
// the owner never learns whether an address has an account: sharing works the same either way and takes effect when that person signs in.
const KEY_RE = /^[a-z0-9-]{1,70}$/, SHARED_RE = /^shared--([a-z0-9]{1,32})--([a-z0-9-]{1,70})$/;
const MAX_LISTS = 30, MAX_SHARES = 20;
const emailKey = e => "inv:" + crypto.createHash("sha256").update(String(e).trim().toLowerCase()).digest("hex").slice(0, 24);
const myEmail = u => String(u.email || "").trim().toLowerCase();
const sharesOf = d => (Array.isArray(d && d.shares) ? d.shares : []).filter(s => s && validEmail(s.email)).map(s => ({ email: String(s.email).toLowerCase(), role: s.role === "edit" ? "edit" : "view", at: String(s.at || "") })).slice(0, MAX_SHARES);
const delRow = async (owner, key) => { const r = await rowOf(owner, key); if (r) await pb.asApp("DELETE", recs + "/" + r.id); };
const ownerNames = new Map();
async function nameOf(id) {
  const hit = ownerNames.get(id); if (hit && Date.now() - hit.at < 600e3) return hit.name;
  let name = ""; try { const u = await pb.getUser(id); name = u.name || (u.email ? u.email.split("@")[0] : ""); } catch {}
  ownerNames.set(id, { name, at: Date.now() }); if (ownerNames.size > 500) ownerNames.clear(); return name;
}
// What the person may do with a list reference (their own key, or shared--<owner>--<key>): { kind, owner, key, role: owner|edit|view, data } or null.
async function access(user, ref) {
  const sm = ref.match(SHARED_RE);
  if (!sm) { const d = await getData(user.id, ref); return d ? { kind: "own", owner: user.id, key: ref, role: "owner", data: d } : null; }
  if (sm[1] === user.id) return null;
  const d = await getData(sm[1], sm[2]); if (!d) return null;
  const s = sharesOf(d).find(x => x.email === myEmail(user)); if (!s) return null;
  const viewOnly = !!(user.portal && user.portal.readonly) && !user.isAdmin;   // View-only accounts can never change a shared resource
  return { kind: "shared", owner: sm[1], key: sm[2], role: s.role === "edit" && !viewOnly ? "edit" : "view", data: d };
}
async function sharedWithMe(user) {
  const em = myEmail(user); if (!em) return [];
  const rows = (await pb.asApp("GET", recs + `?page=1&perPage=100&filter=${qs(`owner = '${esc(emailKey(em))}'`)}`)).items || [], out = [];
  for (const r of rows) {
    const [oid, k] = String(r.key).split("--");
    const d = oid && k && oid !== user.id ? await getData(oid, k) : null;
    const s = d && sharesOf(d).find(x => x.email === em);
    if (!s) { await pb.asApp("DELETE", recs + "/" + r.id).catch(() => {}); continue; }   // no longer shared: tidy the pointer
    const l = L.cleanList(d);
    out.push({ key: `shared--${oid}--${k}`, name: (l && l.name) || k, source: "shared", role: access.roleOf(user, s), by: await nameOf(oid), count: l ? l.projects.filter(x => x.state === "live").length : 0 });
  }
  return out;
}
access.roleOf = (user, s) => (s.role === "edit" && !(user.portal && user.portal.readonly && !user.isAdmin) ? "edit" : "view");

async function listsRoutes(req, res, p, url, user) {
  if (p === "/api/lists" && req.method === "GET") {
    const mine = (await listRows(user.id)).map(r => ({ key: r.key, name: (r.data && r.data.name) || r.key, source: "pocketbase", role: "owner", sharedWith: sharesOf(r.data).length, count: ((r.data && r.data.projects) || []).filter(x => x.state === "live").length }));
    const owner = await ghAccess(user); let g = null;
    if (owner) {
      g = { key: GH_LIST, name: "App development", source: "github", role: "owner", readOnly: !(await hasToken()), count: 0 };
      try { const f = await gh.read(false); const l = f.data && L.cleanList(f.data); if (l) { g.count = l.projects.filter(x => x.state === "live").length; g.name = l.name; } } catch (e) { g.error = e.message; }
    }
    const shared = await sharedWithMe(user).catch(() => []);
    send(res, 200, { lists: [...(g ? [g] : []), ...mine, ...shared], owner }); return true;
  }
  if (p === "/api/lists" && req.method === "POST") {
    if (throttled(req, "newlist:" + user.id, 20, 3600e3)) return send(res, 429, { code: "slow_down", message: "That's a lot of new lists. Try again later." }), true;
    const b = JSON.parse((await readBody(req)).toString() || "{}"), name = L.str(b.name, 80);
    if (!name) return send(res, 400, { code: "no_name", message: "Give the list a name." }), true;
    const rows = await listRows(user.id);
    if (rows.length >= MAX_LISTS) return send(res, 400, { code: "too_many", message: "You have " + MAX_LISTS + " lists already. Delete one first." }), true;
    const have = new Set(rows.map(r => r.key)); let key = L.slug(name), n = 2; if (key === GH_LIST) key = "list-" + key;
    while (have.has(key)) key = L.slug(name) + "-" + n++;
    await putData(user.id, key, emptyList(name)); send(res, 200, { key }); return true;
  }
  const m = p.match(/^\/api\/list\/(shared--[a-z0-9]{1,32}--[a-z0-9-]{1,70}|[a-z0-9-]{1,70})(\/apply|\/share|\/leave)?$/);
  if (!m) return false;
  const key = m[1], isGh = key === GH_LIST, sub = m[2] || "";
  if (isGh && !(await ghAccess(user))) return noAccess(res);   // the GitHub list is only ever the owner's, and cannot be shared
  const acc = isGh ? { kind: "gh", role: "owner" } : await access(user, key);
  if (!acc) return send(res, 404, { code: "no_list", message: "That list doesn't exist, or isn't shared with you any more." }), true;
  const canEdit = acc.role !== "view";

  if (!sub && req.method === "GET") {
    const since = url.searchParams.get("sha") || "";
    if (isGh) {
      const f = await gh.read(false), l = (f.data && L.cleanList(f.data)) || emptyList("App development"), worked = await workedMap(l);
      const stamp = (f.sha || "none") + ":" + hashOf(JSON.stringify(worked));
      if (since && since === stamp) return send(res, 200, { unchanged: true, sha: stamp }), true;
      send(res, 200, { sha: stamp, list: l, worked, readOnly: !(await hasToken()), source: "github", role: "owner" }); return true;
    }
    const d = acc.data, l = L.cleanList(d) || emptyList(d.name || acc.key), worked = await workedMap(l, true), shares = acc.role === "owner" ? sharesOf(d) : undefined;
    const stamp = hashOf(JSON.stringify(l) + JSON.stringify(worked) + acc.role + JSON.stringify(shares || ""));
    if (since && since === stamp) return send(res, 200, { unchanged: true, sha: stamp }), true;
    send(res, 200, { sha: stamp, list: l, worked, readOnly: !canEdit, source: acc.kind === "shared" ? "shared" : "pocketbase", role: acc.role, shares, by: acc.kind === "shared" ? await nameOf(acc.owner) : undefined }); return true;
  }
  if (sub === "/apply" && req.method === "POST") {
    const b = JSON.parse((await readBody(req)).toString() || "{}");
    if (isGh) {
      try { await gh.write(mutateFor("App development", b), b.message ? L.str(b.message, 100) : "Tracker: update projects"); }
      catch (e) { if (e instanceof makeGitHub.GitHubError) return send(res, e.code === "read_only" ? 403 : e.code === "conflict" ? 409 : 502, { code: e.code, message: e.message }), true; throw e; }
      send(res, 200, { ok: true }); return true;
    }
    if (!canEdit) return send(res, 403, { code: "read_only", message: "This list was shared with you to view only." }), true;
    const next = mutateFor(acc.data.name || acc.key, b)(acc.data);
    if (acc.data.shares) next.shares = acc.data.shares;   // cleanList drops fields it doesn't know, so put the shares back
    await putData(acc.owner, acc.key, next); send(res, 200, { ok: true }); return true;
  }
  if (sub === "/share" && req.method === "POST") {
    if (acc.kind !== "own") return send(res, 403, { code: "not_yours", message: "Only the person who made a list can share it." }), true;
    if (throttled(req, "share:" + user.id, 40, 3600e3)) return send(res, 429, { code: "slow_down", message: "Too many share changes. Try again later." }), true;
    const b = JSON.parse((await readBody(req)).toString() || "{}"), email = String(b.email || "").trim().toLowerCase();
    if (!validEmail(email)) return send(res, 400, { code: "bad_email", message: "Enter the email address of their JoolzApp account." }), true;
    if (email === myEmail(user)) return send(res, 400, { code: "self", message: "That's your own address." }), true;
    let shares = sharesOf(acc.data).filter(s => s.email !== email);
    if (!b.remove) {
      if (shares.length >= MAX_SHARES) return send(res, 400, { code: "too_many", message: "A list can be shared with up to " + MAX_SHARES + " people." }), true;
      shares.push({ email, role: b.role === "edit" ? "edit" : "view", at: new Date().toISOString() });
    }
    await putData(user.id, key, { ...acc.data, shares });
    if (b.remove) await delRow(emailKey(email), `${user.id}--${key}`); else await putData(emailKey(email), `${user.id}--${key}`, { from: user.id, key });
    send(res, 200, { ok: true, shares }); return true;
  }
  if (sub === "/leave" && req.method === "POST") {
    if (acc.kind !== "shared") return send(res, 400, { code: "not_shared", message: "That list isn't shared with you." }), true;
    await putData(acc.owner, acc.key, { ...acc.data, shares: sharesOf(acc.data).filter(s => s.email !== myEmail(user)) });
    await delRow(emailKey(myEmail(user)), `${acc.owner}--${acc.key}`); send(res, 200, { ok: true }); return true;
  }
  if (!sub && req.method === "DELETE" && acc.kind === "own") {
    for (const s of sharesOf(acc.data)) await delRow(emailKey(s.email), `${user.id}--${key}`).catch(() => {});
    await delRow(user.id, key); send(res, 200, { ok: true }); return true;
  }
  return false;
}

// The built-in chat helper: the person's own AI key, one project at a time. It can only propose changes (see helper.js).
async function aiChat(req, res, user) {
  if (throttled(req, "aichat:" + user.id, 20, 60e3)) return send(res, 429, { code: "slow_down", message: "That's a lot of messages. Wait a moment." });
  const b = JSON.parse((await readBody(req)).toString() || "{}"), cfg = makeAi.resolve(user);
  if (!cfg) return send(res, 400, { code: "no_ai_key", message: "No AI key is set for Project Pilot yet. Add one in Portal Admin > My settings > AI." });
  const key = String(b.list || ""), isGh = key === GH_LIST;
  if (!(KEY_RE.test(key) || SHARED_RE.test(key))) return send(res, 400, { code: "bad_list", message: "Unknown list." });
  if (isGh && !(await ghAccess(user))) return noAccess(res);
  let raw = null; if (isGh) { const f = await gh.read(false); raw = f.data; } else { const a = await access(user, key); raw = a && a.data; }
  const list = raw && L.cleanList(raw); if (!list) return send(res, 404, { code: "no_list", message: "That list doesn't exist." });
  const project = list.projects.find(x => x.id === b.project && x.state !== "bin"); if (!project) return send(res, 404, { code: "no_project", message: "That project isn't in the list any more." });
  const conf = await loadGhConfig(false), prefs = (user.portal && user.portal.prefs && user.portal.prefs["project-tracker"]) || {};
  try {
    const worked = (await workedMap(list, !isGh))[project.id] || "";
    const out = await helper.run({ ai: aiClient, cfg, list, project, worked, autoGlobal: prefs.auto !== false, days: prefs.days, ghToken: isGh ? conf.token : "", ghRepo: conf.repo }, Array.isArray(b.messages) ? b.messages : []);
    return send(res, 200, { ...out, model: cfg.model });
  } catch (e) {
    if (e instanceof makeAi.AiError) return send(res, e.status, { code: e.code, message: e.message });
    if (e.code === "empty") return send(res, 400, { code: "empty", message: e.message });
    throw e;
  }
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
const SETUP = "<!doctype html><meta name=viewport content='width=device-width'><meta http-equiv=refresh content=5><body style='font:16px system-ui;padding:2rem;max-width:34rem;margin:auto'><h1>Waiting for PocketBase</h1><p>Project Pilot isn't connected to PocketBase yet. Open Portal Admin and sign in once; this page will carry on by itself.</p>";

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
    if (p === "/api/link" && req.method === "GET") return send(res, 200, feedHandle ? feedHandle.link() : { state: "broken", shaking: false, note: "Not reporting yet." });
    if (p === "/api/ai/status" && req.method === "GET") { const c = makeAi.resolve(user); return send(res, 200, { ready: !!c, key: makeAi.pub(c) }); }
    if (p === "/api/ai/chat" && req.method === "POST") return aiChat(req, res, user);
    if (p === "/api/prefs" && req.method === "PUT") {
      const b = JSON.parse((await readBody(req)).toString() || "{}"), prev = (user.portal && user.portal.prefs && user.portal.prefs["project-tracker"]) || {}, next = { ...prev };
      if (typeof b.list === "string" && /^[a-z0-9-]{1,120}$/.test(b.list)) next.list = b.list;
      if (["all", "active", "maintenance", "hiatus", "complete", "abandoned", "archive", "bin"].includes(b.view)) next.view = b.view;   // (an old saved "closed" view falls back to All)
      if (b.chat === "claude" || b.chat === "builtin") next.chat = b.chat;   // how the Chat button works: the Claude app, or the built-in helper
      if (typeof b.auto === "boolean") next.auto = b.auto;   // global switch for the 3-day rule (default on)
      if (Number.isInteger(b.days) && b.days >= 1 && b.days <= 30) next.days = b.days;   // length of the 3-day rule
      if (b.theme === "light" || b.theme === "dark" || b.theme === "") next.theme = b.theme;   // light / dark, or "" for the device setting
      if (typeof b.details === "boolean") next.details = b.details;   // List view: title-only rows (off) or expandable rows (on)
      if (b.layout === "grid" || b.layout === "list") next.layout = b.layout;   // grid cards or compact expandable list
      if (Array.isArray(b.tabs)) { const t = [...new Set(b.tabs.filter(x => ["all", "active", "maintenance", "hiatus", "complete", "abandoned", "archive", "bin"].includes(x)))]; if (t.length) next.tabs = t; }   // which tabs show (Settings > Tabs shown)
      if (Array.isArray(b.groups)) { const g = [...new Set(b.groups.filter(x => ["active", "maintenance", "hiatus", "complete", "abandoned"].includes(x)))]; if (g.length) next.groups = g; }   // order of the groups in the All tab (Settings, drag)
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
// Status feed (read by the owner and Claude through GitHub): project and note counts only, nothing private. See status-feed.js.
// A change in these numbers is a "change" for the top bar's handshake (Claude sets a note to "review" -> the counts move).
async function feedPayload() {
  const out = { app: "project-tracker", version: require("./package.json").version, accounts: !!pb.enabled };
  try {
    const f = await gh.read(false), l = f.data && L.cleanList(f.data), notes = { open: 0, review: 0 };
    if (l) { out.projects = l.projects.filter(x => x.state === "live").length; for (const x of (f.data.projects || [])) for (const n of (x.notes || [])) { if (n && n.state === "review") notes.review++; else if (n && n.state !== "done") notes.open++; } out.notes = notes; }
  } catch (e) { out.listError = String(e.code || e.message || "error").slice(0, 60); }
  return out;
}
let feedHandle = null;
try { fs.mkdirSync(process.env.DATA_DIR || path.join(__dirname, "data"), { recursive: true }); } catch { /* Portal Admin links an app once its data folder exists */ }
if (require.main === module) feedHandle = require("./status-feed")({ dataDir: process.env.DATA_DIR || path.join(__dirname, "data"), getPayload: feedPayload, log: m => console.error(m) });
server.listen(PORT, () => console.log(`Project Pilot running on http://0.0.0.0:${PORT}`));
