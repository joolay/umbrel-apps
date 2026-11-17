'use strict';
// PocketBase signs its emails (new sign-in alerts, password resets, verification, deletion notices) with one "application name".
// It was set when the first app was built, so every email said it came from that app, whichever app or page the person actually used.
// This sets it to JoolzApp, the name of the account people sign in with everywhere.
const NAME = 'JoolzApp';
const wrong = (s) => { const m = (s && s.meta) || {}; return { app: m.appName !== NAME, sender: !!m.senderName && m.senderName === m.appName && m.senderName !== NAME, old: m.appName || '(empty)' }; };
module.exports = {
  id: '011-email-app-name',
  title: 'Emails say they come from JoolzApp',
  summary: 'Sign-in alerts, password resets and other emails are signed with one name for all apps. It is currently the name of a single app, which is confusing. This changes it to JoolzApp. Nothing else is touched.',
  async plan(c) {
    const w = wrong(await c.pb('GET', '/api/settings')), out = [];
    if (w.app) out.push(`Change the name on emails from "${w.old}" to "${NAME}"`);
    if (w.sender) out.push(`Change the sender name on emails to "${NAME}" too`);
    return out;
  },
  async apply(c) {
    const s = await c.pb('GET', '/api/settings'), w = wrong(s);
    if (w.app || w.sender) await c.pb('PATCH', '/api/settings', { meta: { ...(s.meta || {}), appName: NAME, ...(w.sender ? { senderName: NAME } : {}) } });
  },
};
