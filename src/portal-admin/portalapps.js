'use strict';
// Portal tiles for apps that do not use the JoolzApp account (Stremio, OpenClaw, ...). Port Master (owner-only) asks through the Portal API
// (`portalApps.list` / `portalApps.add` / `portalApps.remove`, that app's key only) and this keeps ONE portal_apps row per app, the same row the Apps page's "Add" button
// makes, so the tile shows on the JoolzApp Dashboard like any other. Only an app that is really installed on this Umbrel and is not one of our own joolay-* apps can be added;
// a tile is hidden (enabled = false), never deleted, so adding it again brings it back with its name and address.
const SET = '/api/collections/portal_settings/records', NOTE = 'Port Master: tile for admins only';
const COLL = '/api/collections/portal_apps/records', AUD = '/api/collections/portal_audit/records', q = encodeURIComponent;
const SLUG = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const txt = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, n);
const slugOf = (id) => String(id).toLowerCase().replace(/^joolay-/, '').replace(/[^a-z0-9_-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 48);
const bad = (m, status = 400) => Object.assign(new Error(m), { status });
function cleanUrl(u) {
  let x; try { x = new URL(String(u || '').trim()); } catch { return ''; }
  return /^https?:$/.test(x.protocol) && !x.username && !x.password && x.hostname ? x.href.replace(/\/$/, '') : '';
}
module.exports = ({ pbx, installedApps }) => {
  const only = (app) => { if (app !== 'routing-reporter') throw bad('Only Port Master can change the portal tiles.', 403); };
  const find = async (slug) => ((await pbx.asSuper('GET', `${COLL}?page=1&perPage=1&filter=${q(`slug = '${slug}'`)}`)).items || [])[0];
  const audit = (action, target, detail) => pbx.asSuper('POST', AUD, { actor: 'Port Master', action, target, detail }).catch(() => {});
  // Audience: 'admins' = an app-level `app.adminOnly` = true row: the Store leaves the tile out for everyone who is not an admin (nothing to see, no lock);
  // 'all' = that row removed again. Only a row Port Master made (its note) is ever touched.
  const accRow = async (slug) => ((await pbx.asSuper('GET', `${SET}?page=1&perPage=1&filter=${q(`scope = 'app' && app = '${slug}' && key = 'app.adminOnly'`)}`)).items || [])[0];
  const setAudience = async (slug, audience) => {
    const row = await accRow(slug);
    if (audience === 'admins') { if (!row) await pbx.asSuper('POST', SET, { scope: 'app', user: '', app: slug, key: 'app.adminOnly', value: true, secret: false, note: NOTE }); else if (row.note === NOTE && row.value !== true) await pbx.asSuper('PATCH', `${SET}/${row.id}`, { value: true }); }
    else if (row && row.note === NOTE) await pbx.asSuper('DELETE', `${SET}/${row.id}`);
  };
  return {
    slugOf, cleanUrl,
    async list(app) {
      only(app); const locked = new Set(((await pbx.asSuper('GET', `${SET}?perPage=200&filter=${q(`scope = 'app' && key = 'app.adminOnly' && value = true`)}`)).items || []).map((r) => r.app));
      return ((await pbx.asSuper('GET', COLL + '?perPage=200')).items || []).map((r) => ({ slug: r.slug, name: r.name, url: r.url || '', enabled: !!r.enabled, audience: locked.has(r.slug) ? 'admins' : 'all' }));
    },
    // spec: { id (the app's Umbrel id), name, description, url }
    async add(app, spec) {
      only(app); spec = spec && typeof spec === 'object' ? spec : {};
      const inst = installedApps().apps.find((a) => a.id === spec.id);
      if (!inst) throw bad('That app is not installed on this Umbrel.', 404);
      if (/^joolay-/.test(inst.dir)) throw bad('That is one of your JoolzApp apps: it gets its own tile automatically (or lives in the Admin folder).');
      const slug = slugOf(inst.id), name = txt(spec.name, 60) || inst.name, description = txt(spec.description, 200), url = cleanUrl(spec.url);
      if (!SLUG.test(slug)) throw bad('That app has no usable name for a tile.');
      if (!url) throw bad('Choose an address people can open (https://... or http://...).');
      if (installedApps().apps.some((a) => /^joolay-/.test(a.dir) && (a.slug === slug || a.dir.replace(/^joolay-/, '') === slug))) throw bad('That name belongs to one of your JoolzApp apps, so it cannot be used for another tile.', 409);
      const audience = spec.audience === 'all' ? 'all' : 'admins', ex = await find(slug), body = { name, description, url, enabled: true };
      if (ex) { await pbx.asSuper('PATCH', `${COLL}/${ex.id}`, body); await setAudience(slug, audience); await audit('app.update', slug, { ...body, audience, umbrelId: inst.id }); return { slug, created: false }; }
      await pbx.asSuper('POST', COLL, { slug, ...body }); await setAudience(slug, audience); await audit('app.create', slug, { slug, ...body, audience, umbrelId: inst.id }); return { slug, created: true };
    },
    async remove(app, slug) {
      only(app); slug = String(slug || '');
      if (!SLUG.test(slug)) throw bad('Unknown tile.');
      if (installedApps().apps.some((a) => /^joolay-/.test(a.dir) && (a.slug === slug || a.dir.replace(/^joolay-/, '') === slug))) throw bad('That tile belongs to a JoolzApp app.', 409);
      const ex = await find(slug); if (!ex) return { removed: false };
      await pbx.asSuper('PATCH', `${COLL}/${ex.id}`, { enabled: false }); await audit('app.disable', slug, {}); return { removed: true };
    },
  };
};
