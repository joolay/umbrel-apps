"use strict";
// Quick Access: a faster, less secure way back in with a 4 or 6 digit PIN or a pattern, on a device the person already signed in on.
// A device (a phone browser, a TV) that sets it up gets a random deviceId + deviceSecret. Only hashes are kept here, in a hidden `qa.<deviceId>` row of `portal_settings`
// (scope user, secret = true: PocketBase never shows it to a signed-in person). To sign in the device sends deviceId + deviceSecret + the code, so a guessed code alone is useless.
// 5 wrong codes in a row remove the device's Quick Access (the password is needed again). Signing a person out (admin, or themselves) removes all their devices and
// stamps `portal.signedOutAt`, which the Portal and every app compare with their own sign-in time.
//   setup(userId, {kind, code, label})  -> { deviceId, deviceSecret }
//   login(deviceId, deviceSecret, code) -> { userId, kind }            (apps mint their own session; the Portal asks session() for a PocketBase one)
//   session(userId)                     -> { token, record }          (PocketBase superuser impersonation, 14 days)
//   list(userId) / remove(userId, deviceId) / signOut(userId) / counts()
const crypto = require("crypto");
const pb = require("./pocketbase");
const SET = "/api/collections/portal_settings/records";
const q = encodeURIComponent, esc = (s) => String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
const KINDS = { pin4: /^\d{4}$/, pin6: /^\d{6}$/, pattern: /^p:(?!.*(\d).*\1)[0-8]{4,9}$/ };      // a pattern: 4 to 9 different dots
const MAX_DEVICES = 10, MAX_FAILS = 5, MIN_GAP_MS = 700, SESSION_SECONDS = 14 * 86400;
const fail = (status, message) => Object.assign(new Error(message), { status });
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest();
const scrypt = (code, salt) => crypto.scryptSync(String(code), salt, 32, { N: 16384, r: 8, p: 1 });
const eq = (a, b) => a.length === b.length && crypto.timingSafeEqual(a, b);
const cleanLabel = (s) => String(s || "").replace(/[\u0000-\u001f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, 40) || "This device";
const validId = (id) => typeof id === "string" && /^[A-Za-z0-9_-]{22}$/.test(id);

module.exports = function makeQuick({ now = Date.now } = {}) {
  const last = new Map();                                                 // deviceId -> time of the last try (one try per 700 ms)
  const rowOf = async (userId, deviceId) => ((await pb.asSuper("GET", `${SET}?page=1&perPage=1&filter=${q(`scope = 'user' && user = '${esc(userId)}' && app = '' && key = 'qa.${esc(deviceId)}'`)}`)).items || [])[0] || null;
  const rowByDevice = async (deviceId) => ((await pb.asSuper("GET", `${SET}?page=1&perPage=1&filter=${q(`scope = 'user' && app = '' && key = 'qa.${esc(deviceId)}'`)}`)).items || [])[0] || null;
  async function rowsOf(userId) {
    const out = []; for (let page = 1; page <= 5; page++) {
      const j = await pb.asSuper("GET", `${SET}?page=${page}&perPage=100&filter=${q(`scope = 'user' && user = '${esc(userId)}' && app = '' && key ~ 'qa.'`)}`);
      out.push(...(j.items || [])); if (page >= (j.totalPages || 1)) break;
    } return out;
  }
  const checkCode = (kind, code) => { if (!KINDS[kind]) throw fail(400, "Pick a 4 digit PIN, a 6 digit PIN or a pattern."); if (!KINDS[kind].test(String(code))) throw fail(400, kind === "pattern" ? "A pattern joins 4 to 9 different dots." : "That is not a " + (kind === "pin4" ? "4" : "6") + " digit PIN."); };

  async function setup(userId, o = {}) {
    if (!userId) throw fail(401, "Sign in to continue.");
    checkCode(o.kind, o.code);
    if ((await rowsOf(userId)).length >= MAX_DEVICES) throw fail(429, "You have Quick Access on " + MAX_DEVICES + " devices already. Remove one first.");
    const deviceId = crypto.randomBytes(16).toString("base64url"), deviceSecret = crypto.randomBytes(32).toString("base64url"), salt = crypto.randomBytes(16);
    await pb.asSuper("POST", SET, { scope: "user", user: userId, app: "", key: "qa." + deviceId, secret: true, value: {
      kind: o.kind, salt: salt.toString("base64"), codeHash: scrypt(o.code, salt).toString("base64"), secretHash: sha(deviceSecret).toString("base64"), label: cleanLabel(o.label), created: now(), lastUsed: 0, fails: 0 } });
    return { deviceId, deviceSecret };
  }
  async function login(deviceId, deviceSecret, code) {
    if (!validId(deviceId) || typeof deviceSecret !== "string" || deviceSecret.length > 100 || typeof code !== "string" || code.length > 20) throw fail(401, "Quick Access did not work. Sign in with your password.");
    const t = now(), prev = last.get(deviceId) || 0; if (t - prev < MIN_GAP_MS) throw fail(429, "Wait a moment before trying again."); last.set(deviceId, t); if (last.size > 5000) last.clear();
    const row = await rowByDevice(deviceId), v = row && row.value;
    const bad = () => fail(401, "Quick Access did not work. Sign in with your password.");
    if (!v || !eq(sha(deviceSecret), Buffer.from(v.secretHash, "base64"))) throw bad();            // wrong device or secret: no attempt is counted, nothing is revealed
    const good = KINDS[v.kind] && KINDS[v.kind].test(code) && eq(scrypt(code, Buffer.from(v.salt, "base64")), Buffer.from(v.codeHash, "base64"));
    if (!good) {
      const fails = (v.fails || 0) + 1;
      if (fails >= MAX_FAILS) { await pb.asSuper("DELETE", `${SET}/${row.id}`); throw fail(423, "Too many wrong tries. Quick Access was switched off on this device: sign in with your password."); }
      await pb.asSuper("PATCH", `${SET}/${row.id}`, { value: Object.assign({}, v, { fails }) });
      throw Object.assign(fail(401, "Wrong " + (v.kind === "pattern" ? "pattern" : "PIN") + ". " + (MAX_FAILS - fails) + (MAX_FAILS - fails === 1 ? " try" : " tries") + " left."), { left: MAX_FAILS - fails });
    }
    await pb.asSuper("PATCH", `${SET}/${row.id}`, { value: Object.assign({}, v, { fails: 0, lastUsed: t }) });
    return { userId: row.user, kind: v.kind };
  }
  async function session(userId) {
    try { const j = await pb.asSuper("POST", `/api/collections/users/impersonate/${encodeURIComponent(userId)}`, { duration: SESSION_SECONDS }); return { token: j.token, record: j.record }; }
    catch (e) { if (e.status === 404 || e.status === 405) throw fail(501, "Quick Access needs PocketBase 0.23 or newer on this Umbrel."); throw e; }
  }
  async function list(userId) { return (await rowsOf(userId)).map((r) => ({ id: r.key.slice(3), kind: r.value && r.value.kind, label: (r.value && r.value.label) || "", created: (r.value && r.value.created) || 0, lastUsed: (r.value && r.value.lastUsed) || 0 })).sort((a, b) => b.created - a.created); }
  async function remove(userId, deviceId) { if (!validId(deviceId)) throw fail(400, "Unknown device."); const r = await rowOf(userId, deviceId); if (!r) return { removed: 0 }; await pb.asSuper("DELETE", `${SET}/${r.id}`); return { removed: 1 }; }
  /* Ends every Quick Access device and marks the moment: sessions older than it are no longer valid. */
  async function signOut(userId) {
    if (!userId) throw fail(400, "Unknown person.");
    const rows = await rowsOf(userId); for (const r of rows) await pb.asSuper("DELETE", `${SET}/${r.id}`);
    const ex = ((await pb.asSuper("GET", `${SET}?page=1&perPage=1&filter=${q(`scope = 'user' && user = '${esc(userId)}' && app = '' && key = 'portal.signedOutAt'`)}`)).items || [])[0], at = now();
    if (ex) await pb.asSuper("PATCH", `${SET}/${ex.id}`, { value: at }); else await pb.asSuper("POST", SET, { scope: "user", user: userId, app: "", key: "portal.signedOutAt", value: at, secret: false });
    try { await pb.asSuper("PATCH", `/api/collections/users/records/${encodeURIComponent(userId)}`, { tokenKey: crypto.randomBytes(24).toString("hex") }); } catch { /* older PocketBase: the marker above still signs the apps out */ }
    return { signedOutAt: at, devices: rows.length };
  }
  /* for the admin Users list: userId -> { devices, signedOutAt } */
  async function overview() {
    const out = {}; for (let page = 1; page <= 50; page++) {
      const j = await pb.asSuper("GET", `${SET}?page=${page}&perPage=200&filter=${q("scope = 'user' && app = '' && (key ~ 'qa.' || key = 'portal.signedOutAt')")}`);
      for (const r of j.items || []) { const o = out[r.user] = out[r.user] || { devices: 0, signedOutAt: 0 }; if (r.key === "portal.signedOutAt") o.signedOutAt = Number(r.value) || 0; else o.devices++; }
      if (page >= (j.totalPages || 1)) break;
    } return out;
  }
  return { setup, login, session, list, remove, signOut, overview, KINDS };
};
