'use strict';
// Gym Guru keeps each person's workout sets and learned machines in one PocketBase collection. This makes sure it exists with the fields the app
// needs, and that ONLY Gym Guru's own limited login can read or write it.
const SLUG = 'gym-guru', COL = 'gymguru_data';
const FIELDS = [{ name: 'owner', type: 'text', required: true }, { name: 'key', type: 'text', required: true }, { name: 'data', type: 'json', required: false, maxSize: 5000000 }];
const rules = () => { const r = '@request.auth.collectionName = "app_service" && @request.auth.appId = "' + SLUG + '"'; return { listRule: r, viewRule: r, createRule: r, updateRule: r, deleteRule: r }; };
const stale = (col) => Object.entries(rules()).filter(([k, v]) => (col[k] ?? null) !== v).map(([k]) => k.replace('Rule', ''));
const missing = (col) => FIELDS.filter((f) => !(col.fields || []).some((h) => h.name === f.name));

module.exports = {
  id: '015-gym-guru-storage',
  title: 'Gym Guru storage',
  summary: "Each person's workout sets and learned machines are stored in PocketBase. Only Gym Guru's own limited login will be able to read or write them. Nothing existing is changed.",
  async plan(c) {
    if (!c.apps().some((a) => a.slug === SLUG)) return [];
    if (!(await c.getCollection('app_service'))) return ['Run "Limited login for each app" first'];
    const col = await c.getCollection(COL), out = [];
    if (!col) return [`Create the ${COL} collection (only Gym Guru's login can use it)`];
    const add = missing(col), st = stale(col);
    if (add.length) out.push(`Add ${add.map((f) => f.name).join(', ')} to ${COL}`);
    if (st.length) out.push(`Restrict ${COL} to Gym Guru's login (${st.join(', ')} rules)`);
    return out;
  },
  async apply(c) {
    if (!c.apps().some((a) => a.slug === SLUG)) return ['Gym Guru is not installed, so nothing was changed.'];
    if (!(await c.getCollection('app_service'))) throw new Error('Run "Limited login for each app" first.');
    const col = await c.getCollection(COL);
    if (!col) {
      await c.pb('POST', '/api/collections', { name: COL, type: 'base', fields: FIELDS, ...rules(), indexes: ['CREATE UNIQUE INDEX `idx_' + COL + '_owner_key` ON `' + COL + '` (`owner`, `key`)'] });
      return [];
    }
    const patch = {}, add = missing(col);
    if (add.length) patch.fields = [...(col.fields || []), ...add];
    if (stale(col).length) Object.assign(patch, rules());
    if (Object.keys(patch).length) await c.pb('PATCH', '/api/collections/' + COL, patch);
    return [];
  },
};
