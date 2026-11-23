'use strict';
// End to end: a real Port Master process with temporary folders. Create, rename, fix a clash and remove a name; check the files TSDProxy would read.
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path'), { spawn } = require('child_process');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-')), apps = path.join(root, 'apps'), tsd = path.join(root, 'tsd'), data = path.join(root, 'data');
[apps, tsd, data].forEach((d) => fs.mkdirSync(d));
const mk = (id, port, label) => { fs.mkdirSync(path.join(apps, id)); fs.writeFileSync(path.join(apps, id, 'umbrel-app.yml'), `id: ${id}\nname: ${id}\nversion: "1"\nport: ${port}\n`); if (label) fs.writeFileSync(path.join(apps, id, 'docker-compose.yml'), `labels:\n  tsdproxy.enable: "true"\n  tsdproxy.name: "${label}"\n`); };
mk('joolay-a', 4101, 'taken'); mk('stremio', 4102); mk('bitcoin', 4103);
fs.writeFileSync(path.join(tsd, 'tsdproxy.yaml'), 'defaultProxyProvider: default\nlists:\n  joolz:\n    filename: /config/joolz-published.yaml\n');
const PORT = 3000 + Math.floor(Math.random() * 2000) + 30000 - 3000;
const env = { ...process.env, PORT: String(PORT), DATA_DIR: data, UMBREL_APP_DATA: apps, TSDPROXY_DIR: tsd, LAN_HOST: '127.0.0.1', LOCAL_HOST: '', TAILNET: 'tail1.ts.net' };
const child = spawn('node', ['server.js'], { env, stdio: ['ignore', 'ignore', 'inherit'] });
const call = async (m, p, b) => { const r = await fetch('http://127.0.0.1:' + PORT + p, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, j: await r.json() }; };
const row = (j, id) => j.names.rows.find((x) => x.appId === id), read = (f) => { try { return fs.readFileSync(path.join(tsd, f), 'utf8'); } catch { return null; } };
(async () => {
  for (let i = 0; i < 50; i++) { try { await call('GET', '/api/names'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  // automatic is on from the start: the first check names every app that has no name
  let r = await call('POST', '/api/check'); r = await call('GET', '/api/state'); assert.strictEqual(r.status, 200);
  assert.strictEqual(r.j.names.auto, true); assert.deepStrictEqual(r.j.names.rows.map((x) => [x.appId, x.tsdName]), [['bitcoin', 'bitcoin'], ['joolay-a', 'taken'], ['stremio', 'stremio']]);
  await call('POST', '/api/names', { op: 'auto', on: false }); await call('POST', '/api/names', { op: 'remove', appId: 'stremio' }); await call('POST', '/api/names', { op: 'remove', appId: 'bitcoin' });
  assert.strictEqual(row({ names: (await call('GET', '/api/names')).j }, 'bitcoin').state, 'none');
  let j = (await call('POST', '/api/names', { op: 'create', appId: 'stremio' })).j;
  assert.strictEqual(row(j, 'stremio').tsdName, 'stremio'); assert.strictEqual(row(j, 'stremio').source, 'names');
  assert.ok(/stremio:\n  ports:\n    443\/https:\n      targets:\n        - http:\/\/host.docker.internal:4102/.test(read('joolz-names.yaml')));
  assert.ok(/joolz-names:\n    filename: \/config\/joolz-names.yaml/.test(read('tsdproxy.yaml')) && /joolz:\n/.test(read('tsdproxy.yaml')), 'list switched on, the other list kept');
  assert.ok(read('restart-tsdproxy'), 'TSDProxy is asked to restart once'); assert.ok(read('tsdproxy.yaml.bak'));
  fs.unlinkSync(path.join(tsd, 'restart-tsdproxy'));
  assert.ok(j.report.apps.find((a) => a.id === 'stremio').routes.some((x) => x.key === 'name' && x.url === 'https://stremio.tail1.ts.net/'), 'the new name is checked like any other');
  // modify
  r = await call('POST', '/api/names', { op: 'rename', appId: 'stremio', name: 'Stream' }); assert.strictEqual(row(r.j, 'stremio').tsdName, 'stream'); assert.ok(!read('restart-tsdproxy'), 'no restart for a rename');
  r = await call('POST', '/api/names', { op: 'rename', appId: 'stremio', name: 'taken' }); assert.strictEqual(r.status, 400); assert.ok(/already used by joolay-a/.test(r.j.message));
  r = await call('POST', '/api/names', { op: 'rename', appId: 'joolay-a', name: 'other' }); assert.strictEqual(r.status, 400, 'a label name is not changed here');
  // fix: a hand-edited list file and a clash with a name the app gets later
  fs.writeFileSync(path.join(tsd, 'joolz-names.yaml'), '# edited\n'); r = await call('POST', '/api/check'); assert.ok(/stream:\n/.test(read('joolz-names.yaml')), 'the list file is written again');
  fs.writeFileSync(path.join(apps, 'stremio', 'docker-compose.yml'), 'labels:\n  tsdproxy.enable: "true"\n  tsdproxy.name: "own"\n'); r = await call('POST', '/api/check');
  assert.ok(!/stream:/.test(read('joolz-names.yaml')) && (await call('GET', '/api/names')).j.owned === 0, 'an app that got its own name loses ours');
  fs.writeFileSync(path.join(apps, 'stremio', 'docker-compose.yml'), '');
  // all at once, and a removed name stays removed while automatic is on
  await call('POST', '/api/check'); r = await call('POST', '/api/names', { op: 'create-all' }); assert.deepStrictEqual(r.j.names.rows.map((x) => x.state), ['ok', 'ok', 'ok']);
  r = await call('POST', '/api/names', { op: 'remove', appId: 'bitcoin' }); assert.strictEqual(row(r.j, 'bitcoin').state, 'none'); assert.ok(!/bitcoin:/.test(read('joolz-names.yaml')));
  r = await call('POST', '/api/names', { op: 'auto', on: true }); assert.strictEqual(r.j.names.auto, true); assert.strictEqual(row(r.j, 'bitcoin').state, 'none', 'removed by hand, so automatic leaves it alone'); r = await call('POST', '/api/names', { op: 'create', appId: 'bitcoin' }); assert.strictEqual(row(r.j, 'bitcoin').tsdName, 'bitcoin');
  r = await call('POST', '/api/names', { op: 'nope' }); assert.strictEqual(r.status, 400);
  fs.mkdirSync(path.join(apps, 'late')); fs.writeFileSync(path.join(apps, 'late', 'umbrel-app.yml'), 'id: late\nname: late\nversion: "1"\nport: 4104\n'); r = await call('POST', '/api/check');
  assert.strictEqual(row((await call('GET', '/api/names')).j && { names: (await call('GET', '/api/names')).j }, 'late').tsdName, 'late', 'with auto on, a new app gets a name');
  // the wish survives a restart
  child.kill(); console.log('names flow ok'); process.exit(0);
})().catch((e) => { console.error(e); child.kill(); process.exit(1); });
