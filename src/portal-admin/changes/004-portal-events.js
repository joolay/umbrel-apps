'use strict';
// Creates the collection the dashboard ticker reads for notices written by apps (README, "Events and the Organiser").
const FIELDS = [
  { name: 'title', required: true }, { name: 'start', required: true }, { name: 'kind' }, { name: 'sub' },
  { name: 'link' }, { name: 'source' }, { name: 'familyId' }, { name: 'userIds' },
];
const field = (f) => ({ type: 'text', name: f.name, required: !!f.required });
module.exports = {
  id: '004-portal-events',
  title: 'Dashboard notices from apps',
  summary: 'Creates portal_events, the list the dashboard ticker reads. Apps such as App Updater can then post a notice like "Portal Admin updated" that everyone sees on the day it is posted. People cannot read or change the list directly; only Portal Admin does.',
  async plan(c) {
    const col = await c.getCollection('portal_events');
    if (!col) return ['Create the portal_events collection (superusers only)'];
    const have = new Set((col.fields || []).map((f) => f.name)), miss = FIELDS.filter((f) => !have.has(f.name));
    return miss.length ? ['Add ' + miss.map((f) => f.name).join(', ') + ' to portal_events'] : [];
  },
  async apply(c) {
    await c.needNewPocketBase();
    const col = await c.getCollection('portal_events');
    if (!col) {
      await c.pb('POST', '/api/collections', { name: 'portal_events', type: 'base', listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null, fields: FIELDS.map(field) });
      return [];
    }
    const have = new Set((col.fields || []).map((f) => f.name)), miss = FIELDS.filter((f) => !have.has(f.name));
    if (miss.length) await c.pb('PATCH', '/api/collections/portal_events', { fields: [...col.fields, ...miss.map(field)] });
    return [];
  },
};
