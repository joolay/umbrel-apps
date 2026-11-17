'use strict';
// Gives every app its own limited PocketBase login ("app_service") instead of the all-powerful superuser one.
// A service login can only read and write the access rows (trial, unlimited, access) of its own app. It can't touch users, other apps or settings.
const SVC = 'app_service';
const R = {
  listRule: 'user = @request.auth.id || (@request.auth.collectionName = "app_service" && app = @request.auth.appId)',
  viewRule: 'user = @request.auth.id || (@request.auth.collectionName = "app_service" && app = @request.auth.appId)',
  createRule: '@request.auth.collectionName = "app_service" && @request.body.app = @request.auth.appId',
  updateRule: '@request.auth.collectionName = "app_service" && app = @request.auth.appId && @request.body.app:isset = false && @request.body.user:isset = false',
  deleteRule: null,
};
const email = (slug) => slug + '@apps.local';

async function stale(c) {   // apps whose saved service login is missing or no longer works
  const out = [];
  for (const a of c.apps()) { const e = c.readEnv(a); if (!(await c.loginWorks(SVC, e.POCKETBASE_SERVICE_EMAIL, e.POCKETBASE_SERVICE_PASSWORD, { retry: false }))) out.push(a); }
  return out;
}
// Create (or reset) one app's limited login and save it in its data folder. Also used for apps installed later (linkNewApps in changes.js).
async function giveLogin(c, a) {
  const pw = c.password(), em = email(a.slug);
  const f = await c.pb('GET', `/api/collections/${SVC}/records?page=1&perPage=1&filter=${encodeURIComponent(`appId = '${c.esc(a.slug)}'`)}`);
  const rec = (f.items || [])[0];
  if (rec) await c.pb('PATCH', `/api/collections/${SVC}/records/${rec.id}`, { password: pw, passwordConfirm: pw });
  else await c.pb('POST', `/api/collections/${SVC}/records`, { email: em, password: pw, passwordConfirm: pw, appId: a.slug, emailVisibility: false, verified: true });
  c.setEnv(a, { POCKETBASE_SERVICE_EMAIL: em, POCKETBASE_SERVICE_PASSWORD: pw });
}
module.exports = {
  id: '001-app-service-accounts',
  title: 'Limited login for each app',
  summary: 'Apps stop using the superuser login for trials and access. Each gets its own login that can only touch its own access rows. The apps keep working as they are until they are updated to use it.',
  async plan(c) {
    const out = [], svc = await c.getCollection(SVC), ac = await c.getCollection('app_access');
    if (!svc) out.push('Create the app_service collection (superusers only, no sign-up)');
    if (!ac) out.push('app_access does not exist yet. Open any JoolzApp once so it is created, then come back');
    else for (const [k, v] of Object.entries(R)) if ((ac[k] ?? null) !== v) out.push(`Change the ${k.replace('Rule', '')} rule on app_access`);
    const todo = svc ? await stale(c) : c.apps();
    for (const a of todo) out.push(`Create a limited login for ${a.name} and save it in the app's data folder`);
    return out;
  },
  async apply(c) {
    const notes = [];
    if (!(await c.getCollection(SVC))) await c.pb('POST', '/api/collections', {
      name: SVC, type: 'auth', listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null, manageRule: null,
      fields: [{ name: 'appId', type: 'text', required: true }],
      passwordAuth: { enabled: true, identityFields: ['email'] }, oauth2: { enabled: false }, otp: { enabled: false }, mfa: { enabled: false },
      authToken: { duration: 43200 }, authAlert: { enabled: false },
      indexes: ['CREATE UNIQUE INDEX idx_app_service_appId ON app_service (appId)'],
    });
    const ac = await c.getCollection('app_access');
    if (ac) { const patch = {}; for (const [k, v] of Object.entries(R)) if ((ac[k] ?? null) !== v) patch[k] = v; if (Object.keys(patch).length) await c.pb('PATCH', '/api/collections/app_access', patch); }
    else notes.push('app_access is missing, so its rules were not changed.');
    for (const a of await stale(c)) await giveLogin(c, a);
    notes.push('The superuser login is still in each app. It is removed in a later change, after the apps are updated to use these logins.');
    return notes;
  },
};
module.exports.giveLogin = giveLogin;
