// TMDB (themoviedb.org) as a second source of film and TV information: artwork and logos, summaries in your language, age ratings,
// cast, collections, recommendations, trending / popular / now playing lists, discover by genre and year, people, episode stills.
// The key stays on this server (env TMDB_KEY or <data>/tmdb.key); the TV never sees it. Without a key every function reports "off" and the app carries on with Cinemeta.
"use strict";
const fs = require("fs");
const API = process.env.TMDB_URL || "https://api.themoviedb.org/3";
const IMG = process.env.TMDB_IMG || "https://image.tmdb.org/t/p/";
let keyFile = null, memKey = (process.env.TMDB_KEY || "").trim();
const cache = new Map();

function configure(file) { keyFile = file; if (!memKey) { try { memKey = fs.readFileSync(file, "utf8").trim(); } catch {} } }
function setKey(k) {                                  // admin pastes a key in Settings; it is stored on the server only
  k = String(k || "").trim();
  if (k && !/^[\w.\-]{16,800}$/.test(k)) throw Object.assign(new Error("That does not look like a TMDB key."), { code: "bad_key" });
  memKey = k; cache.clear();
  if (keyFile) { if (k) fs.writeFileSync(keyFile, k, { mode: 0o600 }); else { try { fs.unlinkSync(keyFile); } catch {} } }
}
const enabled = () => !!memKey;

async function call(path, params, ttl = 12 * 3600e3) {
  if (!memKey) throw Object.assign(new Error("TMDB is not set up"), { code: "off" });
  const q = new URLSearchParams(params || {}); const bearer = memKey.indexOf(".") > 0;       // a v4 read token is a JWT, a v3 key is plain hex
  if (!bearer) q.set("api_key", memKey);
  const url = API + path + "?" + q.toString(), hit = cache.get(url);
  if (hit && Date.now() - hit.at < ttl) return hit.v;
  const r = await fetch(url, { headers: Object.assign({ accept: "application/json", "user-agent": "JoolzTV" }, bearer ? { authorization: "Bearer " + memKey } : {}), signal: AbortSignal.timeout(10000) });
  if (r.status === 401) throw Object.assign(new Error("TMDB refused the key"), { code: "bad_key" });
  if (r.status === 404) throw Object.assign(new Error("not found"), { code: "not_found" });
  if (r.status === 429) throw Object.assign(new Error("TMDB is busy"), { code: "busy" });
  if (!r.ok) throw Object.assign(new Error("TMDB answered " + r.status), { code: "upstream" });
  const v = await r.json(); if (cache.size > 800) cache.delete(cache.keys().next().value); cache.set(url, { at: Date.now(), v }); return v;
}
const img = (p, size) => (p ? IMG + size + p : "");
const L = (o, region) => ({ language: o.locale || "en-US", region: region || undefined });
const clean = o => { const r = {}; Object.keys(o).forEach(k => { if (o[k] !== undefined && o[k] !== null && o[k] !== "") r[k] = o[k]; }); return r; };

/* ---- age ratings -> the youngest age a title is meant for ---- */
const AGE = {
  GB: { U: 0, UC: 0, PG: 8, "12": 12, "12A": 12, "15": 15, "18": 18, R18: 18 },
  ZA: { A: 0, "ALL": 0, PG: 8, "7": 7, "7-9": 7, "7-9PG": 7, "10": 10, "10-12": 10, "10-12PG": 10, "13": 13, "16": 16, "18": 18, X18: 18, R18: 18 },
  US: { G: 0, PG: 8, "PG-13": 13, R: 17, "NC-17": 18, NR: null, "TV-Y": 0, "TV-Y7": 7, "TV-Y7-FV": 7, "TV-G": 0, "TV-PG": 8, "TV-14": 14, "TV-MA": 17 },
  DE: { "0": 0, "6": 6, "12": 12, "16": 16, "18": 18 }, FR: { U: 0, "10": 10, "12": 12, "16": 16, "18": 18 }, NL: { AL: 0, "6": 6, "9": 9, "12": 12, "14": 14, "16": 16, "18": 18 },
  AU: { G: 0, PG: 8, M: 14, "MA15+": 15, "R18+": 18 }, CA: { G: 0, PG: 8, "14A": 14, "18A": 18, R: 18 }
};
function certAge(region, rating) {
  const t = AGE[region] || null, key = String(rating || "").trim().toUpperCase().replace(/\s+/g, "");
  if (!key) return null;
  const k2 = Object.keys(t || {}).filter(x => x.toUpperCase() === key)[0];
  if (t && k2 !== undefined) return t[k2];
  const m = /^(\d{1,2})\+?$/.exec(key); return m ? +m[1] : null;           // "16", "16+": a number is an age
}
/* the rating that applies in the person's country, falling back to the UK, then the US */
function pickCert(d, type, region) {
  const rows = type === "tv"
    ? ((d.content_ratings && d.content_ratings.results) || []).map(x => ({ r: x.iso_3166_1, c: x.rating }))
    : ((d.release_dates && d.release_dates.results) || []).map(x => ({ r: x.iso_3166_1, c: ((x.release_dates || []).filter(y => y.certification)[0] || {}).certification }));
  for (const reg of [region, "GB", "US"]) { const row = rows.filter(x => x.r === reg && x.c)[0]; if (row) return { region: reg, rating: row.c, age: certAge(reg, row.c) }; }
  return null;
}

/* ---- normalising ---- */
const card = (x, type) => ({ tmdb: x.id, type: (x.media_type || type) === "tv" ? "series" : "movie", name: x.title || x.name || "", poster: img(x.poster_path, "w342"), background: img(x.backdrop_path, "w780"),
  year: String(x.release_date || x.first_air_date || "").slice(0, 4), rating: x.vote_average ? Math.round(x.vote_average * 10) / 10 : null, description: x.overview || "" });
const STINGER = /credits?\s*stinger|post.?credits?\s*scene|mid.?credits?\s*scene/i;

async function find(imdb) {
  const j = await call("/find/" + encodeURIComponent(imdb), { external_source: "imdb_id" }, 7 * 864e5);
  const m = (j.movie_results || [])[0], t = (j.tv_results || [])[0];
  return m ? { tmdb: m.id, type: "movie" } : t ? { tmdb: t.id, type: "tv" } : null;
}
async function title({ imdb, tmdb, type, locale, region }) {
  let id = tmdb, t = type === "series" ? "tv" : type === "tv" ? "tv" : "movie";
  if (!id) { const f = await find(imdb); if (!f) throw Object.assign(new Error("not found"), { code: "not_found" }); id = f.tmdb; t = f.type; }
  const append = t === "tv" ? "images,credits,content_ratings,keywords,recommendations,external_ids" : "images,credits,release_dates,keywords,recommendations,external_ids";
  const d = await call("/" + t + "/" + id, clean({ language: locale || "en-US", append_to_response: append, include_image_language: ((locale || "en").slice(0, 2)) + ",en,null" }));
  const logos = ((d.images && d.images.logos) || []).slice().sort((a, b) => (b.vote_average || 0) - (a.vote_average || 0));
  const logo = logos.filter(l => l.iso_639_1 === (locale || "en").slice(0, 2))[0] || logos.filter(l => l.iso_639_1 === "en")[0] || logos[0];
  const kw = ((d.keywords && (d.keywords.keywords || d.keywords.results)) || []);
  const stinger = { during: kw.some(k => k.id === 179431 || /during.?credits?\s*stinger/i.test(k.name)), after: kw.some(k => k.id === 179430 || /after.?credits?\s*stinger/i.test(k.name)) };
  const crew = (d.credits && d.credits.crew) || [], dir = crew.filter(c => c.job === "Director").slice(0, 2).map(c => ({ id: c.id, name: c.name }));
  const creators = (d.created_by || []).slice(0, 2).map(c => ({ id: c.id, name: c.name }));
  const ne = d.next_episode_to_air;
  return {
    tmdb: d.id, type: t === "tv" ? "series" : "movie", imdb: (d.external_ids && d.external_ids.imdb_id) || imdb || "", tvdb: (d.external_ids && d.external_ids.tvdb_id) || null,
    name: d.title || d.name || "", original: d.original_title || d.original_name || "", tagline: d.tagline || "", overview: d.overview || "",
    genres: (d.genres || []).map(g => ({ id: g.id, name: g.name })), runtime: d.runtime || (d.episode_run_time && d.episode_run_time[0]) || null,
    year: String(d.release_date || d.first_air_date || "").slice(0, 4), rating: d.vote_average ? Math.round(d.vote_average * 10) / 10 : null, status: d.status || "",
    cert: pickCert(d, t, region), logo: logo ? img(logo.file_path, "w500") : "", poster: img(d.poster_path, "w500"), background: img(d.backdrop_path, "w1280"),
    cast: ((d.credits && d.credits.cast) || []).slice(0, 14).map(c => ({ id: c.id, name: c.name, role: c.character || "", photo: img(c.profile_path, "w185") })),
    directors: dir.length ? dir : creators, directorLabel: dir.length ? "Directed by" : "Created by",
    collection: d.belongs_to_collection ? { id: d.belongs_to_collection.id, name: d.belongs_to_collection.name } : null,
    similar: ((d.recommendations && d.recommendations.results) || []).filter(x => x.poster_path).slice(0, 18).map(x => card(x, t)),
    seasons: t === "tv" ? (d.seasons || []).filter(s => s.season_number > 0).map(s => ({ n: s.season_number, name: s.name, episodes: s.episode_count })) : [],
    nextEpisode: ne ? { season: ne.season_number, episode: ne.episode_number, name: ne.name || "", air: ne.air_date || "" } : null,
    network: (d.networks && d.networks[0] && d.networks[0].name) || "", stinger
  };
}
async function season({ tmdb, season, locale }) {
  const d = await call("/tv/" + tmdb + "/season/" + season, clean({ language: locale || "en-US" }));
  return { season: d.season_number, episodes: (d.episodes || []).map(e => ({ episode: e.episode_number, name: e.name || "", overview: e.overview || "", still: img(e.still_path, "w300"), air: e.air_date || "", runtime: e.runtime || null })) };
}
const LISTS = {
  movie: { trending: ["/trending/movie/day"], popular: ["/movie/popular"], top: ["/movie/top_rated"], now: ["/movie/now_playing", true], soon: ["/movie/upcoming", true] },
  tv: { trending: ["/trending/tv/day"], popular: ["/tv/popular"], top: ["/tv/top_rated"], now: ["/tv/on_the_air"], soon: ["/tv/airing_today"] }
};
async function list({ kind, type, locale, region, page }) {
  const t = type === "series" || type === "tv" ? "tv" : "movie", def = LISTS[t][kind]; if (!def) throw Object.assign(new Error("unknown list"), { code: "bad_request" });
  const d = await call(def[0], clean({ language: locale || "en-US", region: def[1] ? region : undefined, page: page || 1 }), 3600e3);
  return { items: (d.results || []).filter(x => x.poster_path).map(x => card(x, t)), pages: d.total_pages || 1 };
}
async function genres({ type, locale }) {
  const t = type === "series" || type === "tv" ? "tv" : "movie", d = await call("/genre/" + t + "/list", clean({ language: locale || "en-US" }), 7 * 864e5);
  return (d.genres || []).map(g => ({ id: g.id, name: g.name }));
}
/* TMDB filters films by a rating NAME ("PG"), in its own order for each country; turn an age into the strictest-fitting highest name (age 9 in the UK: "PG") */
async function maxCert(region, age) {
  const d = await call("/certification/movie/list", {}, 7 * 864e5), all = d.certifications || {}, reg = all[region] ? region : "GB";
  const rows = (all[reg] || []).slice().sort((a, b) => a.order - b.order).filter(c => { const a = certAge(reg, c.certification); return a !== null && a <= age; });
  return { region: reg, cert: rows.length ? rows[rows.length - 1].certification : ((all[reg] || []).slice().sort((a, b) => a.order - b.order)[0] || {}).certification || "" };
}
const SORTS = { popular: "popularity.desc", rating: "vote_average.desc", newest: "primary_release_date.desc", az: "original_title.asc" };
async function discover({ type, genre, year, sort, locale, region, page, maxAge }) {
  const t = type === "series" || type === "tv" ? "tv" : "movie", s = SORTS[sort] || SORTS.popular;
  const p = clean({ language: locale || "en-US", page: page || 1, with_genres: /^\d+$/.test(String(genre || "")) ? genre : undefined,
    sort_by: t === "tv" ? s.replace("primary_release_date", "first_air_date").replace("original_title", "name") : s, "vote_count.gte": sort === "rating" ? 200 : undefined });
  if (/^\d{4}$/.test(String(year || ""))) p[t === "tv" ? "first_air_date_year" : "primary_release_year"] = year;
  if (t === "movie" && maxAge != null) { const c = await maxCert(region || "GB", maxAge); if (c.cert) { p.certification_country = c.region; p["certification.lte"] = c.cert; } }      // a limit: only films rated for that age
  const d = await call("/discover/" + t, p, 3600e3);
  return { items: (d.results || []).filter(x => x.poster_path).map(x => card(x, t)), pages: Math.min(d.total_pages || 1, 500) };
}
async function person({ id, locale }) {
  const d = await call("/person/" + id, clean({ language: locale || "en-US", append_to_response: "combined_credits" }));
  const seen = {}, known = ((d.combined_credits && d.combined_credits.cast) || []).filter(x => x.poster_path && (x.media_type === "movie" || x.media_type === "tv") && !seen[x.media_type + x.id] && (seen[x.media_type + x.id] = 1))
    .sort((a, b) => (b.vote_count || 0) - (a.vote_count || 0)).slice(0, 40).map(x => Object.assign(card(x, x.media_type), { role: x.character || "" }));
  return { id: d.id, name: d.name, bio: (d.biography || "").slice(0, 900), born: d.birthday || "", place: d.place_of_birth || "", photo: img(d.profile_path, "w342"), department: d.known_for_department || "", known };
}
async function search({ q, locale }) {
  const d = await call("/search/multi", clean({ query: String(q || "").slice(0, 100), language: locale || "en-US", include_adult: "false" }), 1800e3);
  const r = d.results || [];
  return { people: r.filter(x => x.media_type === "person" && x.profile_path).slice(0, 12).map(x => ({ id: x.id, name: x.name, photo: img(x.profile_path, "w185"), department: x.known_for_department || "" })),
    titles: r.filter(x => (x.media_type === "movie" || x.media_type === "tv") && x.poster_path).slice(0, 24).map(x => card(x, x.media_type)) };
}
async function collection({ id, locale }) {
  const d = await call("/collection/" + id, clean({ language: locale || "en-US" }));
  return { id: d.id, name: d.name, overview: d.overview || "", poster: img(d.poster_path, "w342"), background: img(d.backdrop_path, "w780"), items: (d.parts || []).filter(x => x.poster_path).sort((a, b) => String(a.release_date).localeCompare(String(b.release_date))).map(x => card(x, "movie")) };
}
/* well-known film franchises (TMDB collection ids), shown in this order; ones TMDB no longer has are skipped */
const FRANCHISES = [10, 1241, 119, 121938, 86311, 531241, 284433, 748, 645, 87359, 328, 9485, 263, 2344, 10194, 2150, 295, 131635, 84, 1575, 8091, 528, 173710, 151, 8650, 404609, 86066, 8354, 5039, 1570, 91361, 556, 1733, 2980, 8945, 2602, 33514, 230, 1565, 34055, 86027, 2806];
const colCard = c => ({ id: c.id, name: c.name || "", poster: img(c.poster_path, "w342"), count: c.parts ? c.parts.length : null });
async function collections({ q, locale }) {
  q = String(q || "").trim().slice(0, 80);
  if (q.length >= 2) { const d = await call("/search/collection", clean({ query: q, language: locale || "en-US" }), 1800e3); return (d.results || []).filter(c => c.poster_path).slice(0, 40).map(colCard); }
  const key = "franchises:" + (locale || "en-US"), hit = cache.get(key); if (hit && Date.now() - hit.at < 12 * 3600e3) return hit.v;
  const out = new Array(FRANCHISES.length); let next = 0;
  await Promise.all(Array.from({ length: 6 }, async () => { while (next < FRANCHISES.length) { const i = next++; try { out[i] = colCard(await call("/collection/" + FRANCHISES[i], clean({ language: locale || "en-US" }), 7 * 864e5)); } catch (e) { if (e.code === "off" || e.code === "bad_key") throw e; } } }));
  const v = out.filter(c => c && c.poster); cache.set(key, { at: Date.now(), v }); return v;
}
async function resolve({ tmdb, type }) {
  const t = type === "series" || type === "tv" ? "tv" : "movie", d = await call("/" + t + "/" + tmdb + "/external_ids", {}, 30 * 864e5);
  if (!d.imdb_id) throw Object.assign(new Error("no IMDb id"), { code: "not_found" });
  return { imdb: d.imdb_id, type: t === "tv" ? "series" : "movie" };
}
/* just the age rating of a title (for the parental check before playing) */
async function ageOf({ imdb, type, region }) {
  const f = await find(imdb), t = f ? f.type : (type === "series" ? "tv" : "movie"); if (!f) return null;
  const d = await call("/" + t + "/" + f.tmdb, { append_to_response: t === "tv" ? "content_ratings" : "release_dates" }, 7 * 864e5);
  return pickCert(d, t, region);
}
module.exports = { collections, FRANCHISES, configure, setKey, enabled, find, title, season, list, genres, discover, person, search, collection, resolve, ageOf, certAge, pickCert, LISTS };
