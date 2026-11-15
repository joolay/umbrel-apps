// JoolzApp sign-in gate for Stremio. Zero dependencies.
// Sits in front of the unmodified Stremio image: shows a "JoolzApp account" sign-in page, checks the PocketBase token
// (and Portal Admin's per-app access), then reverse-proxies everything else to Stremio Web. Fails closed: if PocketBase
// accounts aren't configured, nothing from Stremio is served.
"use strict";
const http = require("http");
const net = require("net");
const pb = require("./pocketbase");

const PORT = +process.env.PORT || 3897;
const UP = new URL(process.env.UPSTREAM || "http://stremio:8080");
const COOKIE = "jz_token";
const MAX_AGE = 14 * 24 * 3600;

const readCookie = req => { const m = String(req.headers.cookie || "").match(new RegExp("(?:^|;\\s*)" + COOKIE + "=([^;]+)")); return m ? m[1] : ""; };
const secure = req => /https/i.test(String(req.headers["x-forwarded-proto"] || "")) ? "; Secure" : "";
const setCookie = (req, res, token) => res.setHeader("set-cookie", `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE}${secure(req)}`);
const clearCookie = res => res.setHeader("set-cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
const json = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(obj)); };

/* ---------- login throttle ---------- */
const hits = new Map();
function throttled(req) {
  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  const now = Date.now(); const a = (hits.get(ip) || []).filter(t => now - t < 600e3); a.push(now); hits.set(ip, a);
  if (hits.size > 5000) hits.clear();
  return a.length > 10;
}

/* ---------- who is this, and may they open Stremio? ---------- */
const cache = new Map();
async function userFor(token) {
  if (!token) return null;
  const c = cache.get(token);
  if (c && Date.now() - c.at < 60e3) return c.u;
  let u = null;
  try { u = (await pb.verifyToken(token)).record; }
  catch (e) { if (!(e instanceof pb.PBError) || ![400, 401, 403, 404].includes(e.status)) throw e; }
  if (cache.size > 500) cache.clear();
  cache.set(token, { u, at: Date.now() });
  return u;
}
// Admins always get in. Everyone else needs Portal Admin's access (when the portal is installed) and the app switched on.
function verdict(u) {
  if (!u) return { ok: false, why: "signin" };
  if (u.isAdmin) return { ok: true };
  const p = u.portal;
  if (!p) return { ok: true };
  if (p.access === false) return { ok: false, why: "no_access", message: "Your JoolzApp account doesn't have access to Stremio yet. Ask for access on your JoolzApp dashboard." };
  if (p.app && p.app.enabled === false) return { ok: false, why: "off", message: "Stremio is switched off right now." };
  if (p.app && p.app.maintenance) return { ok: false, why: "off", message: p.app.message || "Stremio is down for maintenance." };
  return { ok: true };
}

/* ---------- sign-in page ---------- */
const page = (note, portalUrl) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Stremio - JoolzApp sign-in</title><style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0c0b11;color:#f2f0ff;font:16px system-ui,sans-serif}
form{width:min(360px,92vw);background:#17151f;border:1px solid #2a2738;border-radius:16px;padding:28px}
h1{margin:0 0 4px;font-size:22px}p{margin:0 0 18px;color:#a9a4c4;font-size:14px}
input{width:100%;padding:12px;margin:0 0 12px;border-radius:10px;border:1px solid #34304a;background:#0f0e15;color:inherit;font:inherit}
button{width:100%;padding:12px;border:0;border-radius:10px;background:#7b5bf5;color:#fff;font:inherit;font-weight:600;cursor:pointer}
#err{color:#ff8c8c;font-size:14px;min-height:20px;margin-bottom:8px}a{color:#b7a4ff}</style></head><body>
<form id="f"><h1>Stremio</h1><p>Sign in with your JoolzApp account.</p>
<div id="err">${note ? note.replace(/[<>&]/g, "") : ""}</div>
<input name="email" type="email" placeholder="Email" autocomplete="username" required>
<input name="password" type="password" placeholder="Password" autocomplete="current-password" required>
<button>Sign in</button>${portalUrl ? `<p style="margin:14px 0 0"><a href="${portalUrl}">Create a JoolzApp account</a></p>` : ""}</form>
<script>document.getElementById("f").onsubmit=async e=>{e.preventDefault();const d=Object.fromEntries(new FormData(e.target));
const r=await fetch("/_auth/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(d)});const j=await r.json().catch(()=>({}));
if(r.ok)location.reload();else document.getElementById("err").textContent=j.message||"Sign-in failed.";};</script></body></html>`;

async function showPage(res, note) {
  const portalUrl = pb.enabled ? await pb.portalUrl().catch(() => "") : "";
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(page(note, portalUrl));
}

/* ---------- proxy to Stremio ---------- */
const stripAuth = h => { const c = String(h.cookie || "").split(/;\s*/).filter(x => x && !x.startsWith(COOKIE + "=")).join("; "); const o = { ...h, host: UP.host }; if (c) o.cookie = c; else delete o.cookie; return o; };
function proxy(req, res) {
  const o = http.request({ host: UP.hostname, port: UP.port || 80, method: req.method, path: req.url, headers: stripAuth(req.headers) }, r => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  o.on("error", () => { if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" }); res.end("Stremio is still starting. Try again in a moment."); });
  req.pipe(o);
}

const server = http.createServer(async (req, res) => {
  try {
    const p = req.url.split("?")[0];
    if (!pb.enabled) { res.writeHead(503, { "content-type": "text/plain" }); return res.end("Stremio is locked until JoolzApp accounts are configured. Put POCKETBASE_URL, POCKETBASE_SUPERUSER_EMAIL and POCKETBASE_SUPERUSER_PASSWORD in <app data>/data/pocketbase.env."); }
    if (p === "/_auth/login" && req.method === "POST") {
      if (throttled(req)) return json(res, 429, { message: "Too many attempts. Try again in a few minutes." });
      let raw = ""; for await (const c of req) { raw += c; if (raw.length > 10000) break; }
      let b = {}; try { b = JSON.parse(raw); } catch {}
      try {
        const j = await pb.login(String(b.email || "").trim().toLowerCase(), String(b.password || ""));
        const v = verdict(j.record);
        if (!v.ok) return json(res, 403, { message: v.message || "No access." });
        setCookie(req, res, j.token); return json(res, 200, { ok: true });
      } catch (e) {
        if (e instanceof pb.PBError && e.status === 400) return json(res, 400, { message: "That email and password don't match." });
        throw e;
      }
    }
    if (p === "/_auth/logout") { clearCookie(res); res.writeHead(302, { location: "/" }); return res.end(); }
    const v = verdict(await userFor(readCookie(req)));
    if (!v.ok) {
      if (req.method === "GET" && /text\/html/.test(String(req.headers.accept || ""))) return showPage(res, v.message);
      return json(res, 401, { message: "Sign in with your JoolzApp account." });
    }
    proxy(req, res);
  } catch (e) {
    console.error(e.message);
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end("Can't check your JoolzApp account right now. Try again shortly.");
  }
});

// WebSocket / upgrade requests must be signed in too.
server.on("upgrade", async (req, socket, head) => {
  try {
    if (!pb.enabled || !verdict(await userFor(readCookie(req))).ok) return socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
    const up = net.connect(UP.port || 80, UP.hostname, () => {
      const h = stripAuth(req.headers);
      up.write(`${req.method} ${req.url} HTTP/1.1\r\n` + Object.entries(h).map(([k, v]) => `${k}: ${v}`).join("\r\n") + "\r\n\r\n");
      if (head && head.length) up.write(head);
      socket.pipe(up).pipe(socket);
    });
    up.on("error", () => socket.destroy()); socket.on("error", () => up.destroy());
  } catch { socket.destroy(); }
});

// Locked because there's no pocketbase.env yet? Portal Admin's automatic connecting writes it; exit when it shows up so Umbrel restarts us with it.
if (!pb.enabled) {
  const f = require("path").join(require("path").resolve(process.env.DATA_DIR || "/data"), "pocketbase.env");
  setInterval(() => { if (require("fs").existsSync(f)) { console.log("pocketbase.env found, restarting"); process.exit(1); } }, 5000).unref();
}

server.listen(PORT, () => console.log(`Stremio gate on :${PORT} -> ${UP.origin} (accounts ${pb.enabled ? "on" : "NOT configured: locked"})`));
