"use strict";
// One recent-activity list for the Portal Admin Overview, built only from what already exists (nothing new is stored):
//   status files every app pushes (App Updater, Services Manager, Kiosk Manager, Port Master...), routes flagged down and back up,
//   access requests, and the admin audit log. Newest first.
const NAMES = { "app-updater": "App Updater", "services-manager": "Services Manager", "kiosk-manager": "Kiosk Manager", "routing-reporter": "Port Master", "project-pilot": "Project Pilot", "theme-editor": "Theme Editor", "portal-admin": "Portal Admin" };
const SKIP = new Set(["route-alerts"]);   // covered by the route events
const STALE = 35 * 60e3;
const pretty = (slug) => NAMES[slug] || String(slug).split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
const iso = (t) => new Date(t).toISOString();

module.exports = function makeActivity({ asSuper, feed, routes, now = Date.now }) {
  async function recent(limit = 20) {
    const items = [], t = now();
    const add = (at, source, title, sub, level) => { if (at > 0) items.push({ at: iso(at), source, title, sub: sub || "", level: level || "info" }); };
    await Promise.all([
      (async () => {
        for (const f of await feed.readAll()) {
          if (SKIP.has(f.app) || f.app.startsWith("_")) continue;
          if (t - f.at > STALE) add(f.at, pretty(f.app), pretty(f.app) + " has stopped reporting", "Last report " + iso(f.at), "warn");
          else add(f.changedAt, pretty(f.app), pretty(f.app) + " reported a change", "", "info");
        }
      })().catch(() => {}),
      (async () => { for (const e of routes.events()) add(e.at, "Port Master", e.label, e.sub, e.level); })().catch(() => {}),
      (async () => {
        const r = await asSuper("GET", "/api/collections/portal_requests/records?perPage=15&sort=-created");
        for (const x of r.items || []) add(Date.parse(String(x.created || "").replace(" ", "T")), "Access", "Access to " + (x.app || "an app") + " " + (x.status === "pending" ? "requested" : x.status), "", x.status === "pending" ? "warn" : x.status === "denied" ? "bad" : "ok");
      })().catch(() => {}),
      (async () => {
        const r = await asSuper("GET", "/api/collections/portal_audit/records?perPage=15&sort=-created");
        for (const x of r.items || []) add(Date.parse(String(x.created || "").replace(" ", "T")), "Admin", (x.actor || "Someone") + " " + (x.action || "changed something"), x.target || "", "info");
      })().catch(() => {}),
    ]);
    return items.sort((a, b) => b.at.localeCompare(a.at)).slice(0, Math.min(50, Math.max(1, limit)));
  }
  return { recent };
};
