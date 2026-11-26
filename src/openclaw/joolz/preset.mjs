// Writes the access settings JoolzApp wants into OpenClaw's config on every start, so the gateway is reachable the way the owner's devices reach it:
//   https://<TS_NAME>.<TAILNET>          the Tailscale name (TSDProxy ends the TLS, the browser's WebSocket is wss://<same name>)
//   http://<TAILSCALE_IP>:<APP_PORT>     the Tailscale address (ws://)
//   http://<LAN_HOST>:<APP_PORT>         the Umbrel's own address on the home network
// Only the keys named in `owned()` are set; everything else in openclaw.json (agents, channels, models...) is left exactly as the owner or the app wrote it.
// It also creates the gateway token once (kept in the state folder, never in the image or the repository).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { createRequire } from 'node:module';

const list = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
const host = (s) => String(s || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/.]+$/, '');

// The networks this container is attached to (its own Docker network, where Umbrel's app proxy lives), as network/prefix. Docker hands out 172.x, then 192.168.x
// and other ranges as an Umbrel gets more apps, so these are read from the container instead of guessed.
export function ownNetworks(ifaces = os.networkInterfaces()) {
  const out = [];
  for (const list of Object.values(ifaces || {})) for (const a of list || []) {
    if (a.internal || !(a.family === 'IPv4' || a.family === 4) || !a.netmask) continue;
    const ip = a.address.split('.').map(Number), m = a.netmask.split('.').map(Number);
    const prefix = m.reduce((n, o) => n + o.toString(2).replace(/0/g, '').length, 0);
    if (prefix < 8) continue;   // never trust something as wide as a /7
    out.push(ip.map((o, i) => o & m[i]).join('.') + '/' + prefix);
  }
  return [...new Set(out)];
}

export function settings(env, ifaces) {
  const port = String(env.APP_PORT || '3927');
  const tailnet = host(env.TAILNET), name = host(env.TS_NAME || 'openclaw'), ip = host(env.TAILSCALE_IP), lan = host(env.LAN_HOST || 'umbrel.local');
  const publicOrigin = tailnet ? `https://${name}.${tailnet}` : '';
  const origins = [
    publicOrigin,
    ip && `http://${ip}:${port}`,
    lan && `http://${lan}:${port}`,
    `http://localhost:${port}`, `http://127.0.0.1:${port}`,
    ...list(env.EXTRA_ORIGINS),
  ].filter(Boolean);
  return {
    publicOrigin,
    // Umbrel's app proxy (which TSDProxy and the app's port 3927 both go through) reaches us over this container's own network, and nothing else can: the gateway's port is not
    // published on the host. TRUSTED_PROXIES adds more. Tailnet-only, never Funnel.
    trustedProxies: [...new Set([...ownNetworks(ifaces), ...list(env.TRUSTED_PROXIES)])],
    allowedOrigins: [...new Set(origins)],
  };
}

// Applies the owned keys to a parsed config object and reports whether anything changed.
export function apply(cfg, s) {
  const next = structuredClone(cfg && typeof cfg === 'object' ? cfg : {});
  const g = (next.gateway = next.gateway && typeof next.gateway === 'object' ? next.gateway : {});
  const ui = (g.controlUi = g.controlUi && typeof g.controlUi === 'object' ? g.controlUi : {});
  const ts = (g.tailscale = g.tailscale && typeof g.tailscale === 'object' ? g.tailscale : {});
  g.mode = 'local';
  g.bind = 'lan';            // 0.0.0.0 inside the container: Umbrel's app proxy and TSDProxy reach it over the Docker network
  g.port = 18789;
  if (s.publicOrigin) g.publicOrigin = s.publicOrigin; else delete g.publicOrigin;
  g.trustedProxies = s.trustedProxies;
  ui.allowedOrigins = s.allowedOrigins;
  ts.mode = 'off';           // the Tailscale name is TSDProxy's job (Port Master / Portal Admin), never OpenClaw's own Serve/Funnel
  return { next, changed: JSON.stringify(next) !== JSON.stringify(cfg || {}) };
}

function parse(text, file) {
  try { return JSON.parse(text); } catch {}
  try { return createRequire('/app/package.json')('json5').parse(text); } catch {}
  throw new Error(`${file} is not valid JSON/JSON5, so the Tailscale access settings were NOT written. Fix or delete it and restart.`);
}

export function main(env = process.env) {
  const state = env.OPENCLAW_STATE_DIR || '/data/state';
  const file = env.OPENCLAW_CONFIG_PATH || path.join(state, 'openclaw.json');
  fs.mkdirSync(state, { recursive: true, mode: 0o700 });
  const tokenFile = path.join(state, 'joolz-gateway-token');
  if (!fs.existsSync(tokenFile) || !fs.readFileSync(tokenFile, 'utf8').trim()) fs.writeFileSync(tokenFile, crypto.randomBytes(32).toString('hex') + '\n', { mode: 0o600 });
  let cfg = {};
  if (fs.existsSync(file)) cfg = parse(fs.readFileSync(file, 'utf8'), file);
  const s = settings(env), { next, changed } = apply(cfg, s);
  if (changed || !fs.existsSync(file)) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
  console.log(`[joolz] gateway access: ${s.allowedOrigins.join(', ')}${s.publicOrigin ? '' : ' (TAILNET not set: no public name)'}`);
  return { file, settings: s, changed };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { main(); } catch (e) { console.error('[joolz] ' + e.message); process.exit(1); }
}
