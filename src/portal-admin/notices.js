'use strict';
// Emails "your account will be deleted" notices (see changes/008-deletion-notices.js) and records that a notice was sent.
const crypto = require('crypto');
const COLL = () => process.env.POCKETBASE_USERS_COLLECTION || 'users';
const q = encodeURIComponent, esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const ddmmyyyy = (d) => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
const DAYS = 30;

module.exports = function makeNotices({ pbx, forgetTouch }) {
  async function one(id) {
    const u = await pbx.asSuper('GET', `/api/collections/${COLL()}/records/${q(id)}`).catch((e) => { if (e.status === 404) return null; throw e; });
    if (!u) return { id, ok: false, message: 'That account no longer exists.' };
    if (u.isAdmin) return { id, ok: false, message: 'Admins are never sent deletion notices.' };
    if (!u.email) return { id, ok: false, message: 'This account has no email address.' };
    const email = String(u.email).toLowerCase(), deleteOn = ddmmyyyy(new Date(Date.now() + DAYS * 86400e3)), name = u.name || email.split('@')[0];
    const found = await pbx.asSuper('GET', `/api/collections/portal_notice/records?page=1&perPage=1&filter=${q(`email = '${esc(email)}'`)}`);
    const row = (found.items || [])[0];
    if (row) await pbx.asSuper('PATCH', `/api/collections/portal_notice/records/${row.id}`, { name, deleteOn });
    else { const pw = crypto.randomBytes(24).toString('base64url'); await pbx.asSuper('POST', '/api/collections/portal_notice/records', { email, password: pw, passwordConfirm: pw, name, deleteOn, emailVisibility: false }); }
    try { await pbx.raw('POST', '/api/collections/portal_notice/request-verification', { body: { email } }); }
    catch (e) { return { id, ok: false, message: "PocketBase couldn't send the email" + (e.message ? ' (' + e.message + ')' : '') + '. Check its mail settings.' }; }
    await pbx.asSuper('PATCH', `/api/collections/${COLL()}/records/${q(id)}`, { deletionNoticeAt: new Date().toISOString().replace('T', ' ') });
    forgetTouch && forgetTouch(id);
    return { id, ok: true, deleteOn, email };
  }
  async function send(ids) {
    ids = [...new Set((Array.isArray(ids) ? ids : []).map(String))].filter((x) => /^[a-z0-9]{15}$/.test(x)).slice(0, 200);
    const out = [];
    for (const id of ids) {
      try { out.push(await one(id)); }
      catch (e) {
        const missing = e.status === 404 && /portal_notice/.test(String(e.message || '') + String(e.url || ''));
        out.push({ id, ok: false, message: String(e.message || e) + (missing ? ' Apply "Email deletion notices" under Changes first.' : '') });
      }
    }
    return { results: out };
  }
  return { send };
};
