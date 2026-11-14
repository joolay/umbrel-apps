// Families, shared by every JoolzApp app (the `joolz_families` collection lives in the shared PocketBase, so a link made in one app shows in all of them).
// A family has two tiers: "family" (immediate: shares joint expenses such as family orders) and "extended" (cousins, grandparents, aunts and so on, with a
// relationship label; linked for future apps, and they never see family expenses). Another app only needs mine(user): members[].tier / .relation.
// Collections are only reachable by the server (as superuser), which enforces the rules.
"use strict";
const pb = require("./pocketbase");

const FAM = process.env.JOOLZ_FAMILIES_COLLECTION || "joolz_families";
const ORD = process.env.GRUBTOGO_FAMILY_ORDERS_COLLECTION || "grubtogo_family_orders";
const famBase = "/api/collections/" + encodeURIComponent(FAM), ordBase = "/api/collections/" + encodeURIComponent(ORD);
const FAM_FIELDS = [["name", "text", true], ["owner", "text", true], ["ownerName", "text"], ["memberIds", "text"], ["invitedIds", "text"], ["members", "json", false, { maxSize: 100000 }], ["invited", "json", false, { maxSize: 100000 }]];
const ORD_FIELDS = [["familyId", "text", true], ["byId", "text", true], ["byName", "text"], ["data", "json", false, { maxSize: 1000000 }]];
const MAX_MEMBERS = 60;
const TIERS = ["family", "extended"];
const tierOf = m => m && m.tier === "extended" ? "extended" : "family";

async function addMissing(path, wanted) {
  const col = await pb.asSuper("GET", path), key = col.fields ? "fields" : "schema", have = col[key] || [];
  const missing = wanted.filter(w => !have.some(f => f.name === w[0]));
  if (!missing.length) return;
  const mk = ([name, type, required, opts]) => key === "fields" ? { name, type, required: !!required, ...(opts || {}) } : { name, type, required: !!required, options: { ...(opts || {}) } };
  await pb.asSuper("PATCH", path, { [key]: [...have, ...missing.map(mk)] });
}
let ready = null;
function ensure() {
  if (!ready) ready = (async () => {
    const users = await pb.asSuper("GET", "/api/collections/" + encodeURIComponent(pb.collection));
    const key = users.fields ? "fields" : "schema";
    const mk = ([name, type, required, opts]) => key === "fields" ? { name, type, required: !!required, ...(opts || {}) } : { name, type, required: !!required, options: { ...(opts || {}) } };
    for (const [path, name, fields] of [[famBase, FAM, FAM_FIELDS], [ordBase, ORD, ORD_FIELDS]]) {
      try { await addMissing(path, fields); continue; } catch (e) { if (e.status !== 404) throw e; }
      try { await pb.asSuper("POST", "/api/collections", { name, type: "base", [key]: fields.map(mk), listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null }); }
      catch (e) { if (e.status !== 400) throw e; }
    }
  })().catch(e => { ready = null; throw e; });
  return ready;
}

const clean = s => String(s || "").replace(/[^A-Za-z0-9]/g, "");
const str = (v, n) => String(v == null ? "" : v).trim().slice(0, n);
const nameOf = u => str(u.name || String(u.email || "").split("@")[0], 80);
const tag = ids => "," + ids.join(",") + ",";
const q = s => encodeURIComponent(s);

async function familyOf(userId) {
  const id = clean(userId);
  const j = await pb.asSuper("GET", `${famBase}/records?page=1&perPage=1&filter=${q(`memberIds ~ ',${id},'`)}`);
  return (j.items || [])[0] || null;
}
const ids = rec => (rec.members || []).map(m => m.id);
async function save(rec, members, invited, owner) {
  const patch = { members, invited, memberIds: tag(members.map(m => m.id)), invitedIds: tag(invited.map(m => m.id)) };
  if (owner) { patch.owner = owner.id; patch.ownerName = owner.name; }
  return pb.asSuper("PATCH", `${famBase}/records/${encodeURIComponent(rec.id)}`, patch);
}
const norm = m => ({ id: m.id, name: m.name || "", tier: tierOf(m), relation: str(m.relation, 40) });
const shapeFam = (rec, user) => { if (!rec) return null; const members = (rec.members || []).map(norm), me = members.find(m => m.id === user.id);
  return { id: rec.id, name: rec.name, owner: rec.owner, ownerName: rec.ownerName || "", isOwner: rec.owner === user.id, myTier: me ? me.tier : "family",
    members, invited: rec.owner === user.id ? (rec.invited || []).map(norm) : [] }; };
// Only immediate family share family expenses.
async function immediate(user) {
  const fam = await familyOf(user.id); if (!fam) return { error: fail(400, "Join or create a family first.") };
  const me = (fam.members || []).find(m => m.id === user.id);
  if (me && tierOf(me) === "extended") return { error: fail(403, "Family expenses are for immediate family. You're linked as extended family.") };
  return { fam };
}

// The person's family (if any) and invitations waiting for them.
async function mine(user) {
  await ensure();
  const fam = await familyOf(user.id);
  const j = await pb.asSuper("GET", `${famBase}/records?page=1&perPage=20&filter=${q(`invitedIds ~ ',${clean(user.id)},'`)}`);
  return { family: shapeFam(fam, user), invites: (j.items || []).map(r => ({ id: r.id, name: r.name, ownerName: r.ownerName || "" })) };
}
const fail = (status, message) => ({ status, message });

async function create(user, name) {
  await ensure();
  name = str(name, 60); if (!name) return fail(400, "Give the family a name.");
  if (await familyOf(user.id)) return fail(400, "You are already in a family.");
  const me = { id: user.id, name: nameOf(user) };
  await pb.asSuper("POST", famBase + "/records", { name, owner: me.id, ownerName: me.name, members: [me], invited: [], memberIds: tag([me.id]), invitedIds: tag([]) });
  return mine(user);
}
async function invite(user, email, tier, relation) {
  await ensure();
  const fam = await familyOf(user.id); if (!fam) return fail(400, "Create a family first.");
  if (fam.owner !== user.id) return fail(403, "Only the person who created the family can invite.");
  email = str(email, 200).toLowerCase(); if (!/^\S+@\S+\.\S+$/.test(email)) return fail(400, "Enter their JoolzApp email address.");
  const t = await pb.findByEmail(email);
  if (!t) return fail(404, "There's no JoolzApp account with that email. They need to sign up first.");
  const members = fam.members || [], invited = fam.invited || [];
  if (members.some(m => m.id === t.id)) return fail(400, "They're already in your family.");
  if (invited.some(m => m.id === t.id)) return fail(400, "They've already been invited.");
  if (members.length + invited.length >= MAX_MEMBERS) return fail(400, "That family is full.");
  tier = TIERS.includes(tier) ? tier : "family";
  await save(fam, members, [...invited, { id: t.id, name: nameOf(t), tier, relation: str(relation, 40) }]);
  return mine(user);
}
async function respond(user, familyId, accept) {
  await ensure();
  let fam;
  try { fam = await pb.asSuper("GET", `${famBase}/records/${encodeURIComponent(clean(familyId))}`); } catch (e) { if (e.status === 404) return fail(404, "That invitation is no longer there."); throw e; }
  const invited = fam.invited || [], mine_ = invited.find(m => m.id === user.id);
  if (!mine_) return fail(404, "That invitation is no longer there.");
  const rest = invited.filter(m => m.id !== user.id);
  if (!accept) { await save(fam, fam.members || [], rest); return mine(user); }
  if (await familyOf(user.id)) return fail(400, "You are already in a family. Leave it first to join another.");
  await save(fam, [...(fam.members || []), { id: user.id, name: nameOf(user), tier: tierOf(mine_), relation: mine_.relation || "" }], rest);
  return mine(user);
}
// Leaving (or the owner removing someone). The owner role passes on if the owner leaves; an empty family is deleted.
async function drop(user, memberId) {
  await ensure();
  const fam = await familyOf(user.id); if (!fam) return fail(400, "You are not in a family.");
  memberId = memberId ? clean(memberId) : user.id;
  if (memberId !== user.id && fam.owner !== user.id) return fail(403, "Only the person who created the family can remove members.");
  const members = (fam.members || []).filter(m => m.id !== memberId), invited = (fam.invited || []).filter(m => m.id !== memberId);
  if (!members.length) { await pb.asSuper("DELETE", `${famBase}/records/${encodeURIComponent(fam.id)}`); return mine(user); }
  await save(fam, members, invited, fam.owner === memberId ? members[0] : null);
  return mine(user);
}

async function addOrder(user, order) {
  await ensure();
  const { fam, error } = await immediate(user); if (error) return error;
  const rec = await pb.asSuper("POST", ordBase + "/records", { familyId: fam.id, byId: user.id, byName: nameOf(user), data: order });
  return { order: shapeOrder(rec) };
}
const shapeOrder = rec => ({ ...(rec.data || {}), id: rec.id, byId: rec.byId, byName: rec.byName || "", scope: "family" });
async function listOrders(user) {
  await ensure();
  const fam = await familyOf(user.id); if (!fam) return { orders: [] };
  if (tierOf((fam.members || []).find(m => m.id === user.id)) === "extended") return { orders: [] };
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const j = await pb.asSuper("GET", `${ordBase}/records?page=${page}&perPage=500&sort=-created&filter=${q(`familyId = '${clean(fam.id)}'`)}`);
    out.push(...(j.items || []).map(shapeOrder)); if (page >= (j.totalPages || 1)) break;
  }
  return { orders: out };
}
// The owner moves someone between immediate and extended family, or changes their relationship label.
async function setTier(user, memberId, tier, relation) {
  await ensure();
  const fam = await familyOf(user.id); if (!fam) return fail(400, "You are not in a family.");
  if (fam.owner !== user.id) return fail(403, "Only the person who created the family can do that.");
  memberId = clean(memberId); if (memberId === user.id) return fail(400, "You are always immediate family.");
  const members = (fam.members || []).map(m => m.id === memberId ? { ...m, tier: TIERS.includes(tier) ? tier : tierOf(m), relation: str(relation !== undefined ? relation : m.relation, 40) } : m);
  await save(fam, members, fam.invited || []);
  return mine(user);
}
async function removeOrder(user, id) {
  await ensure();
  const { fam, error } = await immediate(user); if (error) return error;
  let rec;
  try { rec = await pb.asSuper("GET", `${ordBase}/records/${encodeURIComponent(clean(id))}`); } catch (e) { if (e.status === 404) return { ok: true }; throw e; }
  if (rec.familyId !== fam.id) return fail(403, "That order belongs to another family.");
  if (rec.byId !== user.id && fam.owner !== user.id) return fail(403, "Only the person who placed it, or the family's creator, can delete it.");
  await pb.asSuper("DELETE", `${ordBase}/records/${encodeURIComponent(rec.id)}`);
  return { ok: true };
}
// Ids of everyone linked to this person (any tier), so a split bill can be logged to their own spending.
async function linkedIds(user) {
  await ensure();
  const fam = await familyOf(user.id);
  return new Set(fam ? (fam.members || []).map(m => m.id).filter(id => id !== user.id) : []);
}
module.exports = { linkedIds, mine, create, invite, respond, drop, setTier, addOrder, listOrders, removeOrder };
