// The shared menu archive: every menu anyone uploads lands here (PocketBase collection `grubtogo_menus`) and every signed-in
// person can order from it. Only the person who uploaded a menu, or an admin, can change or remove it.
"use strict";
const pb = require("./pocketbase");

const COLL = process.env.GRUBTOGO_MENUS_COLLECTION || "grubtogo_menus";
const base = "/api/collections/" + encodeURIComponent(COLL);

let ready = null;
function ensure() {
  if (!ready) ready = (async () => {
    try {
      // Already there: make sure it has every field this version needs (older versions lacked "branches").
      const col = await pb.asSuper("GET", base), key = col.fields ? "fields" : "schema", have = col[key] || [];
      if (!have.some(f => f.name === "branches")) {
        const f = key === "fields" ? { name: "branches", type: "json", maxSize: 200000 } : { name: "branches", type: "json", required: false, options: { maxSize: 200000 } };
        await pb.asSuper("PATCH", base, { [key]: [...have, f] });
      }
      return;
    } catch (e) { if (e.status !== 404) throw e; }
    const users = await pb.asSuper("GET", "/api/collections/" + encodeURIComponent(pb.collection));
    const key = users.fields ? "fields" : "schema"; // PocketBase 0.23+ / 0.22
    const mk = (name, type, required, opts) => key === "fields" ? { name, type, required: !!required, ...(opts || {}) } : { name, type, required: !!required, options: { ...(opts || {}) } };
    try {
      await pb.asSuper("POST", "/api/collections", {
        name: COLL, type: "base",
        [key]: [mk("owner", "text", true), mk("ownerName", "text"), mk("name", "text", true), mk("phone", "text"), mk("currency", "text"), mk("categories", "json", false, { maxSize: 5000000 }), mk("branches", "json", false, { maxSize: 200000 })],
        // No API rules: only this server (as superuser) reads or writes the archive, and it enforces who may edit.
        listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null,
      });
    } catch (e) { if (e.status !== 400) throw e; } // another request may have created it a moment ago
  })().catch(e => { ready = null; throw e; });
  return ready;
}

const str = (v, n) => String(v == null ? "" : v).trim().slice(0, n);
function cleanCategories(cats) {
  if (!Array.isArray(cats)) return null;
  const out = cats.slice(0, 60).map((c, ci) => ({
    name: str(c && c.name, 120) || "Menu",
    items: (Array.isArray(c && c.items) ? c.items : []).slice(0, 300).filter(i => i && i.name).map((i, ii) => ({
      id: str(i.id, 40) || `c${ci}i${ii}`, name: str(i.name, 160), description: str(i.description, 600),
      price: typeof i.price === "number" && isFinite(i.price) ? i.price : (parseFloat(i.price) || null),
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
  owner: rec.owner, ownerName: rec.ownerName || "", canEdit: canEdit(user, rec), updated: rec.updated || "" });

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
async function create(user, menu) {
  await ensure();
  const rec = await pb.asSuper("POST", base + "/records", { ...menu, owner: user.id, ownerName: str(user.name || String(user.email || "").split("@")[0], 80) });
  return shape(rec, user);
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

module.exports = { list, create, update, remove, cleanMenu };
