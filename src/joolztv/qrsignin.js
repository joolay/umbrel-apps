// QR sign-in for the TV: shows a code, a signed-in phone approves it in the JoolzApp Store, and the person is signed in here exactly as
// if they had typed their email and password (same account checks afterwards). Portal Admin keeps the request and says WHO approved;
// this module only remembers the secret that proves the poller is the screen that asked, and hands an approval out once.
"use strict";
const crypto = require("crypto"), qrcode = require("./qr");
const sha = s => crypto.createHash("sha256").update(String(s)).digest();
const WAIT_MS = 125e3, MAX = 200;

module.exports = function makeQrSignin({ portalCall, portalUrl, now = Date.now }) {
  const reqs = new Map();   // id -> { secretHash, created, userId }
  const sweep = () => { const t = now(); for (const [id, r] of reqs) if (t - r.created > WAIT_MS) reqs.delete(id); };
  const bad = (status, code, message) => Object.assign(new Error(message), { status, code });

  async function start(label) {
    sweep(); if (reqs.size >= MAX) throw bad(503, "busy", "Too many sign-ins are waiting. Try again in a minute.");
    const base = String((await portalUrl()) || process.env.JOOLZAPP_URL || "").replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(base)) throw bad(503, "no_portal_url", "QR sign-in needs the JoolzApp address. Ask the admin to set it in Portal Admin (setting portal.url).");
    let r; try { r = await portalCall("qr.start", [{ label }]); } catch (e) { throw bad(e.status === 429 ? 429 : 503, "qr_unavailable", e.status === 429 ? "Too many QR codes. Wait a minute." : "QR sign-in isn't available right now. Use your email and password."); }
    reqs.set(r.id, { secretHash: sha(r.secret), created: now(), userId: "" });
    const url = base + "/#/qr/" + r.id;
    return { id: r.id, secret: r.secret, expiresIn: r.expiresIn, url, svg: qrcode.svg(url, 360) };
  }
  const mine = (id, secret) => { const r = reqs.get(String(id)); return r && crypto.timingSafeEqual(sha(secret), r.secretHash) ? r : null; };

  async function poll(id, secret) {
    sweep(); const r = mine(id, secret); if (!r) return { status: "expired" };
    if (r.userId) return { status: "approved" };
    let p; try { p = await portalCall("qr.poll", [String(id), String(secret)]); } catch { return { status: "pending" }; }   // a hiccup: keep waiting
    if (p.status === "approved" && p.userId) { r.userId = String(p.userId); return { status: "approved" }; }
    if (p.status === "pending") return { status: "pending" };
    reqs.delete(String(id)); return { status: p.status === "denied" ? "denied" : "expired" };
  }
  // The sign-in itself: an approved request is used once. Returns the person's id.
  function claim(id, secret) {
    const r = mine(id, secret);
    if (!r || !r.userId) throw bad(400, "bad_login", "That QR code isn't approved or has expired. Try again.");
    reqs.delete(String(id)); return r.userId;
  }
  return { start, poll, claim, _size: () => reqs.size };
};
