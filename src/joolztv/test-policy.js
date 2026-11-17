// The app-side parts of the adult block (ui/js/policy.js): recognising adult material in the data the app already has.
"use strict";
global.Backend = {}; global.Tmdb = { region: () => "GB" };
const P = require("./ui/js/policy.js");
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log("FAIL", m); } else console.log("ok  ", m); };
ok(P.adultMeta({ name: "Something", genres: ["Drama", "Adult"] }) && P.adultMeta({ name: "X", genres: ["adult"] }), "Cinemeta's Adult genre (any case)");
ok(P.adultMeta({ name: "Big XXX Night" }) && P.adultMeta({ name: "Porn Star Diaries" }) && P.adultMeta({ name: "Hentai Dreams" }), "obvious names");
ok(!P.adultMeta({ name: "The Shawshank Redemption", genres: ["Drama"] }), "an ordinary title passes");
ok(!P.adultMeta({ name: "Sussex Adventures", genres: ["Family"] }) && !P.adultMeta({ name: "Xanadu" }) && !P.adultMeta(null), "words that merely contain 'xxx'-like letters are fine; null is fine");
ok(P.cleanMetas([{ name: "A", genres: ["Adult"] }, { name: "B" }, { name: "C", genres: ["Comedy"] }]).map(m => m.name).join("") === "BC", "lists lose their adult entries");
ok(P.cleanMetas(undefined).length === 0, "no list, no problem");
console.log(fails ? fails + " FAILED" : "ALL PASSED"); process.exit(fails ? 1 : 0);
