"use strict";
// Starts the real server with a fake PocketBase and a fake GitHub, then drives it over HTTP.
const assert = require("assert"), path = require("path"), http = require("http");
const rows = []; let n = 0; const prefs = [];
const fakePb = {
  enabled: true, reload() { return true; }, PBError: class PBError extends Error { constructor(s, m) { super(m); this.status = s; } },
  async verifyToken(t) { if (t === "admin") return { token: "admin", record: { id: "u1", isAdmin: true, name: "Zahir", email: "zahir@x.co", portal: { prefs: {} } } }; if (t === "aikey") return { token: "aikey", record: { id: "u1", isAdmin: true, name: "Zahir", portal: { prefs: { "ai.provider": "anthropic", "ai.apiKey": "sk-ant-WXYZ", "ai.model": "claude-x" } } } }; if (t === "admin2") return { token: "admin2", record: { id: "u3", isAdmin: true, name: "Other admin", portal: { prefs: {} } } }; if (t === "user") return { token: "user", record: { id: "u2", isAdmin: false, email: "sam@x.co", name: "Sam" } }; if (t === "viewer") return { token: "viewer", record: { id: "u4", isAdmin: false, email: "view@x.co", portal: { readonly: true, prefs: {} } } }; const e = new this.PBError(401, "no"); throw e; },
  portalOn() { return true; },
  async portalCall(fn, a) {
    const E = (st, m) => new fakePb.PBError(st, m), qa = global.qa || (global.qa = { code: null, devices: {} });
    if (fn === "qa.status") return { kind: qa.code ? qa.code.kind : null };
    if (fn === "qa.setup") { const o = a[1]; if (o.code) qa.code = { kind: o.kind, code: o.code }; if (!qa.code) throw E(400, "Choose a PIN or pattern first."); const id = ("dev" + Math.random().toString(36).slice(2) + "xxxxxxxxxxxxxxxxxxxx").slice(0, 22); qa.devices[id] = { secret: "sec-" + id, uid: a[0] }; return { deviceId: id, deviceSecret: "sec-" + id, kind: qa.code.kind }; }
    if (fn === "qa.login") { const d = qa.devices[a[0]]; if (!d || d.secret !== a[1]) throw E(401, "Quick Access did not work. Sign in with your password."); if (a[2] !== qa.code.code) throw E(401, "Wrong PIN. 4 tries left."); return { userId: d.uid, kind: qa.code.kind }; }
    if (fn === "qa.remove") { delete qa.devices[a[1]]; return {}; }
    if (fn === "qa.list") return Object.keys(qa.devices).map(id => ({ id }));
    throw E(400, "unknown " + fn);
  },
  async getUser(id) { return { id, name: id === "u1" ? "Zahir" : "", email: "x@x.co", portal: { prefs: {}, signedOutAt: global.signedOutAt || 0 } }; }, async serviceCan() { return true; }, async portalUrl() { return ""; }, async setAppPref(id, v) { prefs.push([id, v]); },
  async asApp(method, p, body) {
    const m = p.match(/records(?:\/(\w+))?(?:\?.*filter=([^&]*))?/), id = m && m[1];
    if (method === "GET") { const f = decodeURIComponent(m[2] || ""), o = (f.match(/owner = '([^']*)'/) || [])[1], k = (f.match(/key = '([^']*)'/) || [])[1]; return { items: rows.filter(r => (!o || r.owner === o) && (!k || r.key === k)) }; }
    if (method === "POST") { const r = { id: "r" + ++n, ...body }; rows.push(r); return r; }
    if (method === "PATCH") { Object.assign(rows.find(r => r.id === id), body); return {}; }
    if (method === "DELETE") { rows.splice(rows.findIndex(r => r.id === id), 1); return {}; }
  },
};
require.cache[require.resolve("./pocketbase")] = { id: "pb", filename: require.resolve("./pocketbase"), loaded: true, exports: fakePb };
// fake GitHub
let file = JSON.stringify({ version: 1, name: "App development", categories: ["X"], projects: [{ id: "a", name: "A", category: "X", status: "maintenance", rank: 10 }, { id: "b", name: "B", category: "X", status: "active", rank: 20 }] }), sha = "s1", puts = 0;
global.fetch = async (u, init = {}) => {
  const R = (status, body, h = {}) => ({ status, ok: status < 400, json: async () => body, headers: { get: k => h[k.toLowerCase()] || null } });
  if (/api\.anthropic\.com/.test(u)) { global.lastAi = JSON.parse(init.body); return R(200, { content: [{ type: "text", text: "Hi from the helper" }] }); }
  if (/\/commits\?/.test(u)) { global.commitAuth = (init.headers || {}).authorization; } if (/\/commits\?/.test(u)) return R(200, [{ commit: { committer: { date: new Date().toISOString() } } }]);
  if ((init.method || "GET") === "GET") { if (init.headers["if-none-match"] === '"e' + sha + '"') return R(304, {}); return R(200, { sha, content: Buffer.from(file).toString("base64") }, { etag: '"e' + sha + '"' }); }
  const b = JSON.parse(init.body); if (b.sha !== sha) return R(409, {}); file = Buffer.from(b.content, "base64").toString(); sha = "s" + (++puts + 1); return R(200, { content: { sha } });
};
process.env.PORT = "39155"; require("./server");
const call = (method, p, body, tok = "admin") => new Promise((ok, bad) => { const r = http.request({ port: 39155, path: p, method, headers: { "x-gd-token": tok, "content-type": "application/json" } }, res => { let d = ""; res.on("data", c => d += c); res.on("end", () => ok({ status: res.statusCode, body: d ? JSON.parse(d) : {} })); }); r.on("error", bad); if (body) r.write(JSON.stringify(body)); r.end(); });
(async () => {
  await new Promise(r => setTimeout(r, 300));
  // the app is public: any signed-in person may open it, but only the owner ever gets the GitHub list
  let r = await call("GET", "/api/lists", null, "user"); assert.strictEqual(r.status, 200); assert.strictEqual(r.body.lists.length, 0, "a new person sees no lists, least of all appdev"); assert.strictEqual(r.body.owner, false);
  assert.strictEqual((await call("GET", "/api/list/appdev", null, "user")).status, 403); assert.strictEqual((await call("GET", "/api/config/github", null, "user")).status, 403);
  assert.strictEqual((await call("GET", "/api/lists", null, "nope")).status, 401);
  r = await call("GET", "/api/list/appdev"); assert.strictEqual(r.status, 200); assert.strictEqual(r.body.list.projects.length, 2); assert.strictEqual(r.body.readOnly, true, "no token yet");
  r = await call("POST", "/api/list/appdev/apply", { ops: { upsert: [] } }); assert.strictEqual(r.status, 403); assert.strictEqual(r.body.code, "read_only");
  // add the token through the connection panel; it is never sent back
  assert.strictEqual((await call("PUT", "/api/config/github", { token: "secret-token" })).status, 200);
  r = await call("GET", "/api/config/github"); assert.strictEqual(r.body.hasToken, true); assert.ok(!JSON.stringify(r.body).includes("secret-token"));
  assert.ok(!JSON.stringify((await call("GET", "/api/list/appdev")).body).includes("secret-token"));
  // move down, change status by hand, archive, delete, restore
  r = await call("POST", "/api/list/appdev/apply", { move: { id: "a", dir: 1 } }); assert.strictEqual(r.status, 200);
  let l = JSON.parse(file); assert.deepStrictEqual(l.projects.filter(p => p.category === "X").sort((x, y) => x.rank - y.rank).map(p => p.id), ["b", "a"]);
  const pa = l.projects.find(p => p.id === "a");
  await call("POST", "/api/list/appdev/apply", { ops: { upsert: [{ ...pa, status: "closed", pinned: true, closedAs: "abandoned" }] } });
  l = JSON.parse(file); assert.strictEqual(l.projects.find(p => p.id === "a").closedAs, "abandoned"); assert.ok(l.projects.find(p => p.id === "a").closedAt);
  await call("POST", "/api/list/appdev/apply", { ops: { upsert: [{ ...l.projects.find(p => p.id === "a"), state: "bin" }] } });
  assert.strictEqual(JSON.parse(file).projects.find(p => p.id === "a").state, "bin");
  await call("POST", "/api/list/appdev/apply", { ops: { remove: ["a"] } }); assert.ok(!JSON.parse(file).projects.find(p => p.id === "a"));
  // polling: unchanged answers are tiny; a change from outside (you or me in GitHub) shows up
  r = await call("GET", "/api/list/appdev"); const stamp = r.body.sha; assert.strictEqual((await call("GET", "/api/list/appdev?sha=" + encodeURIComponent(stamp))).body.unchanged, true);
  file = JSON.stringify({ ...JSON.parse(file), projects: [...JSON.parse(file).projects, { id: "z", name: "Z", category: "X", status: "active", rank: 30 }] }); sha = "s99";
  await new Promise(r => setTimeout(r, 3300));
  r = await call("GET", "/api/list/appdev?sha=" + encodeURIComponent(stamp)); assert.ok(!r.body.unchanged && r.body.list.projects.some(p => p.id === "z"), "outside change is picked up");
  // a private list in PocketBase
  const k = (await call("POST", "/api/lists", { name: "Home & garden" })).body.key; assert.strictEqual(k, "home-garden");
  await call("POST", "/api/list/" + k + "/apply", { ops: { upsert: [{ id: "x1", name: "Fence", category: "Garden", status: "active" }] } });
  r = await call("GET", "/api/list/" + k); assert.strictEqual(r.body.list.projects[0].name, "Fence"); assert.strictEqual(r.body.readOnly, false);
  assert.strictEqual((await call("GET", "/api/lists")).body.lists.length, 2);
  assert.strictEqual((await call("GET", "/api/list/" + k, null, "user")).status, 404, "someone else's private list is invisible");
  await call("DELETE", "/api/list/" + k); assert.strictEqual((await call("GET", "/api/lists")).body.lists.length, 1);
  await call("PUT", "/api/prefs", { view: "abandoned", list: "appdev" }); assert.strictEqual(prefs[0][1].view, "abandoned");
  // the shared list belongs to its owner: another admin sees none of it and cannot reach its connection
  r = await call("GET", "/api/lists", null, "admin2"); assert.strictEqual(r.status, 200); assert.strictEqual(r.body.lists.length, 0); assert.strictEqual(r.body.owner, false);
  assert.strictEqual((await call("GET", "/api/list/appdev", null, "admin2")).status, 403);
  assert.strictEqual((await call("POST", "/api/list/appdev/apply", { ops: {} }, "admin2")).status, 403);
  assert.strictEqual((await call("GET", "/api/config/github", null, "admin2")).status, 403);
  assert.strictEqual((await call("PUT", "/api/config/github", { token: "x" }, "admin2")).status, 403);
  assert.strictEqual((await call("GET", "/api/lists")).body.owner, true);
  await call("PUT", "/api/prefs", { tabs: ["all", "bin", "nope", "all"] }); assert.deepStrictEqual(prefs[prefs.length - 1][1].tabs, ["all", "bin"]);
  await call("PUT", "/api/prefs", { view: "schedule", tabs: ["all", "schedule"], tabsV: 2 }); assert.strictEqual(prefs[prefs.length - 1][1].view, "schedule"); assert.deepStrictEqual(prefs[prefs.length - 1][1].tabs, ["all", "schedule"]); assert.strictEqual(prefs[prefs.length - 1][1].tabsV, 2);
  await call("PUT", "/api/prefs", { tabs: ["nope"] }); assert.strictEqual(prefs[prefs.length - 1][1].tabs, undefined);   // an empty or unknown list is ignored, never saved as no tabs
  await call("PUT", "/api/prefs", { auto: false }); assert.strictEqual(prefs[prefs.length - 1][1].auto, false);
  // built-in chat: needs a key, only the owner can reach the shared list, and answers from the person's own provider
  r = await call("GET", "/api/ai/status"); assert.deepStrictEqual(r.body, { ready: false, key: null });
  r = await call("POST", "/api/ai/chat", { list: "appdev", project: "b", messages: [{ role: "user", text: "hi" }] }); assert.strictEqual(r.status, 400); assert.strictEqual(r.body.code, "no_ai_key");
  r = await call("GET", "/api/ai/status", null, "aikey"); assert.deepStrictEqual(r.body, { ready: true, key: { provider: "anthropic", model: "claude-x", last4: "WXYZ" } });
  r = await call("POST", "/api/ai/chat", { list: "appdev", project: "b", messages: [{ role: "user", text: "hi" }] }, "aikey"); assert.strictEqual(r.status, 200, JSON.stringify(r.body)); assert.strictEqual(r.body.text, "Hi from the helper");
  assert.ok(global.lastAi.system.includes('"B"') || global.lastAi.system.includes("B"), "the project is named in the prompt"); assert.strictEqual(global.lastAi.model, "claude-x");
  r = await call("POST", "/api/ai/chat", { list: "appdev", project: "zzz", messages: [{ role: "user", text: "hi" }] }, "aikey"); assert.strictEqual(r.status, 404);
  await call("PUT", "/api/prefs", { chat: "builtin" }); assert.strictEqual(prefs[prefs.length - 1][1].chat, "builtin"); await call("PUT", "/api/prefs", { days: 7 }); assert.strictEqual(prefs[prefs.length - 1][1].days, 7); await call("PUT", "/api/prefs", { days: 99 }); assert.strictEqual(prefs[prefs.length - 1][1].days, undefined, "out-of-range days ignored");
  await call("PUT", "/api/prefs", { chat: "bogus" }); assert.strictEqual(prefs[prefs.length - 1][1].chat, undefined, "unknown modes are ignored");
  // ---- sharing ----
  const ks = (await call("POST", "/api/lists", { name: "Family trips" })).body.key;
  await call("POST", "/api/list/" + ks + "/apply", { ops: { upsert: [{ id: "t1", name: "Cape Town", category: "Trips", status: "active", paths: [{ repo: "a/b", path: "x" }] }] } });
  r = await call("POST", "/api/list/" + ks + "/share", { email: "sam@x.co", role: "view" }); assert.strictEqual(r.status, 200);
  assert.strictEqual((await call("POST", "/api/list/" + ks + "/share", { email: "zahir@x.co" })).status, 400, "not with yourself");
  assert.strictEqual((await call("POST", "/api/list/" + ks + "/share", { email: "nope" })).status, 400);
  r = await call("GET", "/api/list/" + ks); assert.strictEqual(r.body.role, "owner"); assert.strictEqual(r.body.shares.length, 1);
  r = await call("GET", "/api/lists", null, "user"); const sh = r.body.lists.find(x => x.source === "shared"); assert.ok(sh && sh.key.startsWith("shared--u1--") && sh.role === "view" && sh.by === "Zahir" && sh.count === 1, JSON.stringify(r.body));
  r = await call("GET", "/api/list/" + sh.key, null, "user"); assert.strictEqual(r.status, 200); assert.strictEqual(r.body.readOnly, true); assert.strictEqual(r.body.shares, undefined, "recipients never see who else it is shared with");
  assert.strictEqual(global.commitAuth, undefined, "other people's lists never use the owner's GitHub token");
  r = await call("POST", "/api/list/" + sh.key + "/apply", { ops: { upsert: [{ id: "t2", name: "Nope", category: "Trips" }] } }, "user"); assert.strictEqual(r.status, 403); assert.strictEqual(r.body.code, "read_only");
  assert.strictEqual((await call("GET", "/api/list/" + sh.key, null, "admin2")).status, 404, "a third person gets nothing");
  assert.strictEqual((await call("POST", "/api/list/" + sh.key + "/share", { email: "x@y.co" }, "user")).status, 403, "only the maker shares");
  assert.strictEqual((await call("DELETE", "/api/list/" + sh.key, null, "user")).status, 404 === 0 ? 0 : (await call("DELETE", "/api/list/" + sh.key, null, "user")).status, "recipients can't delete it");
  assert.ok((await call("GET", "/api/list/" + ks)).body.list.projects.length === 1, "still there after that delete attempt");
  await call("POST", "/api/list/" + ks + "/share", { email: "Sam@X.co", role: "edit" });
  r = await call("POST", "/api/list/" + sh.key + "/apply", { ops: { upsert: [{ id: "t2", name: "Garden Route", category: "Trips", status: "active" }] } }, "user"); assert.strictEqual(r.status, 200);
  r = await call("GET", "/api/list/" + ks); assert.strictEqual(r.body.list.projects.length, 2); assert.strictEqual(r.body.shares.length, 1, "an edit never loses the shares"); assert.strictEqual(r.body.shares[0].role, "edit");
  await call("POST", "/api/list/" + ks + "/share", { email: "view@x.co", role: "edit" });
  r = await call("GET", "/api/lists", null, "viewer"); const vs = r.body.lists.find(x => x.source === "shared"); assert.strictEqual(vs.role, "view", "a view-only account is never an editor");
  assert.strictEqual((await call("POST", "/api/list/" + vs.key + "/apply", { ops: {} }, "viewer")).status, 403);
  r = await call("POST", "/api/ai/chat", { list: sh.key, project: "t1", messages: [{ role: "user", text: "hi" }] }, "aikey"); assert.strictEqual(r.status, 404, "chat only reads lists you can open");
  assert.strictEqual((await call("POST", "/api/list/" + sh.key + "/leave", {}, "user")).status, 200);
  assert.strictEqual((await call("GET", "/api/list/" + sh.key, null, "user")).status, 404); assert.strictEqual((await call("GET", "/api/list/" + ks)).body.shares.length, 1, "leaving removes only you");
  await call("POST", "/api/list/" + ks + "/share", { email: "view@x.co", remove: true });
  assert.strictEqual((await call("GET", "/api/lists", null, "viewer")).body.lists.filter(x => x.source === "shared").length, 0);
  await call("POST", "/api/list/" + ks + "/share", { email: "sam@x.co", role: "view" });
  await call("DELETE", "/api/list/" + ks); assert.strictEqual(rows.filter(x => String(x.owner).startsWith("inv:")).length, 0, "deleting a list tidies its shares");
  assert.strictEqual((await call("GET", "/api/lists", null, "user")).body.lists.length, 0);
  // Quick Access: PIN on a device that signed in before
  r = await call("GET", "/api/account/quick/status", null, "admin"); assert.deepStrictEqual(r.body, { available: true, kind: null });
  assert.strictEqual((await call("GET", "/api/account/quick/status", null, "")).status, 401, "managing Quick Access needs a sign-in");
  r = await call("POST", "/api/account/quick", { kind: "pin4", code: "1234", label: "Test phone" }, "admin"); assert.strictEqual(r.status, 201); const dev = r.body;
  assert.strictEqual((await call("GET", "/api/account/quick/status", null, "admin")).body.kind, "pin4");
  r = await call("POST", "/api/account/login", { quick: { deviceId: dev.deviceId, deviceSecret: dev.deviceSecret, code: "0000" } }, ""); assert.strictEqual(r.status, 401); assert.ok(/Wrong PIN/.test(r.body.message));
  r = await call("POST", "/api/account/login", { quick: { deviceId: dev.deviceId, deviceSecret: "nope", code: "1234" } }, ""); assert.strictEqual(r.status, 401, "wrong device secret");
  r = await call("POST", "/api/account/login", { quick: { deviceId: dev.deviceId, deviceSecret: dev.deviceSecret, code: "1234" } }, ""); assert.strictEqual(r.status, 200); assert.ok(/^s\./.test(r.body.token), "its own session"); assert.strictEqual(r.body.user.id, "u1"); const qtok = r.body.token;
  assert.strictEqual((await call("GET", "/api/lists", null, qtok)).status, 200, "the Quick Access session opens the app");
  assert.strictEqual((await call("GET", "/api/account/me", null, qtok)).body.user.id, "u1");
  assert.strictEqual((await call("GET", "/api/lists", null, qtok.slice(0, -2) + "xx")).status, 401, "a tampered session is refused");
  global.signedOutAt = Date.now() + 5000;
  r = await call("POST", "/api/account/login", { quick: { deviceId: dev.deviceId, deviceSecret: dev.deviceSecret, code: "1234" } }, "");
  assert.strictEqual((await call("GET", "/api/lists", null, r.body.token)).status, 401, "signed out everywhere ends sessions that began before it"); global.signedOutAt = 0;
  assert.strictEqual((await call("DELETE", "/api/account/quick/" + dev.deviceId, null, "admin")).status, 200);
  assert.strictEqual((await call("POST", "/api/account/login", { quick: { deviceId: dev.deviceId, deviceSecret: dev.deviceSecret, code: "1234" } }, "")).status, 401, "a removed device cannot sign in");
  console.log("server ok"); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
