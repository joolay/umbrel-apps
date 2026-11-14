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
  if (!have.has("dob")) patch[key] = [...(col[key] || []), mk("dob")];
  if (col.createRule !== null && col.createRule !== SERVER_ONLY) patch.createRule = SERVER_ONLY;
  const ref = key === "fields" ? "@request.body." : "@request.data.";
  if (typeof col.updateRule === "string" && col.updateRule.includes("isAdmin:isset = false") && !col.updateRule.includes("dob:isset")) patch.updateRule = col.updateRule + " && " + ref + "dob:isset = false";
  if (Object.keys(patch).length) await asSuper("PATCH", "/api/collections/" + encodeURIComponent(COLL), patch);
  return col.createRule !== null || patch.createRule !== undefined;
}
async function createUser({ email, password, name, dob }) {
  return asSuper("POST", rec(), { email, password, passwordConfirm: password, name: name || "", emailVisibility: true, isAdmin: false, dob });
}
// Who is this signed-in person? (their own PocketBase token, refreshed)
async function userFromToken(token) {
  try { const j = await raw("POST", "/api/collections/" + encodeURIComponent(COLL) + "/auth-refresh", { token }); return j.record; }
  catch (e) { if ([400, 401, 403, 404].includes(e.status)) return null; throw e; }
}
async function getUser(id) { return asSuper("GET", rec("/" + encodeURIComponent(id))); }
async function setDob(id, dob) { await asSuper("PATCH", rec("/" + encodeURIComponent(id)), { dob }); }
module.exports = { getUser, setDob, userFromToken, ready, asSuper, findByEmail, createUser, usersSchema, PBError, collection: COLL };
