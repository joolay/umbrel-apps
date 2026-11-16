'use strict';
// Diner Bell (shared menus) and Jolly Grocer (each person's lists and archived receipts) keep their own data in PocketBase. This makes
// sure those collections exist, have every field the apps need, and that ONLY the owning app's limited login can read or write them,
// so neither app needs the superuser login for its own data. From here on these collections are looked after by this card, not by the apps.
const json = (name, maxSize) => ({ name, type: 'json', required: false, maxSize });
const text = (name, required) => ({ name, type: 'text', required: !!required });
const APPS = {
  'diner-bell': {
    name: 'Diner Bell',
    cols: {
      grubtogo_menus: { fields: [text('owner', true), text('ownerName'), text('name', true), text('phone'), text('currency'), json('categories', 5000000), json('branches', 200000), text('version'), text('versionByName'), text('wa'), json('rerenderReq', 20000), json('logo', 600000)] },
      grubtogo_menu_archive: { fields: [text('menuId', true), text('version'), text('byName'), json('data', 5000000)] },
      grubtogo_menu_sources: { fields: [text('menuId', true), text('kind'), text('name'), text('mime'), text('byName'), { name: 'size', type: 'number', required: false }, json('data', 9000000)] },
    },
  },
  'jolly-grocer': {
    name: 'Jolly Grocer',
    cols: {
      jollygrocer_state: { fields: [text('owner', true), json('data', 10485760)], unique: 'owner' },
      jollygrocer_receipts: { fields: [text('owner', true), text('rid', true), { name: 'file', type: 'file', required: false, maxSelect: 1, maxSize: 5242880 }], unique: 'owner, rid' },
    },
  },
};
const rulesFor = (app) => { const r = '@request.auth.collectionName = "app_service" && @request.auth.appId = "' + app + '"'; return { listRule: r, viewRule: r, createRule: r, updateRule: r, deleteRule: r }; };
const staleRules = (col, rules) => Object.entries(rules).filter(([k, v]) => (col[k] ?? null) !== v).map(([k]) => k.replace('Rule', ''));
const missing = (col, fields) => fields.filter((f) => !(col.fields || []).some((h) => h.name === f.name));
const installed = (c) => Object.keys(APPS).filter((slug) => c.apps().some((a) => a.slug === slug));

module.exports = {
  id: '009-app-data-storage',
  title: 'App data storage (Diner Bell, Jolly Grocer)',
  summary: "Diner Bell's menus and Jolly Grocer's lists and receipts are stored in PocketBase. Only each app's own limited login will be able to read or write its data, so the apps no longer need the superuser login for it. Nothing stored is changed.",
  async plan(c) {
    const out = [], apps = installed(c);
    if (!apps.length) return out;
    if (!(await c.getCollection('app_service'))) return ['Run "Limited login for each app" first'];
    for (const slug of apps) {
      const { name, cols } = APPS[slug], rules = rulesFor(slug);
      for (const [cn, def] of Object.entries(cols)) {
        const col = await c.getCollection(cn);
        if (!col) { out.push(`Create the ${cn} collection (only ${name}'s login can use it)`); continue; }
        const add = missing(col, def.fields), st = staleRules(col, rules);
        if (add.length) out.push(`Add ${add.map((f) => f.name).join(', ')} to ${cn}`);
        if (st.length) out.push(`Restrict ${cn} to ${name}'s login (${st.join(', ')} rules)`);
      }
    }
    return out;
  },
  async apply(c) {
    const apps = installed(c);
    if (!apps.length) return ['Neither app is installed, so nothing was changed.'];
    if (!(await c.getCollection('app_service'))) throw new Error('Run "Limited login for each app" first.');
    for (const slug of apps) {
      const { cols } = APPS[slug], rules = rulesFor(slug);
      for (const [cn, def] of Object.entries(cols)) {
        const col = await c.getCollection(cn);
        if (!col) {
          await c.pb('POST', '/api/collections', { name: cn, type: 'base', fields: def.fields, ...rules, indexes: def.unique ? [`CREATE UNIQUE INDEX \`idx_${cn}_owner_key\` ON \`${cn}\` (${def.unique.split(', ').map((x) => '`' + x + '`').join(', ')})`] : [] });
          continue;
        }
        const patch = {}, add = missing(col, def.fields);
        if (add.length) patch.fields = [...(col.fields || []), ...add];
        if (staleRules(col, rules).length) Object.assign(patch, rules);
        if (Object.keys(patch).length) await c.pb('PATCH', '/api/collections/' + cn, patch);
      }
    }
    return ['Update Diner Bell and Jolly Grocer so they use their own logins for this. Until then they keep using the superuser login, which still works.'];
  },
};
