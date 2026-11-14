'use strict';
// Services Manager backend. Node built-ins only (no npm install needed).
// Talks to the Docker Engine API over the unix socket and to umbreld's tRPC API.

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 3000;
const DOCKER_SOCKET = process.env.DOCKER_SOCKET || '/var/run/docker.sock';
const DATA_DIR = process.env.DATA_DIR || '/data';
const PUBLIC_DIR = path.join(__dirname, 'public');
const SELF_ID = (process.env.HOSTNAME || '').slice(0, 12);

const UMBREL_CANDIDATES = [
  process.env.UMBREL_URL,
  'http://host.docker.internal',
  process.env.DEVICE_DOMAIN_NAME && 'http://' + process.env.DEVICE_DOMAIN_NAME,
  'http://umbrel.local',
  'http://172.17.0.1',
].filter(Boolean);

const BUSY_STATES = new Set(['installing', 'uninstalling', 'updating', 'starting', 'stopping', 'restarting']);
const ON_STATES = new Set(['running', 'ready', 'starting', 'restarting', 'updating']);

/* ------------------------------ persistence ------------------------------ */

const SESSION_FILE = path.join(DATA_DIR, 'session.json');
const PINS_FILE = path.join(DATA_DIR, 'policies.json');

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

const umbrel = Object.assign({ base: null, token: null, cookie: '', error: null }, readJson(SESSION_FILE, {}));
let pins = readJson(PINS_FILE, {}); // { "umbrel:<appId>": "always" | "unless-stopped" }

function saveSession() {
  if (umbrel.token) writeJson(SESSION_FILE, { base: umbrel.base, token: umbrel.token, cookie: umbrel.cookie }, 0o600);
  else { try { fs.unlinkSync(SESSION_FILE); } catch { /* none */ } }
}

/* ------------------------------ Docker client ----------------------------- */

function docker(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {};
    const req = http.request({ socketPath: DOCKER_SOCKET, path: p, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let json;
        try { json = JSON.parse(text); } catch { /* not json */ }
        if (res.statusCode >= 400) return reject(new Error((json && json.message) || text || 'Docker error ' + res.statusCode));
        resolve(json !== undefined ? json : text);
      });
    });
    req.on('error', reject);
    req.setTimeout(90000, () => req.destroy(new Error('Docker request timed out')));
    if (data) req.write(data);
    req.end();
  });
}

async function inChunks(items, size, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  }
  return out;
}

async function listContainers() {
  const list = await docker('GET', '/containers/json?all=1');
  return inChunks(list, 16, async (c) => {
    let policy = { Name: 'no', MaximumRetryCount: 0 };
    try {
      const info = await docker('GET', '/containers/' + c.Id + '/json');
      policy = (info.HostConfig && info.HostConfig.RestartPolicy) || policy;
    } catch { /* container vanished between calls */ }
    return {
      id: c.Id,
      name: (c.Names && c.Names[0] ? c.Names[0] : c.Id.slice(0, 12)).replace(/^\//, ''),
      image: c.Image,
      state: c.State,
      status: c.Status,
      labels: c.Labels || {},
      policy: policy.Name || 'no',
    };
  });
}

const setPolicy = (id, name) =>
  docker('POST', '/containers/' + id + '/update', { RestartPolicy: { Name: name, MaximumRetryCount: 0 } });

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

function expireSession(message) {
  umbrel.token = null;
  umbrel.cookie = '';
  umbrel.error = message;
  saveSession();
}

async function umbrelCall(proc, type, input, timeout) {
  if (!umbrel.token || !umbrel.base) throw Object.assign(new Error('Connect to umbrelOS first'), { status: 401 });
  try {
    return (await trpc(umbrel.base, proc, type, input, timeout)).data;
  } catch (err) {
    if (err.code === 'UNAUTHORIZED' || err.code === 'FORBIDDEN') {
      expireSession('Session expired, please connect again');
      err.status = 401;
    }
    throw err;
  }
}

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
      saveSession();
      return;
    } catch (err) {
      if (err.unreachable || /^(ECONN|ENOTFOUND|EHOST|ENETUNREACH|ETIMEDOUT|EAI_AGAIN)/.test(String(err.code || '')) || err.message === 'timeout') {
        lastError = err;
        continue; // try the next address
      }
      throw Object.assign(err, { status: 401 }); // reachable, but refused (wrong password, 2FA, ...)
    }
  }
  throw Object.assign(
    new Error('Could not reach umbrelOS from inside this container. Tried: ' + UMBREL_CANDIDATES.join(', ') +
      (lastError ? ' (' + lastError.message + ')' : '') + '. Set UMBREL_URL in docker-compose.yml.'),
    { status: 502 }
  );
}

/* ------------------------------ service model ----------------------------- */

const prettify = (id) => id.replace(/[-_]+/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());

function summarisePolicy(containers) {
  const set = new Set(containers.map((c) => c.policy));
  if (set.size === 0) return null;
  return set.size === 1 ? [...set][0] : 'mixed';
}

async function collect() {
  const containers = await listContainers();

  let apps = null;
  if (umbrel.token) {
    try {
      const list = await umbrelCall('apps.list', 'query');
      apps = Array.isArray(list) ? list.filter((a) => a && a.id && !a.error) : null;
      umbrel.error = null;
    } catch (err) {
      umbrel.error = err.message;
    }
  }
  const appById = new Map((apps || []).map((a) => [a.id, a]));

  const groups = new Map();
  const group = (key, kind, id, name) => {
    if (!groups.has(key)) groups.set(key, { key, kind, id, name, containers: [] });
    return groups.get(key);
  };

  for (const a of apps || []) group('umbrel:' + a.id, 'umbrel', a.id, a.name || prettify(a.id));

  for (const c of containers) {
    const project = c.labels['com.docker.compose.project'];
    const wd = c.labels['com.docker.compose.project.working_dir'] || '';
    const m = wd.match(/\/app-data\/([^/]+)/);
    const appId = m ? m[1] : project && appById.has(project) ? project : null;
    const entry = {
      id: c.id.slice(0, 12), fullId: c.id, name: c.name, image: c.image, state: c.state, status: c.status, policy: c.policy,
      self: SELF_ID !== '' && c.id.startsWith(SELF_ID),
    };
    const g = appId
      ? group('umbrel:' + appId, 'umbrel', appId, (appById.get(appId) || {}).name || prettify(appId))
      : project
        ? group('docker:' + project, 'docker', project, project)
        : group('docker:' + c.name, 'docker', c.name, c.name);
    g.containers.push(entry);
  }

  const services = [...groups.values()].map((g) => {
    const app = g.kind === 'umbrel' ? appById.get(g.id) : null;
    const running = g.containers.filter((c) => c.state === 'running').length;
    let state = running > 0 ? 'running' : 'stopped';
    if (app && app.state) state = app.state;
    else if (g.containers.some((c) => c.state === 'restarting')) state = 'restarting';
    return {
      key: g.key,
      kind: g.kind,
      id: g.id,
      name: g.name,
      state,
      busy: BUSY_STATES.has(state),
      on: ON_STATES.has(state),
      autoStart: app && typeof app.autoStart === 'boolean' ? app.autoStart : null,
      policy: summarisePolicy(g.containers),
      pinned: pins[g.key] || null,
      protected: g.containers.some((c) => c.self),
      containers: g.containers.map(({ fullId, ...rest }) => rest),
      _full: g.containers,
    };
  });

  services.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'umbrel' ? -1 : 1));
  return { apps, services };
}

const publicService = ({ _full, ...rest }) => rest;

async function snapshot() {
  const { services } = await collect();
  return {
    umbrel: { connected: !!umbrel.token, base: umbrel.base, error: umbrel.error },
    services: services.map(publicService),
    time: Date.now(),
  };
}

/* -------------------------------- actions --------------------------------- */

const POLICIES = new Set(['no', 'on-failure', 'unless-stopped', 'always']);

async function applyPolicy(svc, name) {
  await Promise.all(svc._full.filter((c) => !c.self && c.policy !== name).map((c) => setPolicy(c.fullId, name)));
}

async function perform({ key, action, policy }) {
  const { services } = await collect();
  const svc = services.find((s) => s.key === key);
  if (!svc) throw Object.assign(new Error('Service not found'), { status: 404 });
  if (svc.protected) throw Object.assign(new Error('Services Manager cannot control itself'), { status: 400 });

  if (action === 'policy') {
    if (svc.kind === 'umbrel') {
      if (policy === 'default') {
        delete pins[key];
      } else if (policy === 'always' || policy === 'unless-stopped') {
        pins[key] = policy;
        await applyPolicy(svc, policy);
      } else throw Object.assign(new Error('Umbrel apps support: default, unless-stopped, always'), { status: 400 });
      writeJson(PINS_FILE, pins);
      return;
    }
    if (!POLICIES.has(policy)) throw Object.assign(new Error('Unknown restart policy'), { status: 400 });
    await applyPolicy(svc, policy);
    return;
  }

  if (svc.kind === 'umbrel') {
    const map = { start: 'apps.start', enable: 'apps.start', stop: 'apps.stop', disable: 'apps.stop', restart: 'apps.restart' };
    if (!map[action]) throw Object.assign(new Error('Unknown action'), { status: 400 });
    await umbrelCall(map[action], 'mutation', { appId: svc.id }, 180000);
    if (pins[key] && (action === 'start' || action === 'enable' || action === 'restart')) {
      setTimeout(reconcile, 5000).unref();
    }
    return;
  }

  // custom docker service
  const targets = svc._full.filter((c) => !c.self);
  const current = svc.policy;
  if (action === 'start' || action === 'enable') {
    if (action === 'enable' && current !== 'always' && current !== 'unless-stopped') await applyPolicy(svc, 'unless-stopped');
    await Promise.all(targets.map((c) => docker('POST', '/containers/' + c.fullId + '/start')));
  } else if (action === 'stop' || action === 'disable') {
    // "always" would bring a manually stopped container back after a reboot; "unless-stopped" will not.
    if (current === 'always' || current === 'mixed') await applyPolicy(svc, 'unless-stopped');
    await Promise.all(targets.map((c) => docker('POST', '/containers/' + c.fullId + '/stop?t=10')));
  } else if (action === 'restart') {
    await Promise.all(targets.map((c) => docker('POST', '/containers/' + c.fullId + '/restart?t=10')));
  } else {
    throw Object.assign(new Error('Unknown action'), { status: 400 });
  }
}

// Umbrel recreates an app's containers when it starts or updates them, which resets their restart
// policy. Re-apply pinned policies so "always" / "unless-stopped" stick.
let reconciling = false;
async function reconcile() {
  if (reconciling || Object.keys(pins).length === 0) return;
  reconciling = true;
  try {
    const containers = await listContainers();
    for (const c of containers) {
      if (SELF_ID && c.id.startsWith(SELF_ID)) continue;
      const wd = c.labels['com.docker.compose.project.working_dir'] || '';
      const m = wd.match(/\/app-data\/([^/]+)/);
      const want = m && pins['umbrel:' + m[1]];
      if (want && c.policy !== want) await setPolicy(c.id, want).catch((e) => console.error('reconcile', c.name, e.message));
    }
  } catch (err) {
    console.error('reconcile failed:', err.message);
  } finally {
    reconciling = false;
  }
}

/* ---------------------------------- HTTP ---------------------------------- */

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(body);
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/api/state' && req.method === 'GET') return send(res, 200, await snapshot());

    if (url.pathname === '/api/umbrel/login' && req.method === 'POST') {
      const { password, totp } = await readBody(req);
      if (!password) throw Object.assign(new Error('Enter your umbrelOS password'), { status: 400 });
      await umbrelLogin(String(password), totp);
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/api/umbrel/logout' && req.method === 'POST') {
      expireSession(null);
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/api/action' && req.method === 'POST') {
      const body = await readBody(req);
      await perform(body);
      return send(res, 200, { ok: true });
    }

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
    const status = err.status || 500;
    if (status >= 500) console.error(req.method, url.pathname, err.message);
    send(res, status, { error: err.message || 'Server error' });
  }
});

if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => console.log('Services Manager listening on :' + PORT));
  setInterval(reconcile, 30000).unref();
  setTimeout(reconcile, 3000).unref();
}

module.exports = { server };
