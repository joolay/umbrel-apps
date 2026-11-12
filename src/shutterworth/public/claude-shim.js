// Connects the ShutterWorth page to its own server. The page was first written
// for claude.ai, so this file provides the same window.claude.use(...) interface
// (db, assets, sample, downloads) backed by server.js instead.
(function () {
  "use strict";
  const ORIGIN = Math.random().toString(36).slice(2);
  const cache = new Map();            // "items/abc" -> data
  const listeners = new Set();        // {match(path), fire()}
  let ready = null;

  const err = (code, message) => Object.assign(new Error(message || code), { code });
  const newId = () => { const a = "abcdefghijklmnopqrstuvwxyz0123456789"; let s = ""; const r = crypto.getRandomValues(new Uint8Array(20)); for (const b of r) s += a[b % 36]; return s; };
  const clone = v => v == null ? v : JSON.parse(JSON.stringify(v));

  function notify(paths) {
    for (const l of listeners) if (paths === null || paths.some(p => l.match(p))) { try { l.fire(); } catch (e) { console.error(e); } }
  }
  async function loadAll() {
    const r = await fetch("api/docs", { cache: "no-store" });
    if (!r.ok) throw err("unavailable", "server returned " + r.status);
    const { docs } = await r.json();
    cache.clear(); for (const [k, v] of Object.entries(docs)) cache.set(k, v);
  }
  function connect() {
    let wasOpen = false;
    const es = new EventSource("api/events");
    es.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.hello) { if (wasOpen) loadAll().then(() => notify(null)).catch(() => {}); wasOpen = true; return; }
      if (m.origin === ORIGIN) return;
      const paths = [];
      for (const c of m.changes) { if (c.data === null) cache.delete(c.path); else cache.set(c.path, c.data); paths.push(c.path); }
      notify(paths);
    };
  }

  // writes are applied locally first so the page stays responsive, then sent to the server
  let queue = Promise.resolve();
  function write(ops) {
    const paths = [];
    for (const o of ops) {
      if (o.op === "delete") cache.delete(o.path);
      else if (o.op === "set") cache.set(o.path, clone(o.data));
      else if (o.op === "update") {
        if (!cache.has(o.path)) return Promise.reject(err("not-found", "No document at " + o.path));
        cache.set(o.path, { ...cache.get(o.path), ...clone(o.data) });
      }
      paths.push(o.path);
    }
    notify(paths);
    if (DRIVE) return window.SWDrive.write(ops);
    const p = queue.then(async () => {
      const r = await fetch("api/write", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ origin: ORIGIN, ops }) });
      if (!r.ok) { const j = await r.json().catch(() => ({})); await loadAll().catch(() => {}); notify(null); throw err(j.code || "unavailable", "Save failed"); }
    });
    queue = p.catch(() => {});
    return p;
  }

  function docSnap(path) {
    const has = cache.has(path), d = cache.get(path);
    return { id: path.split("/")[1], ref: docRef(path), exists: has, data: () => has ? clone(d) : undefined };
  }
  function docRef(path) {
    return {
      id: path.split("/")[1], path,
      set: data => write([{ op: "set", path, data }]),
      update: data => write([{ op: "update", path, data }]),
      delete: () => write([{ op: "delete", path }]),
      get: async () => { await ready; return docSnap(path); },
      onSnapshot(cb, onErr) {
        const l = { match: p => p === path, fire: () => cb(docSnap(path)) };
        listeners.add(l); ready.then(() => l.fire(), e => onErr && onErr(e));
        return () => listeners.delete(l);
      },
    };
  }
  function query(coll, order = null, lim = null) {
    const run = () => {
      const pre = coll + "/";
      let ds = [];
      for (const k of cache.keys()) if (k.startsWith(pre)) ds.push(docSnap(k));
      if (order) {
        const [f, dir] = order, s = dir === "desc" ? -1 : 1;
        ds.sort((a, b) => {
          const x = a.data()[f], y = b.data()[f];
          if (x === y) return 0; if (x === undefined || x === null) return 1; if (y === undefined || y === null) return -1;
          return x < y ? -s : s;
        });
      }
      if (lim != null) ds = ds.slice(0, lim);
      return { docs: ds, size: ds.length, empty: !ds.length, forEach: fn => ds.forEach(fn) };
    };
    return {
      orderBy: (f, dir = "asc") => query(coll, [f, dir], lim),
      limit: n => query(coll, order, n),
      get: async () => { await ready; return run(); },
      onSnapshot(cb, onErr) {
        const l = { match: p => p.startsWith(coll + "/"), fire: () => cb(run()) };
        listeners.add(l); ready.then(() => l.fire(), e => onErr && onErr(e));
        return () => listeners.delete(l);
      },
    };
  }
  const db = {
    collection: name => Object.assign(query(name), {
      doc: id => docRef(name + "/" + (id || newId())),
      add: async data => { const id = newId(); await write([{ op: "set", path: name + "/" + id, data }]); return docRef(name + "/" + id); },
    }),
    doc: path => docRef(path),
  };

  const assets = {
    async upload(blob) {
      const r = await fetch("api/assets", { method: "POST", headers: { "content-type": blob.type || "application/octet-stream" }, body: blob });
      if (!r.ok) throw err("upload_failed", "Photo upload failed");
      return r.json();
    },
    async delete(id) { await fetch("api/assets/" + encodeURIComponent(id), { method: "DELETE" }); },
  };

  // when accounts are on, accounts.js keeps the sign-in token here
  const swTokenHeader = () => { try { const t = localStorage.getItem("sw.token"); return t ? { "x-sw-token": t } : {}; } catch (e) { return {}; } };
  const toB64 = blob => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(",")[1]); fr.onerror = rej; fr.readAsDataURL(blob); });
  const sample = {
    async limits() {
      const r = await fetch("api/ai/status", { cache: "no-store" }).then(r => r.json()).catch(() => ({}));
      return { images: !!r.configured, text: !!r.configured };
    },
    async json(prompt, opts = {}) {
      const images = [];
      for (const im of opts.images || []) images.push({ type: im.type || "image/jpeg", data: await toB64(im) });
      const r = await fetch("api/ai", { method: "POST", headers: { "content-type": "application/json", ...swTokenHeader() }, body: JSON.stringify({ prompt, images, tier: opts.modelTier === "quick" ? "quick" : "default" }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw err(j.code || "ai_error", j.message || "AI request failed");
      return j.result;
    },
  };

  const downloads = {
    async save({ filename, data, mimeType }) {
      const blob = data instanceof Blob ? data : new Blob([data], { type: mimeType || (typeof data === "string" ? "text/plain;charset=utf-8" : "application/octet-stream") });
      const url = URL.createObjectURL(blob), a = document.createElement("a");
      a.href = url; a.download = filename || "download"; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    },
  };

  // Google Drive storage (gdrive-store.js) replaces the server for docs and photos on this device
  const DRIVE = !!(window.SWDrive && window.SWDrive.active());
  const caps = { db, assets: DRIVE ? window.SWDrive.assets : assets, sample, downloads };
  window.claude = {
    use(name) {
      if (!caps[name]) return Promise.reject(err("unavailable", name + " isn't available"));
      if (!ready) { ready = DRIVE ? window.SWDrive.load(cache, notify) : loadAll().then(connect); }
      return name === "db" ? ready.then(() => db) : Promise.resolve(caps[name]);
    },
  };
  window.shutterworth = { photoUrl: u => DRIVE ? window.SWDrive.photoUrl(u) : u, photoUrlAsync: async u => DRIVE ? window.SWDrive.photoUrlAsync(u) : u, refreshAI: () => { window.dispatchEvent(new Event("shutterworth-ai-changed")); } };
})();
