'use strict';
// App Updater backend. Node built-ins only. It talks to umbreld's tRPC API (the same API the umbrelOS
// dashboard uses) to find apps with a newer version in their store and to update the ones you chose.
// It deliberately has no Docker socket, no PocketBase and no npm dependencies, so it rarely needs changing.

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || '/data';
const PUBLIC_DIR = path.join(__dirname, 'public');
const SELF_APP_ID = 'joolay-app-updater';

const UMBREL_CANDIDATES = [
  process.env.UMBREL_URL,
  'http://host.docker.internal',
  process.env.DEVICE_DOMAIN_NAME && 'http://' + process.env.DEVICE_DOMAIN_NAME,
  'http://umbrel.local',
  'http://172.17.0.1',
].filter(Boolean);

const MODES = new Set(['off', 'nightly', 'immediate']);
const FAIL_BACKOFF_MS = 30 * 60 * 1000;
const NIGHTLY_WINDOW_MIN = 60;

/* ------------------------------ persistence ------------------------------ */

const SESSION_FILE = path.join(DATA_DIR, 'session.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const LOG_FILE = path.join(DATA_DIR, 'log.json');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, value, mode) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2), { mode: mode || 0o644 });
  } catch (err) {
    console.error('Could not write', file, err.message);
  }
}

const DEFAULTS = {
  apps: {},                    // { appId: 'off' | 'nightly' | 'immediate' }
  nightlyTime: '03:00',        // 24-hour, in `timezone`
  timezone: '',                // seeded from the browser the first time the page opens
  quiet: { enabled: false, start: '22:00', end: '06:00' }, // "Immediately" apps wait while this is active
  paused: false,
  pollSeconds: 60,
  ticker: { enabled: false },  // announce finished updates in the JoolzApp dashboard news ticker (everyone sees it)
  groupOpen: {},               // { storeId: true | false } expanded/collapsed state of each store group
  seen: {},                    // { appId: lastAnnouncedVersion }
};
const settings = Object.assign({}, DEFAULTS, readJson(SETTINGS_FILE, {}));
settings.quiet = Object.assign({}, DEFAULTS.quiet, settings.quiet);
settings.ticker = Object.assign({}, DEFAULTS.ticker, settings.ticker);
const saveSettings = () => writeJson(SETTINGS_FILE, settings);

// session.json holds the umbrelOS session token. When "stay connected" is chosen it also holds the
// password (file mode 0600, only readable inside this app's data folder) so the app can sign in again
// by itself when the session expires, which is what makes unattended updates possible.
const umbrel = Object.assign({ base: null, token: null, cookie: '', password: '', error: null }, readJson(SESSION_FILE, {}));
function saveSession() {
  if (umbrel.token || umbrel.password) {
    writeJson(SESSION_FILE, { base: umbrel.base, token: umbrel.token, cookie: umbrel.cookie, password: umbrel.password || '' }, 0o600);
  } else { try { fs.unlinkSync(SESSION_FILE); } catch { /* none */ } }
}

let log = readJson(LOG_FILE, []);
function addLog(level, message, appId) {
  log.push({ t: Date.now(), level, appId: appId || null, message });
  if (log.length > 300) log = log.slice(-200);
  writeJson(LOG_FILE, log);
}

/* ------------------------------ umbrelOS client --------------------------- */

function rawRequest(urlStr, { method = 'GET', headers = {}, body = null, timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const h = Object.assign({}, headers);
    if (body !== null) {
      h['Content-Type'] = 'application/json';
      h['Content-Length'] = Buffer.byteLength(body);
    }
    const req = http.request({ hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, method, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => req.destroy(new Error('timeout')));
    if (body !== null) req.write(body);
    req.end();
  });
}

function parseTrpc(res) {
  let json;
  try { json = JSON.parse(res.text); } catch { return { reachable: false }; }
  if (json && json.result) return { reachable: true, data: json.result.data !== undefined ? json.result.data : json.result };
  const err = json && (json.error || (Array.isArray(json) && json[0] && json[0].error));
  if (err) {
    const e = err.json || err;
    return { reachable: true, error: e.message || 'umbrelOS error', code: (e.data && e.data.code) || e.code };
  }
  return { reachable: false };
}

async function trpc(base, proc, type, input, timeout) {
  const headers = {};
  if (umbrel.token) headers.Authorization = 'Bearer ' + umbrel.token;
  if (umbrel.cookie) headers.Cookie = umbrel.cookie;
  let url = base + '/trpc/' + proc;
  let res;
  if (type === 'query') {
    if (input !== undefined) url += '?input=' + encodeURIComponent(JSON.stringify(input));
    res = await rawRequest(url, { headers, timeout });
  } else {
    res = await rawRequest(url, { method: 'POST', headers, body: JSON.stringify(input === undefined ? {} : input), timeout });
  }
  const parsed = parseTrpc(res);
  if (!parsed.reachable) throw Object.assign(new Error('umbrelOS did not answer at ' + base), { unreachable: true });
  if (parsed.error) throw Object.assign(new Error(parsed.error), { code: parsed.code });
  return { data: parsed.data, res };
}

const isNetworkError = (err) =>
  err.unreachable || /^(ECONN|ENOTFOUND|EHOST|ENETUNREACH|ETIMEDOUT|EAI_AGAIN)/.test(String(err.code || '')) || err.message === 'timeout';

async function umbrelLogin(password, totpToken) {
  const body = { password };
  if (totpToken) body.totpToken = String(totpToken);
  let lastError = null;
  for (const base of [umbrel.base, ...UMBREL_CANDIDATES].filter((v, i, a) => v && a.indexOf(v) === i)) {
    try {
      const { data, res } = await trpc(base, 'user.login', 'mutation', body, 10000);
      if (typeof data !== 'string') throw new Error('Unexpected login response from umbrelOS');
      const cookies = [].concat(res.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
      Object.assign(umbrel, { base, token: data, cookie: cookies, error: null });
      return;
    } catch (err) {
      if (isNetworkError(err)) { lastError = err; continue; }
      throw Object.assign(err, { status: 401 }); // reachable, but refused (wrong password, 2FA, ...)
    }
  }
  throw Object.assign(
    new Error('Could not reach umbrelOS from inside this container. Tried: ' + UMBREL_CANDIDATES.join(', ') +
      (lastError ? ' (' + lastError.message + ')' : '') + '. Set UMBREL_URL in docker-compose.yml.'),
    { status: 502 }
  );
}

function dropSession(message) {
  umbrel.token = null;
  umbrel.cookie = '';
  umbrel.error = message;
  saveSession();
}

// Sign in again with the stored password (only exists when "stay connected" was chosen).
let relogin = null;
function reconnect() {
  if (!umbrel.password) return Promise.reject(new Error('Session expired, please connect again'));
  if (!relogin) {
    relogin = umbrelLogin(umbrel.password)
      .then(() => { saveSession(); addLog('info', 'Signed in to umbrelOS again automatically'); })
      .catch((err) => {
        dropSession(isNetworkError(err) ? err.message : 'Automatic sign-in failed: ' + err.message);
        throw err;
      })
      .finally(() => { relogin = null; });
  }
  return relogin;
}

async function umbrelCall(proc, type, input, timeout) {
  if (!umbrel.base || (!umbrel.token && !umbrel.password)) throw Object.assign(new Error('Connect to umbrelOS first'), { status: 401 });
  if (!umbrel.token) await reconnect();
  try {
    return (await trpc(umbrel.base, proc, type, input, timeout)).data;
  } catch (err) {
    if (err.code === 'UNAUTHORIZED' || err.code === 'FORBIDDEN') {
      if (umbrel.password) {
        umbrel.token = null;
        await reconnect();
        return (await trpc(umbrel.base, proc, type, input, timeout)).data;
      }
      dropSession('Session expired, please connect again');
      err.status = 401;
    }
    throw err;
  }
}

/* ------------------------------ dashboard ticker -------------------------- */

// Notices go through Portal API (inside Portal Admin), the same way the other JoolzApps talk to it, so this app holds no PocketBase login.
// Portal Admin > Changes writes POCKETBASE_PORTAL_URL and POCKETBASE_PORTAL_KEY into this app's data folder (pocketbase.env);
// the file is re-read on every call, so no restart is needed once it appears.
const PORTAL_ENV = path.join(DATA_DIR, 'pocketbase.env');
function portalConfig() {
  try {
    const kv = {};
    for (const line of fs.readFileSync(PORTAL_ENV, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*(POCKETBASE_PORTAL_(?:URL|KEY))\s*=\s*(.*?)\s*$/);
      if (m) kv[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2');
    }
    return kv.POCKETBASE_PORTAL_URL && kv.POCKETBASE_PORTAL_KEY ? { url: kv.POCKETBASE_PORTAL_URL.replace(/\/+$/, ''), key: kv.POCKETBASE_PORTAL_KEY } : null;
  } catch { return null; }
}

async function portalCall(fn, args) {
  const cfg = portalConfig();
  if (!cfg) throw new Error('not linked to Portal Admin yet (apply "Portal API key for each app" under Portal Admin > Changes)');
  let r;
  try {
    r = await fetch(cfg.url + '/app-api/call', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + cfg.key }, body: JSON.stringify({ fn, args }), signal: AbortSignal.timeout(20000) });
  } catch (e) { throw new Error("can't reach Portal Admin at " + cfg.url + ' (' + ((e.cause && e.cause.code) || e.message) + ')'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || 'Portal API error ' + r.status);
  if (!j.ok) throw new Error(j.message || 'Portal API error');
  return j.result;
}

// "YYYY-MM-DD HH:MM" in the chosen time zone: the form the ticker expects.
function stamp() {
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: settings.timezone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date()).map((x) => [x.type, x.value]));
    return p.year + '-' + p.month + '-' + p.day + ' ' + p.hour + ':' + p.minute;
  } catch { return new Date().toISOString().slice(0, 16).replace('T', ' '); }
}

async function announce(item, from, to) {
  if (!settings.ticker.enabled) return;
  try {
    await portalCall('publishEvent', [{
      title: item.name + ' updated',
      sub: from && to ? 'v' + from + ' → v' + to : to ? 'now v' + to : '',
      kind: 'update',
      start: stamp(),
    }]);
    status.ticker = { at: Date.now(), error: null };
    addLog('info', 'Posted "' + item.name + ' updated" to the dashboard ticker', item.id);
  } catch (err) {
    status.ticker = { at: status.ticker.at, error: err.message };
    addLog('error', 'Could not post to the dashboard ticker: ' + err.message, item.id);
  }
}

/* ------------------------------ update detection -------------------------- */

// Walks whatever umbrelOS returns for the store registry and collects { appId: version }.
// When `stores` is given it also records which store each app came from ({ id, name }).
function collectVersions(node, map, depth, stores, store) {
  if (!node || depth > 6) return map;
  if (Array.isArray(node)) { node.forEach((n) => collectVersions(n, map, depth + 1, stores, store)); return map; }
  if (typeof node === 'object') {
    if (typeof node.id === 'string' && typeof node.version === 'string' && !node.apps) {
      map.set(node.id, node.version);
      if (stores && store) stores.set(node.id, store);
    }
    const here = node.apps && typeof node.id === 'string' ? { id: node.id, name: prettyStore(node.name || node.id) } : store;
    for (const k of ['apps', 'registry']) if (node[k]) collectVersions(node[k], map, depth + 1, stores, here);
  }
  return map;
}
const prettyStore = (v) => String(v).replace(/[-_]+/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());

const clean = (v) => String(v || '').trim().replace(/^v/i, '');
function isNewer(latest, installed) {
  const a = clean(latest).split(/[.+-]/).map((x) => parseInt(x, 10));
  const b = clean(installed).split(/[.+-]/).map((x) => parseInt(x, 10));
  if (a.some(Number.isNaN) || b.some(Number.isNaN)) return clean(latest) !== clean(installed);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0, y = b[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

const status = {
  lastCheck: null, lastError: null, registryProc: null, registryCount: 0, stores: new Map(), ticker: { at: null, error: null }, busy: {}, lastResult: {}, failedAt: {}, detectedAt: {},
};
let installedCache = [];

async function fetchRegistry() {
  for (const proc of ['appStore.registry']) {
    try {
      const data = await umbrelCall(proc, 'query');
      const stores = new Map();
      const map = collectVersions(data, new Map(), 0, stores, null);
      if (map.size) { status.registryProc = proc; status.registryCount = map.size; status.stores = stores; return map; }
    } catch (err) {
      if (err.status === 401) throw err;
    }
  }
  status.registryProc = null;
  status.registryCount = 0;
  return null;
}

async function check() {
  const list = await umbrelCall('apps.list', 'query');
  const installed = (Array.isArray(list) ? list : []).filter((a) => a && a.id && !a.error && a.id !== SELF_APP_ID); // this app never lists or updates itself
  const registry = await fetchRegistry();
  installedCache = installed.map((a) => {
    const latest = registry && registry.get(a.id) ? registry.get(a.id) : null;
    const flagged = typeof a.updateAvailable === 'boolean' ? a.updateAvailable : null; // newer umbrelOS builds may report it directly
    const update = flagged !== null ? flagged : !!(latest && a.version && isNewer(latest, a.version));
    const store = status.stores.get(a.id) || null;
    const item = { id: a.id, name: a.name || a.id, version: a.version || null, latest: latest || null, update, state: a.state || null, store: store || { id: 'other', name: 'Other apps' } };
    if (update) {
      if (!status.detectedAt[a.id] || status.detectedAt[a.id].version !== (latest || '?')) {
        status.detectedAt[a.id] = { version: latest || '?', at: Date.now() };
      }
      if (settings.seen[a.id] !== (latest || '?')) {
        settings.seen[a.id] = latest || '?';
        saveSettings();
        addLog('info', 'Update available: ' + item.name + ' ' + (item.version || '?') + ' → ' + (latest || 'newer version'), a.id);
      }
    } else {
      delete status.detectedAt[a.id];
    }
    return item;
  });
  status.lastCheck = Date.now();
  status.lastError = null;
  return installedCache;
}

/* ------------------------------ time rules -------------------------------- */

function minutesNow(tz) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz || 'UTC', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
    const get = (t) => Number((parts.find((p) => p.type === t) || {}).value || 0);
    return get('hour') * 60 + get('minute');
  } catch {
    const d = new Date();
    return d.getUTCHours() * 60 + d.getUTCMinutes();
  }
}
const toMin = (s) => { const m = /^(\d{1,2}):(\d{2})$/.exec(s || ''); return m ? Math.min(23, +m[1]) * 60 + Math.min(59, +m[2]) : 0; };

function inNightlyWindow() {
  const start = toMin(settings.nightlyTime);
  const diff = (minutesNow(settings.timezone) - start + 1440) % 1440;
  return diff < NIGHTLY_WINDOW_MIN;
}
function inQuietHours() {
  if (!settings.quiet.enabled) return false;
  const now = minutesNow(settings.timezone), s = toMin(settings.quiet.start), e = toMin(settings.quiet.end);
  return s <= e ? now >= s && now < e : now >= s || now < e;
}

function allowedNow(appId) {
  const mode = settings.apps[appId] || 'off';
  if (appId === SELF_APP_ID) return false;          // never restarts itself mid-update
  if (settings.paused || mode === 'off') return false;
  if (status.failedAt[appId] && Date.now() - status.failedAt[appId] < FAIL_BACKOFF_MS) return false;
  if (mode === 'immediate') return !inQuietHours();
  return inNightlyWindow();
}

/* ------------------------------ updating ---------------------------------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let queue = Promise.resolve(); // one app at a time

function updateApp(item, reason) {
  const run = async () => {
    if (status.busy[item.id]) return;
    status.busy[item.id] = true;
    const before = item.version;
    addLog('info', 'Updating ' + item.name + ' (' + reason + ')…', item.id);
    try {
      await umbrelCall('apps.update', 'mutation', { appId: item.id }, 20 * 60 * 1000);
      // umbrelOS may answer before the app is back; wait until it leaves the "updating" state.
      for (let i = 0; i < 90; i++) {
        const list = await umbrelCall('apps.list', 'query');
        const a = (Array.isArray(list) ? list : []).find((x) => x && x.id === item.id);
        if (a && a.state !== 'updating') {
          status.lastResult[item.id] = { ok: true, at: Date.now(), from: before, to: a.version || null };
          addLog('ok', item.name + ' updated' + (a.version ? ' to ' + a.version : '') + ' (state: ' + (a.state || 'unknown') + ')', item.id);
          delete status.failedAt[item.id];
          await announce(item, before, a.version || null);
          await check().catch(() => {});
          return;
        }
        await sleep(10000);
      }
      throw new Error('Still updating after 15 minutes, check the app in umbrelOS');
    } catch (err) {
      status.failedAt[item.id] = Date.now();
      status.lastResult[item.id] = { ok: false, at: Date.now(), error: err.message };
      addLog('error', item.name + ' update failed: ' + err.message, item.id);
    } finally {
      delete status.busy[item.id];
    }
  };
  queue = queue.then(run, run);
  return queue;
}

let ticking = false;
async function tick(force) {
  if (ticking) return;
  ticking = true;
  try {
    if (!umbrel.base || (!umbrel.token && !umbrel.password)) return;
    const items = await check();
    if (settings.paused && !force) return;
    for (const item of items.filter((i) => i.update && allowedNow(i.id) && !status.busy[i.id])) {
      const mode = settings.apps[item.id];
      await updateApp(item, mode === 'immediate' ? 'detected, updating straight away' : 'nightly window');
    }
  } catch (err) {
    status.lastError = err.message;
    if (err.status !== 401) console.error('check failed:', err.message);
  } finally {
    ticking = false;
  }
}

let timer = null;
function schedule() {
  clearTimeout(timer);
  const secs = Math.max(30, Math.min(3600, Number(settings.pollSeconds) || 60));
  timer = setTimeout(async () => { await tick(); schedule(); }, secs * 1000);
  timer.unref();
}

/* ---------------------------------- API ----------------------------------- */

function snapshot() {
  const apps = installedCache.map((a) => ({
    ...a,
    mode: settings.apps[a.id] || 'off',
    busy: !!status.busy[a.id] || a.state === 'updating',
    detectedAt: status.detectedAt[a.id] ? status.detectedAt[a.id].at : null,
    result: status.lastResult[a.id] || null,
    waiting: a.update && !status.busy[a.id] && (settings.apps[a.id] || 'off') !== 'off' && !allowedNow(a.id),
  }));
  apps.sort((a, b) => Number(b.update) - Number(a.update) || a.name.localeCompare(b.name));
  return {
    umbrel: { connected: !!umbrel.token || !!umbrel.password, signedIn: !!umbrel.token, remember: !!umbrel.password, base: umbrel.base, error: umbrel.error },
    settings: { nightlyTime: settings.nightlyTime, timezone: settings.timezone, quiet: settings.quiet, paused: settings.paused, pollSeconds: settings.pollSeconds, groupOpen: settings.groupOpen, ticker: { enabled: settings.ticker.enabled, linked: !!portalConfig(), at: status.ticker.at, error: status.ticker.error } },
    apps,
    check: { at: status.lastCheck, error: status.lastError, registryProc: status.registryProc, registryCount: status.registryCount },
    log: log.slice(-60).reverse(),
    time: Date.now(),
  };
}

async function diagnose() {
  const out = [];
  const probe = async (proc, type, input) => {
    try {
      const data = await umbrelCall(proc, type, input);
      const shape = Array.isArray(data) ? 'array(' + data.length + ')' : data && typeof data === 'object' ? 'object{' + Object.keys(data).slice(0, 8).join(',') + '}' : typeof data;
      out.push({ proc, ok: true, shape });
      return data;
    } catch (err) { out.push({ proc, ok: false, error: err.message }); }
  };
  const apps = await probe('apps.list', 'query');
  if (Array.isArray(apps) && apps[0]) out.push({ proc: 'apps.list item fields', ok: true, shape: Object.keys(apps[0]).join(', ') });
  const reg = await probe('appStore.registry', 'query');
  if (reg) out.push({ proc: 'versions found in registry', ok: true, shape: String(collectVersions(reg, new Map(), 0).size) });
  return out;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

function send(res, status_, payload) {
  res.writeHead(status_, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 65536) { reject(Object.assign(new Error('Body too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}); }
      catch { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

const validTime = (s) => /^([01]?\d|2[0-3]):[0-5]\d$/.test(String(s));
const validZone = (z) => { try { new Intl.DateTimeFormat('en', { timeZone: z }); return true; } catch { return false; } };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/api/state' && req.method === 'GET') return send(res, 200, snapshot());

    if (url.pathname === '/api/umbrel/login' && req.method === 'POST') {
      const { password, totp, remember } = await readBody(req);
      if (!password) throw Object.assign(new Error('Enter your umbrelOS password'), { status: 400 });
      if (remember && totp) throw Object.assign(new Error('Staying connected needs 2FA to be off, because a one-time code cannot be reused. Turn off "Stay connected" or use the code once.'), { status: 400 });
      await umbrelLogin(String(password), totp);
      umbrel.password = remember ? String(password) : '';
      saveSession();
      addLog('info', 'Connected to umbrelOS' + (remember ? ' (staying connected)' : ''));
      tick().then(schedule);
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/api/umbrel/logout' && req.method === 'POST') {
      umbrel.password = '';
      dropSession(null);
      installedCache = [];
      addLog('info', 'Disconnected from umbrelOS');
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/api/mode' && req.method === 'POST') {
      const { appId, mode } = await readBody(req);
      if (!appId || !MODES.has(mode)) throw Object.assign(new Error('Unknown mode'), { status: 400 });
      if (appId === SELF_APP_ID) throw Object.assign(new Error('App Updater cannot update itself. Update it by hand from the App Store.'), { status: 400 });
      if (mode === 'off') delete settings.apps[appId]; else settings.apps[appId] = mode;
      saveSettings();
      if (mode === 'immediate') tick();
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/api/settings' && req.method === 'POST') {
      const b = await readBody(req);
      if (b.nightlyTime !== undefined) { if (!validTime(b.nightlyTime)) throw Object.assign(new Error('Use a time like 03:00'), { status: 400 }); settings.nightlyTime = b.nightlyTime.padStart(5, '0'); }
      if (b.timezone !== undefined) { if (b.timezone && !validZone(b.timezone)) throw Object.assign(new Error('Unknown time zone'), { status: 400 }); settings.timezone = b.timezone; }
      if (b.paused !== undefined) settings.paused = !!b.paused;
      if (b.ticker && b.ticker.enabled !== undefined) settings.ticker.enabled = !!b.ticker.enabled;
      if (b.groupOpen && typeof b.groupOpen.id === 'string' && b.groupOpen.id.length < 80) {
        settings.groupOpen = Object.assign({}, settings.groupOpen, { [b.groupOpen.id]: !!b.groupOpen.open });
      }
      if (b.pollSeconds !== undefined) settings.pollSeconds = Math.max(30, Math.min(3600, Number(b.pollSeconds) || 60));
      if (b.quiet) {
        const q = b.quiet;
        if (q.enabled !== undefined) settings.quiet.enabled = !!q.enabled;
        if (q.start !== undefined) { if (!validTime(q.start)) throw Object.assign(new Error('Use a time like 22:00'), { status: 400 }); settings.quiet.start = q.start.padStart(5, '0'); }
        if (q.end !== undefined) { if (!validTime(q.end)) throw Object.assign(new Error('Use a time like 06:00'), { status: 400 }); settings.quiet.end = q.end.padStart(5, '0'); }
      }
      saveSettings();
      if (b.pollSeconds !== undefined) schedule();
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/api/check' && req.method === 'POST') {
      await check();
      tick();
      return send(res, 200, snapshot());
    }
    if (url.pathname === '/api/update' && req.method === 'POST') {
      const { appId } = await readBody(req);
      if (appId === SELF_APP_ID) throw Object.assign(new Error('Update App Updater by hand from the App Store.'), { status: 400 });
      const item = installedCache.find((a) => a.id === appId);
      if (!item) throw Object.assign(new Error('App not found'), { status: 404 });
      if (status.busy[appId]) throw Object.assign(new Error('Already updating'), { status: 409 });
      updateApp(item, 'you asked for it now');
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/api/diagnose' && req.method === 'GET') return send(res, 200, { results: await diagnose() });
    if (url.pathname === '/api/log/clear' && req.method === 'POST') { log = []; writeJson(LOG_FILE, log); return send(res, 200, { ok: true }); }

    if (req.method === 'GET') {
      const file = url.pathname === '/' ? 'index.html' : path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '');
      const full = path.join(PUBLIC_DIR, file);
      if (full.startsWith(PUBLIC_DIR) && fs.existsSync(full) && fs.statSync(full).isFile()) {
        res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
        return fs.createReadStream(full).pipe(res);
      }
    }
    send(res, 404, { error: 'Not found' });
  } catch (err) {
    const code = err.status || 500;
    if (code >= 500) console.error(req.method, url.pathname, err.message);
    send(res, code, { error: err.message || 'Server error' });
  }
});

if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => console.log('App Updater listening on :' + PORT));
  setTimeout(() => tick().then(schedule), 3000).unref();
}

module.exports = { server, isNewer, collectVersions };
