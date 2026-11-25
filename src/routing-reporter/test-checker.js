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

// apps published through a TSDProxy list file (no labels of their own)
{
  const assert2 = require('assert'), C2 = require('./checker'), fs2 = require('fs'), os2 = require('os'), p2 = require('path');
  const list = '# c\nopenclaw:\n  ports:\n    443/https:\n      targets:\n        - http://host.docker.internal:18789\n';
  assert2.deepStrictEqual(C2.parseList(list), [{ name: 'openclaw', port: 18789, funnel: false }]);
  const d = fs2.mkdtempSync(p2.join(os2.tmpdir(), 'rl-')); fs2.mkdirSync(p2.join(d, 'openclaw'));
  fs2.writeFileSync(p2.join(d, 'openclaw', 'umbrel-app.yml'), 'id: openclaw\nname: OpenClaw\nversion: "1"\nport: 18789\n');
  const lf = p2.join(d, 'l.yaml'); fs2.writeFileSync(lf, list);
  assert2.deepStrictEqual(C2.discover(d, lf)[0].tsdproxy, { name: 'openclaw', funnel: false });
  assert2.strictEqual(C2.discover(d)[0].tsdproxy, null);
  console.log('list-file test ok');
}  // Open links and the Fix helper
  const fx = (key, err, up) => C.fixHint({ id: 'a', name: 'A', port: 1 }, { key, error: err }, [{ key: 'lan', state: up ? 'up' : 'down' }, { key, state: 'down' }], { tailscaleIp: '100.1.1.1', tailnet: 't.ts.net', localHost: 'umbrel.local' });
  assert.ok(/mDNS/.test(fx('local', '', true)[0]) && /Tailscale/.test(fx('tailscale', '', true)[0]) && /TSDProxy/.test(fx('name', '', true)[0]) && /Restart/.test(fx('lan', 'connection refused (nothing listening)', false)[0]));
  assert.strictEqual(C.openUrl({ key: 'lan', url: 'http://host.docker.internal:1/' }, { lanHost: 'host.docker.internal' }), '');
  assert.strictEqual(C.openUrl({ key: 'tailscale', url: 'http://100.1.1.1:1/' }, { lanHost: 'host.docker.internal' }), 'http://100.1.1.1:1/');


// Tailscale name that cannot be looked up from inside the container: MagicDNS answer is used, and TSDProxy "Running" keeps the route up
(async () => {
  const srv = require('http').createServer((q, r) => { r.end('ok'); }).listen(0, '127.0.0.1'); await new Promise((r) => srv.on('listening', r));
  const p = await C.probe('http://x.macaw.ts.net:' + srv.address().port + '/', { tailnetResolver: async () => '127.0.0.1' }); assert.strictEqual(p.ok, true, 'a .ts.net name connects to the address MagicDNS gave'); srv.close();
  const dir = require('fs').mkdtempSync(require('os').tmpdir() + '/pmx-'); require('fs').mkdirSync(dir + '/app-a', { recursive: true });
  require('fs').writeFileSync(dir + '/app-a/umbrel-app.yml', 'id: app-a\nname: A\nversion: "1"\nport: 4101\n'); require('fs').writeFileSync(dir + '/app-a/docker-compose.yml', 'services:\n  web:\n    labels:\n      tsdproxy.enable: "true"\n      tsdproxy.name: "app-a"\n');
  let st = 'Running'; const dnsFail = async (u) => (u.includes('ts.net') ? { ok: false, status: 0, ms: 3, error: 'name not found (DNS)' } : { ok: true, status: 200, ms: 3, error: '' });
  const mon = C.makeMonitor({ dir, getConfig: () => ({ lanHost: 'h', tailscaleIp: '1.2.3.4', tailnet: 'x.ts.net', intervalMin: 5 }), probeImpl: dnsFail, proxyStatus: () => st });
  let r = await mon.run(); let n = r.apps[0].routes.find((x) => x.key === 'name'); assert.ok(n, 'name route exists'); assert.strictEqual(n.state, 'up', 'Running in TSDProxy: not down'); assert.strictEqual(n.via, 'tsdproxy', 'and it says so');
  st = 'Paused'; r = await mon.run(); r = await mon.run(); n = r.apps[0].routes.find((x) => x.key === 'name'); assert.strictEqual(n.state, 'down', 'a paused proxy still shows down');
  console.log('tailnet name fallback ok');
})().catch((e) => { console.error(e); process.exit(1); });

(() => { const C2 = require('./checker'); const tls = require('tls'); assert.ok(typeof C2.probe === 'function');
  // a self-signed https server must be reported as a certificate problem, not a raw message
  const https = require('https'), { execSync } = require('child_process'); let key, cert; try { const d = require('fs').mkdtempSync(require('os').tmpdir() + '/pmc-'); execSync(`openssl req -x509 -newkey rsa:2048 -nodes -keyout ${d}/k.pem -out ${d}/c.pem -days 1 -subj /CN=localhost 2>/dev/null`); key = require('fs').readFileSync(d + '/k.pem'); cert = require('fs').readFileSync(d + '/c.pem'); } catch { console.log('certificate label test skipped (no openssl)'); return; }
  const s = https.createServer({ key, cert }, (q, r) => r.end('x')).listen(0, '127.0.0.1', async () => { const r = await C2.probe('https://127.0.0.1:' + s.address().port + '/'); s.close(); assert.strictEqual(r.ok, false); assert.ok(/certificate/.test(r.error), r.error); console.log('certificate label ok'); });
})();
