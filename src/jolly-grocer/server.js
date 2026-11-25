// Jolly Grocer: a grocery shopping companion that follows your JoolzApp account.
// Zero-dependency Node server. Sign-in is the shared JoolzApp (PocketBase) account. Each person's lists, shops and purchases are one
// PocketBase record (jollygrocer_state); receipt photos are low-res images in PocketBase (jollygrocer_receipts). With accounts off,
// the same data lives in files in the data folder.
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const pb = require("./pocketbase");
const guardians = require("./guardians");

const PORT = +process.env.PORT || 3897;
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
  if (!u.portal) return u.access ? { ok: true } : { ok: false, reason: "no_access", message: "The admin hasn't opened Jolly Grocer to you yet. Ask them to give you access, then check again." };
  const a = u.portal.app;
  if (a && a.enabled === false) return { ok: false, reason: "disabled", message: "Jolly Grocer is switched off right now." };
  if (a && a.maintenance) return { ok: false, reason: "maintenance", message: a.message || "Jolly Grocer is under maintenance. Try again soon." };
  if (!u.portal.access) return { ok: false, reason: "no_access", message: "You need approval to use Jolly Grocer. Open Portal Admin, request access to Jolly Grocer, then check again here." };
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
// Checking a sign-in with PocketBase takes several round trips, so the answer is reused: as it is for 15 seconds, and for up to 10 minutes
// while a fresh check runs in the background, so pages open straight away. Requests arriving together share one check.
// Admin actions and "who am I" pass strict and always get an answer no older than 15 seconds.
const checking = new Map();
function verifyFresh(t, prev) {
  if (checking.has(t)) return checking.get(t);
  const p = (async () => {
    try {
      const j = await pb.verifyToken(t);
      await withGuard(j.record);
      activity.touch(j.record.id);
      const e = { user: j.record, at: Date.now(), fresh: j.token, renewedAt: prev && prev.renewedAt || 0 };
      tokenCache.set(t, e);
      if (tokenCache.size > 200) tokenCache.delete(tokenCache.keys().next().value);
      return e;
    } catch (e) {
      if (e instanceof pb.PBError && [400, 401, 403, 404].includes(e.status)) { const n = { user: null, at: Date.now() }; tokenCache.set(t, n); return n; }
      throw e;
    } finally { checking.delete(t); }
  })();
  checking.set(t, p); return p;
}
async function currentUser(req, strict) {
  let failure = null;
  for (const t of tokensOf(req)) {
    let c = tokenCache.get(t); const age = c ? Date.now() - c.at : Infinity;
    if (c && age < 15000) { if (c.user) { req._renew = c; return c.user; } continue; }
    if (c && c.user && !strict && age < 600000) { verifyFresh(t, c).catch(() => {}); req._renew = c; return c.user; }
    try { c = await verifyFresh(t, c); if (c.user) { req._renew = c; return c.user; } }
    catch (e) { failure = failure || e; }
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
      const u = await currentUser(req, true);
      if (!u) return send(res, 401, { code: "signin_required", message: "Sign in to continue." }), true;
      setSessionCookie(req, res, (req._renew && req._renew.fresh) || tokenOf(req));
      send(res, 200, { user: { ...publicUser(u), portalUrl: await pb.portalUrl().catch(() => "") } }); return true;
    }
    if (p === "/api/account/logout" && req.method === "POST") { clearSessionCookie(res); send(res, 200, { ok: true }); return true; }
    send(res, 404, { code: "not_found" }); return true;
  } catch (e) {
    if (e instanceof pb.PBError) { console.error("PocketBase:", e.message); send(res, e.status === 0 ? 503 : 502, { code: "accounts_unavailable", message: e.message }); return true; }
    throw e;
  }
}

/* ---------- saved data: one record per person (PocketBase), or files when accounts are off ---------- */
const STATE_COL = "jollygrocer_state", RCPT_COL = "jollygrocer_receipts";
const ownerKey = u => (u && u.id ? String(u.id).replace(/[^A-Za-z0-9]/g, "") : "local") || "local";
const validRid = id => typeof id === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(id);
const recs = c => "/api/collections/" + c + "/records";
const qs = encodeURIComponent;
const esc = s => String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
let schemaReady = null;
function ensureCollections() {
  if (!schemaReady) schemaReady = (async () => {
    // Portal Admin > Changes ("App data storage") creates these two collections and lets only Jolly Grocer's own limited login use them.
    // Once that is done nothing below is needed. Until then (older setups) the app makes them itself with its superuser login.
    if (await pb.serviceCan([STATE_COL, RCPT_COL].map(c => "/api/collections/" + c))) return;
    if (!pb.legacyOn()) throw new pb.PBError(503, "Jolly Grocer's storage isn't set up yet. In Portal Admin > Changes, apply \"App data storage\".");
    await pb.ensureSchema();
    const users = await pb.asSuper("GET", "/api/collections/" + encodeURIComponent(pb.collection));
    const key = users.fields ? "fields" : "schema"; // PocketBase 0.23+ says "fields", 0.22 says "schema"
    const fld = (name, type, o = {}) => { const { required, ...opts } = o; return key === "fields" ? { name, type, required: !!required, ...opts } : { name, type, required: !!required, options: opts }; };
    const make = async (name, fields, idxField) => {
      try { await pb.asSuper("GET", "/api/collections/" + name); return; } catch (e) { if (e.status !== 404) throw e; }
      try {
        await pb.asSuper("POST", "/api/collections", { name, type: "base", [key]: fields, indexes: [`CREATE UNIQUE INDEX \`idx_${name}_owner_key\` ON \`${name}\` (\`owner\`${idxField ? `, \`${idxField}\`` : ""})`], listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null });
      } catch (e) { try { await pb.asSuper("GET", "/api/collections/" + name); } catch { throw e; } } // another request may have just created it
    };
    await make(STATE_COL, [fld("owner", "text", { required: true }), fld("data", "json", { maxSize: 10485760 })]);
    await make(RCPT_COL, [fld("owner", "text", { required: true }), fld("rid", "text", { required: true }), fld("file", "file", { maxSelect: 1, maxSize: 5242880 })], "rid");
  })().catch(e => { schemaReady = null; throw e; });
  return schemaReady;
}
const one = f => (Array.isArray(f) ? f[0] : f);
const fileStore = {
  dir: u => { const d = path.join(USERS_DIR, ownerKey(u)); fs.mkdirSync(path.join(d, "receipts"), { recursive: true }); return d; },
  async getState(u) { try { return JSON.parse(fs.readFileSync(path.join(this.dir(u), "state.json"), "utf8")); } catch { return null; } },
  async putState(u, s) { const f = path.join(this.dir(u), "state.json"), t = f + ".tmp"; fs.writeFileSync(t, JSON.stringify(s)); fs.renameSync(t, f); },
  async putReceipt(u, id, buf) { fs.writeFileSync(path.join(this.dir(u), "receipts", id + ".jpg"), buf); },
  async getReceipt(u, id) { try { return fs.readFileSync(path.join(this.dir(u), "receipts", id + ".jpg")); } catch { return null; } },
  async delReceipt(u, id) { fs.rmSync(path.join(this.dir(u), "receipts", id + ".jpg"), { force: true }); },
};
const pbStore = {
  async getState(u) { await ensureCollections(); const j = await pb.asApp("GET", recs(STATE_COL) + `?page=1&perPage=1&filter=${qs(`owner = '${esc(u.id)}'`)}`); const r = (j.items || [])[0]; return r && r.data && typeof r.data === "object" ? r.data : null; },
  async putState(u, s) {
    await ensureCollections();
    const j = await pb.asApp("GET", recs(STATE_COL) + `?page=1&perPage=1&filter=${qs(`owner = '${esc(u.id)}'`)}`), r = (j.items || [])[0];
    if (r) await pb.asApp("PATCH", recs(STATE_COL) + "/" + r.id, { data: s }); else await pb.asApp("POST", recs(STATE_COL), { owner: u.id, data: s });
  },
  async findReceipt(u, id) { const j = await pb.asApp("GET", recs(RCPT_COL) + `?page=1&perPage=1&filter=${qs(`owner = '${esc(u.id)}' && rid = '${esc(id)}'`)}`); return (j.items || [])[0] || null; },
  async putReceipt(u, id, buf) {
    await ensureCollections();
    const old = await this.findReceipt(u, id); if (old) await pb.asApp("DELETE", recs(RCPT_COL) + "/" + old.id);
    const fd = new FormData(); fd.append("owner", u.id); fd.append("rid", id); fd.append("file", new Blob([buf], { type: "image/jpeg" }), id + ".jpg");
    const r = await pb.appFetch(recs(RCPT_COL), { method: "POST", body: fd });
    if (!r.ok) throw new pb.PBError(r.status, "Couldn't archive the receipt (" + r.status + ")");
  },
  async getReceipt(u, id) {
    await ensureCollections(); const r = await this.findReceipt(u, id); if (!r) return null;
    const f = await pb.appFetch(`/api/files/${RCPT_COL}/${r.id}/${qs(one(r.file))}`); if (!f.ok) return null;
    return Buffer.from(await f.arrayBuffer());
  },
  async delReceipt(u, id) { await ensureCollections(); const r = await this.findReceipt(u, id); if (r) { try { await pb.asApp("DELETE", recs(RCPT_COL) + "/" + r.id); } catch (e) { if (e.status !== 404) throw e; } } },
};
const store = () => (pb.enabled ? pbStore : fileStore);
// Keep the shape the app needs and bound its size; the page tidies the rest when it loads.
function cleanState(d) {
  if (!d || typeof d !== "object" || !Array.isArray(d.lists) || !Array.isArray(d.shops)) return null;
  const arr = (a, n) => (Array.isArray(a) ? a.slice(0, n) : []);
  const s = { shops: arr(d.shops, 200), defaultShop: String(d.defaultShop || "").slice(0, 40), ...(Array.isArray(d.cats) ? { cats: d.cats.slice(0, 60).map(c => String(c).slice(0, 30)) } : {}), lists: arr(d.lists, 500), activeId: String(d.activeId || "").slice(0, 40), prefs: d.prefs && typeof d.prefs === "object" && !Array.isArray(d.prefs) ? d.prefs : {}, purchases: arr(d.purchases, 20000), receipts: arr(d.receipts, 20000), settings: d.settings && typeof d.settings === "object" ? d.settings : {}, at: Date.now() };
  return JSON.stringify(s).length > 9 * 1024 * 1024 ? null : s;
}

/* ---------- AI (reads a photo of a list) ---------- */
// Same set-up as GrubToGo: a person's own provider/model/key from Portal Admin (My settings) wins; otherwise the shared key,
// with TRIAL_LIMIT free reads for people without their own key (admins are not limited).
const TRIAL_LIMIT = Math.max(0, parseInt(process.env.JOLLYGROCER_TRIAL_LIMIT || "10", 10) || 0);
const PRESETS = {
  anthropic: { baseUrl: "https://api.anthropic.com", model: "claude-sonnet-5-5" },
  gemini: { baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/", model: "gemini-3.8-flash" },
  openai: { baseUrl: "https://api.openai.com/v1", model: "" },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", model: "" },
  nvidia: { baseUrl: "https://integrate.api.nvidia.com/v1", model: "" },
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
// Order: the person's own key -> the Master key while their free trial lasts -> the key a parent shares with the family once it is over -> this app's own shared key.
// Portal Admin decides (Portal API ai.resolve); the app only says whether the trial is used up. Family keys count as the person's own (no trial counting).
async function aiFor(user) {
  const own = userAI(user); if (own) return own;
  if (user && pb.portalOn && pb.portalOn()) {
    try {
      const over = !user.isAdmin && (await pb.trialUsed(user.id)).used >= TRIAL_LIMIT;
      const r = await pb.portalCall("ai.resolve", [user.id, over]);
      if (r && PRESETS[r.provider]) { const pre = PRESETS[r.provider]; return { provider: r.provider, apiKey: r.apiKey || "", baseUrl: r.provider === "custom" ? r.baseUrl : pre.baseUrl, model: r.model || pre.model, own: r.source !== "master", source: r.source }; }
    } catch {}
  }
  return loadAI();
}
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
// Tell Portal Admin one AI request happened, so the person (and a parent) can see the month's usage there. Never slows or breaks the request.
function logAI(user, c) { try { if (user && user.id && pb.portalOn && pb.portalOn()) pb.portalCall("ai.log", [user.id, { source: (c && c.source) || (c && c.own ? "own" : "master") }]).catch(() => {}); } catch {} }
async function callAI(prompt, images, user) {
  const c = await aiFor(user), out = await callAIRaw(prompt, images, user, c);
  logAI(user, c); return out;
}
async function callAIRaw(prompt, images, user, cfg) {
  const c = cfg || await aiFor(user);
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
    if (c.provider === "openrouter") headers["x-title"] = "Jolly Grocer";
    r = await fetch(c.baseUrl.replace(/\/+$/, "") + "/chat/completions", { method: "POST", headers, signal: AbortSignal.timeout(120000), body: JSON.stringify({ model: c.model, max_tokens: 4000, messages: [{ role: "user", content }] }) });
    const j = await readAI(r); text = j.choices?.[0]?.message?.content || "";
    if (Array.isArray(text)) text = text.map(p => p.text || "").join("");
  }
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) throw new AIError("bad_response", "Couldn't read a list from that photo.");
  try { return JSON.parse(m[0]); } catch { throw new AIError("bad_response", "The AI reply wasn't valid JSON."); }
}
const LIST_PROMPT = `Read the attached photo of a handwritten, printed or on-screen shopping list. Reply with ONLY one JSON object, no prose, no code fences: {"items": [string]}. One entry per list item in the order shown. Keep each item exactly as written, including any short 1-2 letter code at the start of a line (for example "PP Milk" or "W: bread"). Skip titles, dates and crossed-out items. Never invent items. If there is no list, return {"items": []}.`;
const RECEIPT_PROMPT = `Read the attached shop receipt. Reply with ONLY one JSON object, no prose, no code fences: {"store": string|null, "date": "YYYY-MM-DD"|null, "time": "HH:MM"|null, "total": number|null, "lines": [{"name": string, "qty": number|null, "price": number}]}. "price" is the full amount charged for that line (quantity already multiplied) as a plain number. Include every purchased product line in order; skip subtotals, VAT lines, discount summaries, change and card slips. "total" is the amount paid. Never invent lines.`;
const num = x => (typeof x === "number" && isFinite(x) ? x : typeof x === "string" && isFinite(parseFloat(x.replace(",", "."))) ? parseFloat(x.replace(",", ".")) : null);
function cleanReceipt(o) {
  const lines = (Array.isArray(o.lines) ? o.lines : []).slice(0, 300).map(l => ({ name: String((l && l.name) || "").trim().slice(0, 120), qty: num(l && l.qty), price: num(l && l.price) })).filter(l => l.name && l.price !== null);
  return { store: typeof o.store === "string" && o.store.trim() ? o.store.trim().slice(0, 80) : null, date: typeof o.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(o.date) ? o.date : null, time: typeof o.time === "string" && /^\d{2}:\d{2}$/.test(o.time) ? o.time : null, total: num(o.total), lines };
}
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".webmanifest": "application/manifest+json" };
const SETUP = "<!doctype html><meta name=viewport content='width=device-width'><meta http-equiv=refresh content=5><body style='font:16px system-ui;padding:2rem;max-width:34rem;margin:auto'><h1>Waiting for PocketBase</h1><p>Jolly Grocer isn't connected to PocketBase yet. Open Portal Admin and sign in when it asks; this page then starts on its own within a few seconds.</p></body>";

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
    const isData = p === "/api/state" || p === "/api/prefs" || p === "/api/extract" || p === "/api/ai/status" || p.startsWith("/api/ai/choice") || p === "/api/receipt";

    // Only signed-in people the admin has let in can open the app (Umbrel's own login is off, so this is the lock).
    let user = null;
    if (isPage || isData) {
      pb.reload(); // picks up pocketbase.env as soon as Portal Admin writes it, with no restart
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

    if (p === "/api/state" && req.method === "GET") return send(res, 200, { state: await store().getState(user || { id: "local" }), user: user ? { name: user.name || "", email: user.email || "", prefs: (user.portal && user.portal.prefs && user.portal.prefs["jolly-grocer"]) || {} } : null });
    if (p === "/api/state" && req.method === "PUT") {
      const s = cleanState(JSON.parse((await readBody(req)).toString() || "{}"));
      if (!s) return send(res, 400, { code: "bad_state", message: "That isn't a Jolly Grocer save." });
      await store().putState(user || { id: "local" }, s); return send(res, 200, { ok: true, at: s.at });
    }
    if (p === "/api/prefs" && req.method === "PUT") {
      if (!user || !user.id || user.id === "local") return send(res, 200, { ok: true });
      const b = JSON.parse((await readBody(req)).toString() || "{}"), prev = (user.portal && user.portal.prefs && user.portal.prefs["jolly-grocer"]) || {}, next = { ...prev };
      if (b.theme === "light" || b.theme === "dark" || b.theme === "") next.theme = b.theme;   // light / dark, or "" for the device setting
      await pb.setAppPref(user.id, next); return send(res, 200, { ok: true, prefs: next });
    }
    if (p === "/api/receipt") {
      const id = url.searchParams.get("id") || "", owner = user || { id: "local" };
      if (!validRid(id)) return send(res, 400, { code: "bad_id", message: "Bad receipt id." });
      if (req.method === "PUT") {
        const buf = await readBody(req);
        if (!buf.length || buf.length > 4 * 1024 * 1024 || !(buf[0] === 0xff && buf[1] === 0xd8)) return send(res, 400, { code: "bad_image", message: "Receipt images must be small JPEG photos." });
        await store().putReceipt(owner, id, buf); return send(res, 200, { ok: true });
      }
      if (req.method === "DELETE") { await store().delReceipt(owner, id); return send(res, 200, { ok: true }); }
      if (req.method === "GET") {
        const buf = await store().getReceipt(owner, id);
        if (!buf) return send(res, 404, { code: "not_found", message: "That receipt image isn't in the archive." });
        res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "private, max-age=3600" }); return res.end(buf);
      }
      return send(res, 405, { code: "bad_method" });
    }

    if (p === "/api/ai/choice" || p === "/api/ai/choice/models") {   // this person's AI choice for THIS app (its Settings screen): Master key, own keys and models, through Portal API
      
      if (!user || !pb.portalOn || !pb.portalOn()) return send(res, 503, { message: "AI choices need the JoolzApp account." });
      try {
        if (p.endsWith("/models")) return send(res, 200, await pb.portalCall("ai.models", [user.id, new URL(req.url, "http://x").searchParams.get("id") || ""]));
        if (req.method === "POST") { const b = JSON.parse((await readBody(req)).toString() || "{}"); await pb.portalCall("ai.choose", [user.id, String(b.id || ""), String(b.model || "")]); }
        return send(res, 200, await pb.portalCall("ai.mine", [user.id]));
      } catch (e) { return send(res, e.status >= 400 && e.status < 600 ? e.status : 502, { message: e.message }); }
    }
    if (p === "/api/ai/status") {
      const c = await aiFor(user), trial = await trialInfo(user, c);
      return send(res, 200, { configured: aiReady(c) && !trial.over, own: !!c.own, trial: trial.on ? { limit: TRIAL_LIMIT, used: trial.used } : null, trialOver: trial.over });
    }
    if (p === "/api/extract" && req.method === "POST") {
      if (throttled(req, "extract", 30, 3600e3)) return send(res, 429, { code: "slow_down", message: "That's a lot of photos in an hour. Try again later." });
      const b = JSON.parse((await readBody(req)).toString() || "{}");
      const images = Array.isArray(b.images) ? b.images.slice(0, 4).filter(i => i && typeof i.data === "string" && /^[A-Za-z0-9+/=]+$/.test(i.data)) : [];
      if (!images.length) return send(res, 400, { code: "empty", message: "No photo to read." });
      try {
        const c = await aiFor(user), trial = await trialInfo(user, c);
        if (trial.over) return send(res, 402, { code: "trial_over", message: `You've used your ${TRIAL_LIMIT} free photo reads. Add your own AI key in Portal Admin (My settings) to keep going.` });
        const receipt = b.kind === "receipt", out = await callAI(receipt ? RECEIPT_PROMPT : LIST_PROMPT, images, user);
        if (trial.on) { try { await pb.trialBump(user.id); } catch {} }
        if (receipt) return send(res, 200, cleanReceipt(out));
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
server.listen(PORT, () => console.log(`Jolly Grocer running on http://0.0.0.0:${PORT}`));
