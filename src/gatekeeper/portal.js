'use strict';
// Gatekeeper's only way to know who people are: the Portal API (Portal Admin), never PocketBase directly.
// POCKETBASE_PORTAL_URL and POCKETBASE_PORTAL_KEY come from <data>/pocketbase.env, which Portal Admin writes by itself within about 30 s of this app getting its
// data folder ("Limited login for each app" in Portal Admin > Changes). The file is re-read (at most every 2 s) until the key is there, so no restart is needed.
const fs = require('fs');
const path = require('path');
const DATA = () => path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
let looked = 0;
function envFile() {
  if (process.env.POCKETBASE_PORTAL_URL && process.env.POCKETBASE_PORTAL_KEY) return;
  if (Date.now() - looked < 2000) return; looked = Date.now();
  try {
    for (const line of fs.readFileSync(path.join(DATA(), 'pocketbase.env'), 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*(POCKETBASE_[A-Z_]+)\s*=\s*(.*?)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2');
    }
  } catch { /* not there yet */ }
}
class PortalError extends Error { constructor(status, message) { super(message); this.status = status; } }

async function call(fn, args = []) {
  envFile();
  const base = (process.env.POCKETBASE_PORTAL_URL || '').replace(/\/+$/, ''), key = process.env.POCKETBASE_PORTAL_KEY || '';
  if (!base || !key) throw new PortalError(503, 'Gatekeeper is not linked to Portal Admin yet.');
  let r;
  try { r = await fetch(base + '/app-api/call', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key }, body: JSON.stringify({ fn, args }), signal: AbortSignal.timeout(10000) }); }
  catch (e) { throw new PortalError(0, "Can't reach Portal Admin"); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new PortalError(r.status, j.message || 'Portal API error');
  if (!j.ok) throw new PortalError(j.status || 500, j.message || 'Portal API error');
  return j.result;
}
// -> { id, email, name, admin }. Throws PortalError (400/401 = wrong details).
async function signIn(email, password) {
  if (!email || !password) throw new PortalError(400, 'Enter your email and password.');
  const r = await call('login', [email, password]);
  const u = r && r.record; if (!u || !u.id) throw new PortalError(401, 'Not recognised.');
  return { id: u.id, email: u.email || email, name: u.name || '', admin: u.isAdmin === true };
}
// Names of apps Portal Admin knows, to help fill in the route form. Optional: [] when unavailable.
async function knownApps() {
  const r = await call('portalApps.list', []);
  return (Array.isArray(r) ? r : []).map((a) => ({ slug: String(a.slug || a.id || ''), name: String(a.name || a.slug || '') })).filter((a) => a.slug).slice(0, 200);
}
module.exports = { call, signIn, knownApps, PortalError };
