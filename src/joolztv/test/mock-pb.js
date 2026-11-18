// Stand-in for pocketbase.js used only by test.js (NODE_ENV=test + JTV_PB). Same shape as the real module.
"use strict";
class PBError extends Error { constructor(status, message) { super(message); this.status = status; } }
const users = {};
function add(id, email, password, opts) { users[id] = Object.assign({ id, email, password, name: email.split("@")[0], isAdmin: false, access: true }, opts || {}); }
add("u1", "ann@x.com", "pw1", { name: "Ann", avatar: "ann_photo.png" }); add("u2", "bob@x.com", "pw2", { name: "Bob" });
add("u3", "kid@x.com", "pw3", { access: false });
for (let i = 4; i < 20; i++) add("u" + i, "p" + i + "@x.com", "pw" + i);
add("u20", "view@x.com", "pw20", { readonly: true });
add("u21", "admin@x.com", "pw21", { isAdmin: true });
users.u5.age = 9; users.u1.kids = ["u5"]; users.u1.isAdmin = false;
let n = 0; const tokens = {};
const rec = u => ({ id: u.id, email: u.email, name: u.name, isAdmin: u.isAdmin, avatar: u.avatar || "", age: u.age == null ? undefined : u.age, kids: u.kids, hasParent: u.hasParent, portal: { access: u.access, app: { enabled: true }, signedOutAt: (exports.__signedOut()[u.id]) || 0 } });
const mint = u => { const t = "tok." + u.id + "." + (++n); tokens[t] = u.id; return t; };
exports.collection = "users";
exports.superFetch = async p => (/\/u1\/ann_photo\.png/.test(p) ? new Response(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"), { headers: { "content-type": "image/png" } }) : new Response("no", { status: 404 }));
exports.enabled = true; exports.PBError = PBError;
exports.login = async (email, password) => {
  const u = Object.values(users).filter(x => x.email === email)[0];
  if (!u || u.password !== password) throw new PBError(400, "Failed to authenticate.");
  return { token: mint(u), record: rec(u) };
};
exports.verifyToken = async token => {
  const id = token === "legacy-ann" ? "u1" : tokens[token]; if (!id) throw new PBError(401, "bad token");
  return { token: mint(users[id]), record: rec(users[id]) };
};
exports.getUser = async id => { if (!users[id]) throw new PBError(404, "no such user"); const r = rec(users[id]); if (users[id].readonly) r.portal.readonly = true; return r; };
exports.requestPasswordReset = async () => {};
// App keys saved in "Portal Admin > App keys": test.js writes them to <DATA_DIR>/portal-secrets.json
const fs = require("fs"), path = require("path");
const secrets = () => { try { return JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR || ".", "portal-secrets.json"), "utf8")); } catch { return {}; } };
const flag = n => fs.existsSync(path.join(process.env.DATA_DIR || ".", n));
exports.portalOn = () => Object.keys(secrets()).length > 0 || flag("portal-qa.on") || process.env.JTV_QA === "1";
exports.__signedOut = () => { try { return JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR || ".", "signed-out.json"), "utf8")); } catch { return {}; } };
// Quick Access as Portal Admin does it (in memory): setup / login with a lockout after 5 wrong codes / list / remove
const qaDev = {};
// QR sign-in: the test writes <DATA_DIR>/qr-approve.json { "<id>": "<userId>" | "deny" } to play the phone that scans and approves.
const qrs = {}, approvals = () => { try { return JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR || ".", "qr-approve.json"), "utf8")); } catch { return {}; } };
exports.portalUrl = async () => "https://joolzapp.test";
exports.portalCall = async (fn, a) => {
  if (fn === "appSecret") return secrets()[a[0]] || "";
  if (fn === "qr.start") { const id = require("crypto").randomBytes(16).toString("base64url"), secret = "s" + id; qrs[id] = secret; return { id, secret, expiresIn: 120 }; }
  if (fn === "qr.poll") { const [id, secret] = a; if (qrs[id] !== secret) return { status: "expired" }; const v = approvals()[id]; if (!v) return { status: "pending" }; delete qrs[id]; return v === "deny" ? { status: "denied" } : { status: "approved", userId: v }; }
  if (fn === "qa.setup") { const [uid, o] = a; if (!/^(\d{4}|\d{6}|p:[0-8]{4,9})$/.test(o.code)) throw new PBError(400, "That is not a valid PIN or pattern."); const id = require("crypto").randomBytes(16).toString("base64url"), secret = require("crypto").randomBytes(32).toString("base64url"); qaDev[id] = { uid, secret, code: o.code, kind: o.kind, label: o.label, fails: 0 }; return { deviceId: id, deviceSecret: secret }; }
  if (fn === "qa.login") { const [id, secret, code] = a, d = qaDev[id]; if (!d || d.secret !== secret) throw new PBError(401, "Quick Access did not work. Sign in with your password."); if (d.code !== code) { d.fails++; if (d.fails >= 5) { delete qaDev[id]; throw new PBError(423, "Too many wrong tries. Quick Access was switched off on this device: sign in with your password."); } throw new PBError(401, "Wrong PIN. " + (5 - d.fails) + " tries left."); } d.fails = 0; return { userId: d.uid, kind: d.kind }; }
  if (fn === "qa.list") return Object.keys(qaDev).filter(k => qaDev[k].uid === a[0]).map(k => ({ id: k, kind: qaDev[k].kind, label: qaDev[k].label }));
  if (fn === "qa.remove") { if (qaDev[a[1]] && qaDev[a[1]].uid === a[0]) delete qaDev[a[1]]; return { removed: 1 }; }
  throw new PBError(404, "no " + fn);
};
