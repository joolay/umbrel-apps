// Under-18s: an account needs a date of birth, and anyone under 18 needs a parent or guardian with their own JoolzApp account to approve it.
// Parents also approve the kid's settings that matter (for now: joining a family). Data lives in the shared PocketBase (`joolz_guardians`), so
// any JoolzApp app can read it: statusOf(user) says whether the person is a minor and whether a parent has approved.
"use strict";
const pb = require("./pocketbase");

const COLL = process.env.JOOLZ_GUARDIANS_COLLECTION || "joolz_guardians";
const base = "/api/collections/" + encodeURIComponent(COLL);
const FIELDS = [["childId", "text", true], ["childName", "text"], ["parentId", "text", true], ["parentName", "text"], ["kind", "text"], ["ref", "text"], ["label", "text"], ["status", "text"], ["decidedAt", "text"]];
const ADULT = 18;

let ready = null;
function ensure() {
  if (!ready) ready = (async () => {
    const users = await pb.asSuper("GET", "/api/collections/" + encodeURIComponent(pb.collection));
    const key = users.fields ? "fields" : "schema";
    const mk = ([name, type, required]) => key === "fields" ? { name, type, required: !!required } : { name, type, required: !!required, options: {} };
    try {
      const col = await pb.asSuper("GET", base), k = col.fields ? "fields" : "schema", have = col[k] || [];
      const missing = FIELDS.filter(f => !have.some(h => h.name === f[0]));
      if (missing.length) await pb.asSuper("PATCH", base, { [k]: [...have, ...missing.map(mk)] });
    } catch (e) {
      if (e.status !== 404) throw e;
      try { await pb.asSuper("POST", "/api/collections", { name: COLL, type: "base", [key]: FIELDS.map(mk), listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null }); }
      catch (e2) { if (e2.status !== 400) throw e2; }
    }
  })().catch(e => { ready = null; throw e; });
  return ready;
}

const q = s => encodeURIComponent(s), clean = s => String(s || "").replace(/[^A-Za-z0-9]/g, "");
const nameOf = u => String(u.name || String(u.email || "").split("@")[0]).slice(0, 80);
function validDob(dob) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dob || "")); if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] && +m[1] >= 1900 && d.getTime() <= Date.now();
}
function ageOf(dob) {
  if (!validDob(dob)) return null;
  const [y, m, d] = dob.split("-").map(Number), n = new Date();
  let a = n.getUTCFullYear() - y; if (n.getUTCMonth() + 1 < m || (n.getUTCMonth() + 1 === m && n.getUTCDate() < d)) a--;
  return a;
}
const isMinor = u => !!(u && !u.isAdmin && u.dob && ageOf(u.dob) !== null && ageOf(u.dob) < ADULT);

async function rows(filter) {
  await ensure();
  const out = [];
  for (let page = 1; page <= 5; page++) {
    const j = await pb.asSuper("GET", `${base}/records?page=${page}&perPage=200&sort=created&filter=${q(filter)}`);
    out.push(...(j.items || [])); if (page >= (j.totalPages || 1)) break;
  }
  return out;
}
// Is this person a minor, and has a parent approved them?
async function statusOf(u) {
  if (!isMinor(u)) return { minor: false, approved: true };
  const r = await rows(`childId = '${clean(u.id)}' && (kind = 'account' || kind = 'admin')`);
  const par = r.filter(x => x.kind === "account"), adm = r.filter(x => x.kind === "admin");
  const adminOk = !adm.some(x => x.status !== "approved");   // accounts a parent created here also need an admin's OK
  return { minor: true, approved: adminOk && par.some(x => x.status === "approved"), adminPending: !adminOk, parents: par.map(x => ({ name: x.parentName || "", status: x.status })) };
}
// A parent creating a child's account: the parent has approved already, an admin still has to.
async function createdByParent(child, parent) {
  await ensure();
  const base_ = { childId: child.id, childName: nameOf(child), parentId: parent.id, parentName: nameOf(parent), ref: "" };
  await pb.asSuper("POST", base + "/records", { ...base_, kind: "account", label: "Created by " + nameOf(parent), status: "approved", decidedAt: new Date().toISOString() });
  await pb.asSuper("POST", base + "/records", { ...base_, kind: "admin", label: "Admin approval", status: "pending" });
}
async function adminDecide(childId, approve) {
  await ensure();
  for (const x of await rows(`childId = '${clean(childId)}' && kind = 'admin'`)) await pb.asSuper("PATCH", base + "/records/" + x.id, { status: approve ? "approved" : "declined", decidedAt: new Date().toISOString() });
}
// Checks the parents someone names: each must already have an account, be a different person, and not be a minor themselves.
async function checkParents(emails, childEmail) {
  const list = [...new Set((Array.isArray(emails) ? emails : [emails]).map(e => String(e || "").trim().toLowerCase()).filter(Boolean))].slice(0, 2);
  if (!list.length) return { error: "Enter a parent or guardian's JoolzApp email. They need their own account to approve yours." };
  const parents = [];
  for (const e of list) {
    if (e === String(childEmail || "").toLowerCase()) return { error: "A parent or guardian has to be someone else." };
    const u = await pb.findByEmail(e);
    if (!u) return { error: `There's no JoolzApp account for ${e}. Your parent or guardian needs to create one first.` };
    if (isMinor(u)) return { error: `${e} is under 18, so they can't approve your account.` };
    parents.push({ id: u.id, name: nameOf(u) });
  }
  return { parents };
}
async function requestApproval(child, parents) {
  await ensure();
  const have = await rows(`childId = '${clean(child.id)}' && kind = 'account'`);
  for (const p of parents) {
    if (have.some(x => x.parentId === p.id && x.status !== "declined")) continue;
    await pb.asSuper("POST", base + "/records", { childId: child.id, childName: nameOf(child), parentId: p.id, parentName: p.name, kind: "account", ref: "", label: "Approve " + nameOf(child) + "'s account", status: "pending", decidedAt: "" });
  }
}
// A kid's family-join needs a parent's approval too.
async function requestFamily(child, familyId, familyName) {
  await ensure();
  const parents = (await rows(`childId = '${clean(child.id)}' && kind = 'account' && status = 'approved'`));
  const open = await rows(`childId = '${clean(child.id)}' && kind = 'family' && ref = '${clean(familyId)}' && status = 'pending'`);
  if (open.length) return;
  for (const p of parents) await pb.asSuper("POST", base + "/records", { childId: child.id, childName: nameOf(child), parentId: p.parentId, parentName: p.parentName, kind: "family", ref: familyId, label: nameOf(child) + " wants to join the " + String(familyName || "") + " family", status: "pending", decidedAt: "" });
}
// What a parent sees: requests waiting on them, and the kids they look after.
async function inbox(parent) {
  const pend = await rows(`parentId = '${clean(parent.id)}' && status = 'pending' && kind != 'admin'`);
  const kids = await rows(`parentId = '${clean(parent.id)}' && kind = 'account' && status = 'approved'`);
  return { pending: pend.map(x => ({ id: x.id, kind: x.kind, childName: x.childName, label: x.label })), kids: kids.map(x => ({ childId: x.childId, childName: x.childName })) };
}
// Returns { ok, applied } or { status, message }. `join` is called when a family-join is approved.
async function decide(parent, id, approve, join) {
  await ensure();
  let r;
  try { r = await pb.asSuper("GET", `${base}/records/${encodeURIComponent(clean(id))}`); } catch (e) { if (e.status === 404) return { status: 404, message: "That request is no longer there." }; throw e; }
  if (r.parentId !== parent.id || r.status !== "pending" || r.kind === "admin") return { status: 404, message: "That request is no longer there." };
  const status = approve ? "approved" : "declined", at = new Date().toISOString();
  await pb.asSuper("PATCH", `${base}/records/${r.id}`, { status, decidedAt: at });
  if (r.kind === "family") {   // one parent's answer settles it for the others
    for (const o of await rows(`childId = '${clean(r.childId)}' && kind = 'family' && ref = '${clean(r.ref)}' && status = 'pending'`)) await pb.asSuper("PATCH", `${base}/records/${o.id}`, { status, decidedAt: at });
    if (approve && join) await join(r.childId, r.ref);
  }
  return { ok: true };
}
// A parent withdraws their approval of a kid's account.
async function revoke(parent, childId) {
  await ensure();
  for (const r of await rows(`parentId = '${clean(parent.id)}' && childId = '${clean(childId)}' && kind = 'account' && status = 'approved'`)) await pb.asSuper("PATCH", `${base}/records/${r.id}`, { status: "declined", decidedAt: new Date().toISOString() });
  return { ok: true };
}
module.exports = { createdByParent, adminDecide, validDob, ageOf, isMinor, statusOf, checkParents, requestApproval, requestFamily, inbox, decide, revoke };
