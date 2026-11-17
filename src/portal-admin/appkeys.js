"use strict";
// App keys: API keys that an app needs but that belong to the person running it (for example JoolzTV's TMDB key). The admin pastes them here, once; they are stored in
// PocketBase as `portal_settings` rows (scope app, app <slug>, key secret.<name>, secret = true: hidden from every signed-in person, visible to the superuser only) and the
// app asks Portal Admin for its own key through Portal API (`appSecret`, appclient.js). Nothing is kept in the app's files or in the source code, so everyone who installs
// the app stores their own.
const pb = require("./pocketbase");
const SET = "/api/collections/portal_settings/records";
const q = encodeURIComponent, esc = (s) => String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");

// What each app can be given. Add an app's keys here.
const REGISTRY = {
  joolztv: [{
    name: "tmdb", label: "TMDB API key (v3 key or read access token)",
    help: "Gives JoolzTV artwork, title logos, age ratings, cast, collections, Discover, where-to-watch and the age limits for kids. Free: create an account at themoviedb.org and copy the key from Settings > API.",
    link: "https://www.themoviedb.org/settings/api",
  }],
};
const filter = (app, name) => `scope = 'app' && app = '${esc(app)}' && key = 'secret.${esc(name)}'`;
async function row(app, name) { return ((await pb.asSuper("GET", `${SET}?page=1&perPage=1&filter=${q(filter(app, name))}`)).items || [])[0] || null; }

async function adminView() {
  const apps = ((await pb.asSuper("GET", "/api/collections/portal_apps/records?perPage=200").catch(() => ({ items: [] }))).items || []);
  const out = [];
  for (const a of apps) {
    const keys = REGISTRY[a.slug]; if (!keys) continue;
    const list = []; for (const k of keys) { const r = await row(a.slug, k.name); list.push({ name: k.name, label: k.label, help: k.help, link: k.link, has: !!(r && r.value) }); }
    out.push({ slug: a.slug, name: a.name || a.slug, keys: list });
  }
  return { apps: out };
}
/* b: { app, name, value }  value "" removes the key. The value is never sent back. */
async function adminAction(b) {
  const app = String(b.app || ""), name = String(b.name || ""), def = (REGISTRY[app] || []).filter((k) => k.name === name)[0];
  if (!def) throw Object.assign(new Error("Unknown app key."), { status: 400 });
  const value = String(b.value == null ? "" : b.value).trim(), ex = await row(app, name);
  if (!value) { if (ex) await pb.asSuper("DELETE", `${SET}/${ex.id}`); return { has: false }; }
  if (!/^[\w.\-]{16,900}$/.test(value)) throw Object.assign(new Error("That does not look like a key: it should be letters, numbers, dots, dashes and underscores, with no spaces."), { status: 400 });
  if (ex) await pb.asSuper("PATCH", `${SET}/${ex.id}`, { value, secret: true });
  else await pb.asSuper("POST", SET, { scope: "app", app, user: "", key: "secret." + name, value, secret: true, note: def.label });
  return { has: true };
}
module.exports = { adminView, adminAction, REGISTRY };
