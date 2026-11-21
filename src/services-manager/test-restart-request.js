'use strict';
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path'), { makeWatcher, MARKER } = require('./restart-request');
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-')), calls = []; let t = 1000000;
  const docker = async (m, p) => { calls.push(m + ' ' + p.split('?')[0]); return m === 'GET' ? [{ Id: 'abc', Image: 'almeidapaulopt/tsdproxy:2' }, { Id: 'x', Image: 'other' }] : ''; };
  const w = makeWatcher({ dir, docker, now: () => t });
  assert.strictEqual(await w(), 'none');
  fs.writeFileSync(path.join(dir, MARKER), new Date(t).toISOString());
  t += 29000; assert.strictEqual(await w(), 'waiting'); assert.deepStrictEqual(calls, []);
  t += 1500; assert.strictEqual(await w(), 'restarted'); assert.deepStrictEqual(calls, ['GET /containers/json', 'POST /containers/abc/restart']);
  assert.ok(!fs.existsSync(path.join(dir, MARKER))); assert.strictEqual(await w(), 'none');
  fs.writeFileSync(path.join(dir, MARKER), new Date(t - 2 * 24 * 3600 * 1000).toISOString()); assert.strictEqual(await w(), 'stale'); assert.ok(!fs.existsSync(path.join(dir, MARKER)));
  const none = makeWatcher({ dir, docker: async () => [], now: () => t }); fs.writeFileSync(path.join(dir, MARKER), new Date(t - 40000).toISOString());
  assert.strictEqual(await none(), 'skipped'); assert.ok(fs.existsSync(path.join(dir, MARKER)));
  console.log('restart-request ok');
})();
