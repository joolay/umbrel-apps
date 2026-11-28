"use strict";
// JAB's own people. JoolzApp Biz is a separate network from the family JoolzApp accounts: its people, passwords, roles, preferences and Quick Access
// codes live here, in <data>/users.json, and nothing is shared with PocketBase or the JoolzApp Dashboard (only the look comes from the shared Glass template).
// The JAB dashboard (server.js) and JAB Admin (admin.js) run from the same image and mount the same data folder, so both use this one file:
// every change re-reads it under a small lock and writes it back whole (temp file + rename), so the two programs never overwrite each other.
// Roles, highest first: admin > editor > member > viewonly (the same hierarchy as the rest of the JoolzApp family, but JAB's own people).
const fs = require("fs"), path = require("path"), crypto = require("crypto");

const ROLES = ["admin", "editor", "member", "viewonly"];
const KINDS = { pin4: /^\d{4}$/, pin6: /^\d{6}$/, pattern: /^p:(?!.*(\d).*\1)[0-8]{4,9}$/ };      // a pattern joins 4 to 9 different dots
const TTL = 90 * 86400e3;                                                                          // signed in until 90 days after last use (cookie is renewed as you use the app)
const MAX_DEVICES = 10, MAX_FAILS = 5, MIN_GAP_MS = 700;
const fail = (status, message, extra) => Object.assign(new Error(message), { status }, extra || {});
const b64u = b => Buffer.from(b).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
const sha = s => crypto.createHash("sha256").update(String(s)).digest();
const scrypt = (s, salt) => crypto.scryptSync(String(s), salt, 32, { N: 16384, r: 8, p: 1 });
const eq = (a, b) => a.length === b.length && crypto.timingSafeEqual(a, b);
const clean = (s, n) => String(s == null ? "" : s).replace(/[\u0000-\u001f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
const validEmail = e => typeof e === "string" && e.length <= 200 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const sleep = ms => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { const t = Date.now() + ms; while (Date.now() < t); } };

module.exports = function makeAccounts({ dataDir, now = Date.now }) {
  const DIR = path.resolve(dataDir), USERS = path.join(DIR, "users.json"), SECRET_FILE = path.join(DIR, "secret.key"), LOCK = path.join(DIR, ".users.lock");
  fs.mkdirSync(DIR, { recursive: true });
  const SECRET = (() => {
    try { const s = fs.readFileSync(SECRET_FILE, "utf8").trim(); if (s.length >= 32) return s; } catch {}
    const s = crypto.randomBytes(32).toString("hex");
    try { fs.writeFileSync(SECRET_FILE, s, { mode: 0o600, flag: "wx" }); return s; } catch { try { return fs.readFileSync(SECRET_FILE, "utf8").trim(); } catch { return s; } }   // the other program may have made it a moment ago
  })();
  const mac = s => b64u(crypto.createHmac("sha256", SECRET).update(s).digest()).slice(0, 27);

  /* ---------- the file: read when it changed, changed under a lock ---------- */
  let cache = null, sig = "";
  function read() {
    try {
      const st = fs.statSync(USERS), s = st.mtimeMs + ":" + st.size;
      if (!cache || s !== sig) { cache = JSON.parse(fs.readFileSync(USERS, "utf8")); sig = s; }
    } catch (e) { if (e.code !== "ENOENT") throw e; cache = { v: 1, users: [] }; sig = ""; }
    if (!Array.isArray(cache.users)) cache.users = [];
    return cache;
  }
  function mutate(fn) {
    let got = false;
    for (let i = 0; i < 150 && !got; i++) {
      try { fs.mkdirSync(LOCK); got = true; }
      catch (e) { if (e.code !== "EEXIST") throw e; try { if (Date.now() - fs.statSync(LOCK).mtimeMs > 10000) fs.rmdirSync(LOCK); } catch {} sleep(20); }
    }
    if (!got) throw fail(503, "The people list is busy. Try again.");
    try {
      cache = null; const d = read(), out = fn(d);
      const tmp = USERS + "." + process.pid + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(d, null, 1), { mode: 0o600 }); fs.renameSync(tmp, USERS); cache = null;
      return out;
    } finally { cache = null; try { fs.rmdirSync(LOCK); } catch {} }
  }
  const byId = (d, id) => d.users.find(u => u.id === id) || null;
  const activeAdmins = (d, exceptId) => d.users.filter(u => u.role === "admin" && !u.disabled && u.id !== exceptId).length;

  /* ---------- what the outside may see ---------- */
  const safe = u => ({ id: u.id, email: u.email, name: u.name, role: u.role, disabled: !!u.disabled, createdAt: u.createdAt || 0, lastActive: u.lastActive || 0, quick: !!(u.qa && u.qa.kind), devices: u.qa && u.qa.devices ? Object.keys(u.qa.devices).length : 0 });
  const publicUser = u => ({ id: u.id, email: u.email, name: u.name, role: u.role, isAdmin: u.role === "admin", canOpen: !u.disabled, gate: { ok: !u.disabled }, prefs: u.prefs || {} });
  const list = () => read().users.map(safe).sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email));
  const get = id => { const u = byId(read(), id); return u ? { ...u } : null; };
  const count = () => read().users.length;

  /* ---------- people ---------- */
  function newPassword(p) { p = String(p || ""); if (p.length < 8) throw fail(400, "A password needs at least 8 characters."); if (p.length > 200) throw fail(400, "That password is too long."); const salt = crypto.randomBytes(16); return { salt: salt.toString("base64"), hash: scrypt(p, salt).toString("base64") }; }
  function create({ email, name, role, password }) {
    email = String(email || "").trim().toLowerCase();
    if (!validEmail(email)) throw fail(400, "Enter a valid email address.");
    if (!ROLES.includes(role)) throw fail(400, "Pick a role.");
    const pw = newPassword(password);
    return mutate(d => {
      if (d.users.some(u => u.email === email)) throw fail(409, "Someone with that email is already on the team.");
      const u = { id: crypto.randomBytes(9).toString("base64url"), email, name: clean(name, 60), role, salt: pw.salt, hash: pw.hash, disabled: false, createdAt: now(), lastActive: 0, signedOutAt: 0, prefs: {}, qa: null };
      d.users.push(u); return safe(u);
    });
  }
  function update(id, o) {
    return mutate(d => {
      const u = byId(d, id); if (!u) throw fail(404, "That person is not on the team any more.");
      if ("email" in o) { const e = String(o.email || "").trim().toLowerCase(); if (!validEmail(e)) throw fail(400, "Enter a valid email address."); if (d.users.some(x => x.email === e && x.id !== id)) throw fail(409, "Someone with that email is already on the team."); u.email = e; }
      if ("name" in o) u.name = clean(o.name, 60);
      if ("role" in o) { if (!ROLES.includes(o.role)) throw fail(400, "Pick a role."); u.role = o.role; }
      if ("disabled" in o) u.disabled = !!o.disabled;
      if ((u.role !== "admin" || u.disabled) && activeAdmins(d, id) === 0) throw fail(400, "JAB needs at least one active admin.");
      if (u.disabled) { u.signedOutAt = now(); u.qa = null; }
      return safe(u);
    });
  }
  function remove(id) {
    return mutate(d => {
      const u = byId(d, id); if (!u) return { removed: 0 };
      if (u.role === "admin" && !u.disabled && activeAdmins(d, id) === 0) throw fail(400, "JAB needs at least one active admin.");
      d.users = d.users.filter(x => x.id !== id); return { removed: 1 };
    });
  }
  // The admin sets a new password: the person is signed out everywhere and their Quick Access is forgotten.
  function resetPassword(id, password) {
    const pw = newPassword(password);
    return mutate(d => { const u = byId(d, id); if (!u) throw fail(404, "That person is not on the team any more."); Object.assign(u, pw, { signedOutAt: now(), qa: null }); return { ok: true }; });
  }
  function changeOwnPassword(id, current, password) {
    const u = byId(read(), id); if (!u || !checkPassword(u, current)) throw fail(400, "Your current password is not right.");
    const pw = newPassword(password);
    return mutate(d => { const x = byId(d, id); Object.assign(x, pw, { signedOutAt: now(), qa: null }); return { ok: true }; });
  }
  function signOutEverywhere(id) {
    return mutate(d => { const u = byId(d, id); if (!u) throw fail(404, "That person is not on the team any more."); u.signedOutAt = now(); u.qa = null; return { ok: true }; });
  }
  function setPrefs(id, prefs) { return mutate(d => { const u = byId(d, id); if (u) u.prefs = prefs; return prefs; }); }
  function touch(id) {
    const u = byId(read(), id); if (!u || now() - (u.lastActive || 0) < 3600e3) return;
    try { mutate(d => { const x = byId(d, id); if (x) x.lastActive = now(); }); } catch { /* never slow or break the app */ }
  }

  /* ---------- sign-in ---------- */
  const checkPassword = (u, p) => !!(u && u.hash && typeof p === "string" && p.length <= 200 && eq(scrypt(p, Buffer.from(u.salt, "base64")), Buffer.from(u.hash, "base64")));
  const DUMMY = { salt: crypto.randomBytes(16).toString("base64") };
  function login(email, password) {
    const u = read().users.find(x => x.email === String(email || "").trim().toLowerCase());
    if (!u) { checkPassword({ ...DUMMY, hash: DUMMY.salt }, String(password || "")); throw fail(400, "That email and password don't match."); }   // same work either way
    if (!checkPassword(u, password)) throw fail(400, "That email and password don't match.");
    if (u.disabled) throw fail(403, "This account is switched off. Ask the practice admin.");
    return { ...u };
  }
  const mint = id => { const body = "s." + b64u(id) + "." + now().toString(36); return body + "." + mac("sess:" + body); };
  function verify(token) {                       // -> { user, iat } | null
    const p = String(token || "").split(".");
    if (p.length !== 4 || p[0] !== "s") return null;
    const body = p.slice(0, 3).join("."), good = mac("sess:" + body);
    if (p[3].length !== good.length || !crypto.timingSafeEqual(Buffer.from(p[3]), Buffer.from(good))) return null;
    const iat = parseInt(p[2], 36), id = Buffer.from(p[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString();
    if (!iat || iat + TTL < now() || !/^[\w-]{1,40}$/.test(id)) return null;
    const u = byId(read(), id);
    if (!u || u.disabled || iat < (u.signedOutAt || 0)) return null;
    return { user: { ...u }, iat };
  }

  /* ---------- Quick Access (PIN or pattern on a device that already signed in) ---------- */
  const last = new Map();
  const validDevice = id => typeof id === "string" && /^[A-Za-z0-9_-]{22}$/.test(id);
  function checkCode(kind, code) {
    if (!KINDS[kind]) throw fail(400, "Pick a 4 digit PIN, a 6 digit PIN or a pattern.");
    if (!KINDS[kind].test(String(code))) throw fail(400, kind === "pattern" ? "A pattern joins 4 to 9 different dots." : "A " + (kind === "pin4" ? "4" : "6") + " digit PIN is digits only.");
  }
  const qStatus = u => ({ available: true, kind: u.qa && u.qa.kind || null });
  function qSetup(userId, o = {}) {
    return mutate(d => {
      const u = byId(d, userId); if (!u) throw fail(401, "Sign in to continue.");
      if (o.code) {
        checkCode(o.kind, o.code);
        const salt = crypto.randomBytes(16), devices = u.qa && u.qa.kind === o.kind ? u.qa.devices || {} : {};   // a different kind means every device starts again
        u.qa = { kind: o.kind, salt: salt.toString("base64"), codeHash: scrypt(o.code, salt).toString("base64"), changed: now(), devices };
      } else if (!u.qa) throw fail(400, "Choose a PIN or pattern first.");
      if (Object.keys(u.qa.devices).length >= MAX_DEVICES) throw fail(429, "You have Quick Access on " + MAX_DEVICES + " devices already. Remove one first.");
      const deviceId = crypto.randomBytes(16).toString("base64url"), deviceSecret = crypto.randomBytes(32).toString("base64url");
      u.qa.devices[deviceId] = { secretHash: sha(deviceSecret).toString("base64"), label: clean(o.label, 40) || "This device", created: now(), lastUsed: 0, fails: 0 };
      return { deviceId, deviceSecret, kind: u.qa.kind };
    });
  }
  function qLogin(q) {
    q = q || {}; const bad = () => fail(401, "Quick Access did not work. Sign in with your password.");
    if (!validDevice(q.deviceId) || typeof q.deviceSecret !== "string" || q.deviceSecret.length > 100 || typeof q.code !== "string" || q.code.length > 20) throw bad();
    const t = now(); if (t - (last.get(q.deviceId) || 0) < MIN_GAP_MS) throw fail(429, "Wait a moment before trying again."); last.set(q.deviceId, t); if (last.size > 5000) last.clear();
    const u = read().users.find(x => x.qa && x.qa.devices && x.qa.devices[q.deviceId]);
    if (!u || u.disabled) throw bad();
    const dev = u.qa.devices[q.deviceId];
    if (!eq(sha(q.deviceSecret), Buffer.from(dev.secretHash, "base64"))) throw bad();      // wrong secret: no attempt is counted, nothing is revealed
    const good = KINDS[u.qa.kind].test(q.code) && eq(scrypt(q.code, Buffer.from(u.qa.salt, "base64")), Buffer.from(u.qa.codeHash, "base64"));
    const r = mutate(d => {                       // a wrong try must be saved, so errors are returned out of the change and thrown after it
      const x = byId(d, u.id), v = x && x.qa && x.qa.devices[q.deviceId]; if (!v) return { err: bad() };
      if (!good) {
        v.fails = (v.fails || 0) + 1;
        if (v.fails >= MAX_FAILS) { delete x.qa.devices[q.deviceId]; return { err: fail(423, "Too many wrong tries. Quick Access was switched off on this device: sign in with your password.") }; }
        return { err: fail(401, "Wrong " + (x.qa.kind === "pattern" ? "pattern" : "PIN") + ". " + (MAX_FAILS - v.fails) + (MAX_FAILS - v.fails === 1 ? " try" : " tries") + " left.", { left: MAX_FAILS - v.fails }) };
      }
      v.fails = 0; v.lastUsed = t; return { user: { ...x } };
    });
    if (r.err) throw r.err;
    return r.user;
  }
  const qList = u => Object.entries(u.qa && u.qa.devices || {}).map(([id, v]) => ({ id, kind: u.qa.kind, label: v.label, created: v.created, lastUsed: v.lastUsed }));
  function qRemove(userId, deviceId) {
    if (!validDevice(deviceId)) throw fail(400, "Unknown device.");
    return mutate(d => { const u = byId(d, userId); if (u && u.qa && u.qa.devices[deviceId]) { delete u.qa.devices[deviceId]; return { removed: 1 }; } return { removed: 0 }; });
  }
  return { ROLES, list, get, count, create, update, remove, resetPassword, changeOwnPassword, signOutEverywhere, setPrefs, touch, login, mint, verify, publicUser, safe, validEmail, TTL,
    qStatus, qSetup, qLogin, qList, qRemove };
};
module.exports.ROLES = ROLES;
