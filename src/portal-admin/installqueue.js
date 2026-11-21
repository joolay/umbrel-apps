'use strict';
// Install queue for App Updater: the list of new JoolzApps (joolay-<name>) that App Updater should install on the Umbrel as soon as umbrelOS lists them.
//   - An admin adds an app by applying a Changes card (portal-changes/<NNN>-install-<name>.json with { "op": "install-app", "id": "joolay-<name>" }).
//   - App Updater (only the app with the key "app-updater") asks for the queue through Portal API `updater.queue` and says how each install went through `updater.report`.
// One global, non-secret setting row (portal_settings, scope global, key updater.install): { queue: [id], results: [{ id, ok, note, at }] }. Data only: nothing here runs anything.
const SET = '/api/collections/portal_settings/records', KEY = 'updater.install';
const ID = /^joolay-[a-z0-9][a-z0-9-]{0,60}$/;
const q = encodeURIComponent;
const bad = (m, status = 400) => Object.assign(new Error(m), { status });

const clean = (v) => {
  const o = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  const seen = new Set(), queue = (Array.isArray(o.queue) ? o.queue : []).filter((x) => typeof x === 'string' && ID.test(x) && !seen.has(x) && seen.add(x)).slice(0, 30);
  const results = (Array.isArray(o.results) ? o.results : []).filter((r) => r && typeof r.id === 'string' && ID.test(r.id)).slice(-20)
    .map((r) => ({ id: r.id, ok: !!r.ok, note: String(r.note || '').replace(/[\u0000-\u001f\u007f<>]/g, '').slice(0, 200), at: Number(r.at) || 0 }));
  return { queue, results };
};

module.exports = function makeInstallQueue({ asSuper, now = () => Date.now() }) {
  async function row() { return ((await asSuper('GET', `${SET}?page=1&perPage=1&filter=${q(`scope = 'global' && key = '${KEY}'`)}`)).items || [])[0] || null; }
  async function read() { const r = await row(); return { r, v: clean(r && r.value) }; }
  async function save(r, v) {
    if (r) await asSuper('PATCH', `${SET}/${r.id}`, { value: v });
    else await asSuper('POST', SET, { scope: 'global', user: '', app: '', key: KEY, value: v, secret: false, note: 'Apps App Updater should install' });
    return v;
  }
  let chain = Promise.resolve();
  const serial = (fn) => { const p = chain.then(fn); chain = p.catch(() => {}); return p; };   // one change at a time, so two quick calls never overwrite each other

  return {
    ID, clean,
    get: async () => (await read()).v,
    // What the Changes card will do, in words.
    async planAdd(id) { const { v } = await read(); return v.queue.includes(id) ? [] : [`Queue ${id} for automatic install by App Updater`]; },
    add: (id) => serial(async () => {
      if (!ID.test(String(id))) throw bad('Only apps whose id starts with joolay- can be queued.');
      const { r, v } = await read(); if (!v.queue.includes(id)) v.queue.push(id);
      return save(r, v);
    }),
    // Portal API for App Updater only: its queue ...
    queueFor: async (app) => { if (app !== 'app-updater') throw bad('Only App Updater can read the install queue.', 403); return { queue: (await read()).v.queue }; },
    // ... and its report: [{ id, ok, note }]. A finished install (ok or given up) leaves the queue and goes into the short results list.
    reportFrom: (app, list) => serial(async () => {
      if (app !== 'app-updater') throw bad('Only App Updater can report installs.', 403);
      const { r, v } = await read(), done = new Set();
      for (const x of (Array.isArray(list) ? list : []).slice(0, 30)) {
        if (!x || !ID.test(String(x.id))) continue;
        v.results.push({ id: x.id, ok: !!x.ok, note: x.note, at: now() }); done.add(x.id);
      }
      v.queue = v.queue.filter((id) => !done.has(id));
      const out = clean(v); await save(r, out); return { queue: out.queue };
    }),
  };
};
module.exports.ID = ID;
