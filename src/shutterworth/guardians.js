"use strict";
// Guardian approvals (under-18s) now run inside Portal Admin, one copy for every app. Without a Portal API key this app runs its own
// copy (guardians-legacy.js) as before. The pure age helpers (validDob, ageOf, isMinor) always run here.
const legacy = require("./guardians-legacy"), pb = require("./pocketbase");
const ASYNC = ["createdByParent", "adminDecide", "statusOf", "checkParents", "requestApproval", "requestFamily", "inbox", "decide", "revoke"];
const out = { ...legacy };
if (pb.portalCall) for (const n of ASYNC) out[n] = async (...a) => {
  try { return await pb.portalCall("guardians." + n, a); }
  catch (e) { if (e.portalDenied && pb.enabled) return legacy[n](...a); throw e; }
};
module.exports = out;
