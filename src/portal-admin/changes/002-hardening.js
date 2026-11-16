'use strict';
// Small tightening of existing rules.
const VERIFIED = '@request.body.verified:isset = false';
const CAP = 65536;   // bytes: plenty for a setting or preference, stops one account from filling the disk with a single row
module.exports = {
  id: '002-hardening',
  title: 'Tighten user and settings rules',
  summary: 'People can no longer mark their own account as verified, and a single setting or preference value is capped at 64 KB.',
  async plan(c) {
    const out = [], u = await c.getCollection('users'), ps = await c.getCollection('portal_settings');
    if (u && typeof u.updateRule === 'string' && !u.updateRule.includes('verified:isset')) out.push('Stop people from marking their own account as verified (users update rule)');
    const f = ps && (ps.fields || []).find((x) => x.name === 'value');
    if (f && f.type === 'json' && (!f.maxSize || f.maxSize > CAP)) out.push('Cap a settings value at 64 KB (portal_settings)');
    return out;
  },
  async apply(c) {
    const u = await c.getCollection('users');
    if (u && typeof u.updateRule === 'string' && !u.updateRule.includes('verified:isset')) await c.pb('PATCH', '/api/collections/users', { updateRule: u.updateRule + ' && ' + VERIFIED });
    const ps = await c.getCollection('portal_settings'), f = ps && (ps.fields || []).find((x) => x.name === 'value');
    if (f && f.type === 'json' && (!f.maxSize || f.maxSize > CAP)) await c.pb('PATCH', '/api/collections/portal_settings', { fields: ps.fields.map((x) => (x.name === 'value' ? { ...x, maxSize: CAP } : x)) });
    return [];
  },
};
