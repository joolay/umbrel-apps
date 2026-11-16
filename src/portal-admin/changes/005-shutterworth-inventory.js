'use strict';
// ShutterWorth keeps each person's inventory (items and photos) in two collections. This makes sure they exist and that ONLY
// ShutterWorth's own limited login can read or write them, so the app no longer needs the superuser login for its inventory.
const APP = 'shutterworth';
const RULE = '@request.auth.collectionName = "app_service" && @request.auth.appId = "' + APP + '"';
const RULES = { listRule: RULE, viewRule: RULE, createRule: RULE, updateRule: RULE, deleteRule: RULE };
const COLS = {
  sw_docs: [
    { name: 'owner', type: 'text', required: true }, { name: 'path', type: 'text', required: true },
    { name: 'data', type: 'json', required: false, maxSize: 5242880 },
  ],
  sw_photos: [
    { name: 'owner', type: 'text', required: true }, { name: 'pid', type: 'text', required: true },
    { name: 'file', type: 'file', required: false, maxSelect: 1, maxSize: 15728640 },
  ],
};
const stale = (col) => Object.entries(RULES).filter(([k, v]) => (col[k] ?? null) !== v).map(([k]) => k.replace('Rule', ''));

module.exports = {
  id: '005-shutterworth-inventory',
  title: 'ShutterWorth inventory storage',
  summary: 'ShutterWorth stores inventory items and photos in PocketBase. Only ShutterWorth\'s own limited login will be able to read or write them, so the app no longer needs the superuser login for this.',
  async plan(c) {
    const out = [];
    if (!c.apps().some(a => a.slug === APP)) return out;           // ShutterWorth not installed: nothing to do
    if (!(await c.getCollection('app_service'))) return ['Run "Limited login for each app" first'];
    for (const [name] of Object.entries(COLS)) {
      const col = await c.getCollection(name);
      if (!col) out.push(`Create the ${name} collection (only ShutterWorth's login can use it)`);
      else { const s = stale(col); if (s.length) out.push(`Restrict ${name} to ShutterWorth's login (${s.join(', ')} rules)`); }
    }
    return out;
  },
  async apply(c) {
    if (!c.apps().some(a => a.slug === APP)) return ['ShutterWorth is not installed, so nothing was changed.'];
    if (!(await c.getCollection('app_service'))) throw new Error('Run "Limited login for each app" first.');
    for (const [name, fields] of Object.entries(COLS)) {
      const col = await c.getCollection(name);
      if (!col) {
        await c.pb('POST', '/api/collections', {
          name, type: 'base', fields, ...RULES,
          indexes: [`CREATE UNIQUE INDEX idx_${name}_owner_key ON ${name} (owner, ${fields[1].name})`],
        });
      } else if (stale(col).length) await c.pb('PATCH', '/api/collections/' + name, RULES);
    }
    return ['Inventory stays private to ShutterWorth. Update ShutterWorth to use it; until then it keeps using the superuser login.'];
  },
};
