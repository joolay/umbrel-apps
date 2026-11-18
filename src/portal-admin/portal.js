'use strict';
// JoolzApp Portal: the home screen everyone uses (sign-in, sign-up, app icons, family, settings, payments).
// It runs from the same image as Portal Admin but is a different, much smaller program, and it is the one that faces the internet:
//  - it holds NO PocketBase superuser login and has no admin pages, Changes, or app folders mounted;
//  - /pb/*   : people's own PocketBase calls (their own token, collection rules apply). Admin APIs and superuser tokens are refused;
//  - the few things that need more than a person's own token (sign-up, family, guardians, events, payments) are passed to
//    Portal Admin over its internal apps-only port, with this app's own Portal API key. Portal Admin always treats those as
//    coming from the public: user-only, whatever they contain.
// The key arrives in <data>/pocketbase.env, written by Portal Admin by itself once both apps are installed.
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || '/data';
const PUBLIC_DIR = path.join(__dirname, 'public');
const PB_URL = (() => { try { const u = new URL(String(process.env.PB_URL || '').trim()); if (/^https?:$/.test(u.protocol)) return u.origin + u.pathname.replace(/\/+$/, ''); } catch {} return 'http://host.docker.internal:5400'; })();
const SUPERUSER_COLLECTION_ID = 'pbc_3142635823';   // PocketBase's built-in _superusers collection
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon' };
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}   // Portal Admin looks for this folder before it writes the key

function send(res, code, body, headers = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': typeof body === 'object' && !Buffer.isBuffer(body) ? 'application/json' : 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store', ...headers });
  res.end(data);
}
function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8'))); req.on('error', reject);
  });
}

// ---- This app's Portal API key (re-read from the file at most every 2 s while there is none, and again if Portal Admin refuses it) ----
let link = { url: '', key: '' }, lastLook = 0;
function loadLink(force) {
  if (!force && (link.key || Date.now() - lastLook < 2000)) return link;
  lastLook = Date.now();
  const got = { url: process.env.POCKETBASE_PORTAL_URL || '', key: process.env.POCKETBASE_PORTAL_KEY || '' };
  try {
    for (const line of fs.readFileSync(path.join(DATA_DIR, 'pocketbase.env'), 'utf8').split(/\r?\n/)) {
      const m = /^\s*(POCKETBASE_PORTAL_URL|POCKETBASE_PORTAL_KEY)\s*=\s*(.*?)\s*$/.exec(line);
      if (m && !process.env[m[1]]) got[m[1] === 'POCKETBASE_PORTAL_URL' ? 'url' : 'key'] = m[2];
    }
  } catch {}
  link = { url: got.url.replace(/\/+$/, ''), key: got.key };
  return link;
}

// ---- Who is calling, and sign-in guessing (same limits as before: 10 per address and 20 per account name in 10 minutes) ----
function isPrivateAddr(a) {
  a = String(a || '').trim().toLowerCase().replace(/^::ffff:/, '');
  if (!a || a === '::1' || a === 'localhost') return true;
  if (/^f[cd][0-9a-f]{2}:/.test(a) || /^fe80:/.test(a)) return true;
  const m = a.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)(?::\d+)?$/); if (!m) return false;
  const [x, y] = [Number(m[1]), Number(m[2])];
  return x === 10 || x === 127 || (x === 192 && y === 168) || (x === 172 && y >= 16 && y <= 31) || (x === 169 && y === 254) || (x === 100 && y >= 64 && y <= 127);
}
function clientIp(req) {
  const xs = String(req.headers['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean);
  for (let i = xs.length - 1; i >= 0; i--) if (!isPrivateAddr(xs[i])) return xs[i];
  return xs.length ? xs[xs.length - 1] : String(req.socket.remoteAddress || '');
}
const authFails = new Map();
const failList = (k) => { const now = Date.now(), a = (authFails.get(k) || []).filter((t) => now - t < 600e3); if (a.length) authFails.set(k, a); else authFails.delete(k); return a; };
const authBlocked = (ip, id) => failList('ip:' + ip).length >= 10 || (id && failList('id:' + id).length >= 20);
function authFailed(ip, id) { for (const k of ['ip:' + ip, id && 'id:' + id]) if (k) authFails.set(k, [...failList(k), Date.now()]); if (authFails.size > 5000) authFails.clear(); }
const authOk = (ip) => authFails.delete('ip:' + ip);

// ---- People's own PocketBase calls ----
// Only record access and sign-in flows of normal collections (their rules still apply), files and health. Collection definitions,
// settings, backups, logs, every system collection (names starting with "_") and any superuser token are refused: this app has no admin side.
const PB_ALLOW = [
  /^\/api\/health\/?$/,
  /^\/api\/collections\/(?!_)[^/]+\/(records|auth-with-password|auth-refresh|auth-methods|request-password-reset|confirm-password-reset|request-verification|confirm-verification)(\/|$)/,
  /^\/api\/files\//,
];
function isSuperuserToken(auth) {
  try { const tok = String(auth || '').replace(/^Bearer\s+/i, ''); return JSON.parse(Buffer.from(tok.split('.')[1] || '', 'base64url').toString('utf8')).collectionId === SUPERUSER_COLLECTION_ID; }
  catch { return false; }
}
function pass(req, res, target, headers, opt = {}) {
  const lib = target.protocol === 'https:' ? https : http;
  if (opt.body !== undefined) { headers['content-length'] = Buffer.byteLength(opt.body); delete headers['transfer-encoding']; }
  const up = lib.request(target, { method: req.method, headers, timeout: 30000 }, (r) => {
    if (opt.onStatus) opt.onStatus(r.statusCode || 502);
    const h = { ...r.headers, 'cache-control': 'no-store' }; delete h['set-cookie'];
    res.writeHead(r.statusCode || 502, h); r.pipe(res);
  });
  up.on('timeout', () => up.destroy(new Error('timeout')));
  up.on('error', (e) => { if (!res.headersSent) send(res, 502, { message: opt.down || 'Cannot reach PocketBase: ' + e.message }); else res.destroy(); });
  if (opt.body !== undefined) up.end(opt.body); else req.pipe(up);
}
async function pocketbase(req, res, sub, search) {
  if (!sub.startsWith('/api/')) return send(res, 403, { message: 'Only /api/ is proxied.' });
  if (isSuperuserToken(req.headers.authorization) || !PB_ALLOW.some((re) => re.test(sub))) return send(res, 403, { message: 'Admin sign-in is not available here. Use Portal Admin on your home network.' });
  const target = new URL(PB_URL + sub + (search || ''));
  const headers = { ...req.headers, host: target.host };
  delete headers.origin; delete headers.referer; delete headers.cookie; delete headers['accept-encoding'];
  if (req.method === 'POST' && /^\/api\/collections\/[^/]+\/auth-with-password\/?$/.test(sub)) {
    const ip = clientIp(req); let raw; try { raw = await readBody(req, 16 * 1024); } catch { return send(res, 413, { message: 'Request too large.' }); }
    let who = ''; try { who = String(JSON.parse(raw).identity || '').trim().toLowerCase().slice(0, 200); } catch {}
    if (authBlocked(ip, who)) return send(res, 429, { message: 'Too many sign-in attempts. Try again in a few minutes.' });
    return pass(req, res, target, headers, { body: raw, onStatus: (st) => { if (st === 200) authOk(ip); else if (st >= 400 && st < 500 && st !== 429) authFailed(ip, who); } });
  }
  return pass(req, res, target, headers);
}

// ---- Everything that needs Portal Admin's help ----
const VIA_ADMIN = new Set(['/signup-config', '/signup', '/forgot', '/guardians', '/family', '/family/users', '/events', '/paywall', '/pay', '/pay/status', '/account/dob', '/account/username', '/account/guardian', '/qr', '/quick', '/api/active', '/yoco/webhook']);
function viaAdmin(req, res, pathname, search) {
  const l = loadLink();
  if (!l.url || !l.key) return send(res, 503, { message: 'JoolzApp is still being set up. Try again in a minute.' });
  const target = new URL(l.url + '/user' + pathname + (search || ''));
  const headers = { ...req.headers, host: target.host, 'x-portal-key': l.key, 'x-portal-client-ip': clientIp(req) };
  delete headers.cookie; delete headers['accept-encoding']; delete headers['x-forwarded-for'];
  // A 401 may mean Portal Admin replaced this app's key: look at the file again (at most every 2 s) so the next request uses the new one.
  pass(req, res, target, headers, { down: 'JoolzApp is restarting. Try again in a moment.', onStatus: (st) => { if (st === 401 && Date.now() - lastLook > 2000) loadLink(true); } });
}

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden');
  fs.readFile(file, (err, buf) => (err ? send(res, 404, 'Not found') : send(res, 200, buf, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' })));
}

const server = http.createServer(async (req, res) => {
  try {
    const { pathname, search } = new URL(req.url, 'http://x');
    if (pathname === '/healthz') return send(res, 200, { ok: true });
    if (pathname === '/config') return req.method === 'GET' ? send(res, 200, { pbUrl: PB_URL, locked: true, custom: false, public: true, portal: true, ready: !!loadLink().key }) : send(res, 405, { message: 'Method not allowed' });
    if (pathname === '/pb' || pathname.startsWith('/pb/')) return await pocketbase(req, res, pathname.slice(3) || '/', search);
    if (VIA_ADMIN.has(pathname)) return viaAdmin(req, res, pathname, search);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    return serveStatic(res, decodeURIComponent(pathname));
  } catch (e) { send(res, 500, { message: String(e.message || e) }); }
});
if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => console.log(`JoolzApp Portal listening on :${PORT} (PocketBase ${PB_URL}, Portal Admin link ${loadLink().key ? 'ready' : 'waiting for its key'})`));
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
}
module.exports = { server, VIA_ADMIN: [...VIA_ADMIN] };
