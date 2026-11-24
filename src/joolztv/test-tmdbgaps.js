// tmdb.js: missing details are filled from Cinemeta, marked as fallback, and replaced once TMDB has them (also by the cache backfill).
"use strict";
const http = require("http"), fs = require("fs"), os = require("os"), path = require("path");
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log("FAIL", m); } else console.log("ok  ", m); };
let full = false, cineDown = false;
const sparse = { id: 1, title: "New Film", overview: "", genres: [], runtime: 0, credits: { cast: [], crew: [] }, release_dates: { results: [] }, external_ids: { imdb_id: "tt1" }, images: { logos: [] }, keywords: { keywords: [] }, recommendations: { results: [] } };
const done = { id: 1, title: "New Film", overview: "From TMDB", genres: [{ id: 18, name: "Drama" }], runtime: 101, credits: { cast: [{ id: 5, name: "Real Actor", character: "Lead", profile_path: "/a.jpg" }], crew: [{ id: 6, name: "Real Director", job: "Director" }] },
  release_dates: { results: [{ iso_3166_1: "GB", release_dates: [{ certification: "12A" }] }] }, external_ids: { imdb_id: "tt1" }, images: { logos: [] }, keywords: { keywords: [] }, recommendations: { results: [] } };
const srv = http.createServer((q, r) => {
  const u = new URL(q.url, "http://x"), js = o => { r.writeHead(200, { "content-type": "application/json" }); r.end(JSON.stringify(o)); };
  if (/^\/meta\//.test(u.pathname)) { if (cineDown) { r.writeHead(500); return r.end("x"); } return js({ meta: { runtime: "1h 35min", genres: ["Thriller"], cast: ["Fall Back"], director: ["Fall Director"], description: "From Cinemeta", year: 2025, imdbRating: "7.1" } }); }
  if (u.pathname === "/find/tt1") return js({ movie_results: [{ id: 1 }], tv_results: [] });
  if (/^\/find\//.test(u.pathname)) return js({ movie_results: [], tv_results: [] });
  if (u.pathname === "/movie/1") return js(full ? done : sparse);
  r.writeHead(404); r.end("{}");
});
(async () => {
  await new Promise(r => srv.listen(0, r)); const base = "http://127.0.0.1:" + srv.address().port;
  process.env.TMDB_URL = base; process.env.CINEMETA_URL = base; process.env.TMDB_KEY = "goodkey1234567890abcd"; process.env.TMDB_IMG = "https://img.test/t/p/";
  const T = require("./tmdb.js"); const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tg-")), "c.json"); T.configure(null, null, file);
  ok(T.minutes("136 min") === 136 && T.minutes("2h 16min") === 136 && T.minutes("1h") === 60 && T.minutes("") === null, "runtime text becomes minutes");
  let t = await T.title({ imdb: "tt1", type: "movie", region: "GB" });
  ok(t.runtime === 95 && t.genres[0].name === "Thriller" && t.cast[0].name === "Fall Back" && t.directors[0].name === "Fall Director" && t.overview === "From Cinemeta", "TMDB has nothing: runtime, genres, cast, director and summary come from Cinemeta");
  ok(t.fallback.indexOf("runtime") >= 0 && t.missing.join() === "cert" && t.partial === true, "the answer says what came from the fallback and what is still missing (age rating: " + t.missing + ")");
  ok(T.cacheStats().withGaps >= 1, "the bare entry is noted as having gaps");
  full = true; const bf = await T.backfill(); ok(bf && bf.updated >= 1 && bf.completed >= 1, "backfill asks TMDB again and the entry is complete now (" + JSON.stringify(bf) + ")");
  t = await T.title({ imdb: "tt1", type: "movie", region: "GB" });
  ok(t.runtime === 101 && t.genres[0].name === "Drama" && t.cast[0].name === "Real Actor" && t.cert && t.cert.rating === "12A" && t.fallback.length === 0 && !t.partial && t.overview === "From TMDB", "once TMDB has the details they replace the fallback (and the age rating appears)");
  t = await T.title({ imdb: "tt404", type: "movie", region: "GB" });
  ok(t.partial && t.tmdb === null && t.runtime === 95 && t.cast.length === 1, "TMDB does not know the title at all: Cinemeta's details are still shown");
  cineDown = true; let e = null; try { await T.title({ imdb: "tt405", type: "movie" }); } catch (x) { e = x; } ok(e && e.code === "not_found", "both sources empty: the old 'not found' is reported");
  srv.close(); console.log(fails ? fails + " FAILED" : "all passed"); process.exit(fails ? 1 : 0);
})();
