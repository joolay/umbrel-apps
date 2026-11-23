"use strict";
const assert = require("assert");
const makeActivity = require("./activity");
const NOW = Date.parse("2026-11-23T13:00:00Z");
const feed = { readAll: async () => [
  { app: "services-manager", at: NOW - 60e3, changedAt: NOW - 600e3, rev: 4 },
  { app: "kiosk-manager", at: NOW - 3 * 3600e3, changedAt: NOW - 5 * 3600e3, rev: 2 },
  { app: "route-alerts", at: NOW, changedAt: NOW, rev: 1 } ] };
const routes = { events: () => [{ at: NOW - 120e3, label: "Stremio Public route flagged as down", sub: "timeout", level: "bad" }] };
const asSuper = async (m, p) => p.includes("portal_requests") ? { items: [{ created: "2026-11-23 12:00:00.000Z", app: "stremio", status: "pending" }] }
  : { items: [{ created: "2026-11-23 12:30:00.000Z", actor: "zahir", action: "setting.update", target: "portal.url" }] };
(async () => {
  const a = makeActivity({ asSuper, feed, routes, now: () => NOW });
  const r = await a.recent(20);
  assert.strictEqual(r.length, 5);                                              // route-alerts file skipped
  assert.deepStrictEqual(r.map((x) => x.at), r.map((x) => x.at).sort().reverse());   // newest first
  assert.ok(r.some((x) => x.title === "Kiosk Manager has stopped reporting" && x.level === "warn"));
  assert.ok(r.some((x) => x.title === "Services Manager reported a change"));
  assert.ok(r.some((x) => x.title === "Access to stremio requested"));
  assert.strictEqual((await a.recent(2)).length, 2);
  const broken = makeActivity({ asSuper: async () => { throw new Error("x"); }, feed: { readAll: async () => { throw new Error("y"); } }, routes, now: () => NOW });
  assert.strictEqual((await broken.recent()).length, 1);                        // one failing source never hides the others
  console.log("activity ok");
})();
