// Unit tests for subtitle matching (ui/js/subs.js) and the direct-vs-transcode decision (Api.assess in ui/js/api.js).
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm");
const Subs = require("./ui/js/subs.js");
const sandbox = { window: {}, navigator: { userAgent: "x" }, document: { createElement: () => ({ canPlayType: () => "" }) }, Store: { _m: {}, get(k, d) { return k in this._m ? JSON.parse(this._m[k]) : d; }, set(k, v) { this._m[k] = JSON.stringify(v); }, del(k) { delete this._m[k]; } }, fetch() {}, console, setTimeout, clearTimeout, Promise };
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
let r = Subs.rank(list, file, { lang: "eng" }, 10);
ok(r.best.sub.id === "c", "same release group + source + resolution ranks first (" + r.best.sub.id + ")");
ok(r.items.map(x => x.sub.id).join("") === "cbda", "English only, ordered by how likely they match the file (" + r.items.map(x => x.sub.id).join("") + ")");
ok(r.hidden === 2 && r.items.every(x => x.sub.lang === "eng"), "non-English subtitles are hidden (" + r.hidden + " hidden)");
const many = []; for (let i = 0; i < 25; i++) many.push(mk("m" + i, "eng", "Some.Other.Release." + i + ".720p.WEB-GRP" + i + ".srt")); many.push(mk("best", "eng", "The.Shawshank.Redemption.1994.1080p.BluRay.x264-RARBG.srt"));
r = Subs.rank(many, file, { lang: "eng" }, 10);
ok(r.items.length === 10 && r.items[0].sub.id === "best", "no more than the best 10 are listed, best first");
r = Subs.rank([mk("x", "eng", "A.Release.srt"), mk("y", "eng", "A.Release.srt"), mk("z", "eng", "Other.srt")], file, { lang: "eng" }, 10);
ok(r.items.length === 2, "the same subtitle uploaded twice is listed once");
const withHash = list.concat([mk("h", "eng", "totally.different.name.srt", "f")]);
r = Subs.rank(withHash, file, { lang: "eng" }, 10);
ok(r.best.sub.id === "h" && r.items[0].file, "a hash (exact file) match beats everything else");
r = Subs.rank(list, file, { lang: "fre", lang2: "eng" }, 10);
ok(r.items[0].sub.id === "e" && r.items.map(x => x.sub.lang).join(",") === "fre,eng,eng,eng,eng" && r.hidden === 1, "chosen language first, second language after, others hidden");
r = Subs.rank(list, file, { lang: "ger" }, 10);
ok(r.best === null && r.items.length === 0 && r.hidden === 6, "nothing in the chosen language -> empty list, no automatic pick");
ok(Subs.parse("Movie.2020.2160p.WEB-DL.DDP5.1.H.265-FLUX.mkv").group === "flux" && Subs.parse("Movie.2020.2160p.WEB-DL.DDP5.1.H.265-FLUX.mkv").src === "web" && Subs.parse("Movie 2160p x265").codec === "hevc", "release name parsing (group, source, codec)");
ok(Subs.shift("00:01:00,000 --> 00:02:00,000", 1000, 0.959) === "00:00:58.540 --> 00:01:56.080" && Subs.shift("00:00:01,000 --> 00:00:02,500", 500) === "00:00:01.500 --> 00:00:03.000" && Subs.shift("00:00:00,100 --> 00:00:00,200", -500) === "00:00:00.000 --> 00:00:00.000", "subtitle timing shift and frame-rate scale (later / earlier, never below zero)");
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

/* ---- remembering what this device can decode ---- */
const Store = sandbox.Store, reset = () => { Store._m = {}; };
reset();
const dts = S("Movie.2021.1080p.BluRay.x264.DTS-HD.MA.5.1-GRP.mkv"), ac3 = S("Movie.2021.1080p.WEB-DL.DD5.1.H.264-GRP.mkv"), plain = S("Movie.2021.1080p.BluRay.x264.AAC5.1-GRP.mp4");
ok(Api.assess(ac3, tv).transcode === false, "before learning: Dolby Digital file plays directly (the TV says it can)");
Api.learn(ac3, false);
ok(Api.assess(ac3, tv).transcode === true && Api.assess(ac3, tv).learned && /Dolby Digital audio before/.test(Api.assess(ac3, tv).reason), "after the TV failed on it once, the next Dolby Digital file is transcoded straight away (" + Api.assess(ac3, tv).reason + ")");
ok(Api.assess(plain, tv).transcode === false, "files without that format are still played directly");
Api.learn(ac3, true); Api.learn(ac3, true);
ok(Api.assess(ac3, tv).transcode === false, "if it later plays fine (more successes than failures) it is trusted again");
reset();
ok(Api.assess(dts, tv).transcode === true, "DTS: the TV says it can't, so it is transcoded");
Api.learn(dts, true);
ok(Api.assess(dts, tv).transcode === false, "...but if it was played directly once (e.g. you forced direct) and worked, the device's real ability wins");
reset(); Api.learn(plain, false);
ok(Object.keys(Store.get("devcaps", {})).length === 0 && Api.assess(plain, tv).transcode === false, "a failure of plain H.264/AAC is never blamed on the device (file or network problem)");
reset(); Api.learn(S("Movie.2021.1080p.WEB-DL.DD5.1.H.264.x265-GRP.mkv"), false);
const memo = Store.get("devcaps", {});
ok(Object.keys(memo).indexOf("ac3") >= 0 || Object.keys(memo).length > 0, "a failure is blamed on the unproven formats in the file (" + Object.keys(memo).join(",") + ")");
reset(); Store.set("devcaps", { dts: { ok: 0, fail: 3, ts: Date.now() - 200 * 86400e3 } });
ok(Api.assess(dts, { hevc: true, hevc10: true, ac3: true, eac3: true, dts: true, tv: true }).transcode === false, "old lessons expire after 180 days (firmware updates)");
reset(); Api.learn(ac3, false); const rep = Api.deviceReport(); ok(rep.bad.indexOf("Dolby Digital audio") >= 0 && rep.good.length === 0, "the report lists what is remembered");
Api.forgetDevice(); ok(Api.deviceReport().bad.length === 0, "forgetting the device clears it");

/* ---- first-run device check results ---- */
reset();
Api.recordTest("av1", true); Api.recordTest("hevc", false); Api.recordTest("h264", false);
const av1File = S("Movie.2020.AV1.1080p.WEB-GRP.mkv"), hevcFile = S("Movie.2020.2160p.WEB-DL.x265-GRP.mkv");
ok(Api.assess(av1File, tv).transcode === false, "device check proved AV1 plays -> the 'AV1 always transcodes' guess no longer applies");
ok(Api.assess(hevcFile, { hevc: true, hevc10: true, ac3: true, eac3: true, dts: true, tv: true }).transcode === true, "device check showed HEVC fails -> transcode even though the device claims HEVC");
ok(!("h264" in Store.get("devcaps", {})), "the plain H.264 baseline is never recorded against the device");
Api.recordTest("hevc", true); ok(Api.assess(hevcFile, { hevc: false, hevc10: false, ac3: true, eac3: true, dts: true, tv: false }).transcode === false, "a later successful test overrides an old failure");
Api.learn(hevcFile, false); ok(Object.keys(Store.get("devcaps", {})).indexOf("hevc") >= 0, "real playback keeps refining what the test found");
console.log(fails ? fails + " FAILED" : "ALL PASSED"); process.exit(fails ? 1 : 0);
