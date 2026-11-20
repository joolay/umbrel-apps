'use strict';
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path'), zlib = require('zlib');
const { untar, parseArchive, makeRegistry } = require('./official'), { findPortClashes } = require('./clashes');
// A small tar writer, so the archive reader is tested on real tar bytes (GitHub archives start with a pax global header, which is included here).
const hdr = (name, size, type) => { const h = Buffer.alloc(512); h.write(name, 0); h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116); h.write(size.toString(8).padStart(11, '0') + '\0', 124); h.write('00000000000\0', 136); h.write(' ', 148); h.write(type, 156); h.write('ustar\0', 257); h.write('00', 263); let sum = 0; for (const b of h) sum += b; h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148); return h; };
const tar = (files, root = 'umbrel-apps-abc') => { const parts = [hdr('pax_global_header', 52, 'g'), Buffer.from('52 comment=0123456789abcdef0123456789abcdef01234567\n'.padEnd(512, '\0'))];
  for (const [n, t] of Object.entries(files)) { const d = Buffer.from(t); parts.push(hdr(root + '/' + n, d.length, '0'), d, Buffer.alloc((512 - (d.length % 512)) % 512)); } parts.push(Buffer.alloc(1024)); return Buffer.concat(parts); };
const man = (id, port) => `id: ${id}\nname: ${id.toUpperCase()}\nversion: "1.0.0"\nport: ${port}\n`;
(async () => {
  const files = { 'alpha/umbrel-app.yml': man('alpha', 8080), 'alpha/docker-compose.yml': 'ports:\n  - "9001:9001"\n  - 22000:22000/tcp\n', 'beta/umbrel-app.yml': man('beta', 3900), 'gamma/umbrel-app.yml': 'id: gamma\nname: G\nversion: "1"\n', 'alpha/data/deep/umbrel-app.yml': man('deep', 1234), 'README.md': 'x' };
  const got = untar(tar(files)); assert.deepStrictEqual(Object.keys(got).sort(), ['alpha/docker-compose.yml', 'alpha/umbrel-app.yml', 'beta/umbrel-app.yml', 'gamma/umbrel-app.yml']);
  const apps = parseArchive(zlib.gzipSync(tar(files))); assert.deepStrictEqual(apps, [{ id: 'alpha', name: 'ALPHA', port: 8080, hostPorts: [9001, 22000] }, { id: 'beta', name: 'BETA', port: 3900, hostPorts: [] }], 'apps without a port are left out');
  // clashes: the official app keeps the port, the other app is flagged, official apps that are not installed still keep theirs
  const official = [{ id: 'alpha', name: 'Alpha', port: 8080, hostPorts: [9001] }, { id: 'beta', name: 'Beta', port: 3900, hostPorts: [] }, { id: 'gamma', name: 'Gamma', port: 7000, hostPorts: [] }];
  const inst = [{ id: 'alpha', name: 'Alpha', port: 8080, hostPorts: [9001], joolzapp: false }, { id: 'joolay-x', name: 'X', port: 3900, hostPorts: [], joolzapp: true }, { id: 'joolay-y', name: 'Y', port: 7000, hostPorts: [9001], joolzapp: true }, { id: 'joolay-z', name: 'Z', port: 4000, hostPorts: [], joolzapp: true }];
  const cl = findPortClashes(inst, official);
  assert.deepStrictEqual(cl.map((c) => c.port), [3900, 7000, 9001]);
  assert.deepStrictEqual(cl[0].keep.map((p) => [p.id, p.installed]), [['beta', false]], 'an official app that is not installed still keeps its port');
  assert.deepStrictEqual(cl[0].change.map((p) => [p.id, p.source, p.suggestedPort]), [['joolay-x', 'joolzapp', 3901]]);
  assert.deepStrictEqual(cl[1].change.map((p) => p.id), ['joolay-y']); assert.strictEqual(cl[1].change[0].suggestedPort, 7001);
  assert.deepStrictEqual(cl[2].change.map((p) => [p.id, p.kind]), [['joolay-y', 'published']]); assert.strictEqual(cl[2].keep[0].id, 'alpha');
  assert.ok(new Set(cl.flatMap((c) => c.change.map((p) => p.suggestedPort))).size === 3, 'suggested ports are all different');
  assert.ok(!cl.some((c) => c.change.some((p) => p.id === 'alpha')), 'an installed official app is never flagged');
  // no official app involved: another store's app wins over a JoolzApp app; equal rank keeps the first id
  const two = findPortClashes([{ id: 'joolay-a', name: 'A', port: 5000, hostPorts: [], joolzapp: true }, { id: 'someapp', name: 'S', port: 5000, hostPorts: [], joolzapp: false }], []);
  assert.deepStrictEqual([two[0].keep[0].id, two[0].change[0].id], ['someapp', 'joolay-a']);
  const eq = findPortClashes([{ id: 'joolay-b', name: 'B', port: 5000, hostPorts: [], joolzapp: true }, { id: 'joolay-a', name: 'A', port: 5000, hostPorts: [], joolzapp: true }], []); assert.deepStrictEqual([eq[0].keep[0].id, eq[0].change[0].id], ['joolay-a', 'joolay-b']);
  assert.deepStrictEqual(findPortClashes([{ id: 'alpha', name: 'A', port: 8080, hostPorts: [], joolzapp: false }, { id: 'gamma', name: 'G', port: 8080, hostPorts: [], joolzapp: false }], official.concat([{ id: 'gamma', name: 'G', port: 8080, hostPorts: [] }])), [], 'two official apps are not reported');
  assert.deepStrictEqual(findPortClashes([{ id: 'joolay-a', name: 'A', port: 5000, hostPorts: [], joolzapp: true }], official), [], 'no clash');
  // the registry: keeps a good list on disk, survives a failed refresh, and goes stale after a week
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-')), file = path.join(dir, 'official-ports.json'), many = {}; for (let i = 0; i < 25; i++) many['app' + i + '/umbrel-app.yml'] = man('app' + i, 6000 + i);
  const gz = zlib.gzipSync(tar(many)); let t = 1e12, fail = false;
  const reg = makeRegistry({ file, url: 'http://x/', now: () => t, fetchImpl: async () => (fail ? { ok: false, status: 503 } : { ok: true, status: 200, arrayBuffer: async () => gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.length) }) });
  assert.ok(reg.stale && reg.count === 0); await reg.refresh(); assert.strictEqual(reg.count, 25); assert.ok(!reg.stale && !reg.error);
  const again = makeRegistry({ file, url: 'http://x/', now: () => t }); assert.strictEqual(again.count, 25, 'read back from the data folder');
  t += 8 * 24 * 3600e3; assert.ok(reg.stale); fail = true; await reg.refresh(); assert.strictEqual(reg.count, 25, 'a failed refresh keeps the old list'); assert.ok(/503/.test(reg.error)); assert.ok(reg.stale);
  fail = false; await reg.refresh(); assert.ok(!reg.stale && !reg.error);
  const tiny = makeRegistry({ file: path.join(dir, 'b.json'), url: 'http://x/', fetchImpl: async () => ({ ok: true, arrayBuffer: async () => zlib.gzipSync(tar({ 'a/umbrel-app.yml': man('a', 1) })) }) }); await tiny.refresh(); assert.ok(/looked wrong/.test(tiny.error) && tiny.count === 0);
  // the real official store, when a copy of its archive is at OFFICIAL_TGZ (optional)
  if (process.env.OFFICIAL_TGZ) { const real = parseArchive(fs.readFileSync(process.env.OFFICIAL_TGZ)); assert.ok(real.length > 200, 'real store: ' + real.length); console.log('real official apps with a port:', real.length); }
  console.log('clashes ok'); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
