"use strict";
// Guardian approvals (under-18s) run inside Portal Admin, one copy for every app. Without a Portal API key (or if Portal Admin can't help
// and this app still has its own PocketBase login) the app runs its own copy, guardians-legacy.js, as before.
// The pure age helpers (validDob, ageOf, isMinor) always run here. This file is the same in every JoolzApp app.
const legacy = require("./guardians-legacy"), pb = require("./pocketbase");
const ASYNC = ["createdByParent", "adminDecide", "statusOf", "checkParents", "requestApproval", "requestFamily", "inbox", "decide", "revoke"];
const out = { ...legacy };
for (const n of ASYNC) if (typeof legacy[n] === "function") out[n] = async (...a) => {
  if (!pb.portalOn()) return legacy[n](...a);
  try { return await pb.portalCall("guardians." + n, a); }
  catch (e) { if (pb.portalFallback(e)) return legacy[n](...a); throw e; }
};
module.exports = out;
