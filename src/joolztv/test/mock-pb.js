// Stand-in for pocketbase.js used only by test.js (NODE_ENV=test + JTV_PB). Same shape as the real module.
"use strict";
class PBError extends Error { constructor(status, message) { super(message); this.status = status; } }
const users = {};
function add(id, email, password, opts) { users[id] = Object.assign({ id, email, password, name: email.split("@")[0], isAdmin: false, access: true }, opts || {}); }
add("u1", "ann@x.com", "pw1", { name: "Ann" }); add("u2", "bob@x.com", "pw2", { name: "Bob" });
add("u3", "kid@x.com", "pw3", { access: false });
for (let i = 4; i < 20; i++) add("u" + i, "p" + i + "@x.com", "pw" + i);
let n = 0; const tokens = {};
const rec = u => ({ id: u.id, email: u.email, name: u.name, isAdmin: u.isAdmin, portal: { access: u.access, app: { enabled: true } } });
const mint = u => { const t = "tok." + u.id + "." + (++n); tokens[t] = u.id; return t; };
exports.enabled = true; exports.PBError = PBError;
exports.login = async (email, password) => {
  const u = Object.values(users).filter(x => x.email === email)[0];
  if (!u || u.password !== password) throw new PBError(400, "Failed to authenticate.");
  return { token: mint(u), record: rec(u) };
};
exports.verifyToken = async token => {
  const id = tokens[token]; if (!id) throw new PBError(401, "bad token");
  return { token: mint(users[id]), record: rec(users[id]) };
};
exports.requestPasswordReset = async () => {};
