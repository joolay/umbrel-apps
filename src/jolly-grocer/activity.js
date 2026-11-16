"use strict";
// Tells Portal Admin that someone just used this app (at most once every 6 hours per person), so accounts nobody has used for a year can be
// reviewed. It uses the app's Portal API key and never slows down or breaks the app: if Portal Admin can't be reached it just tries again later.
const seen = new Map();
exports.touch = function touch(userId) {
  const url = String(process.env.POCKETBASE_PORTAL_URL || "").replace(/\/+$/, ""), key = process.env.POCKETBASE_PORTAL_KEY || "";
  if (!url || !key || !userId) return;
  const now = Date.now();
  if (now - (seen.get(userId) || 0) < 6 * 3600e3) return;
  seen.set(userId, now); if (seen.size > 5000) seen.clear();
  fetch(url + "/app-api/call", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + key }, body: JSON.stringify({ fn: "touchActive", args: [userId] }), signal: AbortSignal.timeout(5000) })
    .then(r => { if (!r.ok) seen.delete(userId); }).catch(() => seen.delete(userId));
};
