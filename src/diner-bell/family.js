"use strict";
// Families (who is in the household, shared family orders) are kept by Portal Admin, one copy for every app. Without a Portal API key
// (or if Portal Admin can't help and this app still has its own PocketBase login) the app runs its own older copy, family-legacy.js.
const legacy = require("./family-legacy"), pb = require("./pocketbase");
const VIA = ["mine", "linkedIds", "addOrder", "listOrders", "removeOrder"];
const slim = a => a.map((x, i) => (i === 0 && x && typeof x === "object" && x.id ? { id: x.id, email: x.email || "", name: x.name || "" } : x));
const out = { ...legacy };
for (const n of VIA) out[n] = async (...a) => {
  if (!pb.portalOn()) return legacy[n](...a);
  try { const r = await pb.portalCall("family." + n, slim(a)); return n === "linkedIds" ? new Set(Array.isArray(r) ? r : []) : r; }
  catch (e) { if (pb.portalFallback(e)) return legacy[n](...a); throw e; }
};
module.exports = out;
