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
