"use strict";
// Paid apps. An app is "locked" by turning its paywall on; people then get in by paying with Yoco, or because the admin chose them.
//
// How it plugs into every JoolzApp without changing any of them: apps already honour `portal.access` rows in portal_settings
// (precedence user x app > app > global). Turning a paywall on writes an app-level `portal.access = false` row, and each person who
// pays (or is chosen by the admin) gets a user x app `portal.access = true` row plus a `portal.entitlement` row that records how and
// until when. Expiry and household membership are enforced by sweep(), which removes the access row.
//
// Rows (all in portal_settings):
//   scope app,  app <slug>, key app.paywall        value { mode: "once"|"period", days, price, householdPrice, managed }  (prices in cents)
//   scope user, user <id>, app <slug>, key portal.entitlement   value { until: ISO|null, via: "yoco"|"admin"|"household", paymentId, payerId, familyId, amount }
//   scope global, key yoco.secretKey | yoco.webhookSecret | yoco.publicUrl   (secret keys are saved with secret = true)
const crypto = require("crypto");
const pb = require("./pocketbase");
const family = require("./family");

const SET = "/api/collections/portal_settings/records";
const q = encodeURIComponent, esc = s => String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
const YOCO = "https://payments.yoco.com/api";
const DAY = 86400000;

async function list(filter) {
  const out = []; for (let page = 1; page <= 20; page++) {
    const j = await pb.asSuper("GET", `${SET}?page=${page}&perPage=200&filter=${q(filter)}`);
    out.push(...(j.items || [])); if (page >= (j.totalPages || 1)) break;
  }
  return out;
}
async function upsert(filter, body) {
  const ex = (await pb.asSuper("GET", `${SET}?page=1&perPage=1&filter=${q(filter)}`)).items[0];
  return ex ? pb.asSuper("PATCH", `${SET}/${ex.id}`, { value: body.value }) : pb.asSuper("POST", SET, { secret: false, ...body });
}
async function remove(filter) { for (const r of await list(filter)) await pb.asSuper("DELETE", `${SET}/${r.id}`); }

/* ---------- Yoco settings ---------- */
let yc = null;
async function yocoSettings(fresh) {
  if (!fresh && yc && Date.now() - yc.at < 15000) return yc.v;
  const rows = await list("scope = 'global' && key ~ 'yoco.'"), v = {};
  rows.forEach(r => { v[r.key.slice(5)] = r.value; });
  yc = { v, at: Date.now() }; return v;
}
async function setYoco(key, value) {
  await upsert(`scope = 'global' && key = 'yoco.${key}'`, { scope: "global", user: "", app: "", key: "yoco." + key, value, secret: key !== "publicUrl" });
  yc = null;
}
async function yocoFetch(path, method, body, key) {
  const s = await yocoSettings(), secret = key || s.secretKey;
  if (!secret) throw Object.assign(new Error("Payments are not set up yet. The admin needs to add the Yoco secret key."), { status: 503 });
  const r = await fetch(YOCO + path, { method, headers: { authorization: "Bearer " + secret, "content-type": "application/json", "Idempotency-Key": crypto.randomUUID() }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.message || j.errorMessage || "Yoco said no (" + r.status + ")."), { status: 502 });
  return j;
}

/* ---------- Config and entitlements ---------- */
async function paywalls() {
  const m = {}; (await list("scope = 'app' && key = 'app.paywall'")).forEach(r => { if (r.value && typeof r.value === "object") m[r.app] = r.value; });
  return m;
}
const cleanSlug = s => String(s || "").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 48);
function cleanCfg(c) {
  const price = Math.round(Number(c.price)), hp = c.householdPrice === null || c.householdPrice === "" || c.householdPrice === undefined ? null : Math.round(Number(c.householdPrice));
  if (!(price >= 200)) throw Object.assign(new Error("The price must be at least R2.00 (Yoco's minimum)."), { status: 400 });
  if (hp !== null && !(hp >= 200)) throw Object.assign(new Error("The household price must be at least R2.00."), { status: 400 });
  const mode = c.mode === "once" ? "once" : "period", days = Math.min(3650, Math.max(1, Math.round(Number(c.days) || 30)));
  return { mode, days, price, householdPrice: hp };
}
// Two kinds of pass per person and app, so a household pass never overwrites something they paid for themselves:
// key portal.entitlement (their own payment, or chosen by the admin) and portal.entitlement.household (someone in their household paid).
const HH = "portal.entitlement.household";
const entFilter = (slug, userId, key = "portal.entitlement") => `scope = 'user' && app = '${esc(slug)}' && key = '${key}'` + (userId ? ` && user = '${esc(userId)}'` : "");
const entAny = (slug, userId) => `scope = 'user' && app = '${esc(slug)}' && key ~ 'portal.entitlement'` + (userId ? ` && user = '${esc(userId)}'` : "");
const accFilter = (slug, userId) => `scope = 'user' && user = '${esc(userId)}' && app = '${esc(slug)}' && key = 'portal.access'`;
const live = e => e.value && (!e.value.until || Date.parse(e.value.until) > Date.now());

async function setAccess(userId, slug, on) {
  if (on) await upsert(accFilter(slug, userId), { scope: "user", user: userId, app: slug, key: "portal.access", value: true });
  else await remove(accFilter(slug, userId));
}
// Give one person access. `days` extends from today or from their current end date, whichever is later; null = permanent.
async function grant(userId, slug, { days, via, paymentId, payerId, familyId, amount, until }) {
  const key = via === "household" ? HH : "portal.entitlement", cur = (await list(entFilter(slug, userId, key)))[0], now = Date.now();
  let end = until !== undefined ? until : null;
  if (days) {
    const base = cur && cur.value && cur.value.until && Date.parse(cur.value.until) > now ? Date.parse(cur.value.until) : now;
    end = new Date(base + days * DAY).toISOString();
  }
  if (cur && cur.value && cur.value.until === null) end = null;      // never shorten a permanent pass
  await upsert(entFilter(slug, userId, key), { scope: "user", user: userId, app: slug, key, value: { until: end, via, paymentId: paymentId || "", payerId: payerId || "", familyId: familyId || "", amount: amount || 0 } });
  await setAccess(userId, slug, true);
  return end;
}
// Admin revoke: every pass this person has for the app.
async function revoke(userId, slug) { await remove(entAny(slug, userId)); await setAccess(userId, slug, false); }
// One pass ended (expired, or they left the household): they stay in if another pass is still running.
async function endPass(e) {
  await pb.asSuper("DELETE", `${SET}/${e.id}`);
  if (!(await list(entAny(e.app, e.user))).some(live)) await setAccess(e.user, e.app, false);
}

async function setConfig(slug, cfg, adminPerson) {
  slug = cleanSlug(slug); if (!slug) throw Object.assign(new Error("Unknown app."), { status: 400 });
  if (cfg === null) {
    const ex = (await list(`scope = 'app' && app = '${esc(slug)}' && key = 'app.paywall'`))[0];
    if (ex && ex.value && ex.value.managed) await remove(`scope = 'app' && app = '${esc(slug)}' && key = 'portal.access'`);
    await remove(`scope = 'app' && app = '${esc(slug)}' && key = 'app.paywall'`); return;
  }
  const c = cleanCfg(cfg);
  const had = (await list(`scope = 'app' && app = '${esc(slug)}' && key = 'portal.access'`))[0], ex = (await list(`scope = 'app' && app = '${esc(slug)}' && key = 'app.paywall'`))[0];
  c.managed = ex ? !!(ex.value && ex.value.managed) : !had;     // we only undo the lock if we were the ones who set it
  if (!had) await pb.asSuper("POST", SET, { scope: "app", user: "", app: slug, key: "portal.access", value: false, secret: false });
  else if (had.value !== false) { await pb.asSuper("PATCH", `${SET}/${had.id}`, { value: false }); c.managed = false; }
  await upsert(`scope = 'app' && app = '${esc(slug)}' && key = 'app.paywall'`, { scope: "app", user: "", app: slug, key: "app.paywall", value: c });
  // the admin always keeps access, and so does anyone flagged isAdmin
  if (adminPerson) await grant(adminPerson.id, slug, { days: 0, via: "admin" }).catch(() => {});
}

async function findPerson(identity) {
  const v = String(identity || "").trim(); if (!v) return null;
  return v.includes("@") ? pb.findByEmail(v.toLowerCase()) : pb.findByUsername(pb.cleanUsername(v));
}

/* ---------- What the signed-in person sees ---------- */
async function forPerson(user) {
  const [pw, s, mine] = await Promise.all([paywalls(), yocoSettings(), list(`scope = 'user' && user = '${esc(user.id)}' && key ~ 'portal.entitlement'`)]);
  const fam = await family.circleIds(user).catch(() => ({ familyIds: [] }));
  const apps = {}; Object.keys(pw).forEach(k => { apps[k] = { mode: pw[k].mode, days: pw[k].days, price: pw[k].price, householdPrice: pw[k].householdPrice }; });
  const m = {}; mine.filter(live).forEach(e => { const c = m[e.app]; if (!c || !e.value.until || (c.until && e.value.until > c.until)) m[e.app] = { until: e.value.until, via: e.value.via }; });
  return { ready: !!(s.secretKey && s.publicUrl), apps, mine: m, household: !!(fam.householdId) };
}

/* ---------- Paying ---------- */
async function startPayment(user, slug, scope) {
  slug = cleanSlug(slug);
  const cfg = (await paywalls())[slug]; if (!cfg) throw Object.assign(new Error("That app is not for sale."), { status: 404 });
  const s = await yocoSettings(); if (!s.publicUrl) throw Object.assign(new Error("Payments are not set up yet."), { status: 503 });
  let amount = cfg.price, familyId = "";
  if (scope === "household") {
    if (!cfg.householdPrice) throw Object.assign(new Error("There is no household price for this app."), { status: 400 });
    const fam = await family.circleIds(user); familyId = fam.householdId || "";
    if (!familyId) throw Object.assign(new Error("You need a household first. Create one under Family."), { status: 400 });
    amount = cfg.householdPrice;
  }
  const base = String(s.publicUrl).replace(/\/+$/, "");
  const j = await yocoFetch("/checkouts", "POST", {
    amount, currency: "ZAR", cancelUrl: base + "/#/home", successUrl: base + "/#/paid/" + slug, failureUrl: base + "/#/home",
    metadata: { kind: "joolzapp-access", userId: user.id, slug, scope: familyId ? "household" : "person", familyId, amount: String(amount), mode: cfg.mode, days: String(cfg.days) },
  });
  return { redirectUrl: j.redirectUrl };
}

// Yoco webhooks use Standard Webhooks: HMAC-SHA256 (base64) over "<webhook-id>.<webhook-timestamp>.<raw body>" with the whsec_ secret.
function verifySignature(secret, headers, raw) {
  const id = headers["webhook-id"], ts = headers["webhook-timestamp"], sig = headers["webhook-signature"];
  if (!secret || !id || !ts || !sig) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const key = Buffer.from(String(secret).replace(/^whsec_/, ""), "base64");
  const want = crypto.createHmac("sha256", key).update(`${id}.${ts}.${raw}`).digest();
  return String(sig).split(" ").some(p => { const [v, b] = p.split(","); if (v !== "v1" || !b) return false; const got = Buffer.from(b, "base64"); return got.length === want.length && crypto.timingSafeEqual(got, want); });
}
async function handleWebhook(headers, raw) {
  const s = await yocoSettings(true);
  if (!verifySignature(s.webhookSecret, headers, raw)) return { status: 401 };
  let ev; try { ev = JSON.parse(raw); } catch { return { status: 400 }; }
  if (ev.type !== "payment.succeeded") return { status: 200 };
  const p = ev.payload || {}, md = p.metadata || {};
  if (md.kind !== "joolzapp-access") return { status: 200 };        // not one of ours (the webhook sees every payment on the Yoco account)
  if (Number(p.amount) !== Number(md.amount)) return { status: 200 };
  const slug = cleanSlug(md.slug), paymentId = String(p.id || ev.id || "");
  if (!slug || !md.userId || !paymentId) return { status: 200 };
  const seen = (await list(`scope = 'user' && key ~ 'portal.entitlement' && app = '${esc(slug)}'`)).some(e => e.value && e.value.paymentId === paymentId);
  if (seen) return { status: 200 };                                  // a retry of a payment we already honoured
  const days = md.mode === "once" ? 0 : Math.max(1, Number(md.days) || 30), amount = Number(md.amount);
  if (md.scope === "household" && md.familyId) {
    for (const id of await family.memberIdsOf(md.familyId)) await grant(id, slug, { days, via: "household", paymentId, payerId: md.userId, familyId: md.familyId, amount });
  } else await grant(md.userId, slug, { days, via: "yoco", paymentId, payerId: md.userId, amount });
  return { status: 200 };
}

/* ---------- Housekeeping (hourly) ---------- */
async function sweep() {
  const all = await list("scope = 'user' && key ~ 'portal.entitlement'");
  for (const e of all) if (e.value && e.value.until && Date.parse(e.value.until) <= Date.now()) await endPass(e);
  // Households: everyone who lives there now has the pass, and people who left lose it.
  const groups = {};
  all.filter(e => live(e) && e.key === HH && e.value.familyId).forEach(e => { const k = e.app + "|" + e.value.familyId + "|" + e.value.payerId; (groups[k] = groups[k] || []).push(e); });
  for (const k of Object.keys(groups)) {
    const rows = groups[k], { app, value } = rows[0], members = new Set(await family.memberIdsOf(value.familyId));
    if (!members.size) continue;
    const latest = rows.map(r => r.value.until).sort().pop() || null;
    for (const id of members) if (!rows.some(r => r.user === id)) await grant(id, app, { until: latest, via: "household", paymentId: value.paymentId, payerId: value.payerId, familyId: value.familyId, amount: value.amount });
    for (const r of rows) if (!members.has(r.user)) await endPass(r);
  }
}

/* ---------- Admin ---------- */
async function adminView() {
  const [s, pw, ents] = await Promise.all([yocoSettings(true), paywalls(), list("scope = 'user' && key ~ 'portal.entitlement'")]);
  const people = {}; async function who(id) { if (!people[id]) { const u = await pb.getUser(id).catch(() => null); people[id] = u ? { name: u.name || "", email: u.email || "", username: u.username || "" } : { name: "(deleted)", email: "", username: "" }; } return people[id]; }
  const apps = {};
  for (const slug of Object.keys(pw)) apps[slug] = { cfg: pw[slug], people: [] };
  for (const e of ents) { if (!apps[e.app]) apps[e.app] = { cfg: null, people: [] }; apps[e.app].people.push({ userId: e.user, ...(await who(e.user)), until: e.value.until, via: e.value.via, expired: !live(e) }); }
  const key = String(s.secretKey || "");
  return { yoco: { hasSecret: !!key, mode: key.startsWith("sk_live") ? "live" : key ? "test" : "", hasWebhook: !!s.webhookSecret, publicUrl: s.publicUrl || "" }, apps };
}
async function adminAction(b, adminPerson) {
  if (b.action === "yoco") {
    if (typeof b.secretKey === "string" && b.secretKey.trim()) await setYoco("secretKey", b.secretKey.trim());
    if (typeof b.webhookSecret === "string" && b.webhookSecret.trim()) await setYoco("webhookSecret", b.webhookSecret.trim());
    if (typeof b.publicUrl === "string") { const u = b.publicUrl.trim().replace(/\/+$/, ""); if (u && !/^https:\/\/[^\s]+$/.test(u)) throw Object.assign(new Error("The public address must start with https://"), { status: 400 }); await setYoco("publicUrl", u); }
    return { ok: true };
  }
  if (b.action === "register") {
    const s = await yocoSettings(true); if (!s.publicUrl) throw Object.assign(new Error("Add the public address first."), { status: 400 });
    const j = await yocoFetch("/webhooks", "POST", { name: "JoolzApp paid apps", url: s.publicUrl.replace(/\/+$/, "") + "/yoco/webhook" });
    if (j.secret) await setYoco("webhookSecret", j.secret);
    return { ok: true, hasSecret: !!j.secret };
  }
  if (b.action === "config") { await setConfig(b.slug, b.cfg === null ? null : b.cfg, adminPerson); return { ok: true }; }
  if (b.action === "grant") {
    const u = await findPerson(b.identity); if (!u) throw Object.assign(new Error("No account with that email or username."), { status: 404 });
    const days = b.days ? Math.max(1, Math.round(Number(b.days))) : 0;
    await grant(u.id, cleanSlug(b.slug), { days, via: "admin" }); return { ok: true, name: u.name || u.email };
  }
  if (b.action === "revoke") { await revoke(String(b.userId || "").replace(/[^A-Za-z0-9]/g, ""), cleanSlug(b.slug)); return { ok: true }; }
  throw Object.assign(new Error("Unknown action"), { status: 400 });
}
async function status(user, slug) {
  const es = (await list(entAny(cleanSlug(slug), user.id))).filter(live);
  return { active: es.length > 0, until: es.some(e => !e.value.until) ? null : es.map(e => e.value.until).sort().pop() || null };
}
module.exports = { forPerson, startPayment, handleWebhook, verifySignature, sweep, adminView, adminAction, status };
