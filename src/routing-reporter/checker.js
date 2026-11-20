'use strict';
// Port Master's brain: finds the installed apps (from Umbrel's app-data folder), works out which routes each one should have, and probes them.
// Routes: LAN (http://<umbrel LAN address>:<port>), .local (http://umbrel.local:<port>, the mDNS name: it can break while the LAN address still works), Tailscale (http://<tailscale IP>:<port>), Tailscale name (https://<name>.<tailnet>, for apps TSDProxy publishes
// inside the tailnet only) and Public (https://<name>.<tailnet> when TSDProxy publishes the app with Funnel). A route is "up" if the app answers at all
// (even a sign-in page or a redirect); a refused connection, a timeout or a 5xx answer (bad gateway: the app behind it is down) is "down".
// Probes run from inside the Umbrel, so Public means "the Funnel address answers from here"; a break outside your network is not visible from the server.
const fs = require('fs'), path = require('path'), dns = require('dns'), dgram = require('dgram');

const field = (text, key) => { const m = new RegExp('^' + key + ':\\s*(.+?)\\s*$', 'm').exec(text); return m ? m[1].replace(/^(["'])(.*)\1$/, '$2') : ''; };
function parseManifest(text) {
  const port = parseInt(field(text, 'port'), 10);
  return { id: field(text, 'id'), name: field(text, 'name'), version: field(text, 'version'), port: port > 0 && port < 65536 ? port : 0 };
}
// TSDProxy labels: tsdproxy.enable, tsdproxy.name and tsdproxy.port.N ("443/https:3916/http, no_autodetect, tailscale_funnel" = public).
function parseCompose(text) {
  const lab = (k) => { const m = new RegExp('tsdproxy\\.' + k + ':\\s*["\']?([^"\'\\n]*)', 'i').exec(text); return m ? m[1].trim() : ''; };
  const enabled = /tsdproxy\.enable:\s*["']?true/i.test(text), name = lab('name'), funnel = /tsdproxy\.port\.\d+:[^\n]*tailscale_funnel/i.test(text);
  // Host ports the app publishes itself ("3916:3915", optionally with an address or /tcp): what could clash with another app's port.
  const hostPorts = []; for (const m of text.matchAll(/^\s*-\s*["']?(?:[\d.]+:)?(\d{2,5}):\d{2,5}(?:\/(?:tcp|udp))?["']?\s*$/gim)) { const n = Number(m[1]); if (n < 65536 && !hostPorts.includes(n)) hostPorts.push(n); }
  return { tsdproxy: enabled && /^[a-z0-9-]{1,63}$/i.test(name) ? { name: name.toLowerCase(), funnel } : null, hostPorts };
}

// ---- .local (mDNS) names ----
// The .local name is found by multicast DNS, not by the normal resolver, so it can fail while the LAN address still works (Avahi stopped on the Umbrel, multicast blocked,
// a name clash). We ask the system resolver first and then ask the network directly with a one-shot mDNS query, so a failure here means the NAME is the problem.
function mdnsQuery(host) {
  const parts = host.split('.'), b = [0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0];
  for (const l of parts) { b.push(l.length); for (const c of Buffer.from(l)) b.push(c); }
  b.push(0, 0, 1, 0x80, 1);                      // type A, class IN with the "unicast reply" bit
  return Buffer.from(b);
}
function readName(buf, off) {                    // -> [lowercase name, offset after it]
  const out = []; let next = -1, guard = 0;
  while (off < buf.length && guard++ < 40) {
    const n = buf[off];
    if (n === 0) { off++; break; }
    if ((n & 0xc0) === 0xc0) { if (next < 0) next = off + 2; off = ((n & 0x3f) << 8) | buf[off + 1]; continue; }
    out.push(buf.toString('latin1', off + 1, off + 1 + n)); off += 1 + n;
  }
  return [out.join('.').toLowerCase(), next < 0 ? off : next];
}
function mdnsParse(buf, host) {                  // -> IPv4 string for `host`, or ''
  if (buf.length < 12) return '';
  let off = 12; const qd = buf.readUInt16BE(4), an = buf.readUInt16BE(6) + buf.readUInt16BE(8) + buf.readUInt16BE(10);
  for (let i = 0; i < qd; i++) { off = readName(buf, off)[1] + 4; }
  for (let i = 0; i < an && off + 10 <= buf.length; i++) {
    const [name, o] = readName(buf, off), type = buf.readUInt16BE(o), len = buf.readUInt16BE(o + 8); off = o + 10;
    if (type === 1 && len === 4 && name === host.toLowerCase() && off + 4 <= buf.length) return [...buf.subarray(off, off + 4)].join('.');
    off += len;
  }
  return '';
}
function mdnsResolve(host, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4'); let done = false;
    const end = (ip) => { if (!done) { done = true; clearTimeout(t); try { sock.close(); } catch { /* already closed */ } resolve(ip); } };
    const t = setTimeout(() => end(''), timeoutMs);
    sock.on('error', () => end('')); sock.on('message', (m) => { const ip = mdnsParse(m, host); if (ip) end(ip); });
    try { sock.bind(0, () => sock.send(mdnsQuery(host), 5353, '224.0.0.251', (e) => { if (e) end(''); })); } catch { end(''); }
  });
}
function resolveLocal(host) {
  return new Promise((resolve) => dns.lookup(host, { family: 4 }, (e, a) => (!e && a ? resolve(a) : mdnsResolve(host).then(resolve))));
}
function discover(dir) {
  const out = [];
  let names = []; try { names = fs.readdirSync(dir); } catch { return out; }
  for (const d of names.sort()) {
    let man; try { man = parseManifest(fs.readFileSync(path.join(dir, d, 'umbrel-app.yml'), 'utf8')); } catch { continue; }
    if (!man.id || !man.port) continue;
    let comp = { tsdproxy: null, hostPorts: [] }; try { comp = parseCompose(fs.readFileSync(path.join(dir, d, 'docker-compose.yml'), 'utf8')); } catch { /* no compose: LAN and Tailscale only */ }
    out.push({ ...man, joolzapp: /^joolay-/.test(man.id), tsdproxy: comp.tsdproxy, hostPorts: comp.hostPorts });
  }
  return out;
}
// cfg: { lanHost, tailscaleIp, tailnet }  ->  [{ key, label, url }] (a route with nothing to test is left out; see skipped for why)
function routesFor(app, cfg) {
  const r = [];
  if (cfg.lanHost) r.push({ key: 'lan', label: 'LAN', url: `http://${cfg.lanHost}:${app.port}/` });
  if (cfg.localHost) r.push({ key: 'local', label: '.local', url: `http://${cfg.localHost}:${app.port}/` });
  if (cfg.tailscaleIp) r.push({ key: 'tailscale', label: 'Tailscale', url: `http://${cfg.tailscaleIp}:${app.port}/` });
  if (app.tsdproxy && cfg.tailnet) {
    const url = `https://${app.tsdproxy.name}.${cfg.tailnet}/`;
    r.push(app.tsdproxy.funnel ? { key: 'public', label: 'Public', url } : { key: 'name', label: 'Tailscale name', url });
  }
  return r;
}
const FRIENDLY = { ECONNREFUSED: 'connection refused (nothing listening)', ETIMEDOUT: 'timed out', UND_ERR_CONNECT_TIMEOUT: 'timed out', EHOSTUNREACH: 'host unreachable', ENETUNREACH: 'network unreachable', ENOTFOUND: 'name not found (DNS)', LOCALNAME: 'the .local name did not resolve (mDNS/Avahi), the IP address may still work', ECONNRESET: 'connection reset', CERT_HAS_EXPIRED: 'certificate expired', DEPTH_ZERO_SELF_SIGNED_CERT: 'certificate not trusted', UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'certificate not trusted' };
// A fresh connection every time (agent: false), so a pooled keep-alive connection can never make a dead app look alive.
async function probe(url, { timeoutMs = 8000, now = Date.now, resolver = resolveLocal } = {}) {
  const t0 = now(), mod = /^https:/i.test(url) ? require('https') : require('http');
  let headers = { 'user-agent': 'routing-reporter', connection: 'close' };
  const u = (() => { try { return new URL(url); } catch { return null; } })();
  if (u && /\.local$/i.test(u.hostname)) {          // a .local name: resolve it ourselves, then connect to the address it gave
    const ip = await resolver(u.hostname);
    if (!ip) return { ms: now() - t0, ok: false, status: 0, error: FRIENDLY.LOCALNAME };
    headers = { ...headers, host: u.host }; u.hostname = ip; url = u.toString();
  }
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve({ ms: now() - t0, ...r }); } };
    const fail = (e, timedOut) => { const code = e && e.code || ''; finish({ ok: false, status: 0, error: timedOut ? 'timed out' : FRIENDLY[code] || String((e && e.message) || 'failed').slice(0, 120) }); };
    let req;
    try { req = mod.request(url, { method: 'GET', agent: false, timeout: timeoutMs, headers }, (res) => {
      res.resume(); const st = res.statusCode || 0;
      if (st >= 500) finish({ ok: false, status: st, error: st === 502 || st === 503 || st === 504 ? 'the app behind it is not answering (' + st + ')' : 'server error ' + st });
      else finish({ ok: true, status: st, error: '' });
      req.destroy();
    }); } catch (e) { return fail(e); }
    req.on('timeout', () => { fail(null, true); req.destroy(); });
    req.on('error', (e) => fail(e));
    req.end();
  });
}
// Keeps each route's history so one blip is not reported: a route turns "down" after 2 failed checks in a row and "up" again after one good one.
function makeMonitor({ dir, getConfig, probeImpl = probe, now = Date.now, concurrency = 6 }) {
  const mem = new Map();      // "app:route" -> { state, fails, since }
  let last = null, running = null;
  async function run() {
    const cfg = getConfig(), apps = discover(dir), jobs = [];
    const out = apps.map((a) => ({ id: a.id, name: a.name, version: a.version, port: a.port, hostPorts: a.hostPorts || [], joolzapp: a.joolzapp, published: a.tsdproxy ? (a.tsdproxy.funnel ? 'public' : 'tailnet') : '', routes: [] }));
    apps.forEach((a, i) => { for (const r of routesFor(a, cfg)) jobs.push({ i, r }); });
    let next = 0;
    await Promise.all(new Array(Math.min(concurrency, jobs.length || 1)).fill(0).map(async () => {
      while (next < jobs.length) {
        const j = jobs[next++], res = await probeImpl(j.r.url, { now }), k = out[j.i].id + ':' + j.r.key, t = now();
        let m = mem.get(k) || { state: 'unknown', fails: 0, since: t };
        if (res.ok) { m.fails = 0; if (m.state !== 'up') { m.state = 'up'; m.since = t; } }
        else { m.fails++; if (m.fails >= 2 && m.state !== 'down') { m.state = 'down'; m.since = t; } }
        mem.set(k, m);
        out[j.i].routes.push({ key: j.r.key, label: j.r.label, url: j.r.url, state: m.state === 'unknown' ? (res.ok ? 'up' : 'checking') : m.state === 'up' && !res.ok ? 'up' : m.state, status: res.status, ms: res.ms, error: res.ok ? '' : res.error, since: m.since, checkedAt: t });
      }
    }));
    const ORDER = { lan: 0, local: 1, tailscale: 2, name: 3, public: 4 };
    for (const a of out) a.routes.sort((x, y) => ORDER[x.key] - ORDER[y.key]);
    last = { v: 1, at: now(), config: { lanHost: cfg.lanHost || '', localHost: cfg.localHost || '', tailscaleIp: cfg.tailscaleIp || '', tailnet: cfg.tailnet || '' }, intervalMin: cfg.intervalMin, apps: out };
    return last;
  }
  return { run: () => (running = running || run().finally(() => { running = null; })), get last() { return last; } };
}
module.exports = { mdnsQuery, mdnsParse, resolveLocal, parseManifest, parseCompose, discover, routesFor, probe, makeMonitor };
