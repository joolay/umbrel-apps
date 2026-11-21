'use strict';
// Theme Editor: owner-only editor for the global Glass theme. It saves the theme to Portal Admin through the Portal API (`theme.get` / `theme.set` / `theme.reset`);
// Portal Admin serves the result as /theme.css, which every JoolzApp can load (templates/glass/theme-global.js). Only this app may change the theme.
// Owner-only: Umbrel's login stays in front of it, and it is not shown on the JoolzApp home screen (JOOLZAPP_DASHBOARD=hidden); it lives in the Store's Admin folder.
// Node built-ins only.
const http = require('http'), fs = require('fs'), path = require('path');
const PORT = Number(process.env.PORT) || 3000, DATA_DIR = process.env.DATA_DIR || '/data', PUBLIC_DIR = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

function portalLink() {   // data/pocketbase.env is written by Portal Admin (the same file every JoolzApp app uses)
  try {
    const kv = {}; for (const line of fs.readFileSync(path.join(DATA_DIR, 'pocketbase.env'), 'utf8').split(/\r?\n/)) { const m = line.match(/^\s*(POCKETBASE_PORTAL_(?:URL|KEY))\s*=\s*(.*?)\s*$/); if (m) kv[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2'); }
    return kv.POCKETBASE_PORTAL_URL && kv.POCKETBASE_PORTAL_KEY ? { url: kv.POCKETBASE_PORTAL_URL.replace(/\/+$/, ''), key: kv.POCKETBASE_PORTAL_KEY } : null;
  } catch { return null; }
}
async function portal(fn, args) {
  const p = portalLink(); if (!p) throw Object.assign(new Error('Not linked to Portal Admin yet: sign in to Portal Admin once and it links this app.'), { status: 503 });
  const r = await fetch(p.url + '/app-api/call', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + p.key }, body: JSON.stringify({ fn, args: args || [] }), signal: AbortSignal.timeout(15000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw Object.assign(new Error(j.message || 'Portal API error ' + r.status), { status: j.status || 502 });
  return j.result;
}
const send = (res, code, body, h = {}) => {
  const raw = typeof body === 'string' || Buffer.isBuffer(body);
  res.writeHead(code, { 'Content-Type': !raw ? 'application/json' : 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...h });
  res.end(raw ? body : JSON.stringify(body));
};
const readBody = (req, lim = 32 * 1024) => new Promise((ok, no) => { let n = 0; const c = []; req.on('data', (d) => { n += d.length; if (n > lim) { no(new Error('too large')); req.destroy(); } else c.push(d); }); req.on('end', () => ok(Buffer.concat(c).toString('utf8'))); req.on('error', no); });

const server = http.createServer(async (req, res) => {
  try {
    const p = new URL(req.url, 'http://x').pathname;
    if (p === '/api/theme' && req.method === 'GET') return send(res, 200, { theme: await portal('theme.get'), linked: true });
    if (p === '/api/theme' && req.method === 'POST') { let b; try { b = JSON.parse(await readBody(req)); } catch { return send(res, 400, { message: 'Invalid request.' }); } return send(res, 200, { theme: await portal('theme.set', [b.theme]) }); }
    if (p === '/api/reset' && req.method === 'POST') return send(res, 200, { theme: await portal('theme.reset') });
    if (p === '/api/state' && req.method === 'GET') return send(res, 200, { linked: !!portalLink() });
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    const file = path.normalize(path.join(PUBLIC_DIR, p === '/' ? '/index.html' : decodeURIComponent(p)));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden');
    fs.readFile(file, (e, buf) => (e ? send(res, 404, 'Not found') : send(res, 200, buf, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' })));
  } catch (e) { send(res, e.status || 500, { message: String(e.message || e) }); }
});
if (require.main === module) {
  fs.mkdirSync(DATA_DIR, { recursive: true });   // Portal Admin links an app once its data folder exists
  server.listen(PORT, '0.0.0.0', () => console.log('Theme Editor listening on :' + PORT));
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
}
module.exports = { server };
