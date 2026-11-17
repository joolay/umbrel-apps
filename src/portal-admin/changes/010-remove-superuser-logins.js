'use strict';
// The last step: take the all-powerful PocketBase superuser login out of each app's data folder. By now an app talks to Portal Admin
// (Portal API key) for accounts and uses its own limited login for its own data, so it has no use for the superuser login.
// An app is only touched when it is a version known to work without it and the earlier changes are in place for it.
// Portal Admin keeps its own login: it is the one place that still needs it.
const NEEDS = { shutterworth: '1.7.14', 'diner-bell': '2.0.7', listify: '1.0.12', 'jolly-grocer': '1.0.9', stremio: '1.1.5', 'app-updater': '0.0.0' };
const EARLIER = ['001-app-service-accounts', '003-portal-api-keys', '005-shutterworth-inventory', '009-app-data-storage'];
const KEYS = ['POCKETBASE_SUPERUSER_EMAIL', 'POCKETBASE_SUPERUSER_PASSWORD'];
const atLeast = (have, want) => { const a = String(have || '0').split('.').map(Number), b = want.split('.').map(Number); for (let i = 0; i < 3; i++) { if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0); } return true; };
const holders = (c) => c.apps().filter((a) => NEEDS[a.slug] && KEYS.some((k) => c.readEnv(a)[k]));
async function earlierLeft(c) { for (const id of EARLIER) { if ((await require('./' + id).plan(c)).length) return require('./' + id).title; } return ''; }

module.exports = {
  id: '010-remove-superuser-logins',
  title: 'Remove the superuser login from the apps',
  summary: "Each app has been holding PocketBase's all-powerful login. They no longer use it, so this takes it out of their data folders. Only apps that are new enough to work without it are touched, and Portal Admin keeps its own. If an app ever misbehaves afterwards, Apps > Connect puts the login back.",
  async plan(c) {
    const have = holders(c); if (!have.length) return [];
    const first = await earlierLeft(c); if (first) return [`Apply "${first}" first (and the other changes above this one)`];
    return have.map((a) => (atLeast(a.version, NEEDS[a.slug]) ? `Remove the superuser login from ${a.name}'s data folder` : `Update ${a.name} to version ${NEEDS[a.slug]} or newer first (it is on ${a.version || 'an older version'})`));
  },
  async apply(c) {
    const first = await earlierLeft(c); if (first) throw new Error(`Apply "${first}" first.`);
    if (!c.ownLoginSaved()) throw new Error("Portal Admin doesn't have its own copy of the login yet. Open Portal Admin's home screen once, then try again.");
    const done = [];
    for (const a of holders(c)) if (atLeast(a.version, NEEDS[a.slug])) { c.unsetEnv(a, KEYS); done.push(a.name); }
    return done.length ? [`Removed from: ${done.join(', ')}. Restart those apps (or the server) so they also forget the login they already loaded.`] : ['Nothing could be removed yet. Update the apps listed, then come back.'];
  },
};
