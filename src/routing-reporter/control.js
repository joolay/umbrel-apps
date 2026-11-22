'use strict';
// Route switches. A tick can switch a route off in two ways:
//  - Public and Tailscale-name routes belong to a TSDProxy proxy; "off" means that proxy is PAUSED (Services Manager's TSDProxy keeper does it; see
//    src/services-manager/tsdproxy.js). A proxy has one switch, so its Tailscale-name and Public routes go together.
//  - LAN, .local and Tailscale-address routes cannot be switched off from here (they reach the app's own port), so "off" only means Port Master stops counting them as a problem (Disable).
// The wish is kept in Port Master's own settings (config.pausedProxies) and mirrored to joolz-paused.json in TSDProxy's folder, where the keeper reads it.
const PROXY_KEYS = new Set(['name', 'public']);
const fresh = (tsd, now) => !!(tsd && tsd.at && now - tsd.at < 90e3);
const proxyOf = (tsd, name) => (tsd && Array.isArray(tsd.proxies) ? tsd.proxies.find((p) => p.name === name) : null);

// report -> report with ignored/paused/control filled in for every route.
function applyControl(r, { ignored, paused, tsd, now = Date.now() }) {
  if (!r) return r;
  const live = fresh(tsd, now), controllable = !!(live && tsd.api && tsd.api.reachable);
  return { ...r, apps: r.apps.map((a) => ({ ...a, routes: a.routes.map((x) => {
    const wantPaused = PROXY_KEYS.has(x.key) && !!a.tsdName && paused.has(a.tsdName), px = wantPaused || PROXY_KEYS.has(x.key) ? proxyOf(tsd, a.tsdName) : null;
    const out = { ...x, ignored: ignored.has(a.id + '|' + x.key) || wantPaused };
    if (PROXY_KEYS.has(x.key) && a.tsdName) {
      out.switch = 'proxy'; out.proxy = a.tsdName;
      if (wantPaused) out.control = controllable ? (px && px.paused ? 'paused' : 'pending') : 'waiting';       // paused | pending (asked, not yet applied) | waiting (TSDProxy control not reachable)
      else out.control = px && px.paused ? 'resuming' : 'on';
    } else out.switch = 'monitor';
    return out;
  }) })) };
}
// The names to hand to the keeper: only proxies that exist on this server, lowercase, no duplicates.
const cleanPaused = (list, known) => [...new Set((Array.isArray(list) ? list : []).map((n) => String(n).toLowerCase()).filter((n) => /^[a-z0-9-]{1,63}$/.test(n) && (!known || known.has(n))))].sort();
module.exports = { applyControl, cleanPaused, fresh, proxyOf, PROXY_KEYS };
