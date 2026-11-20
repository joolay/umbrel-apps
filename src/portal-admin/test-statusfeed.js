'use strict';
const assert = require('assert'), makeFeed = require('./statusfeed');
(async () => {
  // cleaning: nothing secret-looking leaves
  const dirty = { name: 'x', password: 'hunter2', nested: { sessionToken: 'abc', ok: true }, log: ['Bearer abc.def.ghi', 'login with password=hunter2 failed', 'token ghp_' + 'a'.repeat(30), 'hash ' + 'f'.repeat(40), 'fine'], list: Array(400).fill(1), n: NaN };
  const c = makeFeed.clean(dirty), txt = JSON.stringify(c);
  assert.ok(!/hunter2|ghp_|abc\.def|ffffffff/.test(txt), txt);
  assert.strictEqual(c.password, '[hidden]'); assert.strictEqual(c.nested.sessionToken, '[hidden]'); assert.strictEqual(c.nested.ok, true); assert.strictEqual(c.list.length, 300); assert.strictEqual(c.n, null); assert.strictEqual(c.log[4], 'fine');

  // storage + publishing against fakes
  const rows = []; let t = 1e6;
  const asSuper = async (m, p, b) => {
    if (m === 'GET') return { items: rows.slice(0, 1) };
    // like PocketBase's json field: a string holding JSON comes back as the parsed value
    const asJson = (x) => { if (x && typeof x.value === 'string') { try { return { ...x, value: JSON.parse(x.value) }; } catch { /* plain string */ } } return x; };
    if (m === 'POST') { rows.push({ id: 'r1', ...asJson(b) }); return rows[0]; }
    if (m === 'PATCH') { Object.assign(rows[0], asJson(b)); return rows[0]; }
    if (m === 'DELETE') { rows.length = 0; return {}; }
  };
  const files = {}, calls = []; let conflict = 0;
  const fetchImpl = async (u, i = {}) => {
    calls.push([i.method || 'GET', u, i.headers && i.headers.authorization]);
    const key = u.split('/contents/')[1].split('?')[0];
    if (!i.method) return { status: files[key] ? 200 : 404, json: async () => ({ sha: files[key] && files[key].sha }) };
    if (conflict-- > 0) return { ok: false, status: 409 };
    const b = JSON.parse(i.body); files[key] = { sha: 's' + calls.length, text: Buffer.from(b.content, 'base64').toString(), branch: b.branch }; return { ok: true, status: 201 };
  };
  const feed = makeFeed({ asSuper, fetchImpl, now: () => t });
  assert.deepStrictEqual(await feed.publish('app-updater', { a: 1 }), { ok: false, skipped: 'not_configured' });
  await assert.rejects(() => feed.adminSave({ repo: 'bad', token: 'x'.repeat(30) }), /owner\/name/);
  await assert.rejects(() => feed.adminSave({ repo: 'joolay/tracking-data', dir: '../x', token: 'x'.repeat(30) }), /Folder/);
  await assert.rejects(() => feed.adminSave({ repo: 'joolay/tracking-data' }), /token/);
  let v = await feed.adminSave({ repo: 'joolay/tracking-data', dir: 'status', token: 'ghp_' + 'z'.repeat(30) });
  assert.strictEqual(v.configured, true); assert.strictEqual(v.hasToken, true); assert.ok(!JSON.stringify(v).includes('zzzz'), 'token never returned');
  v = await feed.adminSave({ repo: 'joolay/tracking-data', dir: 'status', token: '' }); assert.strictEqual(v.hasToken, true, 'blank token keeps the saved one');

  conflict = 1;
  assert.deepStrictEqual(await feed.publish('app-updater', { apps: [{ name: 'A', password: 'p' }] }), { ok: true });
  const f = files['status/app-updater.json']; assert.ok(f, 'file written under the app slug'); const j = JSON.parse(f.text); assert.strictEqual(j.app, 'app-updater'); assert.strictEqual(j.data.apps[0].password, '[hidden]'); assert.ok(calls.some((c) => c[2] === 'Bearer ghp_' + 'z'.repeat(30)));
  t += 5e3; assert.strictEqual((await feed.publish('app-updater', { apps: [] })).skipped, 'too_soon');
  t += 40e3; assert.strictEqual((await feed.publish('app-updater', { apps: [{ name: 'A', password: 'p' }] })).ok, true);      // different from the last one? same body: unchanged
  const n = calls.length; t += 40e3; assert.strictEqual((await feed.publish('app-updater', { apps: [{ name: 'A', password: 'p' }] })).skipped, 'unchanged'); assert.strictEqual(calls.length, n, 'no GitHub call when nothing changed');
  { t += 40e3; assert.strictEqual((await feed.publish('app-updater', { apps: [{ name: 'A', password: 'p' }], check: { at: t } })).ok, true); const m2 = calls.length;
    t += 40e3; assert.strictEqual((await feed.publish('app-updater', { apps: [{ name: 'A', password: 'p' }], check: { at: t } })).skipped, 'unchanged'); assert.strictEqual(calls.length, m2, 'a moving timestamp alone is not a change'); }
  t += 31 * 60e3; assert.strictEqual((await feed.publish('app-updater', { apps: [{ name: 'A', password: 'p' }] })).ok, true, 'refreshed after the heartbeat gap');
  await assert.rejects(() => feed.publish('../etc', {}), /Unknown app/); await assert.rejects(() => feed.publish('x', { big: 'y'.repeat(100) }.big && { a: Array(300).fill('z'.repeat(590)) }), /too large/);
  assert.match((await feed.test()).message, /status\/_portal-admin\.json/);
  assert.ok((await feed.adminView()).feeds.some((x) => x.app === 'app-updater' && x.ok));
  v = await feed.adminClear(); assert.strictEqual(v.configured, false);
  console.log('statusfeed ok');
})().catch((e) => { console.error(e); process.exit(1); });
