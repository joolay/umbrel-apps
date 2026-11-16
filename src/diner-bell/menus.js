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
  ["categories", "json", false, { maxSize: 5000000 }], ["branches", "json", false, { maxSize: 200000 }], ["version", "text"], ["versionByName", "text"], ["wa", "text"], ["rerenderReq", "json", false, { maxSize: 20000 }], ["logo", "json", false, { maxSize: 600000 }]];
const SRC = process.env.GRUBTOGO_SOURCES_COLLECTION || "grubtogo_menu_sources";
const srcBase = "/api/collections/" + encodeURIComponent(SRC);
const SRC_FIELDS = [["menuId", "text", true], ["kind", "text"], ["name", "text"], ["mime", "text"], ["byName", "text"], ["size", "number"], ["data", "json", false, { maxSize: 9000000 }]];
const ARCH_FIELDS = [["menuId", "text", true], ["version", "text"], ["byName", "text"], ["data", "json", false, { maxSize: 5000000 }]];

let ready = null;
function ensure() {
  if (!ready) ready = (async () => {
    const users = await pb.asSuper("GET", "/api/collections/" + encodeURIComponent(pb.collection));
    const key = users.fields ? "fields" : "schema"; // PocketBase 0.23+ / 0.22
    const mk = ([name, type, required, opts]) => key === "fields" ? { name, type, required: !!required, ...(opts || {}) } : { name, type, required: !!required, options: { ...(opts || {}) } };
    // No API rules: only this server (as superuser) reads or writes these, and it enforces who may do what.
    for (const [path, name, fields] of [[base, COLL, MENU_FIELDS], [archBase, ARCH, ARCH_FIELDS], [srcBase, SRC, SRC_FIELDS]]) {
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
      price: parsePrice(i.price),
      ...(cleanEdit(i.edit) ? { edit: cleanEdit(i.edit) } : {}),
    })),
  })).filter(c => c.items.length);
  return out.length ? out : null;
}
// Franchises: a menu can list several branches, each with its own phone number.
function cleanBranches(b) {
  if (!Array.isArray(b)) return null;
  return b.slice(0, 40).map(x => ({ name: str(x && x.name, 80), phone: str(x && x.phone, 40), wa: str(x && x.wa, 40) })).filter(x => x.name || x.phone);
}
// A whole new menu. Returns null when there's nothing usable in it.
function cleanMenu(x) {
  if (!x || typeof x !== "object") return null;
  const categories = cleanCategories(x.categories);
  if (!categories) return null;
  return { name: str(x.name, 120) || "Restaurant", phone: str(x.phone, 40), currency: str(x.currency, 8) || "R", categories };
}

// The JoolzApp hierarchy: Admin > Editor (granted by an admin, edits everything shared) > Member > View-only. Whoever uploaded something is its
// "uploader" (a title for the originator) and has editor rights over that upload.
const isEditor = u => !!(u && (u.isAdmin || (u.portal && u.portal.editor && !u.portal.readonly)));
const canEdit = (user, rec) => !!(user && (isEditor(user) || user.id === rec.owner));
// The AI sometimes returns prices as text ("R 89,90", "1 250.00", "R89-R95"). Read the first amount; a comma followed by one or two
// digits is a decimal comma, otherwise commas and spaces are thousands separators.
function parsePrice(v) {
  if (typeof v === "number") return isFinite(v) && v >= 0 ? v : null;
  const m = String(v == null ? "" : v).replace(/\u00a0/g, " ").match(/\d[\d ,.']*/);
  if (!m) return null;
  let t = m[0].trim().replace(/[ ']/g, "");
  if (/,\d{1,2}$/.test(t) && !/\.\d{1,2}$/.test(t)) t = t.replace(/\./g, "").replace(",", ".");
  else t = t.replace(/,/g, "");
  const n = parseFloat(t);
  return isFinite(n) && n >= 0 && n < 100000 ? n : null;
}
const shape = (rec, user) => ({ id: rec.id, name: rec.name || "", phone: rec.phone || "", wa: rec.wa || "", logo: typeof rec.logo === "string" ? rec.logo : "", branches: Array.isArray(rec.branches) ? rec.branches : [], currency: rec.currency || "R", categories: Array.isArray(rec.categories) ? rec.categories : [],
  owner: rec.owner, ownerName: rec.ownerName || "", canEdit: canEdit(user, rec), updated: rec.updated || "",
  version: rec.version || rec.created || "", versionByName: rec.versionByName || rec.ownerName || "",
  // People ask the uploader or an admin to re-render a menu; only they see who asked.
  rerenderReq: canEdit(user, rec) && Array.isArray(rec.rerenderReq) ? rec.rerenderReq : [], iRequested: Array.isArray(rec.rerenderReq) && rec.rerenderReq.some(x => x && x.by === user.id) });

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
  const name = str(body.name, 80), phone = str(body.phone, 40), wa = str(body.wa, 40);
  if (!phone) return { status: 400, message: "Enter the branch's phone number." };
  const list = Array.isArray(rec.branches) ? rec.branches : [];
  const digits = s => String(s || "").replace(/\D/g, "");
  if (list.some(b => digits(b.phone) === digits(phone))) return { status: 400, message: "That number is already listed." };
  if (list.length >= 40) return { status: 400, message: "This restaurant has too many branches listed." };
  const out = await pb.asSuper("PATCH", `${base}/records/${encodeURIComponent(id)}`, { branches: [...list, { name, phone, wa }] });
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
  if (!canEdit(user, rec)) return { status: 403, message: "Only an editor, an admin or the person who uploaded this menu can change it." };
  return { rec };
}
async function update(user, id, body) {
  const g = await guarded(user, id); if (g.status) return g;
  const patch = {};
  if (body.name !== undefined) { const n = str(body.name, 120); if (n) patch.name = n; }
  if (body.phone !== undefined) patch.phone = str(body.phone, 40);
  if (body.wa !== undefined) patch.wa = str(body.wa, 40);
  if (body.branches !== undefined) { const b = cleanBranches(body.branches); if (b) patch.branches = b; }
  if (body.currency !== undefined) patch.currency = str(body.currency, 8) || "R";
  if (body.categories !== undefined) { const c = cleanCategories(body.categories); if (!c) return { status: 400, message: "A menu needs at least one item." }; patch.categories = c; }
  const rec = Object.keys(patch).length ? await pb.asSuper("PATCH", `${base}/records/${encodeURIComponent(id)}`, patch) : g.rec;
  return { menu: shape(rec, user) };
}
// Anyone signed in (and not view-only) may set a restaurant's display picture. Pass "" to clear it. The picture is a small
// image the app has already shrunk, sent as a data URL.
async function setLogo(user, id, logo) {
  await ensure();
  let rec;
  try { rec = await pb.asSuper("GET", `${base}/records/${encodeURIComponent(id)}`); }
  catch (e) { if (e.status === 404) return { status: 404, message: "That menu no longer exists." }; throw e; }
  const v = typeof logo === "string" ? logo : "";
  if (v && !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(v)) return { status: 400, message: "That isn't a usable picture." };
  if (v.length > 400000) return { status: 400, message: "That picture is too big." };
  const out = await pb.asSuper("PATCH", `${base}/records/${encodeURIComponent(id)}`, { logo: v });
  return { menu: shape(out, user) };
}
// The original material a menu was read from (photos, PDF pages, pasted text or the link) is kept with the menu, so it can be
// looked at again or re-read later. Anyone who is not view-only can add to it when they upload; everyone can look.
async function addSources(user, id, items) {
  await ensure();
  try { await pb.asSuper("GET", `${base}/records/${encodeURIComponent(id)}`); } catch (e) { if (e.status === 404) return { status: 404, message: "That menu no longer exists." }; throw e; }
  let saved = 0;
  for (const it of (Array.isArray(items) ? items : []).slice(0, 12)) {
    const kind = it && ["image", "text", "url"].includes(it.kind) ? it.kind : "";
    let data = "", mime = "";
    if (kind === "image") { mime = /^image\/(jpeg|png|webp)$/.test(it.type) ? it.type : "image/jpeg"; data = typeof it.data === "string" && /^[A-Za-z0-9+/=]+$/.test(it.data) ? it.data : ""; }
    else if (kind === "text") data = str(it.text, 60000);
    else if (kind === "url") data = str(it.url, 500);
    if (!kind || !data || data.length > 6500000) continue;
    await pb.asSuper("POST", srcBase + "/records", { menuId: id, kind, name: str(it.name, 80) || (kind === "image" ? "Photo " + (saved + 1) : kind === "text" ? "Pasted text" : "Link"), mime, byName: who(user), size: data.length, data });
    saved++;
  }
  return { saved };
}
async function listSources(user, id) {
  await ensure();
  const j = await pb.asSuper("GET", `${srcBase}/records?page=1&perPage=100&sort=created&fields=id,kind,name,mime,byName,size,created&filter=${encodeURIComponent(`menuId = '${str(id, 40).replace(/[^A-Za-z0-9]/g, "")}'`)}`);
  return { sources: (j.items || []).map(r => ({ id: r.id, kind: r.kind, name: r.name, mime: r.mime, byName: r.byName || "", size: r.size || 0, at: r.created || "" })) };
}
async function getSource(user, id, sid) {
  await ensure();
  let r; try { r = await pb.asSuper("GET", `${srcBase}/records/${encodeURIComponent(sid)}`); } catch (e) { if (e.status === 404) return { status: 404, message: "That file no longer exists." }; throw e; }
  if (r.menuId !== id) return { status: 404, message: "That file no longer exists." };
  return { source: { id: r.id, kind: r.kind, name: r.name, mime: r.mime, data: r.data } };
}
// Re-reads the menu from its saved original with today's instructions and model. The current version is archived first, so it can be
// restored from "Previous versions". Hand edits to items are replaced by the new reading (they stay in the archived version).
async function rerender(user, id, extract) {
  const g = await guarded(user, id); if (g.status) return g;
  const list = (await pb.asSuper("GET", `${srcBase}/records?page=1&perPage=100&sort=created&filter=${encodeURIComponent(`menuId = '${str(id, 40).replace(/[^A-Za-z0-9]/g, "")}'`)}`)).items || [];
  if (!list.length) return { status: 400, message: "No original was kept for this menu, so it can't be re-rendered. Upload it again instead." };
  const images = list.filter(s => s.kind === "image").map(s => ({ type: s.mime || "image/jpeg", data: s.data })), url = (list.find(s => s.kind === "url") || {}).data, text = list.filter(s => s.kind === "text").map(s => s.data).join("\n\n");
  const out = await extract(images.length ? { images } : url ? { url } : { text });
  if (!out || out.error) return { status: 422, message: "The AI couldn't read a menu from the original" + (out && out.error ? " (" + str(out.error, 120) + ")" : "") + ". Nothing was changed." };
  const stamp = Date.now().toString(36);
  const cats = cleanCategories((out.categories || []).map((c, ci) => ({ name: c && c.name, items: ((c && c.items) || []).map((i, ii) => ({ ...i, id: `r${stamp}c${ci}i${ii}`, edit: undefined })) })));
  if (!cats) return { status: 422, message: "No menu items were found in the original. Nothing was changed." };
  await archive(g.rec);
  const rec = await pb.asSuper("PATCH", `${base}/records/${encodeURIComponent(id)}`, { categories: cats, currency: str(out.currency, 8) || g.rec.currency || "R", phone: g.rec.phone || str(out.phone, 40), version: nowIso(), versionByName: who(user), rerenderReq: [] });
  return { menu: shape(rec, user) };
}
async function requestRerender(user, id) {
  await ensure();
  let rec; try { rec = await pb.asSuper("GET", `${base}/records/${encodeURIComponent(id)}`); } catch (e) { if (e.status === 404) return { status: 404, message: "That menu no longer exists." }; throw e; }
  const cur = (Array.isArray(rec.rerenderReq) ? rec.rerenderReq : []).filter(x => x && x.by !== user.id);
  const out = await pb.asSuper("PATCH", `${base}/records/${encodeURIComponent(id)}`, { rerenderReq: [...cur, { by: user.id, byName: who(user), at: nowIso() }].slice(-30) });
  return { menu: shape(out, user), requested: true };
}
// An admin, or the person who uploaded the menu, confirms the edits other people made: the "edited by" tag is cleared (one item, or all of them). The new values stay.
async function confirmEdits(user, id, itemId) {
  await ensure();
  let rec; try { rec = await pb.asSuper("GET", `${base}/records/${encodeURIComponent(id)}`); } catch (e) { if (e.status === 404) return { status: 404, message: "That menu no longer exists." }; throw e; }
  if (!canEdit(user, rec)) return { status: 403, message: "Only an editor, an admin or the person who uploaded this menu can confirm its edits." };
  let n = 0;
  const cats = (Array.isArray(rec.categories) ? rec.categories : []).map(c => ({ ...c, items: (c.items || []).map(i => {
    if (!i.edit || (itemId && i.id !== itemId)) return i;
    n++; const { edit, ...rest } = i; return rest;
  }) }));
  if (!n) return { menu: shape(rec, user), cleared: 0 };
  const out = await pb.asSuper("PATCH", `${base}/records/${encodeURIComponent(id)}`, { categories: cats });
  return { menu: shape(out, user), cleared: n };
}
async function remove(user, id) {
  const g = await guarded(user, id); if (g.status) return g;
  await pb.asSuper("DELETE", `${base}/records/${encodeURIComponent(id)}`);
  return { ok: true };
}

module.exports = { confirmEdits, rerender, requestRerender, addSources, listSources, getSource, setLogo, list, create, update, remove, cleanMenu, editItem, addBranch, versions, restore };
