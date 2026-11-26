// node test-tsdpublished.js : change 014 publishes OpenClaw (our build or the Umbrel store's) at https://openclaw.<tailnet>, tailnet only.
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path');
const ch = require('./changes/014-tsdproxy-published');
const mk = (apps) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tsd-')); fs.writeFileSync(path.join(d, 'tsdproxy.yaml'), 'lists:\n  joolz:\n    filename: /config/joolz-published.yaml\n'); return { tsdDir: d, installedApps: () => ({ apps }) }; };
(async () => {
  // not installed: nothing to do
  assert.deepStrictEqual(await ch.plan(mk([{ id: 'wallos', port: 8282 }])), []);
  // our own build
  let c = mk([{ id: 'joolay-openclaw', port: 3927 }]);
  assert.ok((await ch.plan(c)).some((x) => /port 3927/.test(x)));
  await ch.apply(c);
  const f = fs.readFileSync(path.join(c.tsdDir, 'joolz-published.yaml'), 'utf8');
  assert.ok(/^openclaw:\n/m.test(f) && f.includes('http://host.docker.internal:3927') && f.includes('443/https'), f);
  assert.deepStrictEqual(await ch.plan(c), [], 'applied: nothing left to do');
  // the Umbrel store's app still works, and a stale list entry is rewritten when our build replaces it
  c = mk([{ id: 'openclaw', port: 18789 }]); await ch.apply(c);
  assert.ok(fs.readFileSync(path.join(c.tsdDir, 'joolz-published.yaml'), 'utf8').includes(':18789'));
  const c2 = { tsdDir: c.tsdDir, installedApps: () => ({ apps: [{ id: 'joolay-openclaw', port: 3927 }] }) };
  assert.ok((await ch.plan(c2)).some((x) => /port 3927/.test(x)));
  await ch.apply(c2); assert.ok(fs.readFileSync(path.join(c.tsdDir, 'joolz-published.yaml'), 'utf8').includes(':3927'));
  console.log('tsdpublished ok');
})().catch((e) => { console.error(e); process.exit(1); });
