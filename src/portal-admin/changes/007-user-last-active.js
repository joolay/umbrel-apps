'use strict';
// Adds a "last active" date to every person so accounts nobody has used for a year can be reviewed on the Cleanup page.
// Apps report use through Portal API and the dashboard reports its own. Everyone who already exists starts today, so nobody is flagged early.
const COLL = 'users';
const hasField = (col) => (col.fields || []).some((f) => f.name === 'lastActive');
module.exports = {
  id: '007-user-last-active',
  title: 'Track when people were last active',
  summary: 'Adds a last-active date to each account. People unused for a year then appear on the Cleanup page, and nothing is deleted until you confirm it there. Everyone starts from today.',
  async plan(c) {
    const col = await c.getCollection(COLL);
    return col && !hasField(col) ? ['Add a lastActive date to the users collection and set it to today for everyone'] : [];
  },
  async apply(c) {
    await c.needNewPocketBase();
    const col = await c.getCollection(COLL);
    if (!col) return ['The users collection does not exist yet, so nothing was changed.'];
    if (hasField(col)) return [];
    await c.pb('PATCH', '/api/collections/' + COLL, { fields: [...(col.fields || []), { name: 'lastActive', type: 'date', required: false }] });
    const now = new Date().toISOString().replace('T', ' ');
    let n = 0;
    for (;;) {
      const j = await c.pb('GET', `/api/collections/${COLL}/records?page=1&perPage=100&fields=id&filter=${encodeURIComponent('lastActive = ""')}`);
      if (!(j.items || []).length) break;
      for (const r of j.items) { await c.pb('PATCH', `/api/collections/${COLL}/records/${r.id}`, { lastActive: now }); n++; }
      if (n > 20000) break;
    }
    return [`Started tracking for ${n} account${n === 1 ? '' : 's'}. Update the apps so they report when people use them.`];
  },
};
