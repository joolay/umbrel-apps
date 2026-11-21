// Install queue: Changes card adds a joolay-* app, only App Updater can read/report, a report clears finished installs.
"use strict";
const assert = require("assert");
(async () => {
  let row = null;
  const asSuper = async (m, p, b) => {
    if (m === "GET") return { items: row ? [row] : [] };
    if (m === "POST") { row = { id: "r1", ...b }; return row; }
    if (m === "PATCH") { Object.assign(row, b); return row; }
  };
  const iq = require("./installqueue")({ asSuper, now: () => 1000 });
  assert.deepStrictEqual(await iq.planAdd("joolay-foo"), ["Queue joolay-foo for automatic install by App Updater"]);
  await Promise.all([iq.add("joolay-foo"), iq.add("joolay-bar"), iq.add("joolay-foo")]);
  assert.deepStrictEqual((await iq.get()).queue, ["joolay-foo", "joolay-bar"], "two quick adds never overwrite each other, no duplicates");
  assert.deepStrictEqual(await iq.planAdd("joolay-foo"), [], "already queued: nothing to do");
  await assert.rejects(iq.add("evil-app"), /joolay-/, "only joolay-* ids");
  await assert.rejects(iq.queueFor("shutterworth"), /Only App Updater/, "other apps cannot read it");
  await assert.rejects(iq.reportFrom("shutterworth", []), /Only App Updater/);
  assert.deepStrictEqual(await iq.queueFor("app-updater"), { queue: ["joolay-foo", "joolay-bar"] });
  const out = await iq.reportFrom("app-updater", [{ id: "joolay-foo", ok: true, note: "Installed" }, { id: "nope", ok: true }]);
  assert.deepStrictEqual(out, { queue: ["joolay-bar"] }, "a finished install leaves the queue, junk ids are ignored");
  assert.strictEqual((await iq.get()).results[0].note, "Installed");
  const inbox = require("./inbox");
  inbox.validate({ id: "install-foo", title: "Install Foo", ops: [{ op: "install-app", id: "joolay-foo" }] });
  assert.throws(() => inbox.validate({ id: "x", title: "t", ops: [{ op: "install-app", id: "../etc" }] }), /install-app/);
  console.log("installqueue ok");
})().catch((e) => { console.error(e); process.exit(1); });
