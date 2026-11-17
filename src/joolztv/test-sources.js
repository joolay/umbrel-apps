// Source filters -> address, and the preferred-quality choice (Sources in ui/js/sources.js, Api.organise in ui/js/api.js).
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm");
const Sources = require("./ui/js/sources.js");
const sandbox = { window: {}, navigator: { userAgent: "x" }, document: { createElement: () => ({ canPlayType: () => "" }) }, Sources, Store: { _m: {}, get(k, d) { return k in this._m ? JSON.parse(this._m[k]) : d; }, set(k, v) { this._m[k] = JSON.stringify(v); }, del(k) { delete this._m[k]; } } };
vm.createContext(sandbox); vm.runInContext(fs.readFileSync(path.join(__dirname, "ui/js/api.js"), "utf8") + "\nthis.Api = Api;", sandbox);
const Api = sandbox.Api;
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log("FAIL", m); } else console.log("ok  ", m); };

/* ---- filters -> address ---- */
ok(Sources.url({}) === "https://torrentio.strem.fun/qualityfilter=scr,cam", "defaults: only camera recordings and screeners are left out (" + Sources.url({}) + ")");
const u = Sources.url({ hide: { dv: true, hdr: true, remux: true, threed: true, unknown: true }, maxGb: 8, language: "english", providers: ["yts", "eztv"] });
ok(u === "https://torrentio.strem.fun/providers=yts,eztv|language=english|qualityfilter=scr,cam,dolbyvision,dolbyvisionwithhdr,hdrall,brremux,threed,unknown|sizefilter=8GB", "every filter lands in the address (" + u + ")");
ok(Sources.url({ providers: ["nope", "yts"], maxGb: 99, language: 5, hide: { dv: "yes" } }) === "https://torrentio.strem.fun/providers=yts|qualityfilter=scr,cam", "unknown sites, sizes and non-boolean values are ignored");
ok(Sources.url({ custom: "https://my.example/abc/" }) === "https://my.example/abc", "a custom https address replaces the built-in one");
ok(Sources.url({ custom: "http://insecure" }).indexOf("torrentio") > 0 && Sources.url({ custom: "javascript:1" }).indexOf("torrentio") > 0, "a custom address must be https");
ok(Sources.summary({}) === "Everything except camera recordings" && /Hiding Dolby Vision, HDR/.test(Sources.summary({ hide: { dv: true, hdr: true } })) && /up to 8 GB/i.test(Sources.summary({ maxGb: 8 })), "a plain-words summary of the filters");
ok(!/torrentio/i.test(Sources.summary({ custom: "x", providers: ["yts"], language: "english", maxGb: 4, hide: { dv: true } })), "the summary never shows the source's name");

/* ---- preferred quality ---- */
const mk = (id, cat, seeds, extra) => Object.assign({ infoHash: id.padEnd(40, "0"), name: "Torrentio\n" + cat, title: "Film " + id + "\n👤 " + seeds, _q: { seeds, score: 10, quality: cat, size: "" } }, extra || {});
const found = [mk("a1", "4k", 40), mk("a2", "4k", 90), mk("b1", "1080p", 30), mk("b2", "1080p", 300), mk("b3", "1080p", 120), mk("b4", "1080p", 5), mk("c1", "720p", 500), mk("c2", "720p", 7), mk("d1", "480p", 900)];
let r = Api.organise(found, "1080p");
ok(r.hasPreferred && r.preferred === "1080p" && r.list[0].infoHash.indexOf("b2") === 0, "1080p preferred: the 1080p file with the most seeds plays first (" + r.list[0].title.split("\n")[0] + ")");
ok(r.list.slice(0, 3).map(x => x._cat).join() === "1080p,1080p,1080p" && r.list.slice(3).map(x => x._cat)[0] === "720p", "then the other 1080p files, then the nearest quality (720p)");
ok(r.groups.filter(g => g.label === "1080p")[0].items.length === 3, "only the top 3 per resolution are offered");
r = Api.organise(found, "4K"); ok(r.list[0].infoHash.indexOf("a2") === 0 && r.first === "4K", "4K preferred: most-seeded 4K file first (not the globally most-seeded file)");
r = Api.organise(found, "720p"); ok(r.list[0].infoHash.indexOf("c1") === 0 && r.list[1].infoHash.indexOf("c2") === 0 && r.list[2]._cat === "1080p", "720p preferred: 720p files, then 1080p, then 4K");
r = Api.organise(found.filter(f => !/1080p/.test(f.name)), "1080p");
ok(!r.hasPreferred && r.preferred === "1080p" && r.first === "720p" && r.counts["1080p"] === 0 && r.list.length > 0, "no 1080p at all: it says so, and the alternatives are listed (nearest first: " + r.first + ")");
r = Api.organise(found.filter(f => /1080p|720p/.test(f.name)), "4K"); ok(!r.hasPreferred && r.first === "1080p", "no 4K: the nearest alternative is 1080p");
ok(Api.organise(found, "bogus").preferred === "1080p", "an unknown preference falls back to 1080p");
Api.setPrefs({ quality: "720p", sources: { hide: { dv: true } } });
ok(Api.quality() === "720p" && /dolbyvision/.test(Api.torrentioUrl()), "household settings drive the preferred quality and the source address");
Api.setPrefs({}); ok(Api.quality() === "", "no stored choice: the wizard asks");
/* ---- built-in pictures ---- */
const Avatars = require("./ui/js/avatars.js");
ok(Avatars.LIST.length === 24 && new Set(Avatars.LIST.map(a => a[0])).size === 24 && new Set(Avatars.LIST.map(a => a[1])).size === 24, "24 built-in pictures, each with its own id and name");
ok(Avatars.LIST.every(a => /^a\d\d$/.test(a[0]) && /^#[0-9a-f]{6}$/i.test(a[2]) && /^#[0-9a-f]{6}$/i.test(a[3]) && a[4].length > 20), "every picture has two colours and a drawing");
ok(/<svg/.test(Avatars.html({ avatar: "a05" })) && Avatars.html({ avatar: "a05" }).indexOf("polygon") > 0, "a chosen picture is drawn");
ok(/<img[^>]+src="data:image\/png/.test(Avatars.html({ avatar: "photo", photo: "data:image/png;base64,AAAA" })) && /<img/.test(Avatars.html({ avatar: "", photo: "data:image/png;base64,AAAA" })), "the JoolzApp photo is used when chosen, or when nothing else was chosen");
ok(/<svg/.test(Avatars.html({ avatar: "a09", photo: "data:image/png;base64,AAAA" })), "a built-in picture wins over the photo when the person chose it");
ok(/<svg/.test(Avatars.html({}, 3)) && /<svg/.test(Avatars.html({ avatar: "zzz" }, 30)), "no choice, or an unknown one: a built-in picture by position");
console.log(fails ? fails + " FAILED" : "ALL PASSED"); process.exit(fails ? 1 : 0);
