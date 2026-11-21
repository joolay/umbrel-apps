'use strict';
// Installs new JoolzApps by itself. Portal Admin keeps a queue of app ids (Portal API `updater.queue`, filled by a Changes card);
// each minute this looks at it, waits until umbrelOS lists the app in its store, installs it (umbrelOS `apps.install`), and tells Portal Admin
// how it went (`updater.report`), which takes the app off the queue. Nothing here reads GitHub or forces a store refresh.
// Only ids that start with "joolay-" are ever installed, and only when they are on the queue.
const ID = /^joolay-[a-z0-9][a-z0-9-]{0,60}$/;
const GIVE_UP_MS = 24 * 3600e3, MAX_TRIES = 3, INSTALL_WAIT_MS = 20 * 60e3, LAST_KEEP = 10;

module.exports = function makeInstaller({ portalCall, umbrelCall, registry, enabled, log = () => {}, now = () => Date.now(), onChange = () => {} }) {
  const waitingSince = new Map(), tries = new Map(), busy = new Set();
  const st = { queue: [], last: [], error: null, at: 0 };
  const done = (id, ok, note) => { st.last.unshift({ id, ok, note, at: now() }); st.last.length = Math.min(st.last.length, LAST_KEEP); waitingSince.delete(id); tries.delete(id); };

  async function run(id) {
    busy.add(id);
    try {
      await umbrelCall('apps.install', 'mutation', { appId: id }, INSTALL_WAIT_MS);
      log('info', 'Install started for ' + id, id); onChange();
    } catch (e) {
      const n = (tries.get(id) || 0) + 1; tries.set(id, n);
      log('error', 'Could not install ' + id + ' (try ' + n + ' of ' + MAX_TRIES + '): ' + String(e.message || e).slice(0, 160), id);
    } finally { busy.delete(id); }
  }

  async function tick() {
    if (!enabled()) { st.queue = []; return st; }
    let q;
    try { q = (await portalCall('updater.queue', [])) || {}; st.error = null; }
    catch (e) { st.error = String(e.message || e).slice(0, 160); return st; }
    st.at = now();
    st.queue = (Array.isArray(q.queue) ? q.queue : []).filter((id) => typeof id === 'string' && ID.test(id));
    if (!st.queue.length) return st;
    const apps = await umbrelCall('apps.list', 'query'), reg = registry(), reports = [];
    for (const id of st.queue) {
      const have = (Array.isArray(apps) ? apps : []).find((a) => a && a.id === id);
      if (have) {
        if (/install|starting/i.test(String(have.state || ''))) continue;          // still going: look again next minute
        reports.push({ id, ok: true, note: 'Installed' + (have.version ? ' (v' + have.version + ')' : '') }); done(id, true, 'Installed'); log('info', 'Installed ' + id, id); continue;
      }
      if (busy.has(id)) continue;
      if ((tries.get(id) || 0) >= MAX_TRIES) { const n = 'umbrelOS refused the install ' + MAX_TRIES + ' times (see the log)'; reports.push({ id, ok: false, note: n }); done(id, false, n); continue; }
      if (reg && reg.has(id)) { run(id); continue; }                                  // not awaited: the install takes a minute or two
      if (!waitingSince.has(id)) { waitingSince.set(id, now()); log('info', id + ' is queued; waiting for umbrelOS to list it in the app store', id); }
      if (now() - waitingSince.get(id) > GIVE_UP_MS) { const n = 'Not listed in the app store after 24 hours'; reports.push({ id, ok: false, note: n }); done(id, false, n); log('error', id + ': ' + n, id); }
    }
    if (reports.length) { try { await portalCall('updater.report', [reports]); onChange(); } catch (e) { st.error = String(e.message || e).slice(0, 160); } }
    return st;
  }
  const state = () => ({ queue: st.queue, waiting: Object.fromEntries(waitingSince), last: st.last, error: st.error, at: st.at });
  return { tick, state };
};
module.exports.ID = ID;
