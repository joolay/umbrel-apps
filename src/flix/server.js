/* JoolzFlix for Umbrel (no dependencies).
   - Serves the JoolzFlix UI (./public) to browsers, behind Umbrel's login (app_proxy on PORT).
   - /config.js tells the UI where your Stremio streaming server is and turns on profile sync.
   - /tf/api/sync stores profiles, watchlists and watch progress (newest entry wins) in /data/state.json. */
'use strict';
var http = require('http'), fs = require('fs'), path = require('path');

var PORT = parseInt(process.env.PORT || '3900', 10);
var API_PORT = parseInt(process.env.API_PORT || '0', 10);   // optional second port that serves ONLY the profile-sync API (for the TV app)
var DATA = process.env.DATA_DIR || '/data';
var ROOT = path.resolve(process.env.TF_ROOT || path.join(__dirname, 'public'));
var STREMIO_PORT = process.env.TF_STREMIO_PORT || "11470";   // the bundled streaming server
var STREMIO_URL = process.env.TF_STREMIO_URL || '';       // optional: point at another streaming server
var FILE = path.join(DATA, 'state.json');
var MAX_BODY = 2 * 1024 * 1024, MAX_RESUME = 200, MAX_LIST = 500;
var KEY_RE = /^(profiles|p[a-z0-9]{1,12}\.(resume|list))$/;
var MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

var state = {};
try { fs.mkdirSync(DATA, { recursive: true }); state = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { state = {}; }
var saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(function () {
    var tmp = FILE + '.tmp';
    fs.writeFile(tmp, JSON.stringify(state), function (err) { if (!err) fs.rename(tmp, FILE, function () {}); });
  }, 300);
}

function validEntry(e) { return e && typeof e === 'object' && !Array.isArray(e) && typeof e.ts === 'number' && isFinite(e.ts); }
function merge(incoming) {
  Object.keys(incoming || {}).forEach(function (key) {
    if (!KEY_RE.test(key) || !incoming[key] || typeof incoming[key] !== 'object') return;
    var cur = state[key] || (state[key] = {}), src = incoming[key];
    Object.keys(src).forEach(function (id) {
      if (id.length > 64 || !validEntry(src[id])) return;
      if (!cur[id] || src[id].ts > (cur[id].ts || 0)) cur[id] = src[id];
    });
    var cap = /\.resume$/.test(key) ? MAX_RESUME : /\.list$/.test(key) ? MAX_LIST : 50;
    var ids = Object.keys(cur);
    if (ids.length > cap) ids.sort(function (a, b) { return (cur[b].ts || 0) - (cur[a].ts || 0); }).slice(cap).forEach(function (id) { delete cur[id]; });
  });
  // data of profiles that were deleted (tombstoned) is dropped
  var profiles = state.profiles || {};
  Object.keys(state).forEach(function (key) {
    var m = /^p([a-z0-9]+)\./.exec(key);
    if (m && profiles[m[1]] && profiles[m[1]].deleted) delete state[key];
  });
  save();
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '600');
}
function json(res, code, obj) { cors(res); res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); }

function configJs(req) {
  var host = String(req.headers.host || 'localhost').replace(/:\d+$/, '');
  var server = STREMIO_URL || ('http://' + host + ':' + STREMIO_PORT);
  return 'window.FLIX_CONFIG = { serverUrl: ' + JSON.stringify(server) + ' };\nwindow.TF_BACKEND = "/tf/api";\n';
}

function serveStatic(req, res, pathname) {
  if (pathname === '/') pathname = '/index.html';
  var file = path.normalize(path.join(ROOT, pathname));
  if (file !== ROOT && file.indexOf(ROOT + path.sep) !== 0) { res.writeHead(403); return res.end('Forbidden'); }
  fs.stat(file, function (err, st) {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'Content-Length': st.size });
    fs.createReadStream(file).pipe(res);
  });
}

function handler(apiOnly) { return function (req, res) {
  var pathname = decodeURIComponent((req.url || '/').split('?')[0]);
  if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); return res.end(); }
  if (pathname === '/healthz') return json(res, 200, { ok: true });
  if (apiOnly && pathname.indexOf('/tf/api/') !== 0) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
  if (pathname === '/config.js') { res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(configJs(req)); }
  if (pathname === '/tf/api/state' && req.method === 'GET') return json(res, 200, { state: state });
  if (pathname === '/tf/api/sync' && req.method === 'POST') {
    var chunks = [], size = 0, aborted = false;
    req.on('data', function (c) { size += c.length; if (size > MAX_BODY) { aborted = true; json(res, 413, { error: 'too large' }); req.destroy(); } else chunks.push(c); });
    req.on('end', function () {
      if (aborted) return;
      var body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { return json(res, 400, { error: 'bad json' }); }
      merge(body && body.state);
      json(res, 200, { state: state });
    });
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  serveStatic(req, res, pathname);
}; }
http.createServer(handler(false)).listen(PORT, '0.0.0.0', function () { console.log('JoolzFlix listening on :' + PORT + ', UI from ' + ROOT + ', data in ' + DATA); });
if (API_PORT) http.createServer(handler(true)).listen(API_PORT, '0.0.0.0', function () { console.log('Profile-sync API only on :' + API_PORT); });
process.on('SIGTERM', function () { try { fs.writeFileSync(FILE, JSON.stringify(state)); } catch (e) {} process.exit(0); });
