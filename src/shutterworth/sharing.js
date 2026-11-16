"use strict";
// Sharing a list with other JoolzApp people, view only or can edit. Only used when accounts are on.
//
// How it fits together (nothing about a list is ever copied: the owner's inventory stays the one real copy):
//  - Owner's inventory holds `shares/<listId>`: who the list is shared with and their role. Only this file writes it.
//  - Each invited person's inventory holds `invites/<ownerId>_<listId>`: the invitation and whether they accepted.
//  - The invited person's page is sent the shared list and its items as if they were their own ("mirrored"), tagged with `shared`.
//    Their writes to those items are checked here (role) and applied to the owner's inventory; photos are looked up there too.
//  - Whether someone really is a member is decided by the owner's `shares` record plus their own acceptance, never by the page.
const MAX_MEMBERS = 20;
const SEP = "_";
const KEY_RE = /^[a-z0-9]{15}_[A-Za-z0-9-]{1,64}$/;
const ID_RE = /^[a-z0-9]{15}$/;
const ROLES = new Set(["view", "edit"]);

module.exports = function makeSharing({ store, pb, clients, readBody, send, StoreError }) {
  const who = u => (u.name || u.email || "Someone");
  const docsOf = id => store.docs({ id });
  const err = (status, code, message) => new StoreError(status, code, message);

  async function sharesOf(ownerId) {
    const docs = await docsOf(ownerId), out = new Map();
    for (const [p, d] of Object.entries(docs)) if (p.startsWith("shares/") && d && Array.isArray(d.members)) out.set(p.slice(7), d);
    return out;
  }
  // Lists other people have shared with this person (accepted, and still confirmed by the owner).
  async function membershipsFor(userId) {
    const mine = await docsOf(userId), out = new Map();   // listId -> { ownerId, role }
    for (const [p, inv] of Object.entries(mine)) {
      if (!p.startsWith("invites/") || !inv || inv.status !== "accepted" || !KEY_RE.test(p.slice(8))) continue;
      const ownerId = String(inv.ownerId || ""), listId = String(inv.listId || "");
      if (p.slice(8) !== ownerId + SEP + listId || ownerId === userId) continue;
      const odocs = await docsOf(ownerId), list = odocs["lists/" + listId], sh = odocs["shares/" + listId];
      const m = sh && (sh.members || []).find(x => x.id === userId && x.status === "accepted");
      if (!list || list.deletedAt || !m || !ROLES.has(m.role)) continue;
      out.set(listId, { ownerId, role: m.role, ownerName: inv.ownerName || "" });
    }
    return out;
  }

  // The owner's shared lists and their items, as the invited person's page sees them.
  async function mirrorFor(user) {
    const out = {}, ms = await membershipsFor(user.id);
    const byOwner = new Map();
    for (const [listId, m] of ms) { if (!byOwner.has(m.ownerId)) byOwner.set(m.ownerId, []); byOwner.get(m.ownerId).push([listId, m]); }
    for (const [ownerId, lists] of byOwner) {
      const odocs = await docsOf(ownerId), set = new Map(lists);
      for (const [listId, m] of lists) out["lists/" + listId] = { ...odocs["lists/" + listId], shared: { ownerId, ownerName: m.ownerName, role: m.role } };
      for (const [p, d] of Object.entries(odocs)) if (p.startsWith("items/") && d && set.has(d.listId)) out[p] = d;
    }
    return out;
  }
  async function docsFor(user) { return { ...(await store.docs(user)), ...(await mirrorFor(user)) }; }

  /* ---------- live updates ---------- */
  const push = (userId, changes, origin) => { if (!changes.length) return; const msg = `data: ${JSON.stringify({ changes, origin })}\n\n`; for (const [res, o] of clients) if (o === userId) res.write(msg); };
  const refresh = userId => { const msg = `data: ${JSON.stringify({ refresh: true })}\n\n`; for (const [res, o] of clients) if (o === userId) res.write(msg); };
  // Tell the owner and everyone the changed lists are shared with.
  async function fanout(ownerId, changes, origin) {
    const shares = await sharesOf(ownerId), per = new Map();
    const accepted = lid => ((shares.get(lid) || {}).members || []).filter(m => m.status === "accepted").map(m => m.id);
    const add = (uid, c) => { if (!per.has(uid)) per.set(uid, []); per.get(uid).push(c); };
    const everyone = new Set([...shares.values()].flatMap(s => s.members.filter(m => m.status === "accepted").map(m => m.id)));
    for (const c of changes) {
      const id = c.path.split("/")[1];
      if (c.path.startsWith("lists/")) {
        for (const m of ((shares.get(id) || {}).members || []).filter(x => x.status === "accepted")) {
          if (!c.data || c.data.deletedAt) { add(m.id, { path: c.path, data: null }); continue; }
          const inv = (await docsOf(m.id))["invites/" + ownerId + SEP + id];
          add(m.id, { path: c.path, data: { ...c.data, shared: { ownerId, ownerName: (inv && inv.ownerName) || "", role: m.role } } });
        }
      } else if (c.path.startsWith("items/")) {
        if (!c.data) for (const uid of everyone) add(uid, c);
        else for (const uid of accepted(c.data.listId)) add(uid, c);
      }
    }
    push(ownerId, changes, origin);
    for (const [uid, cs] of per) push(uid, cs, origin);
  }

  /* ---------- writes ---------- */
  // Splits a person's writes into their own and ones that belong to an owner whose list is shared with them.
  async function write(user, ops, origin) {
    ops = Array.isArray(ops) ? ops : [];
    const mine = [], theirs = new Map();
    let ms = null, itemOwner = null;
    const need = async () => {
      if (ms) return;
      ms = await membershipsFor(user.id); itemOwner = new Map();
      for (const ownerId of new Set([...ms.values()].map(m => m.ownerId))) {
        const odocs = await docsOf(ownerId);
        for (const [p, d] of Object.entries(odocs)) if (p.startsWith("items/") && d && ms.get(d.listId) && ms.get(d.listId).ownerId === ownerId) itemOwner.set(p, ms.get(d.listId));
      }
    };
    for (const o of ops) {
      const p = o && typeof o.path === "string" ? o.path : "";
      if (p.startsWith("shares/") || p.startsWith("invites/")) throw err(400, "reserved_path", "That part of your inventory is managed by the app.");
      if (p.startsWith("lists/") && o.data && typeof o.data === "object") { o.data = { ...o.data }; delete o.data.shared; }
      await need();
      if (p.startsWith("lists/") && ms.has(p.slice(6))) throw err(403, "not_owner", "Only the owner can change or delete this list.");
      let target = null;
      if (p.startsWith("items/")) {
        const known = itemOwner.get(p);
        if (known) target = known;
        else if (o.op === "set" && o.data && ms.has(o.data.listId)) target = ms.get(o.data.listId);
        if (target) {
          if (target.role !== "edit") throw err(403, "read_only", "This list is shared with you as view only.");
          if (o.data && o.data.listId !== undefined && !(ms.get(o.data.listId) && ms.get(o.data.listId).ownerId === target.ownerId)) throw err(400, "cross_owner", "Items can't be moved out of a shared list.");
        }
      }
      if (target) { if (!theirs.has(target.ownerId)) theirs.set(target.ownerId, []); theirs.get(target.ownerId).push(o); } else mine.push(o);
    }
    const all = [];
    if (mine.length) { const ch = await store.write(user, mine); await fanout(user.id, ch, origin); all.push(...ch); }
    for (const [ownerId, list] of theirs) { const ch = await store.write({ id: ownerId }, list); await fanout(ownerId, ch, origin); }
    return all;
  }

  /* ---------- photos ---------- */
  async function photoOwners(user, needEdit) {
    const out = [], seen = new Set();
    for (const m of (await membershipsFor(user.id)).values()) if ((!needEdit || m.role === "edit") && !seen.has(m.ownerId)) { seen.add(m.ownerId); out.push(m.ownerId); }
    return out;
  }
  const photos = {
    async get(user, id) { let b = await store.getPhoto(user, id); if (b) return b; for (const o of await photoOwners(user, false)) { b = await store.getPhoto({ id: o }, id); if (b) return b; } return null; },
    async put(user, buf, listId) {
      if (listId) { const m = (await membershipsFor(user.id)).get(String(listId)); if (m) { if (m.role !== "edit") throw err(403, "read_only", "This list is shared with you as view only."); return store.putPhoto({ id: m.ownerId }, buf); } }
      return store.putPhoto(user, buf);
    },
    async del(user, id) { for (const o of [user.id, ...(await photoOwners(user, true))]) { const u = { id: o }; if (await store.getPhoto(u, id).catch(() => null)) return store.delPhoto(u, id); } },
  };

  /* ---------- sharing endpoints ---------- */
  const when = () => Date.now();
  async function setShare(ownerId, listId, mut) {
    const cur = (await docsOf(ownerId))["shares/" + listId] || { members: [] }, next = { members: mut(cur.members.map(m => ({ ...m }))) };
    const ch = next.members.length ? await store.write({ id: ownerId }, [{ op: "set", path: "shares/" + listId, data: next }]) : await store.write({ id: ownerId }, [{ op: "delete", path: "shares/" + listId }]);
    push(ownerId, ch, "server"); return next;
  }
  async function setInvite(userId, key, data) {
    const ch = data ? await store.write({ id: userId }, [{ op: "set", path: "invites/" + key, data }]) : await store.write({ id: userId }, [{ op: "delete", path: "invites/" + key }]);
    push(userId, ch, "server");
  }
  async function ownList(user, listId) {
    const l = (await store.docs(user))["lists/" + listId];
    if (!l || l.deletedAt) throw err(404, "no_list", "That list doesn't exist.");
    return l;
  }
  async function handle(req, res, p, user) {
    if (!p.startsWith("/api/share/") || req.method !== "POST") return false;
    let b; try { b = JSON.parse((await readBody(req)).toString() || "{}"); } catch { throw err(400, "bad_request", "Invalid request."); }
    const listId = String(b.listId || "");
    if (p === "/api/share/add") {
      const list = await ownList(user, listId), role = String(b.role || "view"), email = String(b.email || "").trim().toLowerCase();
      if (!ROLES.has(role)) throw err(400, "bad_role", "Choose view only or can edit.");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw err(400, "bad_email", "Enter a valid email address.");
      if (email === String(user.email || "").toLowerCase()) throw err(400, "self", "That's your own account.");
      const target = await pb.findByEmail(email);
      if (!target) throw err(404, "no_account", "Nobody has a JoolzApp account with that email. They can create one first, then you can share the list.");
      const cur = ((await docsOf(user.id))["shares/" + listId] || { members: [] }).members;
      if (cur.length >= MAX_MEMBERS && !cur.some(m => m.id === target.id)) throw err(400, "too_many", "A list can be shared with up to " + MAX_MEMBERS + " people.");
      await setShare(user.id, listId, ms => {
        const m = ms.find(x => x.id === target.id);
        if (m) { m.role = role; if (m.status === "declined") m.status = "pending"; } else ms.push({ id: target.id, email: target.email, name: target.name || "", role, status: "pending", at: when() });
        return ms;
      });
      const key = user.id + SEP + listId, prev = (await docsOf(target.id))["invites/" + key];
      await setInvite(target.id, key, { ownerId: user.id, ownerName: who(user), listId, listName: list.name || "List", role, status: prev && prev.status === "accepted" ? "accepted" : "pending", at: when() });
      refresh(target.id); send(res, 200, { ok: true }); return true;
    }
    if (p === "/api/share/role" || p === "/api/share/remove") {
      await ownList(user, listId);
      const memberId = String(b.memberId || ""), role = String(b.role || "");
      if (!ID_RE.test(memberId)) throw err(400, "bad_request", "Invalid request.");
      if (p === "/api/share/role" && !ROLES.has(role)) throw err(400, "bad_role", "Choose view only or can edit.");
      await setShare(user.id, listId, ms => p === "/api/share/remove" ? ms.filter(m => m.id !== memberId) : ms.map(m => m.id === memberId ? { ...m, role } : m));
      const key = user.id + SEP + listId, inv = (await docsOf(memberId))["invites/" + key];
      if (p === "/api/share/remove") await setInvite(memberId, key, null); else if (inv) await setInvite(memberId, key, { ...inv, role });
      refresh(memberId); send(res, 200, { ok: true }); return true;
    }
    if (p === "/api/share/respond" || p === "/api/share/leave") {
      const key = String(b.key || ""); if (!KEY_RE.test(key)) throw err(400, "bad_request", "Invalid request.");
      const inv = (await store.docs(user))["invites/" + key]; if (!inv) throw err(404, "no_invite", "That invitation no longer exists.");
      const ownerId = String(inv.ownerId), lid = String(inv.listId), accept = p === "/api/share/respond" && !!b.accept;
      const sh = (await docsOf(ownerId))["shares/" + lid];
      const still = sh && sh.members.some(m => m.id === user.id);
      if (!still) { await setInvite(user.id, key, null); refresh(user.id); send(res, 200, { ok: true }); return true; }   // the owner already removed it
      if (accept) { await setShare(ownerId, lid, ms => ms.map(m => m.id === user.id ? { ...m, status: "accepted" } : m)); await setInvite(user.id, key, { ...inv, status: "accepted" }); }
      else { await setShare(ownerId, lid, ms => p === "/api/share/leave" ? ms.filter(m => m.id !== user.id) : ms.map(m => m.id === user.id ? { ...m, status: "declined" } : m)); await setInvite(user.id, key, null); }
      refresh(user.id); refresh(ownerId); send(res, 200, { ok: true }); return true;
    }
    return false;
  }

  return { docsFor, write, photos, handle, fanout, membershipsFor };
};
