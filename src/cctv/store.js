// Sites, cameras and who may watch what. One JSON file in the data folder (mode 600), because it holds the recorders' passwords.
// Saved views (which cameras sit in which tile) are NOT here: they are each person's own settings on their JoolzApp account.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const dev = require("./devices");

const newId = () => crypto.randomBytes(5).toString("hex");
const str = (v, n) => String(v == null ? "" : v).trim().slice(0, n);

function createStore(dataDir) {
  const file = path.join(dataDir, "cctv.json");
  let db = { sites: [], cameras: [], grants: {} };
  try { const j = JSON.parse(fs.readFileSync(file, "utf8")); if (j && Array.isArray(j.sites) && Array.isArray(j.cameras)) db = { sites: j.sites, cameras: j.cameras, grants: j.grants && typeof j.grants === "object" ? j.grants : {} }; } catch {}
  const save = () => { const t = file + ".tmp"; fs.writeFileSync(t, JSON.stringify(db, null, 1), { mode: 0o600 }); fs.renameSync(t, file); try { fs.chmodSync(file, 0o600); } catch {} };

  const site = id => db.sites.find(s => s.id === id) || null;
  const camera = id => db.cameras.find(c => c.id === id) || null;
  const publicSite = s => ({ id: s.id, name: s.name, vendor: s.vendor, host: s.host || "", httpPort: s.httpPort, rtspPort: s.rtspPort, user: s.user || "", hasPassword: !!s.pass });
  const publicCam = c => { const s = site(c.site) || {}; return { id: c.id, site: c.site, siteName: s.name || "", vendor: s.vendor || "", channel: c.channel, name: c.name, enabled: c.enabled !== false }; };

  function cleanSiteInput(p, existing) {
    const vendor = dev.VENDORS[p.vendor] ? p.vendor : (existing ? existing.vendor : null);
    if (!vendor) throw new Error("Choose the make (Hikvision, Dahua or other)");
    const name = str(p.name, 60) || (existing && existing.name) || "";
    if (!name) throw new Error("Give the site a name, for example Home or Shop");
    const o = { id: existing ? existing.id : newId(), name, vendor };
    if (vendor === "rtsp") { o.host = ""; o.httpPort = 80; o.rtspPort = 554; o.user = ""; o.pass = ""; return o; }
    const host = dev.cleanHost(str(p.host, 253)) || (existing && existing.host);
    if (!host) throw new Error("Enter the recorder's address (IP, or a name like shop.example.com or a Tailscale address)");
    o.host = host;
    o.httpPort = dev.cleanPort(p.httpPort || (existing && existing.httpPort) || 80) || 80;
    o.rtspPort = dev.cleanPort(p.rtspPort || (existing && existing.rtspPort) || 554) || 554;
    o.user = str(p.user, 64) || (existing && existing.user) || "admin";
    o.pass = typeof p.pass === "string" && p.pass ? p.pass.slice(0, 128) : (existing && existing.pass) || "";   // blank keeps the saved password
    if (!o.pass) throw new Error("Enter the recorder's password");
    return o;
  }

  return {
    sites: () => db.sites.map(publicSite),
    rawSite: site,
    rawCamera: camera,
    cameras: () => db.cameras.map(publicCam),
    cleanSite: (p, existing) => cleanSiteInput(p, existing || null),
    insertSite(s) { db.sites.push(s); save(); return s; },
    updateSite(id, p) { const ex = site(id); if (!ex) throw new Error("Unknown site"); const s = cleanSiteInput(p, ex); db.sites[db.sites.indexOf(ex)] = s; save(); return s; },
    removeSite(id) {
      const gone = new Set(db.cameras.filter(c => c.site === id).map(c => c.id));
      db.sites = db.sites.filter(s => s.id !== id); db.cameras = db.cameras.filter(c => c.site !== id);
      for (const g of Object.values(db.grants)) g.cams = (g.cams || []).filter(c => !gone.has(c)); save(); return [...gone];
    },
    // Adds the cameras a probe found that the site doesn't have yet (same channel); existing names are kept.
    importChannels(siteId, channels) {
      let added = 0;
      for (const ch of channels) {
        if (db.cameras.some(c => c.site === siteId && c.channel === ch.channel)) continue;
        db.cameras.push({ id: newId(), site: siteId, channel: ch.channel, name: str(ch.name, 60) || ("Camera " + ch.channel), enabled: true }); added++;
      }
      save(); return added;
    },
    addRtspCamera(siteId, p) {
      const s = site(siteId); if (!s || s.vendor !== "rtsp") throw new Error("Add the camera to a site of type Other (RTSP address)");
      const url = str(p.rtsp, 500), sub = str(p.rtspSub, 500);
      if (!/^rtsps?:\/\//i.test(url) || (sub && !/^rtsps?:\/\//i.test(sub))) throw new Error("The address must start with rtsp://");
      const c = { id: newId(), site: siteId, channel: 0, name: str(p.name, 60) || "Camera", enabled: true, rtsp: url, rtspSub: sub };
      db.cameras.push(c); save(); return c;
    },
    updateCamera(id, p) { const c = camera(id); if (!c) throw new Error("Unknown camera"); if (typeof p.name === "string" && p.name.trim()) c.name = str(p.name, 60); if (typeof p.enabled === "boolean") c.enabled = p.enabled; save(); return publicCam(c); },
    removeCamera(id) { db.cameras = db.cameras.filter(c => c.id !== id); for (const g of Object.values(db.grants)) g.cams = (g.cams || []).filter(x => x !== id); save(); },
    // Who may watch what. Admins always see everything.
    grantOf: uid => { const g = db.grants[uid]; return { all: !!(g && g.all), cams: g && Array.isArray(g.cams) ? g.cams.slice() : [] }; },
    setGrant(uid, p) {
      if (typeof uid !== "string" || !/^[A-Za-z0-9]{1,40}$/.test(uid)) throw new Error("Bad person");
      const have = new Set(db.cameras.map(c => c.id));
      const cams = (Array.isArray(p.cams) ? p.cams : []).filter(c => have.has(c));
      if (!p.all && !cams.length) delete db.grants[uid]; else db.grants[uid] = { all: !!p.all, cams: [...new Set(cams)] };
      save();
    },
    allGrants: () => JSON.parse(JSON.stringify(db.grants)),
    forgetUser(uid) { if (db.grants[uid]) { delete db.grants[uid]; save(); } },
    // The cameras this person may watch (enabled ones only; an admin sees every enabled camera).
    visibleTo(user) {
      const on = db.cameras.filter(c => c.enabled !== false);
      if (!user) return [];
      if (user.isAdmin) return on;
      const g = db.grants[user.id]; if (!g) return [];
      return g.all ? on : on.filter(c => (g.cams || []).includes(c.id));
    },
    canWatch(user, camId) { const c = camera(camId); return !!(c && c.enabled !== false && this.visibleTo(user).some(x => x.id === camId)); },
    publicCam,
  };
}
module.exports = { createStore };
