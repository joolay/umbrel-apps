"use strict";
const assert = require("assert"), L = require("./lists");
const NOW = "2026-11-19T12:00:00.000Z", T = Date.parse(NOW);
const base = () => L.cleanList({ name: "Test", projects: [
  { id: "a", name: "A", category: "X", status: "maintenance", rank: 10 }, { id: "b", name: "B", category: "X", status: "active", rank: 20 },
  { id: "c", name: "C", category: "X", status: "hiatus", rank: 30 }, { id: "d", name: "D", category: "Y", status: "closed", closedAs: "completed", closedAt: "2026-10-01T00:00:00Z", rank: 10 } ] }, NOW);
let l = base();
assert.strictEqual(l.projects.length, 4); assert.deepStrictEqual(l.categories, ["X", "Y"]);
assert.strictEqual(L.cleanList({ projects: [{ id: "", name: "x" }, { id: "ok", name: "" }] }, NOW).projects.length, 0);
assert.strictEqual(L.cleanList({ nope: 1 }), null);
// priority arrows
let m = L.move(l, "c", -1, NOW); assert.deepStrictEqual(m.map(p => [p.id, p.rank]).sort(), [["b", 30], ["c", 20]]);
assert.deepStrictEqual(L.move(l, "a", -1, NOW), []); assert.deepStrictEqual(L.move(l, "c", 1, NOW), []);
l = L.applyOps(l, { upsert: m }, NOW); assert.deepStrictEqual(l.projects.filter(p => p.category === "X").sort((a, b) => a.rank - b.rank).map(p => p.id), ["a", "c", "b"]);
// three-day rule
const day = d => new Date(T - d * 86400e3).toISOString().slice(0, 10);
assert.strictEqual(L.effective({ status: "maintenance", pinned: false, lastWorked: day(2) }, "", T).status, "active");
assert.strictEqual(L.effective({ status: "maintenance", pinned: false, lastWorked: day(2) }, "", T).auto, true);
assert.strictEqual(L.effective({ status: "maintenance", pinned: false, lastWorked: day(5) }, "", T).status, "maintenance");
assert.strictEqual(L.effective({ status: "hiatus", pinned: false, lastWorked: day(9) }, day(1), T).status, "active");   // a recent commit counts too
assert.strictEqual(L.effective({ status: "hiatus", pinned: true, lastWorked: day(0) }, "", T).status, "hiatus");   // set by hand: left alone
assert.strictEqual(L.effective({ status: "closed", pinned: false, lastWorked: day(0) }, "", T).status, "closed");   // closed never promotes
// remove: archive, bin, restore, empty the bin
l = L.applyOps(l, { upsert: [{ ...l.projects.find(p => p.id === "d"), state: "archived" }] }, NOW); assert.strictEqual(l.projects.find(p => p.id === "d").state, "archived");
l = L.applyOps(l, { upsert: [{ ...l.projects.find(p => p.id === "a"), state: "bin" }] }, NOW); assert.ok(l.projects.find(p => p.id === "a").binnedAt);
l = L.applyOps(l, { remove: ["b"] }, NOW); assert.ok(l.projects.find(p => p.id === "b"), "only binned projects can be removed for good");
l = L.applyOps(l, { upsert: [{ ...l.projects.find(p => p.id === "a"), state: "live" }] }, NOW); assert.strictEqual(l.projects.find(p => p.id === "a").binnedAt, "");
l = L.applyOps(l, { upsert: [{ ...l.projects.find(p => p.id === "a"), state: "bin" }] }, "2026-10-01T00:00:00.000Z");
assert.deepStrictEqual(L.purgeBin(l, T), ["a"]);
l = L.applyOps(l, { remove: ["a"] }, NOW); assert.ok(!l.projects.find(p => p.id === "a"));
// closed review
assert.strictEqual(L.dueForReview(base().projects.find(p => p.id === "d"), T), true);
assert.strictEqual(L.dueForReview({ state: "live", status: "closed", closedAt: "2026-11-10T00:00:00Z" }, T), false);
// paths are checked
assert.strictEqual(L.cleanProject({ id: "p", name: "P", paths: [{ repo: "joolay/umbrel-apps", path: "src/x" }, { repo: "bad", path: "x" }, { repo: "a/b", path: "../etc" }] }, NOW).paths.length, 1);
console.log("lists ok");
