'use strict';
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path');
const T = require('./tsdproxy');
(async () => {
  // helpers
  assert.deepStrictEqual(T.listProxies([{ name: 'Joolzapp', status: 'Running' }, { Name: 'x', Status: 'Paused' }]), [{ name: 'joolzapp', status: 'Running', paused: false }, { name: 'x', status: 'Paused', paused: true }]);
  assert.deepStrictEqual(T.listProxies({ proxies: [{ name: 'a', status: 'paused' }] })[0].paused, true);
  assert.deepStrictEqual(T.listProxies({ a: { status: 'Running' } }), [{ name: 'a', status: 'Running', paused: false }]);
  assert.ok(T.hasKeyLine('x: 1\napiKey: "k"\n') && T.hasKeyLine('apiKeyFile: /config/a') && !T.hasKeyLine('# apiKey: x\nlists:\n'));
  assert.ok(/apiKeyFile: "\/config\/tsdproxy-api.key"\n$/.test(T.withKeyFile('a:\n  b: 1')));
  assert.deepStrictEqual(T.splitImage('almeidapaulopt/tsdproxy:2'), { repo: 'almeidapaulopt/tsdproxy', tag: '2' });
  assert.deepStrictEqual(T.splitImage('localhost:5000/x'), { repo: 'localhost:5000/x', tag: 'latest' });
  const at = (h, m) => new Date(2026, 10, 22, h, m);
  assert.ok(T.inWindow(at(3, 30), '03:30') && T.inWindow(at(4, 29), '03:30') && !T.inWindow(at(4, 30), '03:30') && !T.inWindow(at(3, 29), '03:30') && T.inWindow(at(0, 10), '23:30'));

  // keeper with a fake Docker and a fake TSDProxy API
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsd-')); fs.writeFileSync(path.join(dir, 'tsdproxy.yaml'), 'lists:\n  joolz:\n    filename: /config/joolz-published.yaml\n');
  const calls = []; let imgId = 'sha256:aaaaaaaaaaaaaaaa', pulled = 'sha256:aaaaaaaaaaaaaaaa';
  const info = () => ({ Id: 'cid', Name: '/tsdproxy-tsdproxy-1', Image: imgId, Config: { Image: 'almeidapaulopt/tsdproxy:2', Hostname: 'cid', Labels: { a: 'b' } }, HostConfig: { PortBindings: {} }, State: { Running: true }, NetworkSettings: { Networks: { tsd_default: { IPAddress: '172.30.0.2', Aliases: ['tsdproxy', 'cid'] } } } });
  const docker = async (m, p) => {
    calls.push(m + ' ' + p.split('?')[0]);
    if (m === 'GET' && p.startsWith('/containers/json')) return [{ Id: 'cid', Image: 'almeidapaulopt/tsdproxy:2' }];
    if (m === 'GET' && p === '/containers/cid/json') return info();
    if (m === 'GET' && p === '/containers/nid/json') return { State: { Running: true } };
    if (m === 'GET' && p.startsWith('/images/almeidapaulopt/tsdproxy:2')) return { Id: pulled, Created: 'x', Config: { Labels: { 'org.opencontainers.image.version': '2.3.0' } } };
    if (m === 'GET' && p.startsWith('/images/')) return { Id: imgId, Config: { Labels: { 'org.opencontainers.image.version': '2.2.0' } } };
    if (m === 'POST' && p.startsWith('/containers/create')) return { Id: 'nid' };
    return '';
  };
  let paused = new Set(); const apiCalls = [];
  const api = async (base, m, p) => {
    apiCalls.push(m + ' ' + p);
    if (base !== 'http://172.30.0.2:8080') return { status: 0, error: 'ECONNREFUSED' };
    if (p === '/api/version') return { status: 200, json: { version: '2.2.0', commit: 'abc' } };
    if (p === '/api/v1/proxies') return { status: 200, json: [{ name: 'joolzapp', status: paused.has('joolzapp') ? 'Paused' : 'Running' }, { name: 'port-master', status: 'Running' }] };
    const m2 = /^\/api\/proxy\/([^/]+)\/(pause|resume)$/.exec(p); if (m2) { if (m2[2] === 'pause') paused.add(m2[1]); else paused.delete(m2[1]); return { status: 200, json: { status: 'ok' } }; }
    return { status: 404 };
  };
  let t = new Date(2026, 10, 22, 12, 0).getTime();
  const k = T.makeKeeper({ dir, docker, api, now: () => t, selfId: 'self', sleep: async () => {} });

  let s = await k.tick();                                   // first run: key is created, TSDProxy restarted, API reached on its Docker address
  assert.ok(fs.existsSync(path.join(dir, 'tsdproxy-api.key')) && T.hasKeyLine(fs.readFileSync(path.join(dir, 'tsdproxy.yaml'), 'utf8')) && fs.existsSync(path.join(dir, 'tsdproxy.yaml.bak')));
  assert.ok(calls.includes('POST /containers/cid/restart'));
  assert.strictEqual(s.api.reachable, true); assert.strictEqual(s.api.version, '2.2.0'); assert.strictEqual(s.container.version, '2.2.0'); assert.strictEqual(s.update.available, false);
  assert.ok(calls.includes('POST /networks/tsd_default/connect'));
  calls.length = 0; await k.tick(); assert.ok(!calls.includes('POST /containers/cid/restart'), 'key is added only once');

  // pause / resume follow joolz-paused.json, and only resume what we paused
  fs.writeFileSync(path.join(dir, 'joolz-paused.json'), JSON.stringify({ paused: ['joolzapp'] })); s = await k.tick();
  assert.ok(paused.has('joolzapp') && s.proxies.find((x) => x.name === 'joolzapp').paused);
  fs.writeFileSync(path.join(dir, 'joolz-paused.json'), JSON.stringify({ paused: [] })); s = await k.tick();
  assert.ok(!paused.has('joolzapp')); paused.add('port-master');    // paused by hand in TSDProxy's own dashboard: left alone
  await k.tick(); assert.ok(paused.has('port-master'));

  // update: a newer image is found, but nothing happens outside the window
  pulled = 'sha256:bbbbbbbbbbbbbbbb'; t += 13 * 3600e3; s = await k.tick();      // 01:00 next day
  assert.strictEqual(s.update.available, true); assert.strictEqual(s.update.latestVersion, '2.3.0'); assert.ok(!calls.includes('POST /containers/create'));
  // "Update now" request
  fs.writeFileSync(path.join(dir, 'tsdproxy-update-request'), new Date(t).toISOString()); calls.length = 0; s = await k.tick();
  assert.deepStrictEqual(calls.filter((c) => /containers/.test(c) && /create|stop|rename|start|DELETE/.test(c)), ['POST /containers/create', 'POST /containers/cid/stop', 'POST /containers/cid/rename', 'POST /containers/nid/rename', 'POST /containers/nid/start', 'DELETE /containers/cid']);
  assert.strictEqual(s.update.last.ok, true); assert.ok(!fs.existsSync(path.join(dir, 'tsdproxy-update-request')));
  // nightly window
  imgId = pulled; pulled = 'sha256:cccccccccccccccc'; t = new Date(2026, 10, 24, 3, 40).getTime(); calls.length = 0; s = await k.tick();
  assert.ok(calls.includes('POST /containers/create') && s.update.last.by === 'nightly');
  // failed new container: old one is put back
  imgId = pulled; pulled = 'sha256:dddddddddddddddd'; t = new Date(2026, 10, 26, 3, 40).getTime(); calls.length = 0;
  const bad = async (m, p) => (m === 'GET' && p === '/containers/nid/json' ? { State: { Running: false } } : docker(m, p));
  const k2 = T.makeKeeper({ dir, docker: bad, api, now: () => t, selfId: 'self', sleep: async () => {} }); s = await k2.tick();
  assert.strictEqual(s.update.last.ok, false); assert.ok(/put back/.test(s.update.last.message)); assert.ok(calls.filter((c) => c === 'POST /containers/cid/rename').length >= 1);
  // switched off
  fs.writeFileSync(path.join(dir, 'tsdproxy-settings.json'), JSON.stringify({ autoUpdate: false })); t = new Date(2026, 10, 28, 3, 40).getTime(); calls.length = 0; const k3 = T.makeKeeper({ dir, docker, api, now: () => t, selfId: 'self', sleep: async () => {} }); s = await k3.tick();
  assert.ok(!calls.includes('POST /containers/create') && s.settings.autoUpdate === false);
  console.log('tsdproxy ok');
})().catch((e) => { console.error(e); process.exit(1); });
