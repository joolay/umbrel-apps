"use strict";
// The JAB dashboard's content: practice name, groups and apps (<data>/jab.json, edited by the admin on the dashboard and in JAB Admin),
// and the address of JAB Admin (<data>/admin.json, written by JAB Admin itself so the dashboard's Admin folder can link to it).
// Shared by server.js (dashboard) and admin.js (JAB Admin), which mount the same data folder.
const fs = require("fs"), path = require("path");

const str = (s, n) => String(s == null ? "" : s).replace(/[\u0000-\u001f<>]/g, " ").trim().slice(0, n);
const slug = x => (typeof x === "string" && /^[a-z0-9][a-z0-9-]{0,40}$/.test(x) ? x : "");
const colour = (x, d) => (typeof x === "string" && /^#[0-9a-fA-F]{6}$/.test(x) ? x.toLowerCase() : d);
const GLYPHS = ["tooth", "users", "calendar", "file", "camera", "monitor", "chart", "shield", "link", "chat", "wallet", "box"];
// Only plain web addresses open from a tile (never javascript: or data:); "" means "not linked yet".
function cleanUrl(u) {
  u = str(u, 500); if (!u) return "";
  if (/^\/(?!\/)/.test(u)) return u;
  try { const x = new URL(u); return x.protocol === "http:" || x.protocol === "https:" ? x.toString() : ""; } catch { return ""; }
}
function cleanConfig(c) {
  c = c && typeof c === "object" ? c : {};
  const groups = (Array.isArray(c.groups) ? c.groups : []).map(g => g && slug(g.id) ? { id: g.id, name: str(g.name, 40) || "Group" } : null).filter(Boolean).slice(0, 12);
  const gids = new Set(groups.map(g => g.id)), seen = new Set();
  const apps = (Array.isArray(c.apps) ? c.apps : []).map(a => {
    if (!a || !slug(a.id) || seen.has(a.id)) return null; seen.add(a.id);
    return { id: a.id, name: str(a.name, 40) || "App", desc: str(a.desc, 140), url: cleanUrl(a.url), glyph: GLYPHS.includes(a.glyph) ? a.glyph : "tooth", c1: colour(a.c1, "#7e22ce"), c2: colour(a.c2, "#e879f9"), group: gids.has(a.group) ? a.group : "", adminOnly: !!a.adminOnly };
  }).filter(Boolean).slice(0, 80);
  return { v: 2, practice: { name: str(c.practice && c.practice.name, 60) || "Berea Dental Studio", tagline: str(c.practice && c.practice.tagline, 100) }, groups, apps };
}
// First run: the practice's own projects as placeholder tiles (no address yet, so an admin links them from the dashboard).
const SEED = {
  practice: { name: "Berea Dental Studio", tagline: "Practice apps" },
  groups: [{ id: "clinical", name: "Clinical" }, { id: "front-desk", name: "Front desk" }],
  apps: [
    { id: "patient-records", name: "Patient Records", desc: "Patients, pricing, tariff codes and backups", glyph: "tooth", c1: "#0e7490", c2: "#22d3ee", group: "clinical" },
    { id: "shop-screen", name: "ShopScreen", desc: "Waiting-room display and signage", glyph: "monitor", c1: "#7e22ce", c2: "#e879f9", group: "front-desk" }
  ]
};
module.exports = function makeConfig(dataDir) {
  const DIR = path.resolve(dataDir), FILE = path.join(DIR, "jab.json"), ADMIN = path.join(DIR, "admin.json");
  fs.mkdirSync(DIR, { recursive: true });
  const atomic = (f, o) => { const t = f + "." + process.pid + ".tmp"; fs.writeFileSync(t, JSON.stringify(o, null, 2), { mode: 0o600 }); fs.renameSync(t, f); };
  // Re-read when the file changed (the other program may have saved it).
  let cache = null, sig = "";
  function load() {
    try { const st = fs.statSync(FILE), s = st.mtimeMs + ":" + st.size; if (!cache || s !== sig) { cache = cleanConfig(JSON.parse(fs.readFileSync(FILE, "utf8"))); sig = s; } }
    catch { if (!cache) cache = cleanConfig(SEED); }
    return cache;
  }
  function save(c) { cache = cleanConfig(c); atomic(FILE, cache); sig = ""; return cache; }
  function adminUrl() { try { const u = JSON.parse(fs.readFileSync(ADMIN, "utf8")).url; return cleanUrl(u); } catch { return ""; } }
  function setAdminUrl(u) { u = cleanUrl(u); if (u && u !== adminUrl()) atomic(ADMIN, { url: u }); return u; }
  return { load, save, adminUrl, setAdminUrl };
};
Object.assign(module.exports, { cleanConfig, cleanUrl, SEED, GLYPHS, slug, str });
