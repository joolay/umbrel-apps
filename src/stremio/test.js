// Tests for the Stremio soft-sync layer: fake Stremio upstream + fake PocketBase (no network, no deps).  Run: node test.js
"use strict";
const http = require("http");
const path = require("path");
const fs = require("fs");
const assert = require("assert");
const zlib = require("zlib");
const vm = require("vm");

/* ---- fake PocketBase, injected in place of ./pocketbase ---- */
class PBError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fake = { enabled: true, hang: false, users: { u1: { id: "u1", email: "z@x.co", password: "pw", name: "Zahir" } }, saved: {}, puts: 0 };
const pbStub = {
  PBError,
  reload: () => fake.enabled,
  login: async (email, password) => { const u = Object.values(fake.users).find(x => x.email === email && x.password === password); if (!u) throw new PBError(400, "bad"); return { token: "tok-" + u.id, record: { id: u.id, email: u.email, name: u.name } }; },
  verifyToken: async token => { if (fake.hang) return new Promise(() => {}); const u = fake.users[String(token).replace("tok-", "")]; if (!u) throw new PBError(401, "no"); return { record: { id: u.id, email: u.email, name: u.name } }; },
  getAppPref: async id => fake.saved[id] || null,
  setAppPref: async (id, v) => { fake.puts++; fake.saved[id] = v; },
  clearAppPref: async id => { delete fake.saved[id]; },
};
const pbPath = require.resolve("./pocketbase");
require.cache[pbPath] = { id: pbPath, filename: pbPath, loaded: true, exports: pbStub };

/* ---- fake Stremio upstream ---- */
const HTML = "<!doctype html><html><head><title>Stremio</title></head><body><div id=app></div><script src=/main.js></script></body></html>";
const JS = "console.log('stremio '.repeat(500))";
let upstreamUp = true;
const upstream = http.createServer((req, res) => {
  if (req.url === "/") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(HTML); }
  if (req.url === "/main.js") { const z = zlib.gzipSync(JS); res.writeHead(200, { "content-type": "application/javascript", "content-encoding": "gzip" }); return res.end(z); }
  res.writeHead(404); res.end("nope");
});

const get = (port, p, headers = {}) => new Promise((resolve, reject) => {
  const t0 = Date.now();
  http.get({ host: "127.0.0.1", port, path: p, headers }, r => { const c = []; r.on("data", d => c.push(d)); r.on("end", () => resolve({ status: r.statusCode, headers: r.headers, body: Buffer.concat(c), ms: Date.now() - t0 })); }).on("error", reject);
});
const send = (port, method, p, obj, headers = {}) => new Promise((resolve, reject) => {
  const data = JSON.stringify(obj || {});
  const rq = http.request({ host: "127.0.0.1", port, path: p, method, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data), ...headers } }, r => { const c = []; r.on("data", d => c.push(d)); r.on("end", () => { let j = {}; try { j = JSON.parse(Buffer.concat(c)); } catch {} resolve({ status: r.statusCode, headers: r.headers, j }); }); });
  rq.on("error", reject); rq.end(data);
});
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---- run sync.js against a fake browser that talks to the real test server ---- */
function browser(port, { cookie = "", profile = null, seen = false } = {}) {
  const store = {}; if (profile) store.profile = JSON.stringify(profile); if (seen) store.jz_seen_auth = "1";
  const session = {}; const state = { reloaded: 0, listeners: {}, cookie, toasts: [] };
  const stub = () => new Proxy(function () {}, { get: (t, k) => k === Symbol.toPrimitive ? () => "" : k === "length" ? 0 : stub(), set: () => true, apply: () => stub() });
  const doc = { body: stub(), readyState: "complete", visibilityState: "visible", createElement: () => stub(), addEventListener: (e, f) => { state.listeners[e] = f; } };
  const sandbox = {
    window: {}, document: doc, console, setTimeout, setInterval, clearInterval, clearTimeout, AbortController, JSON, Date, Promise,
    localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
    sessionStorage: { getItem: k => (k in session ? session[k] : null), setItem: (k, v) => { session[k] = String(v); }, removeItem: k => { delete session[k]; } },
    location: { reload: () => { state.reloaded++; } },
    fetch: async (u, o = {}) => {
      const r = await fetch("http://127.0.0.1:" + port + u, { ...o, headers: { ...(o.headers || {}), ...(state.cookie ? { cookie: state.cookie } : {}) } });
      const sc = r.headers.get("set-cookie"); if (sc) state.cookie = sc.split(";")[0];
      return r;
    },
  };
  sandbox.window = sandbox; vm.createContext(sandbox);
  return { store, session, state, run: () => vm.runInContext(fs.readFileSync(path.join(__dirname, "sync.js"), "utf8"), sandbox) };
}

(async () => {
  await new Promise(r => upstream.listen(0, "127.0.0.1", r));
  process.env.UPSTREAM = "http://127.0.0.1:" + upstream.address().port;
  const { server, inject } = require("./server");
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  let n = 0; const ok = m => console.log("ok " + ++n + " - " + m);

  // 1. proxy: HTML gets the script, content-length is right, assets are untouched (still gzip)
  let r = await get(port, "/", { accept: "text/html" });
  assert.strictEqual(r.status, 200); assert(r.body.toString().includes('<script src="/_jz/sync.js" defer></script></body>'));
  assert.strictEqual(+r.headers["content-length"], r.body.length); ok("HTML gets the sync script, content-length matches");
  r = await get(port, "/main.js", { accept: "*/*", "accept-encoding": "gzip" });
  assert.strictEqual(r.headers["content-encoding"], "gzip"); assert.strictEqual(zlib.gunzipSync(r.body).toString(), JS); ok("assets pass through untouched (gzip kept)");
  assert.strictEqual(inject(inject(HTML)).split("sync.js").length, 2); ok("inject is idempotent");
  r = await get(port, "/missing"); assert.strictEqual(r.status, 404); ok("upstream 404 passes through");

  // 2. fail-open: sync off (no pocketbase.env) never blocks Stremio
  fake.enabled = false;
  r = await get(port, "/", { accept: "text/html" }); assert.strictEqual(r.status, 200); assert(r.body.toString().includes("sync.js"));
  r = await get(port, "/_jz/state"); assert.deepStrictEqual(JSON.parse(r.body), { enabled: false }); ok("no PocketBase config: Stremio still loads, sync reports off, no exit");
  fake.enabled = true;

  // 3. fail-open: PocketBase hanging must not slow Stremio and /_jz answers within the timeout
  fake.hang = true;
  r = await get(port, "/", { accept: "text/html" }); assert(r.status === 200 && r.ms < 500, "proxy slow: " + r.ms);
  r = await get(port, "/_jz/state", { cookie: "jz_token=tok-u1" }); const j = JSON.parse(r.body);
  assert(r.ms < 4500, "state slow: " + r.ms); assert.deepStrictEqual(j, { enabled: true, store: false }); ok("PocketBase hanging: Stremio instant (" + "<500ms), /_jz/state gives up after " + r.ms + "ms");
  fake.hang = false;

  // 4. upstream down: clean 502, server keeps running
  const saveUp = process.env.UPSTREAM; upstream.close(); await sleep(50);
  r = await get(port, "/", { accept: "text/html" }); assert.strictEqual(r.status, 502); ok("Stremio container down: clear 502, no crash");
  await new Promise(res => upstream.listen(+new URL(saveUp).port, "127.0.0.1", res));

  // 5. API flow
  r = await send(port, "POST", "/_jz/login", { email: "z@x.co", password: "nope" }); assert.strictEqual(r.status, 400);
  r = await send(port, "POST", "/_jz/login", { email: "z@x.co", password: "pw" }); assert.strictEqual(r.status, 200); const cookie = r.headers["set-cookie"][0].split(";")[0];
  r = await send(port, "PUT", "/_jz/auth", { auth: { key: "short" } }, { cookie }); assert.strictEqual(r.status, 400);
  r = await send(port, "PUT", "/_jz/auth", { auth: { key: "AUTHKEY-1234567890", user: { email: "s@x.co" } } }, { cookie }); assert.strictEqual(r.status, 200);
  r = await send(port, "PUT", "/_jz/auth", { auth: { key: "x".repeat(300) } }, { cookie }); assert.strictEqual(r.status, 400);
  r = await send(port, "GET", "/_jz/auth", null, { cookie }); assert.strictEqual(r.j.auth.key, "AUTHKEY-1234567890");
  r = await send(port, "GET", "/_jz/auth", null); assert.strictEqual(r.status, 401); ok("login, save, validate and read back the auth key; anonymous refused");
  await send(port, "PUT", "/_jz/auth", { auth: null }, { cookie }); assert.strictEqual(fake.saved.u1, undefined); ok("auth:null deletes the saved login");

  // 6. client script
  fake.saved = {}; fake.puts = 0;
  // 6a. signed-in browser with a Stremio login: saves it
  const A = browser(port, { cookie, profile: { auth: { key: "AUTHKEY-1234567890", user: { email: "s@x.co" } }, settings: {} } }); A.run(); await sleep(400);
  assert.strictEqual(fake.saved.u1.auth.key, "AUTHKEY-1234567890"); assert.strictEqual(A.store.jz_seen_auth, "1"); ok("client saves the Stremio login to the account");
  const before = fake.puts; await sleep(150); assert.strictEqual(fake.puts, before); ok("unchanged login is not re-saved");
  // 6b. fresh browser (storage cleared): restores once Stremio makes its blank profile
  const B = browser(port, { cookie }); B.run(); await sleep(700);
  assert.strictEqual(B.state.reloaded, 0); B.store.profile = JSON.stringify({ auth: null, addons: [], settings: { x: 1 } });   // Stremio creates a blank profile
  await sleep(1300);
  const p = JSON.parse(B.store.profile); assert.strictEqual(p.auth.key, "AUTHKEY-1234567890"); assert.strictEqual(p.settings.x, 1); assert.strictEqual(B.state.reloaded, 1); ok("cleared browser: login restored into Stremio's blank profile (settings kept), one reload");
  // 6c. explicit sign-out in Stremio forgets the saved copy
  // (a fresh page load after signing out: the browser has SEEN set but the profile has no auth)
  const C = browser(port, { cookie, seen: true, profile: { auth: null, settings: {} } }); C.run(); await sleep(400);
  assert.strictEqual(fake.saved.u1, undefined); assert.strictEqual(C.store.jz_seen_auth, undefined); assert.strictEqual(C.state.reloaded, 0); ok("signing out of Stremio deletes the saved login and does not restore it");
  // 6d. a browser that never had a login and nothing saved: no reload, no writes
  const D = browser(port, { cookie, profile: { auth: null, settings: {} } }); D.run(); await sleep(900); assert.strictEqual(D.state.reloaded, 0); ok("nothing saved: nothing restored, no reload loop");
  // 6e. not signed in to JoolzApp: no API writes
  fake.puts = 0; const E = browser(port, { profile: { auth: { key: "AUTHKEY-ABCDEFGHIJ" }, settings: {} } }); E.run(); await sleep(400); assert.strictEqual(fake.puts, 0); ok("not signed in to JoolzApp: nothing is sent");
  // 6f. restore loop guard
  fake.saved.u1 = { auth: { key: "AUTHKEY-1234567890", user: null } };
  const F = browser(port, { cookie }); F.session.jz_restore_tried = "1"; F.run(); await sleep(300); F.store.profile = JSON.stringify({ auth: null }); await sleep(1200); assert.strictEqual(F.state.reloaded, 0); ok("restore runs at most once per tab session");

  console.log("\nall " + n + " checks passed"); process.exit(0);
})().catch(e => { console.error("FAIL:", e); process.exit(1); });
