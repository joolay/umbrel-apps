'use strict';
const assert = require('assert'), make = require('./repowatch');
const isNewer = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };
(async () => {
  const yml = (id, name, v) => 'manifestVersion: 1\nid: ' + id + '\nname: ' + name + '\nversion: "' + v + '"\ntagline: x\n';
  const files = { 'joolay-a': yml('joolay-a', 'Alpha', '1.2.0'), 'joolay-b': yml('joolay-b', 'Beta', '2.0.0'), 'joolay-c': yml('joolay-c', 'Gamma', '0.1.0') };
  let calls = 0, t = 1000;
  const fetchText = async (url) => {
    calls++;
    if (url.includes('api.github.com')) return JSON.stringify({ tree: [{ path: 'joolay-a', type: 'tree' }, { path: 'joolay-b', type: 'tree' }, { path: 'joolay-c', type: 'tree' }, { path: 'src', type: 'tree' }, { path: 'README.md', type: 'blob' }] });
    const id = /\/(joolay-[a-z]+)\/umbrel-app\.yml$/.exec(url)[1];
    return files[id];
  };
  const w = make({ fetchText, isNewer, now: () => t });
  await w.refresh();
  assert.strictEqual(w.state.error, null);
  assert.deepStrictEqual(Object.keys(w.state.apps).sort(), ['joolay-a', 'joolay-b', 'joolay-c']);
  const reg = new Map([['joolay-a', '1.1.0'], ['joolay-b', '2.0.0']]);
  assert.deepStrictEqual(w.pending(reg).map((p) => [p.id, p.kind, p.repo, p.umbrel]), [['joolay-a', 'update', '1.2.0', '1.1.0'], ['joolay-c', 'new', '0.1.0', null]]);
  assert.deepStrictEqual(w.pending(null), [], 'no registry, nothing can be said');
  reg.set('joolay-a', '1.2.0'); reg.set('joolay-c', '0.1.0');
  assert.deepStrictEqual(w.pending(reg), [], 'Umbrel caught up');
  const n = calls; await w.refresh(); assert.strictEqual(calls, n, 'throttled');
  t += 200000; await w.refresh(); assert.ok(calls > n, 'fetches again after the interval');
  const bad = make({ fetchText: async () => { throw new Error('offline'); }, isNewer, now: () => t });
  await bad.refresh(); assert.strictEqual(bad.state.error, 'offline'); assert.deepStrictEqual(bad.pending(reg), []);
  console.log('repowatch ok');
})().catch((e) => { console.error(e); process.exit(1); });
