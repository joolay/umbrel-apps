// Lean PocketBase client for the one JoolzApp sign-up page. Zero dependencies.
// Creating accounts needs the superuser, because date of birth and parent approval are checked on the server, not in the browser.
// Credentials: <data folder>/pocketbase.env (POCKETBASE_SUPERUSER_EMAIL / _PASSWORD). If that file doesn't exist yet, they are copied
// once from an app you already connected with the "Connect" button (<umbrel app-data>/joolay-*/data/pocketbase.env).
"use strict";
const fs = require("fs"), path = require("path");

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, "data"));
const APPS_DIR = process.env.UMBREL_APPS_DIR || "/umbrel-app-data";
const OWN_ENV = path.join(DATA_DIR, "pocketbase.env");
const COLL = process.env.POCKETBASE_USERS_COLLECTION || "users";
const URL_BASE = () => (process.env.PB_URL || "http://host.docker.internal:5400").replace(/\/+$/, "");

class PBError extends Error { constructor(status, message, data) { super(message); this.status = status; this.data = data; } }

const parseEnv = txt => { const o = {}; for (const line of String(txt).split(/\r?\n/)) { const m = line.match(/^\s*(POCKETBASE_[A-Z_]+)\s*=\s*(.*?)\s*$/); if (m) o[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2"); } return o; };
function creds() {
  const read = f => { try { return parseEnv(fs.readFileSync(f, "utf8")); } catch { return {}; } };
  let c = read(OWN_ENV);
  if (!(c.POCKETBASE_SUPERUSER_EMAIL && c.POCKETBASE_SUPERUSER_PASSWORD)) {
    try {
      for (const d of fs.readdirSync(APPS_DIR)) {
        if (!/^joolay-/.test(d) || d === "joolay-portal-admin") continue;
        const o = read(path.join(APPS_DIR, d, "data", "pocketbase.env"));
        if (o.POCKETBASE_SUPERUSER_EMAIL && o.POCKETBASE_SUPERUSER_PASSWORD) {
          c = o; try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(OWN_ENV, `POCKETBASE_SUPERUSER_EMAIL=${o.POCKETBASE_SUPERUSER_EMAIL}\nPOCKETBASE_SUPERUSER_PASSWORD=${o.POCKETBASE_SUPERUSER_PASSWORD}\n`, { mode: 0o600 }); } catch {}
          break;
        }
      }
    } catch {}
  }
  return { email: c.POCKETBASE_SUPERUSER_EMAIL || "", pass: c.POCKETBASE_SUPERUSER_PASSWORD || "" };
}
const ready = () => { const c = creds(); return !!(c.email && c.pass); };

async function raw(method, p, { token, body } = {}) {
  const headers = {}; if (body !== undefined) headers["content-type"] = "application/json"; if (token) headers.authorization = token;
  let r;
  try { r = await fetch(URL_BASE() + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) }); }
  catch (e) { throw new PBError(0, "Can't reach PocketBase (" + (e.cause?.code || e.message) + ")"); }
  if (r.status === 204) return null;
  const text = await r.text(); let j = {}; try { j = JSON.parse(text); } catch {}
  if (!r.ok) throw new PBError(r.status, j.message || ("PocketBase error " + r.status), j.data);
  return j;
}
let suToken = "", suUntil = 0;
async function superToken(force) {
  if (!force && suToken && Date.now() < suUntil) return suToken;
  const c = creds(); if (!c.email) throw new PBError(503, "Sign-up isn't connected to PocketBase yet. An admin needs to use Connect on one of the apps first.");
  const body = { identity: c.email, password: c.pass };
  let j;
  try { j = await raw("POST", "/api/collections/_superusers/auth-with-password", { body }); }
  catch (e) { if (e.status !== 404) throw e; j = await raw("POST", "/api/admins/auth-with-password", { body }); }
  suToken = j.token; suUntil = Date.now() + 20 * 60 * 1000; return suToken;
}
async function asSuper(method, p, body) {
  try { return await raw(method, p, { token: await superToken(), body }); }
  catch (e) { if (e.status === 401 || e.status === 403) return raw(method, p, { token: await superToken(true), body }); throw e; }
}

const q = s => encodeURIComponent(s), esc = s => String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
const rec = p => "/api/collections/" + encodeURIComponent(COLL) + "/records" + (p || "");
async function findByEmail(email) {
  const j = await asSuper("GET", rec(`?page=1&perPage=1&filter=${q(`email = '${esc(email)}'`)}`));
  return (j.items || [])[0] || null;
}
// Sign-ups are "open" when the users collection has a create rule at all (the Portal Admin toggle). The rule itself can never be met by a
// browser: accounts are only created here, by the server, after date of birth and parent checks.
const SERVER_ONLY = '@request.body.email:isset = false && @request.body.email:isset = true';
async function usersSchema() {
  const col = await asSuper("GET", "/api/collections/" + encodeURIComponent(COLL));
  const key = col.fields ? "fields" : "schema", have = new Set((col[key] || []).map(f => f.name)), patch = {};
  const mk = n => key === "fields" ? { name: n, type: "text" } : { name: n, type: "text", options: {} };
  const extra = [!have.has("dob") && "dob", key === "fields" && !have.has("username") && "username"].filter(Boolean);
  if (extra.length) patch[key] = [...(col[key] || []), ...extra.map(mk)];
  // Sign in with a username as well as an email.
  if (key === "fields") {
    const ids = (col.passwordAuth && col.passwordAuth.identityFields) || ["email"];
    if (!ids.includes("username")) patch.passwordAuth = { ...(col.passwordAuth || { enabled: true }), identityFields: [...ids, "username"] };
    const idx = col.indexes || [];
    if (!idx.some(i => /username/i.test(i))) patch.indexes = [...idx, "CREATE UNIQUE INDEX idx_" + COLL + "_username ON " + COLL + " (username) WHERE username != ''"];
  } else if (col.options && col.options.allowUsernameAuth === false) patch.options = { ...col.options, allowUsernameAuth: true };
  if (col.createRule !== null && col.createRule !== SERVER_ONLY) patch.createRule = SERVER_ONLY;
  const ref = key === "fields" ? "@request.body." : "@request.data.";
  let ur = typeof col.updateRule === "string" && col.updateRule.includes("isAdmin:isset = false") ? col.updateRule : null;
  if (ur !== null && !ur.includes("dob:isset")) ur += " && " + ref + "dob:isset = false";
  if (ur !== null && key === "fields" && !ur.includes("username:isset")) ur += " && " + ref + "username:isset = false";   // usernames are set only through this server, which checks them
  if (ur !== null && ur !== col.updateRule) patch.updateRule = ur;
  if (Object.keys(patch).length) await asSuper("PATCH", "/api/collections/" + encodeURIComponent(COLL), patch);
  return col.createRule !== null || patch.createRule !== undefined;
}
async function createUser({ email, password, name, dob, username }) {
  return asSuper("POST", rec(), { email, password, passwordConfirm: password, name: name || "", emailVisibility: true, isAdmin: false, dob, ...(username ? { username } : {}) });
}
// Usernames: 3-30 letters, digits, dots, dashes or underscores, saved in lower case, unique, and never shaped like an email.
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,29}$/;
function cleanUsername(v) { return String(v || "").trim().toLowerCase(); }
function usernameError(u) { return USERNAME_RE.test(u) ? "" : "Use 3 to 30 letters, numbers, dots, dashes or underscores, starting with a letter or number."; }
async function findByUsername(u) {
  const j = await asSuper("GET", rec(`?page=1&perPage=1&filter=${q(`username = '${esc(u)}'`)}`));
  return (j.items || [])[0] || null;
}
async function setUsername(id, username) {
  const t = await findByUsername(username); if (t && t.id !== id) throw Object.assign(new Error("That username is taken. Try another."), { status: 409 });
  await asSuper("PATCH", rec("/" + encodeURIComponent(id)), { username });
}
// Password reset by email or username, without telling the caller whether the account exists.
async function requestReset(identity) {
  const v = String(identity || "").trim(), u = v.includes("@") ? await findByEmail(v.toLowerCase()) : await findByUsername(cleanUsername(v));
  if (u && u.email) await raw("POST", "/api/collections/" + encodeURIComponent(COLL) + "/request-password-reset", { body: { email: u.email } }).catch(() => {});
}
// Who is this signed-in person? (their own PocketBase token, refreshed)
async function userFromToken(token) {
  try { const j = await raw("POST", "/api/collections/" + encodeURIComponent(COLL) + "/auth-refresh", { token }); return j.record; }
  catch (e) { if ([400, 401, 403, 404].includes(e.status)) return null; throw e; }
}
// The PocketBase superuser who is also a regular JoolzApp person: same email in the users collection. Used for read-only extras like the events ticker.
async function userForSuperuser(token) {
  try { const j = await raw("POST", "/api/collections/_superusers/auth-refresh", { token }); return j.record && j.record.email ? await findByEmail(String(j.record.email).toLowerCase()) : null; }
  catch (e) { if ([400, 401, 403, 404].includes(e.status)) return null; throw e; }
}
// Is this a valid PocketBase superuser token?
async function isSuperuser(token) {
  try { await raw("POST", "/api/collections/_superusers/auth-refresh", { token }); return true; }
  catch (e) { if ([400, 401, 403, 404].includes(e.status)) return false; throw e; }
}
// Registered people, for picking family members. Only name and email leave here, and only to signed-in users.
async function listUsers() {
  const out = []; for (let page = 1; page <= 10; page++) {
    const j = await asSuper("GET", rec(`?page=${page}&perPage=200&sort=name&fields=id,name,email`));
    out.push(...(j.items || []).map((u) => ({ id: u.id, name: u.name || u.email.split("@")[0], email: u.email })));
    if (page >= (j.totalPages || 1)) break;
  }
  return out;
}
async function getUser(id) { return asSuper("GET", rec("/" + encodeURIComponent(id))); }
async function setDob(id, dob) { await asSuper("PATCH", rec("/" + encodeURIComponent(id)), { dob }); }
module.exports = { raw, creds, url: URL_BASE, dataDir: DATA_DIR, isSuperuser, userForSuperuser, cleanUsername, usernameError, findByUsername, setUsername, requestReset, listUsers, getUser, setDob, userFromToken, ready, asSuper, findByEmail, createUser, usersSchema, PBError, collection: COLL };
