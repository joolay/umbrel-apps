// GrubToGo server: JoolzApp sign-in (shared PocketBase account), per-person saved menus and carts, and menu reading
// through an AI service. No npm dependencies — runs on plain Node 20+.
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const dns = require("dns").promises;
const net = require("net");
const pb = require("./pocketbase");
const menus = require("./menus");

const PORT = +process.env.PORT || 3893;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, "data"));
const PUBLIC_DIR = path.join(__dirname, "public");
const USERS_DIR = path.join(DATA_DIR, "users");
const AI_FILE = path.join(DATA_DIR, "ai-config.json");
const REQUIRE_ACCOUNTS = /^(1|true|yes)$/i.test(process.env.REQUIRE_ACCOUNTS || "");
const MAX_BODY = 25 * 1024 * 1024;
fs.mkdirSync(USERS_DIR, { recursive: true });

/* ---------- AI (reads menus) ---------- */
const TRIAL_LIMIT = Math.max(0, parseInt(process.env.GRUBTOGO_TRIAL_LIMIT || "10", 10) || 0);
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
// A person can save their own provider, model and key in Portal Admin ("My settings"); those win over the shared key.
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
// People without their own AI key get TRIAL_LIMIT free menu reads on the shared key (admins are not limited).
async function trialInfo(user, c) {
  if (!pb.enabled || !user || user.isAdmin || c.own || !aiReady(c)) return { on: false, over: false, used: 0 };
  const t = await pb.trialUsed(user.id); if (t.noPortal) return { on: false, over: false, used: 0 };
  return { on: true, used: t.used, over: t.used >= TRIAL_LIMIT };
}

async function callAI(prompt, images = [], user = null) {
  const c = aiFor(user);
  if (!aiReady(c)) throw new AIError("not_configured", "Menu reading isn't set up yet. Add your own AI key in Portal Admin (My settings), or ask an admin to add a shared one.");
  let r, text;
  if (c.provider === "anthropic") {
    const content = images.map(im => ({ type: "image", source: { type: "base64", media_type: im.type || "image/jpeg", data: im.data } }));
    content.push({ type: "text", text: prompt });
    r = await fetch(c.baseUrl.replace(/\/+$/, "") + "/v1/messages", {
      method: "POST", signal: AbortSignal.timeout(120000),
      headers: { "content-type": "application/json", "x-api-key": c.apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: c.model, max_tokens: 8000, messages: [{ role: "user", content }] }),
    });
    text = ((await readAI(r)).content || []).filter(b => b.type === "text").map(b => b.text).join("");
  } else {
    const content = [{ type: "text", text: prompt }, ...images.map(im => ({ type: "image_url", image_url: { url: `data:${im.type || "image/jpeg"};base64,${im.data}` } }))];
    const headers = { "content-type": "application/json" }; if (c.apiKey) headers.authorization = "Bearer " + c.apiKey;
    if (c.provider === "openrouter") { headers["x-title"] = "GrubToGo"; }
    r = await fetch(c.baseUrl.replace(/\/+$/, "") + "/chat/completions", { method: "POST", headers, signal: AbortSignal.timeout(120000), body: JSON.stringify({ model: c.model, max_tokens: 8000, messages: [{ role: "user", content }] }) });
    const j = await readAI(r); text = j.choices?.[0]?.message?.content || "";
    if (Array.isArray(text)) text = text.map(p => p.text || "").join("");
  }
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) throw new AIError("bad_response", "Couldn't read a menu from that.");
  try { return JSON.parse(m[0]); } catch { throw new AIError("bad_response", "The AI reply wasn't valid JSON."); }
}
async function readAI(r) {
  const body = await r.text(); let j = {}; try { j = JSON.parse(body); } catch {}
  if (r.status === 429 || r.status === 529) throw new AIError("rate_limited", "The AI service is busy. Try again in a moment.");
  if (r.status === 401 || r.status === 403) throw new AIError("bad_key", "The AI service rejected the API key. Check it in Portal Admin (My settings) or ask the admin.");
  if (!r.ok) throw new AIError("ai_error", (j.error?.message || body || "HTTP " + r.status).slice(0, 300));
  return j;
}
const PROMPT = `You extract restaurant menus into JSON. Reply with ONLY one JSON object, no prose, no code fences:
{"name": string, "phone": string|null, "currency": string, "categories": [{"name": string, "items": [{"name": string, "description": string, "price": number|null}]}]}
Rules: include every dish and drink actually on the menu; never invent items or prices. "phone" is the restaurant's telephone number exactly as printed anywhere in the source, else null. "currency" is the symbol used for prices (e.g. "R", "$", "€"; default "R" if unclear). "price" is a plain number without symbol (use the base price if sizes vary). Keep the menu's own language. If the source contains no readable menu, reply {"error":"reason"}.`;

// Fetches a menu page for the person. Refuses addresses inside the home network.
async function fetchPage(raw) {
  let u; try { u = new URL(raw); } catch { throw new AIError("bad_url", "That doesn't look like a web address."); }
  if (!/^https?:$/.test(u.protocol)) throw new AIError("bad_url", "Only http and https links work.");
  const addrs = net.isIP(u.hostname) ? [{ address: u.hostname }] : await dns.lookup(u.hostname, { all: true }).catch(() => []);
  if (!addrs.length) throw new AIError("bad_url", "Couldn't find that website.");
  const priv = a => /^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(a) || /^(::1?$|fc|fd|fe80)/i.test(a);
  if (addrs.some(a => priv(a.address))) throw new AIError("bad_url", "That address isn't allowed.");
  let r;
  try { r = await fetch(u, { redirect: "follow", signal: AbortSignal.timeout(15000), headers: { "user-agent": "Mozilla/5.0 (compatible; GrubToGo/1.0)", accept: "text/html,*/*" } }); }
  catch { throw new AIError("bad_url", "Couldn't open that page."); }
  if (!r.ok) throw new AIError("bad_url", "That page answered with an error (" + r.status + ").");
  const html = (await r.text()).slice(0, 2e6);
  const text = html.replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ").replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d)>/gi, "\n").replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
  if (text.length < 80) throw new AIError("bad_url", "That page has no readable text (it may load its menu with a script). Try a screenshot or PDF instead.");
  return text.slice(0, 40000);
}

/* ---------- accounts (JoolzApp account on PocketBase) ---------- */
// Who may open the app: with Portal Admin set up the portal decides (per-app approval, on/off, maintenance); admins always get in.
function gateOf(u) {
  if (u.isAdmin) return { ok: true };
  if (!u.portal) return u.access ? { ok: true } : { ok: false, reason: "no_access", message: "The admin hasn't opened GrubToGo to you yet. Ask them to give you access, then check again." };
  const a = u.portal.app;
  if (a && a.enabled === false) return { ok: false, reason: "disabled", message: "GrubToGo is switched off right now." };
  if (a && a.maintenance) return { ok: false, reason: "maintenance", message: a.message || "GrubToGo is under maintenance. Try again soon." };
  if (!u.portal.access) return { ok: false, reason: "no_access", message: "You need approval to use GrubToGo. Open Portal Admin, request access to GrubToGo, then check again here." };
  return { ok: true };
}
const publicUser = u => ({ id: u.id, email: u.email || "", name: u.name || "", isAdmin: !!u.isAdmin, canOpen: gateOf(u).ok, gate: gateOf(u), prefs: Object.fromEntries(Object.entries((u.portal && u.portal.prefs) || {}).filter(([k]) => k !== "ai.apiKey")) });

const tokenCache = new Map();
function tokenOf(req) {
  const h = String(req.headers["x-gd-token"] || ""); if (h) return h;
  const m = String(req.headers.cookie || "").match(/(?:^|;\s*)gd_token=([^;]+)/); return m ? m[1] : "";
}
// "Remember me" keeps the sign-in for 14 days; otherwise the cookie lasts until the browser closes. gd_rem remembers the choice.
function setSessionCookie(req, res, token, remember) {
  if (remember === undefined) remember = /(?:^|;\s*)gd_rem=1/.test(String(req.headers.cookie || ""));
  const secure = String(req.headers["x-forwarded-proto"] || "").includes("https") ? "; Secure" : "", age = remember ? `; Max-Age=${14 * 86400}` : "";
  res.setHeader("set-cookie", [`gd_token=${token}; Path=/; HttpOnly; SameSite=Lax${age}${secure}`, remember ? `gd_rem=1; Path=/; HttpOnly; SameSite=Lax${age}${secure}` : `gd_rem=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`]);
}
const clearSessionCookie = res => res.setHeader("set-cookie", ["gd_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0", "gd_rem=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"]);
async function currentUser(req) {
  const t = tokenOf(req); if (!t) return null;
  const c = tokenCache.get(t); if (c && Date.now() - c.at < 15000) return c.user;
  try {
    const j = await pb.verifyToken(t);
    tokenCache.set(t, { user: j.record, at: Date.now() });
    if (tokenCache.size > 200) tokenCache.delete(tokenCache.keys().next().value);
    return j.record;
  } catch (e) { if (e instanceof pb.PBError && [400, 401, 403, 404].includes(e.status)) return null; throw e; }
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

async function accountRoutes(req, res, p) {
  if (!p.startsWith("/api/account/")) return false;
  if (!pb.enabled) { send(res, 404, { code: "accounts_off", message: "Accounts aren't switched on for this server." }); return true; }
  try {
    const body = req.method === "GET" ? {} : JSON.parse((await readBody(req)).toString() || "{}");
    if (p === "/api/account/register" && req.method === "POST") {
      if (throttled(req, "reg", 10, 3600e3)) return send(res, 429, { code: "slow_down", message: "Too many attempts. Try again later." }), true;
      if (!(await pb.signupsOpen())) return send(res, 403, { code: "signups_closed", message: "New sign-ups are closed right now." }), true;
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
        const provider = PRESETS[ai.provider] ? ai.provider : "gemini", clip = (v, n) => String(v || "").trim().slice(0, n);
        const baseUrl = clip(ai.baseUrl, 300);
        if (provider !== "custom" || /^https?:\/\//i.test(baseUrl)) { try { await pb.setUserPrefs(created.id, { "ai.provider": provider, "ai.model": clip(ai.model, 120), "ai.apiKey": clip(ai.apiKey, 300), "ai.baseUrl": provider === "custom" ? baseUrl : "" }); } catch {} }
      }
      const j = await pb.login(email, password); setSessionCookie(req, res, j.token, false);
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
    send(res, 404, { code: "not_found" }); return true;
  } catch (e) {
    if (e instanceof pb.PBError) { console.error("PocketBase:", e.message); send(res, e.status === 0 ? 503 : 502, { code: "accounts_unavailable", message: e.message }); return true; }
    throw e;
  }
}

/* ---------- saved menus and carts, one file per person ---------- */
const ownerKey = u => (u && u.id ? String(u.id).replace(/[^A-Za-z0-9]/g, "") : "local") || "local";
const stateFile = u => path.join(USERS_DIR, ownerKey(u) + ".json");
function readState(u) { try { return JSON.parse(fs.readFileSync(stateFile(u), "utf8")); } catch { return null; } }
function writeState(u, s) { const f = stateFile(u), t = f + ".tmp"; fs.writeFileSync(t, JSON.stringify(s)); fs.renameSync(t, f); }
function cleanState(s) {
  if (!s || typeof s !== "object" || !Array.isArray(s.restaurants)) return null;
  return { restaurants: [], carts: s.carts && typeof s.carts === "object" && !Array.isArray(s.carts) ? s.carts : {}, at: Date.now() };
}

/* ---------- HTTP ---------- */
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json" };
function readBody(req) {
  return new Promise((ok, bad) => {
    const chunks = []; let size = 0;
    req.on("data", c => { size += c.length; if (size > MAX_BODY) { bad(new Error("too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => ok(Buffer.concat(chunks))); req.on("error", bad);
  });
}
const send = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(obj)); };
const SETUP = "<!doctype html><meta name=viewport content='width=device-width'><body style='font:16px system-ui;padding:2rem;max-width:34rem;margin:auto'><h1>GrubToGo isn't set up yet</h1><p>Accounts are required but PocketBase isn't connected. Add <code>pocketbase.env</code> to the app's data folder and restart the app.</p>";

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    const p = decodeURIComponent(url.pathname);
    const isPage = p === "/" || p === "/index.html";
    const isMenus = p === "/api/menus" || /^\/api\/menus\/[A-Za-z0-9]{1,40}$/.test(p);
    const isData = isMenus || p === "/api/state" || p === "/api/extract" || p === "/api/ai/status" || p === "/api/ai/config";

    // The app and its data are only for signed-in people the admin has let in (admins always can).
    // Umbrel's own login is off for this app, so this is the lock: with REQUIRE_ACCOUNTS set it fails closed.
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

    if (p === "/api/app-config") return send(res, 200, { accounts: pb.enabled, ...(pb.enabled ? { signups: await pb.signupsOpen().catch(() => true) } : {}) });
    if (await accountRoutes(req, res, p)) return;

    if (isMenus) {
      if (!user) return send(res, 503, { code: "accounts_unavailable", message: "The shared menu archive needs accounts. Connect PocketBase first." });
      const id = (p.match(/^\/api\/menus\/([A-Za-z0-9]+)$/) || [])[1];
      if (!id && req.method === "GET") return send(res, 200, { menus: await menus.list(user) });
      if (!id && req.method === "POST") {
        const m = menus.cleanMenu(JSON.parse((await readBody(req)).toString() || "{}"));
        if (!m) return send(res, 400, { code: "bad_menu", message: "That menu has no items." });
        return send(res, 200, { menu: await menus.create(user, m) });
      }
      if (id && req.method === "PUT") { const r = await menus.update(user, id, JSON.parse((await readBody(req)).toString() || "{}")); return r.status ? send(res, r.status, { code: "menu_denied", message: r.message }) : send(res, 200, r); }
      if (id && req.method === "DELETE") { const r = await menus.remove(user, id); return r.status ? send(res, r.status, { code: "menu_denied", message: r.message }) : send(res, 200, r); }
      return send(res, 405, { message: "Method not allowed" });
    }
    if (p === "/api/state" && req.method === "GET") return send(res, 200, { state: readState(user) });
    if (p === "/api/state" && req.method === "PUT") {
      const s = cleanState(JSON.parse((await readBody(req)).toString() || "{}"));
      if (!s) return send(res, 400, { code: "bad_state", message: "That isn't a GrubToGo save." });
      writeState(user, s); return send(res, 200, { ok: true, at: s.at });
    }

    if (p === "/api/ai/status") {
      const c = aiFor(user), trial = await trialInfo(user, c); const ready = aiReady(c) && !trial.over;
      return send(res, 200, { configured: ready, own: !!c.own, trial: trial.on ? { limit: TRIAL_LIMIT, used: trial.used } : null, trialOver: trial.over, isAdmin: !pb.enabled || !!(user && user.isAdmin), provider: c.provider, model: c.model, keyHint: c.apiKey ? "…" + c.apiKey.slice(-4) : "" });
    }
    if (p === "/api/ai/config" && req.method === "POST") {
      if (pb.enabled && !(user && user.isAdmin)) return send(res, 403, { code: "forbidden", message: "Admins only." });
      const b = JSON.parse((await readBody(req)).toString() || "{}"), cur = loadAI();
      const provider = PRESETS[b.provider] ? b.provider : cur.provider, pre = PRESETS[provider];
      const next = { provider, apiKey: typeof b.apiKey === "string" && b.apiKey.trim() ? b.apiKey.trim() : cur.apiKey, baseUrl: String(b.baseUrl || "").trim() || pre.baseUrl, model: String(b.model || "").trim() || pre.model };
      fs.writeFileSync(AI_FILE, JSON.stringify(next), { mode: 0o600 });
      const c = loadAI(); return send(res, 200, { configured: aiReady(c), provider: c.provider, model: c.model, keyHint: c.apiKey ? "…" + c.apiKey.slice(-4) : "" });
    }
    if (p === "/api/extract" && req.method === "POST") {
      if (throttled(req, "extract", 30, 3600e3)) return send(res, 429, { code: "slow_down", message: "That's a lot of menus in an hour. Try again later." });
      const b = JSON.parse((await readBody(req)).toString() || "{}");
      try {
        let prompt, images = [];
        if (b.url) prompt = PROMPT + "\n\nMENU TEXT (from " + String(b.url).slice(0, 200) + "):\n" + await fetchPage(String(b.url));
        else if (Array.isArray(b.images) && b.images.length) { images = b.images.slice(0, 6).filter(i => i && typeof i.data === "string"); prompt = PROMPT + "\n\nThe menu is in the attached image(s)."; }
        else if (typeof b.text === "string" && b.text.trim()) prompt = PROMPT + "\n\nMENU TEXT:\n" + b.text.slice(0, 40000);
        else return send(res, 400, { code: "empty", message: "Nothing to read." });
        const c = aiFor(user), trial = await trialInfo(user, c);
        if (trial.over) return send(res, 402, { code: "trial_over", message: `You've used your ${TRIAL_LIMIT} free menu reads. Add your own AI key in Portal Admin (My settings) to keep going.` });
        const menu = await callAI(prompt, images, user);
        if (trial.on) { try { await pb.trialBump(user.id); } catch {} }
        return send(res, 200, { menu });
      } catch (e) {
        if (e instanceof AIError) return send(res, e.code === "rate_limited" ? 429 : e.code === "bad_url" || e.code === "not_configured" ? 400 : 502, { code: e.code, message: e.message });
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
server.listen(PORT, () => console.log(`GrubToGo running on http://0.0.0.0:${PORT}`));
