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
const events = require('./events');
const paywall = require('./paywall');
const appkeys = require('./appkeys'), appnames = require('./appnames');
const makeChanges = require('./changes');
const makeGoogleSignIn = require('./googlesignin');
const makeAppApi = require('./appapi');
const qrlogin = require('./qrlogin')();
const quick = require('./quickaccess')();
const aiKeys = require('./ai')({ asSuper: (m, p, b) => pbx.asSuper(m, p, b) });
const CHILD_REQ = '__child_account__', SPOUSE_REQ = '__spouse_account__';

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, 'public');
// The Umbrel PocketBase app publishes port 5400 on the host; host.docker.internal (host-gateway) reaches it from this container.
const DEFAULT_PB_URL = 'http://host.docker.internal:5400';
const ENV_PB_URL = (process.env.PB_URL || '').trim();

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon',
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

function proxy(req, res, pbUrl, subPath, opt = {}) {
  const target = new URL(pbUrl + subPath);
  const lib = target.protocol === 'https:' ? https : http;
  const headers = { ...req.headers, host: target.host };
  delete headers.origin; delete headers.referer; delete headers.cookie; delete headers['accept-encoding'];
  if (opt.body !== undefined) headers['content-length'] = Buffer.byteLength(opt.body);
  const up = lib.request(target, { method: req.method, headers, timeout: 30000 }, (r) => {
    if (opt.onStatus) opt.onStatus(r.statusCode || 502);
    const h = { ...r.headers, 'cache-control': 'no-store' };
    delete h['set-cookie'];
    res.writeHead(r.statusCode || 502, h);
    r.pipe(res);
  });
  up.on('timeout', () => up.destroy(new Error('timeout')));
  up.on('error', (e) => { if (!res.headersSent) send(res, 502, { message: 'Cannot reach PocketBase: ' + e.message }); else res.destroy(); });
  if (opt.body !== undefined) up.end(opt.body); else req.pipe(up);
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
// True only for a request that came through Umbrel's login proxy for this app (the app_proxy container, which checks Umbrel's
// session before passing anything on), is not public, and when Portal Admin has a saved PocketBase login to use.
const dns = require('dns');
const APP_PROXY_HOST = process.env.APP_PROXY_HOST || 'joolay-portal-admin_app_proxy_1';
const AUTO_LOGIN = !/^(0|false|no|off)$/i.test(String(process.env.AUTO_LOGIN || ''));
let proxyIps = { at: 0, v: [] };
let autoWhy = '';   // why the last check said no (shown only to non-public requests, in /config, to help when the admin sign-in stops working)
async function behindUmbrelLogin(req) {
  if (!AUTO_LOGIN) { autoWhy = 'AUTO_LOGIN is off'; return false; }
  if (req.publicPort) { autoWhy = 'public port'; return false; }
  if (req.portalClientIp) { autoWhy = 'portal client'; return false; }
  if (isPublicRequest(req)) { autoWhy = 'public request'; return false; }
  // The login proxy's container name depends on the Docker / umbrelOS version (joolay-portal-admin_app_proxy_1 or joolay-portal-admin-app_proxy-1);
  // its service name app_proxy always resolves on the app's own network. Any of them counts.
  if (Date.now() - proxyIps.at > 60000) {
    const v = [];
    for (const h of [...new Set([APP_PROXY_HOST, APP_PROXY_HOST.replace(/_app_proxy_1$/, '-app_proxy-1'), 'app_proxy'])]) { try { for (const a of await dns.promises.lookup(h, { all: true })) if (!v.includes(a.address)) v.push(a.address); } catch {} }
    proxyIps = { at: Date.now(), v };
  }
  const from = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (!proxyIps.v.length) { autoWhy = 'cannot find the login proxy (tried ' + APP_PROXY_HOST + ', its hyphen form and app_proxy); request came from ' + from; return false; }
  if (!proxyIps.v.includes(from)) { autoWhy = 'request came from ' + from + ', not from ' + APP_PROXY_HOST + ' (' + proxyIps.v.join(', ') + ')'; return false; }
  const c = pbx.creds(); if (!(c.email && c.pass)) { autoWhy = 'no saved PocketBase login in Portal Admin'; return false; }
  autoWhy = ''; return true;
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
  /^\/api\/collections\/(?!_)[^/]+\/(records|auth-with-password|auth-with-oauth2|auth-refresh|auth-methods|request-password-reset|confirm-password-reset|request-verification|confirm-verification)(\/|$)/,
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
// Preferred: the declaration lives in <app>/pocketbase.json (Umbrel copies it untouched; it can re-write docker-compose.yml on install,
// which breaks the inline JSON). The compose `x-pocketbase:` key is still read as a fallback.
function xPocketbaseFile(dir) {
  let txt; try { txt = fs.readFileSync(path.join(dir, 'pocketbase.json'), 'utf8'); } catch { return null; }
  try { const v = JSON.parse(txt); return v && typeof v === 'object' && !Array.isArray(v) ? v : { error: 'pocketbase.json must be a JSON object' }; }
  catch { return { error: "pocketbase.json isn't valid JSON" }; }
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
      // An app that sets JOOLZAPP_DASHBOARD=hidden is a tool for the server's owner (opened from Umbrel): it gets its Portal API key but no icon on the JoolzApp home screen.
      const noDash = /JOOLZAPP_DASHBOARD["']?\s*[=:]\s*["']?hidden\b/i.test(compose);
      const pbName = ((compose.match(/POCKETBASE_APP_NAME["']?\s*[=:]\s*["']?([^"'\r\n]{1,80})/) || [])[1] || '').trim();
      const dataDir = path.join(APPS_DIR, dir, 'data');
      let env = 'no-data-dir';
      try { if (fs.statSync(dataDir).isDirectory()) env = fs.existsSync(path.join(dataDir, 'pocketbase.env')) ? 'present' : 'missing'; } catch {}
      apps.push({ dir, env, noDash, id, name: yamlKey(yml, 'name') || id, version: yamlKey(yml, 'version'), tagline: yamlKey(yml, 'tagline'), category: yamlKey(yml, 'category'), port: Number(yamlKey(yml, 'port')) || 0, funnel: ((compose.match(/tsdproxy\.name["']?\s*[=:]\s*["']?([a-z0-9-]{1,63})/i) || [])[1] || '').toLowerCase(), slug, pbName, pocketbase: xPocketbaseFile(path.join(APPS_DIR, dir)) || xPocketbase(compose) });
    }
    out = { available: true, apps: apps.sort((a, b) => a.name.localeCompare(b.name)) };
  } catch { out = { available: false, apps: [] }; }
  appsCache = { at: Date.now(), v: out };
  return out;
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



// ---- Who is calling, and sign-in guessing ---------------------------------------------------------------------
// The caller is the right-most public address in X-Forwarded-For (what the first proxy that saw the internet appended, so a client
// can't fake it by adding its own values on the left). On the home network there is no public hop, so the last address is used.
function clientIp(req) {
  if (req.portalClientIp) return req.portalClientIp;   // passed on by JoolzApp Dashboard (checked by its key), which is the one that saw the caller
  const xs = String(req.headers['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean);
  for (let i = xs.length - 1; i >= 0; i--) if (!isPrivateAddr(xs[i])) return xs[i];
  return xs.length ? xs[xs.length - 1] : String(req.socket.remoteAddress || '');
}
// Failed password sign-ins that pass through /pb: 10 per address and 20 per account name in a 10 minute window, then 429.
const authFails = new Map();
const failList = (k) => { const now = Date.now(), a = (authFails.get(k) || []).filter((t) => now - t < 600e3); if (a.length) authFails.set(k, a); else authFails.delete(k); return a; };
const authBlocked = (ip, id) => failList('ip:' + ip).length >= 10 || (id && failList('id:' + id).length >= 20);
function authFailed(ip, id) { for (const k of ['ip:' + ip, id && 'id:' + id]) if (k) authFails.set(k, [...failList(k), Date.now()]); if (authFails.size > 5000) authFails.clear(); }
const authOk = (ip) => authFails.delete('ip:' + ip);

// ---- The one JoolzApp sign-up. Every app sends people here, so a change to this page or these rules applies to all of them. ----
const signupHits = new Map();
function signupThrottled(req) {
  const ip = clientIp(req), now = Date.now();
  const a = (signupHits.get(ip) || []).filter((t) => now - t < 3600e3); a.push(now); signupHits.set(ip, a);
  if (signupHits.size > 2000) signupHits.clear();
  return a.length > 10;
}
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) && e.length <= 200;
// Parents approve their kids' accounts here (and the kids' settings, such as joining a family).
async function guardiansRoute(req, res) {
  const tok = String(req.headers.authorization || '');
  const user = tok ? await personFromToken(tok) : null;
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

// ---- QR sign-in, phone side: a signed-in person looks at a request from a TV (GET ?id=) and approves or denies it (POST {id, approve}). ----
async function qrRoute(req, res) {
  const tok = String(req.headers.authorization || '');
  const user = tok ? await personFromToken(tok) : null;
  if (!user) return send(res, 401, { message: 'Sign in to continue.' });
  const reply = (fn) => { try { return send(res, 200, fn()); } catch (e) { return send(res, e.status || 500, { message: String(e.message || e) }); } };
  if (req.method === 'GET') return reply(() => qrlogin.info(new URL(req.url, 'http://x').searchParams.get('id'), user));
  if (req.method !== 'POST') return send(res, 405, { message: 'Method not allowed' });
  let b; try { b = JSON.parse(await readBody(req, 4096)); } catch { return send(res, 400, { message: 'Invalid request.' }); }
  return reply(() => qrlogin.decide(b.id, user, b.approve === true));
}

// ---- Quick Access (PIN / pattern): one route. `login` needs no token (it carries the device secret and the code); everything else needs the signed-in person. ----
const quickTries = new Map();
async function quickRoute(req, res) {
  if (req.method !== 'POST') return send(res, 405, { message: 'Method not allowed' });
  let b; try { b = JSON.parse(await readBody(req, 8192)); } catch { return send(res, 400, { message: 'Invalid request.' }); }
  const reply = async (fn) => { try { return send(res, 200, await fn()); } catch (e) { return send(res, e.status || 500, { message: String(e.message || e), left: e.left }); } };
  if (b.action === 'login') {
    const ip = String(req.portalClientIp || req.socket.remoteAddress || ''), now = Date.now(), tries = (quickTries.get(ip) || []).filter((t) => now - t < 600e3);
    if (tries.length >= 40) return send(res, 429, { message: 'Too many tries. Wait a few minutes.' });
    quickTries.set(ip, [...tries, now]); if (quickTries.size > 5000) quickTries.clear();
    return reply(async () => { const r = await quick.login(b.deviceId, b.deviceSecret, b.code), s = await quick.session(r.userId); return { token: s.token, kind: r.kind, record: s.record && { id: s.record.id, email: s.record.email, name: s.record.name } }; });
  }
  const tok = String(req.headers.authorization || ''), user = tok ? await personFromToken(tok) : null;
  if (!user) return send(res, 401, { message: 'Sign in to continue.' });
  if (b.action === 'setup') return reply(() => quick.setup(user.id, { kind: b.kind, code: b.code, label: b.label }));
  if (b.action === 'list') return reply(async () => ({ devices: await quick.list(user.id), kind: (await quick.status(user.id)).kind }));
  if (b.action === 'remove') return reply(() => quick.remove(user.id, b.deviceId));
  if (b.action === 'signout') return reply(() => quick.signOut(user.id));
  return send(res, 400, { message: 'Unknown action.' });
}

// ---- Family and account details. These are managed here once for every JoolzApp app (the apps only link to this page). ----
// Who is signed in, as a JoolzApp person: their own account token, or a PocketBase superuser token mapped to the account with the same email.
// So the admin uses Family, Settings, events and everything else exactly as everyone else does.
async function personFromToken(tok) {
  const u = await pbx.userFromToken(tok).catch(() => null);
  return u || (await pbx.userForSuperuser(tok).catch(() => null));
}
async function accountRoutes(req, res, pathname) {
  const tok = String(req.headers.authorization || '');
  let user = tok ? await personFromToken(tok) : null;
  if (!user) return send(res, 401, { message: 'Sign in to continue.' });
  const out = (r) => (r.status ? send(res, r.status, { message: r.message }) : send(res, 200, r));
  try {
    let b = {}; if (req.method === 'POST') { try { b = JSON.parse(await readBody(req)); } catch { return send(res, 400, { message: 'Invalid request.' }); } }
    if (pathname === '/account/ai') {   // a person's saved AI keys (list, add, remove, choose, test). Keys never leave here except their last 4 characters.
      if (req.method !== 'POST') return send(res, 405, { message: 'Method not allowed' });
      try {
        if (b.action === 'add') return send(res, 200, { key: await aiKeys.add(user.id, b), ...(await aiKeys.state(user.id)) });
        if (b.action === 'remove') { await aiKeys.remove(user.id, b.id); return send(res, 200, await aiKeys.state(user.id)); }
        if (b.action === 'select') { await aiKeys.select(user.id, b.app || '', b.id || ''); return send(res, 200, await aiKeys.state(user.id)); }
        if (b.action === 'test') return send(res, 200, await aiKeys.test(user.id, b.id));
        return send(res, 200, await aiKeys.state(user.id));
      } catch (e) { return send(res, e.status || 500, { message: String(e.message || e) }); }
    }
    if (pathname === '/store/layout') {   // the shared App Store layout: anyone signed in reads it, only an admin changes it (checked here, never from the browser)
      if (req.method === 'GET') return send(res, 200, { layout: await storeLayout.get(), admin: !!user.isAdmin });
      if (req.method !== 'POST') return send(res, 405, { message: 'Method not allowed' });
      if (!user.isAdmin) return send(res, 403, { message: 'Only an admin can change the App Store.' });
      try { return send(res, 200, { layout: await storeLayout.set(b.layout), admin: true }); } catch (e) { return send(res, e.status || 500, { message: String(e.message || e) }); }
    }
    if (pathname === '/admin/apps') {   // owner-only tools (JOOLZAPP_DASHBOARD=hidden) for the Admin folder: admins only, checked here, never trusted from the browser
      if (req.method !== 'GET') return send(res, 405, { message: 'Method not allowed' });
      if (!user.isAdmin) return send(res, 403, { message: 'Only an admin can see these.' });
      return send(res, 200, { apps: installedApps().apps.filter((a) => a.noDash).map((a) => ({ slug: a.slug || a.id.replace(/^joolay-/, ''), id: a.id, name: a.pbName || a.name, tagline: a.tagline, port: a.port, funnel: a.funnel })) });
    }
    if (pathname === '/paywall' && req.method === 'GET') return send(res, 200, await paywall.forPerson(user));
    if (pathname === '/pay' && req.method === 'POST') { try { return send(res, 200, await paywall.startPayment(user, b.slug, b.scope)); } catch (e) { return send(res, e.status || 500, { message: String(e.message || e) }); } }
    if (pathname === '/pay/status' && req.method === 'GET') return send(res, 200, await paywall.status(user, new URL(req.url, 'http://x').searchParams.get('slug')));
    if (pathname === '/events' && req.method === 'GET') {
      const sp = new URL(req.url, 'http://x').searchParams, days = Math.min(120, Math.max(1, parseInt(sp.get('days'), 10) || 60));
      return send(res, 200, { events: await events.upcoming(user, sp.get('today'), days) });
    }
    if (pathname === '/family/users' && req.method === 'GET') return send(res, 200, { users: (await pbx.listUsers()).filter((u) => u.id !== user.id) });
    if (pathname === '/family') {
      if (req.method === 'GET') return out(await family.mine(user));
      if (req.method !== 'POST') return send(res, 405, { message: 'Method not allowed' });
      const minor = guardians.isMinor(user);
      if (b.action === 'create') return minor ? out({ status: 403, message: 'A parent or guardian creates the family. They can invite you.' }) : out(await family.create(user, b.name));
      if (b.action === 'unlinkSpouse') return out(await family.unlinkSpouse(user));
      if (b.action === 'inviteSpouse') { if (minor) return out({ status: 403, message: 'Spouse links are for adults.' }); return out(await family.invite(user, b.email, 'family', 'Spouse', true)); }
      if (b.action === 'createSpouse') {   // a household member makes their spouse's account; it is linked straight away and held until an admin approves it
        if (minor) return out({ status: 403, message: 'Spouse accounts are for adults.' });
        const bad = await family.spouseCheck(user); if (bad) return out(bad);
        const email = String(b.email || '').trim().toLowerCase(), password = String(b.password || ''), name = String(b.name || '').trim().slice(0, 80), dob = String(b.dob || '').trim(), username = pbx.cleanUsername(b.username);
        if (!/\S\s+\S/.test(name)) return out({ status: 400, message: "Enter your spouse's name and surname." });
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return out({ status: 400, message: "Enter a valid email for your spouse's account." });
        if (password.length < 8 || password.length > 200) return out({ status: 400, message: 'Use a password of at least 8 characters.' });
        if (!guardians.validDob(dob) || guardians.ageOf(dob) < 18) return out({ status: 400, message: "Enter your spouse's date of birth. A spouse must be 18 or older." });
        if (pbx.usernameError(username)) return out({ status: 400, message: pbx.usernameError(username) });
        if (await pbx.findByUsername(username)) return out({ status: 400, message: 'That username is taken. Try another.' });
        let sp;
        try { sp = await pbx.createUser({ email, password, name, dob, username }); }
        catch (e) { if (e instanceof pbx.PBError && e.status === 400) return out({ status: 400, message: e.data && e.data.email ? 'That email is already registered. Use "Link an existing account" instead.' : 'Those details were not accepted.' }); throw e; }
        await guardians.createdSpouse(sp, user);
        const linked = await family.linkCreatedSpouse(user, sp); if (linked.status) return out(linked);
        await pbx.asSuper('POST', '/api/collections/portal_requests/records', { user: sp.id, email, app: SPOUSE_REQ, message: `${name}, spouse account created by ${user.name || user.email}`, status: 'pending' }).catch(() => {});
        return send(res, 200, { ...linked, notice: `${name}'s account is created and linked as your spouse. It can be used once an admin approves it.` });
      }
      if (b.action === 'invite') return out(await family.invite(user, b.email, b.tier, b.relation));
      if (b.action === 'createChild') {   // a parent makes a child's account; it is held until an admin approves it
        if (minor) return out({ status: 403, message: 'Only a parent or guardian can create an account for a child.' });
        const mineF = (await family.mine(user)).family;
        if (!mineF || !mineF.canManage) return out({ status: 400, message: 'Create a family first, or ask its creator to make you a manager.' });
        const email = String(b.email || '').trim().toLowerCase(), password = String(b.password || ''), name = String(b.name || '').trim().slice(0, 80), dob = String(b.dob || '').trim(), username = pbx.cleanUsername(b.username);
        if (!/\S\s+\S/.test(name)) return out({ status: 400, message: "Enter the child's name and surname." });
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
      if (b.action === 'leaveExt') return out(await family.leaveExtended(user, b.familyId));
      if (b.action === 'leave') return out(await family.drop(user, ''));
      if (b.action === 'remove') return out(await family.drop(user, b.memberId));
      return send(res, 400, { message: 'Unknown action' });
    }
    if (pathname === '/account/username' && req.method === 'POST') {
      const username = pbx.cleanUsername(b.username); if (pbx.usernameError(username)) return send(res, 400, { message: pbx.usernameError(username) });
      try { await pbx.setUsername(user.id, username); } catch (e) { return send(res, e.status === 409 ? 409 : 500, { message: String(e.message || e) }); }
      return send(res, 200, { ok: true, username });
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
    const email = String(b.email || '').trim().toLowerCase(), password = String(b.password || ''), name = String(b.name || '').trim().slice(0, 80), dob = String(b.dob || '').trim(), username = pbx.cleanUsername(b.username);
    if (!/\S\s+\S/.test(name)) return send(res, 400, { message: 'Enter your name and surname.' });
    if (!validEmail(email)) return send(res, 400, { message: 'Enter a valid email address.' });
    if (password.length < 8 || password.length > 200) return send(res, 400, { message: 'Use a password of at least 8 characters.' });
    if (!guardians.validDob(dob)) return send(res, 400, { message: 'Enter your date of birth.' });
    if (pbx.usernameError(username)) return send(res, 400, { message: pbx.usernameError(username) });
    if (await pbx.findByUsername(username)) return send(res, 400, { message: 'That username is taken. Try another.' });
    let parents = [];
    if (guardians.ageOf(dob) < 18) {
      const chk = await guardians.checkParents(b.parentEmails, email);
      if (chk.error) return send(res, 400, { message: chk.error });
      parents = chk.parents;
    }
    let created;
    try { created = await pbx.createUser({ email, password, name, dob, username }); }
    catch (e) {
      if (e instanceof pbx.PBError && e.status === 400) return send(res, 400, { message: e.data && e.data.email && e.data.email.code === 'validation_not_unique' ? 'That email is already registered. Sign in instead.' : ((e.data && e.data.password && e.data.password.message) || 'Could not create that account.') });
      throw e;
    }
    if (parents.length) await guardians.requestApproval(created, parents);
    return send(res, 200, { ok: true, minor: parents.length > 0 });
  } catch (e) { return send(res, e instanceof pbx.PBError && e.status === 503 ? 503 : 500, { message: String(e.message || e) }); }
}

const feed = require('./statusfeed')({ asSuper: (m, p, b) => pbx.asSuper(m, p, b) });
const routes = require('./routes')({ dataDir: pbx.dataDir, feed });
const activity = require('./activity')({ asSuper: (m, p, b) => pbx.asSuper(m, p, b), feed, routes });
const theme = require('./theme')(pbx);
const portalApps = require('./portalapps')({ pbx, installedApps });   // Port Master adds/hides tiles for apps that do not use the JoolzApp account
const installQueue = require('./installqueue')({ asSuper: (m, p, b) => pbx.asSuper(m, p, b) });   // new JoolzApps App Updater should install
const appapi = makeAppApi({ qrlogin, quick, feed, routes, theme, portalApps, installQueue, pbx, DATA_DIR: pbx.dataDir, readBody, send });
const notices = require('./notices')({ pbx, forgetTouch: appapi.forgetTouch });
const storeLayout = require('./storelayout')(pbx);
const googleSignIn = makeGoogleSignIn({ pbx });
const changes = makeChanges({ pbx, installQueue, installedApps, APPS_DIR, DATA_DIR: pbx.dataDir, appKeys: appapi.keys });
const handle = async (req, res) => {
  try {
    const { pathname, search } = new URL(req.url, 'http://x');
    if (pathname === '/healthz') return send(res, 200, { ok: true });

    if (pathname === '/theme.css') {   // the global Glass theme as CSS: public on purpose (colours, sizes and a font name only), so every app can load it
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { message: 'Method not allowed' });
      try { return send(res, 200, await theme.css(await theme.get()), { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'public, max-age=60', 'Access-Control-Allow-Origin': '*' }); } catch { return send(res, 200, '/* no theme */', { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-store' }); }
    }
    if (pathname === '/signup-config') { if (req.method !== 'GET') return send(res, 405, { message: 'Method not allowed' }); return signupConfig(req, res); }
    if (pathname === '/guardians') return guardiansRoute(req, res);
    if (pathname === '/qr') return qrRoute(req, res);
    if (pathname === '/quick') return quickRoute(req, res);
    if (pathname === '/family' || pathname === '/events' || pathname === '/paywall' || pathname === '/pay' || pathname === '/pay/status' || pathname === '/family/users' || pathname === '/account/ai' || pathname === '/account/dob' || pathname === '/account/username' || pathname === '/account/guardian' || pathname === '/store/layout' || pathname === '/admin/apps') return accountRoutes(req, res, pathname);
    if (pathname === '/yoco/webhook') {
      if (req.method !== 'POST') return send(res, 405, { message: 'Method not allowed' });
      const raw = await readBody(req); const r = await paywall.handleWebhook(req.headers, raw);
      return send(res, r.status, { ok: r.status === 200 });
    }
    if (pathname === '/admin/paywall') {
      if (isPublicRequest(req)) return send(res, 403, { message: 'Only available from your home network or tailnet.' });
      const tok = String(req.headers.authorization || '');
      if (!tok || !(await pbx.isSuperuser(tok))) return send(res, 401, { message: 'Admin only.' });
      try {
        if (req.method === 'GET') return send(res, 200, await paywall.adminView());
        if (req.method !== 'POST') return send(res, 405, { message: 'Method not allowed' });
        const b = JSON.parse(await readBody(req)); const me = await pbx.userForSuperuser(tok).catch(() => null);
        return send(res, 200, await paywall.adminAction(b, me));
      } catch (e) { return send(res, e.status || 500, { message: String(e.message || e) }); }
    }
    // The dashboard says "this person just opened me" (the apps do the same through Portal API). Their own sign-in is the proof; it can't be set to any other date.
    if (pathname === '/api/active' && req.method === 'POST') {
      const tok = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const me = tok ? await pbx.userFromToken(tok).catch(() => null) : null;
      if (!me) return send(res, 401, { message: 'Sign in first.' });
      await appapi.touchActive(me.id).catch(() => {}); return send(res, 200, { ok: true });
    }
    if (pathname === '/admin/app-keys') {                                  // API keys apps need (JoolzTV's TMDB key): admin only, never sent back
      if (isPublicRequest(req)) return send(res, 403, { message: 'Only available from your home network or tailnet.' });
      const tok = String(req.headers.authorization || '');
      if (!tok || !(await pbx.isSuperuser(tok))) return send(res, 401, { message: 'Admin only.' });
      try {
        if (req.method === 'GET') return send(res, 200, await appkeys.adminView());
        if (req.method !== 'POST') return send(res, 405, { message: 'Method not allowed' });
        return send(res, 200, await appkeys.adminAction(JSON.parse(await readBody(req))));
      } catch (e) { return send(res, e.status || 500, { message: String(e.message || e) }); }
    }
    if (pathname === '/admin/routes') {                                    // the JoolzApp apps page: route health from Port Master, and flagging a broken route to Claude
      if (isPublicRequest(req)) return send(res, 403, { message: 'Only available from your home network or tailnet.' });
      const tok = String(req.headers.authorization || '');
      if (!tok || !(await pbx.isSuperuser(tok))) return send(res, 401, { message: 'Admin only.' });
      try {
        if (req.method === 'GET') return send(res, 200, routes.view());
        if (req.method !== 'POST') return send(res, 405, { message: 'Method not allowed' });
        const b = JSON.parse(await readBody(req)), who = await pbx.raw('POST', '/api/collections/_superusers/auth-refresh', { token: tok }).then((j) => (j && j.record && j.record.email) || 'admin').catch(() => 'admin');
        if (b.action === 'notify') return send(res, 200, await routes.notify(who, b));
        if (b.action === 'clear') return send(res, 200, await routes.clear(b));
        return send(res, 400, { message: 'Unknown action.' });
      } catch (e) { return send(res, e.status || 500, { message: String(e.message || e) }); }
    }
    if (pathname === '/admin/activity') {                                 // the Overview's recent-activity feed (app status, route alerts, access requests, audit log): admin only, read only
      if (isPublicRequest(req)) return send(res, 403, { message: 'Only available from your home network or tailnet.' });
      const tok = String(req.headers.authorization || '');
      if (!tok || !(await pbx.isSuperuser(tok))) return send(res, 401, { message: 'Admin only.' });
      if (req.method !== 'GET') return send(res, 405, { message: 'Method not allowed' });
      try { return send(res, 200, { items: await activity.recent(20) }); } catch (e) { return send(res, e.status || 500, { message: String(e.message || e) }); }
    }
    if (pathname === '/admin/status-feed') {                               // where apps' status files go (a GitHub repo + token): admin only, the token is never sent back
      if (isPublicRequest(req)) return send(res, 403, { message: 'Only available from your home network or tailnet.' });
      const tok = String(req.headers.authorization || '');
      if (!tok || !(await pbx.isSuperuser(tok))) return send(res, 401, { message: 'Admin only.' });
      try {
        if (req.method === 'GET') return send(res, 200, await feed.adminView());
        if (req.method !== 'POST') return send(res, 405, { message: 'Method not allowed' });
        const b = JSON.parse(await readBody(req));
        if (b.action === 'test') return send(res, 200, await feed.test());
        if (b.action === 'clear') return send(res, 200, await feed.adminClear());
        return send(res, 200, await feed.adminSave(b));
      } catch (e) { return send(res, e.status || 500, { message: String(e.message || e) }); }
    }
    if (pathname === '/admin/app-names') {                                 // the names people gave their apps on their own home screen: admin sees them and can reset
      if (isPublicRequest(req)) return send(res, 403, { message: 'Only available from your home network or tailnet.' });
      const tok = String(req.headers.authorization || '');
      if (!tok || !(await pbx.isSuperuser(tok))) return send(res, 401, { message: 'Admin only.' });
      try {
        if (req.method === 'GET') return send(res, 200, await appnames.adminView());
        if (req.method !== 'POST') return send(res, 405, { message: 'Method not allowed' });
        return send(res, 200, await appnames.adminAction(JSON.parse(await readBody(req))));
      } catch (e) { return send(res, e.status || 500, { message: String(e.message || e) }); }
    }
    if (pathname === '/admin/quick') {                                     // who has Quick Access, and signing a person out everywhere (admin only)
      if (isPublicRequest(req)) return send(res, 403, { message: 'Only available from your home network or tailnet.' });
      const tok = String(req.headers.authorization || '');
      if (!tok || !(await pbx.isSuperuser(tok))) return send(res, 401, { message: 'Admin only.' });
      try {
        if (req.method === 'GET') return send(res, 200, { people: await quick.overview() });
        if (req.method !== 'POST') return send(res, 405, { message: 'Method not allowed' });
        const b = JSON.parse(await readBody(req)); return send(res, 200, await quick.signOut(String(b.userId || '')));
      } catch (e) { return send(res, e.status || 500, { message: String(e.message || e) }); }
    }
    if (pathname === '/admin/inactive/notice') {
      if (isPublicRequest(req)) return send(res, 403, { message: 'Only available from your home network or tailnet.' });
      const tok = String(req.headers.authorization || '');
      if (!tok || !(await pbx.isSuperuser(tok))) return send(res, 401, { message: 'Admin only.' });
      if (req.method !== 'POST') return send(res, 405, { message: 'Method not allowed' });
      try { const b = JSON.parse(await readBody(req)); return send(res, 200, await notices.send(b.ids)); } catch (e) { return send(res, e.status || 500, { message: String(e.message || e) }); }
    }
    if (pathname === '/admin/google-signin') {   // switch Google on/off as a sign-in provider of the JoolzApp account (admin only; the secret goes straight to PocketBase)
      if (isPublicRequest(req)) return send(res, 403, { message: 'Only available from your home network or tailnet.' });
      const tok = String(req.headers.authorization || '');
      if (!tok || !(await pbx.isSuperuser(tok))) return send(res, 401, { message: 'Admin only.' });
      try {
        if (req.method === 'GET') return send(res, 200, await googleSignIn.status());
        if (req.method !== 'POST') return send(res, 405, { message: 'Method not allowed' });
        const b = JSON.parse(await readBody(req)); return send(res, 200, b.off ? await googleSignIn.off() : await googleSignIn.save(b));
      } catch (e) { return send(res, e.status || 500, { message: String(e.message || e) }); }
    }
    if (pathname === '/admin/changes' || pathname === '/admin/changes/apply') {
      if (isPublicRequest(req)) return send(res, 403, { message: 'Only available from your home network or tailnet.' });
      const tok = String(req.headers.authorization || '');
      if (!tok || !(await pbx.isSuperuser(tok))) return send(res, 401, { message: 'Admin only.' });
      try {
        if (pathname === '/admin/changes') return req.method === 'GET' ? send(res, 200, await changes.list()) : send(res, 405, { message: 'Method not allowed' });
        if (req.method !== 'POST') return send(res, 405, { message: 'Method not allowed' });
        const b = JSON.parse(await readBody(req)); return send(res, 200, await changes.apply(String(b.id || '')));
      } catch (e) { return send(res, e.status || 500, { message: String(e.message || e) }); }
    }
    if (pathname === '/forgot') {
      if (req.method !== 'POST') return send(res, 405, { message: 'Method not allowed' });
      if (signupThrottled(req)) return send(res, 429, { message: 'Too many attempts. Try again later.' });
      let b; try { b = JSON.parse(await readBody(req)); } catch { return send(res, 400, { message: 'Invalid request.' }); }
      await pbx.requestReset(b.identity).catch(() => {}); return send(res, 200, { ok: true });
    }
    if (pathname === '/signup') { if (req.method !== 'POST') return send(res, 405, { message: 'Method not allowed' }); return signup(req, res); }

    if (pathname === '/config') {
      if (req.method !== 'GET') return send(res, 405, { message: 'Method not allowed' });
      return send(res, 200, { pbUrl: currentPbUrl(), locked: true, custom: !!(ENV_PB_URL && normaliseUrl(ENV_PB_URL)), public: isPublicRequest(req), autoLogin: await behindUmbrelLogin(req), ...(isPublicRequest(req) || !autoWhy ? {} : { autoWhy }) });
    }
    // No second sign-in for the admin: whoever reaches this address has already passed Umbrel's own login (and Tailscale, from outside),
    // so the page is handed an admin session made with the login Portal Admin keeps. Strictly for requests that came through Umbrel's
    // login proxy for this app; anything else (another container, the old dashboard port, JoolzApp Dashboard's pass-through) gets nothing.
    if (pathname === '/auto-login') {
      if (req.method !== 'POST') return send(res, 405, { message: 'Method not allowed' });
      if (!(await behindUmbrelLogin(req))) return send(res, 403, { message: 'Not available here.' });
      const c = pbx.creds(), body = { identity: c.email, password: c.pass };
      try {
        let j; try { j = await pbx.raw('POST', '/api/collections/_superusers/auth-with-password', { body }); } catch (e) { if (e.status !== 404) throw e; j = await pbx.raw('POST', '/api/admins/auth-with-password', { body }); }
        return send(res, 200, { token: j.token, email: (j.record || j.admin || {}).email || c.email, id: (j.record || j.admin || {}).id || '' });
      } catch (e) { return send(res, 502, { message: "Portal Admin's saved PocketBase login no longer works. Sign in with the current one." }); }
    }

    if (pathname === '/umbrel-apps') {
      if (req.method !== 'GET') return send(res, 405, { message: 'Method not allowed' });
      if (isPublicRequest(req)) return send(res, 403, { message: 'Only available from your home network or tailnet.' });
      const found = installedApps();   // JoolzApp Dashboard is part of this app, not something to register, connect or show as an icon
      return send(res, 200, { ...found, apps: found.apps.filter((a) => a.dir !== 'joolay-portal') });
    }


    if (pathname === '/pb' || pathname.startsWith('/pb/')) {
      const pb = currentPbUrl();
      const sub = pathname.slice(3) || '/';
      if (!sub.startsWith('/api/')) return send(res, 403, { message: 'Only /api/ is proxied.' });
      if (isPublicRequest(req)) { const why = publicBlockReason(req, sub); if (why) return send(res, 403, { message: why }); }
      if (req.method === 'POST' && /^\/api\/collections\/[^/]+\/auth-with-password\/?$/.test(sub)) {
        const ip = clientIp(req); let raw; try { raw = await readBody(req, 16 * 1024); } catch { return send(res, 413, { message: 'Request too large.' }); }
        let who = ''; try { who = String(JSON.parse(raw).identity || '').trim().toLowerCase().slice(0, 200); } catch {}
        if (authBlocked(ip, who)) return send(res, 429, { message: 'Too many sign-in attempts. Try again in a few minutes.' });
        return proxy(req, res, pb, sub + (search || ''), { body: raw, onStatus: (st) => { if (st === 200) authOk(ip); else if (st >= 400 && st < 500 && st !== 429) authFailed(ip, who); } });
      }
      return proxy(req, res, pb, sub + (search || ''));
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    return serveStatic(req, res, decodeURIComponent(pathname));
  } catch (e) {
    send(res, 500, { message: String(e.message || e) });
  }
};

// JoolzApp Dashboard (the separate, internet-facing home screen app) passes these on for people: /user/<route> on the apps-only port,
// with its own Portal API key. They are ALWAYS handled as public, user-only requests, and only the routes listed here exist.
const PORTAL_ROUTES = new Set(['/signup-config', '/signup', '/forgot', '/guardians', '/family', '/family/users', '/events', '/paywall', '/pay', '/pay/status', '/account/ai', '/account/dob', '/account/username', '/account/guardian', '/store/layout', '/admin/apps', '/theme.css', '/qr', '/quick', '/api/active', '/yoco/webhook']);
const portalBad = new Map();
function fromPortal(req, res) {
  const ip = String(req.socket.remoteAddress || ''), now = Date.now(), fails = (portalBad.get(ip) || []).filter((t) => now - t < 600e3);
  if (fails.length >= 20) return send(res, 429, { message: 'Too many attempts.' });
  if (appapi.keys.appOf(String(req.headers['x-portal-key'] || '')) !== 'portal') { portalBad.set(ip, [...fails, now]); if (portalBad.size > 2000) portalBad.clear(); return send(res, 401, { message: 'Unknown app key.' }); }
  const u = new URL(req.url.slice(5), 'http://x');
  if (!PORTAL_ROUTES.has(u.pathname)) return send(res, 404, { message: 'Not found' });
  req.url = u.pathname + u.search; req.publicPort = true;
  req.portalClientIp = String(req.headers['x-portal-client-ip'] || '').slice(0, 64) || ip;
  delete req.headers['x-portal-key']; delete req.headers['x-portal-client-ip']; delete req.headers['x-forwarded-for'];
  return handle(req, res);
}
// The Portal app's key is handed over without a Changes card: it is our own app and no PocketBase change is involved.
const linkPortal = () => { try { const r = changes.linkPortal(); if (r) console.log('JoolzApp Dashboard: ' + r); } catch (e) { console.error('JoolzApp Dashboard link:', e.message); } };
const linkNew = () => changes.linkNewApps().then((d) => { if (d.length) console.log('Linked new app(s) to Portal API with their own limited login: ' + d.join(', ')); }).catch((e) => console.error('Linking new apps:', e.message));
setTimeout(() => { linkPortal(); linkNew(); }, 3000).unref(); setInterval(() => { linkPortal(); linkNew(); }, 30e3).unref();

// Listeners. PORT is the normal one (Umbrel's app address, behind Umbrel's login): the admin's own.
const server = http.createServer(handle);
setInterval(() => paywall.sweep().catch((e) => console.error('paywall sweep:', e.message)), 3600e3).unref();
setTimeout(() => paywall.sweep().catch(() => {}), 20e3).unref();
server.listen(PORT, '0.0.0.0', () => console.log(`Portal Admin listening on :${PORT}`));
// Portal API for the apps: its own internal port, never published through the tunnel. Every call needs an app key.
const APP_API_PORT = Number(process.env.APP_API_PORT === undefined ? 3002 : process.env.APP_API_PORT);
let apiServer = null;
if (APP_API_PORT && APP_API_PORT !== PORT) {
  apiServer = http.createServer((req, res) => {
    if (req.url.startsWith('/user/')) return fromPortal(req, res);
    appapi.handle(req, res).catch((e) => send(res, 500, { message: String(e.message || e) }));
  });
  apiServer.listen(APP_API_PORT, '0.0.0.0', () => console.log(`Portal API (apps only) listening on :${APP_API_PORT}`));
}
process.on('SIGTERM', () => { if (apiServer) apiServer.close(); server.close(() => process.exit(0)); });
