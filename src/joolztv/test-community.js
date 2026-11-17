// Skip points from the community databases (community.js): the answers of both services, merged and sanity-checked, and the server route.
"use strict";
const http = require("http");
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log("FAIL", m); } else console.log("ok  ", m); };
const hits = []; const INTRO = { "tt0371746": { imdb_id: "tt0371746", is_movie: true, intro: null, recap: null, outro: { start_ms: 7038000, end_ms: 7540000, confidence: 1 }, post_credits: { start_ms: 7540000, end_ms: 7580000, confidence: 1 }, no_intro: true, no_outro: false },
  "tt0903747:1:1": { intro: null, outro: { start_ms: 3431000, end_ms: 3500000, confidence: 1 }, post_credits: null, no_intro: true },
  "tt0000001:2:3": { intro: { start_ms: 2500, end_ms: 58000, confidence: 0.92 }, outro: null, post_credits: null, no_intro: false } };
const THE = { "tt0903747:1:1": { tvdb_id: 81189, type: "tv", intro: [{ start_ms: 228665, end_ms: 246498 }], credits: [{ start_ms: 3432884, end_ms: null }] },
  "tt0000001:2:3": { intro: [{ start_ms: null, end_ms: 40000 }], credits: [{ start_ms: 2700000, end_ms: null }] },
  "tt0000009": { type: "movie", intro: [{ start_ms: null, end_ms: 23000 }], credits: [{ start_ms: 5801777, end_ms: 6371111 }, { start_ms: 6408000, end_ms: null }], preview: [{ start_ms: 1680000, end_ms: 1740000 }] } };
const stub = (db, keyOf) => http.createServer((q, r) => {
  const u = new URL(q.url, "http://x"), imdb = u.searchParams.get("imdb_id"), k = imdb + (u.searchParams.get("season") ? ":" + u.searchParams.get("season") + ":" + u.searchParams.get("episode") : "");
  hits.push(q.headers["user-agent"] + " " + q.url);
  if (imdb === "tt0000500") { r.writeHead(500); return r.end(); }
  const j = db[k]; if (!j) { r.writeHead(404); return r.end("{}"); } r.writeHead(200, { "content-type": "application/json" }); r.end(JSON.stringify(j));
});
const s1 = stub(INTRO), s2 = stub(THE);
(async () => {
  await new Promise(r => s1.listen(0, r)); await new Promise(r => s2.listen(0, r));
  process.env.INTRODB_URL = "http://127.0.0.1:" + s1.address().port; process.env.THEINTRODB_URL = "http://127.0.0.1:" + s2.address().port;
  const C = require("./community.js");
  let r = await C.lookup({ imdb: "tt0371746", duration: 7600 });
  ok(r.credits && r.credits.start === 7038 && r.scenes.join() === "7540" && r.intro === null, "a film: credits start and the post-credit scene come from IntroDB (" + JSON.stringify(r.scenes) + ")");
  r = await C.lookup({ imdb: "tt0903747", season: 1, episode: 1, duration: 3500 });
  ok(r.intro && r.intro.start === 228.665 && r.intro.end === 246.498 && r.credits.start === 3431 && r.from.join() === "IntroDB,TheIntroDB", "an episode: both services are used, the earlier credits start wins (" + r.credits.start + ")");
  r = await C.lookup({ imdb: "tt0000001", season: 2, episode: 3, duration: 2800 });
  ok(r.intro.start === 2.5 && r.intro.end === 58 && r.credits.start === 2700, "the intro with the higher confidence is used");
  r = await C.lookup({ imdb: "tt0000009", duration: 6500 });
  ok(r.credits.start === 5801.777 && r.scenes.join() === "6371", "credits that stop and start again leave a scene in the gap (" + r.scenes + ")");
  ok(!r.scenes.some(x => x === 1680), "a 'preview' segment is not taken for a credit scene");
  r = await C.lookup({ imdb: "tt0000009", duration: 5000 });
  ok(r.credits === null && !r.scenes.length, "points beyond the end of the file are thrown out");
  r = await C.lookup({ imdb: "tt0000001", season: 2, episode: 3, duration: 100 });
  ok(r.intro === null || r.intro.end < 60, "an intro that makes no sense for a 100 s file is dropped");
  r = await C.lookup({ imdb: "tt0111111", season: 1, episode: 1, duration: 3000 });
  ok(r.intro === null && r.credits === null && !r.scenes.length && r.from.length === 0, "an unknown title gives nothing (not an error)");
  let err = null; try { await C.lookup({ imdb: "tt0000500", season: 1, episode: 1, duration: 3000 }); } catch (e) { err = e; }
  ok(err && err.code === "unreachable", "both services failing is reported as unreachable");
  r = await C.lookup({ imdb: "../x", duration: 100 }); ok(r.intro === null && !hits.some(h => /\.\.\/x/.test(h)), "a bad id is never sent anywhere");
  ok(hits.every(h => /^JoolzTV /.test(h)) && hits.every(h => !/@|email|token/i.test(h)), "only the IMDb id, season and episode are sent, under a generic client name");
  const q = hits.filter(h => /tt0903747/.test(h)); ok(q.some(h => /is_movie/.test(h)) === false && q.every(h => /season=1&episode=1/.test(h)), "an episode is asked for by season and episode");
  s1.close(); s2.close();
  console.log(fails ? fails + " FAILED" : "ALL PASSED"); process.exit(fails ? 1 : 0);
})().catch(e => { console.log("ERROR", e.stack); process.exit(1); });
