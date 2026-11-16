"use strict";
// Talks to Portal API (inside Portal Admin) instead of PocketBase. The app needs only POCKETBASE_PORTAL_URL and POCKETBASE_PORTAL_KEY,
// both written into its data folder by Portal Admin > Changes. Same functions and errors as pocketbase.js, so the app code doesn't change.
const FNS = ["portalUrl", "requestPasswordReset", "setUserPrefs", "portalAvailable", "setPortalAccess", "signupsOpen", "login", "verifyToken", "createUser", "listUsers", "getUser", "updateUser", "updateAccess", "deleteUser", "countAdmins", "findByEmail", "firstAdmin"];
module.exports = function portalClient(PBError) {
  const URL_BASE = (process.env.POCKETBASE_PORTAL_URL || "").replace(/\/+$/, ""), KEY = process.env.POCKETBASE_PORTAL_KEY || "";
  async function call(fn, args) {
    let r;
    try { r = await fetch(URL_BASE + "/app-api/call", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + KEY }, body: JSON.stringify({ fn, args }), signal: AbortSignal.timeout(30000) }); }
    catch (e) { throw new PBError(0, "Can't reach Portal Admin at " + URL_BASE + " (" + (e.cause?.code || e.message) + ")"); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new PBError(r.status, j.message || "Portal API error " + r.status), { portalDenied: r.status === 401 });
    if (!j.ok) throw new PBError(j.status || 500, j.message || "Portal API error", j.data);
    return j.result;
  }
  return Object.fromEntries(FNS.map((fn) => [fn, (...args) => call(fn, args)]));
};
