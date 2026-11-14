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

const server = http.createServer(async (req, res) => {
  try {
    const { pathname, search } = new URL(req.url, 'http://x');
    if (pathname === '/healthz') return send(res, 200, { ok: true });

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
});

server.listen(PORT, '0.0.0.0', () => console.log(`Portal Admin listening on :${PORT}`));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
