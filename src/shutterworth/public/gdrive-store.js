// ShutterWorth: keep lists, items and photos in the user's own Google Drive.
//
// Each device chooses where its data lives (Settings → Storage):
//   - "server": this ShutterWorth server (the original behaviour)
//   - "gdrive": a private app folder in the user's Google Drive (drive.appdata scope,
//               so the app can only see its own files and nothing else in their Drive)
//
// Drive layout (all hidden in the app data folder):
//   db-main.json     lists, items, settings
//   db-backups.json  the in-app backups (kept apart so everyday saves stay small)
//   photo files      one JPEG per photo; items refer to them as "gdrive:<fileId>"
//
// Sign-in uses Google Identity Services in the browser. In the Android app later,
// swap getToken() for native Google sign-in and everything else stays the same.
(function () {
  "use strict";
  const SCOPE = "https://www.googleapis.com/auth/drive.appdata";
  const API = "https://www.googleapis.com/drive/v3/files";
  const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
  const LS = { mode: "sw.storage", hint: "sw.gdrive.email", pending: "sw.gdrive.pending" };
  const FILES = { main: "db-main.json", backups: "db-backups.json" };
  const isBackupPath = p => p.startsWith("backups/") || p.startsWith("backupParts/");
  const lsGet = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} };
  const err = (code, message) => Object.assign(new Error(message || code), { code });
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ---------- config + sign-in ----------
  let clientId = null, tokenClient = null, token = null, tokenExp = 0, gisLoading = null;
  async function getClientId() {
    if (clientId !== null) return clientId;
    try { clientId = (await fetch("api/app-config", { cache: "no-store" }).then(r => r.json())).googleClientId || ""; }
    catch (e) { clientId = ""; }
    return clientId;
  }
  function originProblem() {
    const h = location.hostname;
    if (h === "localhost" || h === "127.0.0.1") return "";
    if (location.protocol !== "https:") return "Google sign-in needs the app opened over https (not " + location.origin + ").";
    if (h.endsWith(".local") || /^\d+\.\d+\.\d+\.\d+$/.test(h)) return "Google sign-in doesn't accept " + h + " as an address.";
    return "";
  }
  function loadGis() {
    return gisLoading ||= new Promise((res, rej) => {
      if (window.google?.accounts?.oauth2) return res();
      const s = document.createElement("script");
      s.src = "https://accounts.google.com/gsi/client"; s.async = true;
      s.onload = () => res(); s.onerror = () => { gisLoading = null; rej(err("gis_failed", "Couldn't load Google sign-in. Check your connection.")); };
      document.head.appendChild(s);
    });
  }
  // interactive=true must be called from a tap (it may open Google's popup)
  async function getToken(interactive) {
    if (token && Date.now() < tokenExp - 60000) return token;
    const id = await getClientId();
    if (!id) throw err("no_client_id", "Google Drive isn't set up on this server yet.");
    const bad = originProblem(); if (bad) throw err("bad_origin", bad);
    await loadGis();
    return new Promise((res, rej) => {
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: id, scope: SCOPE, hint: lsGet(LS.hint) || undefined,
        callback: r => {
          if (r.error) return rej(err("auth_" + r.error, r.error_description || "Google sign-in was cancelled."));
          token = r.access_token; tokenExp = Date.now() + (r.expires_in || 3600) * 1000;
          whoAmI().catch(() => {}); res(token);
        },
        error_callback: e => rej(err("auth_" + (e.type || "failed"), e.type === "popup_closed" ? "Google sign-in was closed." : e.type === "popup_failed_to_open" ? "needs_tap" : "Google sign-in failed.")),
      });
      tokenClient.requestAccessToken({ prompt: interactive ? "" : "none" });
    });
  }
  async function whoAmI() {
    const r = await gfetch("https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)");
    const j = await r.json(); if (j.user?.emailAddress) lsSet(LS.hint, j.user.emailAddress);
  }
  function signOut() {
    if (token && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(token, () => {});
    token = null; tokenExp = 0; lsSet(LS.hint, null);
  }

  // fetch with auth; on 401 asks for a fresh token (silently) once
  async function gfetch(url, opts = {}, retried) {
    const t = await getToken(false);
    const r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), authorization: "Bearer " + t } });
    if (r.status === 401 && !retried) { token = null; return gfetch(url, opts, true); }
    if (r.status === 429 || r.status >= 500) { if (!retried) { await sleep(1500); return gfetch(url, opts, true); } }
    if (!r.ok) throw err("drive_" + r.status, "Google Drive error " + r.status);
    return r;
  }

  // ---------- Drive file helpers ----------
  async function findFile(name) {
    const q = encodeURIComponent(`name='${name}' and trashed=false`);
    const j = await (await gfetch(`${API}?spaces=appDataFolder&q=${q}&fields=files(id,version)&pageSize=10`)).json();
    return j.files?.[0] || null;
  }
  async function createFile(name, blob, mimeType) {
    const meta = { name, parents: ["appDataFolder"], mimeType };
    const fd = new FormData();
    fd.append("metadata", new Blob([JSON.stringify(meta)], { type: "application/json" }));
    fd.append("file", blob);
    return (await gfetch(`${UPLOAD}?uploadType=multipart&fields=id,version`, { method: "POST", body: fd })).json();
  }
  async function updateFile(id, blob) {
    return (await gfetch(`${UPLOAD}/${id}?uploadType=media&fields=id,version`, { method: "PATCH", body: blob, headers: { "content-type": blob.type } })).json();
  }
  const fileVersion = async id => (await (await gfetch(`${API}/${id}?fields=version`)).json()).version;
  const downloadJson = async id => (await gfetch(`${API}/${id}?alt=media`, { cache: "no-store" })).json();

  // ---------- document store (used by claude-shim.js) ----------
  // files[k] = {id, version}; the shim's cache Map is the single source of truth in memory
  const files = { main: null, backups: null };
  let cache = null, notify = null, pending = [], saving = null, saveTimer = null, status = "idle";
  const statusListeners = new Set();
  function setStatus(s) { status = s; statusListeners.forEach(f => { try { f(s); } catch (e) {} }); }
  const which = p => isBackupPath(p) ? "backups" : "main";

  function snapshot(k) {
    const out = {};
    for (const [p, v] of cache) if (which(p) === k) out[p] = v;
    return new Blob([JSON.stringify({ app: "shutterworth", v: 1, docs: out })], { type: "application/json" });
  }
  function applyOps(map, ops) {
    for (const o of ops) {
      if (o.op === "delete") map.delete(o.path);
      else if (o.op === "set") map.set(o.path, o.data);
      else if (o.op === "update") map.set(o.path, { ...(map.get(o.path) || {}), ...o.data });
    }
  }
  async function loadInto(map) {
    for (const k of ["main", "backups"]) {
      const f = await findFile(FILES[k]);
      files[k] = f;
      if (f) { const j = await downloadJson(f.id); for (const [p, v] of Object.entries(j.docs || {})) map.set(p, v); }
    }
  }

  async function load(theCache, theNotify) {
    cache = theCache; notify = theNotify;
    await signInGate();
    setStatus("loading");
    cache.clear(); await loadInto(cache);
    // ops saved locally while offline / before a reload
    try { pending = JSON.parse(lsGet(LS.pending) || "[]"); } catch (e) { pending = []; }
    if (pending.length) { applyOps(cache, pending); scheduleSave(0); }
    setStatus(pending.length ? "saving" : "saved");
    startWatching();
  }

  function write(ops) {
    pending.push(...JSON.parse(JSON.stringify(ops)));
    lsSet(LS.pending, JSON.stringify(pending));
    scheduleSave(1200);
    return Promise.resolve();
  }
  function scheduleSave(ms) { clearTimeout(saveTimer); setStatus("saving"); saveTimer = setTimeout(() => { save().catch(() => {}); }, ms); }

  async function save() {
    if (saving) return saving.then(() => pending.length && save());
    if (!pending.length) { setStatus("saved"); return; }
    saving = (async () => {
      const ops = pending.slice();
      const touched = new Set(ops.map(o => which(o.path)));
      try {
        // someone else (another device) saved since we loaded? merge: their docs + our changes
        let merged = false;
        for (const k of touched) {
          if (files[k] && await fileVersion(files[k].id) !== files[k].version) merged = true;
        }
        if (merged) {
          const fresh = new Map(); await loadInto(fresh); applyOps(fresh, ops);
          cache.clear(); for (const [p, v] of fresh) cache.set(p, v);
          for (const k of ["main", "backups"]) touched.add(k);
          notify(null);
        }
        for (const k of touched) {
          const blob = snapshot(k);
          files[k] = files[k] ? await updateFile(files[k].id, blob) : await createFile(FILES[k], blob, "application/json");
        }
        pending.splice(0, ops.length);
        lsSet(LS.pending, pending.length ? JSON.stringify(pending) : null);
        setStatus(pending.length ? "saving" : "saved");
      } catch (e) {
        setStatus(e.message === "needs_tap" || e.code === "auth_popup_failed_to_open" || e.code === "auth_interaction_required" ? "signin" : "offline");
        clearTimeout(saveTimer); saveTimer = setTimeout(() => save().catch(() => {}), 30000);
        throw e;
      }
    })();
    try { await saving; } finally { saving = null; }
    if (pending.length) scheduleSave(500);
  }

  // pick up changes made on other devices
  let watchTimer = null;
  function startWatching() {
    const tick = async () => {
      if (document.visibilityState !== "visible" || pending.length || saving || !files.main) return;
      try {
        if (await fileVersion(files.main.id) !== files.main.version) {
          const fresh = new Map(); await loadInto(fresh);
          cache.clear(); for (const [p, v] of fresh) cache.set(p, v); notify(null);
        }
      } catch (e) {}
    };
    clearInterval(watchTimer); watchTimer = setInterval(tick, 20000);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") tick(); });
  }

  // ---------- photos ----------
  const urlCache = new Map(), loadingPhotos = new Map();
  const PLACEHOLDER = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="#d5dce1"/></svg>');
  let redrawTimer = null;
  function photoUrl(url) {
    if (!url || !url.startsWith("gdrive:")) return url;
    const id = url.slice(7);
    if (urlCache.has(id)) return urlCache.get(id);
    if (!loadingPhotos.has(id)) {
      loadingPhotos.set(id, gfetch(`${API}/${id}?alt=media`).then(r => r.blob()).then(b => {
        urlCache.set(id, URL.createObjectURL(b));
        clearTimeout(redrawTimer); redrawTimer = setTimeout(() => window.dispatchEvent(new Event("shutterworth-photos")), 150);
      }).catch(() => { setTimeout(() => loadingPhotos.delete(id), 30000); }));
    }
    return PLACEHOLDER;
  }
  async function photoUrlAsync(url) {
    if (!url || !url.startsWith("gdrive:")) return url;
    const id = url.slice(7);
    if (!urlCache.has(id)) { photoUrl(url); await loadingPhotos.get(id); }
    return urlCache.get(id) || "";
  }
  const assets = {
    async upload(blob) {
      const f = await createFile("photo-" + Date.now() + ".jpg", blob, blob.type || "image/jpeg");
      urlCache.set(f.id, URL.createObjectURL(blob));
      return { id: "g_" + f.id, url: "gdrive:" + f.id };
    },
    async delete(id) { if (String(id).startsWith("g_")) await gfetch(`${API}/${id.slice(2)}`, { method: "DELETE" }).catch(() => {}); },
  };

  // ---------- sign-in gate shown while the app starts in Drive mode ----------
  function signInGate() {
    return getToken(false).catch(() => new Promise(resolve => {
      const box = document.createElement("div");
      box.id = "swGate";
      box.innerHTML = `<div class="card">
        <div class="logo"><img src="icon.svg?v=2" alt="" width="112" height="112"></div>
        <h1>ShutterWorth</h1>
        <h2>Open your inventory</h2>
        <p>This device keeps ShutterWorth in your Google Drive${lsGet(LS.hint) ? " (" + lsGet(LS.hint) + ")" : ""}.</p>
        <button class="go" id="swGateGo" type="button">Sign in with Google</button>
        <button class="alt" id="swGateServer" type="button">Use this server instead</button>
        <p class="e" id="swGateErr" role="alert"></p></div>`;
      const css = document.createElement("style");
      css.textContent = `#swGate{position:fixed;inset:0;z-index:50;display:grid;place-items:center;padding:24px;overflow:auto;color:#f8f4ea;font-family:var(--body,system-ui,sans-serif);
background:radial-gradient(90% 70% at 22% 8%,#2f8571 0%,#145f4f 48%,#0c5143 100%)}
#swGate .card{width:100%;max-width:340px;display:flex;flex-direction:column;align-items:stretch;gap:10px;text-align:center}
#swGate .logo{margin:0 auto 14px}
#swGate .logo img{display:block;width:112px;height:112px;border-radius:30px;box-shadow:0 18px 36px -12px rgba(0,0,0,.55)}
#swGate h1{margin:0;font-family:var(--display,inherit);font-stretch:85%;font-weight:800;font-size:2.1rem;letter-spacing:-.01em;line-height:1}
#swGate h2{margin:6px 0 0;font-size:1.05rem;font-weight:600;color:#f1d28a}
#swGate p{margin:0 0 10px;font-size:.92rem;line-height:1.45;color:rgba(248,244,234,.78)}
#swGate button{font:inherit;font-weight:700;height:50px;border-radius:999px;cursor:pointer;border:1px solid transparent}
#swGate .go{background:linear-gradient(135deg,#f1d28a,#d9ab55 55%,#b98633);color:#0c4034;box-shadow:0 10px 22px -10px rgba(0,0,0,.6)}
#swGate .go:active{transform:scale(.98)}
#swGate .alt{background:transparent;color:#f8f4ea;border-color:rgba(248,244,234,.4)}
#swGate .alt:hover{background:rgba(248,244,234,.1)}
#swGate button:focus-visible{outline:2px solid #f1d28a;outline-offset:3px}
#swGate .e{color:#ffb3ab;min-height:1.2em;margin:0}`;
      document.head.appendChild(css); document.body.appendChild(box);
      document.getElementById("swGateGo").onclick = async () => {
        try { await getToken(true); box.remove(); resolve(); }
        catch (e) { document.getElementById("swGateErr").textContent = e.message; }
      };
      document.getElementById("swGateServer").onclick = () => { lsSet(LS.mode, null); location.reload(); };
    }));
  }

  // ---------- move data between the server and Drive ----------
  async function driveHasData() { return !!(await findFile(FILES.main)); }

  // copies everything on this server (including photos) into Drive, then switches this device to Drive
  async function copyServerToDrive(progress) {
    const { docs } = await fetch("api/docs", { cache: "no-store" }).then(r => r.json());
    const map = new Map(Object.entries(docs));
    const items = [...map.entries()].filter(([p, v]) => p.startsWith("items/") && v.assetId && !String(v.assetUrl || "").startsWith("gdrive:"));
    let n = 0;
    for (const [p, v] of items) {
      progress && progress(`Copying photos ${++n} of ${items.length}…`);
      try {
        const src = v.assetUrl || "/_blob/" + v.assetId;
        const blob = await fetch(src).then(r => { if (!r.ok) throw new Error(); return r.blob(); });
        const up = await assets.upload(blob);
        map.set(p, { ...v, assetId: up.id, assetUrl: up.url });
      } catch (e) { /* photo missing on server: keep the item without changing it */ }
    }
    progress && progress("Saving to Google Drive…");
    cache = map;
    for (const k of ["main", "backups"]) {
      const f = await findFile(FILES[k]);
      const blob = snapshot(k);
      files[k] = f ? await updateFile(f.id, blob) : await createFile(FILES[k], blob, "application/json");
    }
  }

  window.SWDrive = {
    active: () => lsGet(LS.mode) === "gdrive",
    setMode: m => { lsSet(LS.mode, m === "gdrive" ? "gdrive" : null); lsSet(LS.pending, null); },
    account: () => lsGet(LS.hint),
    status: () => status, onStatus: f => { statusListeners.add(f); return () => statusListeners.delete(f); },
    retrySave: async () => { await getToken(true); return save(); },
    getClientId, originProblem, getToken, signOut, driveHasData, copyServerToDrive,
    load, write, assets, photoUrl, photoUrlAsync,
  };
})();
