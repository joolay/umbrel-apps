// Tells the LG TV launcher which version of itself is the newest. The launcher asks right after it connects (/tv/update);
// if it is behind, it asks the TV Updater service to install the new IPK. This is only a hint: the updater re-reads the
// Homebrew feed itself and checks sha256 before installing, so nothing the server says can make the TV install anything.
// The answer comes from the same manifest Homebrew Channel uses (joolay/homebrew), cached, so releasing a new launcher
// needs no server update. Public like /healthz: it holds nothing private.
"use strict";
const https = require("https"), http = require("http");
const MANIFEST = process.env.TV_MANIFEST_URL || "https://raw.githubusercontent.com/joolay/homebrew/main/webosbrew/manifest-flix.json";
const TTL = +process.env.TV_UPDATE_TTL_MS || 3600e3, RETRY = 5 * 60e3, ID = "io.stremio.flix.tv";
let cache = null, at = 0, fails = 0, pending = null;

function fetchJson(url) {
  return new Promise((ok, bad) => {
    const lib = url.startsWith("http:") ? http : https;
    const req = lib.get(url, { headers: { "user-agent": "joolztv-server" }, timeout: 10000 }, res => {
      if (res.statusCode !== 200) { res.resume(); return bad(new Error("HTTP " + res.statusCode)); }
      let s = ""; res.setEncoding("utf8");
      res.on("data", c => { s += c; if (s.length > 64 * 1024) { req.destroy(); bad(new Error("too large")); } });
      res.on("end", () => { try { ok(JSON.parse(s)); } catch (e) { bad(e); } });
    });
    req.on("timeout", () => req.destroy(new Error("timeout"))); req.on("error", bad);
  });
}
const clean = v => (typeof v === "string" && /^\d+(\.\d+){0,3}$/.test(v) ? v : null);

// { id, version } or { id, version: null } when the feed has never been reachable. A stale copy beats an error.
async function latest() {
  const now = Date.now();
  if (cache && now - at < (fails ? RETRY : TTL)) return cache;
  if (!pending) pending = fetchJson(MANIFEST).then(m => {
    const v = m && m.id === ID ? clean(m.version) : null;
    if (!v) throw new Error("manifest has no usable version");
    cache = { id: ID, version: v }; at = Date.now(); fails = 0;
  }).catch(() => { fails++; at = Date.now(); }).finally(() => { pending = null; });
  await pending;
  return cache || { id: ID, version: null };
}
function _reset() { cache = null; at = 0; fails = 0; pending = null; }
module.exports = { latest, _reset, ID };
