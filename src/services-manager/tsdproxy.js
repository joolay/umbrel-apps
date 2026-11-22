'use strict';
// TSDProxy keeper (Services Manager). TSDProxy is not an Umbrel App Store app (it is set up once with deploy/tsdproxy), so nothing else watches or updates it.
// This module, which lives here because Services Manager owns the Docker socket, does four small jobs and reports them in ONE file other apps can read:
//   1. API key: asks TSDProxy for an API key once (apiKeyFile in tsdproxy.yaml, then one TSDProxy restart) so the other jobs can use its REST API.
//   2. Pause / resume: Port Master writes the proxies it wants switched off to joolz-paused.json; this keeps TSDProxy in that state (pause closes the listeners,
//      Public and Tailscale name both stop answering; resume brings them back). A TSDProxy restart forgets a pause, so the state is re-applied every 15 s.
//   3. Version: reads TSDProxy's version and image, checks the registry for a newer image about every 12 hours (a pull, which is also what makes it ready to install).
//   4. Update: when a newer image is ready, replaces the TSDProxy container with one made from it (same settings, volumes, networks and labels, Watchtower style) in the
//      nightly window, or on "Update now". If the new container does not stay up, the old one is put back.
// Files in TSDProxy's settings folder: tsdproxy-status.json (written here, read by Port Master and App Updater), joolz-paused.json (written by Port Master),
// tsdproxy-settings.json and tsdproxy-update-request (written by App Updater), tsdproxy-api.key (written here, mode 0600), tsdproxy-managed.json (proxies this paused).
const fs = require('fs'), path = require('path'), http = require('http'), crypto = require('crypto');

const F = { status: 'tsdproxy-status.json', paused: 'joolz-paused.json', settings: 'tsdproxy-settings.json', request: 'tsdproxy-update-request', key: 'tsdproxy-api.key', managed: 'tsdproxy-managed.json', yaml: 'tsdproxy.yaml' };
const DEFAULT_SETTINGS = { autoUpdate: true, time: '03:30' };
const CHECK_EVERY_MS = 12 * 3600e3, WINDOW_MIN = 60, REQUEST_STALE_MS = 24 * 3600e3;

/* ---------- pure helpers (tested) ---------- */
const nameOf = (p) => String((p && (p.name || p.Name || p.hostname || p.Hostname)) || '').toLowerCase();
const statusOf = (p) => String((p && (p.status || p.Status || p.state || p.State)) || '');
const isPaused = (s) => /paus/i.test(String(s || ''));
// The proxy list may be a bare array, {proxies:[...]} or an object keyed by name.
function listProxies(json) {
  let a = Array.isArray(json) ? json : json && Array.isArray(json.proxies) ? json.proxies : json && typeof json === 'object' ? Object.entries(json).map(([k, v]) => (v && typeof v === 'object' ? { name: k, ...v } : null)).filter(Boolean) : [];
  return a.map((p) => ({ name: nameOf(p), status: statusOf(p), paused: isPaused(statusOf(p)) })).filter((p) => p.name);
}
const hasKeyLine = (yaml) => /^(apiKey|apiKeyFile)\s*:\s*\S/m.test(yaml);
const withKeyFile = (yaml) => yaml.replace(/\n*$/, '\n') + '\n# Added by Services Manager: lets it pause/resume proxies and read the version (Port Master, App Updater).\napiKeyFile: "/config/' + F.key + '"\n';
function keyFromYaml(yaml, dir) {
  const f = /^apiKeyFile\s*:\s*["']?([^"'\n#]+?)["']?\s*(#.*)?$/m.exec(yaml), k = /^apiKey\s*:\s*["']?([^"'\n#]+?)["']?\s*(#.*)?$/m.exec(yaml);
  if (f) { try { return fs.readFileSync(path.join(dir, path.basename(f[1].trim())), 'utf8').trim(); } catch { return ''; } }
  return k ? k[1].trim() : '';
}
function splitImage(ref) { const m = /^(.*?)(?::([^/:]+))?$/.exec(ref || ''); return { repo: (m && m[1]) || ref || '', tag: (m && m[2]) || 'latest' }; }
const inWindow = (d, hhmm, minutes = WINDOW_MIN) => { const [h, m] = String(hhmm || '03:30').split(':').map(Number), now = d.getHours() * 60 + d.getMinutes(), s = (h * 60 + m) % 1440; return ((now - s + 1440) % 1440) < minutes; };
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v, mode) => { try { fs.writeFileSync(f + '.tmp', JSON.stringify(v, null, 2), { mode: mode || 0o644 }); fs.renameSync(f + '.tmp', f); } catch (e) { /* folder not writable: the next tick reports it */ } };

// REST call to TSDProxy. Resolves { status, json, text } and never throws (status 0 = could not connect).
function httpApi(base, method, p, key, timeout = 5000) {
  return new Promise((resolve) => {
    let u; try { u = new URL(base + p); } catch { return resolve({ status: 0, error: 'bad address' }); }
    const req = http.request({ hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, method, headers: key ? { authorization: 'Bearer ' + key } : {}, agent: false, timeout }, (res) => {
      const c = []; res.on('data', (x) => c.push(x)); res.on('end', () => { const text = Buffer.concat(c).toString(); let json; try { json = JSON.parse(text); } catch { /* not json */ } resolve({ status: res.statusCode, json, text: text.slice(0, 400) }); });
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'timed out' }); });
    req.on('error', (e) => resolve({ status: 0, error: String(e.code || e.message).slice(0, 80) }));
    req.end();
  });
}

function makeKeeper({ dir, docker, api = httpApi, now = Date.now, selfId = '', log = () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), fixedBases = ['http://host.docker.internal:8088'] }) {
  const p = (k) => path.join(dir, F[k]);
  const S = { base: '', keyReady: false, error: '', checkedAt: 0, pulledId: '', latest: null, lastUpdate: null, restartedForKey: 0, busy: false };

  async function find() {
    const list = await docker('GET', '/containers/json?all=1&filters=' + encodeURIComponent(JSON.stringify({ label: ['com.docker.compose.service=tsdproxy'] })));
    const ids = (Array.isArray(list) ? list : []).filter((c) => /tsdproxy/i.test(c.Image || ''));
    if (ids.length !== 1) throw new Error(ids.length ? 'more than one TSDProxy container found' : 'TSDProxy container not found');
    return docker('GET', '/containers/' + ids[0].Id + '/json');
  }
  async function ensureKey() {
    let yaml; try { yaml = fs.readFileSync(p('yaml'), 'utf8'); } catch { return { key: '', note: "TSDProxy's settings file is not visible here" }; }
    if (hasKeyLine(yaml)) return { key: keyFromYaml(yaml, dir) };
    const key = crypto.randomBytes(24).toString('hex');
    try { fs.writeFileSync(p('key'), key + '\n', { mode: 0o600 }); fs.writeFileSync(p('yaml') + '.bak', yaml, { mode: 0o600 }); fs.writeFileSync(p('yaml'), withKeyFile(yaml)); }
    catch (e) { return { key: '', note: "could not write TSDProxy's settings: " + e.message }; }
    return { key, installed: true };
  }
  // Candidate addresses for the API: the one that worked last, TSDProxy's own address on its Docker network (this container joins that network, which needs the Docker socket),
  // then the host port TSDProxy's compose file publishes on this machine.
  async function candidates(info) {
    const out = [S.base]; const nets = (info && info.NetworkSettings && info.NetworkSettings.Networks) || {}, names = Object.keys(nets).filter((n) => !/^(host|none)$/.test(n));
    for (const n of names) {
      if (selfId) { try { await docker('POST', '/networks/' + encodeURIComponent(n) + '/connect', { Container: selfId }); } catch { /* already connected */ } }
      if (nets[n].IPAddress) out.push('http://' + nets[n].IPAddress + ':8080');
    }
    return [...out, ...fixedBases].filter((b, i, a) => b && a.indexOf(b) === i);
  }
  async function reach(info, key) {
    let last = 'not tried';
    for (const b of await candidates(info)) {
      const r = await api(b, 'GET', '/api/version', key);
      if (r.status === 200) { S.base = b; return { ok: true, base: b, json: r.json }; }
      last = r.status ? (b + ' answered ' + r.status + (r.status === 401 || r.status === 403 ? ' (the API key is not active yet or was refused)' : '')) : (b + ': ' + (r.error || 'no answer'));
    }
    S.base = ''; return { ok: false, error: last };
  }

  // Keep TSDProxy in the state Port Master asked for.
  async function reconcile(key) {
    const want = new Set(((readJson(p('paused'), {}).paused) || []).map((n) => String(n).toLowerCase()));
    const managed = new Set(readJson(p('managed'), []));
    const r = await api(S.base, 'GET', '/api/v1/proxies', key); if (r.status !== 200) return { proxies: [], note: 'could not list proxies (' + (r.status || r.error) + ')' };
    const proxies = listProxies(r.json), done = [];
    for (const px of proxies) {
      if (want.has(px.name) && !px.paused) { const x = await api(S.base, 'POST', '/api/proxy/' + encodeURIComponent(px.name) + '/pause', key); if (x.status === 200) { px.paused = true; px.status = 'Paused'; managed.add(px.name); done.push('paused ' + px.name); } else px.error = 'pause failed (' + (x.status || x.error) + ')'; }
      else if (!want.has(px.name) && px.paused && managed.has(px.name)) { const x = await api(S.base, 'POST', '/api/proxy/' + encodeURIComponent(px.name) + '/resume', key); if (x.status === 200) { px.paused = false; px.status = 'Running'; managed.delete(px.name); done.push('resumed ' + px.name); } else px.error = 'resume failed (' + (x.status || x.error) + ')'; }
    }
    writeJson(p('managed'), [...managed]); done.forEach((d) => log('[tsdproxy] ' + d));
    return { proxies, wanted: [...want] };
  }

  async function checkImage(info, force) {
    if (!force && now() - S.checkedAt < CHECK_EVERY_MS) return;
    const { repo, tag } = splitImage(info.Config.Image), ref = repo + ':' + tag;
    try {
      await docker('POST', '/images/create?fromImage=' + encodeURIComponent(repo) + '&tag=' + encodeURIComponent(tag));
      const im = await docker('GET', '/images/' + ref + '/json');
      S.pulledId = im.Id; S.checkedAt = now();
      S.latest = { checkedAt: S.checkedAt, imageId: String(im.Id || '').slice(7, 19), version: (im.Config && im.Config.Labels && im.Config.Labels['org.opencontainers.image.version']) || '', created: im.Created || '', error: '' };
    } catch (e) { S.checkedAt = now(); S.latest = { ...(S.latest || {}), checkedAt: S.checkedAt, error: 'could not check for a newer image: ' + String(e.message).slice(0, 120) }; }
  }

  // Replace the container with one made from the newly pulled image; put the old one back if the new one does not stay up.
  async function recreate(info) {
    const name = info.Name.replace(/^\//, ''), nets = info.NetworkSettings.Networks || {}, names = Object.keys(nets), first = names[0];
    const body = { ...info.Config, HostConfig: info.HostConfig }; delete body.Hostname;
    if (first) body.NetworkingConfig = { EndpointsConfig: { [first]: { Aliases: (nets[first].Aliases || []).filter((a) => !info.Id.startsWith(a)), ...(nets[first].IPAMConfig ? { IPAMConfig: nets[first].IPAMConfig } : {}) } } };
    const created = await docker('POST', '/containers/create?name=' + encodeURIComponent(name + '-new'), body), nid = created.Id;
    let stopped = false;
    try {
      await docker('POST', '/containers/' + info.Id + '/stop?t=10'); stopped = true;
      await docker('POST', '/containers/' + info.Id + '/rename?name=' + encodeURIComponent(name + '-old'));
      await docker('POST', '/containers/' + nid + '/rename?name=' + encodeURIComponent(name));
      await docker('POST', '/containers/' + nid + '/start');
      for (const n of names.slice(1)) { try { await docker('POST', '/networks/' + encodeURIComponent(n) + '/connect', { Container: nid, EndpointConfig: { Aliases: (nets[n].Aliases || []).filter((a) => !info.Id.startsWith(a)) } }); } catch { /* optional network */ } }
      let ok = false; for (let i = 0; i < 10; i++) { await sleep(2000); const s = (await docker('GET', '/containers/' + nid + '/json')).State || {}; ok = !!s.Running && !s.Restarting; if (!ok) break; }
      if (!ok) throw new Error('the new container did not stay running');
      await docker('DELETE', '/containers/' + info.Id + '?force=1'); return { ok: true };
    } catch (e) {
      try { await docker('DELETE', '/containers/' + nid + '?force=1'); } catch { /* gone */ }
      if (stopped) { try { await docker('POST', '/containers/' + info.Id + '/rename?name=' + encodeURIComponent(name)); await docker('POST', '/containers/' + info.Id + '/start'); } catch (e2) { return { ok: false, message: e.message + '; putting the old one back also failed: ' + e2.message }; } }
      return { ok: false, message: e.message + (stopped ? ' (the old container was put back)' : '') };
    }
  }

  async function tick() {
    if (S.busy) return; S.busy = true;
    const t = now(), settings = { ...DEFAULT_SETTINGS, ...readJson(p('settings'), {}) }, out = { v: 1, at: t, settings: { autoUpdate: !!settings.autoUpdate, time: settings.time } };
    try {
      const info = await find();
      const key = await ensureKey();
      if (key.installed) { await docker('POST', '/containers/' + info.Id + '/restart?t=10'); S.restartedForKey = t; log('[tsdproxy] API key added, TSDProxy restarted'); }
      out.api = { keyReady: !!key.key, note: key.note || '' };
      const imgId = info.Image;
      out.container = { name: info.Name.replace(/^\//, ''), image: info.Config.Image, imageId: String(imgId || '').slice(7, 19), running: !!(info.State && info.State.Running), startedAt: info.State && info.State.StartedAt };
      const im = await docker('GET', '/images/' + imgId).catch(() => null);
      out.container.version = (im && im.Config && im.Config.Labels && im.Config.Labels['org.opencontainers.image.version']) || '';
      out.container.created = (im && im.Created) || '';
      const r = key.key ? await reach(info, key.key) : { ok: false, error: key.note || 'no API key yet' };
      out.api.reachable = r.ok; out.api.via = r.ok ? r.base : ''; out.api.error = r.ok ? '' : r.error;
      if (r.ok) {
        const v = r.json && typeof r.json === 'object' ? r.json : {}; out.api.build = Object.entries(v).filter(([, x]) => typeof x === 'string' || typeof x === 'number').slice(0, 6).map(([k, x]) => k + ': ' + String(x).slice(0, 40)).join(', ');
        out.api.version = String(v.version || v.Version || v.tag || '').slice(0, 40);
        Object.assign(out, await reconcile(key.key));
      }
      await checkImage(info, !!S.forceCheck); S.forceCheck = false;
      const latest = S.latest || null, newer = !!(latest && latest.imageId && latest.imageId !== out.container.imageId);
      out.update = { checkedAt: latest && latest.checkedAt, latestImage: latest && latest.imageId, latestVersion: latest && latest.version, available: newer, error: (latest && latest.error) || '', last: S.lastUpdate };
      // Update: on request now, or automatically inside the nightly window.
      let req = null; try { const txt = fs.readFileSync(p('request'), 'utf8'), age = t - (Date.parse(txt.trim()) || fs.statSync(p('request')).mtimeMs); if (age < REQUEST_STALE_MS) req = txt; fs.unlinkSync(p('request')); } catch { /* none */ }
      if (req) { S.forceCheck = false; await checkImage(info, true); const l2 = S.latest; out.update.available = !!(l2 && l2.imageId && l2.imageId !== out.container.imageId); out.update.latestImage = l2 && l2.imageId; }
      const auto = settings.autoUpdate && inWindow(new Date(t), settings.time) && t - ((S.lastUpdate && S.lastUpdate.at) || 0) > 6 * 3600e3;
      if (out.update.available && (req || auto) && !(S.lastUpdate && !S.lastUpdate.ok && t - S.lastUpdate.at < 6 * 3600e3 && !req)) {
        log('[tsdproxy] updating ' + out.container.image);
        const res = await recreate(info); S.lastUpdate = { at: t, ok: res.ok, message: res.ok ? 'Updated to image ' + out.update.latestImage : res.message, by: req ? 'request' : 'nightly' };
        out.update.last = S.lastUpdate; if (res.ok) { out.update.available = false; S.base = ''; }
      } else if (req) { S.lastUpdate = { at: t, ok: true, message: 'Already up to date', by: 'request' }; out.update.last = S.lastUpdate; }
    } catch (e) { out.error = String(e.message || e).slice(0, 200); }
    finally { S.busy = false; }
    writeJson(p('status'), out); return out;
  }
  return { tick, S };
}
module.exports = { F, nameOf, statusOf, isPaused, listProxies, hasKeyLine, withKeyFile, keyFromYaml, splitImage, inWindow, httpApi, makeKeeper };
