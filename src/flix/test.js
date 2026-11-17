// Starts server.js on temp ports/data and checks config, static serving, sync merge rules and the API-only port.
'use strict';
var http = require('http'), fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-')), P = 39100 + Math.floor(Math.random() * 500), A = P + 1;
var child = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: Object.assign({}, process.env, { PORT: P, API_PORT: A, DATA_DIR: dir, TF_STREMIO_PORT: '11470' }), stdio: 'ignore' });
function req(port, method, p, body, headers) {
  return new Promise(function (res, rej) {
    var r = http.request({ port: port, method: method, path: p, headers: Object.assign({ Host: 'umbrel.local:' + port }, headers || {}) }, function (x) { var b = ''; x.on('data', function (c) { b += c; }); x.on('end', function () { res({ code: x.statusCode, body: b, headers: x.headers }); }); });
    r.on('error', rej); if (body) r.write(body); r.end();
  });
}
var fails = 0; function ok(c, m) { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); }
function sync(state) { return req(A, 'POST', '/tf/api/sync', JSON.stringify({ state: state }), { 'Content-Type': 'application/json' }).then(function (r) { return JSON.parse(r.body).state; }); }
setTimeout(function () {
  req(P, 'GET', '/healthz').then(function (r) { ok(r.code === 200, 'health'); return req(P, 'GET', '/config.js'); })
    .then(function (r) { ok(/serverUrl: "http:\/\/umbrel\.local:11470"/.test(r.body) && /TF_BACKEND/.test(r.body), 'config.js points at the Stremio server and enables sync'); return req(P, 'GET', '/'); })
    .then(function (r) { ok(r.code === 200 && /JoolzFlix/.test(r.body), 'UI served'); return req(P, 'GET', '/%2e%2e/server.js'); })
    .then(function (r) { ok(r.code === 403 || r.code === 404, 'path traversal blocked (' + r.code + ')'); return req(A, 'GET', '/'); })
    .then(function (r) { ok(r.code === 404, 'API-only port does not serve the UI'); return req(A, 'OPTIONS', '/tf/api/sync'); })
    .then(function (r) { ok(r.code === 204 && r.headers['access-control-allow-origin'] === '*', 'CORS preflight'); return sync({ profiles: { a1: { id: 'a1', name: 'Dad', ts: 100 } }, 'pa1.resume': { tt1: { t: 5, ts: 100 } }, evil: { x: { ts: 1 } }, 'pa1.list': { bad: { n: 1 } } }); })
    .then(function (s) { ok(s.profiles.a1 && s['pa1.resume'].tt1 && !s.evil && !Object.keys(s['pa1.list']).length, 'valid keys/entries kept, invalid dropped'); return sync({ 'pa1.resume': { tt1: { t: 9, ts: 50 }, tt2: { t: 1, ts: 200 } } }); })
    .then(function (s) { ok(s['pa1.resume'].tt1.t === 5 && s['pa1.resume'].tt2, 'older entry does not overwrite newer; new entry added'); return sync({ profiles: { a1: { id: 'a1', deleted: true, ts: 300 } } }); })
    .then(function (s) { ok(s.profiles.a1.deleted && !s['pa1.resume'], 'deleted profile tombstoned and its data dropped'); })
    .catch(function (e) { fails++; console.log('ERROR', e.message); })
    .then(function () { child.kill(); console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exit(fails ? 1 : 0); });
}, 800);
