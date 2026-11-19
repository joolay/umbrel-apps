"use strict";
// Project Tracker: the shape of a list and the rules for changing it. Pure functions, no network, so they are easy to test.
// A list is { name, categories: [string], projects: [project] }. A project:
//   id, name, category, desc, status (active|maintenance|hiatus|closed), closedAs (completed|abandoned|""), closedAt,
//   pinned (true once someone set the status by hand: the 3-day rule then leaves it alone), lastWorked (YYYY-MM-DD),
//   paths ([{repo, path}] used to read the last commit), note, rank (lower is higher priority), state (live|archived|bin), binnedAt, updatedAt.
const STATUSES = ["active", "maintenance", "hiatus", "closed"];
const STATES = ["live", "archived", "bin"];
const BIN_DAYS = 30, ACTIVE_DAYS = 3, REVIEW_DAYS = 30, DAY = 86400e3;
const str = (v, n) => String(v == null ? "" : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, n);
const isDay = v => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const iso = v => { const t = Date.parse(v); return isFinite(t) ? new Date(t).toISOString() : ""; };
const slug = s => str(s, 60).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "project";

function cleanProject(p, now) {
  if (!p || typeof p !== "object") return null;
  const id = str(p.id, 60).replace(/[^A-Za-z0-9_-]/g, ""), name = str(p.name, 120);
  if (!id || !name) return null;
  const status = STATUSES.includes(p.status) ? p.status : "active";
  const paths = (Array.isArray(p.paths) ? p.paths : []).slice(0, 6).map(x => ({ repo: str(x && x.repo, 80), path: str(x && x.path, 120) })).filter(x => /^[\w.-]+\/[\w.-]+$/.test(x.repo) && x.path && !x.path.includes(".."));
  return {
    id, name, category: str(p.category, 60) || "General", desc: str(p.desc, 600), status,
    closedAs: status === "closed" && ["completed", "abandoned"].includes(p.closedAs) ? p.closedAs : "",
    closedAt: status === "closed" && iso(p.closedAt) ? iso(p.closedAt) : status === "closed" ? now : "",
    pinned: !!p.pinned, lastWorked: isDay(p.lastWorked) ? p.lastWorked : "", paths, note: str(p.note, 600),
    rank: Number.isFinite(+p.rank) ? +p.rank : 0, state: STATES.includes(p.state) ? p.state : "live",
    binnedAt: p.state === "bin" ? (iso(p.binnedAt) || now) : "", updatedAt: iso(p.updatedAt) || now,
  };
}
function cleanList(d, now = new Date().toISOString()) {
  if (!d || typeof d !== "object" || !Array.isArray(d.projects)) return null;
  const seen = new Set(), projects = [];
  for (const p of d.projects.slice(0, 2000)) { const c = cleanProject(p, now); if (c && !seen.has(c.id)) { seen.add(c.id); projects.push(c); } }
  const cats = [...new Set([...(Array.isArray(d.categories) ? d.categories.map(c => str(c, 60)).filter(Boolean) : []), ...projects.map(p => p.category)])].slice(0, 60);
  return { version: 1, name: str(d.name, 80) || "Projects", categories: cats, projects, updatedAt: iso(d.updatedAt) || now };
}
// Apply a person's change to a list. ops: { upsert: [project], remove: [id] }. Each upserted project replaces the stored one of the same id
// (it is a deliberate action), so two people editing different projects never collide. Removing is only for the bin: emptying it.
function applyOps(list, ops, now = new Date().toISOString()) {
  const out = cleanList(list, now) || { version: 1, name: "Projects", categories: [], projects: [], updatedAt: now };
  const by = new Map(out.projects.map(p => [p.id, p]));
  for (const raw of (ops && Array.isArray(ops.upsert) ? ops.upsert : []).slice(0, 200)) {
    const c = cleanProject({ ...raw, updatedAt: now }, now); if (!c) continue;
    const old = by.get(c.id);
    if (c.state === "live" && old && old.state === "bin") c.binnedAt = "";
    by.set(c.id, c);
    if (!out.categories.includes(c.category)) out.categories.push(c.category);
  }
  for (const id of (ops && Array.isArray(ops.remove) ? ops.remove : []).slice(0, 500)) { const p = by.get(str(id, 60)); if (p && p.state === "bin") by.delete(p.id); }
  out.projects = [...by.values()];
  if (ops && Array.isArray(ops.categories)) out.categories = [...new Set([...ops.categories.map(c => str(c, 60)).filter(Boolean), ...out.projects.map(p => p.category)])].slice(0, 60);
  if (ops && typeof ops.name === "string" && str(ops.name, 80)) out.name = str(ops.name, 80);
  out.updatedAt = now; return out;
}
// Move a project up or down among the live projects of its category. Ranks are renumbered 10, 20, 30... so the file always shows the order.
function move(list, id, dir, now = new Date().toISOString()) {
  const l = cleanList(list, now), p = l.projects.find(x => x.id === id); if (!p) return [];
  const sib = l.projects.filter(x => x.category === p.category && x.state === "live").sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
  const i = sib.indexOf(p), j = i + (dir < 0 ? -1 : 1); if (j < 0 || j >= sib.length) return [];
  [sib[i], sib[j]] = [sib[j], sib[i]];
  return sib.map((x, n) => ({ ...x, rank: (n + 1) * 10 })).filter(x => l.projects.find(o => o.id === x.id).rank !== x.rank);
}
// The status shown: a Maintenance or Hiatus project worked on in the last 3 days counts as Active, unless someone set its status by hand.
function effective(p, worked, now = Date.now()) {
  const last = [p.lastWorked, worked].filter(isDay).sort().pop();
  const recent = !!last && now - Date.parse(last + "T23:59:59Z") <= ACTIVE_DAYS * DAY && now >= Date.parse(last + "T00:00:00Z") - DAY;
  const auto = !p.pinned && recent && (p.status === "maintenance" || p.status === "hiatus");
  return { status: auto ? "active" : p.status, auto, last: last || "" };
}
const dueForReview = (p, now = Date.now()) => p.state === "live" && p.status === "closed" && !!p.closedAt && now - Date.parse(p.closedAt) > REVIEW_DAYS * DAY;
// Anything in the bin for more than 30 days goes for good.
function purgeBin(list, now = Date.now()) {
  const gone = list.projects.filter(p => p.state === "bin" && p.binnedAt && now - Date.parse(p.binnedAt) > BIN_DAYS * DAY).map(p => p.id);
  return gone;
}
module.exports = { STATUSES, STATES, BIN_DAYS, ACTIVE_DAYS, REVIEW_DAYS, cleanList, cleanProject, applyOps, move, effective, dueForReview, purgeBin, slug, str, isDay };
