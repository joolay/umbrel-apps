// Quick Access: setup, sign-in with device secret + code, lockout after 5 wrong codes, per-device rows hidden from people, admin sign-out.
"use strict";
const http = require("http"), path = require("path"), fs = require("fs"), os = require("os");
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log("FAIL", m); } else console.log("ok  ", m); };
const rows = []; const dev = (id) => rows.filter(x => x.key === "qa." + id)[0], devs = () => rows.filter(x => /^qa\./.test(x.key) && x.key !== "qa.code"); let nextId = 1, impersonate = true; const patches = [];
const matchF = (f, r) => { const get = (k) => { const m = new RegExp(k + " = '([^']*)'").exec(f); return m ? m[1] : null; }; const u = get("user"), a = get("app"), k = get("key"), kk = /key ~ 'qa\.'/.test(f);
  if (u !== null && r.user !== u) return false; if (a !== null && r.app !== a) return false; if (k !== null && !(kk && /\|\|/.test(f)) && r.key !== k) return false;
  if (kk && !(r.key.startsWith("qa.") || (/portal\.signedOutAt/.test(f) && r.key === "portal.signedOutAt"))) return false; return r.scope === "user"; };
const pbStub = http.createServer((q, r) => {
  const u = new URL(q.url, "http://x"), chunks = []; q.on("data", d => chunks.push(d)); q.on("end", () => {
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null, J = (o, c) => { r.writeHead(c || 200, { "content-type": "application/json" }); r.end(JSON.stringify(o)); };
    if (/auth-with-password$/.test(u.pathname)) return J({ token: "su-token", record: { id: "su1" } });
    let m = /^\/api\/collections\/users\/impersonate\/(\w+)$/.exec(u.pathname); if (m) return impersonate ? J({ token: "pb-token-for-" + m[1], record: { id: m[1], email: m[1] + "@x.com", name: "N" } }) : J({}, 404);
    m = /^\/api\/collections\/users\/records\/(\w+)$/.exec(u.pathname); if (m && q.method === "PATCH") { patches.push(body); return J({ id: m[1] }); }
    if (u.pathname === "/api/collections/portal_settings/records") {
      if (q.method === "GET") { const f = u.searchParams.get("filter") || ""; return J({ items: rows.filter(x => matchF(f, x)), totalPages: 1 }); }
      if (q.method === "POST") { const rec = Object.assign({ id: "r" + nextId++ }, body); rows.push(rec); return J(rec); }
    }
    m = /^\/api\/collections\/portal_settings\/records\/(r\d+)$/.exec(u.pathname);
    if (m && q.method === "PATCH") { const x = rows.filter(y => y.id === m[1])[0]; Object.assign(x, body); return J(x); }
    if (m && q.method === "DELETE") { const i = rows.findIndex(y => y.id === m[1]); rows.splice(i, 1); return J({}, 204); }
    J({}, 404);
  });
});
const nap = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  await new Promise(r => pbStub.listen(0, r));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pa-")); fs.writeFileSync(path.join(tmp, "pocketbase.env"), "POCKETBASE_SUPERUSER_EMAIL=a@x.com\nPOCKETBASE_SUPERUSER_PASSWORD=pw-pw-pw-pw\n");
  process.env.PB_URL = "http://127.0.0.1:" + pbStub.address().port; process.env.DATA_DIR = tmp; process.env.UMBREL_APPS_DIR = tmp;
  let clock = 1e12; const Q = require("./quickaccess.js")({ now: () => clock }), gap = () => { clock += 1000; return nap(0); };
  const bad = async (p) => { try { await p; return null; } catch (e) { return e; } };
  let e = await bad(Q.setup("userAAAA1", { kind: "pin5", code: "12345" })); ok(e && e.status === 400, "only a 4 digit PIN, a 6 digit PIN or a pattern is accepted");
  e = await bad(Q.setup("userAAAA1", { kind: "pin4", code: "12a4" })); ok(e && e.status === 400, "a PIN must be digits");
  e = await bad(Q.setup("userAAAA1", { kind: "pattern", code: "p:012" })); ok(e && e.status === 400, "a pattern needs at least 4 dots");
  e = await bad(Q.setup("userAAAA1", { kind: "pattern", code: "p:01210" })); ok(e && e.status === 400, "a pattern cannot use a dot twice");
  const d = await Q.setup("userAAAA1", { kind: "pin4", code: "4821", label: "Ann's <phone>" });
  ok(d.deviceId.length === 22 && d.deviceSecret.length >= 40, "setup hands the device an id and a secret");
  ok(rows.length === 2 && dev(d.deviceId).secret === true && dev(d.deviceId).scope === "user" && dev(d.deviceId).user === "userAAAA1" && rows.some(x => x.key === "qa.code" && x.secret === true), "it is stored as hidden per-person rows: the one code and this device");
  const dump = JSON.stringify(rows); ok(!dump.includes("4821") && !dump.includes(d.deviceSecret), "neither the code nor the device secret is stored");
  ok(dev(d.deviceId).value.label === "Ann's phone", "the label is cleaned");
  let r = await Q.login(d.deviceId, d.deviceSecret, "4821"); ok(r.userId === "userAAAA1" && r.kind === "pin4", "the right device secret and code sign in");
  await gap(); e = await bad(Q.login(d.deviceId, "x".repeat(43), "4821")); ok(e && e.status === 401 && !/tries/.test(e.message), "a wrong device secret is refused and reveals nothing");
  await gap(); e = await bad(Q.login(d.deviceId, d.deviceSecret, "0000")); ok(e && e.status === 401 && e.left === 4, "a wrong PIN is refused and counted (4 left)");
  e = await bad(Q.login(d.deviceId, d.deviceSecret, "4821")); ok(e && e.status === 429, "tries are spaced out");
  await gap(); r = await Q.login(d.deviceId, d.deviceSecret, "4821"); ok(r.userId === "userAAAA1" && dev(d.deviceId).value.fails === 0, "a right code resets the counter");
  for (let i = 0; i < 4; i++) { await gap(); e = await bad(Q.login(d.deviceId, d.deviceSecret, "1111")); }
  await gap(); e = await bad(Q.login(d.deviceId, d.deviceSecret, "2222")); ok(e && e.status === 423 && devs().length === 0, "5 wrong codes in a row switch Quick Access off on that device");
  await gap(); e = await bad(Q.login(d.deviceId, d.deviceSecret, "4821")); ok(e && e.status === 401, "...and even the right code no longer works");
  // one code per person: a second device needs no new code, a changed code applies to every device
  const d2 = await Q.setup("userAAAA1", { label: "TV" }); ok(d2.kind === "pin4" && devs().length === 1 && (await Q.status("userAAAA1")).kind === "pin4", "a second device is turned on without choosing a code again");
  await gap(); ok((await Q.login(d2.deviceId, d2.deviceSecret, "4821")).userId === "userAAAA1", "...and signs in with the same code");
  e = await bad(Q.setup("userNEW0001", { label: "x" })); ok(e && e.status === 400, "turning it on needs a code to exist first");
  await Q.setup("userAAAA1", { kind: "pin4", code: "9999", label: "Phone" }); await gap(); ok((await Q.login(d2.deviceId, d2.deviceSecret, "9999")).userId === "userAAAA1" && devs().length === 2, "changing the digits changes it for every device");
  await Q.setup("userAAAA1", { kind: "pin6", code: "123456", label: "Phone" }); ok(devs().length === 1 && (await Q.status("userAAAA1")).kind === "pin6", "changing the kind switches the other devices off (they must be turned on again)");
  await gap(); e = await bad(Q.login(d2.deviceId, d2.deviceSecret, "9999")); ok(e && e.status === 401, "...the old code no longer works");
  // pattern + 6 digit
  const p = await Q.setup("userAAAA1", { kind: "pattern", code: "p:03678" }); await gap();
  r = await Q.login(p.deviceId, p.deviceSecret, "p:03678"); ok(r.kind === "pattern", "a pattern signs in");
  await gap(); e = await bad(Q.login(p.deviceId, p.deviceSecret, "p:03687")); ok(e && e.status === 401, "the dots must be in the same order");
  const s6 = await Q.setup("userBBBB2", { kind: "pin6", code: "135790", label: "TV" });
  ok((await Q.list("userAAAA1")).length === 1 && (await Q.list("userAAAA1"))[0].kind === "pattern" && !JSON.stringify(await Q.list("userAAAA1")).includes("Hash"), "a person lists only their own devices, without any hashes");
  e = await bad(Q.remove("userAAAA1", s6.deviceId)); ok(!e && (await Q.list("userBBBB2")).length === 1, "a person cannot remove someone else's device");
  for (let i = 0; i < 9; i++) await Q.setup("userCCCC3", { kind: "pin4", code: "1357" }); e = await bad(Q.setup("userCCCC3", { kind: "pin4", code: "1357" })); await Q.setup("userCCCC3", { kind: "pin4", code: "1357" }).catch(() => {}); ok(e === null, "up to 10 devices"); e = await bad(Q.setup("userCCCC3", { kind: "pin4", code: "1357" })); ok(e && e.status === 429, "the 11th is refused");
  // checking the code without a device (a parent approving something on a TV)
  ok((await Q.check("userAAAA1", "p:03678")).ok === true, "check: the right code is accepted");
  e = await bad(Q.check("userAAAA1", "p:03687")); ok(e && e.status === 401, "check: a wrong code is refused");
  for (let i = 0; i < 4; i++) e = await bad(Q.check("userAAAA1", "p:00000")); e = await bad(Q.check("userAAAA1", "p:00000")); ok(e && e.status === 429, "check: 5 wrong tries lock it for a while");
  e = await bad(Q.check("userAAAA1", "p:03678")); ok(e && e.status === 429, "check: even the right code waits out the lock");
  clock += 301e3; ok((await Q.check("userAAAA1", "p:03678")).ok === true, "check: works again after 5 minutes");
  e = await bad(Q.check("userNEW0001", "1234")); ok(e && e.status === 404, "check: an account with no code says so");
  const s = await Q.session("userAAAA1"); ok(s.token === "pb-token-for-userAAAA1" && s.record.id === "userAAAA1", "the Portal gets a PocketBase session for the person");
  impersonate = false; e = await bad(Q.session("userAAAA1")); ok(e && e.status === 501 && /0\.23/.test(e.message), "an old PocketBase gives a clear message"); impersonate = true;
  // admin sign-out
  clock += 5000; const out = await Q.signOut("userAAAA1"); ok(out.devices === 1 && out.signedOutAt === clock, "signing a person out removes their devices");
  ok((await Q.list("userAAAA1")).length === 0 && (await Q.list("userBBBB2")).length === 1, "...only theirs");
  const so = rows.filter(x => x.key === "portal.signedOutAt"); ok(so.length === 1 && so[0].value === clock && so[0].secret === false && so[0].user === "userAAAA1", "it stamps portal.signedOutAt (readable by the person's own apps, writable only by the superuser)");
  ok(patches.length === 1 && typeof patches[0].tokenKey === "string", "it also rotates the PocketBase token key so old PocketBase tokens stop working");
  clock += 5000; await Q.signOut("userAAAA1"); ok(rows.filter(x => x.key === "portal.signedOutAt").length === 1 && rows.filter(x => x.key === "portal.signedOutAt")[0].value === clock, "signing out again updates the one marker");
  const ov = await Q.overview(); ok(ov.userAAAA1 && ov.userAAAA1.signedOutAt === clock && ov.userBBBB2.devices === 1 && ov.userCCCC3.devices === 10, "the admin overview shows devices and the last sign-out");
  pbStub.close(); console.log(fails ? fails + " FAILED" : "ALL PASSED"); process.exit(fails ? 1 : 0);
})().catch(e => { console.log("ERROR", e.stack); process.exit(1); });
