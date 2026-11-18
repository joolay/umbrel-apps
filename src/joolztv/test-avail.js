// avail.js: only titles with at least one source are kept; unknown stays (if it has artwork); no artwork needs a confirmed source.
"use strict";
const A = require("./avail.js");
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log("FAIL", m); } else console.log("ok  ", m); };
(async () => {
  const sources = { tt1: 3, tt2: 0, tt3: "down", tt4: 2, tt5: 0 }, hits = [];
  const tmdb = { resolve: async ({ tmdb: id, type }) => { if (id === 99) throw new Error("no imdb"); return { imdb: "tt" + id, type }; } };
  const fetchImpl = async (u) => { hits.push(u); const m = /\/stream\/(movie|series)\/(tt\d)/.exec(u); const v = sources[m[2]]; if (v === "down") throw new Error("down"); return { ok: true, json: async () => ({ streams: Array.from({ length: v }, () => ({})) }) }; };
  const a = A.make({ tmdb, fetchImpl });
  const items = [{ tmdb: 1, type: "movie", poster: "p" }, { tmdb: 2, type: "movie", poster: "p" }, { tmdb: 3, type: "movie", poster: "p" }, { tmdb: 4, type: "series", poster: "" }, { tmdb: 5, type: "movie", poster: "" }, { tmdb: 99, type: "movie", poster: "p" }, { tmdb: 98, type: "movie", poster: "" }];
  sources.tt98 = 0; const out = await a.filter(items, { base: "http://s" });
  const ids = out.map(x => x.tmdb).sort((x, y) => x - y).join();
  ok(ids === "1,3,4,99", "kept: has a source (1), add-on down but has artwork (3), no artwork but confirmed (4), imdb id unknown but artwork (99)");
  ok(!/\b2\b/.test(ids) && !/\b5\b/.test(ids) && !/98/.test(ids), "dropped: add-on says nothing (2), nothing and no artwork (5, 98)");
  ok(hits.some(u => /series\/tt4%3A1%3A1\.json/.test(u)), "a series is checked through its first episode");
  const n = hits.length; await a.filter(items, { base: "http://s" }); ok(hits.length - n <= 2, "answers are remembered (only the 'could not ask' ones are asked again)");
  ok((await a.filter(items, { base: "" })).length === items.length, "no sources add-on configured: nothing is filtered");
  const sp = await a.split(items.map(x => Object.assign({}, x, { release: x.tmdb === 2 ? "2999-01-01" : "2001-01-01" })), { base: "http://s" });
  ok(sp.other.length === 3 && sp.other.filter(x => x.why === "soon").length === 1 && sp.other.filter(x => x.why === "none").length === 2, "split: the left-out titles come back, a future date is 'soon', the rest 'none'");
  console.log(fails ? fails + " FAILED" : "ALL PASSED"); process.exit(fails ? 1 : 0);
})();
