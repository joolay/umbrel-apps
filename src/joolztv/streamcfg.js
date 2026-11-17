// The streaming server's own settings (its cache size), through its HTTP API: GET /settings and POST /settings. The image documents neither,
// so everything is verified by reading the value back.
"use strict";
const GIB = 1073741824, DEFAULT = 50 * GIB;
async function values(base) {
  const r = await fetch(base + "/settings", { signal: AbortSignal.timeout(6000) });
  if (!r.ok) throw Object.assign(new Error("HTTP " + r.status), { code: "upstream" });
  const j = await r.json(); return j && j.values ? j.values : j;
}
/* asks for a cache of `bytes`, then reads the setting back: {requested, reported, ok} */
async function setCache(base, bytes) {
  const cur = await values(base);
  const next = Object.assign({}, cur, { cacheSize: bytes });
  const r = await fetch(base + "/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(next), signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw Object.assign(new Error("HTTP " + r.status), { code: "refused" });
  const now = await values(base), rep = now.cacheSize;
  return { requested: bytes, reported: rep === undefined ? null : rep, ok: Number(rep) === bytes };
}
module.exports = { values, setCache, GIB, DEFAULT };
