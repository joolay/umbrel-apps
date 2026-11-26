'use strict';
// Port Master: checks, for every installed app, that its LAN, Tailscale and Public (Funnel) routes answer, shows the result, and reports it to Portal Admin
// (Portal API `publishRoutes`, which feeds Portal Admin's "JoolzApp apps" page) and to the status feed (so a problem can be diagnosed without opening anything).
// Node built-ins only. Owner-only: Umbrel's login stays in front of it.
const http = require('http'), fs = require('fs'), path = require('path');
const names = require('./names'), { applyControl, cleanPaused } = require('./control'), { makeMonitor } = require('./checker'), { makeRegistry } = require('./official'), { findPortClashes } = require('./clashes');

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
const saveConfig = () => writeJson(CONFIG_FILE, { ...config, ignored: [...ignored], pausedProxies: [...paused].sort() });
// TSDProxy control (see control.js): the proxies we want paused are kept in our own settings and mirrored to joolz-paused.json in TSDProxy's folder; Services Manager's keeper
// applies them and reports back in tsdproxy-status.json (version, update state, every proxy and whether the API can be reached).
const TSD_DIR = process.env.TSDPROXY_DIR || '/tsdproxy-config', TSD_STATUS = path.join(TSD_DIR, 'tsdproxy-status.json'), TSD_PAUSED = path.join(TSD_DIR, 'joolz-paused.json');
let paused = new Set(cleanPaused(config.pausedProxies || readJson(TSD_PAUSED, {}).paused)); delete config.pausedProxies;
let pausedWrite = { ok: null, error: '' };
const tsdStatus = () => readJson(TSD_STATUS, null);
const knownProxies = () => new Set([...(monitor.last ? monitor.last.apps.map((a) => a.tsdName).filter(Boolean) : []), ...(((tsdStatus() || {}).proxies || []).map((p) => p.name))]);
const slugOf = (id) => String(id).toLowerCase().replace(/^joolay-/, '').replace(/[^a-z0-9_-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 48);   // same rule as Portal Admin
// Where each app stands on the JoolzApp Store: auto (a JoolzApp app, shown by itself), locked (an owner-only JoolzApp tool, lives in the Admin folder), on / off (any other app: Port Master can add or hide its tile).
function withPortal(r) {
  if (!r) return r;
  return { ...r, apps: r.apps.map((a) => {
    const slug = slugOf(a.id), rec = tiles.items && tiles.items.find((t) => t.slug === slug);
    const portal = a.joolzapp ? { state: a.onPortal ? 'auto' : 'locked', slug } : { state: rec && rec.enabled ? 'on' : 'off', slug, url: rec && rec.enabled ? rec.url : '', audience: rec && rec.enabled ? rec.audience : '', known: !!tiles.items, error: tiles.items ? '' : tiles.error };
    return { ...a, portal, onPortal: portal.state === 'auto' || portal.state === 'on' };
  }) };
}
const mark = (r) => withPortal(applyControl(r, { ignored, paused, tsd: tsdStatus() }));
function savePaused() {
  saveConfig();
  try { fs.writeFileSync(TSD_PAUSED + '.tmp', JSON.stringify({ paused: [...paused].sort(), at: new Date().toISOString(), by: 'port-master' }, null, 2)); fs.renameSync(TSD_PAUSED + '.tmp', TSD_PAUSED); pausedWrite = { ok: true, error: '' }; }
  catch (e) { pausedWrite = { ok: false, error: 'TSDProxy\'s folder is not writable from Port Master (' + String(e.code || e.message).slice(0, 60) + ')' }; }
}
const tsdInfo = () => { const t = tsdStatus(), now = Date.now(); return { status: t, fresh: !!(t && t.at && now - t.at < 90e3), paused: [...paused].sort(), write: pausedWrite }; };
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
const NAMES_FILE = path.join(TSD_DIR, names.LIST), TSD_YAML = path.join(TSD_DIR, 'tsdproxy.yaml');
const monitor = makeMonitor({ dir: APP_DIR, listFile: [{ file: process.env.TSDPROXY_LIST || path.join(TSD_DIR, 'joolz-published.yaml'), source: 'list' }, { file: NAMES_FILE, source: 'names' }], getConfig: () => config, proxyStatus: (n) => { const p = (((tsdStatus() || {}).proxies) || []).find((x) => x.name === n); return p ? p.status : ''; } });

/* ---------- Tailscale name upkeep (names.js): create, modify and fix the names Port Master gives, kept in TSDProxy's list file joolz-names.yaml ---------- */
let namesState = { ok: null, error: '', changes: [], at: 0, declared: null };
const readText = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const atomic = (f, txt, mode) => { fs.writeFileSync(f + '.tmp', txt, mode ? { mode } : undefined); fs.renameSync(f + '.tmp', f); };
// Makes the list file match what we want. Returns true when the file or TSDProxy's settings changed (the caller then checks again so the new names show up).
function syncNames() {
  const apps = monitor.last && monitor.last.apps; if (!apps) return false;
  const owned = { ...(config.names || {}) }, opts = { ...(config.nameOpts || {}) };
  const first = !config.namesAdopted;
  // 1.10.1, once: apps whose label was removed before Port Master 1.10.0 was running were given a default name, port and visibility. Put our own apps back on what they had before (name, host port, Public).
  if (config.seedAligned !== 1) { for (const a of apps) { const sd = names.seedFor(a.id); if (sd && owned[a.id]) { owned[a.id] = sd.name; opts[a.id] = { port: sd.port, funnel: sd.funnel }; delete (config.noNames || {})[a.id]; } } config.seedAligned = 1; saveConfig(); }
  if (first) { for (const a of apps) if (a.nameSource === 'names' && a.tsdName && !owned[a.id]) owned[a.id] = a.tsdName; config.namesAdopted = true; }
  if (config.autoNames !== false) for (const a of apps) if (!a.tsdName && !owned[a.id] && !(config.noNames || {})[a.id]) { const n = names.suggest(apps, a.id), sd = names.seedFor(a.id); if (n) { owned[a.id] = n; if (sd) opts[a.id] = { port: sd.port, funnel: sd.funnel }; } }
  const r = names.reconcile(apps, owned, opts);
  for (const id of Object.keys(opts)) if (!r.owned[id]) delete opts[id];
  if (JSON.stringify(r.owned) !== JSON.stringify(config.names || {}) || JSON.stringify(opts) !== JSON.stringify(config.nameOpts || {}) || first) { if (Object.keys(r.owned).length) config.names = r.owned; else delete config.names; if (Object.keys(opts).length) config.nameOpts = opts; else delete config.nameOpts; saveConfig(); }
  let changed = false, error = '', declared = null;
  const text = names.listFile(r.entries), cur = readText(NAMES_FILE);
  try {
    if ((cur === null && r.entries.length) || (cur !== null && cur !== text)) { atomic(NAMES_FILE, text); changed = true; }
    if (r.entries.length) {
      const yaml = readText(TSD_YAML);
      if (yaml === null) error = "TSDProxy's settings file is not visible to Port Master, so the names list is not switched on yet.";
      else { const next = names.withList(yaml); declared = next === yaml;
        if (!declared) { try { fs.writeFileSync(TSD_YAML + '.bak', yaml, { mode: 0o600 }); } catch { /* backup is best effort */ } atomic(TSD_YAML, next, 0o600); declared = true; changed = true;
          try { fs.writeFileSync(path.join(TSD_DIR, 'restart-tsdproxy'), new Date().toISOString() + '\n'); } catch { error = 'Restart the TSDProxy app once so it reads the names list.'; } } }
    }
  } catch (e) { error = "TSDProxy's folder is not writable from Port Master (" + String(e.code || e.message).slice(0, 60) + ')'; }
  namesState = { ok: !error, error, changes: r.changes.slice(0, 20), at: Date.now(), declared };
  try { autoRestartIfUnregistered(changed); } catch { /* best effort */ }
  return changed;
}
// TSDProxy only reads the names list when it starts. When names we wrote are still missing from its proxy list after ~6 minutes, ask Services Manager to restart it (at most 3 tries, 30 minutes apart; a changed list starts over).
let unregSince = 0, lastAuto = 0, autoTries = 0;
function autoRestartIfUnregistered(listChanged) {
  if (listChanged) { autoTries = 0; unregSince = 0; }
  const bad = namesInfo().rows.filter((x) => x.state === 'unregistered');
  if (!bad.length) { unregSince = 0; autoTries = 0; return; }
  const now = Date.now(); if (!unregSince) { unregSince = now; return; }
  if (now - unregSince < 6 * 60e3 || now - lastAuto < 30 * 60e3 || autoTries >= 3) return;
  fs.writeFileSync(path.join(TSD_DIR, 'restart-tsdproxy'), new Date(now - 31000).toISOString() + '\n'); lastAuto = now; autoTries++;
  namesState.note = 'Restarted TSDProxy automatically (try ' + autoTries + ') because ' + bad.length + ' name(s) were not registered: ' + bad.map((x) => x.tsdName).join(', ');
}
const namesInfo = () => { const apps = monitor.last ? monitor.last.apps : [], ts = tsdStatus(), live = !!(ts && ts.at && Date.now() - ts.at < 90e3 && ts.api && ts.api.reachable);
  return { rows: names.review(apps, config.names || {}, live ? ts.proxies || [] : null, config.nameOpts || {}), auto: config.autoNames !== false, write: namesState, owned: Object.keys(config.names || {}).length }; };
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
// Generic Portal API call (the same key and address as the report). Throws with Portal Admin's message.
async function portalCall(fn, args) {
  const p = portalLink(); if (!p) throw Object.assign(new Error('Not linked to Portal Admin yet: sign in to Portal Admin once and it links this app.'), { status: 409 });
  const r = await fetch(p.url + '/app-api/call', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + p.key }, body: JSON.stringify({ fn, args }), signal: AbortSignal.timeout(15000) });
  const j = await r.json().catch(() => ({})); if (!r.ok || !j.ok) throw Object.assign(new Error(j.message || 'Portal API error ' + r.status), { status: r.status === 200 ? (j.status || 502) : r.status });
  return j.result;
}
// Tiles on the JoolzApp Store for apps that do not use the JoolzApp account (see src/portal-admin/portalapps.js). Refreshed with every check and after every change.
let tiles = { items: null, at: 0, error: '' };
async function refreshTiles() { try { tiles = { items: await portalCall('portalApps.list', []), at: Date.now(), error: '' }; } catch (e) { tiles = { items: tiles.items, at: tiles.at, error: String(e.message || e).slice(0, 160) }; } }
async function checkNow() { await monitor.run(); if (syncNames()) await monitor.run(); await refreshTiles(); const rep = mark(monitor.last); await sendToPortal(rep); return rep; }
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
  const t = tsdInfo(), ts = t.status || {};
  return { tsdproxy: { fresh: t.fresh, apiReachable: !!(ts.api && ts.api.reachable), apiError: ts.api && ts.api.error || '', version: ts.api && ts.api.version || ts.container && ts.container.version || '', image: ts.container && ts.container.image || '', updateAvailable: !!(ts.update && ts.update.available), lastUpdate: ts.update && ts.update.last || null, pausedByPortMaster: t.paused, writeError: t.write.error, proxies: (ts.proxies || []).map((p) => ({ name: p.name, status: p.status })) },
    names: (() => { const n = namesInfo(); return { auto: n.auto, keptByPortMaster: n.owned, withoutName: n.rows.filter((x) => x.state === 'none').length, problems: n.rows.filter((x) => x.state === 'clash' || x.state === 'unregistered').map((x) => ({ app: x.appId, name: x.tsdName, state: x.state })), lastError: n.write.error, note: n.write.note || '', fixed: n.write.changes }; })(),
    intervalMin: r.intervalMin, config: r.config, reportedToPortalAdmin: reportState.ok, reportError: reportState.error, routesDown: down, portConflicts: conflicts,
    // Clashes with official Umbrel apps (installed or not): the official app keeps the port, the app listed under change should move (suggestedPort is free). The official list itself is not included, only its size.
    portClashes: clashes().map((c) => ({ port: c.port, keep: c.keep.map((p) => ({ id: p.id, source: p.source, installed: p.installed })), change: c.change.map((p) => ({ id: p.id, source: p.source, kind: p.kind, suggestedPort: p.suggestedPort || null })) })), officialPorts: officialInfo(), ports,
    apps: r.apps.map((a) => ({ id: a.id, name: a.name, version: a.version, joolzapp: a.joolzapp, portal: a.portal && a.portal.state, port: a.port, hostPorts: a.hostPorts || [], published: a.published, routes: a.routes.map((x) => ({ key: x.key, url: x.url, state: x.state, ignored: x.ignored, status: x.status, error: x.error, since: x.since })) })) };
};

/* ---------- web server ---------- */
const send = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
const body = (req) => new Promise((ok, bad) => { let s = ''; req.on('data', (c) => { s += c; if (s.length > 20000) { bad(new Error('Too large')); req.destroy(); } }); req.on('end', () => ok(s)); });
const server = http.createServer(async (req, res) => {
  try {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/api/app-config' && req.method === 'GET') { const pl = portalLink(); return send(res, 200, { portalUrl: pl ? pl.url : '' }); }
    if (p === '/api/link' && req.method === 'GET') return send(res, 200, feedHandle ? feedHandle.link() : { state: 'broken', shaking: false, note: 'Not reporting yet.' });
    if (p === '/api/state' && req.method === 'GET') return send(res, 200, { report: mark(monitor.last), tsd: tsdInfo(), names: namesInfo(), clashes: clashes(), official: officialInfo(), config, portal: { linked: !!portalLink(), ...reportState }, checking: false });
    if (p === '/api/check' && req.method === 'POST') { const rep = await checkNow(); refreshOfficial(); return send(res, 200, { report: rep, names: namesInfo(), clashes: clashes(), official: officialInfo(), portal: { linked: !!portalLink(), ...reportState } }); }
    if (p === '/api/portal-app' && req.method === 'POST') {       // put an installed app on the JoolzApp Store (or hide its tile again)
      let b; try { b = JSON.parse((await body(req)) || '{}'); } catch { return send(res, 400, { message: 'Bad request.' }); }
      const a = monitor.last && monitor.last.apps.find((x) => x.id === b.appId);
      if (!a) return send(res, 404, { message: 'That app is not in the latest check.' });
      if (a.joolzapp) return send(res, 400, { message: 'That is a JoolzApp app: it gets its tile by itself (owner-only tools live in the Admin folder).' });
      try {
        if (b.add === false) await portalCall('portalApps.remove', [slugOf(a.id)]);
        else {
          const want = String(b.route || ''), order = ['public', 'name', 'tailscale', 'lan', 'local'], open = (k) => { const x = a.routes.find((r) => r.key === k); return x && x.openUrl || ''; };
          const url = want ? open(want) : order.map(open).find(Boolean);
          if (!url) return send(res, 400, { message: 'No address people can open. Add your tailnet name or Tailscale address in Settings first.' });
          await portalCall('portalApps.add', [{ id: a.id, name: String(b.name || '').slice(0, 60) || a.name, description: String(b.description || '').slice(0, 200), url, audience: b.audience === 'all' ? 'all' : 'admins' }]);
        }
      } catch (e) { return send(res, e.status >= 400 && e.status < 600 ? e.status : 502, { message: String(e.message || e) }); }
      await refreshTiles(); const rep = mark(monitor.last); await sendToPortal(rep); return send(res, 200, { report: rep, tsd: tsdInfo(), portal: { linked: !!portalLink(), ...reportState } });
    }
    if (p === '/api/tsdproxy' && req.method === 'GET') return send(res, 200, tsdInfo());
    if (p === '/api/tsdproxy/restart' && req.method === 'POST') {   // Restart TSDProxy now: the marker is dated past Services Manager's 30 s wait, so its next check restarts it
      try { fs.writeFileSync(path.join(TSD_DIR, 'restart-tsdproxy'), new Date(Date.now() - 31000).toISOString() + '\n'); return send(res, 200, { ok: true }); }
      catch { return send(res, 500, { message: 'Could not write the restart request to the TSDProxy folder.' }); }
    }
    if (p === '/api/names' && req.method === 'GET') return send(res, 200, namesInfo());
    if (p === '/api/names' && req.method === 'POST') {       // create, rename, remove or auto: the names Port Master keeps in TSDProxy's list
      let b; try { b = JSON.parse((await body(req)) || '{}'); } catch { return send(res, 400, { message: 'Bad request.' }); }
      const apps = monitor.last ? monitor.last.apps : [], op = String(b.op || ''), id = String(b.appId || ''), owned = { ...(config.names || {}) }, opts = { ...(config.nameOpts || {}) };
      try {
        if (op === 'create' || op === 'rename') {
          const a = apps.find((x) => x.id === id); if (!a) return send(res, 404, { message: 'That app is not in the latest check.' });
          if (op === 'create' && a.tsdName) return send(res, 400, { message: (a.name || a.id) + ' already has the name ' + a.tsdName + '.' });
          if (config.noNames) { delete config.noNames[id]; if (!Object.keys(config.noNames).length) delete config.noNames; }
          owned[id] = names.validate(apps, id, b.name !== undefined && String(b.name).trim() ? b.name : names.suggest(apps, id));
          const sd = names.seedFor(id), o = { ...(opts[id] || (op === 'create' && sd ? { port: sd.port, funnel: sd.funnel } : {})) };
          if (b.funnel !== undefined) o.funnel = !!b.funnel; else if (op === 'create' && sd) o.funnel = sd.funnel;
          if (o.port || o.funnel) opts[id] = o; else delete opts[id];
        } else if (op === 'remove') { if (!owned[id]) return send(res, 404, { message: 'Port Master did not give that app a name.' }); delete owned[id]; delete opts[id]; config.noNames = { ...(config.noNames || {}), [id]: true }; }   // removed by hand: automatic naming leaves it alone
        else if (op === 'create-all') { delete config.noNames; apps.forEach((a) => { if (!a.tsdName && !owned[a.id]) { const n = names.suggest(apps, a.id), sd = names.seedFor(a.id); if (n) { owned[a.id] = n; if (sd) opts[a.id] = { port: sd.port, funnel: sd.funnel }; } } }); }
        else if (op === 'auto') config.autoNames = !!b.on;
        else return send(res, 400, { message: 'Unknown change.' });
      } catch (e) { return send(res, e.status || 400, { message: e.message }); }
      if (Object.keys(owned).length) config.names = owned; else delete config.names; if (Object.keys(opts).length) config.nameOpts = opts; else delete config.nameOpts; config.namesAdopted = true; saveConfig();
      const rep = await checkNow(); return send(res, 200, { report: rep, names: namesInfo(), tsd: tsdInfo(), portal: { linked: !!portalLink(), ...reportState } });
    }
    if ((p === '/api/route' || p === '/api/proxy') && req.method === 'POST') {       // a tick (route) or a proxy button: turn a route on or off for real where it can be, else just stop counting it
      let b; try { b = JSON.parse((await body(req)) || '{}'); } catch { return send(res, 400, { message: 'Bad request.' }); }
      const proxyName = p === '/api/proxy' ? String(b.name || '').toLowerCase() : (() => { const a = monitor.last && monitor.last.apps.find((x) => x.id === b.appId && x.routes.some((r) => r.key === b.route)); return a && (b.route === 'name' || b.route === 'public') ? a.tsdName : ''; })();
      if (proxyName) {
        if (!knownProxies().has(proxyName)) return send(res, 404, { message: 'TSDProxy has no proxy called ' + proxyName + '.' });
        if (b.enabled === false || b.paused === true) paused.add(proxyName); else paused.delete(proxyName);
        savePaused(); const rep = mark(monitor.last); await sendToPortal(rep); return send(res, 200, { report: rep, tsd: tsdInfo(), portal: { linked: !!portalLink(), ...reportState } });
      }
      if (p === '/api/proxy') return send(res, 404, { message: 'Unknown proxy.' });
      const k = String(b.appId || '') + '|' + String(b.route || '');
      if (!monitor.last || !monitor.last.apps.some((a) => a.id === b.appId && a.routes.some((x) => x.key === b.route))) return send(res, 404, { message: 'That route is not in the latest check.' });
      if (b.enabled === false) ignored.add(k); else ignored.delete(k);
      saveConfig(); const rep = mark(monitor.last); await sendToPortal(rep); return send(res, 200, { report: rep, tsd: tsdInfo(), portal: { linked: !!portalLink(), ...reportState } });
    }
    if (p === '/api/ignore' && req.method === 'POST') {
      let b; try { b = JSON.parse((await body(req)) || '{}'); } catch { return send(res, 400, { message: 'Bad request.' }); }
      const k = String(b.appId || '') + '|' + String(b.route || '');
      if (!monitor.last || !monitor.last.apps.some((a) => a.id === b.appId && a.routes.some((x) => x.key === b.route))) return send(res, 404, { message: 'That route is not in the latest check.' });
      if (b.ignore) ignored.add(k); else ignored.delete(k);
      saveConfig(); const rep = mark(monitor.last); await sendToPortal(rep); return send(res, 200, { report: rep, portal: { linked: !!portalLink(), ...reportState } });
    }
    if (p === '/api/recheck' && req.method === 'POST') {       // Fix helper: probe one route now, then tell Portal Admin
      let b; try { b = JSON.parse((await body(req)) || '{}'); } catch { return send(res, 400, { message: 'Bad request.' }); }
      try { await monitor.recheck(String(b.appId || ''), String(b.route || '')); } catch (e) { return send(res, e.status || 500, { message: e.message }); }
      const rep = mark(monitor.last); await sendToPortal(rep); return send(res, 200, { report: rep, portal: { linked: !!portalLink(), ...reportState } });
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
