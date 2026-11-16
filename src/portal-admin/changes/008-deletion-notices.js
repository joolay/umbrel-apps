'use strict';
// Lets Portal Admin email a "your account will be deleted" notice using PocketBase's own mail settings.
// PocketBase can only send its fixed emails, so this makes a small private collection (portal_notice) whose "verify email" message is the notice.
// Nobody can sign in to it or read it; Portal Admin writes one row per person, asks PocketBase to send the email, and the row is only used for that.
const NAME = 'portal_notice';
const SUBJECT = 'Your {APP_NAME} account will be deleted on {RECORD:deleteOn}';
const BODY = `<p>Hello {RECORD:name},</p>
<p>Your {APP_NAME} account has not been used for over a year, so it is scheduled to be deleted on <b>{RECORD:deleteOn}</b>.</p>
<p>To keep it, just open and sign in to any of the apps before then. That is all you need to do, and your account stays exactly as it is.</p>
<p>If you no longer want the account you don't need to do anything.</p>
<!-- {ACTION_URL} -->`;
const same = (t) => t && t.subject === SUBJECT && t.body === BODY;
module.exports = {
  id: '008-deletion-notices',
  title: 'Email deletion notices',
  summary: "Adds a private list PocketBase uses to email people a deletion notice (the Cleanup page's \"Email deletion notice\" button). It sends through the mail settings you already set up in PocketBase.",
  async plan(c) {
    const col = await c.getCollection(NAME);
    if (!col) return ['Create the private portal_notice collection and its email wording'];
    return same(col.verificationTemplate) ? [] : ['Update the notice email wording'];
  },
  async apply(c) {
    await c.needNewPocketBase();
    const col = await c.getCollection(NAME);
    if (!col) {
      await c.pb('POST', '/api/collections', {
        name: NAME, type: 'auth', listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null, manageRule: null,
        fields: [{ name: 'name', type: 'text', required: false }, { name: 'deleteOn', type: 'text', required: false }],
        passwordAuth: { enabled: true, identityFields: ['email'] }, oauth2: { enabled: false }, otp: { enabled: false }, mfa: { enabled: false },
        authAlert: { enabled: false }, verificationTemplate: { subject: SUBJECT, body: BODY },
      });
    } else await c.pb('PATCH', '/api/collections/' + NAME, { verificationTemplate: { subject: SUBJECT, body: BODY } });
    return ['Notices are emailed with the mail settings in PocketBase. If emails do not arrive, check those settings (Settings > Mail in PocketBase).'];
  },
};
