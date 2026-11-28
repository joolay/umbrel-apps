// JAB tests: accounts, config cleaning and the HTTP flows of the dashboard and JAB Admin (temp data folder, no network).
"use strict";
const assert = require("assert"), fs = require("fs"), os = require("os"), path = require("path");
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "jab-"));
const dash = require("./server"), adm = require("./admin"), { accounts, store } = dash, cfg = require("./config");

const listen = (s) => new Promise((r) => s.listen(0, "127.0.0.1", () => r(s.address().port)));
const call = (port) => async (m, p, body, tok) => {
  const r = await fetch(`http://127.0.0.1:${port}/${p}`, { method: m, headers: { "content-type": "application/json", ...(tok ? { "x-gd-token": tok } : {}) }, body: body ? JSON.stringify(body) : undefined, redirect: "manual" });
  let j = {}; try { j = await r.clone().json(); } catch {} return { s: r.status, j, r };
};
const nap = () => new Promise((r) => setTimeout(r, 750));
let n = 0; const ok = (name, f) => f().then(() => { n++; }, (e) => { console.error("FAIL:", name, "\n", e.message); process.exit(1); });

(async () => {
  const D = call(await listen(dash.server)), A = call(await listen(adm.server));
  await ok("config cleaning", async () => {
    assert.strictEqual(cfg.cleanUrl("javascript:alert(1)"), "");
    assert.strictEqual(cfg.cleanUrl("https://a.b/c"), "https://a.b/c");
    const c = cfg.cleanConfig({ practice: { name: "<b>X</b>" }, apps: [{ id: "a", name: "A", url: "javascript:x", glyph: "nope" }] });
    assert.ok(!/[<>]/.test(c.practice.name)); assert.strictEqual(c.apps[0].url, "");
    assert.ok(cfg.GLYPHS.includes(c.apps[0].glyph));
  });
  await ok("first-run setup state", async () => { assert.strictEqual((await D("GET", "api/app-config")).j.setup, true); assert.strictEqual((await A("GET", "api/overview")).j.users.length, 0); });
  await ok("admin creates first admin + validation", async () => {
    assert.strictEqual((await A("POST", "api/users", { email: "bad", name: "x", role: "admin", password: "longenough1" })).s, 400);
    assert.strictEqual((await A("POST", "api/users", { email: "a@x.co", name: "Dr A", role: "admin", password: "short" })).s, 400);
    const r = await A("POST", "api/users", { email: "a@x.co", name: "Dr A", role: "admin", password: "longenough1" });
    assert.ok(r.s === 200 || r.s === 201); assert.strictEqual(r.j.users.length, 1);
    assert.ok(!JSON.stringify(r.j).includes("hash"), "no hashes leak");
    assert.strictEqual((await D("GET", "api/app-config")).j.setup, false);
  });
  await ok("sign-in, wrong password, no self-registration", async () => {
    assert.ok([400, 401, 403].includes((await D("POST", "api/account/login", { email: "a@x.co", password: "nope" })).s));
    assert.strictEqual((await D("POST", "api/account/register", {})).s, 410);
  });
  let tok, ed;
  await ok("login + me + dashboard config", async () => {
    const l = await D("POST", "api/account/login", { email: "a@x.co", password: "longenough1" }); assert.strictEqual(l.s, 200); tok = l.j.token; assert.ok(tok);
    const me = await D("GET", "api/account/me", null, tok); assert.strictEqual(me.s, 200);
    assert.strictEqual((await D("GET", "api/jab")).s, 401);
    const j = await D("GET", "api/jab", null, tok); assert.strictEqual(j.s, 200); assert.ok(j.j.config.apps.length >= 1);
  });
  await ok("roles: member sees no adminOnly apps and cannot edit", async () => {
    await A("POST", "api/users", { email: "m@x.co", name: "Mem", role: "member", password: "memberpass1" });
    const c = (await D("GET", "api/jab", null, tok)).j.config || (await D("GET", "api/jab", null, tok)).j;
    const body = { ...c, apps: [...c.apps, { id: "secret", name: "Secret", url: "/s", adminOnly: true }] };
    assert.strictEqual((await D("PUT", "api/jab", body, tok)).s, 200);
    ed = (await D("POST", "api/account/login", { email: "m@x.co", password: "memberpass1" })).j.token;
    const mj = (await D("GET", "api/jab", null, ed)).j, apps = (mj.config || mj).apps;
    assert.ok(!apps.some((a) => a.id === "secret"), "adminOnly hidden from members");
    assert.ok([401, 403].includes((await D("PUT", "api/jab", body, ed)).s), "member cannot save");
  });
  await ok("last admin cannot be removed, disabled or demoted", async () => {
    const id = (await A("GET", "api/overview")).j.users.find((u) => u.email === "a@x.co").id;
    assert.ok((await A("DELETE", "api/users/" + id)).s >= 400);
    assert.ok((await A("PATCH", "api/users/" + id, { disabled: true })).s >= 400);
    assert.ok((await A("PATCH", "api/users/" + id, { role: "member" })).s >= 400);
  });
  await ok("sign out everywhere kills old tokens; reset password works", async () => {
    const id = (await A("GET", "api/overview")).j.users.find((u) => u.email === "m@x.co").id;
    assert.strictEqual((await D("GET", "api/account/me", null, ed)).s, 200);
    await A("POST", `api/users/${id}/signout`);
    assert.strictEqual((await D("GET", "api/account/me", null, ed)).s, 401);
    assert.strictEqual((await A("POST", `api/users/${id}/password`, { password: "brandnew123" })).s, 200);
    assert.strictEqual((await D("POST", "api/account/login", { email: "m@x.co", password: "brandnew123" })).s, 200);
  });
  await ok("change own password", async () => {
    assert.ok((await D("POST", "api/account/password", { current: "wrong", password: "another123" }, tok)).s >= 400);
    assert.strictEqual((await D("POST", "api/account/password", { current: "longenough1", password: "another123" }, tok)).s, 200);
    assert.strictEqual((await D("POST", "api/account/login", { email: "a@x.co", password: "another123" })).s, 200);
  });
  await ok("quick access: set up, sign in, 5 wrong tries removes device", async () => {
    const t = (await D("POST", "api/account/login", { email: "a@x.co", password: "another123" })).j.token;
    const s = await D("POST", "api/account/quick", { kind: "pin4", code: "4821", label: "test" }, t); assert.strictEqual(s.s, 201, JSON.stringify(s.j));
    const dev = { id: s.j.deviceId, secret: s.j.deviceSecret }; assert.ok(dev.id && dev.secret, "device id+secret returned");
    await nap(); const q = await D("POST", "api/account/login", { quick: { deviceId: dev.id, deviceSecret: dev.secret, code: "4821" } }); assert.strictEqual(q.s, 200, JSON.stringify(q.j));
    let last; for (let i = 0; i < 5; i++) { await nap(); last = await D("POST", "api/account/login", { quick: { deviceId: dev.id, deviceSecret: dev.secret, code: "0000" } }); }
    assert.ok(last.s >= 400);
    await nap(); assert.ok((await D("POST", "api/account/login", { quick: { deviceId: dev.id, deviceSecret: dev.secret, code: "4821" } })).s >= 400, "device removed after 5 fails");
  });
  await ok("admin registers its URL for the Admin folder", async () => {
    assert.strictEqual((await A("POST", "api/register-url", { url: "http://umbrel.local:3930/" })).s, 200);
    const t2 = (await D("POST", "api/account/login", { email: "a@x.co", password: "another123" })).j.token; const me = (await D("GET", "api/jab", null, t2)).j; assert.ok(JSON.stringify(me).includes("3930"), JSON.stringify(me).slice(0, 200));
  });
  await ok("static pages and healthz", async () => {
    for (const p of ["healthz"]) { assert.strictEqual((await D("GET", p)).s, 200); assert.strictEqual((await A("GET", p)).s, 200); }
    assert.strictEqual((await A("GET", "")).s, 200); assert.strictEqual((await A("GET", "jz.js")).s, 200);
    assert.strictEqual((await D("GET", "../../etc/passwd")).s === 200, false);
  });
  console.log(`jab tests passed (${n} groups)`); process.exit(0);
})();
