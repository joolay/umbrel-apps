'use strict';
// Portal Admin: tiny zero-dependency server.
//  - serves the static admin UI
//  - /config   : where PocketBase lives. Built in: the PocketBase app on this Umbrel (override with env PB_URL).
//  - /pb/*     : transparent proxy to PocketBase (so the browser needs no CORS / network access to it).
//                No credentials are held here: the browser signs in as a PocketBase superuser and sends its own token.
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const pbx = require('./pocketbase');
const guardians = require('./guardians');
const family = require('./family');
const CHILD_REQ = '__child_account__';

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, 'public');
// The Umbrel PocketBase app publishes port 5400 on the host; host.docker.internal (host-gateway) reaches it from this container.
const DEFAULT_PB_URL = 'http://host.docker.internal:5400';
const ENV_PB_URL = (process.env.PB_URL || '').trim();

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.png': 'image/png', '.ico': 'image/x-icon',
};

function normaliseUrl(v) {
  let u;
  try { u = new URL(String(v).trim()); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  return u.origin + u.pathname.replace(/\/+$/, '');
}

function currentPbUrl() {
  return (ENV_PB_URL && normaliseUrl(ENV_PB_URL)) || DEFAULT_PB_URL;
}

function send(res, code, body, headers = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': typeof body === 'object' && !Buffer.isBuffer(body) ? 'application/json' : 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store', ...headers,
  });
  res.end(data);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function proxy(req, res, pbUrl, subPath) {
  const target = new URL(pbUrl + subPath);
  const lib = target.protocol === 'https:' ? https : http;
  const headers = { ...req.headers, host: target.host };
  delete headers.origin; delete headers.referer; delete headers.cookie; delete headers['accept-encoding'];
  const up = lib.request(target, { method: req.method, headers, timeout: 30000 }, (r) => {
    const h = { ...r.headers, 'cache-control': 'no-store' };
    delete h['set-cookie'];
    res.writeHead(r.statusCode || 502, h);
    r.pipe(res);
  });
  up.on('timeout', () => up.destroy(new Error('timeout')));
  up.on('error', (e) => { if (!res.headersSent) send(res, 502, { message: 'Cannot reach PocketBase: ' + e.message }); else res.destroy(); });
  req.pipe(up);
}


// ---- Public-exposure guard -------------------------------------------------------------------------------------
// When this app is published through Tailscale Funnel (or any reverse proxy), requests from the public internet may
// reach it. Those requests may use the user-facing side (sign in, My settings, request access) but never the admin
// side: no superuser sign-in, no PocketBase admin/collection APIs, and no superuser tokens.
// A request counts as public if Tailscale marks it as Funnel traffic, or any X-Forwarded-For hop is not a
// loopback / private / tailnet (CGNAT 100.64.0.0/10) address. Set ALLOW_PUBLIC_ADMIN=1 to switch the guard off.
const ALLOW_PUBLIC_ADMIN = /^(1|true|yes)$/i.test(String(process.env.ALLOW_PUBLIC_ADMIN || ''));
const SUPERUSER_COLLECTION_ID = 'pbc_3142635823'; // PocketBase's built-in _superusers collection

function isPrivateAddr(a) {
  a = String(a || '').trim().toLowerCase().replace(/^::ffff:/, '');
  if (!a) return true;
  if (a === '::1' || a === 'localhost') return true;
  if (/^f[cd][0-9a-f]{2}:/.test(a) || /^fe80:/.test(a)) return true; // IPv6 ULA / link-local (Tailscale uses fd7a:115c:a1e0::/48)
  const m = a.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)(?::\d+)?$/);
  if (!m) return false;
  const [x, y] = [Number(m[1]), Number(m[2])];
  return x === 10 || x === 127 || (x === 192 && y === 168) || (x === 172 && y >= 16 && y <= 31) || (x === 169 && y === 254) || (x === 100 && y >= 64 && y <= 127);
}
function isPublicRequest(req) {
  if (req.publicPort) return true;   // arrived on the dedicated public port: always user-only, whatever any proxy sends or strips
  if (ALLOW_PUBLIC_ADMIN) return false;
  if (req.headers['tailscale-funnel-request'] !== undefined) return true;
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean);
  return xff.some((a) => !isPrivateAddr(a));
}
function isSuperuserToken(auth) {
  try {
    const tok = String(auth || '').replace(/^Bearer\s+/i, '');
    const payload = JSON.parse(Buffer.from(tok.split('.')[1] || '', 'base64url').toString('utf8'));
    return payload.collectionId === SUPERUSER_COLLECTION_ID;
  } catch { return false; }
}
// Only these PocketBase API calls are allowed from the public side: record access and auth flows of normal
// collections (collection rules still apply), plus health. Collection definitions, settings, backups, logs and
// every system collection (names starting with "_") stay private.
const PUBLIC_PB_ALLOW = [
  /^\/api\/health\/?$/,
  /^\/api\/collections\/(?!_)[^/]+\/(records|auth-with-password|auth-refresh|auth-methods|request-password-reset|confirm-password-reset|request-verification|confirm-verification)(\/|$)/,
  /^\/api\/files\//,
];
function publicBlockReason(req, sub) {
  if (isSuperuserToken(req.headers.authorization)) return 'Admin sessions are only available from your home network or tailnet.';
  if (!PUBLIC_PB_ALLOW.some((re) => re.test(sub))) return 'Admin sign-in is only available from your home network or tailnet.';
  return '';
}

// ---- Installed Umbrel apps ------------------------------------------------------------------------------------
// Umbrel keeps a copy of every installed app's umbrel-app.yml and docker-compose.yml in <umbrel>/app-data/<app-id>/.
// That folder is mounted here read-only so the admin page can spot newly installed apps. Only those two files are read,
// and only for the admin side (never for public requests).
const APPS_DIR = process.env.UMBREL_APPS_DIR || '/umbrel-app-data';
const SELF_ID = 'joolay-portal-admin';
let appsCache = { at: 0, v: null };
const yamlKey = (txt, k) => { const m = txt.match(new RegExp('^' + k + ':[ \\t]*(.*)$', 'm')); return m ? m[1].trim().replace(/^(["'])(.*)\1$/, '$2') : ''; };
// An app can declare the PocketBase collections it needs in its docker-compose.yml under a top-level `x-pocketbase:` key
// (Docker Compose ignores `x-` keys). Written as JSON: x-pocketbase: {"collections":[{"name":"...","fields":[{"name":"...","type":"text"}]}]}
function xPocketbase(compose) {
  const i = compose.search(/^x-pocketbase:/m);
  if (i < 0) return null;
  const start = compose.indexOf('{', i);
  if (start < 0 || start - i > 400) return { error: 'x-pocketbase must be a JSON object' };
  let depth = 0, inStr = false, esc = false;
  for (let k = start; k < compose.length && k - start < 200000; k++) {
    const c = compose[k];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) { try { return JSON.parse(compose.slice(start, k + 1)); } catch { return { error: "x-pocketbase isn't valid JSON" }; } }
  }
  return { error: 'x-pocketbase is not closed' };
}
function installedApps() {
  if (appsCache.v && Date.now() - appsCache.at < 15000) return appsCache.v;
  let out;
  try {
    const apps = [];
    for (const dir of fs.readdirSync(APPS_DIR)) {
      if (!/^[a-z0-9][a-z0-9_.-]{0,80}$/.test(dir) || dir === SELF_ID) continue;
      let yml; try { yml = fs.readFileSync(path.join(APPS_DIR, dir, 'umbrel-app.yml'), 'utf8'); } catch { continue; }
      let compose = ''; try { compose = fs.readFileSync(path.join(APPS_DIR, dir, 'docker-compose.yml'), 'utf8'); } catch {}
      const id = yamlKey(yml, 'id') || dir;
      const slug = ((compose.match(/POCKETBASE_APP_ID["']?\s*[=:]\s*["']?([A-Za-z0-9_-]{1,48})/) || [])[1] || '').toLowerCase();
      const pbName = ((compose.match(/POCKETBASE_APP_NAME["']?\s*[=:]\s*["']?([^"'\r\n]{1,80})/) || [])[1] || '').trim();
      const dataDir = path.join(APPS_DIR, dir, 'data');
      let env = 'no-data-dir';
      try { if (fs.statSync(dataDir).isDirectory()) env = fs.existsSync(path.join(dataDir, 'pocketbase.env')) ? 'present' : 'missing'; } catch {}
      apps.push({ dir, env, id, name: yamlKey(yml, 'name') || id, version: yamlKey(yml, 'version'), tagline: yamlKey(yml, 'tagline'), category: yamlKey(yml, 'category'), port: Number(yamlKey(yml, 'port')) || 0, slug, pbName, pocketbase: xPocketbase(compose) });
    }
    out = { available: true, apps: apps.sort((a, b) => a.name.localeCompare(b.name)) };
  } catch { out = { available: false, apps: [] }; }
  appsCache = { at: Date.now(), v: out };
  return out;
}


// ---- Connect an app to PocketBase ------------------------------------------------------------------------------
// Apps built on the JoolzApp account read a PocketBase superuser login from <their data folder>/pocketbase.env. This writes
// that one file for an app of your own store (joolay-*), after checking the login really is a PocketBase superuser. It only
// ever touches <app-data>/<app>/data/pocketbase.env, never creates folders, and refuses public traffic.
let connectFails = [];
const connectLocked = () => { const t = Date.now() - 10 * 60 * 1000; connectFails = connectFails.filter((x) => x > t); return connectFails.length >= 6; };
async function verifySuperuser(email, password) {
  const pb = currentPbUrl(), body = JSON.stringify({ identity: email, password });
  for (const p of ['/api/collections/_superusers/auth-with-password', '/api/admins/auth-with-password']) {
    const r = await fetch(pb + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(15000) });
    if (r.status === 404) continue;
    return r.ok;
  }
  return false;
}
function writeAppEnv(dir, email, password) {
  const root = fs.realpathSync(APPS_DIR), data = fs.realpathSync(path.join(APPS_DIR, dir, 'data'));
  if (!data.startsWith(root + path.sep) || !fs.statSync(data).isDirectory()) throw new Error('That app has no data folder.');
  const file = path.join(data, 'pocketbase.env');
  let keep = [];
  try { keep = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim() && !/^\s*POCKETBASE_SUPERUSER_(EMAIL|PASSWORD)\s*=/.test(l)); } catch {}
  const tmp = path.join(data, '.pocketbase.env.' + process.pid + '.tmp');
  fs.writeFileSync(tmp, [...keep, 'POCKETBASE_SUPERUSER_EMAIL=' + email, 'POCKETBASE_SUPERUSER_PASSWORD=' + password, ''].join('\n'), { mode: 0o600 });
  fs.renameSync(tmp, file);
  appsCache = { at: 0, v: null };
}
async function connectApp(req, res) {
  if (isPublicRequest(req)) return send(res, 403, { message: 'Only available from your home network or tailnet.' });
  if (connectLocked()) return send(res, 429, { message: 'Too many wrong attempts. Try again in a few minutes.' });
  let b; try { b = JSON.parse(await readBody(req)); } catch { return send(res, 400, { message: 'Invalid request.' }); }
  const { id, email, password } = b || {};
  if (![id, email, password].every((x) => typeof x === 'string' && x.length > 0 && x.length < 300)) return send(res, 400, { message: 'App, email and password are required.' });
  if (/[\r\n]/.test(email + password) || /^(["']).*\1$/.test(password) || password !== password.trim()) return send(res, 400, { message: "That password can't be stored in the file (line breaks, surrounding quotes or spaces)." });
  const app = installedApps().apps.find((a) => a.id === id);
  if (!app || !/^joolay-[a-z0-9-]{1,60}$/.test(app.dir) || !app.slug) return send(res, 400, { message: "Only your own JoolzApp apps can be connected." });
  if (app.env === 'no-data-dir') return send(res, 409, { message: "That app has no data folder yet. Open the app once, then try again." });
  let ok; try { ok = await verifySuperuser(email, password); } catch { return send(res, 502, { message: "Couldn't reach PocketBase." }); }
  if (!ok) { connectFails.push(Date.now()); return send(res, 401, { message: "PocketBase didn't accept that login. It has to be a superuser." }); }
  try { writeAppEnv(app.dir, email, password); } catch (e) { return send(res, 500, { message: String(e.message || e) }); }
  return send(res, 200, { ok: true, restart: true });
}

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden');
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'Not found');
    send(res, 200, buf, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  });
}


// ---- The one JoolzApp sign-up. Every app sends people here, so a change to this page or these rules applies to all of them. ----
const signupHits = new Map();
function signupThrottled(req) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(), now = Date.now();
  const a = (signupHits.get(ip) || []).filter((t) => now - t < 3600e3); a.push(now); signupHits.set(ip, a);
  if (signupHits.size > 2000) signupHits.clear();
  return a.length > 10;
}
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) && e.length <= 200;
// Parents approve their kids' accounts here (and the kids' settings, such as joining a family).
async function guardiansRoute(req, res) {
  const tok = String(req.headers.authorization || '');
  const user = tok ? await pbx.userFromToken(tok).catch(() => null) : null;
  if (!user) return send(res, 401, { message: 'Sign in to continue.' });
  try {
    if (req.method === 'GET') { const st = await guardians.statusOf(user), ib = await guardians.inbox(user); return send(res, 200, { minor: st.minor, adminPending: !!st.adminPending, parents: st.parents || [], ...ib }); }
    if (req.method !== 'POST') return send(res, 405, { message: 'Method not allowed' });
    let b; try { b = JSON.parse(await readBody(req)); } catch { return send(res, 400, { message: 'Invalid request.' }); }
    const join = async (childId, familyId) => { const c = await pbx.asSuper('GET', '/api/collections/' + encodeURIComponent(pbx.collection) + '/records/' + encodeURIComponent(childId)); await family.respond({ id: c.id, name: c.name, email: c.email }, familyId, true); };
    const r = b.action === 'decide' ? await guardians.decide(user, b.id, !!b.approve, join) : b.action === 'revoke' ? await guardians.revoke(user, b.childId) : { status: 400, message: 'Unknown action' };
    if (r.status) return send(res, r.status, { message: r.message });
    return send(res, 200, { ok: true, ...(await guardians.inbox(user)) });
  } catch (e) { return send(res, 500, { message: String(e.message || e) }); }
}

// ---- Family and account details. These are managed here once for every JoolzApp app (the apps only link to this page). ----
async function accountRoutes(req, res, pathname) {
  const tok = String(req.headers.authorization || '');
  const user = tok ? await pbx.userFromToken(tok).catch(() => null) : null;
  if (!user) return send(res, 401, { message: 'Sign in to continue.' });
  const out = (r) => (r.status ? send(res, r.status, { message: r.message }) : send(res, 200, r));
  try {
    let b = {}; if (req.method === 'POST') { try { b = JSON.parse(await readBody(req)); } catch { return send(res, 400, { message: 'Invalid request.' }); } }
    if (pathname === '/family/users' && req.method === 'GET') return send(res, 200, { users: (await pbx.listUsers()).filter((u) => u.id !== user.id) });
    if (pathname === '/family') {
      if (req.method === 'GET') return out(await family.mine(user));
      if (req.method !== 'POST') return send(res, 405, { message: 'Method not allowed' });
      const minor = guardians.isMinor(user);
      if (b.action === 'create') return minor ? out({ status: 403, message: 'A parent or guardian creates the family. They can invite you.' }) : out(await family.create(user, b.name));
      if (b.action === 'invite') return out(await family.invite(user, b.email, b.tier, b.relation));
      if (b.action === 'createChild') {   // a parent makes a child's account; it is held until an admin approves it
        if (minor) return out({ status: 403, message: 'Only a parent or guardian can create an account for a child.' });
        const mineF = (await family.mine(user)).family;
        if (!mineF || !mineF.canManage) return out({ status: 400, message: 'Create a family first, or ask its creator to make you a manager.' });
        const email = String(b.email || '').trim().toLowerCase(), password = String(b.password || ''), name = String(b.name || '').trim().slice(0, 80), dob = String(b.dob || '').trim();
        if (!name) return out({ status: 400, message: "Enter the child's name." });
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return out({ status: 400, message: "Enter a valid email for the child's account." });
        if (password.length < 8 || password.length > 200) return out({ status: 400, message: 'Use a password of at least 8 characters.' });
        if (!guardians.validDob(dob) || guardians.ageOf(dob) >= 18) return out({ status: 400, message: "Enter the child's date of birth. This page is for under-18s; adults sign up themselves." });
        let child;
        try { child = await pbx.createUser({ email, password, name, dob }); }
        catch (e) { if (e instanceof pbx.PBError && e.status === 400) return out({ status: 400, message: e.data && e.data.email ? 'That email is already registered.' : 'Those details were not accepted.' }); throw e; }
        await guardians.createdByParent(child, user);
        await family.invite(user, email, 'family', String(b.relation || 'child').slice(0, 40));
        await family.respond(child, mineF.id, true);
        await pbx.asSuper('POST', '/api/collections/portal_requests/records', { user: child.id, email, app: CHILD_REQ, message: `${name} (born ${dob}), created by ${user.name || user.email}`, status: 'pending' }).catch(() => {});
        return send(res, 200, { ...(await family.mine(user)), notice: `${name}'s account is created. It can be used once an admin approves it.` });
      }
      if (b.action === 'respond') {
        if (b.accept && minor) {   // a kid joining a family needs a parent's approval first
          const inv = (await family.mine(user)).invites.find((i) => i.id === String(b.familyId || ''));
          if (!inv) return out({ status: 404, message: 'That invitation is no longer there.' });
          await guardians.requestFamily(user, inv.id, inv.name);
          return send(res, 200, { ...(await family.mine(user)), notice: "Sent to your parent. You'll join once they approve." });
        }
        return out(await family.respond(user, b.familyId, !!b.accept));
      }
      if (b.action === 'tier') return out(await family.setTier(user, b.memberId, b.tier, b.relation));
      if (b.action === 'manager') { const t = await pbx.getUser(String(b.memberId || '').replace(/[^A-Za-z0-9]/g, '')).catch(() => null); if (t && guardians.isMinor(t)) return out({ status: 403, message: "Under-18s can't manage a family." }); return out(await family.setManager(user, b.memberId, !!b.on)); }
      if (b.action === 'leave') return out(await family.drop(user, ''));
      if (b.action === 'remove') return out(await family.drop(user, b.memberId));
      return send(res, 400, { message: 'Unknown action' });
    }
    if (pathname === '/account/dob' && req.method === 'POST') {
      const fresh = await pbx.getUser(user.id);
      if (fresh.dob) return send(res, 400, { message: 'Your date of birth is already saved. Ask an admin if it is wrong.' });
      const dob = String(b.dob || '').trim(); if (!guardians.validDob(dob)) return send(res, 400, { message: 'Enter your date of birth.' });
      let parents = [];
      if (guardians.ageOf(dob) < 18) { const chk = await guardians.checkParents(b.parentEmails, fresh.email); if (chk.error) return send(res, 400, { message: chk.error }); parents = chk.parents; }
      await pbx.setDob(user.id, dob);
      if (parents.length) await guardians.requestApproval({ ...fresh, dob }, parents);
      return send(res, 200, { ok: true, dob, minor: parents.length > 0 });
    }
    if (pathname === '/account/guardian' && req.method === 'POST') {
      const fresh = await pbx.getUser(user.id);
      if (!guardians.isMinor(fresh)) return send(res, 400, { message: 'Only under-18 accounts need a parent.' });
      const chk = await guardians.checkParents(b.parentEmails, fresh.email); if (chk.error) return send(res, 400, { message: chk.error });
      await guardians.requestApproval(fresh, chk.parents);
      return send(res, 200, { ok: true, message: 'Sent to ' + chk.parents.map((x) => x.name).join(' and ') + '.' });
    }
    return send(res, 404, { message: 'Not found' });
  } catch (e) { return send(res, 500, { message: String(e.message || e) }); }
}
async function signupConfig(req, res) {
  try { const open = await pbx.usersSchema(); return send(res, 200, { ready: true, open }); }
  catch (e) { return send(res, 200, { ready: false, open: false, message: String(e.message || e) }); }
}
async function signup(req, res) {
  if (signupThrottled(req)) return send(res, 429, { message: 'Too many attempts. Try again later.' });
  let b; try { b = JSON.parse(await readBody(req)); } catch { return send(res, 400, { message: 'Invalid request.' }); }
  try {
    if (!(await pbx.usersSchema())) return send(res, 403, { message: 'Sign-ups are currently closed. Ask the admin for an account.' });
    const email = String(b.email || '').trim().toLowerCase(), password = String(b.password || ''), name = String(b.name || '').trim().slice(0, 80), dob = String(b.dob || '').trim();
    if (!validEmail(email)) return send(res, 400, { message: 'Enter a valid email address.' });
    if (password.length < 8 || password.length > 200) return send(res, 400, { message: 'Use a password of at least 8 characters.' });
    if (!guardians.validDob(dob)) return send(res, 400, { message: 'Enter your date of birth.' });
    let parents = [];
    if (guardians.ageOf(dob) < 18) {
      const chk = await guardians.checkParents(b.parentEmails, email);
      if (chk.error) return send(res, 400, { message: chk.error });
      parents = chk.parents;
    }
    let created;
    try { created = await pbx.createUser({ email, password, name, dob }); }
    catch (e) {
      if (e instanceof pbx.PBError && e.status === 400) return send(res, 400, { message: e.data && e.data.email && e.data.email.code === 'validation_not_unique' ? 'That email is already registered. Sign in instead.' : ((e.data && e.data.password && e.data.password.message) || 'Could not create that account.') });
      throw e;
    }
    if (parents.length) await guardians.requestApproval(created, parents);
    return send(res, 200, { ok: true, minor: parents.length > 0 });
  } catch (e) { return send(res, e instanceof pbx.PBError && e.status === 503 ? 503 : 500, { message: String(e.message || e) }); }
}

const handle = async (req, res) => {
  try {
    const { pathname, search } = new URL(req.url, 'http://x');
    if (pathname === '/healthz') return send(res, 200, { ok: true });

    if (pathname === '/signup-config') { if (req.method !== 'GET') return send(res, 405, { message: 'Method not allowed' }); return signupConfig(req, res); }
    if (pathname === '/guardians') return guardiansRoute(req, res);
    if (pathname === '/family' || pathname === '/family/users' || pathname === '/account/dob' || pathname === '/account/guardian') return accountRoutes(req, res, pathname);
    if (pathname === '/signup') { if (req.method !== 'POST') return send(res, 405, { message: 'Method not allowed' }); return signup(req, res); }

    if (pathname === '/config') {
      if (req.method !== 'GET') return send(res, 405, { message: 'Method not allowed' });
      return send(res, 200, { pbUrl: currentPbUrl(), locked: true, custom: !!(ENV_PB_URL && normaliseUrl(ENV_PB_URL)), public: isPublicRequest(req) });
    }

    if (pathname === '/umbrel-apps') {
      if (req.method !== 'GET') return send(res, 405, { message: 'Method not allowed' });
      if (isPublicRequest(req)) return send(res, 403, { message: 'Only available from your home network or tailnet.' });
      return send(res, 200, installedApps());
    }

    if (pathname === '/connect-app') {
      if (req.method !== 'POST') return send(res, 405, { message: 'Method not allowed' });
      return connectApp(req, res);
    }

    if (pathname === '/pb' || pathname.startsWith('/pb/')) {
      const pb = currentPbUrl();
      const sub = pathname.slice(3) || '/';
      if (!sub.startsWith('/api/')) return send(res, 403, { message: 'Only /api/ is proxied.' });
      if (isPublicRequest(req)) { const why = publicBlockReason(req, sub); if (why) return send(res, 403, { message: why }); }
      return proxy(req, res, pb, sub + (search || ''));
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    return serveStatic(req, res, decodeURIComponent(pathname));
  } catch (e) {
    send(res, 500, { message: String(e.message || e) });
  }
};

// Two listeners, one app. PORT is the normal one (Umbrel's app address, behind Umbrel's login). PUBLIC_PORT is the one to
// publish on the internet (Tailscale Funnel): requests that arrive there are ALWAYS treated as public, so admin sign-in and the
// PocketBase admin APIs stay refused no matter how the tunnel forwards or labels traffic. Set PUBLIC_PORT=0 to turn it off.
const PUBLIC_PORT = Number(process.env.PUBLIC_PORT === undefined ? 3001 : process.env.PUBLIC_PORT);
const server = http.createServer(handle);
server.listen(PORT, '0.0.0.0', () => console.log(`Portal Admin listening on :${PORT}`));
let pubServer = null;
if (PUBLIC_PORT && PUBLIC_PORT !== PORT) {
  pubServer = http.createServer((req, res) => { req.publicPort = true; handle(req, res); });
  pubServer.listen(PUBLIC_PORT, '0.0.0.0', () => console.log(`Portal Admin public (user-only) listening on :${PUBLIC_PORT}`));
}
process.on('SIGTERM', () => { if (pubServer) pubServer.close(); server.close(() => process.exit(0)); });
