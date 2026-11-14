// The shared menu archive: every menu anyone uploads lands here (PocketBase collection `grubtogo_menus`) and every signed-in
// person can order from it. Only the person who uploaded a menu, or an admin, can change or remove it.
"use strict";
const pb = require("./pocketbase");

const COLL = process.env.GRUBTOGO_MENUS_COLLECTION || "grubtogo_menus";
const base = "/api/collections/" + encodeURIComponent(COLL);

const ARCH = process.env.GRUBTOGO_ARCHIVE_COLLECTION || "grubtogo_menu_archive";
const archBase = "/api/collections/" + encodeURIComponent(ARCH);

// Adds whatever fields this version needs to a collection that already exists (older versions lacked some).
async function addMissing(path, wanted) {
  const col = await pb.asSuper("GET", path), key = col.fields ? "fields" : "schema", have = col[key] || [];
  const missing = wanted.filter(w => !have.some(f => f.name === w[0]));
  if (!missing.length) return;
  const mk = ([name, type, required, opts]) => key === "fields" ? { name, type, required: !!required, ...(opts || {}) } : { name, type, required: !!required, options: { ...(opts || {}) } };
  await pb.asSuper("PATCH", path, { [key]: [...have, ...missing.map(mk)] });
}
const MENU_FIELDS = [["owner", "text", true], ["ownerName", "text"], ["name", "text", true], ["phone", "text"], ["currency", "text"],
  ["categories", "json", false, { maxSize: 5000000 }], ["branches", "json", false, { maxSize: 200000 }], ["version", "text"], ["versionByName", "text"]];
const ARCH_FIELDS = [["menuId", "text", true], ["version", "text"], ["byName", "text"], ["data", "json", false, { maxSize: 5000000 }]];

let ready = null;
function ensure() {
  if (!ready) ready = (async () => {
    const users = await pb.asSuper("GET", "/api/collections/" + encodeURIComponent(pb.collection));
    const key = users.fields ? "fields" : "schema"; // PocketBase 0.23+ / 0.22
    const mk = ([name, type, required, opts]) => key === "fields" ? { name, type, required: !!required, ...(opts || {}) } : { name, type, required: !!required, options: { ...(opts || {}) } };
    // No API rules: only this server (as superuser) reads or writes these, and it enforces who may do what.
    for (const [path, name, fields] of [[base, COLL, MENU_FIELDS], [archBase, ARCH, ARCH_FIELDS]]) {
      try { await addMissing(path, fields); continue; } catch (e) { if (e.status !== 404) throw e; }
      try { await pb.asSuper("POST", "/api/collections", { name, type: "base", [key]: fields.map(mk), listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null }); }
      catch (e) { if (e.status !== 400) throw e; } // another request may have created it a moment ago
    }
  })().catch(e => { ready = null; throw e; });
  return ready;
}

const str = (v, n) => String(v == null ? "" : v).trim().slice(0, n);
// Who last changed an item, when, and what it said before.
function cleanEdit(e) {
  if (!e || typeof e !== "object") return null;
  const w = e.was && typeof e.was === "object" ? e.was : {};
  return { by: str(e.by, 40), byName: str(e.byName, 80), at: str(e.at, 40), was: { name: str(w.name, 160), description: str(w.description, 600), price: typeof w.price === "number" && isFinite(w.price) ? w.price : null } };
}
function cleanCategories(cats) {
  if (!Array.isArray(cats)) return null;
  const out = cats.slice(0, 60).map((c, ci) => ({
    name: str(c && c.name, 120) || "Menu",
    items: (Array.isArray(c && c.items) ? c.items : []).slice(0, 300).filter(i => i && i.name).map((i, ii) => ({
      id: str(i.id, 40) || `c${ci}i${ii}`, name: str(i.name, 160), description: str(i.description, 600),
      price: typeof i.price === "number" && isFinite(i.price) ? i.price : (parseFloat(i.price) || null),
      ...(cleanEdit(i.edit) ? { edit: cleanEdit(i.edit) } : {}),
    })),
  })).filter(c => c.items.length);
  return out.length ? out : null;
}
// Franchises: a menu can list several branches, each with its own phone number.
function cleanBranches(b) {
  if (!Array.isArray(b)) return null;
  return b.slice(0, 40).map(x => ({ name: str(x && x.name, 80), phone: str(x && x.phone, 40) })).filter(x => x.name || x.phone);
}
// A whole new menu. Returns null when there's nothing usable in it.
function cleanMenu(x) {
  if (!x || typeof x !== "object") return null;
  const categories = cleanCategories(x.categories);
  if (!categories) return null;
  return { name: str(x.name, 120) || "Restaurant", phone: str(x.phone, 40), currency: str(x.currency, 8) || "R", categories };
}

const canEdit = (user, rec) => !!(user && (user.isAdmin || user.id === rec.owner));
const shape = (rec, user) => ({ id: rec.id, name: rec.name || "", phone: rec.phone || "", branches: Array.isArray(rec.branches) ? rec.branches : [], currency: rec.currency || "R", categories: Array.isArray(rec.categories) ? rec.categories : [],
  owner: rec.owner, ownerName: rec.ownerName || "", canEdit: canEdit(user, rec), updated: rec.updated || "",
  version: rec.version || rec.created || "", versionByName: rec.versionByName || rec.ownerName || "" });

async function list(user) {
  await ensure();
  const out = []; let page = 1;
  for (;;) {
    const j = await pb.asSuper("GET", `${base}/records?page=${page}&perPage=200&sort=name`);
    out.push(...(j.items || []));
    if (page >= (j.totalPages || 1) || page >= 25) break;
    page++;
  }
  return out.map(r => shape(r, user));
}
const nowIso = () => new Date().toISOString();
const who = user => str(user.name || String(user.email || "").split("@")[0], 80);
// "Nando's" and "NANDOS" are the same restaurant.
const norm = s => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "");
async function findByName(name) {
  const key = norm(name); if (!key) return null;
  let page = 1;
  for (;;) {
    const j = await pb.asSuper("GET", `${base}/records?page=${page}&perPage=200&fields=id,name`);
    const hit = (j.items || []).find(r => norm(r.name) === key); if (hit) return hit.id;
    if (page >= (j.totalPages || 1) || page >= 25) return null;
    page++;
  }
}
// Keeps the old version of a menu in the archive before it is replaced.
async function archive(rec) {
  await pb.asSuper("POST", archBase + "/records", { menuId: rec.id, version: rec.version || rec.created || "", byName: rec.versionByName || rec.ownerName || "",
    data: { name: rec.name, phone: rec.phone || "", branches: rec.branches || [], currency: rec.currency || "R", categories: rec.categories || [] } });
}
// A new upload. If the restaurant is already in the archive it becomes a new version of that restaurant (the old one is archived)
// instead of a duplicate. The upload date is the version.
async function create(user, menu) {
  await ensure();
  const existing = await findByName(menu.name);
  if (existing) {
    const cur = await pb.asSuper("GET", `${base}/records/${encodeURIComponent(existing)}`);
    await archive(cur);
    const rec = await pb.asSuper("PATCH", `${base}/records/${encodeURIComponent(existing)}`, {
      categories: menu.categories, currency: menu.currency || cur.currency, phone: cur.phone || menu.phone || "", version: nowIso(), versionByName: who(user) });
    return { menu: shape(rec, user), merged: true };
  }
  const rec = await pb.asSuper("POST", base + "/records", { ...menu, owner: user.id, ownerName: who(user), version: nowIso(), versionByName: who(user) });
  return { menu: shape(rec, user), merged: false };
}
// Anyone signed in may fix an item. The item is tagged with who edited it, and keeps what it said before.
async function editItem(user, id, body) {
  await ensure();
  let rec;
  try { rec = await pb.asSuper("GET", `${base}/records/${encodeURIComponent(id)}`); }
  catch (e) { if (e.status === 404) return { status: 404, message: "That menu no longer exists." }; throw e; }
  const cats = Array.isArray(rec.categories) ? rec.categories : [];
  const item = cats.flatMap(c => c.items || []).find(i => i.id === String(body.itemId || ""));
  if (!item) return { status: 404, message: "That item is no longer on the menu." };
  const name = str(body.name, 160); if (!name) return { status: 400, message: "An item needs a name." };
  const price = body.price === "" || body.price == null ? null : parseFloat(body.price);
  if (price !== null && !(isFinite(price) && price >= 0)) return { status: 400, message: "That price isn't a number." };
  const was = { name: item.name, description: item.description || "", price: item.price == null ? null : item.price };
  Object.assign(item, { name, description: str(body.description, 600), price, edit: { by: user.id, byName: who(user), at: nowIso(), was } });
  const out = await pb.asSuper("PATCH", `${base}/records/${encodeURIComponent(id)}`, { categories: cats });
  return { menu: shape(out, user) };
}
// Anyone signed in may add a branch number. It lives on the restaurant record, so everyone sees it.
async function addBranch(user, id, body) {
  await ensure();
  let rec;
  try { rec = await pb.asSuper("GET", `${base}/records/${encodeURIComponent(id)}`); }
  catch (e) { if (e.status === 404) return { status: 404, message: "That menu no longer exists." }; throw e; }
  const name = str(body.name, 80), phone = str(body.phone, 40);
  if (!phone) return { status: 400, message: "Enter the branch's phone number." };
  const list = Array.isArray(rec.branches) ? rec.branches : [];
  const digits = s => String(s || "").replace(/\D/g, "");
  if (list.some(b => digits(b.phone) === digits(phone))) return { status: 400, message: "That number is already listed." };
  if (list.length >= 40) return { status: 400, message: "This restaurant has too many branches listed." };
  const out = await pb.asSuper("PATCH", `${base}/records/${encodeURIComponent(id)}`, { branches: [...list, { name, phone }] });
  return { menu: shape(out, user) };
}
async function versions(user, id) {
  await ensure();
  const j = await pb.asSuper("GET", `${archBase}/records?page=1&perPage=50&sort=-created&fields=id,version,byName,created&filter=${encodeURIComponent(`menuId = '${String(id).replace(/[^A-Za-z0-9]/g, "")}'`)}`);
  return { versions: (j.items || []).map(r => ({ id: r.id, version: r.version || r.created, byName: r.byName || "" })) };
}
// Puts an archived version back as the current one (the current one is archived first). Uploader or admin only.
async function restore(user, id, versionId) {
  const g = await guarded(user, id); if (g.status) return g;
  let a;
  try { a = await pb.asSuper("GET", `${archBase}/records/${encodeURIComponent(String(versionId || ""))}`); }
  catch (e) { if (e.status === 404) return { status: 404, message: "That version no longer exists." }; throw e; }
  if (a.menuId !== id || !a.data) return { status: 400, message: "That version belongs to another restaurant." };
  await archive(g.rec);
  const d = a.data, cats = cleanCategories(d.categories); if (!cats) return { status: 400, message: "That version has no items." };
  const rec = await pb.asSuper("PATCH", `${base}/records/${encodeURIComponent(id)}`, { categories: cats, phone: str(d.phone, 40), currency: str(d.currency, 8) || "R", branches: cleanBranches(d.branches) || [], version: a.version || nowIso(), versionByName: a.byName || "" });
  return { menu: shape(rec, user) };
}
// Returns { rec } or { status, message } when the menu is missing or the person isn't allowed to change it.
async function guarded(user, id) {
  await ensure();
  let rec;
  try { rec = await pb.asSuper("GET", `${base}/records/${encodeURIComponent(id)}`); }
  catch (e) { if (e.status === 404) return { status: 404, message: "That menu no longer exists." }; throw e; }
  if (!canEdit(user, rec)) return { status: 403, message: "Only the person who uploaded this menu, or an admin, can change it." };
  return { rec };
}
async function update(user, id, body) {
  const g = await guarded(user, id); if (g.status) return g;
  const patch = {};
  if (body.name !== undefined) { const n = str(body.name, 120); if (n) patch.name = n; }
  if (body.phone !== undefined) patch.phone = str(body.phone, 40);
  if (body.branches !== undefined) { const b = cleanBranches(body.branches); if (b) patch.branches = b; }
  if (body.currency !== undefined) patch.currency = str(body.currency, 8) || "R";
  if (body.categories !== undefined) { const c = cleanCategories(body.categories); if (!c) return { status: 400, message: "A menu needs at least one item." }; patch.categories = c; }
  const rec = Object.keys(patch).length ? await pb.asSuper("PATCH", `${base}/records/${encodeURIComponent(id)}`, patch) : g.rec;
  return { menu: shape(rec, user) };
}
async function remove(user, id) {
  const g = await guarded(user, id); if (g.status) return g;
  await pb.asSuper("DELETE", `${base}/records/${encodeURIComponent(id)}`);
  return { ok: true };
}

module.exports = { list, create, update, remove, cleanMenu, editItem, addBranch, versions, restore };
