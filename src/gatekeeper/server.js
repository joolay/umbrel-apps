// Gatekeeper: the gate in front of the apps on this Umbrel. Zero dependencies.
//
// Layered design: TSDProxy (unmodified) still owns the Tailscale names and Funnel. A name that should be protected points TSDProxy at this app
// (port 3921) instead of at the app. Gatekeeper then:
//   1. works out which app was asked for, from the name (Host / X-Forwarded-Host, first label) -> a route in /data/gatekeeper.json
//   2. makes the person sign in with their JoolzApp account (Portal API: login / verifyToken)
//   3. asks Portal Admin whether that account may open that app (Portal API gate.can: the same portal.access rules every app follows)
//   4. admin accounts open everything; an "admin only" route is refused to everyone else; then the request is passed on to the app.
// Nothing is stored about people here: only a signed session cookie. PocketBase is never touched directly.
'use strict';
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const portal = require('./portal');

const PORT = Number(process.env.PORT) || 3000;
const DATA = process.env.DATA_DIR || '/data';
const PUBLIC = path.join(__dirname, 'public');
const CFG = path.join(DATA, 'gatekeeper.json');
const COOKIE = 'gk_session';
const SESSION_MS = 12 * 3600e3;
const ACCESS_TTL = 30e3;           // how long a "may open" answer is reused (so a removed person is out within 30 s)
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };

try { fs.mkdirSync(DATA, { recursive: true }); } catch {}   // Portal Admin links apps that have a data folder

/* ---------- config: routes + session secret ---------- */
function loadCfg() {
  let c = {}; try { c = JSON.parse(fs.readFileSync(CFG, 'utf8')); } catch { c = {}; }
  if (!c.secret) { c.secret = crypto.randomBytes(32).toString('base64url'); }
  if (!Array.isArray(c.routes)) c.routes = [];
  return c;
}
let cfg = loadCfg();
function saveCfg() { fs.mkdirSync(DATA, { recursive: true }); const t = CFG + '.tmp'; fs.writeFileSync(t, JSON.stringify(cfg, null, 2), { mode: 0o600 }); fs.renameSync(t, CFG); }
saveCfg();

const LABEL = /^[a-z0-9]([a-z0-9-]{0,40}[a-z0-9])?$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,60}$/;
// An upstream is http(s)://host:port on this machine or its Docker network; credentials, paths and odd characters are refused.
function cleanUpstream(u) {
  u = String(u || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[A-Za-z0-9._-]+(:\d{1,5})?$/.test(u)) return '';
  return u;
}
function cleanRoute(r) {
  const name = String(r && r.name || '').trim().toLowerCase(), slug = String(r && r.slug || '').trim().toLowerCase(), upstream = cleanUpstream(r && r.upstream);
  if (!LABEL.test(name)) throw new HttpError(400, 'The name should be one word of letters, numbers or dashes (the first part of the Tailscale address).');
  if (!SLUG.test(slug)) throw new HttpError(400, 'The app id should look like stremio or joolay-kiosk-manager.');
  if (!upstream) throw new HttpError(400, 'The address of the app should look like http://host.docker.internal:3920.');
  return { name, slug, upstream, adminOnly: !!(r && r.adminOnly), enabled: !(r && r.enabled === false) };
}
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

/* ---------- sessions: a signed cookie, nothing stored ---------- */
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const sign = (body) => crypto.createHmac('sha256', cfg.secret).update(body).digest('base64url');
function makeSession(u) { const body = b64({ id: u.id, email: u.email, name: u.name || '', admin: !!u.admin, exp: Date.now() + SESSION_MS }); return body + '.' + sign(body); }
function readSession(req) {
  const m = new RegExp('(?:^|;\\s*)' + COOKIE + '=([^;]+)').exec(req.headers.cookie || ''); if (!m) return null;
  const [body, sig] = m[1].split('.'); if (!body || !sig) return null;
  const want = Buffer.from(sign(body)), got = Buffer.from(sig);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  try { const s = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); return s && s.exp > Date.now() && /^[a-z0-9]{15}$/.test(s.id) ? s : null; } catch { return null; }
}
const proto = (req) => String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || (req.socket.encrypted ? 'https' : 'http');
const setCookie = (req, v, maxAge) => `${COOKIE}=${v}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${proto(req) === 'https' ? '; Secure' : ''}`;

/* ---------- which route? ---------- */
function hostLabel(req) {
  const h = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim().toLowerCase().replace(/:\d+$/, '');
  return h.split('.')[0] || '';
}
function routeFor(req) { const l = hostLabel(req); return cfg.routes.find((r) => r.enabled && r.name === l) || null; }

/* ---------- may this person open that app? (cached briefly) ---------- */
const accessCache = new Map();
async function mayOpen(session, route) {
  if (session.admin) return { ok: true };
  if (route.adminOnly) return { ok: false, why: 'This is for the admin only.' };
  const key = session.id + '|' + route.slug, hit = accessCache.get(key);
  if (hit && Date.now() - hit.at < ACCESS_TTL) return hit.v;
  let v;
  try {
    const r = await portal.call('gate.can', [session.id, route.slug]);
    v = r && r.allowed && r.enabled ? { ok: true } : { ok: false, why: r && !r.enabled ? 'This app is switched off.' : 'Your account is not approved for this app. Ask the admin.' };
  } catch (e) { return { ok: false, why: 'Could not check your access just now. Try again in a moment.', error: true }; }   // fail closed, and do not cache a failure
  accessCache.set(key, { at: Date.now(), v }); if (accessCache.size > 2000) accessCache.clear();
  return v;
}

/* ---------- small helpers ---------- */
const send = (res, status, body, type = 'application/json', headers = {}) => { const s = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body); res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...headers }); res.end(s); };
function readBody(req, max = 64 * 1024) {
  return new Promise((resolve, reject) => { let n = 0; const c = []; req.on('data', (d) => { n += d.length; if (n > max) { reject(new HttpError(413, 'Too large')); req.destroy(); } else c.push(d); }); req.on('end', () => resolve(Buffer.concat(c).toString('utf8'))); req.on('error', reject); });
}
function serveStatic(res, rel) {
  const f = path.join(PUBLIC, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!f.startsWith(PUBLIC)) return send(res, 404, 'Not found', 'text/plain');
  fs.readFile(f, (e, d) => { if (e) return send(res, 404, 'Not found', 'text/plain'); send(res, 200, d, MIME[path.extname(f)] || 'application/octet-stream', { 'cache-control': 'no-cache' }); });
}
const page = (title, msg) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="font:16px system-ui;display:grid;place-items:center;min-height:100vh;margin:0;background:#0b1220;color:#f1f5f9"><div style="max-width:380px;padding:24px;text-align:center"><h1 style="font-size:22px">${title}</h1><p style="color:#a9b6c9">${msg}</p><p><a style="color:#8fb0ff" href="/__gk/logout">Sign in with another account</a></p></div></body>`;

/* ---------- sign-in rate limit: 10 tries per 10 minutes per caller ---------- */
const tries = new Map();
const clientIp = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
const recent = (ip) => { const a = (tries.get(ip) || []).filter((t) => Date.now() - t < 600e3); tries.set(ip, a); return a; };

/* ---------- Gatekeeper's own paths (/__gk/...) ---------- */
async function own(req, res, url) {
  const p = url.pathname;
  if (p === '/__gk/login' && req.method === 'GET') return serveStatic(res, 'gate.html');
  if (p === '/__gk/login' && req.method === 'POST') {
    const ip = clientIp(req); if (recent(ip).length >= 10) return send(res, 429, { message: 'Too many tries. Wait a few minutes.' });
    let b; try { b = JSON.parse(await readBody(req)); } catch { return send(res, 400, { message: 'Invalid request.' }); }
    try {
      const u = await portal.signIn(String(b.email || '').trim(), String(b.password || ''));
      return send(res, 200, { ok: true, name: u.name || u.email }, 'application/json', { 'set-cookie': setCookie(req, makeSession(u), SESSION_MS / 1000) });
    } catch (e) {
      tries.set(ip, [...recent(ip), Date.now()]);
      return send(res, e.status === 400 || e.status === 401 ? 401 : e.status || 502, { message: e.status === 400 || e.status === 401 ? 'That email or password is not right.' : 'Could not reach the account server.' });
    }
  }
  if (p === '/__gk/logout') { return send(res, 302, '', 'text/plain', { 'set-cookie': setCookie(req, '', 0), location: '/__gk/login' }); }
  if (p === '/__gk/me') { const s = readSession(req); return send(res, s ? 200 : 401, s ? { id: s.id, email: s.email, name: s.name, admin: s.admin } : { message: 'Not signed in.' }); }
  if (p.startsWith('/__gk/api/')) {
    const s = readSession(req);
    if (!s) return send(res, 401, { message: 'Sign in first.' });
    if (!s.admin) return send(res, 403, { message: 'Admin only.' });
    if (p === '/__gk/api/routes' && req.method === 'GET') return send(res, 200, { routes: cfg.routes, apps: await portal.knownApps().catch(() => []) });
    if (p === '/__gk/api/routes' && req.method === 'POST') {
      let b; try { b = JSON.parse(await readBody(req)); } catch { return send(res, 400, { message: 'Invalid request.' }); }
      try {
        if (b.action === 'remove') { cfg.routes = cfg.routes.filter((r) => r.name !== String(b.name || '')); }
        else { const r = cleanRoute(b.route); const i = cfg.routes.findIndex((x) => x.name === r.name); if (i >= 0) cfg.routes[i] = r; else cfg.routes.push(r); }
        saveCfg(); accessCache.clear();
        return send(res, 200, { routes: cfg.routes });
      } catch (e) { return send(res, e.status || 500, { message: String(e.message || e) }); }
    }
    return send(res, 404, { message: 'Not found' });
  }
  if (p === '/api/link' || p === '/healthz') return send(res, 200, 'ok', 'text/plain');
  return serveStatic(res, p.replace('/__gk/', '') || 'index.html');
}

/* ---------- the gate ---------- */
async function gate(req, res, route) {
  const s = readSession(req);
  if (!s) {
    if (req.method === 'GET' && /text\/html/.test(req.headers.accept || '')) return send(res, 302, '', 'text/plain', { location: '/__gk/login?next=' + encodeURIComponent(req.url) });
    return send(res, 401, { message: 'Sign in first.' });
  }
  const ok = await mayOpen(s, route);
  if (!ok.ok) return send(res, ok.error ? 503 : 403, page(ok.error ? 'Try again' : 'No access', ok.why), 'text/html; charset=utf-8');
  return proxy(req, res, route, s);
}
function upstreamHeaders(req, route, s) {
  const h = { ...req.headers };
  h.cookie = String(h.cookie || '').split(/;\s*/).filter((c) => c && !c.startsWith(COOKIE + '=')).join('; ');   // the gate's cookie never reaches the app
  if (!h.cookie) delete h.cookie;
  const u = new URL(route.upstream); h.host = u.host;
  h['x-forwarded-for'] = clientIp(req); h['x-forwarded-proto'] = proto(req); h['x-forwarded-host'] = req.headers['x-forwarded-host'] || req.headers.host || '';
  delete h['x-gatekeeper-user']; h['x-gatekeeper-user'] = s.email; delete h['x-gatekeeper-admin']; if (s.admin) h['x-gatekeeper-admin'] = '1';
  return h;
}
function proxy(req, res, route, s) {
  const u = new URL(route.upstream), lib = u.protocol === 'https:' ? require('https') : http;
  const up = lib.request({ hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), method: req.method, path: req.url, headers: upstreamHeaders(req, route, s), timeout: 60000, rejectUnauthorized: false }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  up.on('timeout', () => up.destroy(new Error('timeout')));
  up.on('error', () => { if (!res.headersSent) send(res, 502, page('App not answering', 'Gatekeeper could not reach the app. It may be stopped or still starting.'), 'text/html; charset=utf-8'); else res.destroy(); });
  req.pipe(up);
}
// WebSockets (many apps use them): same checks, then a raw tunnel.
async function upgrade(req, socket, head) {
  const route = routeFor(req), s = readSession(req);
  if (!route || !s || !(await mayOpen(s, route)).ok) { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return; }
  const u = new URL(route.upstream), up = net.connect(Number(u.port) || 80, u.hostname, () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`]; const h = upstreamHeaders(req, route, s);
    for (const [k, v] of Object.entries(h)) lines.push(`${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
    up.write(lines.join('\r\n') + '\r\n\r\n'); if (head && head.length) up.write(head); socket.pipe(up).pipe(socket);
  });
  up.on('error', () => socket.destroy()); socket.on('error', () => up.destroy());
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/__gk/') || url.pathname === '/healthz' || url.pathname === '/api/link') return await own(req, res, url);
    const route = routeFor(req);
    if (route) return await gate(req, res, route);
    // Not a protected name: this is Gatekeeper's own address, so show its admin page.
    if (url.pathname === '/' || url.pathname === '/index.html') return serveStatic(res, 'index.html');
    return serveStatic(res, url.pathname.slice(1));
  } catch (e) { send(res, e.status || 500, { message: e.status ? String(e.message) : 'Something went wrong.' }); }
});
server.on('upgrade', (req, socket, head) => { upgrade(req, socket, head).catch(() => socket.destroy()); });

if (require.main === module) server.listen(PORT, () => console.log('Gatekeeper on', PORT, '-', cfg.routes.length, 'route(s)'));
module.exports = { server, cfgRef: () => cfg, setCfg: (c) => { cfg = c; }, readSession, makeSession, cleanRoute, cleanUpstream, hostLabel };
