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
assert.strictEqual(L.effective({ status: "maintenance", statusAt: day(10), lastWorked: day(2) }, "", T).status, "active");
assert.strictEqual(L.effective({ status: "maintenance", statusAt: day(10), lastWorked: day(2) }, "", T).auto, true);
assert.strictEqual(L.effective({ status: "maintenance", pinned: false, lastWorked: day(5) }, "", T).status, "maintenance");
assert.strictEqual(L.effective({ status: "hiatus", statusAt: day(10), lastWorked: day(9) }, day(1), T).status, "active");   // a recent commit counts too
assert.strictEqual(L.effective({ status: "maintenance", lastWorked: day(0) }, day(0), T).status, "maintenance");   // never stamped: recent commits alone do not move it
assert.strictEqual(L.effective({ status: "maintenance", statusAt: day(20), lastWorked: day(6) }, "", T, true, 7).status, "active");   // window set to 7 days
assert.strictEqual(L.effective({ status: "maintenance", statusAt: day(20), lastWorked: day(6) }, "", T, true, 3).status, "maintenance");
assert.strictEqual(L.effective({ status: "maintenance", statusAt: day(20), lastWorked: day(6) }, "", T, true, 999).status, "maintenance");   // out-of-range falls back to 3
const hand = new Date(T - 2 * 864e5).toISOString();   // status set by hand two days ago
assert.strictEqual(L.effective({ status: "hiatus", statusAt: hand, lastWorked: day(3) }, "", T).status, "hiatus");   // earlier work does not undo it
assert.strictEqual(L.effective({ status: "hiatus", statusAt: hand, lastWorked: day(0) }, "", T).status, "active");   // new work on a later day does
assert.strictEqual(L.effective({ status: "hiatus", auto: "off", lastWorked: day(0) }, "", T).status, "hiatus");      // off for this project
assert.strictEqual(L.effective({ status: "hiatus", lastWorked: day(0) }, "", T, false).status, "hiatus");            // off globally
assert.strictEqual(L.effective({ status: "hiatus", auto: "on", statusAt: day(10), lastWorked: day(0) }, "", T, false).status, "active"); // on for this project despite global off
const mig = L.cleanProject({ id: "x", name: "X", note: "old note", pinned: true, updatedAt: hand }, NOW);
assert.deepStrictEqual(mig.notes.map(n => n.text), ["old note"]); assert.strictEqual(mig.statusAt, hand); assert.ok(!("note" in mig) && !("pinned" in mig));
assert.deepStrictEqual(L.cleanProject({ id: "y", name: "Y", notes: [{ id: "a", text: "t", state: "review" }, { text: "" }, { id: "a", text: "u", state: "zzz" }] }, NOW).notes.map(n => n.id + n.state), ["areview", "axopen"]);
assert.strictEqual(L.effective({ status: "closed", pinned: false, lastWorked: day(0) }, "", T).status, "closed");   // closed never promotes
// remove: archive, bin, restore, empty the bin
l = L.applyOps(l, { upsert: [{ ...l.projects.find(p => p.id === "d"), state: "archived" }] }, NOW); assert.strictEqual(l.projects.find(p => p.id === "d").state, "archived");
l = L.applyOps(l, { upsert: [{ ...l.projects.find(p => p.id === "a"), state: "bin" }] }, NOW); assert.ok(l.projects.find(p => p.id === "a").binnedAt);
l = L.applyOps(l, { remove: ["b"] }, NOW); assert.ok(l.projects.find(p => p.id === "b"), "only binned projects can be removed for good");
l = L.applyOps(l, { upsert: [{ ...l.projects.find(p => p.id === "a"), state: "live" }] }, NOW); assert.strictEqual(l.projects.find(p => p.id === "a").binnedAt, "");
l = L.applyOps(l, { upsert: [{ ...l.projects.find(p => p.id === "a"), state: "bin" }] }, "2026-10-01T00:00:00.000Z");
assert.deepStrictEqual(L.binDue(l, T), ["a"]);   // listed for the monthly "empty the bin?" prompt, never deleted by itself
l = L.applyOps(l, { remove: ["a"] }, NOW); assert.ok(!l.projects.find(p => p.id === "a"));
// closed review
assert.strictEqual(L.dueForReview(base().projects.find(p => p.id === "d"), T), true, "completed projects are offered the Archive after a month");
const ab = { state: "live", status: "closed", closedAs: "abandoned", closedAt: "2026-10-01T00:00:00Z" };
assert.strictEqual(L.dueForReview(ab, T), true); assert.strictEqual(L.dueForReview({ ...ab, reviewedAt: "2026-11-10T00:00:00Z" }, T), false, "Keep restarts the month");
assert.strictEqual(L.dueForReview({ ...ab, closedAt: "2026-11-10T00:00:00Z" }, T), false);
// closed projects are Complete unless Abandoned; reviewedAt only lives on abandoned ones
const cc = L.cleanProject({ id: "x", name: "X", status: "closed" }, NOW); assert.strictEqual(cc.closedAs, "completed");
assert.strictEqual(L.cleanProject({ id: "x", name: "X", status: "closed", closedAs: "abandoned", reviewedAt: "2026-11-01T00:00:00Z" }, NOW).reviewedAt, "2026-11-01T00:00:00.000Z");
assert.strictEqual(L.cleanProject({ id: "x", name: "X", status: "closed", closedAs: "completed", reviewedAt: "2026-11-01T00:00:00Z" }, NOW).reviewedAt, "2026-11-01T00:00:00.000Z");
assert.strictEqual(L.cleanProject({ id: "x", name: "X", status: "active", reviewedAt: "2026-11-01T00:00:00Z" }, NOW).reviewedAt, "");
// paths are checked
assert.strictEqual(L.cleanProject({ id: "p", name: "P", paths: [{ repo: "joolay/umbrel-apps", path: "src/x" }, { repo: "bad", path: "x" }, { repo: "a/b", path: "../etc" }] }, NOW).paths.length, 1);
// notes: who left them and when they were edited survive cleaning; anything else is dropped
const nn = L.cleanProject({ id: "p", name: "P", notes: [{ id: "n1", text: "a", by: "claude", editedAt: "2026-11-21T10:00:00Z", extra: 1 }, { id: "n2", text: "b", by: "someone" }] }, NOW).notes;
assert.strictEqual(nn[0].by, "claude"); assert.strictEqual(nn[0].editedAt, "2026-11-21T10:00:00.000Z"); assert.strictEqual(nn[0].extra, undefined);
assert.strictEqual(nn[1].by, undefined); assert.strictEqual(nn[1].editedAt, undefined);
// Task schedule: the queue lives on the project, the run time on the list
let q = L.applyOps(base(), { upsert: [
  { id: "a", name: "A", category: "X", status: "maintenance", queue: { state: "queued", pos: 20, at: "2026-11-19T01:00:00Z" } },
  { id: "b", name: "B", category: "X", status: "active", queue: { state: "queued", pos: 10, merge: false } },
  { id: "c", name: "C", category: "X", status: "hiatus", queue: { state: "done", pos: 5, doneAt: "2026-11-18T02:10:00Z", result: "Built 1.2.0, merged.", runs: 1 } },
  { id: "d", name: "D", category: "Y", status: "active", queue: { state: "nonsense" } }] }, NOW);
assert.strictEqual(q.projects.find(p => p.id === "d").queue, undefined, "a queue with an unknown state is dropped");
assert.strictEqual(q.projects.find(p => p.id === "a").queue.merge, true, "merging to main is on unless switched off"); assert.strictEqual(q.projects.find(p => p.id === "b").queue.merge, false);
let rows = L.queueRows(q, T); assert.deepStrictEqual(rows.waiting.map(p => p.id), ["b", "a"], "waiting projects in pos order"); assert.deepStrictEqual(rows.finished.map(p => p.id), ["c"]);
q = L.applyOps(q, { upsert: [{ ...q.projects.find(p => p.id === "a"), queue: { ...q.projects.find(p => p.id === "a").queue, state: "running" } }] }, NOW); assert.strictEqual(L.queueRows(q, T).waiting[0].id, "a", "running comes first");
q = L.applyOps(q, { upsert: [{ ...q.projects.find(p => p.id === "c"), queue: null }] }, NOW); assert.strictEqual(L.queueRows(q, T).finished.length, 0, "clearing removes it");
assert.strictEqual(L.queueRows(L.applyOps(q, { upsert: [{ ...q.projects.find(p => p.id === "b"), queue: { state: "failed", pos: 1, doneAt: "2026-10-01T00:00:00Z" } }] }, NOW), T).finished.length, 0, "finished items older than 14 days drop out of view");
assert.deepStrictEqual(q.schedule, { days: [1], time: "20:00", offsetMin: 120 }, "default: every Monday at 20:00");
assert.strictEqual(L.cleanSchedule({ time: "25:00", offsetMin: 99999, days: [9, "x"] }).time, "20:00"); assert.deepStrictEqual(L.cleanSchedule({ days: [5, 1, 5, 9] }).days, [1, 5]);
assert.strictEqual(L.applyOps(q, { schedule: { days: [2, 4], time: "03:30", offsetMin: 120 } }, NOW).schedule.time, "03:30"); assert.strictEqual(L.cleanSchedule({ lastRun: "2026-11-23T18:00:00Z" }).lastRun, "2026-11-23T18:00:00.000Z");
// next run. NOW is Thu 2026-11-19 12:00 UTC; Monday 20:00 in UTC+2 is 18:00 UTC
const nr = (sc, at) => new Date(L.nextRun(sc, Date.parse(at))).toISOString();
assert.strictEqual(nr(q.schedule, NOW), "2026-11-23T18:00:00.000Z");
assert.strictEqual(nr(q.schedule, "2026-11-23T17:59:00Z"), "2026-11-23T18:00:00.000Z", "just before it is still this Monday");
assert.strictEqual(nr(q.schedule, "2026-11-23T18:00:00Z"), "2026-11-30T18:00:00.000Z", "exactly at the time means the next week");
assert.strictEqual(nr({ days: [1, 4], time: "01:30", offsetMin: 120 }, "2026-11-19T22:00:00Z"), "2026-11-22T23:30:00.000Z", "Monday 01:30 local is Sunday 23:30 UTC");
assert.strictEqual(nr({ days: [0, 1, 2, 3, 4, 5, 6], time: "02:00", offsetMin: 120 }, NOW), "2026-11-20T00:00:00.000Z", "every day still works");
console.log("lists ok");
