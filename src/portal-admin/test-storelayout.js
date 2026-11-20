'use strict';
const assert = require('assert');
const rows = []; let n = 0;
const pb = { async asSuper(m, p, body) {
  if (m === 'GET') return { items: rows.filter((r) => decodeURIComponent(p).includes("key = 'store.layout'")) };
  if (m === 'POST') { const r = { id: 'r' + ++n, ...body }; rows.push(r); return r; }
  if (m === 'PATCH') { Object.assign(rows.find((r) => p.endsWith(r.id)), body); return {}; }
} };
const S = require('./storelayout')(pb);
(async () => {
  assert.strictEqual(await S.get(), null, 'nothing saved yet');
  const raw = { order: ['app:joolztv', 'folder:abc', 'app:joolztv', '<script>', 'app:in-folder'], dock: ['sys:family', 'sys:me', 'sys:xx', 'sys:a', 'sys:b', 'sys:c'], hidden: ['app:old', 'folder:abc'],
    folders: { abc: { name: '  <b>Media</b>\u0000 ', desc: 'Watch and listen', items: ['app:in-folder', 'folder:abc', 'bad id'] }, 'BAD ID': { name: 'x', items: [] } },
    names: { joolztv: ' Telly ', 'bad key!': 'x', listify: '' }, descs: { joolztv: ' Watch <TV> ', 'bad key!': 'x', listify: '' }, view: 'weird' };
  const c = S.clean(raw);
  assert.deepStrictEqual(c.order, ['app:joolztv', 'folder:abc'], 'ids are checked, duplicates and apps already in a folder dropped');
  assert.deepStrictEqual(c.dock, ['sys:family', 'sys:me', 'sys:xx', 'sys:a'], 'the dock holds at most four');
  assert.deepStrictEqual(c.hidden, ['app:old'], 'folders are never hidden');
  assert.deepStrictEqual(Object.keys(c.folders), ['abc']); assert.strictEqual(c.folders.abc.name, 'bMedia/b', 'markup characters are stripped');
  assert.strictEqual(c.folders.abc.desc, 'Watch and listen'); assert.deepStrictEqual(c.folders.abc.items, ['app:in-folder'], 'folders never nest');
  assert.deepStrictEqual(c.names, { joolztv: 'Telly' }); assert.deepStrictEqual(c.descs, { joolztv: 'Watch TV' }, 'descriptions are cleaned too'); assert.strictEqual(c.view, '');
  assert.strictEqual(S.clean(null), null); assert.strictEqual(S.clean([]), null); assert.strictEqual(S.clean('x'), null);
  const big = { order: Array.from({ length: 900 }, (_, i) => 'app:a' + i), folders: {} }; assert.strictEqual(S.clean(big).order.length, 300);
  await S.set(raw); assert.strictEqual(rows.length, 1); assert.strictEqual(rows[0].scope, 'global');
  await S.set({ order: ['app:x'] }); assert.strictEqual(rows.length, 1, 'saving again updates the one row'); assert.deepStrictEqual((await S.get()).order, ['app:x']);
  await assert.rejects(() => S.set('nope'), (e) => e.status === 400);
  // the Portal forwards the route, and the two route lists stay equal (CLAUDE.md); saving is guarded by the admin flag in server.js
  const src = require('fs').readFileSync(require('path').join(__dirname, 'server.js'), 'utf8');
  const list = /const PORTAL_ROUTES = new Set\(\[(.*?)\]\)/.exec(src)[1].split(',').map((x) => x.trim().replace(/'/g, '')).sort();
  assert.deepStrictEqual(require('./portal').VIA_ADMIN.slice().sort(), list, 'portal.js VIA_ADMIN equals server.js PORTAL_ROUTES'); assert.ok(list.includes('/store/layout'));
  assert.ok(/if \(!user\.isAdmin\) return send\(res, 403, \{ message: 'Only an admin can change the App Store\.' \}\)/.test(src), 'only admins can save the layout');
  console.log('storelayout ok'); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
