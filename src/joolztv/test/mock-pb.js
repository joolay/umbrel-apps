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
const rec = u => ({ id: u.id, email: u.email, name: u.name, isAdmin: u.isAdmin, avatar: u.avatar || "", age: u.age == null ? undefined : u.age, kids: u.kids, hasParent: u.hasParent, portal: { access: u.access, app: { enabled: true } } });
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
