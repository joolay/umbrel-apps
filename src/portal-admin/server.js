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
// Umbrel app list (read-only: only list_apps and get_app_details are ever called). Token comes from the app's environment, never the repo.
const UMBREL_MCP_URL = (process.env.UMBREL_MCP_URL || 'http://host.docker.internal/mcp').trim();
const UMBREL_MCP_TOKEN = (process.env.UMBREL_MCP_TOKEN || '').trim();
const UMBREL_APP_PREFIX = (process.env.UMBREL_APP_PREFIX || 'joolay-').trim().toLowerCase();

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

/* ---------- Umbrel app list (MCP over HTTP) ---------- */
function parseMcp(text) {
  const line = text.split('\n').find((l) => l.startsWith('data:'));
  const j = JSON.parse(line ? line.slice(5) : text);
  if (j.error) throw new Error(j.error.message || 'MCP error');
  return j.result;
}
async function mcpCall(sid, id, method, params) {
  const r = await fetch(UMBREL_MCP_URL, {
    method: 'POST', signal: AbortSignal.timeout(15000),
    headers: { Authorization: 'Bearer ' + UMBREL_MCP_TOKEN, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(sid ? { 'Mcp-Session-Id': sid } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  if (!r.ok) throw new Error('Umbrel MCP returned HTTP ' + r.status);
  return { sid: r.headers.get('mcp-session-id') || sid, result: parseMcp(await r.text()) };
}
const toolJson = (res) => JSON.parse((res.content || []).map((c) => c.text || '').join(''));
let umbrelCache = { at: 0, apps: null };
async function umbrelApps() {
  if (umbrelCache.apps && Date.now() - umbrelCache.at < 60000) return umbrelCache.apps;
  let { sid } = await mcpCall('', 1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'portal-admin', version: '1' } });
  const list = toolJson((await mcpCall(sid, 2, 'tools/call', { name: 'list_apps', arguments: {} })).result);
  const mine = list.filter((a) => a.id.toLowerCase().startsWith(UMBREL_APP_PREFIX));
  const apps = [];
  for (const a of mine) {
    const slug = a.id.toLowerCase().slice(UMBREL_APP_PREFIX.length).replace(/[^a-z0-9_-]/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 48);
    if (!slug || slug === 'portal-admin') continue; // Portal Admin does not manage itself
    let d = {};
    try { d = toolJson((await mcpCall(sid, 10 + apps.length, 'tools/call', { name: 'get_app_details', arguments: { appId: a.id } })).result); } catch {}
    apps.push({ id: a.id, slug, name: a.name, version: a.version, state: a.state, tagline: d.tagline || '', url: d.url || '' });
  }
  umbrelCache = { at: Date.now(), apps };
  return apps;
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
      return send(res, 200, { pbUrl: currentPbUrl(), locked: true, custom: !!(ENV_PB_URL && normaliseUrl(ENV_PB_URL)) });
    }

    if (pathname === '/umbrel/apps') {
      if (req.method !== 'GET') return send(res, 405, { message: 'Method not allowed' });
      if (!UMBREL_MCP_TOKEN) return send(res, 200, { configured: false, apps: [] });
      try { return send(res, 200, { configured: true, prefix: UMBREL_APP_PREFIX, apps: await umbrelApps() }); }
      catch (e) { return send(res, 502, { configured: true, message: 'Cannot read the Umbrel app list: ' + (e.message || e) }); }
    }

    if (pathname === '/pb' || pathname.startsWith('/pb/')) {
      const pb = currentPbUrl();
      const sub = pathname.slice(3) || '/';
      if (!sub.startsWith('/api/')) return send(res, 403, { message: 'Only /api/ is proxied.' });
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
