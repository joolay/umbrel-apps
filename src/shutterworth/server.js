// ShutterWorth server: stores each person's documents and photos (in PocketBase, or on disk without accounts), pushes live
// updates to every open page, and forwards photo identification to an AI service.
// No npm dependencies — runs on plain Node 20+.
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const pb = require("./pocketbase");
const { createStore, StoreError } = require("./inventory-store");

const PORT = +process.env.PORT || 3880;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, "data"));
const PUBLIC_DIR = path.join(__dirname, "public");
const AI_FILE = path.join(DATA_DIR, "ai-config.json");
const REQUIRE_ACCOUNTS = /^(1|true|yes)$/i.test(process.env.REQUIRE_ACCOUNTS || ""); // refuse to serve anything unless accounts are working
const SETTINGS_FILE = path.join(DATA_DIR, "admin-settings.json");
const APP_PASSWORD = process.env.APP_PASSWORD || "";
const MAX_BODY = 25 * 1024 * 1024;

fs.mkdirSync(DATA_DIR, { recursive: true });

/* ---------- inventory store ---------- */
// With accounts on, each person's lists, items and photos live in PocketBase under their own account, and the
// server only ever reads or writes the signed-in person's. Without accounts, one shared inventory sits in the data folder.
const store = createStore({ pb, dataDir: DATA_DIR });
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { store.flush().catch(() => {}).finally(() => process.exit(0)); });

/* ---------- live updates (Server-Sent Events) ---------- */
// Changes only go to the open pages of the person who made them.
const clients = new Map(); // response -> owner key
function broadcast(owner, changes, origin) {
  const msg = `data: ${JSON.stringify({ changes, origin })}\n\n`;
  for (const [res, o] of clients) if (o === owner) res.write(msg);
}
setInterval(() => { for (const res of clients.keys()) res.write(": ping\n\n"); }, 25000);

/* ---------- AI config ---------- */
const PRESETS = {
  anthropic: { baseUrl: "https://api.anthropic.com", model: "claude-sonnet-5-5", quickModel: "claude-haiku-5-5" },
  gemini: { baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/", model: "gemini-3.8-flash", quickModel: "" },
  openai: { baseUrl: "https://api.openai.com/v1", model: "", quickModel: "" },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", model: "", quickModel: "" },
  custom: { baseUrl: "", model: "", quickModel: "" },
};
function loadAI() {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(AI_FILE, "utf8")); } catch {}
  const provider = c.provider || process.env.AI_PROVIDER || "gemini";
  const pre = PRESETS[provider] || PRESETS.openai;
  return {
    provider,
    apiKey: c.apiKey ?? process.env.AI_API_KEY ?? "",
    baseUrl: c.baseUrl || process.env.AI_BASE_URL || pre.baseUrl,
    model: c.model || process.env.AI_MODEL || pre.model,
    quickModel: c.quickModel ?? process.env.AI_QUICK_MODEL ?? pre.quickModel,
  };
}
// A person can save their own provider, model and key in Portal Admin ("My settings"); those win over the shared key
// and are not counted against the free trial.
function userAI(user) {
  const pr = (user && user.portal && user.portal.prefs) || {};
  const key = typeof pr["ai.apiKey"] === "string" ? pr["ai.apiKey"].trim() : "";
  if (!key) return null;
  const provider = PRESETS[pr["ai.provider"]] ? pr["ai.provider"] : "gemini", pre = PRESETS[provider];
  const model = (typeof pr["ai.model"] === "string" ? pr["ai.model"].trim() : "") || pre.model;
  const baseUrl = provider === "custom" ? String(pr["ai.baseUrl"] || "").trim() : pre.baseUrl;
  return model && baseUrl ? { provider, apiKey: key, baseUrl, model, quickModel: "", own: true } : null;
}
function publicAI(c) {
  return { provider: c.provider, hasKey: !!c.apiKey, keyHint: c.apiKey ? "…" + c.apiKey.slice(-4) : "",
    baseUrl: c.baseUrl, model: c.model, quickModel: c.quickModel, presets: PRESETS };
}

class AIError extends Error { constructor(code, msg) { super(msg || code); this.code = code; } }

async function callAI({ prompt, images = [], tier = "default" }, cfg = null) {
  const c = cfg || loadAI();
  if (!c.apiKey && c.provider !== "openai") throw new AIError("not_configured", "No AI key set in Settings");
  if (!c.model) throw new AIError("not_configured", "No AI model set in Settings");
  const model = tier === "quick" && c.quickModel ? c.quickModel : c.model;
  let r, text;
  if (c.provider === "anthropic") {
    const content = images.map(im => ({ type: "image", source: { type: "base64", media_type: im.type || "image/jpeg", data: im.data } }));
    content.push({ type: "text", text: prompt });
    r = await fetch(c.baseUrl.replace(/\/+$/, "") + "/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": c.apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: 1024, messages: [{ role: "user", content }] }),
    });
    const j = await readJSON(r);
    text = (j.content || []).filter(b => b.type === "text").map(b => b.text).join("");
  } else {
    const content = [{ type: "text", text: prompt }, ...images.map(im => ({ type: "image_url", image_url: { url: `data:${im.type || "image/jpeg"};base64,${im.data}` } }))];
    const headers = { "content-type": "application/json" };
    if (c.apiKey) headers.authorization = "Bearer " + c.apiKey;
    r = await fetch(c.baseUrl.replace(/\/+$/, "") + "/chat/completions", {
      method: "POST", headers,
      body: JSON.stringify({ model, max_tokens: 1024, messages: [{ role: "user", content }] }),
    });
    const j = await readJSON(r);
    text = j.choices?.[0]?.message?.content || "";
    if (Array.isArray(text)) text = text.map(p => p.text || "").join("");
  }
  return parseJSONLoose(text);
}
async function readJSON(r) {
  const body = await r.text();
  let j = {}; try { j = JSON.parse(body); } catch {}
  if (r.status === 429 || r.status === 529) throw new AIError("rate_limited", "The AI service is busy");
  if (r.status === 401 || r.status === 403) throw new AIError("bad_key", "The AI service rejected the API key. If it is your own key, check it in Portal Admin (My settings).");
  if (!r.ok) throw new AIError("ai_error", (j.error?.message || body || "HTTP " + r.status).slice(0, 300));
  return j;
}
function parseJSONLoose(t) {
  t = String(t || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try { return JSON.parse(t); } catch {}
  const m = t.match(/\{[\s\S]*\}/);
  if (m) try { return JSON.parse(m[0]); } catch {}
  throw new AIError("bad_response", "The AI reply wasn't valid JSON");
}

/* ---------- accounts (optional: needs POCKETBASE_URL and a PocketBase superuser login) ---------- */
function loadSettings() {
  let s = {}; try { s = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")); } catch {}
  const n = Math.floor(+s.trialLimit);
  return { trialLimit: Number.isFinite(n) && n >= 0 ? n : 10, signups: s.signups !== false };
}
function trialInfo(u) {
  const st = loadSettings();
  const own = Math.floor(+u.trialLimit);
  const limit = own > 0 ? own : st.trialLimit;      // a per-user limit of 0 or blank means "use the default"
  const used = Math.max(0, Math.floor(+u.trialUsed) || 0);
  const unlimited = !!(u.unlimited || u.isAdmin);
  return { unlimited, limit, used, remaining: unlimited ? null : Math.max(0, limit - used) };
}
// Who may open the app. With Portal Admin set up, the portal decides (per-app approval, app on/off, maintenance);
// admins always get in. Without the portal, the app's own `access` flag applies as before.
function gateOf(u) {
  if (u.isAdmin) return { ok: true };
  if (!u.portal) return u.access ? { ok: true } : { ok: false, reason: "no_access", message: "The admin hasn't opened this inventory to you yet. Ask them to give you access, then check again." };
  const a = u.portal.app;
  if (a && a.enabled === false) return { ok: false, reason: "disabled", message: "ShutterWorth is switched off right now." };
  if (a && a.maintenance) return { ok: false, reason: "maintenance", message: a.message || "ShutterWorth is under maintenance. Try again soon." };
  if (!u.portal.access) return { ok: false, reason: "no_access", message: "You need approval to use ShutterWorth. Open Portal Admin, request access to ShutterWorth, then check again here." };
  return { ok: true };
}
const publicUser = u => ({ id: u.id, email: u.email || "", name: u.name || "", isAdmin: !!u.isAdmin, unlimited: !!u.unlimited, access: u.portal ? u.portal.access : !!u.access, canOpen: gateOf(u).ok, gate: gateOf(u), prefs: Object.fromEntries(Object.entries((u.portal && u.portal.prefs) || {}).filter(([k]) => k !== "ai.apiKey")),
  trialUsed: Math.max(0, Math.floor(+u.trialUsed) || 0), trialLimit: Math.max(0, Math.floor(+u.trialLimit) || 0), created: u.created || "", trial: trialInfo(u) });

const tokenCache = new Map();
function tokenOf(req) {
  const h = String(req.headers["x-sw-token"] || "");
  if (h) return h;
  const m = String(req.headers.cookie || "").match(/(?:^|;\s*)sw_token=([^;]+)/);
  return m ? m[1] : "";
}
// The browser keeps the sign-in in a cookie too, so photos and live updates (which can't send headers) are covered.
// "Remember me" keeps the sign-in for 14 days; otherwise the cookie lasts until the browser closes. sw_rem remembers the choice.
function setSessionCookie(req, res, token, remember) {
  if (remember === undefined) remember = /(?:^|;\s*)sw_rem=1/.test(String(req.headers.cookie || ""));
  const secure = String(req.headers["x-forwarded-proto"] || "").includes("https") ? "; Secure" : "", age = remember ? `; Max-Age=${14 * 86400}` : "";
  res.setHeader("set-cookie", [`sw_token=${token}; Path=/; HttpOnly; SameSite=Lax${age}${secure}`, remember ? `sw_rem=1; Path=/; HttpOnly; SameSite=Lax${age}${secure}` : "sw_rem=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"]);
}
const clearSessionCookie = res => res.setHeader("set-cookie", ["sw_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0", "sw_rem=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"]);
async function currentUser(req) {
  const t = tokenOf(req);
  if (!t) return null;
  const c = tokenCache.get(t);
  if (c && Date.now() - c.at < 15000) return c.user;
  try {
    const j = await pb.verifyToken(t);
    tokenCache.set(t, { user: j.record, at: Date.now() });
    if (tokenCache.size > 200) tokenCache.delete(tokenCache.keys().next().value);
    return j.record;
  } catch (e) {
    if (e instanceof pb.PBError && [400, 401, 403, 404].includes(e.status)) return null;
    throw e;
  }
}

const attempts = new Map();
function throttled(req, key, max, windowMs) {
  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  const k = key + ":" + ip, now = Date.now();
  const a = (attempts.get(k) || []).filter(t => now - t < windowMs);
  a.push(now); attempts.set(k, a);
  if (attempts.size > 2000) attempts.clear();
  return a.length > max;
}
const validEmail = e => typeof e === "string" && e.length <= 200 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

// Returns true when the request was an accounts or admin route (and has been answered).
async function accountRoutes(req, res, p, url) {
  if (!p.startsWith("/api/account/") && !p.startsWith("/api/admin/")) return false;
  if (!pb.enabled) { send(res, 404, { code: "accounts_off", message: "Accounts aren't switched on for this server." }); return true; }
  try {
    const body = req.method === "GET" || req.method === "DELETE" ? {} : JSON.parse((await readBody(req)).toString() || "{}");

    if (p === "/api/account/register" && req.method === "POST") {
      if (throttled(req, "reg", 10, 3600e3)) return send(res, 429, { code: "slow_down", message: "Too many attempts. Try again later." }), true;
      if (!loadSettings().signups || !(await pb.signupsOpen())) return send(res, 403, { code: "signups_closed", message: "New sign-ups are closed right now." }), true;
      const email = String(body.email || "").trim().toLowerCase(), password = String(body.password || ""), name = String(body.name || "").trim().slice(0, 80);
      if (!validEmail(email)) return send(res, 400, { code: "bad_email", message: "Enter a valid email address." }), true;
      if (password.length < 8 || password.length > 200) return send(res, 400, { code: "bad_password", message: "Use a password of at least 8 characters." }), true;
      let created; try { created = await pb.createUser({ email, password, name }); }
      catch (e) {
        if (e instanceof pb.PBError && e.status === 400) return send(res, 400, { code: "cannot_register", message: e.data?.email?.code === "validation_not_unique" ? "That email is already registered. Sign in instead." : (e.data?.password?.message || e.data?.email?.message || "Couldn't create the account.") }), true;
        throw e;
      }
      // Optional: the AI provider, model and key chosen while creating the account are saved as the person's own settings.
      const ai = body.ai && typeof body.ai === "object" ? body.ai : null;
      if (ai && typeof ai.apiKey === "string" && ai.apiKey.trim() && created && created.id) {
        const provider = PRESETS[ai.provider] ? ai.provider : "gemini", clip = (v, n) => String(v || "").trim().slice(0, n), baseUrl = clip(ai.baseUrl, 300);
        if (provider !== "custom" || /^https?:\/\//i.test(baseUrl)) { try { await pb.setUserPrefs(created.id, { "ai.provider": provider, "ai.model": clip(ai.model, 120), "ai.apiKey": clip(ai.apiKey, 300), "ai.baseUrl": provider === "custom" ? baseUrl : "" }); } catch {} }
      }
      const j = await pb.login(email, password);
      setSessionCookie(req, res, j.token, false);
      send(res, 200, { token: j.token, user: publicUser(j.record) }); return true;
    }
    if (p === "/api/account/login" && req.method === "POST") {
      if (throttled(req, "login", 10, 600e3)) return send(res, 429, { code: "slow_down", message: "Too many attempts. Try again in a few minutes." }), true;
      try { const j = await pb.login(String(body.email || "").trim().toLowerCase(), String(body.password || "")); setSessionCookie(req, res, j.token, !!body.remember); send(res, 200, { token: j.token, user: publicUser(j.record) }); }
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
      setSessionCookie(req, res, tokenOf(req));
      send(res, 200, { user: { ...publicUser(await pb.getUser(u.id)), portalUrl: await pb.portalUrl().catch(() => "") } }); return true;
    }
    if (p === "/api/account/logout" && req.method === "POST") { clearSessionCookie(res); send(res, 200, { ok: true }); return true; }

    // everything below is admin only; the server checks the database record on every call
    const me = await currentUser(req);
    if (!me) return send(res, 401, { code: "signin_required", message: "Sign in to continue." }), true;
    if (!me.isAdmin) return send(res, 403, { code: "forbidden", message: "Admins only." }), true;

    if (p === "/api/admin/users" && req.method === "GET") {
      const users = await pb.listUsers(String(url.searchParams.get("q") || "").trim().slice(0, 80));
      send(res, 200, { users: users.map(publicUser), settings: loadSettings(), me: me.id }); return true;
    }
    if (p === "/api/admin/settings" && req.method === "GET") { send(res, 200, loadSettings()); return true; }
    if (p === "/api/admin/settings" && req.method === "POST") {
      const cur = loadSettings(), n = Math.floor(+body.trialLimit);
      const next = { trialLimit: Number.isFinite(n) && n >= 0 && n <= 100000 ? n : cur.trialLimit, signups: typeof body.signups === "boolean" ? body.signups : cur.signups };
      fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next));
      send(res, 200, next); return true;
    }
    const m = p.match(/^\/api\/admin\/users\/([A-Za-z0-9]{1,40})$/);
    if (m && req.method === "PATCH") {
      const id = m[1], data = {};
      if (typeof body.name === "string") data.name = body.name.trim().slice(0, 80);
      if (body.email !== undefined) { const e = String(body.email).trim().toLowerCase(); if (!validEmail(e)) return send(res, 400, { code: "bad_email", message: "Enter a valid email address." }), true; data.email = e; }
      if (typeof body.unlimited === "boolean") data.unlimited = body.unlimited;
      let portalChanged = false;
      if (typeof body.access === "boolean") { if (await pb.portalAvailable()) { await pb.setPortalAccess(id, body.access); portalChanged = true; } else data.access = body.access; }
      if (typeof body.isAdmin === "boolean") {
        if (id === me.id && !body.isAdmin) return send(res, 400, { code: "self_demote", message: "You can't remove your own admin access." }), true;
        data.isAdmin = body.isAdmin;
      }
      if (body.trialLimit !== undefined) { const n = Math.floor(+body.trialLimit); if (!(n >= 0 && n <= 100000)) return send(res, 400, { code: "bad_number", message: "Trial limit must be 0 or more." }), true; data.trialLimit = n; }
      if (body.trialUsed !== undefined) { const n = Math.floor(+body.trialUsed); if (!(n >= 0 && n <= 1e7)) return send(res, 400, { code: "bad_number", message: "Used must be 0 or more." }), true; data.trialUsed = n; }
      if (body.resetTrial === true) data.trialUsed = 0;
      if (typeof body.password === "string" && body.password) {
        if (body.password.length < 8 || body.password.length > 200) return send(res, 400, { code: "bad_password", message: "Use a password of at least 8 characters." }), true;
        data.password = body.password; data.passwordConfirm = body.password;
      }
      if (!Object.keys(data).length) { if (portalChanged) { tokenCache.clear(); send(res, 200, { user: publicUser(await pb.getUser(id)) }); return true; } return send(res, 400, { code: "nothing", message: "Nothing to change." }), true; }
      try { const u = await pb.updateUser(id, data); tokenCache.clear(); send(res, 200, { user: publicUser(u) }); }
      catch (e) {
        if (e instanceof pb.PBError && e.status === 404) return send(res, 404, { code: "not_found", message: "That user no longer exists." }), true;
        if (e instanceof pb.PBError && e.status === 400) return send(res, 400, { code: "cannot_save", message: e.data?.email?.code === "validation_not_unique" ? "Another account already uses that email." : (e.data?.email?.message || e.data?.password?.message || "PocketBase didn't accept that change.") }), true;
        throw e;
      }
      return true;
    }
    if (m && req.method === "DELETE") {
      if (m[1] === me.id) return send(res, 400, { code: "self_delete", message: "You can't delete your own account here." }), true;
      try { await pb.deleteUser(m[1]); tokenCache.clear(); send(res, 200, { ok: true }); }
      catch (e) { if (e instanceof pb.PBError && e.status === 404) return send(res, 404, { code: "not_found", message: "That user no longer exists." }), true; throw e; }
      return true;
    }
    send(res, 404, { code: "not_found" }); return true;
  } catch (e) {
    if (e instanceof pb.PBError) { console.error("PocketBase:", e.message); send(res, e.status === 0 ? 503 : 502, { code: "accounts_unavailable", message: e.message }); return true; }
    throw e;
  }
}

// Photo identifications need an account when accounts are on. Trials count photo requests only.
async function aiGate(req, body) {
  const u = await currentUser(req);
  if (!u) return { deny: { status: 401, body: { code: "signin_required", message: "Sign in under Settings > Account to use photo identification." } } };
  const fresh = await pb.getUser(u.id);
  if (fresh.portal) { const g = gateOf(fresh); if (!g.ok) return { deny: { status: 403, body: { code: g.reason, message: g.message } } }; }
  const mine = userAI(fresh);
  if (mine) return { id: u.id, reserved: false, cfg: mine };   // their own key: no trial limit
  const info = trialInfo(fresh);
  const counted = Array.isArray(body.images) && body.images.length > 0;
  if (info.unlimited || !counted) return { id: u.id, reserved: false };
  if (info.used >= info.limit) return { deny: { status: 403, body: { code: "trial_over", message: `Your free trial of ${info.limit} photo identifications is used up. Add your own AI key in Portal Admin (My settings) to keep going, or ask the admin to extend it.` } } };
  await pb.updateAccess(u.id, { "trialUsed+": 1 });
  return { id: u.id, reserved: true };
}

/* ---------- HTTP ---------- */
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css",
  ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json", ".json": "application/json" };

function readBody(req) {
  return new Promise((res, rej) => {
    const chunks = []; let size = 0;
    req.on("data", c => { size += c.length; if (size > MAX_BODY) { rej(new Error("too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => res(Buffer.concat(chunks)));
    req.on("error", rej);
  });
}
const send = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(obj)); };

function authorised(req) {
  if (!APP_PASSWORD) return true;
  const h = req.headers.authorization || "";
  if (!h.startsWith("Basic ")) return false;
  const pass = Buffer.from(h.slice(6), "base64").toString().split(":").slice(1).join(":");
  const a = Buffer.from(pass), b = Buffer.from(APP_PASSWORD);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const server = http.createServer(async (req, res) => {
  try {
    if (!authorised(req)) {
      res.writeHead(401, { "www-authenticate": 'Basic realm="ShutterWorth"' }); return res.end("Password required");
    }
    const url = new URL(req.url, "http://x");
    const p = decodeURIComponent(url.pathname);

    // The app and its data are only for signed-in people the admin has let in (admins always can).
    // Umbrel's own login is switched off for this app, so this is the only lock: with REQUIRE_ACCOUNTS set it fails closed.
    let user = null;
    const isPage = p === "/" || p === "/index.html";
    const isData = p === "/api/events" || p === "/api/docs" || p === "/api/write" || p === "/api/ai/status" || p.startsWith("/api/assets") || p.startsWith("/_blob/");
    if (isPage || isData) {
      if (!pb.enabled) {
        if (REQUIRE_ACCOUNTS) {
          if (isPage) { res.writeHead(503, { "content-type": "text/html; charset=utf-8" }); return res.end("<!doctype html><meta name=viewport content='width=device-width'><body style='font:16px system-ui;padding:2rem;max-width:34rem;margin:auto'><h1>ShutterWorth isn't set up yet</h1><p>Accounts are required but PocketBase isn't connected. Add <code>pocketbase.env</code> to the app's data folder and restart the app.</p>"); }
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

    if (p === "/api/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
      res.write(`data: ${JSON.stringify({ hello: true })}\n\n`);
      clients.set(res, store.ownerKey(user)); req.on("close", () => clients.delete(res));
      return;
    }
    if (p === "/api/docs" && req.method === "GET") return send(res, 200, { docs: await store.docs(user) });
    if (p === "/api/app-config") return send(res, 200, { googleClientId: process.env.GOOGLE_CLIENT_ID || "", accounts: pb.enabled, ...(pb.enabled ? { trialLimit: loadSettings().trialLimit, signups: loadSettings().signups && await pb.signupsOpen() } : {}) });
    if (await accountRoutes(req, res, p, url)) return;

    if (p === "/api/write" && req.method === "POST") {
      // { origin, ops: [{op:"set"|"update"|"delete", path, data}] }
      const { ops = [], origin } = JSON.parse((await readBody(req)).toString() || "{}");
      const changes = await store.write(user, ops);
      broadcast(store.ownerKey(user), changes, origin);
      return send(res, 200, { ok: true });
    }

    if (p === "/api/assets" && req.method === "POST") {
      const buf = await readBody(req);
      if (!buf.length) return send(res, 400, { code: "empty" });
      const id = await store.putPhoto(user, buf);
      return send(res, 200, { id, url: "/_blob/" + id });
    }
    let m;
    if ((m = p.match(/^\/api\/assets\/([a-f0-9]{16,64})$/)) && req.method === "DELETE") {
      await store.delPhoto(user, m[1]); return send(res, 200, { ok: true });
    }
    if ((m = p.match(/^\/_blob\/([a-f0-9]{16,64})$/))) {
      const buf = await store.getPhoto(user, m[1]);
      if (!buf) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { "content-type": "image/jpeg", "content-length": buf.length, "cache-control": "private, max-age=31536000, immutable" });
      return res.end(buf);
    }

    if (pb.enabled && p === "/api/ai/config") {
      const u = await currentUser(req).catch(() => null);
      if (!u || !u.isAdmin) return send(res, u ? 403 : 401, { code: u ? "forbidden" : "signin_required", message: "Admins only." });
    }
    if (p === "/api/ai/config" && req.method === "GET") return send(res, 200, publicAI(loadAI()));
    if (p === "/api/ai/config" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)).toString() || "{}");
      const cur = loadAI();
      const next = {
        provider: PRESETS[body.provider] ? body.provider : cur.provider,
        apiKey: typeof body.apiKey === "string" && body.apiKey.trim() ? body.apiKey.trim() : (body.clearKey ? "" : cur.apiKey),
        baseUrl: String(body.baseUrl || "").trim(), model: String(body.model || "").trim(), quickModel: String(body.quickModel || "").trim(),
      };
      fs.writeFileSync(AI_FILE, JSON.stringify(next), { mode: 0o600 });
      return send(res, 200, publicAI(loadAI()));
    }
    if (p === "/api/ai/status") {
      const c = loadAI(); let own = false;
      if (pb.enabled) { const u = await currentUser(req).catch(() => null); if (u) own = !!userAI(await pb.getUser(u.id).catch(() => null)); }
      return send(res, 200, { configured: own || !!(c.model && (c.apiKey || c.provider === "openai")), own });
    }
    if (p === "/api/ai" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)).toString() || "{}");
      let gate = null;
      if (pb.enabled) {
        try { gate = await aiGate(req, body); }
        catch (e) { if (e instanceof pb.PBError) return send(res, 503, { code: "accounts_unavailable", message: e.message }); throw e; }
        if (gate.deny) return send(res, gate.deny.status, gate.deny.body);
      }
      try { return send(res, 200, { result: await callAI(body, gate && gate.cfg) }); }
      catch (e) {
        if (gate && gate.reserved) await pb.updateAccess(gate.id, { "trialUsed-": 1 }).catch(() => {}); // a failed request doesn't use up the trial
        return send(res, e.code === "rate_limited" ? 429 : 502, { code: e.code || "ai_error", message: e.message });
      }
    }

    // static files
    let f = p === "/" ? "/index.html" : p;
    f = path.normalize(path.join(PUBLIC_DIR, f));
    if (!f.startsWith(PUBLIC_DIR) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "content-type": TYPES[path.extname(f)] || "application/octet-stream", "cache-control": "no-cache" });
    fs.createReadStream(f).pipe(res);
  } catch (e) {
    if (e instanceof StoreError) { if (!res.headersSent) send(res, e.status, { code: e.code, message: e.message, ...e.extra }); else res.end(); return; }
    console.error(e);
    if (e instanceof pb.PBError) { if (!res.headersSent) send(res, e.status === 0 ? 503 : 502, { code: "accounts_unavailable", message: e.message }); else res.end(); return; }
    if (!res.headersSent) send(res, 500, { code: "server_error", message: e.message }); else res.end();
  }
});
server.listen(PORT, () => console.log(`ShutterWorth running on http://0.0.0.0:${PORT}`));
