"use strict";
// App names people chose for their own home screen. Each person can rename the apps on their JoolzApp home screen; the names live in their own
// layout row (`pref.home.layout`, field `names`: { <app slug>: "My name" }). Here the admin sees every such rename and can reset it.
const pb = require("./pocketbase");
const SET = "/api/collections/portal_settings/records";
const q = encodeURIComponent, esc = (s) => String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
const cleanName = (s) => String(s == null ? "" : s).replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0, 30);

async function layoutRows() {
  const out = []; for (let page = 1; page <= 50; page++) {
    const j = await pb.asSuper("GET", `${SET}?page=${page}&perPage=200&filter=${q("scope = 'user' && app = '' && key = 'pref.home.layout'")}`);
    out.push(...(j.items || [])); if (page >= (j.totalPages || 1)) break;
  }
  return out;
}
async function adminView() {
  const apps = ((await pb.asSuper("GET", "/api/collections/portal_apps/records?perPage=200").catch(() => ({ items: [] }))).items || []);
  const appName = {}; apps.forEach((a) => { appName[a.slug] = a.name || a.slug; });
  const rows = (await layoutRows()).filter((r) => r.value && typeof r.value === "object" && r.value.names && typeof r.value.names === "object" && Object.keys(r.value.names).length);
  const users = {};
  for (const r of rows) { try { const u = await pb.asSuper("GET", `/api/collections/users/records/${encodeURIComponent(r.user)}`); users[r.user] = { name: u.name || "", email: u.email || "" }; } catch { users[r.user] = { name: "", email: "" }; } }
  const items = [];
  for (const r of rows) for (const [slug, custom] of Object.entries(r.value.names)) {
    const c = cleanName(custom); if (!c) continue;
    items.push({ user: r.user, userName: users[r.user].name, email: users[r.user].email, slug, original: appName[slug] || slug, custom: c, changed: c.toLowerCase() !== String(appName[slug] || slug).toLowerCase() });
  }
  items.sort((a, b) => (a.email || a.user).localeCompare(b.email || b.user) || a.original.localeCompare(b.original));
  return { items };
}
/* b: { user, slug }  resets one app's name for that person; { user, all: true } resets all of that person's names. */
async function adminAction(b) {
  const user = String(b.user || ""); if (!/^[A-Za-z0-9]{6,40}$/.test(user)) throw Object.assign(new Error("Unknown person."), { status: 400 });
  const j = await pb.asSuper("GET", `${SET}?page=1&perPage=1&filter=${q(`scope = 'user' && user = '${esc(user)}' && app = '' && key = 'pref.home.layout'`)}`);
  const row = (j.items || [])[0]; if (!row || !row.value || typeof row.value !== "object") return { reset: 0 };
  const names = row.value.names && typeof row.value.names === "object" ? Object.assign({}, row.value.names) : {};
  let n = 0;
  if (b.all) { n = Object.keys(names).length; for (const k of Object.keys(names)) delete names[k]; }
  else { const slug = String(b.slug || ""); if (!/^[a-z0-9][a-z0-9_-]{0,60}$/.test(slug)) throw Object.assign(new Error("Unknown app."), { status: 400 }); if (slug in names) { delete names[slug]; n = 1; } }
  if (n) await pb.asSuper("PATCH", `${SET}/${row.id}`, { value: Object.assign({}, row.value, { names }) });
  return { reset: n };
}
module.exports = { adminView, adminAction, cleanName };
