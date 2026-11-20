'use strict';
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const C = require('./checker'), { clean } = require('./server');
(async () => {
  // manifests and TSDProxy labels
  assert.deepStrictEqual(C.parseManifest('id: joolay-x\nname: "X App"\nversion: "1.2.3"\nport: 3915\n'), { id: 'joolay-x', name: 'X App', version: '1.2.3', port: 3915 });
  const pub = 'labels:\n  tsdproxy.enable: "true"\n  tsdproxy.name: "project-tracker"\n  tsdproxy.port.1: "443/https:3916/http, no_autodetect, tailscale_funnel"\n';
  assert.deepStrictEqual(C.parseCompose(pub).tsdproxy, { name: 'project-tracker', funnel: true });
  assert.deepStrictEqual(C.parseCompose(pub.replace(', tailscale_funnel', '')).tsdproxy, { name: 'project-tracker', funnel: false });
  assert.strictEqual(C.parseCompose('services:\n  web:\n    image: x\n').tsdproxy, null);
  // discovery from an app-data folder
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-'));
  const mk = (id, port, compose) => { fs.mkdirSync(path.join(dir, id)); fs.writeFileSync(path.join(dir, id, 'umbrel-app.yml'), `id: ${id}\nname: ${id}\nversion: "1.0.0"\nport: ${port}\n`); if (compose) fs.writeFileSync(path.join(dir, id, 'docker-compose.yml'), compose); };
  mk('joolay-pub', 4001, pub); mk('joolay-priv', 4002, pub.replace(', tailscale_funnel', '').replace('project-tracker', 'priv')); mk('bitcoin', 4003); fs.mkdirSync(path.join(dir, 'empty'));
  const apps = C.discover(dir); assert.deepStrictEqual(apps.map((a) => [a.id, a.joolzapp]), [['bitcoin', false], ['joolay-priv', true], ['joolay-pub', true]]);
  assert.deepStrictEqual(C.parseCompose('ports:\n  - "3916:3915"\n  - 8080:80/tcp\n  - "127.0.0.1:9000:9000"\n').hostPorts, [3916, 8080, 9000]);
  // which routes each app should have
  const cfg = { lanHost: '192.168.1.5', tailscaleIp: '100.64.0.9', tailnet: 'tail1.ts.net', intervalMin: 5 };
  const keys = (a) => C.routesFor(a, cfg).map((r) => r.key + '=' + r.url);
  assert.deepStrictEqual(keys(apps[0]), ['lan=http://192.168.1.5:4003/', 'tailscale=http://100.64.0.9:4003/']);
  assert.deepStrictEqual(keys(apps[2]).slice(2), ['public=https://project-tracker.tail1.ts.net/']);
  assert.deepStrictEqual(keys(apps[1]).slice(2), ['name=https://priv.tail1.ts.net/']);
  assert.deepStrictEqual(C.routesFor(apps[2], { lanHost: '', tailscaleIp: '', tailnet: '' }), [], 'nothing to test without addresses');
  // .local route: its own route, and a name that does not resolve is reported as the name's problem
  const cfgL = { ...cfg, localHost: 'umbrel.local' };
  assert.deepStrictEqual(C.routesFor(apps[0], cfgL).map((r) => r.key + '=' + r.url).slice(0, 2), ['lan=http://192.168.1.5:4003/', 'local=http://umbrel.local:4003/']);
  const q = C.mdnsQuery('umbrel.local'); assert.strictEqual(q.readUInt16BE(q.length - 4), 1); assert.strictEqual(q.readUInt16BE(q.length - 2), 0x8001);
  const nm = Buffer.from([6, ...Buffer.from('umbrel'), 5, ...Buffer.from('local'), 0]);
  const reply = Buffer.concat([Buffer.from([0, 0, 0x84, 0, 0, 0, 0, 1, 0, 0, 0, 0]), nm, Buffer.from([0, 1, 0x80, 1, 0, 0, 0, 120, 0, 4, 192, 168, 1, 50])]);
  assert.strictEqual(C.mdnsParse(reply, 'Umbrel.local'), '192.168.1.50'); assert.strictEqual(C.mdnsParse(reply, 'other.local'), ''); assert.strictEqual(C.mdnsParse(Buffer.alloc(3), 'umbrel.local'), '');
  const noName = await C.probe('http://umbrel.local:4003/', { resolver: async () => '' }); assert.strictEqual(noName.ok, false); assert.ok(/\.local name did not resolve/.test(noName.error));
  // probing a real local server: any answer under 500 is up; 502 and refused connections are down
  const srv = http.createServer((q, r) => { r.statusCode = q.url === '/bad' ? 502 : q.url === '/login' ? 401 : 200; r.end('x'); }).listen(0);
  await new Promise((r) => srv.on('listening', r)); const base = 'http://127.0.0.1:' + srv.address().port;
  assert.strictEqual((await C.probe(base + '/')).ok, true); assert.strictEqual((await C.probe(base + '/login')).ok, true, 'a sign-in page is reachable');
  const bad = await C.probe(base + '/bad'); assert.strictEqual(bad.ok, false); assert.ok(/not answering \(502\)/.test(bad.error));
  srv.close(); await new Promise((r) => setTimeout(r, 50)); const refused = await C.probe(base + '/'); assert.strictEqual(refused.ok, false); assert.ok(/refused/.test(refused.error), refused.error);
    const slow = http.createServer(() => {}).listen(0); await new Promise((r) => slow.on('listening', r));
  const to = await C.probe('http://127.0.0.1:' + slow.address().port + '/', { timeoutMs: 300 }); assert.strictEqual(to.ok, false); assert.strictEqual(to.error, 'timed out'); slow.closeAllConnections && slow.closeAllConnections(); slow.close();
  // the monitor needs two bad checks in a row before a route is down, and one good check to be up again
  let ok = true, t = 1000; const mon = C.makeMonitor({ dir, getConfig: () => cfg, now: () => (t += 10), probeImpl: async (u) => (u.includes(':4003') && !ok ? { ok: false, status: 0, ms: 5, error: 'connection refused (nothing listening)' } : { ok: true, status: 200, ms: 7, error: '' }) });
  const route = (rep, id, key) => rep.apps.find((a) => a.id === id).routes.find((r) => r.key === key);
  let rep = await mon.run(); assert.strictEqual(route(rep, 'bitcoin', 'lan').state, 'up');
  ok = false; rep = await mon.run(); assert.strictEqual(route(rep, 'bitcoin', 'lan').state, 'up', 'one failed check is not reported');
  rep = await mon.run(); assert.strictEqual(route(rep, 'bitcoin', 'lan').state, 'down'); assert.ok(route(rep, 'bitcoin', 'lan').since > 0); assert.strictEqual(route(rep, 'joolay-pub', 'public').state, 'up', 'other routes are unaffected');
  ok = true; rep = await mon.run(); assert.strictEqual(route(rep, 'bitcoin', 'lan').state, 'up', 'recovers on the first good check');
  assert.deepStrictEqual(rep.apps.map((a) => a.joolzapp), [false, true, true]); assert.strictEqual(rep.apps[2].published, 'public');
  const viaName = http.createServer((q, r) => { r.statusCode = q.headers.host && q.headers.host.startsWith('umbrel.local') ? 200 : 421; r.end('x'); }).listen(0); await new Promise((r) => viaName.on('listening', r));
  assert.strictEqual((await C.probe('http://umbrel.local:' + viaName.address().port + '/', { resolver: async () => '127.0.0.1' })).ok, true, 'connects to the resolved address and keeps the .local Host'); viaName.close();
  assert.strictEqual(clean({ localHost: 'Umbrel.local' }, { lanHost: 'a' }).localHost, 'umbrel.local'); assert.throws(() => clean({ localHost: 'umbrel.com' }, { lanHost: 'a' }), /\.local/);
  // settings are checked
  const base0 = { lanHost: 'a', tailscaleIp: '', tailnet: '', intervalMin: 5 };
  assert.throws(() => clean({ tailscaleIp: '192.168.1.5' }, base0), /100\.x\.y\.z/); assert.throws(() => clean({ tailnet: 'example.com' }, base0), /ts\.net/); assert.throws(() => clean({ intervalMin: 0 }, base0), /1 to 60/); assert.throws(() => clean({ lanHost: 'http://x/' }, base0), /LAN address/);
  assert.deepStrictEqual(clean({ tailscaleIp: '100.118.10.62', tailnet: 'Tail1.TS.net', intervalMin: '10' }, base0), { lanHost: 'a', tailscaleIp: '100.118.10.62', tailnet: 'tail1.ts.net', intervalMin: 10 });
  const { feedPayload } = require('./server'); assert.strictEqual(typeof feedPayload, 'function');
  console.log('routing-reporter ok'); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
