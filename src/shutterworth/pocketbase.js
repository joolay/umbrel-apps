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

const URL_BASE = (process.env.POCKETBASE_URL || "").replace(/\/+$/, "");
const SU_EMAIL = process.env.POCKETBASE_SUPERUSER_EMAIL || "";
const SU_PASS = process.env.POCKETBASE_SUPERUSER_PASSWORD || "";
const COLL = process.env.POCKETBASE_USERS_COLLECTION || "users";
const APP = (process.env.POCKETBASE_APP_ID || "shutterworth").trim().toLowerCase();
const ACCESS = process.env.POCKETBASE_ACCESS_COLLECTION || "app_access";

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

/* ---------- users ---------- */
async function login(email, password) {
  await ensureSchema();
  const j = await raw("POST", colPath + "/auth-with-password", { body: { identity: email, password } });
  return { ...j, record: merge(j.record, await getAccess(j.record.id, true)) };
}
async function verifyToken(token) {
  // PocketBase checks the signature and expiry; the record comes back fresh from the database.
  const j = await raw("POST", colPath + "/auth-refresh", { token });
  return { ...j, record: merge(j.record, await getAccess(j.record.id, true)) };
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
  return users.map(u => merge(u, byUser.get(u.id)));
}
async function getUser(id) {
  await ensureSchema();
  const u = await asSuper("GET", rec("/" + encodeURIComponent(id)));
  return merge(u, await getAccess(id, true));
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

module.exports = { enabled, PBError, login, verifyToken, createUser, listUsers, getUser, updateUser, updateAccess, deleteUser, countAdmins, findByEmail, firstAdmin, asSuper, superFetch, ensureSchema, collection: COLL, app: APP };
