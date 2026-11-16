'use strict';
// Adds a "last active" date and a "deletion notice sent" date to every person, so accounts nobody has used for a year can be reviewed on the
// Cleanup page. Apps report use through Portal API and the dashboard reports its own. Everyone who already exists starts today, so nobody is flagged early.
// People cannot write these two dates themselves (users update rule); only Portal Admin does.
const COLL = 'users', FIELDS = ['lastActive', 'deletionNoticeAt'];
const GUARD = '@request.body.lastActive:isset = false && @request.body.deletionNoticeAt:isset = false';
const has = (col, n) => (col.fields || []).some((f) => f.name === n);
module.exports = {
  id: '007-user-last-active',
  title: 'Track when people were last active',
  summary: 'Adds a last-active date and a deletion-notice date to each account. People unused for a year then appear on the Cleanup page, and nothing is deleted until you confirm it there. Everyone starts from today, and nobody can edit these dates themselves.',
  async plan(c) {
    const col = await c.getCollection(COLL), out = [];
    if (!col) return out;
    const missing = FIELDS.filter((n) => !has(col, n));
    if (missing.length) out.push(`Add ${missing.join(' and ')} to the users collection${missing.includes('lastActive') ? ' and set last-active to today for everyone' : ''}`);
    if (typeof col.updateRule === 'string' && !col.updateRule.includes('lastActive:isset')) out.push('Stop people from changing these dates themselves (users update rule)');
    return out;
  },
  async apply(c) {
    await c.needNewPocketBase();
    let col = await c.getCollection(COLL);
    if (!col) return ['The users collection does not exist yet, so nothing was changed.'];
    const notes = [], addedLast = !has(col, 'lastActive');
    const add = FIELDS.filter((n) => !has(col, n)).map((name) => ({ name, type: 'date', required: false }));
    if (add.length) await c.pb('PATCH', '/api/collections/' + COLL, { fields: [...(col.fields || []), ...add] });
    if (typeof col.updateRule === 'string' && !col.updateRule.includes('lastActive:isset')) await c.pb('PATCH', '/api/collections/' + COLL, { updateRule: col.updateRule + ' && ' + GUARD });
    if (addedLast) {
      const now = new Date().toISOString().replace('T', ' ');
      let n = 0;
      for (;;) {
        const j = await c.pb('GET', `/api/collections/${COLL}/records?page=1&perPage=100&fields=id&filter=${encodeURIComponent('lastActive = ""')}`);
        if (!(j.items || []).length) break;
        for (const r of j.items) { await c.pb('PATCH', `/api/collections/${COLL}/records/${r.id}`, { lastActive: now }); n++; }
        if (n > 20000) break;
      }
      notes.push(`Started tracking for ${n} account${n === 1 ? '' : 's'}. Update the apps so they report when people use them.`);
    }
    return notes;
  },
};
