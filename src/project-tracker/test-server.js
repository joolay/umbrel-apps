"use strict";
// Starts the real server with a fake PocketBase and a fake GitHub, then drives it over HTTP.
const assert = require("assert"), path = require("path"), http = require("http");
const rows = []; let n = 0; const prefs = [];
const fakePb = {
  enabled: true, reload() { return true; }, PBError: class PBError extends Error { constructor(s, m) { super(m); this.status = s; } },
  async verifyToken(t) { if (t === "admin") return { token: "admin", record: { id: "u1", isAdmin: true, name: "Zahir", portal: { prefs: {} } } }; if (t === "aikey") return { token: "aikey", record: { id: "u1", isAdmin: true, name: "Zahir", portal: { prefs: { "ai.provider": "anthropic", "ai.apiKey": "sk-ant-WXYZ", "ai.model": "claude-x" } } } }; if (t === "admin2") return { token: "admin2", record: { id: "u3", isAdmin: true, name: "Other admin", portal: { prefs: {} } } }; if (t === "user") return { token: "user", record: { id: "u2", isAdmin: false } }; const e = new this.PBError(401, "no"); throw e; },
  async serviceCan() { return true; }, async portalUrl() { return ""; }, async setAppPref(id, v) { prefs.push([id, v]); },
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
  if (/\/commits\?/.test(u)) return R(200, [{ commit: { committer: { date: new Date().toISOString() } } }]);
  if ((init.method || "GET") === "GET") { if (init.headers["if-none-match"] === '"e' + sha + '"') return R(304, {}); return R(200, { sha, content: Buffer.from(file).toString("base64") }, { etag: '"e' + sha + '"' }); }
  const b = JSON.parse(init.body); if (b.sha !== sha) return R(409, {}); file = Buffer.from(b.content, "base64").toString(); sha = "s" + (++puts + 1); return R(200, { content: { sha } });
};
process.env.PORT = "39155"; require("./server");
const call = (method, p, body, tok = "admin") => new Promise((ok, bad) => { const r = http.request({ port: 39155, path: p, method, headers: { "x-gd-token": tok, "content-type": "application/json" } }, res => { let d = ""; res.on("data", c => d += c); res.on("end", () => ok({ status: res.statusCode, body: d ? JSON.parse(d) : {} })); }); r.on("error", bad); if (body) r.write(JSON.stringify(body)); r.end(); });
(async () => {
  await new Promise(r => setTimeout(r, 300));
  assert.strictEqual((await call("GET", "/api/lists", null, "user")).status, 403, "non-admins are refused");
  assert.strictEqual((await call("GET", "/api/lists", null, "nope")).status, 401);
  let r = await call("GET", "/api/list/appdev"); assert.strictEqual(r.status, 200); assert.strictEqual(r.body.list.projects.length, 2); assert.strictEqual(r.body.readOnly, true, "no token yet");
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
  assert.strictEqual((await call("GET", "/api/list/" + k, null, "user")).status, 403);
  await call("DELETE", "/api/list/" + k); assert.strictEqual((await call("GET", "/api/lists")).body.lists.length, 1);
  await call("PUT", "/api/prefs", { view: "closed", list: "appdev" }); assert.strictEqual(prefs[0][1].view, "closed");
  // the shared list belongs to its owner: another admin sees none of it and cannot reach its connection
  r = await call("GET", "/api/lists", null, "admin2"); assert.strictEqual(r.status, 200); assert.strictEqual(r.body.lists.length, 0); assert.strictEqual(r.body.owner, false);
  assert.strictEqual((await call("GET", "/api/list/appdev", null, "admin2")).status, 403);
  assert.strictEqual((await call("POST", "/api/list/appdev/apply", { ops: {} }, "admin2")).status, 403);
  assert.strictEqual((await call("GET", "/api/config/github", null, "admin2")).status, 403);
  assert.strictEqual((await call("PUT", "/api/config/github", { token: "x" }, "admin2")).status, 403);
  assert.strictEqual((await call("GET", "/api/lists")).body.owner, true);
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
  console.log("server ok"); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
