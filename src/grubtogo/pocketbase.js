// Small PocketBase client for JoolzApp accounts. No npm dependencies.
//
// One JoolzApp account works in every app that talks to the same PocketBase:
//   - the `users` collection holds who the person is, plus a global `isAdmin` flag,
//     so an admin is an admin in every app, including ones you build later;
//   - the `app_access` collection holds the per-app part (trial used, trial limit, unlimited),
//     one row per person per app, so a trial in one app doesn't use up another's.
// Copy this file and make-admin.js into a new app and set POCKETBASE_APP_ID to its name.
//
// Accounts are optional: they switch on when POCKETBASE_URL and the superuser login are set.
// Works with PocketBase 0.22 (admins, "schema") and 0.23+ (_superusers, "fields").
"use strict";

// Secrets can live in <data folder>/pocketbase.env (KEY=value lines) instead of the compose file.
// That is how the Umbrel app is configured, since its compose file sits in a public GitHub repo.
try {
  const f = require("path").join(require("path").resolve(process.env.DATA_DIR || require("path").join(__dirname, "data")), "pocketbase.env");
  for (const line of require("fs").readFileSync(f, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*(POCKETBASE_[A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
  }
} catch {}

// The PocketBase app on this Umbrel publishes port 5400; host.docker.internal reaches it from this container.
const URL_BASE = (process.env.POCKETBASE_URL || "http://host.docker.internal:5400").replace(/\/+$/, "");
const SU_EMAIL = process.env.POCKETBASE_SUPERUSER_EMAIL || "";
const SU_PASS = process.env.POCKETBASE_SUPERUSER_PASSWORD || "";
const COLL = process.env.POCKETBASE_USERS_COLLECTION || "users";
const APP = (process.env.POCKETBASE_APP_ID || "grubtogo").trim().toLowerCase();
const ACCESS = process.env.POCKETBASE_ACCESS_COLLECTION || "app_access";

const APP_NAME = (process.env.POCKETBASE_APP_NAME || (APP === "grubtogo" ? "GrubToGo" : APP)).trim();

const enabled = !!(URL_BASE && SU_EMAIL && SU_PASS);

class PBError extends Error {
  constructor(status, message, data) { super(message); this.status = status; this.data = data; }
}

async function raw(method, path, { token, body, timeout = 10000 } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = token;
  let r;
  try {
    r = await fetch(URL_BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
  } catch (e) {
    throw new PBError(0, "Can't reach PocketBase at " + URL_BASE + " (" + (e.cause?.code || e.message) + ")");
  }
  if (r.status === 204) return null;
  const text = await r.text();
  let j = {}; try { j = JSON.parse(text); } catch {}
  if (!r.ok) throw new PBError(r.status, j.message || ("PocketBase error " + r.status), j.data);
  return j;
}

/* ---------- superuser session (cached, renewed when it expires) ---------- */
let suToken = "", suUntil = 0, suLogin = null;
async function superToken(force) {
  if (!force && suToken && Date.now() < suUntil) return suToken;
  if (suLogin) return suLogin;
  suLogin = (async () => {
    const creds = { identity: SU_EMAIL, password: SU_PASS };
    let j;
    try { j = await raw("POST", "/api/collections/_superusers/auth-with-password", { body: creds }); }
    catch (e) {
      if (e.status !== 404) throw e;
      j = await raw("POST", "/api/admins/auth-with-password", { body: creds }); // PocketBase 0.22 and older
    }
    suToken = j.token; suUntil = Date.now() + 20 * 60 * 1000;
    return suToken;
  })();
  try { return await suLogin; } finally { suLogin = null; }
}
async function asSuper(method, path, body) {
  try { return await raw(method, path, { token: await superToken(), body }); }
  catch (e) {
    if (e.status === 401 || e.status === 403) return raw(method, path, { token: await superToken(true), body });
    throw e;
  }
}

/* ---------- shared schema: isAdmin on users, plus the per-app access collection ---------- */
let ready = null;
function ensureSchema() {
  if (!ready) ready = (async () => {
    const col = await asSuper("GET", "/api/collections/" + encodeURIComponent(COLL));
    const key = col.fields ? "fields" : "schema";
    const mk = (name, type, required) => key === "fields" ? { name, type, required: !!required } : { name, type, required: !!required, options: {} };
    const have = new Set((col[key] || []).map(f => f.name));
    const patch = {};
    if (!have.has("isAdmin")) patch[key] = [...(col[key] || []), mk("isAdmin", "bool")];
    // Stop people changing their own admin flag straight through PocketBase's API.
    const ref = key === "fields" ? "@request.body." : "@request.data.";
    const guard = `${ref}isAdmin:isset = false`;
    if (col.updateRule === "id = @request.auth.id") patch.updateRule = "id = @request.auth.id && " + guard;
    if (col.createRule === "") patch.createRule = guard;
    if (Object.keys(patch).length) await asSuper("PATCH", "/api/collections/" + encodeURIComponent(COLL), patch);

    // Per-app access rows. No API rules, so only the superuser (the app servers) can read or write them.
    // `access` = this person may open this app's inventory (admins always can).
    let acol = null;
    try { acol = await asSuper("GET", "/api/collections/" + encodeURIComponent(ACCESS)); }
    catch (e) { if (e.status !== 404) throw e; }
    if (!acol) {
      const fields = [mk("user", "text", true), mk("app", "text", true), mk("trialUsed", "number"), mk("trialLimit", "number"), mk("unlimited", "bool"), mk("access", "bool")];
      try {
        await asSuper("POST", "/api/collections", {
          name: ACCESS, type: "base", [key]: fields,
          indexes: [`CREATE UNIQUE INDEX \`idx_${ACCESS}_user_app\` ON \`${ACCESS}\` (\`user\`, \`app\`)`],
          listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null,
        });
      } catch (e2) { if (e2.status !== 400) throw e2; } // another app server may have created it a moment ago
    } else {
      const akey = acol.fields ? "fields" : "schema";
      if (!(acol[akey] || []).some(f => f.name === "access")) await asSuper("PATCH", "/api/collections/" + encodeURIComponent(ACCESS), { [akey]: [...(acol[akey] || []), mk("access", "bool")] });
    }
    await ensurePortalApp();
  })().catch(e => { ready = null; throw e; });
  return ready;
}

/* ---------- per-app access ---------- */
const colPath = "/api/collections/" + encodeURIComponent(COLL);
const rec = p => colPath + "/records" + (p || "");
const accPath = p => "/api/collections/" + encodeURIComponent(ACCESS) + "/records" + (p || "");
const esc = s => String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
const q = f => encodeURIComponent(f);
const ACCESS_KEYS = new Set(["trialUsed", "trialLimit", "unlimited", "access", "trialUsed+", "trialUsed-"]);

function merge(u, a) {
  return { ...u, unlimited: !!(a && a.unlimited), access: !!(a && a.access), trialUsed: Math.max(0, +(a && a.trialUsed) || 0), trialLimit: Math.max(0, +(a && a.trialLimit) || 0) };
}
async function getAccess(userId, create) {
  const f = `user = '${esc(userId)}' && app = '${esc(APP)}'`;
  const find = async () => ((await asSuper("GET", accPath(`?page=1&perPage=1&filter=${q(f)}`))).items || [])[0] || null;
  let a = await find();
  if (!a && create) {
    try { a = await asSuper("POST", accPath(), { user: userId, app: APP, trialUsed: 0, trialLimit: 0, unlimited: false }); }
    catch (e) { if (e.status !== 400) throw e; a = await find(); } // lost a race with another request
  }
  return a;
}


/* ---------- Portal Admin (optional): per-app approval, app on/off, and shared user preferences ---------- */
// Portal Admin keeps its settings in `portal_settings` (and apps in `portal_apps`, requests in `portal_requests`).
// Precedence: global < app < user (all apps) < user x app. `portal.access = false` blocks; `pref.*` are the person's
// shared preferences (language, currency, timezone, dateFormat, timeFormat, units, theme). If those collections don't
// exist (the portal isn't installed) every function here quietly returns null and the app falls back to its own rules.
const portalCache = new Map();
async function cached(key, ttl, fn) {
  const c = portalCache.get(key);
  if (c && Date.now() - c.at < ttl) return c.v;
  let v; try { v = await fn(); } catch (e) { if (e.status === 404) v = null; else throw e; }
  portalCache.set(key, { v, at: Date.now() });
  return v;
}
const portalClear = () => portalCache.clear();
const rank = r => r.scope === "global" ? 0 : r.scope === "app" ? 1 : (r.app ? 3 : 2);
function resolvePortal(rows, userId) {
  const mine = rows.filter(r => r.scope === "global" || (r.scope === "app" && r.app === APP) || (r.scope === "user" && r.user === userId && (r.app === "" || r.app === APP))).sort((a, b) => rank(a) - rank(b));
  const eff = {}; for (const r of mine) eff[r.key] = r.value;
  const prefs = {}; for (const [k, v] of Object.entries(eff)) if (k.startsWith("pref.")) prefs[k.slice(5)] = v;
  return { access: eff["portal.access"] !== false, prefs };
}
async function portalRowsFor(userId) {
  const f = `(key = 'portal.access' || key ~ 'pref.') && (scope = 'global' || (scope = 'app' && app = '${esc(APP)}') || (scope = 'user' && user = '${esc(userId)}'))`;
  const j = await asSuper("GET", `/api/collections/portal_settings/records?page=1&perPage=200&filter=${q(f)}`);
  return j.items || [];
}
async function portalApp() {
  return cached("app", 10000, async () => {
    const j = await asSuper("GET", `/api/collections/portal_apps/records?page=1&perPage=1&filter=${q(`slug = '${esc(APP)}'`)}`);
    const a = (j.items || [])[0]; return a ? { enabled: a.enabled !== false, maintenance: !!a.maintenance, message: a.message || "" } : { enabled: true, maintenance: false, message: "" };
  });
}
// { access, prefs, app } for one person, or null when the portal isn't set up.
async function portalFor(userId) {
  const rows = await cached("u:" + userId, 10000, () => portalRowsFor(userId));
  if (rows === null) return null;
  return { ...resolvePortal(rows, userId), app: await portalApp() };
}
// userId -> allowed, for the admin Users list (one pass instead of one query per person).
async function portalAccessMap() {
  const rows = await cached("all", 10000, async () => {
    const out = []; let page = 1;
    for (;;) {
      const j = await asSuper("GET", `/api/collections/portal_settings/records?page=${page}&perPage=200&filter=${q(`key = 'portal.access' && (scope = 'global' || (scope = 'app' && app = '${esc(APP)}') || scope = 'user')`)}`);
      out.push(...(j.items || []));
      if (page >= (j.totalPages || 1) || page >= 50) break;
      page++;
    }
    return out;
  });
  return rows === null ? null : (userId => resolvePortal(rows, userId).access);
}
const withPortal = async rec => ({ ...rec, portal: await portalFor(rec.id) });
async function portalAvailable() { return (await cached("avail", 30000, async () => { await asSuper("GET", "/api/collections/portal_settings"); return true; })) === true; }
// Allow or block one person for this app. Allowing also closes any pending request they made for it.
async function setPortalAccess(userId, allowed) {
  const f = `scope = 'user' && user = '${esc(userId)}' && app = '${esc(APP)}' && key = 'portal.access'`;
  const ex = ((await asSuper("GET", `/api/collections/portal_settings/records?page=1&perPage=1&filter=${q(f)}`)).items || [])[0];
  if (ex) await asSuper("PATCH", `/api/collections/portal_settings/records/${ex.id}`, { value: !!allowed });
  else await asSuper("POST", "/api/collections/portal_settings/records", { scope: "user", user: userId, app: APP, key: "portal.access", value: !!allowed });
  if (allowed) {
    try {
      const r = await asSuper("GET", `/api/collections/portal_requests/records?page=1&perPage=50&filter=${q(`user = '${esc(userId)}' && app = '${esc(APP)}' && status = 'pending'`)}`);
      for (const x of r.items || []) await asSuper("PATCH", `/api/collections/portal_requests/records/${x.id}`, { status: "approved", decided_by: "GrubToGo admin" });
    } catch (e) { if (e.status !== 404) throw e; }
  }
  portalClear();
}
// Make sure this app is listed in the portal so people can find it and ask for access.
async function ensurePortalApp() {
  try {
    const j = await asSuper("GET", `/api/collections/portal_apps/records?page=1&perPage=1&filter=${q(`slug = '${esc(APP)}'`)}`);
    if (!(j.items || []).length) await asSuper("POST", "/api/collections/portal_apps/records", { slug: APP, name: APP_NAME, enabled: true });
  } catch (e) { if (e.status !== 404 && e.status !== 400) console.error("Portal app registration:", e.message); }
}
// Sign-ups follow the users collection's own create rule, which the portal switches (null = closed).
async function signupsOpen() {
  const col = await cached("signups", 15000, () => asSuper("GET", "/api/collections/" + encodeURIComponent(COLL)));
  return !col || col.createRule !== null;
}
// Clear the portal's rows for a person who is being deleted.
async function portalForget(userId) {
  for (const [coll, f] of [["portal_settings", `scope = 'user' && user = '${esc(userId)}'`], ["portal_requests", `user = '${esc(userId)}'`]]) {
    try {
      for (let i = 0; i < 20; i++) {
        const j = await asSuper("GET", `/api/collections/${coll}/records?page=1&perPage=200&filter=${q(f)}`);
        if (!(j.items || []).length) break;
        for (const x of j.items) await asSuper("DELETE", `/api/collections/${coll}/records/${x.id}`);
      }
    } catch (e) { if (e.status !== 404) throw e; }
  }
  portalClear();
}

/* ---------- users ---------- */
// Sends PocketBase's own reset email (the same one Portal Admin's "Forgot password?" sends).
async function requestPasswordReset(email) { await raw("POST", colPath + "/request-password-reset", { body: { email } }); }
async function login(email, password) {
  await ensureSchema();
  const j = await raw("POST", colPath + "/auth-with-password", { body: { identity: email, password } });
  return { ...j, record: await withPortal(merge(j.record, await getAccess(j.record.id, true))) };
}
async function verifyToken(token) {
  // PocketBase checks the signature and expiry; the record comes back fresh from the database.
  const j = await raw("POST", colPath + "/auth-refresh", { token });
  return { ...j, record: await withPortal(merge(j.record, await getAccess(j.record.id, true))) };
}
async function createUser({ email, password, name }) {
  await ensureSchema();
  const u = await asSuper("POST", rec(), { email, password, passwordConfirm: password, name: name || "", emailVisibility: true, isAdmin: false });
  return merge(u, null);
}
async function listUsers(search) {
  await ensureSchema();
  const users = []; let page = 1;
  const filter = search ? `&filter=${q(`(email ~ '${esc(search)}' || name ~ '${esc(search)}')`)}` : "";
  for (;;) {
    const j = await asSuper("GET", rec(`?page=${page}&perPage=200&sort=-created${filter}`));
    users.push(...(j.items || []));
    if (page >= (j.totalPages || 1) || page >= 10) break;
    page++;
  }
  const byUser = new Map(); page = 1;
  for (;;) {
    const j = await asSuper("GET", accPath(`?page=${page}&perPage=200&filter=${q(`app = '${esc(APP)}'`)}`));
    for (const a of j.items || []) byUser.set(a.user, a);
    if (page >= (j.totalPages || 1) || page >= 25) break;
    page++;
  }
  const allowed = await portalAccessMap();
  return users.map(u => { const m = merge(u, byUser.get(u.id)); return allowed ? { ...m, portal: { access: allowed(u.id), prefs: {}, app: null } } : m; });
}
async function getUser(id) {
  await ensureSchema();
  const u = await asSuper("GET", rec("/" + encodeURIComponent(id)));
  return withPortal(merge(u, await getAccess(id, true)));
}
// Changes the per-app part only (trial counters, unlimited). Used on every AI request, so it stays lean.
async function updateAccess(id, data) {
  await ensureSchema();
  const a = await getAccess(id, true);
  return asSuper("PATCH", accPath("/" + encodeURIComponent(a.id)), data);
}
async function updateUser(id, data) {
  await ensureSchema();
  const userData = {}, accessData = {};
  for (const [k, v] of Object.entries(data)) (ACCESS_KEYS.has(k) ? accessData : userData)[k] = v;
  if (Object.keys(userData).length) await asSuper("PATCH", rec("/" + encodeURIComponent(id)), userData);
  if (Object.keys(accessData).length) await updateAccess(id, accessData);
  return getUser(id);
}
async function deleteUser(id) {
  await ensureSchema();
  // The JoolzApp account goes away everywhere, so clear its access rows in every app first.
  for (let i = 0; i < 20; i++) {
    const j = await asSuper("GET", accPath(`?page=1&perPage=200&filter=${q(`user = '${esc(id)}'`)}`));
    if (!(j.items || []).length) break;
    for (const a of j.items) await asSuper("DELETE", accPath("/" + encodeURIComponent(a.id)));
  }
  await portalForget(id);
  return asSuper("DELETE", rec("/" + encodeURIComponent(id)));
}
// The oldest admin account: the person who set the app up. The inventory that existed before accounts moves to them.
async function firstAdmin() {
  await ensureSchema();
  const j = await asSuper("GET", rec(`?page=1&perPage=1&sort=created&filter=${q("isAdmin = true")}`));
  return (j.items || [])[0] || null;
}
// Raw request as the superuser (file uploads and downloads), renewing the login if it has expired.
async function superFetch(path, init = {}, timeout = 60000) {
  const go = async force => fetch(URL_BASE + path, { ...init, headers: { ...(init.headers || {}), authorization: await superToken(force) }, signal: AbortSignal.timeout(timeout) });
  let r;
  try { r = await go(false); if (r.status === 401 || r.status === 403) r = await go(true); }
  catch (e) { throw new PBError(0, "Can't reach PocketBase at " + URL_BASE + " (" + (e.cause?.code || e.message) + ")"); }
  return r;
}
async function countAdmins() {
  await ensureSchema();
  const j = await asSuper("GET", rec(`?page=1&perPage=1&filter=${q("isAdmin = true")}`));
  return j.totalItems || 0;
}
async function findByEmail(email) {
  await ensureSchema();
  const j = await asSuper("GET", rec(`?page=1&perPage=1&filter=${q(`email = '${esc(email)}'`)}`));
  return (j.items || [])[0] || null;
}


// ---- free trial counter and per-person settings (stored in the portal's settings table, written with the superuser) ----
const TRIAL_KEY = "trial.ai";
async function trialUsed(userId) {
  const f = `scope = 'user' && user = '${esc(userId)}' && app = '${esc(APP)}' && key = '${TRIAL_KEY}'`;
  try {
    const j = await asSuper("GET", `/api/collections/portal_settings/records?page=1&perPage=1&filter=${q(f)}`);
    const r = (j.items || [])[0]; return { id: r ? r.id : "", used: r ? Number(r.value) || 0 : 0 };
  } catch (e) { if (e.status === 404) return { id: "", used: 0, noPortal: true }; throw e; }
}
async function trialBump(userId) {
  const t = await trialUsed(userId); if (t.noPortal) return 0;
  if (t.id) await asSuper("PATCH", `/api/collections/portal_settings/records/${t.id}`, { value: t.used + 1 });
  else await asSuper("POST", "/api/collections/portal_settings/records", { scope: "user", user: userId, app: APP, key: TRIAL_KEY, value: 1, secret: false });
  return t.used + 1;
}
// Saves "pref.<name>" rows for one person (used for the AI choice made while creating an account).
async function setUserPrefs(userId, prefs) {
  for (const [k, v] of Object.entries(prefs)) {
    if (v === "" || v == null) continue;
    try { await asSuper("POST", "/api/collections/portal_settings/records", { scope: "user", user: userId, app: "", key: "pref." + k, value: v, secret: false }); } catch (e) { if (e.status !== 400 && e.status !== 404) throw e; }
  }
  portalCache.delete("u:" + userId);
}

// Address of the JoolzApp dashboard (Portal Admin), from the global "portal.url" setting. Empty means "work it out from the browser".
async function portalUrl() {
  return (await cached("purl", 30000, async () => {
    const f = "scope = 'global' && key = 'portal.url'";
    const j = await asSuper("GET", `/api/collections/portal_settings/records?page=1&perPage=1&filter=${q(f)}`);
    const v = (j.items || [])[0] && j.items[0].value; return typeof v === "string" && /^https?:\/\//i.test(v) ? v : "";
  })) || "";
}
module.exports = { portalUrl, requestPasswordReset, trialUsed, trialBump, setUserPrefs, portalAvailable, setPortalAccess, signupsOpen, enabled, PBError, login, verifyToken, createUser, listUsers, getUser, updateUser, updateAccess, deleteUser, countAdmins, findByEmail, firstAdmin, asSuper, superFetch, ensureSchema, collection: COLL, app: APP };
