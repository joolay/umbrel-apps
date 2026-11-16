// Listify: checklists that follow your JoolzApp account.
// Zero-dependency Node server. Sign-in is the shared JoolzApp (PocketBase) account; each person's lists are one JSON file in the data folder.
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const pb = require("./pocketbase");
const guardians = require("./guardians");

const PORT = +process.env.PORT || 3895;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, "data"));
const PUBLIC_DIR = path.join(__dirname, "public");
const USERS_DIR = path.join(DATA_DIR, "users");
const REQUIRE_ACCOUNTS = /^(1|true|yes)$/i.test(process.env.REQUIRE_ACCOUNTS || "");
const MAX_BODY = 15 * 1024 * 1024;
const AI_FILE = path.join(DATA_DIR, "ai-config.json");
fs.mkdirSync(USERS_DIR, { recursive: true });

/* ---------- who may open the app ---------- */
function gateOf(u) {
  if (u.isAdmin) return { ok: true };
  if (u.guard && u.guard.minor && !u.guard.approved) return { ok: false, reason: "guardian_pending", message: "Waiting for approval of your account. Ask a parent or guardian to approve you on the JoolzApp dashboard (Portal Admin), or wait for an admin. Then check again here." };
  if (!u.portal) return u.access ? { ok: true } : { ok: false, reason: "no_access", message: "The admin hasn't opened Listify to you yet. Ask them to give you access, then check again." };
  const a = u.portal.app;
  if (a && a.enabled === false) return { ok: false, reason: "disabled", message: "Listify is switched off right now." };
  if (a && a.maintenance) return { ok: false, reason: "maintenance", message: a.message || "Listify is under maintenance. Try again soon." };
  if (!u.portal.access) return { ok: false, reason: "no_access", message: "You need approval to use Listify. Open Portal Admin, request access to Listify, then check again here." };
  return { ok: true };
}
const publicUser = u => ({ id: u.id, email: u.email || "", name: u.name || "", isAdmin: !!u.isAdmin, dob: u.dob || "", age: guardians.ageOf(u.dob), minor: !!(u.guard ? u.guard.minor : guardians.isMinor(u)), canOpen: gateOf(u).ok, gate: gateOf(u), prefs: Object.fromEntries(Object.entries((u.portal && u.portal.prefs) || {}).filter(([k]) => k !== "ai.apiKey")) });

/* ---------- sessions ---------- */
const tokenCache = new Map();
// Header first (the page sends it), then the cookie. If the header copy has gone stale the cookie, which is renewed as you use the app, still works.
function tokensOf(req) {
  const out = [], h = String(req.headers["x-gd-token"] || "");
  if (h) out.push(h);
  const m = String(req.headers.cookie || "").match(/(?:^|;\s*)gd_token=([^;]+)/);
  if (m && m[1] !== h) out.push(m[1]);
  return out;
}
// "Remember me" keeps the sign-in until 90 days after you last used the app; otherwise the cookie lasts until the browser closes.
function setSessionCookie(req, res, token, remember) {
  if (remember === undefined) remember = /(?:^|;\s*)gd_rem=1/.test(String(req.headers.cookie || ""));
  const secure = String(req.headers["x-forwarded-proto"] || "").includes("https") ? "; Secure" : "", age = remember ? `; Max-Age=${90 * 86400}` : "";
  res.setHeader("set-cookie", [`gd_token=${token}; Path=/; HttpOnly; SameSite=Lax${age}${secure}`, remember ? `gd_rem=1; Path=/; HttpOnly; SameSite=Lax${age}${secure}` : `gd_rem=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`]);
}
const clearSessionCookie = res => res.setHeader("set-cookie", ["gd_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0", "gd_rem=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"]);
async function withGuard(u) { if (u) u.guard = await guardians.statusOf(u).catch(() => ({ minor: guardians.isMinor(u), approved: !guardians.isMinor(u) })); return u; }
const activity = require("./activity");
// "Signed in for 90 days since you last used the app": every time PocketBase checks a token it hands back a fresh one, and the cookie is renewed
// with it (at most once an hour). PocketBase's own token lifetime for the users collection is set to 90 days by Portal Admin > Changes.
const tokenOf = req => tokensOf(req)[0] || "";
async function currentUser(req) {
  let failure = null;
  for (const t of tokensOf(req)) {
    const c = tokenCache.get(t);
    if (c && Date.now() - c.at < 15000) { if (c.user) { req._renew = c; return c.user; } continue; }
    try {
      const j = await pb.verifyToken(t);
      await withGuard(j.record);
      activity.touch(j.record.id);
      const e = { user: j.record, at: Date.now(), fresh: j.token, renewedAt: c && c.renewedAt || 0 };
      tokenCache.set(t, e); req._renew = e;
      if (tokenCache.size > 200) tokenCache.delete(tokenCache.keys().next().value);
      return j.record;
    } catch (e) {
      if (e instanceof pb.PBError && [400, 401, 403, 404].includes(e.status)) { tokenCache.set(t, { user: null, at: Date.now() }); continue; }
      failure = failure || e;
    }
  }
  if (failure) throw failure;
  return null;
}
const attempts = new Map();
function throttled(req, key, max, windowMs) {
  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  const k = key + ":" + ip, now = Date.now();
  const a = (attempts.get(k) || []).filter(t => now - t < windowMs); a.push(now); attempts.set(k, a);
  if (attempts.size > 2000) attempts.clear();
  return a.length > max;
}
const validEmail = e => typeof e === "string" && e.length <= 200 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

function readBody(req) {
  return new Promise((ok, bad) => {
    const chunks = []; let size = 0;
    req.on("data", c => { size += c.length; if (size > MAX_BODY) { bad(new Error("too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => ok(Buffer.concat(chunks))); req.on("error", bad);
  });
}
const send = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(obj)); };

async function accountRoutes(req, res, p) {
  if (!p.startsWith("/api/account/")) return false;
  if (!pb.enabled) { send(res, 404, { code: "accounts_off", message: "Accounts aren't switched on for this server." }); return true; }
  try {
    const body = req.method === "GET" ? {} : JSON.parse((await readBody(req)).toString() || "{}");
    // One JoolzApp sign-up page (in Portal Admin) for every app. Nothing is created here.
    if (p === "/api/account/register") return send(res, 410, { code: "signup_moved", message: "Create your JoolzApp account on the JoolzApp sign-up page (Portal Admin).", portalUrl: await pb.portalUrl().catch(() => "") }), true;
    if (p === "/api/account/login" && req.method === "POST") {
      if (throttled(req, "login", 10, 600e3)) return send(res, 429, { code: "slow_down", message: "Too many attempts. Try again in a few minutes." }), true;
      try { const j = await pb.login(String(body.email || "").trim().toLowerCase(), String(body.password || "")); setSessionCookie(req, res, j.token, !!body.remember); send(res, 200, { token: j.token, user: publicUser(await withGuard(j.record)) }); }
      catch (e) { if (e instanceof pb.PBError && e.status === 400) return send(res, 400, { code: "bad_login", message: "That email and password don't match." }), true; throw e; }
      return true;
    }
    if (p === "/api/account/forgot" && req.method === "POST") {
      if (throttled(req, "forgot", 5, 3600e3)) return send(res, 429, { code: "slow_down", message: "Too many attempts. Try again later." }), true;
      const email = String(body.email || "").trim().toLowerCase();
      if (validEmail(email)) { try { await pb.requestPasswordReset(email); } catch {} }
      send(res, 200, { ok: true, message: "If that account exists, a password reset email has been sent." }); return true;
    }
    if (p === "/api/account/me" && req.method === "GET") {
      const u = await currentUser(req);
      if (!u) return send(res, 401, { code: "signin_required", message: "Sign in to continue." }), true;
      setSessionCookie(req, res, (req._renew && req._renew.fresh) || tokenOf(req));
      send(res, 200, { user: { ...publicUser(await withGuard(await pb.getUser(u.id))), portalUrl: await pb.portalUrl().catch(() => "") } }); return true;
    }
    if (p === "/api/account/logout" && req.method === "POST") { clearSessionCookie(res); send(res, 200, { ok: true }); return true; }
    send(res, 404, { code: "not_found" }); return true;
  } catch (e) {
    if (e instanceof pb.PBError) { console.error("PocketBase:", e.message); send(res, e.status === 0 ? 503 : 502, { code: "accounts_unavailable", message: e.message }); return true; }
    throw e;
  }
}

/* ---------- saved lists, one file per person ---------- */
const ownerKey = u => (u && u.id ? String(u.id).replace(/[^A-Za-z0-9]/g, "") : "local") || "local";
const stateFile = u => path.join(USERS_DIR, ownerKey(u) + ".json");
function readState(u) { try { return JSON.parse(fs.readFileSync(stateFile(u), "utf8")); } catch { return null; } }
function writeState(u, s) { const f = stateFile(u), t = f + ".tmp"; fs.writeFileSync(t, JSON.stringify(s)); fs.renameSync(t, f); }
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function cleanState(d) {
  if (!d || !Array.isArray(d.lists)) return null;
  const lists = d.lists.slice(0, 100).filter(l => l && typeof l.name === "string" && Array.isArray(l.items)).map(l => ({
    id: String(l.id || "").slice(0, 40), name: l.name.slice(0, 60) || "Untitled list", sample: !!l.sample,
    tag: typeof l.tag === "string" && l.tag.trim() ? l.tag.trim().slice(0, 30) : "Groceries",
    date: typeof l.date === "string" && DATE_RE.test(l.date) ? l.date : "",
    items: l.items.filter(i => i && typeof i.text === "string" && i.text.trim()).slice(0, 2000).map(i => ({ id: String(i.id || "").slice(0, 40), text: i.text.slice(0, 300), done: !!i.done }))
  })).filter(l => l.id);
  if (!lists.length) return null;
  return { lists, activeId: lists.some(l => l.id === d.activeId) ? d.activeId : lists[0].id, at: Date.now() };
}

/* ---------- AI (reads a photo of a list) ---------- */
// Same set-up as GrubToGo: a person's own provider/model/key from Portal Admin (My settings) wins; otherwise the shared key,
// with TRIAL_LIMIT free reads for people without their own key (admins are not limited).
const TRIAL_LIMIT = Math.max(0, parseInt(process.env.LISTIFY_TRIAL_LIMIT || "10", 10) || 0);
const PRESETS = {
  anthropic: { baseUrl: "https://api.anthropic.com", model: "claude-sonnet-5-5" },
  gemini: { baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/", model: "gemini-3.8-flash" },
  openai: { baseUrl: "https://api.openai.com/v1", model: "" },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", model: "" },
  custom: { baseUrl: "", model: "" },
};
function loadAI() {
  let c = {}; try { c = JSON.parse(fs.readFileSync(AI_FILE, "utf8")); } catch {}
  const provider = c.provider || process.env.AI_PROVIDER || "anthropic";
  const pre = PRESETS[provider] || PRESETS.openai;
  return { provider, apiKey: c.apiKey ?? process.env.AI_API_KEY ?? "", baseUrl: c.baseUrl || process.env.AI_BASE_URL || pre.baseUrl, model: c.model || process.env.AI_MODEL || pre.model };
}
function userAI(user) {
  const pr = (user && user.portal && user.portal.prefs) || {};
  const key = typeof pr["ai.apiKey"] === "string" ? pr["ai.apiKey"].trim() : "";
  if (!key) return null;
  const provider = PRESETS[pr["ai.provider"]] ? pr["ai.provider"] : "gemini", pre = PRESETS[provider];
  const model = (typeof pr["ai.model"] === "string" ? pr["ai.model"].trim() : "") || pre.model;
  if (!model) return null;
  const baseUrl = provider === "custom" ? String(pr["ai.baseUrl"] || "").trim() : pre.baseUrl;
  return baseUrl ? { provider, apiKey: key, baseUrl, model, own: true } : null;
}
const aiFor = user => userAI(user) || loadAI();
const aiReady = c => !!(c.model && (c.apiKey || c.provider === "openai"));
class AIError extends Error { constructor(code, msg) { super(msg || code); this.code = code; } }
async function trialInfo(user, c) {
  if (!pb.enabled || !user || user.isAdmin || c.own || !aiReady(c)) return { on: false, over: false, used: 0 };
  const t = await pb.trialUsed(user.id); if (t.noPortal) return { on: false, over: false, used: 0 };
  return { on: true, used: t.used, over: t.used >= TRIAL_LIMIT };
}
async function readAI(r) {
  const body = await r.text(); let j = {}; try { j = JSON.parse(body); } catch {}
  if (r.status === 429 || r.status === 529) throw new AIError("rate_limited", "The AI service is busy. Try again in a moment.");
  if (r.status === 401 || r.status === 403) throw new AIError("bad_key", "The AI service rejected the API key. Check it in Portal Admin (My settings) or ask the admin.");
  if (!r.ok) throw new AIError("ai_error", (j.error?.message || body || "HTTP " + r.status).slice(0, 300));
  return j;
}
async function callAI(prompt, images, user) {
  const c = aiFor(user);
  if (!aiReady(c)) throw new AIError("not_configured", "Photo reading isn't set up yet. Add your own AI key in Portal Admin (My settings), or ask an admin to add a shared one.");
  let r, text;
  if (c.provider === "anthropic") {
    const content = images.map(im => ({ type: "image", source: { type: "base64", media_type: im.type || "image/jpeg", data: im.data } }));
    content.push({ type: "text", text: prompt });
    r = await fetch(c.baseUrl.replace(/\/+$/, "") + "/v1/messages", {
      method: "POST", signal: AbortSignal.timeout(120000),
      headers: { "content-type": "application/json", "x-api-key": c.apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: c.model, max_tokens: 4000, messages: [{ role: "user", content }] }),
    });
    text = ((await readAI(r)).content || []).filter(b => b.type === "text").map(b => b.text).join("");
  } else {
    const content = [{ type: "text", text: prompt }, ...images.map(im => ({ type: "image_url", image_url: { url: `data:${im.type || "image/jpeg"};base64,${im.data}` } }))];
    const headers = { "content-type": "application/json" }; if (c.apiKey) headers.authorization = "Bearer " + c.apiKey;
    if (c.provider === "openrouter") headers["x-title"] = "Listify";
    r = await fetch(c.baseUrl.replace(/\/+$/, "") + "/chat/completions", { method: "POST", headers, signal: AbortSignal.timeout(120000), body: JSON.stringify({ model: c.model, max_tokens: 4000, messages: [{ role: "user", content }] }) });
    const j = await readAI(r); text = j.choices?.[0]?.message?.content || "";
    if (Array.isArray(text)) text = text.map(p => p.text || "").join("");
  }
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) throw new AIError("bad_response", "Couldn't read a list from that photo.");
  try { return JSON.parse(m[0]); } catch { throw new AIError("bad_response", "The AI reply wasn't valid JSON."); }
}
const PROMPT = `You read a photo of a written, printed or on-screen list (shopping list, to-do list, notes) into JSON. Reply with ONLY one JSON object, no prose, no code fences:
{"items": [string]}
Rules: one entry per list item, in the order shown; keep each item's own wording and language (fix obvious spelling only); keep quantities with the item (e.g. "Milk x2"); skip titles, dates, ticked-off/crossed-out items and anything that is not a list item; never invent items. If there is no list, return {"items": []}.`;
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".webmanifest": "application/manifest+json" };
const SETUP = "<!doctype html><meta name=viewport content='width=device-width'><body style='font:16px system-ui;padding:2rem;max-width:34rem;margin:auto'><h1>Listify isn't set up yet</h1><p>Accounts are required but PocketBase isn't connected. Add <code>pocketbase.env</code> to the app's data folder (POCKETBASE_SUPERUSER_EMAIL and POCKETBASE_SUPERUSER_PASSWORD), or open Portal Admin and connect PocketBase.</p></body>";

const server = http.createServer(async (req, res) => {
  { // renew the sign-in cookie when this request proved who the person is
    const wh = res.writeHead;
    res.writeHead = function (...a) {
      const e = req._renew;
      if (e && e.fresh && !res.headersSent && !res.getHeader("set-cookie") && Date.now() - e.renewedAt > 3600e3) { e.renewedAt = Date.now(); setSessionCookie(req, res, e.fresh); }
      return wh.apply(this, a);
    };
  }
  try {
    const url = new URL(req.url, "http://x");
    const p = decodeURIComponent(url.pathname);
    const isPage = p === "/" || p === "/index.html";
    const isData = p === "/api/state" || p === "/api/extract" || p === "/api/ai/status";

    // Only signed-in people the admin has let in can open the app (Umbrel's own login is off, so this is the lock).
    let user = null;
    if (isPage || isData) {
      if (!pb.enabled) {
        if (REQUIRE_ACCOUNTS) {
          if (isPage) { res.writeHead(503, { "content-type": "text/html; charset=utf-8" }); return res.end(SETUP); }
          return send(res, 503, { code: "accounts_unavailable", message: "Accounts aren't set up yet." });
        }
      } else {
        let u = null, err = null;
        try { u = await currentUser(req); } catch (e) { err = e; }
        if (!(u && gateOf(u).ok)) {
          if (isPage) { res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); return fs.createReadStream(path.join(PUBLIC_DIR, "gate.html")).pipe(res); }
          if (err) return send(res, 503, { code: "accounts_unavailable", message: err.message });
          return u ? send(res, 403, { code: gateOf(u).reason || "no_access", message: gateOf(u).message }) : send(res, 401, { code: "signin_required", message: "Sign in to continue." });
        }
        user = u;
      }
    }

    if (p === "/api/app-config") return send(res, 200, { accounts: pb.enabled, ...(pb.enabled ? { signups: await pb.signupsOpen().catch(() => true), portalUrl: await pb.portalUrl().catch(() => "") } : {}) });
    if (await accountRoutes(req, res, p)) return;

    if (p === "/api/state" && req.method === "GET") return send(res, 200, { state: readState(user), user: user ? { name: user.name || "", email: user.email || "" } : null });
    if (p === "/api/state" && req.method === "PUT") {
      const s = cleanState(JSON.parse((await readBody(req)).toString() || "{}"));
      if (!s) return send(res, 400, { code: "bad_state", message: "That isn't a Listify save." });
      writeState(user, s); return send(res, 200, { ok: true, at: s.at });
    }

    if (p === "/api/ai/status") {
      const c = aiFor(user), trial = await trialInfo(user, c);
      return send(res, 200, { configured: aiReady(c) && !trial.over, own: !!c.own, trial: trial.on ? { limit: TRIAL_LIMIT, used: trial.used } : null, trialOver: trial.over });
    }
    if (p === "/api/extract" && req.method === "POST") {
      if (throttled(req, "extract", 30, 3600e3)) return send(res, 429, { code: "slow_down", message: "That's a lot of photos in an hour. Try again later." });
      const b = JSON.parse((await readBody(req)).toString() || "{}");
      const images = Array.isArray(b.images) ? b.images.slice(0, 4).filter(i => i && typeof i.data === "string" && /^[A-Za-z0-9+/=]+$/.test(i.data)) : [];
      if (!images.length) return send(res, 400, { code: "empty", message: "No photo to read." });
      try {
        const c = aiFor(user), trial = await trialInfo(user, c);
        if (trial.over) return send(res, 402, { code: "trial_over", message: `You've used your ${TRIAL_LIMIT} free photo reads. Add your own AI key in Portal Admin (My settings) to keep going.` });
        const out = await callAI(PROMPT, images, user);
        if (trial.on) { try { await pb.trialBump(user.id); } catch {} }
        const items = (Array.isArray(out.items) ? out.items : []).map(x => String(x == null ? "" : x).trim().slice(0, 300)).filter(Boolean).slice(0, 100);
        return send(res, 200, { items });
      } catch (e) {
        if (e instanceof AIError) return send(res, e.code === "rate_limited" ? 429 : e.code === "not_configured" ? 400 : 502, { code: e.code, message: e.message });
        throw e;
      }
    }

    // static files
    let f = p === "/" ? "/index.html" : p;
    f = path.normalize(path.join(PUBLIC_DIR, f));
    if (!f.startsWith(PUBLIC_DIR) || !fs.existsSync(f) || fs.statSync(f).isDirectory() || path.basename(f) === "gate.html") { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "content-type": TYPES[path.extname(f)] || "application/octet-stream", "cache-control": "no-cache" });
    fs.createReadStream(f).pipe(res);
  } catch (e) {
    console.error(e);
    if (e instanceof pb.PBError) { if (!res.headersSent) send(res, e.status === 0 ? 503 : 502, { code: "accounts_unavailable", message: e.message }); else res.end(); return; }
    if (!res.headersSent) send(res, 500, { code: "server_error", message: e.message }); else res.end();
  }
});
server.listen(PORT, () => console.log(`Listify running on http://0.0.0.0:${PORT}`));
