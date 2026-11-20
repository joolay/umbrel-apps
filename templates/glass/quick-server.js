"use strict";
// Quick Access for an app's server: sign in with a PIN or pattern on a device that already signed in once. Portal Admin keeps and checks the code
// (Portal API qa.*); this file only forwards to it and gives the person this app's own session afterwards (the same way JoolzTV does).
// Copy this file into the app next to pocketbase.js, then:
//   const quick = require("./quick-server")({ pb, dataDir: DATA_DIR });
//   login:        if (body.quick) { const rec = await quick.login(body.quick); token = quick.mint(rec.id); ...same as a password sign-in... }
//   sessions:     const m = quick.parse(token)  ->  { id, iat } | null   (then load the user with pb.getUser(id) and call quick.stale(user, m))
//   management:   if (await quick.handle(req, res, p, user, body, send)) return;     (routes under /api/account/quick, signed-in people only)
const crypto = require("crypto"), fs = require("fs"), path = require("path");

module.exports = function makeQuickServer({ pb, dataDir }) {
  const FILE = path.join(path.resolve(dataDir), "secret.key"), TTL = 14 * 86400e3;
  const b64u = b => Buffer.from(b).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  const SECRET = (() => {
    try { const s = fs.readFileSync(FILE, "utf8").trim(); if (s.length >= 32) return s; } catch {}
    const s = crypto.randomBytes(32).toString("hex"); try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, s, { mode: 0o600 }); } catch {}
    return s;
  })();
  const mac = s => b64u(crypto.createHmac("sha256", SECRET).update(s).digest()).slice(0, 27);
  const mint = userId => { const body = "s." + b64u(userId) + "." + Date.now().toString(36); return body + "." + mac("sess:" + body); };
  function parse(token) {
    const p = String(token || "").split(".");
    if (p.length !== 4 || p[0] !== "s") return null;
    const body = p.slice(0, 3).join("."), good = mac("sess:" + body);
    if (p[3].length !== good.length || !crypto.timingSafeEqual(Buffer.from(p[3]), Buffer.from(good))) return null;
    const iat = parseInt(p[2], 36), id = Buffer.from(p[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString();
    return iat && iat + TTL > Date.now() && /^[\w-]{1,40}$/.test(id) ? { id, iat } : null;
  }
  // true when an admin (or the person) signed everyone out after this session began
  const stale = (user, m) => !!(user && user.portal && user.portal.signedOutAt && m.iat < user.portal.signedOutAt);

  // Portal Admin has 15 s to answer; a hung call is cut off with a clear message.
  async function call(fn, args) {
    if (!(pb.portalOn && pb.portalOn())) throw Object.assign(new Error("Quick Access needs this app to be linked to Portal Admin."), { status: 503 });
    let timer;
    try { return await Promise.race([pb.portalCall(fn, args), new Promise((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error("Portal Admin did not answer in 15 seconds. Try again."), { status: 504 })), 15000); })]); }
    finally { clearTimeout(timer); }
  }
  const fromPortal = e => (e && [400, 401, 423, 429, 503, 504].includes(e.status)) ? e : null;

  // quick = { deviceId, deviceSecret, code }  ->  the person's record. Errors carry status: 401 wrong code (left = tries left), 423 switched off, 429 slow down.
  async function login(q) {
    try {
      const r = await call("qa.login", [String(q.deviceId || ""), String(q.deviceSecret || ""), String(q.code || "")]);
      return await pb.getUser(r.userId);
    } catch (e) { throw fromPortal(e) || e; }
  }

  async function handle(req, res, p, user, body, send) {
    if (p !== "/api/account/quick" && !p.startsWith("/api/account/quick/")) return false;
    if (!user) { send(res, 401, { code: "signin_required", message: "Sign in to continue." }); return true; }
    try {
      if (p === "/api/account/quick/status" && req.method === "GET") {
        const available = !!(pb.portalOn && pb.portalOn()); let kind = null;
        if (available) { const r = await call("qa.status", [user.id]); kind = (r && r.kind) || null; }
        send(res, 200, { available, kind }); return true;
      }
      if (p === "/api/account/quick" && req.method === "GET") { send(res, 200, { devices: await call("qa.list", [user.id]) }); return true; }
      if (p === "/api/account/quick" && req.method === "POST") {
        const r = await call("qa.setup", [user.id, { kind: String(body.kind || ""), code: String(body.code || ""), label: String(body.label || "This device").slice(0, 40) }]);
        send(res, 201, r); return true;
      }
      const m = /^\/api\/account\/quick\/([\w-]{22})$/.exec(p);
      if (m && req.method === "DELETE") { await call("qa.remove", [user.id, m[1]]); send(res, 200, { ok: true }); return true; }
      send(res, 404, { code: "not_found" }); return true;
    } catch (e) {
      const s = fromPortal(e); if (!s) throw e;
      send(res, s.status, { code: "quick_error", message: s.message, left: s.left }); return true;
    }
  }
  return { mint, parse, stale, login, handle };
};
