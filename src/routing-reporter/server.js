'use strict';
// Port Master: checks, for every installed app, that its LAN, Tailscale and Public (Funnel) routes answer, shows the result, and reports it to Portal Admin
// (Portal API `publishRoutes`, which feeds Portal Admin's "JoolzApp apps" page) and to the status feed (so a problem can be diagnosed without opening anything).
// Node built-ins only. Owner-only: Umbrel's login stays in front of it.
const http = require('http'), fs = require('fs'), path = require('path');
const { makeMonitor } = require('./checker'), { makeRegistry } = require('./official'), { findPortClashes } = require('./clashes');

const PORT = Number(process.env.PORT) || 3000, DATA_DIR = process.env.DATA_DIR || '/data', PUBLIC_DIR = path.join(__dirname, 'public');
const APP_DIR = process.env.UMBREL_APP_DATA || '/umbrel-app-data', CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

/* ---------- settings (the addresses to test, kept in this app's data folder) ---------- */
const DEFAULTS = { lanHost: process.env.LAN_HOST || 'host.docker.internal', localHost: process.env.LOCAL_HOST || 'umbrel.local', tailscaleIp: process.env.TAILSCALE_IP || '', tailnet: process.env.TAILNET || '', intervalMin: 5 };
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(f + '.tmp', JSON.stringify(v, null, 2)); fs.renameSync(f + '.tmp', f); } catch (e) { console.error('Could not write', f, e.message); } };
let config = { ...DEFAULTS, ...readJson(CONFIG_FILE, {}) };
// Routes you chose to ignore ("<app id>|<route key>", e.g. an app that is not meant to be on Tailscale). They are still checked, but never count as a problem.
let ignored = new Set(Array.isArray(config.ignored) ? config.ignored.filter((k) => /^[A-Za-z0-9._-]{1,80}\|(lan|local|tailscale|name|public)$/.test(k)).slice(0, 400) : []);
delete config.ignored;
const saveConfig = () => writeJson(CONFIG_FILE, { ...config, ignored: [...ignored] });
const mark = (r) => r && { ...r, apps: r.apps.map((a) => ({ ...a, routes: a.routes.map((x) => ({ ...x, ignored: ignored.has(a.id + '|' + x.key) })) })) };
const clean = (b, old) => {
  const o = { ...old }, bad = (m) => Object.assign(new Error(m), { status: 400 });
  if (b.lanHost !== undefined) { const v = String(b.lanHost).trim(); if (!/^[A-Za-z0-9.-]{1,100}$/.test(v)) throw bad('The LAN address should look like 192.168.1.50 or umbrel.local.'); o.lanHost = v; }
  if (b.localHost !== undefined) { const v = String(b.localHost).trim().toLowerCase(); if (v && !/^[a-z0-9-]{1,63}\.local$/.test(v)) throw bad('The .local name looks like umbrel.local (leave it empty to skip this route).'); o.localHost = v; }
  if (b.tailscaleIp !== undefined) { const v = String(b.tailscaleIp).trim(); if (v && !/^100\.(?:\d{1,3}\.){2}\d{1,3}$/.test(v)) throw bad('A Tailscale address looks like 100.x.y.z.'); o.tailscaleIp = v; }
  if (b.tailnet !== undefined) { const v = String(b.tailnet).trim().toLowerCase().replace(/^\.+|\.+$/g, ''); if (v && !/^[a-z0-9-]{1,60}\.ts\.net$/.test(v)) throw bad('Your tailnet name looks like tail1234.ts.net.'); o.tailnet = v; }
  if (b.intervalMin !== undefined) { const v = Math.round(Number(b.intervalMin)); if (!(v >= 1 && v <= 60)) throw bad('Check every 1 to 60 minutes.'); o.intervalMin = v; }
  return o;
};

/* ---------- checking and reporting ---------- */
const monitor = makeMonitor({ dir: APP_DIR, listFile: process.env.TSDPROXY_LIST || '/tsdproxy-config/joolz-published.yaml', getConfig: () => config });
// The hidden list of official Umbrel store ports (see official.js): fetched about once a week, kept in the data folder, used only to find clashes.
const registry = makeRegistry({ file: path.join(DATA_DIR, 'official-ports.json'), url: process.env.OFFICIAL_STORE_URL || undefined });
const officialInfo = () => ({ count: registry.count, at: registry.at, error: registry.error });
const clashes = () => { const r = monitor.last; return r ? findPortClashes(r.apps, registry.apps) : []; };
const refreshOfficial = () => { if (registry.stale) registry.refresh().catch(() => {}); };
let reportState = { ok: null, at: 0, error: '' }, timer = null;
function portalLink() {     // data/pocketbase.env is written by Portal Admin once you have signed in there (the same file every JoolzApp app uses)
  try {
    const kv = {}; for (const line of fs.readFileSync(path.join(DATA_DIR, 'pocketbase.env'), 'utf8').split(/\r?\n/)) { const m = line.match(/^\s*(POCKETBASE_PORTAL_(?:URL|KEY))\s*=\s*(.*?)\s*$/); if (m) kv[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2'); }
    return kv.POCKETBASE_PORTAL_URL && kv.POCKETBASE_PORTAL_KEY ? { url: kv.POCKETBASE_PORTAL_URL.replace(/\/+$/, ''), key: kv.POCKETBASE_PORTAL_KEY } : null;
  } catch { return null; }
}
async function sendToPortal(report) {
  const p = portalLink(); if (!p) { reportState = { ok: false, at: Date.now(), error: 'Not linked to Portal Admin yet: sign in to Portal Admin once and it links this app.' }; return; }
  try {
    const r = await fetch(p.url + '/app-api/call', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + p.key }, body: JSON.stringify({ fn: 'publishRoutes', args: [report] }), signal: AbortSignal.timeout(15000) });
    const j = await r.json().catch(() => ({})); if (!r.ok || !j.ok) throw new Error(j.message || 'Portal API error ' + r.status);
    reportState = { ok: true, at: Date.now(), error: '' };
  } catch (e) { reportState = { ok: false, at: Date.now(), error: String(e.message || e).slice(0, 160) }; console.error('Report to Portal Admin: ' + reportState.error); }
}
async function checkNow() { const rep = mark(await monitor.run()); await sendToPortal(rep); return rep; }
function schedule() { clearTimeout(timer); timer = setTimeout(async () => { try { await checkNow(); } catch (e) { console.error('Check failed:', e.message); } schedule(); }, config.intervalMin * 60e3); if (timer.unref) timer.unref(); }
// What the status feed carries: states and reasons, never latency (it changes every check and would be a commit every time).
const feedPayload = async () => {
  const r = mark(monitor.last); if (!r) return { note: 'No check has run yet.' };
  const down = []; r.apps.forEach((a) => a.routes.filter((x) => x.state === 'down' && !x.ignored).forEach((x) => down.push({ app: a.id, route: x.key, url: x.url, error: x.error, since: x.since })));
  // Every port in one list (sorted), so a clash or a gap is easy to see: the app's own port, plus any host port it publishes itself.
  const ports = [], by = {};
  r.apps.forEach((a) => { const st = a.routes.some((x) => x.state === 'down' && !x.ignored) ? 'down' : a.routes.length && a.routes.every((x) => x.state === 'up' || x.ignored) ? 'up' : 'checking';
    [[a.port, 'app'], ...(a.hostPorts || []).filter((p) => p !== a.port).map((p) => [p, 'published'])].forEach(([p, kind]) => { ports.push({ port: p, app: a.id, name: a.name, kind, state: st }); (by[p] = by[p] || new Set()).add(a.id); }); });
  ports.sort((x, y) => x.port - y.port);
  const conflicts = Object.keys(by).filter((p) => by[p].size > 1).map((p) => ({ port: Number(p), apps: [...by[p]] }));
  return { intervalMin: r.intervalMin, config: r.config, reportedToPortalAdmin: reportState.ok, reportError: reportState.error, routesDown: down, portConflicts: conflicts,
    // Clashes with official Umbrel apps (installed or not): the official app keeps the port, the app listed under change should move (suggestedPort is free). The official list itself is not included, only its size.
    portClashes: clashes().map((c) => ({ port: c.port, keep: c.keep.map((p) => ({ id: p.id, source: p.source, installed: p.installed })), change: c.change.map((p) => ({ id: p.id, source: p.source, kind: p.kind, suggestedPort: p.suggestedPort || null })) })), officialPorts: officialInfo(), ports,
    apps: r.apps.map((a) => ({ id: a.id, name: a.name, version: a.version, joolzapp: a.joolzapp, port: a.port, hostPorts: a.hostPorts || [], published: a.published, routes: a.routes.map((x) => ({ key: x.key, url: x.url, state: x.state, ignored: x.ignored, status: x.status, error: x.error, since: x.since })) })) };
};

/* ---------- web server ---------- */
const send = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
const body = (req) => new Promise((ok, bad) => { let s = ''; req.on('data', (c) => { s += c; if (s.length > 20000) { bad(new Error('Too large')); req.destroy(); } }); req.on('end', () => ok(s)); });
const server = http.createServer(async (req, res) => {
  try {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/api/link' && req.method === 'GET') return send(res, 200, feedHandle ? feedHandle.link() : { state: 'broken', shaking: false, note: 'Not reporting yet.' });
    if (p === '/api/state' && req.method === 'GET') return send(res, 200, { report: mark(monitor.last), clashes: clashes(), official: officialInfo(), config, portal: { linked: !!portalLink(), ...reportState }, checking: false });
    if (p === '/api/check' && req.method === 'POST') { const rep = await checkNow(); refreshOfficial(); return send(res, 200, { report: rep, clashes: clashes(), official: officialInfo(), portal: { linked: !!portalLink(), ...reportState } }); }
    if (p === '/api/ignore' && req.method === 'POST') {
      let b; try { b = JSON.parse((await body(req)) || '{}'); } catch { return send(res, 400, { message: 'Bad request.' }); }
      const k = String(b.appId || '') + '|' + String(b.route || '');
      if (!monitor.last || !monitor.last.apps.some((a) => a.id === b.appId && a.routes.some((x) => x.key === b.route))) return send(res, 404, { message: 'That route is not in the latest check.' });
      if (b.ignore) ignored.add(k); else ignored.delete(k);
      saveConfig(); const rep = mark(monitor.last); await sendToPortal(rep); return send(res, 200, { report: rep, portal: { linked: !!portalLink(), ...reportState } });
    }
    if (p === '/api/config' && req.method === 'PUT') {
      try { config = clean(JSON.parse((await body(req)) || '{}'), config); } catch (e) { return send(res, e.status || 400, { message: e.message }); }
      saveConfig(); schedule(); const rep = await checkNow(); return send(res, 200, { config, report: rep, portal: { linked: !!portalLink(), ...reportState } });
    }
    const file = path.join(PUBLIC_DIR, p === '/' ? 'index.html' : p), ok = file.startsWith(PUBLIC_DIR + path.sep);
    if (!ok || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, { message: 'Not found' });
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' }); fs.createReadStream(file).pipe(res);
  } catch (e) { console.error(e); send(res, 500, { message: 'Something went wrong.' }); }
});
module.exports = { clean, feedPayload, _monitor: monitor, _registry: registry };
let feedHandle = null;   // status feed handle: its link() feeds the top bar's handshake icon (GET /api/link)
if (require.main === module) {
  fs.mkdirSync(DATA_DIR, { recursive: true });        // Portal Admin links an app once its data folder exists
  feedHandle = require('./status-feed')({ dataDir: DATA_DIR, getPayload: feedPayload, log: (m) => console.error(m) });
  server.listen(PORT, '0.0.0.0', () => console.log('Port Master listening on :' + PORT));
  setTimeout(() => { checkNow().catch((e) => console.error('Check failed:', e.message)); schedule(); }, 5000);
  setTimeout(refreshOfficial, 15000); const weekly = setInterval(refreshOfficial, 6 * 3600e3); if (weekly.unref) weekly.unref();
}
