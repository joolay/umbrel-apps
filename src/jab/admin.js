// JAB Admin: where the practice's JoolzApp Biz people, roles and settings are managed. Zero-dependency Node server, same image and same data folder as
// the JAB dashboard (server.js), run with `node admin.js`. It is JAB's own admin, separate from the family Portal Admin: it knows nothing about JoolzApp
// accounts or PocketBase. It is protected by Umbrel's own login (like Portal Admin), so it has no sign-in page of its own.
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, "data"));
const accounts = require("./accounts")({ dataDir: DATA_DIR });
const store = require("./config")(DATA_DIR);

const PORT = +process.env.PORT || 3929;
const PUBLIC_DIR = path.join(__dirname, "public-admin"), SHARED_DIR = path.join(__dirname, "public");
const SHARED = new Set(["jz.js"]);       // the one template file lives with the dashboard; the build script keeps it current
const VERSION = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8")).version; } catch { return ""; } })();
const MAX_BODY = 64 * 1024;
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".webmanifest": "application/manifest+json" };

const send = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(obj)); };
function readBody(req) {
  return new Promise((ok, bad) => {
    const chunks = []; let size = 0;
    req.on("data", c => { size += c.length; if (size > MAX_BODY) { bad(Object.assign(new Error("Too large"), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on("end", () => ok(Buffer.concat(chunks))); req.on("error", bad);
  });
}
const overview = () => { const users = accounts.list(), cfg = store.load(); return { users, roles: accounts.ROLES, practice: cfg.practice, appCount: cfg.apps.length, adminUrl: store.adminUrl(), version: VERSION }; };

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x"), p = decodeURIComponent(url.pathname), m = req.method;
    if (p === "/healthz") { res.writeHead(200, { "content-type": "text/plain" }); return res.end("ok"); }
    if (p === "/api/link") { res.writeHead(200, { "content-type": "text/plain" }); return res.end("ok"); }
    if (p.startsWith("/api/")) {
      const body = m === "GET" || m === "DELETE" ? {} : JSON.parse((await readBody(req)).toString() || "{}");
      if (p === "/api/overview" && m === "GET") return send(res, 200, overview());
      if (p === "/api/app-config") return send(res, 200, { accounts: false, portalUrl: "" });
      if (p === "/api/users" && m === "POST") { const u = accounts.create({ email: body.email, name: body.name, role: body.role, password: body.password }); return send(res, 201, { user: u, ...overview() }); }
      const um = /^\/api\/users\/([\w-]{1,40})(\/(password|signout))?$/.exec(p);
      if (um) {
        const id = um[1], act = um[3];
        if (!act && m === "PATCH") { const o = {}; for (const k of ["name", "email", "role", "disabled"]) if (k in body) o[k] = body[k]; accounts.update(id, o); return send(res, 200, overview()); }
        if (!act && m === "DELETE") { accounts.remove(id); return send(res, 200, overview()); }
        if (act === "password" && m === "POST") { accounts.resetPassword(id, body.password); return send(res, 200, overview()); }
        if (act === "signout" && m === "POST") { accounts.signOutEverywhere(id); return send(res, 200, overview()); }
      }
      if (p === "/api/practice" && m === "PUT") { const cur = store.load(); store.save({ ...cur, practice: { name: body.name, tagline: body.tagline } }); return send(res, 200, overview()); }
      if (p === "/api/register-url" && m === "POST") {   // the dashboard's Admin folder links here; remember the address this page was opened from
        const u = String(body.url || ""); if (/^https?:\/\/[^\s/]+\/?$/.test(u)) store.setAdminUrl(u.replace(/\/$/, "") + "/");
        return send(res, 200, { ok: true });
      }
      return send(res, 404, { code: "not_found", message: "Not found" });
    }
    let name = p === "/" ? "index.html" : p.replace(/^\/+/, "");
    let f = path.normalize(path.join(SHARED.has(name) ? SHARED_DIR : PUBLIC_DIR, name));
    const root = SHARED.has(name) ? SHARED_DIR : PUBLIC_DIR;
    if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "content-type": TYPES[path.extname(f)] || "application/octet-stream", "cache-control": "no-cache" });
    fs.createReadStream(f).pipe(res);
  } catch (e) {
    if (!(e && e.status)) console.error(e);
    if (!res.headersSent) send(res, e && e.status || (e instanceof SyntaxError ? 400 : 500), { code: "error", message: e && e.status ? e.message : e instanceof SyntaxError ? "That request was not understood." : "Something went wrong." }); else res.end();
  }
});
if (require.main === module) server.listen(PORT, () => console.log(`JAB Admin running on http://0.0.0.0:${PORT}`));
module.exports = { server };
