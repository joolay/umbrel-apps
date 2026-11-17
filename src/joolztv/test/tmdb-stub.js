// A stand-in for api.themoviedb.org with the documented response shapes (v3), used by the tests. Not the real service.
"use strict";
const http = require("http");
const poster = "/p.jpg", back = "/b.jpg";
const MOVIES = {
  278: { id: 278, imdb: "tt0111161", title: "The Shawshank Redemption", overview: "Two imprisoned men bond.", tagline: "Fear can hold you prisoner.", runtime: 142, release_date: "1994-09-23", vote_average: 8.7,
    genres: [{ id: 18, name: "Drama" }, { id: 80, name: "Crime" }], cert: { GB: "15", ZA: "16", US: "R" }, collection: null, stinger: false },
  9: { id: 9, imdb: "tt0000777", title: "Little Bear Adventures", overview: "A bear goes out.", tagline: "", runtime: 80, release_date: "2015-05-01", vote_average: 6.9,
    genres: [{ id: 16, name: "Animation" }], cert: { GB: "U", US: "G" }, collection: { id: 55, name: "Little Bear Collection" }, stinger: true },
  10: { id: 10, imdb: "tt0000888", title: "Unrated Indie", overview: "No rating.", tagline: "", runtime: 90, release_date: "2020-01-01", vote_average: 5, genres: [], cert: {}, collection: null, stinger: false }
};
const SHOWS = { 1396: { id: 1396, imdb: "tt0903747", name: "Breaking Bad", overview: "A teacher turns.", tagline: "Remember my name", first_air_date: "2008-01-20", vote_average: 8.9, genres: [{ id: 18, name: "Drama" }],
  ratings: { US: "TV-MA", GB: "18" }, status: "Ended", seasons: [{ season_number: 0, name: "Specials", episode_count: 3 }, { season_number: 1, name: "Season 1", episode_count: 7 }] },
  1397: { id: 1397, imdb: "tt0000555", name: "Returning Show", overview: "Still going.", first_air_date: "2022-01-01", vote_average: 7, genres: [], ratings: { GB: "12" }, status: "Returning Series",
    next: { season_number: 3, episode_number: 4, name: "Four", air_date: "2026-12-01" }, seasons: [{ season_number: 1, name: "Season 1", episode_count: 8 }] } };
const results = (a, k) => ({ page: 1, total_pages: 3, results: a.map(x => Object.assign({ id: x.id, poster_path: poster, backdrop_path: back, vote_average: x.vote_average, overview: x.overview }, k === "tv" ? { name: x.name, first_air_date: x.first_air_date } : { title: x.title, release_date: x.release_date })) });
function make() {
  const hits = [];
  const srv = http.createServer((q, r) => {
    const u = new URL(q.url, "http://x"), p = u.pathname, s = u.searchParams, J = (o, c) => { r.writeHead(c || 200, { "content-type": "application/json" }); r.end(JSON.stringify(o)); };
    if (p.indexOf("/t/p/") === 0) { const hue = (p.length * 47) % 360; r.writeHead(200, { "content-type": "image/svg+xml" }); return r.end('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(' + hue + ',70%,55%)"/><stop offset="1" stop-color="hsl(' + ((hue + 60) % 360) + ',70%,25%)"/></linearGradient></defs><rect width="300" height="450" fill="url(#g)"/></svg>'); }
    hits.push(p + "?" + u.searchParams.toString());
    const bearer = /^Bearer /.test(q.headers.authorization || ""), key = s.get("api_key");
    if (!bearer && key !== "goodkey1234567890abcd") return J({ status_code: 7, status_message: "Invalid API key" }, 401);
    let m;
    if ((m = /^\/find\/(tt\d+)$/.exec(p))) { const mv = Object.values(MOVIES).filter(x => x.imdb === m[1]), tv = Object.values(SHOWS).filter(x => x.imdb === m[1]); return J({ movie_results: mv.map(x => ({ id: x.id })), tv_results: tv.map(x => ({ id: x.id })) }); }
    if ((m = /^\/movie\/(\d+)$/.exec(p))) {
      const x = MOVIES[m[1]]; if (!x) return J({}, 404);
      return J({ id: x.id, title: x.title, original_title: x.title, overview: x.overview, tagline: x.tagline, runtime: x.runtime, release_date: x.release_date, vote_average: x.vote_average, genres: x.genres, poster_path: poster, backdrop_path: back, status: "Released",
        belongs_to_collection: x.collection ? { id: x.collection.id, name: x.collection.name } : null,
        images: { logos: [{ file_path: "/logo-fr.png", iso_639_1: "fr", vote_average: 9 }, { file_path: "/logo-en.png", iso_639_1: "en", vote_average: 5 }] },
        credits: { cast: [{ id: 504, name: "Tim Robbins", character: "Andy", profile_path: "/tim.jpg" }, { id: 192, name: "Morgan Freeman", character: "Red", profile_path: "/mf.jpg" }], crew: [{ id: 4027, name: "Frank Darabont", job: "Director" }, { id: 1, name: "Someone", job: "Editor" }] },
        release_dates: { results: Object.keys(x.cert).map(c => ({ iso_3166_1: c, release_dates: [{ certification: "", type: 1 }, { certification: x.cert[c], type: 3 }] })) },
        keywords: { keywords: x.stinger ? [{ id: 179430, name: "aftercreditsstinger" }, { id: 1, name: "prison" }] : [{ id: 1, name: "prison" }] },
        recommendations: { results: [{ id: 238, title: "The Godfather", poster_path: poster, backdrop_path: back, vote_average: 8.7, release_date: "1972-03-14", media_type: "movie" }, { id: 11, title: "No Poster", poster_path: null }] },
        external_ids: { imdb_id: x.imdb } });
    }
    if ((m = /^\/tv\/(\d+)$/.exec(p))) {
      const x = SHOWS[m[1]]; if (!x) return J({}, 404);
      return J({ id: x.id, name: x.name, original_name: x.name, overview: x.overview, tagline: x.tagline || "", first_air_date: x.first_air_date, vote_average: x.vote_average, genres: x.genres, poster_path: poster, backdrop_path: back, status: x.status,
        episode_run_time: [47], next_episode_to_air: x.next || null, networks: [{ name: "AMC" }], created_by: [{ id: 66633, name: "Vince Gilligan" }], seasons: x.seasons, images: { logos: [] },
        credits: { cast: [{ id: 17419, name: "Bryan Cranston", character: "Walter White", profile_path: "/bc.jpg" }], crew: [] },
        content_ratings: { results: Object.keys(x.ratings).map(c => ({ iso_3166_1: c, rating: x.ratings[c] })) }, keywords: { results: [] }, recommendations: { results: [] }, external_ids: { imdb_id: x.imdb, tvdb_id: 81189 } });
    }
    if ((m = /^\/tv\/(\d+)\/season\/(\d+)$/.exec(p))) return J({ season_number: +m[2], episodes: [{ episode_number: 1, name: "Pilot", overview: "It begins.", still_path: "/s1.jpg", air_date: "2008-01-20", runtime: 58 }, { episode_number: 2, name: "Cat's in the Bag", overview: "", still_path: null, air_date: "2008-01-27", runtime: 48 }] });
    if ((m = /^\/(movie|tv)\/(\d+)\/external_ids$/.exec(p))) { const x = (m[1] === "tv" ? SHOWS : MOVIES)[m[2]]; return x ? J({ imdb_id: x.imdb }) : J({ imdb_id: null }); }
    if (/^\/trending\/movie\/day$|^\/movie\/(popular|top_rated|now_playing|upcoming)$/.test(p)) return J(results(Object.values(MOVIES), "movie"));
    if (/^\/trending\/tv\/day$|^\/tv\/(popular|top_rated|on_the_air|airing_today)$/.test(p)) return J(results(Object.values(SHOWS), "tv"));
    if (p === "/certification/movie/list") return J({ certifications: { GB: [{ certification: "15", order: 5 }, { certification: "PG", order: 2 }, { certification: "U", order: 1 }, { certification: "12A", order: 3 }, { certification: "12", order: 4 }, { certification: "18", order: 6 }], ZA: [{ certification: "A", order: 1 }, { certification: "PG", order: 2 }, { certification: "7-9PG", order: 3 }, { certification: "10-12PG", order: 4 }, { certification: "13", order: 5 }, { certification: "16", order: 6 }, { certification: "XX", order: 9 }], US: [{ certification: "NR", order: 0 }, { certification: "G", order: 1 }, { certification: "PG", order: 2 }, { certification: "PG-13", order: 3 }, { certification: "R", order: 4 }] } });
    if ((m = /^\/genre\/(movie|tv)\/list$/.exec(p))) return J({ genres: [{ id: 18, name: "Drama" }, { id: 16, name: "Animation" }, { id: 35, name: "Comedy" }] });
    if ((m = /^\/discover\/(movie|tv)$/.exec(p))) return J(results(m[1] === "tv" ? Object.values(SHOWS) : Object.values(MOVIES).filter(x => !s.get("certification.lte") || (x.cert.GB && ["U", "PG"].includes(x.cert.GB))), m[1]));
    if ((m = /^\/person\/(\d+)$/.exec(p))) return J({ id: +m[1], name: "Tim Robbins", biography: "An actor. ".repeat(10), birthday: "1958-10-16", place_of_birth: "West Covina", profile_path: "/tim.jpg", known_for_department: "Acting",
      combined_credits: { cast: [{ id: 278, media_type: "movie", title: "The Shawshank Redemption", poster_path: poster, vote_count: 20000, character: "Andy" }, { id: 278, media_type: "movie", title: "The Shawshank Redemption", poster_path: poster, vote_count: 20000 }, { id: 1396, media_type: "tv", name: "Breaking Bad", poster_path: poster, vote_count: 12000, character: "Guest" }, { id: 5, media_type: "movie", title: "Nopost", poster_path: null }] } });
    if (p === "/search/collection") return J({ results: [{ id: 55, name: "Little Bear Collection", poster_path: poster }, { id: 56, name: "No Poster Collection", poster_path: null }] });
    if ((m = /^\/collection\/(\d+)$/.exec(p))) { if (![10, 1241, 55].includes(+m[1])) return J({}, 404); return J({ id: +m[1], name: +m[1] === 10 ? "Star Wars Collection" : +m[1] === 1241 ? "Harry Potter Collection" : "Little Bear Collection", overview: "Bears.", poster_path: poster, backdrop_path: back, parts: [{ id: 9, title: "Little Bear Adventures", poster_path: poster, release_date: "2015-05-01" }, { id: 99, title: "Little Bear 0", poster_path: poster, release_date: "2012-05-01" }] }); }
    if (p === "/search/multi") return J({ results: [{ media_type: "person", id: 504, name: "Tim Robbins", profile_path: "/tim.jpg", known_for_department: "Acting" }, { media_type: "movie", id: 278, title: "The Shawshank Redemption", poster_path: poster, release_date: "1994-09-23" }, { media_type: "tv", id: 1396, name: "Breaking Bad", poster_path: poster, first_air_date: "2008-01-20" }] });
    J({ status_message: "not found" }, 404);
  });
  return { srv, hits };
}
module.exports = { make };
