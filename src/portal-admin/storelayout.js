'use strict';
// The App Store layout everyone sees on the JoolzApp Portal: which apps sit in which folder, folder names and descriptions, the order,
// the dock, hidden apps and the names shown. One shared row (portal_settings, scope global, key store.layout). Everyone may read it;
// only an admin may change it (checked in server.js against the signed-in person, never trusted from the browser). Whatever an admin
// sends is cleaned here first, so a bad or oversized layout can never be saved.
const SET = '/api/collections/portal_settings/records', KEY = 'store.layout';
const q = (s) => encodeURIComponent(s);
const txt = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, n);
const ID = /^(app:[a-z0-9][a-z0-9_-]{0,60}|sys:[a-z]{1,20}|tool:[a-z0-9-]{1,30}|folder:[a-z0-9]{1,24})$/;
const ids = (a, n) => { const seen = new Set(); return (Array.isArray(a) ? a : []).filter((x) => typeof x === 'string' && ID.test(x) && !seen.has(x) && seen.add(x)).slice(0, n); };

// Returns a clean layout, or null when the input is not a layout at all.
function clean(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const folders = {};
  for (const [fid, f] of Object.entries(raw.folders && typeof raw.folders === 'object' ? raw.folders : {}).slice(0, 40)) {
    if (!/^[a-z0-9]{1,24}$/.test(fid) || !f || typeof f !== 'object') continue;
    folders[fid] = { name: txt(f.name, 30) || 'Folder', desc: txt(f.desc, 200), items: ids(f.items, 24).filter((x) => !x.startsWith('folder:')) };
  }
  const names = {};
  for (const [k, v] of Object.entries(raw.names && typeof raw.names === 'object' ? raw.names : {}).slice(0, 200)) { const c = txt(v, 30); if (c && /^[a-z0-9][a-z0-9_-]{0,60}$/.test(k)) names[k] = c; }
  const descs = {};
  for (const [k, v] of Object.entries(raw.descs && typeof raw.descs === 'object' ? raw.descs : {}).slice(0, 200)) { const c = txt(v, 300); if (c && /^[a-z0-9][a-z0-9_-]{0,60}$/.test(k)) descs[k] = c; }
  const inFolder = new Set(Object.values(folders).flatMap((f) => f.items));
  const known = (x) => !x.startsWith('folder:') || !!folders[x.slice(7)];
  const order = ids(raw.order, 300).filter((x) => known(x) && !inFolder.has(x));
  const dock = ids(raw.dock, 4).filter((x) => known(x) && !inFolder.has(x));
  const hidden = ids(raw.hidden, 300).filter((x) => !x.startsWith('folder:'));
  return { order, dock, hidden, folders, names, descs, view: raw.view === 'icons' || raw.view === 'tiles' ? raw.view : '' };
}

module.exports = (pb) => ({
  clean,
  async get() {
    const r = ((await pb.asSuper('GET', `${SET}?page=1&perPage=1&filter=${q(`scope = 'global' && key = '${KEY}'`)}`)).items || [])[0];
    return r && r.value ? clean(r.value) : null;
  },
  async set(raw) {
    const layout = clean(raw); if (!layout) { const e = new Error('That is not a layout.'); e.status = 400; throw e; }
    const ex = ((await pb.asSuper('GET', `${SET}?page=1&perPage=1&filter=${q(`scope = 'global' && key = '${KEY}'`)}`)).items || [])[0];
    if (ex) await pb.asSuper('PATCH', `${SET}/${ex.id}`, { value: layout });
    else await pb.asSuper('POST', SET, { scope: 'global', user: '', app: '', key: KEY, value: layout, secret: false });
    return layout;
  },
});
