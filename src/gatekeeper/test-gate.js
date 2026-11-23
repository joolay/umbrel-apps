'use strict';
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gk-'));
process.env.DATA_DIR = tmp;
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const USERS = {
  'admin@x.co': { id: 'adminadminadmin', email: 'admin@x.co', name: 'Admin', isAdmin: true, pw: 'pw-admin' },
  'sam@x.co': { id: 'samsamsamsamsam', email: 'sam@x.co', name: 'Sam', isAdmin: false, pw: 'pw-sam' },
  'lee@x.co': { id: 'leeleeleeleelee', email: 'lee@x.co', name: 'Lee', isAdmin: false, pw: 'pw-lee' },
  'kim@x.co': { id: 'kimkimkimkimkim', email: 'kim@x.co', name: 'Kim', isAdmin: false, pw: 'pw-kim' },
};
let canBroken = false;

(async () => {
  // fake Portal Admin (Portal API)
  const portalSrv = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => {
      const j = JSON.parse(b || '{}'), out = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.headers.authorization !== 'Bearer gatekeeper.key') { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"message":"Unknown app key."}'); }
      if (j.fn === 'login') { const u = USERS[j.args[0]]; return u && u.pw === j.args[1] ? out({ ok: true, result: { record: u } }) : out({ ok: false, status: 400, message: 'bad' }); }
      if (j.fn === 'gate.can') { if (canBroken) return out({ ok: false, status: 500, message: 'down' }); const [id, slug] = j.args; return out({ ok: true, result: { allowed: id === USERS['sam@x.co'].id && slug === 'stremio', enabled: slug !== 'off-app' } }); }
      if (j.fn === 'portalApps.list') return out({ ok: true, result: [{ slug: 'stremio', name: 'Stremio' }] });
      out({ ok: false, status: 404, message: 'Unknown function: ' + j.fn });
    });
  });
  const pPort = await listen(portalSrv);
  process.env.POCKETBASE_PORTAL_URL = 'http://127.0.0.1:' + pPort; process.env.POCKETBASE_PORTAL_KEY = 'gatekeeper.key';

  // fake app behind the gate
  let seen = null;
  const appSrv = http.createServer((req, res) => { seen = { url: req.url, headers: req.headers }; res.writeHead(200, { 'content-type': 'text/plain' }); res.end('hello from the app'); });
  const aPort = await listen(appSrv);

  const gk = require('./server');
  gk.setCfg({ secret: 'test-secret', routes: [
    { name: 'stremio', slug: 'stremio', upstream: 'http://127.0.0.1:' + aPort, adminOnly: false, enabled: true },
    { name: 'secret', slug: 'secret', upstream: 'http://127.0.0.1:' + aPort, adminOnly: true, enabled: true },
    { name: 'off', slug: 'off-app', upstream: 'http://127.0.0.1:' + aPort, adminOnly: false, enabled: true },
    { name: 'paused', slug: 'paused', upstream: 'http://127.0.0.1:' + aPort, adminOnly: false, enabled: false },
  ] });
  const gPort = await listen(gk.server);

  const req = (method, host, p, { cookie, body, accept } = {}) => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: gPort, method, path: p, headers: { host, ...(cookie ? { cookie } : {}), ...(accept ? { accept } : {}), ...(body ? { 'content-type': 'application/json' } : {}) } }, (res) => {
      let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d }));
    });
    r.on('error', reject); if (body) r.write(JSON.stringify(body)); r.end();
  });
  const login = async (email, pw, host = 'stremio.tail.ts.net') => { const r = await req('POST', host, '/__gk/login', { body: { email, password: pw } }); return { r, cookie: (r.headers['set-cookie'] || [''])[0].split(';')[0] }; };

  // 1. no session: a browser is sent to sign in, a script gets 401
  let r = await req('GET', 'stremio.tail.ts.net', '/movies', { accept: 'text/html' });
  assert.strictEqual(r.status, 302); assert.ok(r.headers.location.startsWith('/__gk/login?next=%2Fmovies'));
  assert.strictEqual((await req('GET', 'stremio.tail.ts.net', '/api', {})).status, 401);

  // 2. wrong password: no cookie
  let l = await login('sam@x.co', 'nope'); assert.strictEqual(l.r.status, 401); assert.strictEqual(l.cookie, '');

  // 3. approved person: proxied, gate cookie not passed on, who they are is passed on
  l = await login('sam@x.co', 'pw-sam'); assert.strictEqual(l.r.status, 200); assert.ok(/HttpOnly/.test(l.r.headers['set-cookie'][0]));
  r = await req('GET', 'stremio.tail.ts.net', '/movies?x=1', { cookie: l.cookie + '; other=1' });
  assert.strictEqual(r.status, 200); assert.strictEqual(r.body, 'hello from the app');
  assert.strictEqual(seen.url, '/movies?x=1'); assert.strictEqual(seen.headers['x-gatekeeper-user'], 'sam@x.co');
  assert.ok(!/gk_session/.test(seen.headers.cookie || '')); assert.ok(/other=1/.test(seen.headers.cookie));
  const sam = l.cookie;

  // 4. a person who is not approved gets a no-access page; the app is never called
  l = await login('kim@x.co', 'pw-kim'); seen = null;
  r = await req('GET', 'stremio.tail.ts.net', '/', { cookie: l.cookie }); assert.strictEqual(r.status, 403); assert.strictEqual(seen, null);

  // 5. admin-only route: admin yes, approved member no; admin opens an app nobody else is approved for
  assert.strictEqual((await req('GET', 'secret.tail.ts.net', '/', { cookie: sam })).status, 403);
  const adm = (await login('admin@x.co', 'pw-admin')).cookie;
  assert.strictEqual((await req('GET', 'secret.tail.ts.net', '/', { cookie: adm })).status, 200);
  assert.strictEqual(seen.headers['x-gatekeeper-admin'], '1');

  // 6. a switched-off app is refused to members but not to the admin
  assert.strictEqual((await req('GET', 'off.tail.ts.net', '/', { cookie: sam })).status, 403);
  assert.strictEqual((await req('GET', 'off.tail.ts.net', '/', { cookie: adm })).status, 200);

  // 7. tampered or foreign cookie = signed out
  assert.strictEqual((await req('GET', 'stremio.tail.ts.net', '/', { cookie: sam.slice(0, -3) + 'abc' })).status, 401);
  assert.strictEqual((await req('GET', 'stremio.tail.ts.net', '/', { cookie: 'gk_session=' + sam.split('=')[1].replace(/^[^.]+/, 'eyJhZG1pbiI6dHJ1ZX0') })).status, 401);

  // 8. Portal Admin unreachable: fail closed (503), never open
  const lee = (await login('lee@x.co', 'pw-lee')).cookie; canBroken = true;
  assert.strictEqual((await req('GET', 'stremio.tail.ts.net', '/', { cookie: lee })).status, 503);
  canBroken = false;

  // 9. a switched-off route is not served by the gate; an unknown name shows Gatekeeper's own page, which has no admin API without an admin session
  assert.strictEqual((await req('GET', 'paused.tail.ts.net', '/', { cookie: sam })).headers['x-gatekeeper-user'], undefined);
  assert.strictEqual((await req('GET', 'gatekeeper.tail.ts.net', '/__gk/api/routes', { cookie: sam })).status, 403);
  assert.strictEqual((await req('GET', 'gatekeeper.tail.ts.net', '/__gk/api/routes', {})).status, 401);

  // 10. admin manages routes; bad input refused; changes take effect
  r = await req('POST', 'gatekeeper.tail.ts.net', '/__gk/api/routes', { cookie: adm, body: { route: { name: 'kiosk', slug: 'joolay-kiosk-manager', upstream: 'http://host.docker.internal:3920', adminOnly: true } } });
  assert.strictEqual(r.status, 200); assert.ok(JSON.parse(r.body).routes.some((x) => x.name === 'kiosk'));
  r = await req('POST', 'gatekeeper.tail.ts.net', '/__gk/api/routes', { cookie: adm, body: { route: { name: 'bad name!', slug: 'x', upstream: 'http://a:1' } } }); assert.strictEqual(r.status, 400);
  r = await req('POST', 'gatekeeper.tail.ts.net', '/__gk/api/routes', { cookie: adm, body: { route: { name: 'x', slug: 'x', upstream: 'http://user:pw@a:1/path' } } }); assert.strictEqual(r.status, 400);
  r = await req('POST', 'gatekeeper.tail.ts.net', '/__gk/api/routes', { cookie: adm, body: { action: 'remove', name: 'kiosk' } }); assert.ok(!JSON.parse(r.body).routes.some((x) => x.name === 'kiosk'));

  // 11. logout clears the cookie
  r = await req('GET', 'stremio.tail.ts.net', '/__gk/logout', {}); assert.ok(/Max-Age=0/.test(r.headers['set-cookie'][0]));

  console.log('gatekeeper ok');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
