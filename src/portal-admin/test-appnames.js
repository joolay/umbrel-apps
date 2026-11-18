// App names: the admin sees what people renamed their apps to, and can reset one or all of a person's names.
"use strict";
const http = require("http"), path = require("path"), fs = require("fs"), os = require("os");
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log("FAIL", m); } else console.log("ok  ", m); };
const rows = [
  { id: "r1", scope: "user", user: "userAAAA1", app: "", key: "pref.home.layout", value: { order: ["app:joolztv"], names: { joolztv: "Telly", listify: "Lists" } } },
  { id: "r2", scope: "user", user: "userBBBB2", app: "", key: "pref.home.layout", value: { order: [], names: {} } },
  { id: "r3", scope: "user", user: "userCCCC3", app: "", key: "pref.home.layout", value: { names: { joolztv: "<b>X</b>\u0000", listify: "Listify" } } },
  { id: "r4", scope: "user", user: "userAAAA1", app: "", key: "pref.adminUrl", value: "x" },
];
const pbStub = http.createServer((q, r) => {
  const u = new URL(q.url, "http://x"), chunks = []; q.on("data", d => chunks.push(d)); q.on("end", () => {
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null, J = (o, c) => { r.writeHead(c || 200, { "content-type": "application/json" }); r.end(JSON.stringify(o)); };
    if (/auth-with-password$/.test(u.pathname)) return J({ token: "su-token", record: { id: "su1" } });
    if (u.pathname === "/api/collections/portal_apps/records") return J({ items: [{ slug: "joolztv", name: "JoolzTV" }, { slug: "listify", name: "Listify" }], totalPages: 1 });
    let m = /^\/api\/collections\/users\/records\/(\w+)$/.exec(u.pathname); if (m) return J({ id: m[1], name: m[1] === "userAAAA1" ? "Ann" : "", email: m[1].toLowerCase() + "@x.com" });
    if (u.pathname === "/api/collections/portal_settings/records" && q.method === "GET") {
      const f = u.searchParams.get("filter") || "", um = /user = '([^']*)'/.exec(f);
      return J({ items: rows.filter(x => x.scope === "user" && x.key === "pref.home.layout" && (!um || x.user === um[1])), totalPages: 1 });
    }
    m = /^\/api\/collections\/portal_settings\/records\/(r\d+)$/.exec(u.pathname);
    if (m && q.method === "PATCH") { const x = rows.filter(y => y.id === m[1])[0]; Object.assign(x, body); return J(x); }
    J({}, 404);
  });
});
(async () => {
  await new Promise(r => pbStub.listen(0, r));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pa-")); fs.writeFileSync(path.join(tmp, "pocketbase.env"), "POCKETBASE_SUPERUSER_EMAIL=a@x.com\nPOCKETBASE_SUPERUSER_PASSWORD=pw-pw-pw-pw\n");
  process.env.PB_URL = "http://127.0.0.1:" + pbStub.address().port; process.env.DATA_DIR = tmp; process.env.UMBREL_APPS_DIR = tmp;
  const N = require("./appnames.js");
  let v = await N.adminView();
  ok(v.items.length === 4, "every rename is listed, people with none are not (" + v.items.length + ")");
  const a = v.items.filter(i => i.user === "userAAAA1");
  ok(a.length === 2 && a[0].userName === "Ann" && a.some(i => i.slug === "joolztv" && i.original === "JoolzTV" && i.custom === "Telly" && i.changed), "it shows who renamed what, the original name and the new name");
  ok(v.items.filter(i => i.user === "userCCCC3" && i.slug === "joolztv")[0].custom === "bX/b", "angle brackets and control characters are stripped from names");
  ok(v.items.filter(i => i.user === "userCCCC3" && i.slug === "listify")[0].changed === false, "a name that equals the original is marked as not changed");
  let e = null; try { await N.adminAction({ user: "x y", slug: "joolztv" }); } catch (x) { e = x; } ok(e && e.status === 400, "a bad person id is refused");
  e = null; try { await N.adminAction({ user: "userAAAA1", slug: "../x" }); } catch (x) { e = x; } ok(e && e.status === 400, "a bad app id is refused");
  let r = await N.adminAction({ user: "userAAAA1", slug: "joolztv" }); ok(r.reset === 1 && !("joolztv" in rows[0].value.names) && rows[0].value.names.listify === "Lists" && rows[0].value.order[0] === "app:joolztv", "the admin resets one name; the rest of the person's layout is untouched");
  r = await N.adminAction({ user: "userAAAA1", slug: "joolztv" }); ok(r.reset === 0, "resetting twice does nothing");
  r = await N.adminAction({ user: "userAAAA1", all: true }); ok(r.reset === 1 && Object.keys(rows[0].value.names).length === 0, "the admin can reset all of a person's names");
  ok(rows[3].value === "x", "other settings rows are never touched");
  v = await N.adminView(); ok(v.items.every(i => i.user !== "userAAAA1"), "the list no longer shows them");
  pbStub.close(); console.log(fails ? fails + " FAILED" : "ALL PASSED"); process.exit(fails ? 1 : 0);
})().catch(e => { console.log("ERROR", e.stack); process.exit(1); });
