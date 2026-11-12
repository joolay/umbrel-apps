// Where ShutterWorth keeps lists, items and photos.
//
//  - Accounts on (PocketBase connected): every person's inventory lives in PocketBase under their own account.
//    The server only ever reads or writes the signed-in person's rows, so nobody can see anyone else's inventory.
//    Collections: `sw_docs` (one row per list/item/setting) and `sw_photos` (one row per photo file).
//    Neither has API rules, so only this server (the PocketBase superuser) can touch them.
//  - Accounts off: one shared inventory in the data folder (db.json and photos/), as before.
//
// An inventory that was kept in the data folder before accounts were switched on moves to the first admin's
// account, once, the first time an admin opens the app. It replaces anything that admin already had in PocketBase,
// and the old files are moved to <data folder>/legacy-backup/ (not deleted).
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

class StoreError extends Error {
  constructor(status, code, message, extra) { super(message || code); this.status = status; this.code = code; this.extra = extra || {}; }
}

const validPath = p => typeof p === "string" && /^[A-Za-z0-9_-]+\/[A-Za-z0-9_.:-]+$/.test(p);
const validPhotoId = id => typeof id === "string" && /^[a-f0-9]{16,64}$/.test(id);

// Works out the effect of a batch of writes without touching anything, so a bad op changes nothing.
// ops: [{ op: "set" | "update" | "delete", path, data }]  ->  staged: Map(path -> doc | null), changes: [{ path, data }]
function plan(docs, ops) {
  const staged = new Map(), changes = [];
  const get = p => (staged.has(p) ? staged.get(p) : docs[p] || null);
  for (const o of Array.isArray(ops) ? ops : []) {
    if (!o || !validPath(o.path)) throw new StoreError(400, "invalid_path");
    if (o.op === "delete") { staged.set(o.path, null); changes.push({ path: o.path, data: null }); }
    else if (o.op === "set") { const d = o.data || {}; staged.set(o.path, d); changes.push({ path: o.path, data: d }); }
    else if (o.op === "update") {
      const cur = get(o.path);
      if (!cur) throw new StoreError(404, "not_found", "not_found", { path: o.path });
      const d = { ...cur, ...o.data }; staged.set(o.path, d); changes.push({ path: o.path, data: d });
    } else throw new StoreError(400, "invalid_op");
  }
  return { staged, changes };
}

/* ---------- accounts off: one shared inventory on disk ---------- */
function diskStore(dataDir) {
  const DB_FILE = path.join(dataDir, "db.json"), PHOTO_DIR = path.join(dataDir, "photos");
  fs.mkdirSync(PHOTO_DIR, { recursive: true });
  let docs = {};
  try { docs = JSON.parse(fs.readFileSync(DB_FILE, "utf8")); } catch (e) { if (e.code !== "ENOENT") throw e; }
  let timer = null;
  const persistNow = () => { const tmp = DB_FILE + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(docs)); fs.renameSync(tmp, DB_FILE); };
  return {
    ownerKey: () => "local",
    async docs() { return docs; },
    async write(_user, ops) {
      const { staged, changes } = plan(docs, ops);
      for (const [p, d] of staged) { if (d === null) delete docs[p]; else docs[p] = d; }
      clearTimeout(timer); timer = setTimeout(persistNow, 300);
      return changes;
    },
    async putPhoto(_user, buf) { const id = crypto.randomBytes(16).toString("hex"); fs.writeFileSync(path.join(PHOTO_DIR, id), buf); return id; },
    async getPhoto(_user, id) { if (!validPhotoId(id)) return null; try { return fs.readFileSync(path.join(PHOTO_DIR, id)); } catch { return null; } },
    async delPhoto(_user, id) { if (validPhotoId(id)) fs.rmSync(path.join(PHOTO_DIR, id), { force: true }); },
    async flush() { clearTimeout(timer); persistNow(); },
  };
}

/* ---------- accounts on: each person's inventory in PocketBase ---------- */
function pbStore(pb, dataDir) {
  const DOCS = "sw_docs", PHOTOS = "sw_photos";
  const LEGACY_DB = path.join(dataDir, "db.json"), LEGACY_PHOTOS = path.join(dataDir, "photos");
  const MARKER = path.join(dataDir, "inventory-migrated.json"), BACKUP = path.join(dataDir, "legacy-backup");
  const recs = c => "/api/collections/" + c + "/records";
  const q = encodeURIComponent;
  const esc = s => String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const one = f => (Array.isArray(f) ? f[0] : f);

  let schemaReady = null;
  function ensureCollections() {
    if (!schemaReady) schemaReady = (async () => {
      await pb.ensureSchema();
      const users = await pb.asSuper("GET", "/api/collections/" + encodeURIComponent(pb.collection));
      const key = users.fields ? "fields" : "schema"; // PocketBase 0.23+ says "fields", 0.22 says "schema"
      const fld = (name, type, o = {}) => { const { required, ...opts } = o; return key === "fields" ? { name, type, required: !!required, ...opts } : { name, type, required: !!required, options: opts }; };
      const make = async (name, fields) => {
        try { await pb.asSuper("GET", "/api/collections/" + name); return; } catch (e) { if (e.status !== 404) throw e; }
        try {
          await pb.asSuper("POST", "/api/collections", {
            name, type: "base", [key]: fields,
            indexes: [`CREATE UNIQUE INDEX \`idx_${name}_owner_key\` ON \`${name}\` (\`owner\`, \`${fields[1].name}\`)`],
            listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null,
          });
        } catch (e) { try { await pb.asSuper("GET", "/api/collections/" + name); } catch { throw e; } } // another request may have just created it
      };
      await make(DOCS, [fld("owner", "text", { required: true }), fld("path", "text", { required: true }), fld("data", "json", { maxSize: 5242880 })]);
      await make(PHOTOS, [fld("owner", "text", { required: true }), fld("pid", "text", { required: true }), fld("file", "file", { maxSelect: 1, maxSize: 15728640 })]);
    })().catch(e => { schemaReady = null; throw e; });
    return schemaReady;
  }

  // per person: their docs, the PocketBase row id of each, and where each photo is
  const owners = new Map();
  function state(owner) {
    let s = owners.get(owner);
    if (!s) {
      s = { docs: null, ids: new Map(), photos: new Map(), loading: null, queue: Promise.resolve() };
      owners.set(owner, s);
      if (owners.size > 100) owners.delete(owners.keys().next().value);
    }
    return s;
  }
  const enqueue = (s, fn) => { const run = s.queue.then(() => fn()); s.queue = run.catch(() => {}); return run; };

  async function load(owner) {
    const s = state(owner);
    if (s.docs) return s;
    if (!s.loading) s.loading = (async () => {
      const docs = {}, ids = new Map();
      for (let page = 1; ; page++) {
        const j = await pb.asSuper("GET", recs(DOCS) + `?page=${page}&perPage=200&filter=${q(`owner = '${esc(owner)}'`)}`);
        for (const r of j.items || []) { docs[r.path] = r.data && typeof r.data === "object" ? r.data : {}; ids.set(r.path, r.id); }
        if (page >= (j.totalPages || 1)) break;
      }
      s.docs = docs; s.ids = ids;
    })().finally(() => { s.loading = null; });
    await s.loading;
    return s;
  }

  async function wipe(collection, owner) {
    for (let i = 0; i < 2000; i++) {
      const j = await pb.asSuper("GET", recs(collection) + `?page=1&perPage=200&filter=${q(`owner = '${esc(owner)}'`)}`);
      if (!(j.items || []).length) return;
      for (const r of j.items) await pb.asSuper("DELETE", recs(collection) + "/" + r.id);
    }
  }

  async function uploadPhoto(owner, pid, buf) {
    const fd = new FormData();
    fd.append("owner", owner); fd.append("pid", pid);
    fd.append("file", new Blob([buf], { type: "image/jpeg" }), pid + ".jpg");
    const r = await pb.superFetch(recs(PHOTOS), { method: "POST", body: fd });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new pb.PBError(r.status, j.message || "PocketBase couldn't store a photo", j.data);
    return { rid: j.id, file: one(j.file) };
  }

  async function findPhoto(owner, pid) {
    const s = state(owner);
    if (s.photos.has(pid)) return s.photos.get(pid);
    const j = await pb.asSuper("GET", recs(PHOTOS) + `?page=1&perPage=1&filter=${q(`owner = '${esc(owner)}' && pid = '${esc(pid)}'`)}`);
    const r = (j.items || [])[0];
    if (!r) return null;
    const v = { rid: r.id, file: one(r.file) };
    s.photos.set(pid, v);
    return v;
  }

  // The inventory from before accounts: db.json and photos/ in the data folder.
  const legacyPending = () => !fs.existsSync(MARKER) && fs.existsSync(LEGACY_DB);
  async function migrateLegacy(ownerId) {
    const legacy = JSON.parse(fs.readFileSync(LEGACY_DB, "utf8"));
    const photoIds = fs.existsSync(LEGACY_PHOTOS) ? fs.readdirSync(LEGACY_PHOTOS).filter(validPhotoId) : [];
    console.log(`Moving the existing inventory (${Object.keys(legacy).length} records, ${photoIds.length} photos) to the first admin's PocketBase account…`);
    await wipe(DOCS, ownerId); await wipe(PHOTOS, ownerId); // replaces whatever that account had
    let nd = 0, np = 0;
    for (const [p, data] of Object.entries(legacy)) {
      if (!validPath(p)) continue;
      await pb.asSuper("POST", recs(DOCS), { owner: ownerId, path: p, data: data && typeof data === "object" ? data : {} }); nd++;
    }
    for (const id of photoIds) { await uploadPhoto(ownerId, id, fs.readFileSync(path.join(LEGACY_PHOTOS, id))); np++; }
    fs.writeFileSync(MARKER, JSON.stringify({ at: new Date().toISOString(), owner: ownerId, docs: nd, photos: np }));
    fs.mkdirSync(BACKUP, { recursive: true });
    fs.renameSync(LEGACY_DB, path.join(BACKUP, "db.json"));
    if (fs.existsSync(LEGACY_PHOTOS)) fs.renameSync(LEGACY_PHOTOS, path.join(BACKUP, "photos"));
    owners.delete(ownerId);
    console.log(`Done: ${nd} records and ${np} photos are now in PocketBase. The old files are in ${BACKUP}.`);
  }

  let migrating = null;
  async function ready(user) {
    await ensureCollections();
    if (user.isAdmin && legacyPending()) {
      if (!migrating) migrating = (async () => {
        const first = await pb.firstAdmin();
        if (first && legacyPending()) await migrateLegacy(first.id);
      })().finally(() => { migrating = null; });
      await migrating;
    }
  }
  async function open(user) { await ready(user); return load(user.id); }

  return {
    ownerKey: user => user.id,
    async docs(user) { return (await open(user)).docs; },
    async write(user, ops) {
      const s = await open(user);
      return enqueue(s, async () => {
        const { staged, changes } = plan(s.docs, ops);
        try {
          for (const [p, d] of staged) {
            const rid = s.ids.get(p);
            if (d === null) {
              if (rid) { try { await pb.asSuper("DELETE", recs(DOCS) + "/" + rid); } catch (e) { if (e.status !== 404) throw e; } s.ids.delete(p); }
            } else if (rid) await pb.asSuper("PATCH", recs(DOCS) + "/" + rid, { data: d });
            else { const r = await pb.asSuper("POST", recs(DOCS), { owner: user.id, path: p, data: d }); s.ids.set(p, r.id); }
          }
        } catch (e) { owners.delete(user.id); throw e; } // forget the cache so the next request re-reads what PocketBase really holds
        for (const [p, d] of staged) { if (d === null) delete s.docs[p]; else s.docs[p] = d; }
        return changes;
      });
    },
    async putPhoto(user, buf) {
      await ready(user);
      const id = crypto.randomBytes(16).toString("hex");
      state(user.id).photos.set(id, await uploadPhoto(user.id, id, buf));
      return id;
    },
    async getPhoto(user, id) {
      if (!validPhotoId(id)) return null;
      await ready(user);
      const v = await findPhoto(user.id, id);
      if (!v) return null;
      const r = await pb.superFetch(`/api/files/${PHOTOS}/${v.rid}/${q(v.file)}`);
      if (r.status === 404) { state(user.id).photos.delete(id); return null; }
      if (!r.ok) throw new pb.PBError(r.status, "PocketBase couldn't return a photo");
      return Buffer.from(await r.arrayBuffer());
    },
    async delPhoto(user, id) {
      if (!validPhotoId(id)) return;
      await ready(user);
      const v = await findPhoto(user.id, id);
      if (!v) return;
      try { await pb.asSuper("DELETE", recs(PHOTOS) + "/" + v.rid); } catch (e) { if (e.status !== 404) throw e; }
      state(user.id).photos.delete(id);
    },
    async flush() {},
  };
}

function createStore({ pb, dataDir }) { return pb.enabled ? pbStore(pb, dataDir) : diskStore(dataDir); }

module.exports = { createStore, StoreError };
