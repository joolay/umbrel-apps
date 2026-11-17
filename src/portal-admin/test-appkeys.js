// App keys: the admin saves a key once, the app reads only its own, nothing is sent back, the change card keeps secrets hidden.
"use strict";
const http = require("http"), path = require("path"), fs = require("fs"), os = require("os");
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log("FAIL", m); } else console.log("ok  ", m); };
const rows = []; let nextId = 1; const seen = [];
const pbStub = http.createServer((q, r) => {
  const u = new URL(q.url, "http://x"), chunks = [];
  q.on("data", d => chunks.push(d)); q.on("end", () => {
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null, J = (o, c) => { r.writeHead(c || 200, { "content-type": "application/json" }); r.end(JSON.stringify(o)); };
    seen.push(q.method + " " + u.pathname + (u.searchParams.get("filter") ? " ? " + u.searchParams.get("filter") : ""));
    if (/auth-with-password$/.test(u.pathname)) return J({ token: "su-token", record: { id: "su1" } });
    if (u.pathname === "/api/collections/portal_apps/records") return J({ items: [{ slug: "joolztv", name: "JoolzTV" }, { slug: "listify", name: "Listify" }], totalPages: 1 });
    if (u.pathname === "/api/collections/portal_settings/records") {
      if (q.method === "GET") { const f = u.searchParams.get("filter") || ""; const m = /app = '([^']*)' && key = '([^']*)'/.exec(f); return J({ items: rows.filter(x => m && x.app === m[1] && x.key === m[2]), totalPages: 1 }); }
      if (q.method === "POST") { const rec = Object.assign({ id: "r" + nextId++ }, body); rows.push(rec); return J(rec); }
    }
    const m = /^\/api\/collections\/portal_settings\/records\/(r\d+)$/.exec(u.pathname);
    if (m && q.method === "PATCH") { const x = rows.filter(y => y.id === m[1])[0]; Object.assign(x, body); return J(x); }
    if (m && q.method === "DELETE") { const i = rows.findIndex(y => y.id === m[1]); rows.splice(i, 1); return J({}, 204); }
    J({}, 404);
  });
});
(async () => {
  await new Promise(r => pbStub.listen(0, r)); const URL_BASE = "http://127.0.0.1:" + pbStub.address().port;
  // Portal Admin's own pocketbase.js reads these
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pa-")); fs.writeFileSync(path.join(tmp, "pocketbase.env"), "POCKETBASE_SUPERUSER_EMAIL=a@x.com\nPOCKETBASE_SUPERUSER_PASSWORD=pw-pw-pw-pw\n");
  process.env.PB_URL = URL_BASE; process.env.DATA_DIR = tmp; process.env.UMBREL_APPS_DIR = tmp;
  const keys = require("./appkeys.js");
  let v = await keys.adminView();
  ok(v.apps.length === 1 && v.apps[0].slug === "joolztv" && v.apps[0].keys[0].name === "tmdb" && v.apps[0].keys[0].has === false, "the App keys page lists the keys an installed app can be given, and only for apps that need one (JoolzTV, not Listify)");
  let e = null; try { await keys.adminAction({ app: "joolztv", name: "tmdb", value: "has spaces!" }); } catch (x) { e = x; } ok(e && e.status === 400, "a value that is not a key is refused before anything is stored");
  e = null; try { await keys.adminAction({ app: "listify", name: "tmdb", value: "abcdefghijklmnop0123" }); } catch (x) { e = x; } ok(e && e.status === 400, "an app that has no such key cannot be given one");
  e = null; try { await keys.adminAction({ app: "joolztv", name: "other", value: "abcdefghijklmnop0123" }); } catch (x) { e = x; } ok(e && e.status === 400, "only the keys an app declares can be saved");
  const KEY = "abcdef0123456789abcdef0123456789";
  let r = await keys.adminAction({ app: "joolztv", name: "tmdb", value: KEY }); ok(r.has === true && rows.length === 1, "the admin saves a key");
  ok(rows[0].scope === "app" && rows[0].app === "joolztv" && rows[0].key === "secret.tmdb" && rows[0].secret === true && rows[0].user === "", "it is stored as an app-level secret setting that PocketBase hides from signed-in people");
  v = await keys.adminView(); ok(v.apps[0].keys[0].has === true && !JSON.stringify(v).includes(KEY), "the page says it is saved, and the key is never sent back");
  r = await keys.adminAction({ app: "joolztv", name: "tmdb", value: KEY + "ZZ" }); ok(rows.length === 1 && rows[0].value === KEY + "ZZ", "saving again replaces it (no second copy)");
  // the app side
  const makeClient = require("./appclient.js");
  const mk = (app) => makeClient({ url: URL_BASE, email: "a@x.com", pass: "pw-pw-pw-pw", app });
  ok(await mk("joolztv").appSecret("tmdb") === KEY + "ZZ", "JoolzTV can read its own key through Portal API");
  ok(await mk("listify").appSecret("tmdb") === "", "another app asking for the same name gets nothing: each app reads only its own");
  ok(await mk("joolztv").appSecret("../x") === "" && await mk("joolztv").appSecret("nope") === "", "odd or unknown names give nothing");
  ok(seen.filter(s => /secret\.tmdb/.test(s) && /app = 'listify'/.test(s)).length >= 1, "the lookup is filtered by the calling app (checked in the query PocketBase received)");
  r = await keys.adminAction({ app: "joolztv", name: "tmdb", value: "" }); ok(r.has === false && rows.length === 0, "the admin can remove the key");
  ok(await mk("joolztv").appSecret("tmdb") === "", "...and the app then gets nothing");
  const card = require("./changes/012-app-keys.js");
  const col = (o) => ({ getCollection: async () => o, pb: async (m, p, b) => { col.last = b; } });
  ok((await card.plan(col({ listRule: '@request.auth.id != "" && secret = false', viewRule: '@request.auth.id != "" && secret = false', createRule: '@request.auth.id != ""' }))).length === 0, "the change has nothing to do when secrets are already hidden");
  const todo = await card.plan(col({ listRule: '@request.auth.id != ""', viewRule: null, createRule: 'scope = "app"' }));
  ok(todo.length === 2 && /Hide secret settings/.test(todo[0]), "it notices when PocketBase would show secrets to signed-in people (" + todo.join("; ") + ")");
  const c2 = col({ listRule: '@request.auth.id != ""', viewRule: '', createRule: 'scope = "app"' }); await card.apply(c2); ok(/secret = false/.test(col.last.listRule) && /secret = false/.test(col.last.viewRule) && col.last.createRule === null, "applying hides them and limits writes to the superuser");
  pbStub.close(); console.log(fails ? fails + " FAILED" : "ALL PASSED"); process.exit(fails ? 1 : 0);
})().catch(e => { console.log("ERROR", e.stack); process.exit(1); });
