// tmdb.js cache: on disk, LRU roll-over, refreshed from the daily /changes feed, stale copy served on errors, 429 retry, call cap, de-duplication.
"use strict";
const http = require("http"), fs = require("fs"), os = require("os"), path = require("path");
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log("FAIL", m); } else console.log("ok  ", m); };
const hits = []; let mode = "ok", fly = 0, maxFly = 0, delay = 0, rate = 0, changed = [];
const srv = http.createServer((q, r) => {
  const u = new URL(q.url, "http://x"); hits.push(u.pathname);
  fly++; maxFly = Math.max(maxFly, fly);
  setTimeout(() => {
    fly--;
    if (mode === "500") { r.writeHead(500); return r.end("x"); }
    if (rate > 0) { rate--; r.writeHead(429, { "retry-after": "0" }); return r.end("{}"); }
    r.writeHead(200, { "content-type": "application/json" });
    if (/\/changes$/.test(u.pathname)) return r.end(JSON.stringify({ results: changed.map(id => ({ id })), page: 1, total_pages: 1 }));
    r.end(JSON.stringify({ path: u.pathname, n: hits.length }));
  }, delay);
});
const fresh = () => { Object.keys(require.cache).forEach(k => { if (/\/tmdb\.js$/.test(k)) delete require.cache[k]; }); return require("./tmdb.js"); };
(async () => {
  await new Promise(r => srv.listen(0, r));
  process.env.TMDB_URL = "http://127.0.0.1:" + srv.address().port; process.env.TMDB_KEY = "goodkey1234567890abcd"; process.env.JTV_TMDB_MAX_ENTRIES = "4"; process.env.JTV_TMDB_FLY = "3";
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tc-")), "cache.json");
  let T = fresh(); T.configure(null, null, file);
  let a = await T._call("/movie/1", {}), b = await T._call("/movie/1", {}); ok(a.n === b.n && hits.length === 1, "a repeat is answered from the cache");
  T.cacheSave(); T = fresh(); T.configure(null, null, file); const n0 = hits.length; b = await T._call("/movie/1", {}); ok(hits.length === n0 && b.n === a.n, "the cache survives a restart (it is on disk)");
  await T._call("/movie/2", {}); await T._call("/movie/3", {}); await T._call("/movie/4", {}); await T._call("/movie/1", {}); await T._call("/movie/5", {});       // 1 was used again, so 2 rolls out first
  const h1 = hits.length; await T._call("/movie/1", {}); ok(hits.length === h1, "an entry used recently stays when the cache is full");
  await T._call("/movie/2", {}); ok(hits.length === h1 + 1, "the least recently used entry rolled out and is fetched again");
  ok(T.cacheStats().entries <= 4, "the cache stays within its limit (" + T.cacheStats().entries + ")");
  // the daily changes feed marks only the changed titles
  await T._call("/movie/5", {}); changed = [5]; const h2 = hits.length; const sw = await T.sweep(); ok(sw && sw.changed >= 1 && sw.marked === 1, "the changes sweep marks the changed title (" + JSON.stringify(sw) + ")");
  const h3 = hits.length; await T._call("/movie/5", {}); ok(hits.length === h3 + 1, "a changed title is fetched again");
  const h4 = hits.length; await T._call("/movie/1", {}).catch(() => {}); ok(hits.length === h4, "an unchanged title is still served from the cache");
  // an old copy beats an error
  changed = [5]; await T.sweep(); mode = "500"; const old = await T._call("/movie/5", {}); ok(old && old.path === "/movie/5", "TMDB failing: the older copy is served instead of an error"); mode = "ok";
  e = null; var e = null; mode = "500"; try { await T._call("/movie/999", {}); } catch (x) { e = x; } ok(e && e.code === "upstream", "nothing cached and TMDB failing: the error is reported"); mode = "ok";
  // 429: one retry
  rate = 1; const h5 = hits.length; const r429 = await T._call("/movie/70", {}); ok(r429.path === "/movie/70" && hits.length === h5 + 2, "a 429 is retried once");
  rate = 99; e = null; try { await T._call("/movie/71", {}); } catch (x) { e = x; } ok(e && e.code === "busy", "still 429: reported as busy"); rate = 0;
  const h6 = hits.length; e = null; try { await T._call("/movie/72", {}); } catch (x) { e = x; } ok(e && e.code === "busy" && hits.length === h6, "after repeated 429s calls pause instead of hammering TMDB");
  T = fresh(); T.configure(null, null, file);
  // call cap and de-duplication
  delay = 80; maxFly = 0; const h7 = hits.length; await Promise.all(Array.from({ length: 10 }, (_, i) => T._call("/movie/" + (100 + i), {}))); ok(maxFly <= 3 && hits.length === h7 + 10, "at most 3 calls at once (peak " + maxFly + ")");
  const h8 = hits.length; await Promise.all(Array.from({ length: 6 }, () => T._call("/tv/200", {}))); ok(hits.length === h8 + 1, "the same question asked at once is sent once");
  srv.close(); console.log(fails ? fails + " FAILED" : "ALL PASSED"); process.exit(fails ? 1 : 0);
})().catch(e => { console.log("ERROR", e.stack); process.exit(1); });
