// Families, shared by every JoolzApp app (the `joolz_families` collection lives in the shared PocketBase, so a link made in one app shows in all of them).
// A family is ONE HOUSEHOLD: the people who live together and share joint expenses such as family orders. Everyone is in at most one household.
// Extended relatives (grandparents, aunts, cousins...) keep their own account and are linked to a family as "extended": they can be extended family of
// any number of families at once (a grandparent of several households), with a relationship label, and they never see family expenses.
// If an extended relative moves in, the creator or a manager moves them into the household (tier "family") and they share expenses from then on.
// Another app only needs mine(user): family.members (household) and family.extended / extendedIn (links across households).
// Collections are only reachable by the server (as superuser), which enforces the rules.
"use strict";
const pb = require("./pocketbase");

const FAM = process.env.JOOLZ_FAMILIES_COLLECTION || "joolz_families";
const ORD = process.env.GRUBTOGO_FAMILY_ORDERS_COLLECTION || "grubtogo_family_orders";
const famBase = "/api/collections/" + encodeURIComponent(FAM), ordBase = "/api/collections/" + encodeURIComponent(ORD);
const FAM_FIELDS = [["name", "text", true], ["owner", "text", true], ["ownerName", "text"], ["memberIds", "text"], ["invitedIds", "text"], ["invitedEmails", "text"], ["extendedIds", "text"], ["members", "json", false, { maxSize: 100000 }], ["invited", "json", false, { maxSize: 100000 }], ["extended", "json", false, { maxSize: 100000 }]];
const ORD_FIELDS = [["familyId", "text", true], ["byId", "text", true], ["byName", "text"], ["data", "json", false, { maxSize: 1000000 }]];
const MAX_MEMBERS = 60, MAX_EXTENDED = 150;
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

// Older records kept extended relatives inside `members` with tier "extended". They now live in `extended`, so a person who was only extended
// is free to have a household of their own. This runs the first time such a record is read.
async function fixup(rec) {
  const old = (rec.members || []).filter(m => m.tier === "extended" && m.id !== rec.owner);
  if (!old.length) return rec;
  const members = rec.members.filter(m => !old.includes(m));
  const extended = [...(rec.extended || []), ...old.filter(m => !(rec.extended || []).some(e => e.id === m.id)).map(m => ({ id: m.id, name: m.name || "", relation: str(m.relation, 40) }))];
  return (await save(rec, members, rec.invited || [], null, extended)) || { ...rec, members, extended };
}
async function familyOf(userId) {
  const id = clean(userId);
  const j = await pb.asSuper("GET", `${famBase}/records?page=1&perPage=1&filter=${q(`memberIds ~ ',${id},'`)}`);
  const rec = (j.items || [])[0]; if (!rec) return null;
  const fx = await fixup(rec);
  return (fx.members || []).some(m => m.id === id) ? fx : null;
}
// Every family this person is extended family of (a grandparent can be in many).
async function extendedOf(userId) {
  const id = clean(userId);
  const j = await pb.asSuper("GET", `${famBase}/records?page=1&perPage=100&filter=${q(`extendedIds ~ ',${id},'`)}`);
  return j.items || [];
}
const ids = rec => (rec.members || []).map(m => m.id);
async function save(rec, members, invited, owner, extended) {
  if (extended === undefined) extended = rec.extended || [];
  const patch = { members, invited, extended, extendedIds: tag(extended.map(m => m.id)), memberIds: tag(members.map(m => m.id)), invitedIds: tag(invited.filter(m => !m.email).map(m => m.id)), invitedEmails: tag(invited.filter(m => m.email).map(m => m.email)) };
  if (owner) { patch.owner = owner.id; patch.ownerName = owner.name; }
  return pb.asSuper("PATCH", `${famBase}/records/${encodeURIComponent(rec.id)}`, patch);
}
const norm = m => ({ id: m.id, name: m.name || "", tier: tierOf(m), relation: str(m.relation, 40), manager: !!m.manager, ...(m.email ? { email: m.email } : {}) });
const normExt = m => ({ id: m.id, name: m.name || "", relation: str(m.relation, 40) });
const canManage = (rec, userId) => rec.owner === userId || !!(rec.members || []).find(m => m.id === userId && m.manager);
const shapeFam = (rec, user) => { if (!rec) return null; const members = (rec.members || []).map(norm), me = members.find(m => m.id === user.id);
  return { id: rec.id, name: rec.name, owner: rec.owner, ownerName: rec.ownerName || "", isOwner: rec.owner === user.id, canManage: canManage(rec, user.id), myTier: "family",
    members, extended: (rec.extended || []).map(normExt), invited: canManage(rec, user.id) ? (rec.invited || []).map(norm) : [] }; };
// Only the household shares family expenses (extended relatives are not in `members`).
async function immediate(user) {
  const fam = await familyOf(user.id); if (!fam) return { error: fail(400, "Join or create a family first. Extended relatives are linked to a family but do not share its expenses.") };
  return { fam };
}

// The person's household (if any), the families they are extended family of, and invitations waiting for them.
async function mine(user) {
  await ensure();
  const fam = await familyOf(user.id), ext = await extendedOf(user.id);
  const em = String(user.email || "").toLowerCase().replace(/'/g, "");
  const j = await pb.asSuper("GET", `${famBase}/records?page=1&perPage=20&filter=${q(`invitedIds ~ ',${clean(user.id)},'` + (em ? ` || invitedEmails ~ ',${em},'` : ""))}`);
  const inviteFor = r => (r.invited || []).find(m => m.id === user.id || (m.email && m.email === em)) || {};
  return { family: shapeFam(fam, user),
    extendedIn: ext.filter(r => !fam || r.id !== fam.id).map(r => ({ id: r.id, name: r.name, ownerName: r.ownerName || "", relation: str(((r.extended || []).find(e => e.id === user.id) || {}).relation, 40) })),
    invites: (j.items || []).map(r => { const i = inviteFor(r); return { id: r.id, name: r.name, ownerName: r.ownerName || "", tier: tierOf(i), relation: str(i.relation, 40) }; }) };
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
  if (!canManage(fam, user.id)) return fail(403, "Only the creator or a manager can invite.");
  email = str(email, 200).toLowerCase(); if (!/^\S+@\S+\.\S+$/.test(email)) return fail(400, "Enter their JoolzApp email address.");
  const t = await pb.findByEmail(email);
  const members = fam.members || [], invited = fam.invited || [];
  if (!t) {   // no account yet: the invitation waits for them and appears when they sign up with this email
    if (invited.some(m => m.email === email)) return fail(400, "They've already been invited.");
    if (members.length + invited.length >= MAX_MEMBERS) return fail(400, "That family is full.");
    tier = TIERS.includes(tier) ? tier : "family";
    await save(fam, members, [...invited, { id: "em" + require("crypto").createHash("sha1").update(email).digest("hex").slice(0, 12), email, name: email, tier, relation: str(relation, 40) }]);
    return { ...(await mine(user)), notice: "They don't have a JoolzApp account yet. The invitation will be waiting when they sign up with " + email + "." };
  }
  if (members.some(m => m.id === t.id)) return fail(400, "They're already in your household.");
  if (invited.some(m => m.id === t.id)) return fail(400, "They've already been invited.");
  tier = TIERS.includes(tier) ? tier : "family";
  if (tier === "extended") { if ((fam.extended || []).some(m => m.id === t.id)) return fail(400, "They're already linked as extended family."); if ((fam.extended || []).length >= MAX_EXTENDED) return fail(400, "That family has too many extended relatives."); }
  else {
    if (members.length + invited.length >= MAX_MEMBERS) return fail(400, "That household is full.");
    const other = await familyOf(t.id);
    if (other && other.id !== fam.id) return fail(400, "They already belong to another household. Link them as extended family instead (they can be extended family of any number of families).");
  }
  await save(fam, members, [...invited, { id: t.id, name: nameOf(t), tier, relation: str(relation, 40) }]);
  return mine(user);
}
async function respond(user, familyId, accept) {
  await ensure();
  let fam;
  try { fam = await pb.asSuper("GET", `${famBase}/records/${encodeURIComponent(clean(familyId))}`); } catch (e) { if (e.status === 404) return fail(404, "That invitation is no longer there."); throw e; }
  const em = String(user.email || "").toLowerCase(), invited = fam.invited || [], mine_ = invited.find(m => m.id === user.id || (m.email && m.email === em));
  if (!mine_) return fail(404, "That invitation is no longer there.");
  const rest = invited.filter(m => m !== mine_);
  if (!accept) { await save(fam, fam.members || [], rest); return mine(user); }
  if (tierOf(mine_) === "extended") {   // linked as extended family: allowed alongside a household of their own, and to any number of families
    const extended = [...(fam.extended || []).filter(e => e.id !== user.id), { id: user.id, name: nameOf(user), relation: str(mine_.relation, 40) }];
    await save(fam, fam.members || [], rest, null, extended);
    return mine(user);
  }
  const cur = await familyOf(user.id);
  if (cur && cur.id !== fam.id) return fail(400, "You already live in another household. Leave it first to join this one, or ask to be linked as extended family.");
  await save(fam, [...(fam.members || []), { id: user.id, name: nameOf(user), tier: "family", relation: mine_.relation || "" }], rest, null, (fam.extended || []).filter(e => e.id !== user.id));
  return mine(user);
}
// Leaving (or the owner removing someone). The owner role passes on if the owner leaves; an empty family is deleted.
async function drop(user, memberId) {
  await ensure();
  const fam = await familyOf(user.id); if (!fam) return fail(400, "You are not in a family.");
  memberId = memberId ? clean(memberId) : user.id;
  const target = (fam.members || []).find(m => m.id === memberId);
  if (memberId !== user.id && !target && (fam.extended || []).some(e => e.id === memberId)) {   // removing an extended relative
    if (!canManage(fam, user.id)) return fail(403, "Only the creator or a manager can remove members.");
    await save(fam, fam.members || [], fam.invited || [], null, (fam.extended || []).filter(e => e.id !== memberId));
    return mine(user);
  }
  if (memberId !== user.id) {
    if (!canManage(fam, user.id)) return fail(403, "Only the creator or a manager can remove members.");
    if (memberId === fam.owner) return fail(403, "The creator can't be removed.");
    if (target && target.manager && fam.owner !== user.id) return fail(403, "Only the creator can remove a manager.");
  }
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
// The creator or a manager moves someone between the household and extended family (a grandparent who moves in, or out), or changes their relationship label.
async function setTier(user, memberId, tier, relation) {
  await ensure();
  const fam = await familyOf(user.id); if (!fam) return fail(400, "You are not in a family.");
  if (!canManage(fam, user.id)) return fail(403, "Only the creator or a manager can do that.");
  memberId = clean(memberId); if (memberId === fam.owner) return fail(400, "The creator always lives in the household.");
  const members = fam.members || [], extended = fam.extended || [];
  const inHome = members.find(m => m.id === memberId), inExt = extended.find(m => m.id === memberId);
  if (!inHome && !inExt) return fail(404, "They aren't in the family.");
  const rel = str(relation !== undefined ? relation : (inHome || inExt).relation, 40);
  tier = TIERS.includes(tier) ? tier : (inHome ? "family" : "extended");
  if (inHome && tier === "extended") {   // moved out of the household
    if (members.length <= 1) return fail(400, "The household needs at least one member.");
    await save(fam, members.filter(m => m.id !== memberId), fam.invited || [], null, [...extended, { id: inHome.id, name: inHome.name || "", relation: rel }]);
  } else if (inExt && tier === "family") {   // moved in
    const other = await familyOf(memberId);
    if (other && other.id !== fam.id) return fail(400, "They already live in another household. Ask them to leave it first.");
    if (members.length >= MAX_MEMBERS) return fail(400, "That household is full.");
    await save(fam, [...members, { id: inExt.id, name: inExt.name || "", tier: "family", relation: rel }], fam.invited || [], null, extended.filter(m => m.id !== memberId));
  } else if (inHome) await save(fam, members.map(m => m.id === memberId ? { ...m, relation: rel } : m), fam.invited || []);
  else await save(fam, members, fam.invited || [], null, extended.map(m => m.id === memberId ? { ...m, relation: rel } : m));
  return mine(user);
}
// An extended relative ends their own link to a family.
async function leaveExtended(user, familyId) {
  await ensure();
  let fam;
  try { fam = await pb.asSuper("GET", `${famBase}/records/${encodeURIComponent(clean(familyId))}`); } catch (e) { if (e.status === 404) return mine(user); throw e; }
  if ((fam.extended || []).some(e => e.id === user.id)) await save(fam, fam.members || [], fam.invited || [], null, (fam.extended || []).filter(e => e.id !== user.id));
  return mine(user);
}
// Only the creator decides who else may manage the family.
async function setManager(user, memberId, on) {
  await ensure();
  const fam = await familyOf(user.id); if (!fam) return fail(400, "You are not in a family.");
  if (fam.owner !== user.id) return fail(403, "Only the person who created the family can do that.");
  memberId = clean(memberId); if (memberId === user.id) return fail(400, "You already manage this family.");
  if (!(fam.members || []).some(m => m.id === memberId)) return fail(404, "They aren't in the family.");
  await save(fam, (fam.members || []).map(m => m.id === memberId ? { ...m, manager: !!on, ...(on ? { tier: "family" } : {}) } : m), fam.invited || []);
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
// Everyone this person shares events with: their household and its extended relatives, plus the households they are extended family of.
async function circleIds(user) {
  await ensure();
  const out = new Set([user.id]);
  const fam = await familyOf(user.id);
  if (fam) { (fam.members || []).forEach(m => out.add(m.id)); (fam.extended || []).forEach(m => out.add(m.id)); }
  for (const f of await extendedOf(user.id)) (f.members || []).forEach(m => out.add(m.id));
  return { householdId: fam ? fam.id : "", ids: out, familyIds: [...(fam ? [fam.id] : []), ...(await extendedOf(user.id)).map(f => f.id)] };
}
// Current household member ids of one family record (used to keep a household's paid access in step with who lives there).
async function memberIdsOf(familyId) {
  await ensure();
  try { const r = await pb.asSuper("GET", `${famBase}/records/${encodeURIComponent(clean(familyId))}`); return (await fixup(r)).members.map(m => m.id); }
  catch (e) { if (e.status === 404) return []; throw e; }
}
module.exports = { memberIdsOf, circleIds, leaveExtended, setManager, linkedIds, mine, create, invite, respond, drop, setTier, addOrder, listOrders, removeOrder };
