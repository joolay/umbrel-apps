'use strict';
const assert = require('assert'), make = require('./portalapps');
(async () => {
  const sets = [], rows = [{ id: 'r1', slug: 'listify', name: 'Listify', url: 'https://l', enabled: true }], audits = [];
  const pbx = { asSuper: async (m, p, b) => {
    if (p.includes('portal_audit')) { audits.push(b); return {}; }
    if (p.includes('portal_settings')) {
      if (m === 'GET') { const sl = /app%20%3D%20'([^']+)'/.exec(p); return { items: sets.filter((x) => (!sl || x.app === sl[1]) && x.value === true || (sl && x.app === sl[1])) }; }
      if (m === 'POST') { sets.push({ id: 's' + sets.length, ...b }); return {}; }
      if (m === 'PATCH') { Object.assign(sets.find((x) => p.endsWith('/' + x.id)), b); return {}; }
      if (m === 'DELETE') { sets.splice(sets.findIndex((x) => p.endsWith('/' + x.id)), 1); return {}; }
    }
    if (m === 'GET' && p.includes('filter=')) { const s = /slug%20%3D%20'([^']+)'/.exec(p)[1]; return { items: rows.filter((r) => r.slug === s) }; }
    if (m === 'GET') return { items: rows };
    if (m === 'POST') { rows.push({ id: 'n' + rows.length, ...b }); return {}; }
    if (m === 'PATCH') { Object.assign(rows.find((r) => p.endsWith('/' + r.id)), b); return {}; }
  } };
  const apps = [{ id: 'stremio', dir: 'stremio', name: 'Stremio', slug: '' }, { id: 'joolay-listify', dir: 'joolay-listify', name: 'Listify', slug: 'listify' }, { id: 'ollama', dir: 'ollama', name: 'Ollama', slug: '' }, { id: 'listify', dir: 'listify', name: 'Official Listify', slug: '' }];
  const P = make({ pbx, installedApps: () => ({ apps }) });
  await assert.rejects(() => P.add('joolay-listify', { id: 'stremio', url: 'https://x' }), /Only Port Master/);
  await assert.rejects(() => P.list('theme-editor'), /Only Port Master/);
  await assert.rejects(() => P.add('routing-reporter', { id: 'nope', url: 'https://x' }), /not installed/);
  await assert.rejects(() => P.add('routing-reporter', { id: 'joolay-listify', url: 'https://x' }), /JoolzApp apps/);
  await assert.rejects(() => P.add('routing-reporter', { id: 'listify', url: 'https://x' }), /belongs to one of your JoolzApp/);
  await assert.rejects(() => P.add('routing-reporter', { id: 'stremio', url: 'javascript:alert(1)' }), /address/);
  await assert.rejects(() => P.add('routing-reporter', { id: 'stremio', url: 'https://u:p@x.ts.net' }), /address/);
  assert.deepStrictEqual(await P.add('routing-reporter', { id: 'stremio', name: 'My <b>Stremio</b>', description: 'Movies', url: 'https://stremio.tail1.ts.net/' }), { slug: 'stremio', created: true });
  const r = rows.find((x) => x.slug === 'stremio'); assert.strictEqual(r.name, 'My bStremio/b'); assert.strictEqual(r.url, 'https://stremio.tail1.ts.net'); assert.strictEqual(r.enabled, true); assert.strictEqual(audits[0].action, 'app.create');
  assert.deepStrictEqual(await P.remove('routing-reporter', 'stremio'), { removed: true }); assert.strictEqual(r.enabled, false);
  assert.deepStrictEqual(await P.add('routing-reporter', { id: 'stremio', url: 'http://100.64.0.9:3910' }), { slug: 'stremio', created: false }); assert.strictEqual(r.enabled, true); assert.strictEqual(rows.filter((x) => x.slug === 'stremio').length, 1);
  await assert.rejects(() => P.remove('routing-reporter', 'listify'), /JoolzApp/);
  assert.deepStrictEqual(await P.remove('routing-reporter', 'unknown-thing'), { removed: false });
  assert.strictEqual(sets.length, 1); assert.strictEqual(sets[0].app, 'stremio'); assert.strictEqual(sets[0].value, true); assert.strictEqual(sets[0].key, 'app.adminOnly');   // default audience = admins only
  assert.strictEqual((await P.list('routing-reporter')).find((x) => x.slug === 'stremio').audience, 'admins');
  await P.add('routing-reporter', { id: 'stremio', url: 'https://x.ts.net', audience: 'all' }); assert.strictEqual(sets.length, 0);
  sets.push({ id: 'z', scope: 'app', app: 'ollama', key: 'app.adminOnly', value: true, note: 'someone else made this' });
  await P.add('routing-reporter', { id: 'ollama', url: 'https://o.ts.net', audience: 'all' }); assert.strictEqual(sets.length, 1);   // a row Port Master did not make is left alone
  assert.ok((await P.list('routing-reporter')).some((x) => x.slug === 'stremio' && x.enabled));
  console.log('portalapps ok');
})().catch((e) => { console.error(e); process.exit(1); });
