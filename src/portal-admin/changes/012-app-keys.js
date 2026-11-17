'use strict';
// App keys (Portal Admin > App keys): API keys an app needs but the person running it owns, for example JoolzTV's TMDB key. They are saved as `secret.<name>` settings in
// portal_settings with secret = true. This makes sure PocketBase never hands those rows to a signed-in person: the list and view rules must say `secret = false`, and only the
// superuser (Portal Admin) can create or change app-level rows. Nothing about any key is stored in this change: each admin saves their own on the App keys page.
const HIDE = '@request.auth.id != "" && secret = false && (scope != "user" || user = @request.auth.id)';
const bad = (col) => ({
  read: ['listRule', 'viewRule'].filter((r) => col[r] == null || !String(col[r]).includes('secret = false')),
  write: ['createRule', 'updateRule', 'deleteRule'].filter((r) => col[r] != null && /scope\s*=\s*"?'?app/.test(String(col[r])) && !/scope\s*=\s*"user"/.test(String(col[r]))),
});
module.exports = {
  id: '012-app-keys',
  title: 'App keys stay hidden',
  summary: "Apps can now be given a key of their own on the App keys page (JoolzTV's TMDB key, for example). This checks that PocketBase never shows those keys to anyone signed in, and that only you can change them. Your keys are not part of this change.",
  async plan(c) {
    const col = await c.getCollection('portal_settings'); if (!col) return [];
    const b = bad(col), out = [];
    if (b.read.length) out.push(`Hide secret settings from signed-in people (${b.read.join(', ')})`);
    if (b.write.length) out.push(`Only the superuser may write app settings (${b.write.join(', ')})`);
    return out;
  },
  async apply(c) {
    const col = await c.getCollection('portal_settings'); if (!col) return;
    const b = bad(col), patch = {};
    for (const r of b.read) patch[r] = HIDE;
    for (const r of b.write) patch[r] = null;                       // null = superuser only
    if (Object.keys(patch).length) await c.pb('PATCH', '/api/collections/portal_settings', patch);
  },
};
