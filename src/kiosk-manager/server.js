// Kiosk Manager backend. Zero dependencies.
// Runs inside a privileged container with pid:host and uses nsenter to act on the Umbrel host.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const PORT = 3000;
const DATA = process.env.DATA_DIR || '/data';
const CFG = path.join(DATA, 'config.json');
const UNIT = 'umbrel-kiosk.service';
const UNIT_PATH = '/etc/systemd/system/' + UNIT;
const PUBLIC = path.join(__dirname, 'public');

try { fs.mkdirSync(DATA, { recursive: true }); } catch {} // Portal Admin links apps that have a data folder

const defaults = { url: 'http://localhost', user: 'kiosk' };

function loadCfg() {
  try { return { ...defaults, ...JSON.parse(fs.readFileSync(CFG, 'utf8')) }; }
  catch { return { ...defaults }; }
}
function saveCfg(c) {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(CFG, JSON.stringify(c, null, 2));
}

// Run a shell command on the host (PID 1 namespaces).
function host(cmd, input) {
  return new Promise((resolve) => {
    const p = execFile(
      'nsenter', ['-t', '1', '-m', '-u', '-i', '-n', '-p', '--', 'sh', '-c', cmd],
      { timeout: 900000, maxBuffer: 1 << 24 },
      (err, so, se) => resolve({ ok: !err, out: String(so || '') + String(se || '') })
    );
    p.stdin.end(input || '');
  });
}

const SAFE_URL = /^https?:\/\/[A-Za-z0-9._~:\/?#\[\]@!&'()*+,;=-]+$/;
function validUrl(u) {
  if (typeof u !== 'string' || !SAFE_URL.test(u) || u.includes("'")) return false;
  try { new URL(u); return true; } catch { return false; }
}

function unitText(cfg) {
  return `[Unit]
Description=Umbrel Kiosk Browser
After=systemd-user-sessions.service network-online.target getty@tty1.service
Conflicts=getty@tty1.service

[Service]
User=${cfg.user}
PAMName=login
TTYPath=/dev/tty1
TTYReset=yes
TTYVHangup=yes
TTYVTDisallocate=yes
StandardInput=tty-force
StandardOutput=journal
StandardError=journal
ExecStartPre=/bin/sleep 10
ExecStart=/usr/bin/cage -s -- /usr/bin/chromium --kiosk --noerrdialogs --disable-infobars --no-first-run --disable-session-crashed-bubble --ozone-platform=wayland ${cfg.url}
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
`;
}

const INSTALL = `export DEBIAN_FRONTEND=noninteractive
command -v apt-get >/dev/null || { echo "apt-get not found on host"; exit 1; }
apt-get update && apt-get install -y --no-install-recommends cage chromium seatd xwayland fonts-dejavu-core curl || exit 1
id kiosk >/dev/null 2>&1 || useradd -m -s /bin/bash kiosk
usermod -aG video,render,input,tty kiosk
echo "Kiosk packages ready"`;

async function writeUnit() {
  const cfg = loadCfg();
  const w = await host(`cat > ${UNIT_PATH} && systemctl daemon-reload`, unitText(cfg));
  return w;
}

async function status() {
  const r = await host(`
    { command -v cage >/dev/null && command -v chromium >/dev/null && id kiosk >/dev/null 2>&1; } && echo installed=1 || echo installed=0
    test -f ${UNIT_PATH} && echo unit=1 || echo unit=0
    echo active=$(systemctl is-active ${UNIT} 2>/dev/null)
    echo enabled=$(systemctl is-enabled ${UNIT} 2>/dev/null)
  `);
  const kv = {};
  r.out.split('\n').forEach((l) => { const i = l.indexOf('='); if (i > 0) kv[l.slice(0, i).trim()] = l.slice(i + 1).trim(); });
  const logs = (await host(`journalctl -u ${UNIT} -n 25 --no-pager 2>/dev/null`)).out;
  return {
    hostReachable: r.ok,
    installed: kv.installed === '1',
    unitPresent: kv.unit === '1',
    running: kv.active === 'active',
    bootEnabled: kv.enabled === 'enabled',
    config: loadCfg(),
    logs,
  };
}

const actions = {
  async install() { return host(INSTALL); },
  async load() {
    const w = await writeUnit(); if (!w.ok) return w;
    return host(`systemctl start ${UNIT}`);
  },
  async unload() {
    const r = await host(`systemctl stop ${UNIT}`);
    await host('systemctl start getty@tty1.service');
    return r;
  },
  async bootEnable() {
    const w = await writeUnit(); if (!w.ok) return w;
    return host(`systemctl enable ${UNIT}`);
  },
  async bootDisable() { return host(`systemctl disable ${UNIT}`); },
  async uninstall() {
    await host(`systemctl disable --now ${UNIT}; rm -f ${UNIT_PATH}; systemctl daemon-reload; systemctl start getty@tty1.service`);
    return { ok: true, out: 'Kiosk service removed' };
  },
};

const routes = {
  'POST /api/install': actions.install,
  'POST /api/load': actions.load,
  'POST /api/unload': actions.unload,
  'POST /api/boot/enable': actions.bootEnable,
  'POST /api/boot/disable': actions.bootDisable,
  'POST /api/uninstall': actions.uninstall,
};

function body(req) {
  return new Promise((res) => {
    let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => { try { res(JSON.parse(d || '{}')); } catch { res({}); } });
  });
}
function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

http.createServer(async (req, res) => {
  const key = `${req.method} ${req.url.split('?')[0]}`;
  try {
    if (key === 'GET /api/link') return send(res, 200, feedHandle.link());
    if (key === 'GET /api/status') return send(res, 200, await status());
    if (key === 'POST /api/config') {
      const b = await body(req);
      if (!validUrl(b.url)) return send(res, 400, { ok: false, out: 'Invalid URL' });
      const cfg = { ...loadCfg(), url: b.url };
      saveCfg(cfg);
      // If the service file exists, refresh it so the new URL applies on next start/boot.
      if ((await host(`test -f ${UNIT_PATH}`)).ok) await writeUnit();
      return send(res, 200, { ok: true, out: 'Saved' });
    }
    if (routes[key]) return send(res, 200, await routes[key]());
    // static files
    const file = req.url === '/' ? 'index.html' : path.normalize(req.url.split('?')[0]).replace(/^(\.\.[\/\\])+/, '');
    const full = path.join(PUBLIC, file);
    if (!full.startsWith(PUBLIC) || !fs.existsSync(full)) { res.writeHead(404); return res.end('Not found'); }
    const T = { '.html':'text/html', '.css':'text/css', '.js':'application/javascript', '.svg':'image/svg+xml', '.png':'image/png', '.webmanifest':'application/manifest+json' };
    res.writeHead(200, { 'Content-Type': T[path.extname(full)] || 'application/octet-stream' });
    fs.createReadStream(full).pipe(res);
  } catch (e) {
    send(res, 500, { ok: false, out: String(e) });
  }
}).listen(PORT, () => console.log('Kiosk Manager on ' + PORT));

// Status feed (read by the owner and Claude through GitHub): kiosk state, no secrets. See status-feed.js.
const feedHandle = require('./status-feed')({
  dataDir: DATA,
  getPayload: async () => {
    const s = await status();
    return {
      app: 'kiosk-manager', hostReachable: s.hostReachable, installed: s.installed, unitPresent: s.unitPresent,
      running: s.running, bootEnabled: s.bootEnabled, url: s.config.url,
      recentLog: String(s.logs || '').split('\n').slice(-10),
    };
  },
  log: (m) => console.warn(m),
});
