"use strict";
// Starts the real server with a fake PocketBase and drives it over HTTP. Run: node test-server.js
const assert = require("assert"), http = require("http"), fs = require("fs"), path = require("path");
const rows = []; let n = 0; const saved = [];
const fakePb = {
  enabled: true, reload() { return true; }, PBError: class PBError extends Error { constructor(s, m) { super(m); this.status = s; } },
  async verifyToken(t) { if (t === "zahir") return { token: "zahir", record: { id: "u1", name: "Zahir", email: "z@x.co", portal: { prefs: { "gym-guru": { voice: false } } } } }; if (t === "sadia") return { token: "sadia", record: { id: "u2", name: "Sadia", email: "s@x.co", portal: { prefs: {} } } }; throw new fakePb.PBError(401, "bad token"); },
  async getUser(id) { return { id, portal: { prefs: {} } }; }, async serviceCan() { return true; }, async portalUrl() { return "https://portal.example"; }, portalOn() { return true; },
  async portalCall() { return {}; },
  async setAppPref(id, v) { saved.push([id, v]); },
  async asApp(method, p, body) {
    const m = p.match(/records(?:\/(\w+))?(?:\?.*filter=([^&]*))?/), id = m && m[1];
    if (method === "GET") { const f = decodeURIComponent(m[2] || ""), o = (f.match(/owner = '([^']*)'/) || [])[1], k = (f.match(/key = '([^']*)'/) || [])[1]; return { items: rows.filter(r => (!o || r.owner === o) && (!k || r.key === k)) }; }
    if (method === "POST") { const r = { id: "r" + ++n, ...body }; rows.push(r); return r; }
    if (method === "PATCH") { Object.assign(rows.find(r => r.id === id), body); return {}; }
    if (method === "DELETE") { rows.splice(rows.findIndex(r => r.id === id), 1); return {}; }
  },
};
require.cache[require.resolve("./pocketbase")] = { id: "pb", filename: require.resolve("./pocketbase"), loaded: true, exports: fakePb };
process.env.PORT = "39251"; process.env.DATA_DIR = fs.mkdtempSync(path.join(require("os").tmpdir(), "gg-"));
const { server } = require("./server"); server.listen(39251);
const call = (method, p, body, tok = "zahir", raw) => new Promise((ok, bad) => { const r = http.request({ port: 39251, path: p, method, headers: { "x-gd-token": tok, "content-type": "application/json" } }, res => { let b = ""; res.on("data", c => b += c); res.on("end", () => { let j = {}; try { j = JSON.parse(b); } catch {} ok({ status: res.statusCode, body: j, text: b, type: res.headers["content-type"], cache: res.headers["cache-control"] }); }); }); r.on("error", bad); if (body) r.write(JSON.stringify(body)); r.end(); });
const good = (id, o = {}) => ({ id, ex: "curl", name: "Bicep curl", reps: 12, kg: 10, secs: 40, at: "2026-11-26T08:00:00.000Z", ...o });
(async () => {
  await new Promise(r => setTimeout(r, 200));
  let r = await call("GET", "/api/state", null, "nope"); assert.strictEqual(r.status, 401, "no sign-in, no data");
  r = await call("GET", "/api/state"); assert.strictEqual(r.status, 200); assert.deepStrictEqual(r.body.sets, []);
  r = await call("GET", "/", null, "nope"); assert.ok(/<title>Gym Guru<\/title>/.test(r.text) && /JZGate/.test(r.text), "signed-out people get the gate");
  r = await call("GET", "/"); assert.ok(/id="v-train"/.test(r.text), "signed-in people get the app");
  // saving sets
  assert.strictEqual((await call("POST", "/api/set", good("a1"))).status, 200);
  assert.strictEqual((await call("POST", "/api/set", good("a2", { reps: 8, kg: null }))).status, 200);
  assert.strictEqual((await call("POST", "/api/set", good("a1", { reps: 13 }))).status, 200);   // same id: replaced, not duplicated
  r = await call("GET", "/api/state"); assert.strictEqual(r.body.sets.length, 2); assert.strictEqual(r.body.sets.find(s => s.id === "a1").reps, 13);
  assert.strictEqual(rows.length, 1, "one record per person");
  // private to the person
  r = await call("GET", "/api/state", null, "sadia"); assert.strictEqual(r.body.sets.length, 0, "another person sees none of it");
  await call("POST", "/api/set", good("b1", { ex: "press", name: "Shoulder press" }), "sadia");
  assert.strictEqual((await call("GET", "/api/state")).body.sets.length, 2); assert.strictEqual((await call("GET", "/api/state", null, "sadia")).body.sets.length, 1);
  // bad input is refused or cleaned
  assert.strictEqual((await call("POST", "/api/set", { id: "../x", ex: "curl", reps: 3 })).status, 400);
  assert.strictEqual((await call("POST", "/api/set", good("c1", { ex: "" }))).status, 400);
  await call("POST", "/api/set", good("c2", { reps: 99999, kg: -5, name: "x".repeat(500) }));
  const c2 = (await call("GET", "/api/state")).body.sets.find(s => s.id === "c2"); assert.strictEqual(c2.reps, 999); assert.strictEqual(c2.kg, 0); assert.strictEqual(c2.name.length, 60);
  // delete
  assert.strictEqual((await call("DELETE", "/api/set?id=a2")).status, 200); assert.ok(!(await call("GET", "/api/state")).body.sets.some(s => s.id === "a2"));
  assert.strictEqual((await call("DELETE", "/api/set?id=a%20b")).status, 400);
  assert.strictEqual((await call("GET", "/api/state", null, "sadia")).body.sets.length, 1, "deleting mine never touches hers");
  // machines
  const prof = { v: 1, idx: 15, axis: "y", startHigh: false, lo: -1.2, hi: 0.4, amp: 1.6, near: 0.48 };
  assert.strictEqual((await call("POST", "/api/machine", { id: "m1", name: "Chest press", profile: prof })).status, 200);
  assert.strictEqual((await call("POST", "/api/machine", { id: "m2", name: "Broken", profile: { idx: 99, axis: "z" } })).status, 400);
  assert.strictEqual((await call("POST", "/api/machine", { id: "m1", name: "Chest press 2", profile: prof })).status, 200);
  r = await call("GET", "/api/state"); assert.strictEqual(r.body.machines.length, 1); assert.strictEqual(r.body.machines[0].name, "Chest press 2");
  assert.strictEqual((await call("GET", "/api/state", null, "sadia")).body.machines.length, 0);
  assert.strictEqual((await call("DELETE", "/api/machine?id=m1")).status, 200); assert.strictEqual((await call("GET", "/api/state")).body.machines.length, 0);
  // settings go to the account, only known keys with valid values
  r = await call("PUT", "/api/prefs", { voice: true, sens: "strict", countdown: 5, camera: "environment", ex: "m-abc", kg: { curl: 12.5, "bad key!": 3 }, mode: { curl: "both" }, sens2: "x", countdown2: 1, theme: "dark" });
  assert.strictEqual(r.status, 200); const p = saved[saved.length - 1][1];
  assert.deepStrictEqual(p, { voice: true, sens: "strict", countdown: 5, camera: "environment", ex: "m-abc", kg: { curl: 12.5 }, mode: { curl: "both" }, theme: "dark" });
  await call("PUT", "/api/prefs", { sens: "ultra", countdown: 7, camera: "side", voice: "yes" }); const q = saved[saved.length - 1][1];
  assert.strictEqual(q.sens, undefined, "an invalid value is ignored"); assert.strictEqual(q.camera, undefined); assert.strictEqual(q.voice, false, "kept the earlier saved value, not the invalid one"); assert.strictEqual(q.countdown, undefined);
  // static files: the model files are served with the right type and cached
  fs.mkdirSync(path.join(__dirname, "public/vendor/wasm"), { recursive: true }); fs.writeFileSync(path.join(__dirname, "public/vendor/wasm/t.wasm"), "\0asm"); fs.writeFileSync(path.join(__dirname, "public/vendor/m.mjs"), "export default 1");
  r = await call("GET", "/vendor/wasm/t.wasm"); assert.strictEqual(r.type, "application/wasm"); assert.ok(/max-age/.test(r.cache));
  r = await call("GET", "/vendor/m.mjs"); assert.ok(/javascript/.test(r.type));
  fs.rmSync(path.join(__dirname, "public/vendor"), { recursive: true });
  r = await call("GET", "/engine.js"); assert.strictEqual(r.status, 200); assert.ok(/no-cache/.test(r.cache));
  assert.strictEqual((await call("GET", "/gate.html")).status, 404, "gate.html is only ever served as the sign-in screen");
  assert.strictEqual((await call("GET", "/..%2fserver.js")).status, 404);
  assert.strictEqual((await call("GET", "/api/nothing")).status, 404);
  console.log("All server tests passed"); server.close(); process.exit(0);
})().catch(e => { console.error("FAIL", e); process.exit(1); });
