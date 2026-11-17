// Unit tests for subtitle matching (ui/js/subs.js) and the direct-vs-transcode decision (Api.assess in ui/js/api.js).
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm");
const Subs = require("./ui/js/subs.js");
const sandbox = { window: {}, navigator: { userAgent: "x" }, document: { createElement: () => ({ canPlayType: () => "" }) }, Store: { get: (k, d) => d }, fetch() {}, console, setTimeout, clearTimeout, Promise };
vm.createContext(sandbox); vm.runInContext(fs.readFileSync(path.join(__dirname, "ui/js/api.js"), "utf8") + "\nthis.Api = Api;", sandbox);
const Api = sandbox.Api;
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log("FAIL", m); } else console.log("ok  ", m); };

/* ---- subtitles ---- */
const file = { filename: "The.Shawshank.Redemption.1994.1080p.BluRay.x264-RARBG.mkv" };
const mk = (id, lang, name, m) => ({ id, lang, m: m || "i", subtitleFileName: name, movieReleaseName: "Shawshank Redemption, The (1994)", url: "http://x/" + id });
const list = [
  mk("a", "eng", "sawshank_redemption_engl.srt"),
  mk("b", "eng", "The.Shawshank.Redemption.1994.720p.BluRay.x264-CiNEPHiLiA.eng.srt"),
  mk("c", "eng", "The.Shawshank.Redemption.1994.1080p.BluRay.x264-RARBG.en.srt"),
  mk("d", "eng", "The.Shawshank.Redemption.1994.WEB-DL.x265-GROUP.srt"),
  mk("e", "fre", "Les.Evades.1994.1080p.BluRay.x264-RARBG.fr.srt"),
  mk("f", "spa", "Sueños.de.Libertad.srt"),
];
let r = Subs.rank(list, file, { lang: "eng" });
ok(r.best.sub.id === "c", "same release group + source + resolution ranks first (" + r.best.sub.id + ")");
ok(r.groups[0].items.map(x => x.sub.id).join("") === "cbda", "English order: exact release, same source/other group, then others (" + r.groups[0].items.map(x => x.sub.id).join("") + ")");
ok(r.groups[0].lang === "eng" && r.groups[0].preferred, "preferred language listed first");
ok(r.groups.map(g => g.lang).join(",") === "eng,fre,spa", "other languages follow alphabetically by name (French, Spanish)");
const withHash = list.concat([mk("h", "eng", "totally.different.name.srt", "f")]);
r = Subs.rank(withHash, file, { lang: "eng" });
ok(r.best.sub.id === "h" && r.groups[0].items[0].file, "a hash (exact file) match beats everything else");
r = Subs.rank(list, file, { lang: "fre", lang2: "eng" });
ok(r.groups.map(g => g.lang).join(",") === "fre,eng,spa" && r.best.sub.id === "e", "primary then second language, best of the primary");
r = Subs.rank(list, file, { lang: "ger" });
ok(r.best === null, "no subtitle in the preferred language -> no automatic pick");
ok(Subs.parse("Movie.2020.2160p.WEB-DL.DDP5.1.H.265-FLUX.mkv").group === "flux" && Subs.parse("Movie.2020.2160p.WEB-DL.DDP5.1.H.265-FLUX.mkv").src === "web" && Subs.parse("Movie 2160p x265").codec === "hevc", "release name parsing (group, source, codec)");
ok(Subs.shift("00:00:01,000 --> 00:00:02,500", 500) === "00:00:01.500 --> 00:00:03.000" && Subs.shift("00:00:00,100 --> 00:00:00,200", -500) === "00:00:00.000 --> 00:00:00.000", "subtitle timing shift (later / earlier, never below zero)");
ok(/^WEBVTT/.test(Subs.toVtt("1\n00:00:01,000 --> 00:00:02,000\nHi")) && /00:00:01\.000/.test(Subs.toVtt("1\n00:00:01,000 --> 00:00:02,000\nHi")), "SRT converted to WebVTT");

/* ---- direct play or transcode? ---- */
const tv = { hevc: true, hevc10: true, ac3: true, eac3: true, dts: false, tv: true };
const pc = { hevc: false, hevc10: false, ac3: false, eac3: false, dts: false, tv: false };
const S = (name) => ({ name: "Torrentio\n1080p", title: name + "\n👤 10 💾 2 GB", behaviorHints: { filename: name } });
ok(Api.assess(S("Movie.2020.1080p.BluRay.x264.AAC5.1-GRP.mkv"), tv).transcode === false, "H.264 + AAC plays directly on the TV");
ok(Api.assess(S("Movie.2020.1080p.WEB-DL.DD5.1.H.264-GRP.mkv"), tv).transcode === false, "H.264 + Dolby Digital plays directly on a TV that supports AC-3");
ok(Api.assess(S("Movie.2020.1080p.WEB-DL.DD5.1.H.264-GRP.mkv"), pc).transcode === true, "Dolby Digital on a browser without AC-3 -> transcode");
ok(Api.assess(S("Movie.2020.1080p.BluRay.x264.DTS-HD.MA.5.1-GRP.mkv"), tv).reason === "DTS / TrueHD audio", "DTS-HD audio (TV cannot decode) -> transcode");
ok(Api.assess(S("Movie.2020.2160p.UHD.BluRay.x265.10bit.HDR.TrueHD.Atmos-GRP.mkv"), tv).transcode === true, "TrueHD Atmos -> transcode");
ok(Api.assess(S("Movie.2020.2160p.WEB-DL.DDP5.1.HDR.H.265-GRP.mkv"), tv).transcode === false, "HEVC 10-bit HDR with Dolby Digital Plus plays directly on a TV with HEVC");
ok(Api.assess(S("Movie.2020.1080p.WEB-DL.x265-GRP.mkv"), pc).reason === "HEVC video", "HEVC on a device without HEVC -> transcode");
ok(Api.assess(S("Movie.2020.2160p.WEB-DL.DV.HDR10.H.265-GRP.mkv"), tv).reason === "Dolby Vision", "Dolby Vision -> transcode");
ok(Api.assess(S("Movie.2020.AV1.1080p.WEB-GRP.mkv"), tv).reason === "AV1 video", "AV1 -> transcode");
ok(Api.assess(S("Movie.2005.DVDRip.XviD-GRP.avi"), tv).reason === "older video format", "AVI / XviD -> transcode");
ok(Api.assess(S("Movie.2015.1080p.BluRay.Hi10P.x264-GRP.mkv"), tv).reason === "10-bit H.264", "Hi10P H.264 -> transcode");
ok(Api.assess({ name: "x", title: "Some release with no codec words" }, tv).transcode === false, "unknown release: try direct first (the player falls back if it fails)");
console.log(fails ? fails + " FAILED" : "ALL PASSED"); process.exit(fails ? 1 : 0);
