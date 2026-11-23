'use strict';
// "Sign in with Google" for the JoolzApp account: switches Google on as an OAuth2 provider of the PocketBase users collection.
// The owner pastes the Google client ID and secret once; they go straight to PocketBase and are never stored or returned by Portal Admin.
// Status only ever says whether Google is on and shows the (public) client ID and the redirect address Google must have on file.
const COLL = 'users';
const bad = (m) => Object.assign(new Error(m), { status: 400 });
module.exports = function makeGoogleSignIn({ pbx }) {
  // The public address of the JoolzApp Store is the global setting portal.url; Google must have <that>/google-callback.html on file.
  const redirect = async () => {
    try { const r = await pbx.asSuper('GET', '/api/collections/portal_settings/records?perPage=1&filter=' + encodeURIComponent('key = "portal.url" && scope = "global"')); const v = r.items && r.items[0] && r.items[0].value; return typeof v === 'string' && v ? v.replace(/\/+$/, '') + '/google-callback.html' : ''; } catch { return ''; }
  };
  const load = async () => { const c = await pbx.asSuper('GET', '/api/collections/' + COLL); const o = c.oauth2 || {}; return { o, google: (o.providers || []).find((p) => p.name === 'google') || null }; };
  return {
    async status() {
      const { o, google } = await load();
      return { on: !!(o.enabled && google), clientId: google ? google.clientId : '', redirect: await redirect() };
    },
    async save(b) {
      const id = String((b && b.clientId) || '').trim(), secret = String((b && b.clientSecret) || '').trim();
      if (!/^[\w-]+(?:-[\w]+)*\.apps\.googleusercontent\.com$/.test(id)) return Promise.reject(bad('That does not look like a Google client ID (it ends in .apps.googleusercontent.com).'));
      if (!/^\S{10,200}$/.test(secret)) return Promise.reject(bad('Paste the client secret exactly as Google showed it.'));
      const { o } = await load(), others = (o.providers || []).filter((p) => p.name !== 'google');
      await pbx.asSuper('PATCH', '/api/collections/' + COLL, { oauth2: { ...o, enabled: true, providers: [...others, { name: 'google', clientId: id, clientSecret: secret }] } });
      return this.status();
    },
    async off() {
      const { o } = await load(), others = (o.providers || []).filter((p) => p.name !== 'google');
      await pbx.asSuper('PATCH', '/api/collections/' + COLL, { oauth2: { ...o, enabled: others.length > 0, providers: others } });
      return this.status();
    },
  };
};
