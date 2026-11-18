// Change inbox: files from the repo's portal-changes/ folder become Changes cards (data only), and Apply does exactly what the plan says.
"use strict";
const http = require("http");
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log("FAIL", m); } else console.log("ok  ", m); };
const files = {
  "001-portal-url.json": { id: "portal-url", title: "Set the JoolzApp address", summary: "QR sign-in needs it.", ops: [{ op: "setting", key: "portal.url", value: "https://joolzapp.example.ts.net", note: "QR sign-in" }] },
  "002-bad-op.json": { id: "evil", title: "Run code", ops: [{ op: "exec", key: "x.y" }] },
  "003-secret.json": { id: "sec", title: "Secret", ops: [{ op: "setting", key: "secret.tmdb", value: "x" }] },
  "004-slash.json": { id: "slash", title: "Bad url", ops: [{ op: "setting", key: "portal.url", value: "https://x.ts.net/" }] },
  "005-dupe.json": { id: "portal-url", title: "Duplicate id", ops: [{ op: "setting", key: "other.key", value: 1 }] },
  "006-remove.json": { id: "remove-old", title: "Remove", ops: [{ op: "delete-setting", key: "old.key" }] },
};
const rows = [{ id: "r9", scope: "global", key: "old.key", value: true }];
const srv = http.createServer((q, r) => {
  const u = new URL(q.url, "http://x");
  if (u.pathname.endsWith("/contents/portal-changes")) { r.writeHead(200, { "content-type": "application/json" }); return r.end(JSON.stringify(Object.keys(files).map((n) => ({ name: n, type: "file", size: 300 })).concat([{ name: "README.md", type: "file", size: 5 }, { name: "big.json", type: "file", size: 999999 }]))); }
  const m = /\/portal-changes\/(.+)$/.exec(u.pathname); if (m && files[m[1]]) { r.writeHead(200); return r.end(JSON.stringify(files[m[1]])); }
  r.writeHead(404); r.end("no");
});
(async () => {
  await new Promise((r) => srv.listen(0, r)); const base = "http://127.0.0.1:" + srv.address().port;
  process.env.INBOX_API = base; process.env.INBOX_RAW = base + "/raw"; let n = 0;
  const ctx = {
    esc: (s) => String(s).replace(/'/g, "\\'"),
    async pb(method, p, body) {
      const key = /key = '([^']*)'/.exec(decodeURIComponent(p)); 
      if (method === "GET") return { items: rows.filter((x) => x.key === (key && key[1])) };
      if (method === "POST") { rows.push({ id: "n" + ++n, ...body }); return {}; }
      const id = p.split("/").pop(), i = rows.findIndex((x) => x.id === id);
      if (method === "PATCH") Object.assign(rows[i], body); if (method === "DELETE") rows.splice(i, 1); return {};
    },
  };
  const inbox = require("./inbox.js")(ctx);
  const sets = await inbox.load();
  ok(sets.length === 5, "valid and broken files are listed, README and oversized files are ignored, a duplicate id is dropped (" + sets.length + ")");
  const by = (id) => sets.find((s) => s.id === id);
  ok(by("inbox:portal-url") && /repo inbox/.test(by("inbox:portal-url").summary), "a valid file becomes a change marked as coming from the inbox");
  let plan = await by("inbox:portal-url").plan(); ok(plan.length === 1 && /Add setting portal.url/.test(plan[0]), "the plan says what will be added: " + plan[0]);
  for (const id of ["inbox:002-bad-op", "inbox:003-secret", "inbox:004-slash"]) { let e = null; try { await by(id).plan(); } catch (x) { e = x; } ok(e && /not a valid change/.test(e.message), id + " is shown as a problem, never applied: " + (e && e.message)); }
  await by("inbox:portal-url").apply();
  ok(rows.some((r) => r.key === "portal.url" && r.scope === "global" && r.value === "https://joolzapp.example.ts.net" && r.secret === false), "Apply adds the global setting (not secret)");
  ok((await by("inbox:portal-url").plan()).length === 0, "after Apply there is nothing left to do (safe to apply twice)");
  rows.find((r) => r.key === "portal.url").value = "https://old"; plan = await by("inbox:portal-url").plan(); ok(/Change setting portal.url from "https:\/\/old"/.test(plan[0]), "a different value is shown as a change: " + plan[0]);
  plan = await by("inbox:remove-old").plan(); ok(plan.length === 1 && /Remove setting old.key/.test(plan[0]), "delete-setting is planned when the row exists");
  await by("inbox:remove-old").apply(); ok(!rows.some((r) => r.key === "old.key"), "and removes it");
  ok(by("inbox:remove-old") && (await by("inbox:remove-old").plan()).length === 0, "removing twice does nothing");
  srv.close();
  console.log(fails ? fails + " FAILED" : "all passed"); process.exit(fails ? 1 : 0);
})();
