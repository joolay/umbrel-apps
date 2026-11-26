"use strict";
// Talks to Portal API (inside Portal Admin) instead of PocketBase. The app needs only POCKETBASE_PORTAL_URL and POCKETBASE_PORTAL_KEY,
// both written into its data folder by Portal Admin > Changes. Same functions and errors as pocketbase.js, so the app code doesn't change.
// This file is the same in every JoolzApp app.
const FNS = ["portalUrl", "requestPasswordReset", "setUserPrefs", "portalAvailable", "setPortalAccess", "signupsOpen", "login", "verifyToken", "createUser", "listUsers", "getUser", "updateUser", "updateAccess", "deleteUser", "countAdmins", "findByEmail", "firstAdmin",
  "trialUsed", "trialBump", "setDob", "getAppPref", "setAppPref", "clearAppPref"];
module.exports = function portalClient(PBError) {
  const URL_BASE = (process.env.POCKETBASE_PORTAL_URL || "").replace(/\/+$/, ""), KEY = process.env.POCKETBASE_PORTAL_KEY || "";
  // `as` is the signed-in person's own token. Portal Admin insists on an admin's token for admin work (listing, changing or deleting people).
  async function call(fn, args, as) {
    let r;
    try { r = await fetch(URL_BASE + "/app-api/call", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + KEY }, body: JSON.stringify(as ? { fn, args, as } : { fn, args }), signal: AbortSignal.timeout(30000) }); }
    catch (e) { throw new PBError(0, "Can't reach Portal Admin at " + URL_BASE + " (" + (e.cause?.code || e.message) + ")"); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new PBError(r.status, j.message || "Portal API error " + r.status), { portalDenied: r.status === 401 });
    // An older Portal Admin doesn't know newer functions yet: the caller can fall back to its own copy until Portal Admin is updated.
    if (!j.ok) throw Object.assign(new PBError(j.status || 500, j.message || "Portal API error", j.data), { portalUnknown: j.status === 404 && /^Unknown function/.test(j.message || "") });
    return j.result;
  }
  return { call, fns: Object.fromEntries(FNS.map((fn) => [fn, (...args) => call(fn, args)])), fnsAs: (as) => Object.fromEntries(FNS.map((fn) => [fn, (...args) => call(fn, args, as)])) };
};
module.exports.FNS = FNS;
