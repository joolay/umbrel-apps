'use strict';
// Gives each app a key for Portal API, so it can ask Portal Admin for account and access work instead of holding a PocketBase login.
module.exports = {
  id: '003-portal-api-keys',
  title: 'Portal API key for each app',
  summary: "Each app gets its own key, saved in its data folder. The app uses it to ask Portal Admin who someone is, what they may open and what their settings are. Apps that don't know about the key yet keep working as they are.",
  async plan(c) {
    const ok = (a) => { const e = c.readEnv(a); return c.appKeys.valid(a.slug, e.POCKETBASE_PORTAL_KEY) && e.POCKETBASE_PORTAL_URL === c.portalApiUrl; };
    return c.apps().filter((a) => !ok(a)).map((a) => `Give ${a.name} a Portal API key and save it in the app's data folder`);
  },
  async apply(c) {
    const e0 = (a) => c.readEnv(a);
    for (const a of c.apps()) if (!(c.appKeys.valid(a.slug, e0(a).POCKETBASE_PORTAL_KEY) && e0(a).POCKETBASE_PORTAL_URL === c.portalApiUrl)) c.setEnv(a, { POCKETBASE_PORTAL_URL: c.portalApiUrl, POCKETBASE_PORTAL_KEY: c.appKeys.issue(a.slug) });
    return ["Apps need to be restarted (or updated) to pick up their key, and need to reach Portal Admin on port 3899 of this server."];
  },
};
