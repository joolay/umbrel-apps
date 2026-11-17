// Starts server.js with a stand-in account service and a fake streaming server, then checks the rules.
"use strict";
const http = require("http"), fs = require("fs"), os = require("os"), path = require("path"), cp = require("child_process");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jtv-")), P = 39600 + Math.floor(Math.random() * 300), U = P + 1;
fs.mkdirSync(path.join(dir, "dist", "compat"), { recursive: true }); fs.mkdirSync(path.join(dir, "dist", "modern"), { recursive: true });
fs.writeFileSync(path.join(dir, "dist", "compat", "index.html"), "COMPAT"); fs.writeFileSync(path.join(dir, "dist", "modern", "index.html"), "MODERN");
fs.mkdirSync(path.join(dir, "devtest"), { recursive: true }); fs.writeFileSync(path.join(dir, "devtest", "index.json"), '{"v":1,"clips":[{"id":"h264","trait":"h264","label":"H.264","kind":"video","file":"h264.mp4"}]}'); fs.writeFileSync(path.join(dir, "devtest", "h264.mp4"), Buffer.alloc(3000, 1));
const tmdbStub = require("./test/tmdb-stub.js").make(); tmdbStub.srv.listen(P + 2);
const HASH = "a".repeat(40), BODY = Buffer.from("0123456789".repeat(100));

const settingsVals = { cacheSize: 10 * 1073741824, serverVersion: "stub" };
const upstream = http.createServer((q, r) => {
  if (q.url.indexOf("/" + HASH + "/") === 0) {
    const rg = /bytes=(\d+)-(\d*)/.exec(q.headers.range || "");
    if (rg) { const s = +rg[1], e = rg[2] ? +rg[2] : BODY.length - 1; r.writeHead(206, { "content-type": "video/mp4", "content-range": "bytes " + s + "-" + e + "/" + BODY.length, "content-length": e - s + 1, "accept-ranges": "bytes" }); return r.end(BODY.slice(s, e + 1)); }
    r.writeHead(200, { "content-type": "video/mp4", "content-length": BODY.length, "accept-ranges": "bytes" }); return r.end(BODY);
  }
  if (q.url.indexOf("/hlsv2/x/master.m3u8") === 0) { r.writeHead(200, { "content-type": "application/vnd.apple.mpegurl" }); return r.end("#EXTM3U\n#EXT-X-MEDIA:URI=\"/hlsv2/x/audio.m3u8\"\n/hlsv2/x/video.m3u8\nhttp://127.0.0.1:11470/hlsv2/x/other.m3u8\nrelative.m3u8\n"); }
  if (q.url.indexOf("/opensubHash") === 0) { r.writeHead(200, { "content-type": "application/json" }); return r.end('{"result":{"hash":"8e245d9679d31e12","size":1000}}'); }
  if (q.url === "/settings" && q.method === "POST") { const c = []; q.on("data", d => c.push(d)); q.on("end", () => { try { const v = JSON.parse(Buffer.concat(c).toString()); if (v.cacheSize <= 100 * 1073741824) settingsVals.cacheSize = v.cacheSize; } catch {} r.writeHead(200, { "content-type": "application/json" }); r.end("{}"); }); return; }
  if (q.url === "/settings") { r.writeHead(200, { "content-type": "application/json" }); return r.end(JSON.stringify({ options: [], values: settingsVals })); }
  if (q.url.indexOf("/" + "f".repeat(40) + "/") === 0) { r.writeHead(404); return r.end(); }
  if (q.url.indexOf("/" + "c".repeat(40) + "/") === 0) { r.writeHead(200, { "content-type": "video/mp4", "content-length": 100000000 }); const iv = setInterval(() => { if (r.destroyed) return clearInterval(iv); r.write(Buffer.alloc(2000)); }, 40); r.on("close", () => clearInterval(iv)); return; }
  r.writeHead(200); r.end("SECRET-" + q.url);
}).listen(U);

const child = cp.spawn(process.execPath, [path.join(__dirname, "server.js")], { env: Object.assign({}, process.env, { NODE_ENV: "test", JTV_PB: path.join(__dirname, "test", "mock-pb.js"), PORT: P, DATA_DIR: dir, JTV_CACHE_MS: "0", INTRODB_URL: "http://127.0.0.1:9", JTV_CACHE_APPLY: "1", TMDB_URL: "http://127.0.0.1:" + (P + 2), TMDB_IMG: "https://img.test/t/p/", CINEMETA_URL: "http://127.0.0.1:" + (P + 2), THEINTRODB_URL: "http://127.0.0.1:9", TMDB_URL: "http://127.0.0.1:" + (P + 2), TMDB_IMG: "https://img.test/t/p/", FFMPEG: "/nonexistent/ffmpeg", DEVTEST_DIR: path.join(dir, "devtest"), UI_DIST: path.join(dir, "dist"), STREAM_UPSTREAM: "http://127.0.0.1:" + U }), stdio: "ignore" });
function req(method, p, body, headers) {
  return new Promise((res, rej) => {
    const r = http.request({ port: P, method, path: p, headers: Object.assign({ "content-type": "application/json" }, headers || {}) }, x => { const c = []; x.on("data", d => c.push(d)); x.on("end", () => { const t = Buffer.concat(c).toString(); let j = null; try { j = JSON.parse(t); } catch {} res({ code: x.statusCode, text: t, json: j, headers: x.headers }); }); });
    r.on("error", rej); if (body !== undefined) r.write(typeof body === "string" ? body : JSON.stringify(body)); r.end();
  });
}
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log("FAIL", m); } else console.log("ok  ", m); };
const T = tok => ({ "x-jtv-token": tok });
(async () => {
  await new Promise(r => setTimeout(r, 900));
  let r = await req("GET", "/healthz"); ok(r.code === 200 && r.headers["access-control-allow-origin"] === "*", "healthz is open (CORS) for the TV launcher");
  r = await req("GET", "/config.js"); ok(/internalServerUrl/.test(r.text) && /backend: true/.test(r.text), "config.js");
  r = await req("GET", "/api/household"); ok(r.json.empty === true, "empty household announces itself (first-run wizard)");
  r = await req("GET", "/api/state"); ok(r.code === 401, "no token: /api/state refused");
  r = await req("POST", "/api/household/profiles", { email: "kid@x.com", password: "pw3" }); ok(r.code === 403 && r.json.code === "no_access", "account without access cannot create the first profile");
  r = await req("POST", "/api/household/profiles", { email: "ann@x.com", password: "nope" }); ok(r.code === 400 && r.json.code === "bad_login", "wrong password refused");
  r = await req("POST", "/api/household/profiles", { email: "ann@x.com", password: "pw1" }); ok(r.code === 201 && r.json.profile.owner && r.json.token, "first profile (owner) created by signing in with a JoolzApp account");
  const ann = r.json.token, annId = r.json.profile.id;
  r = await req("GET", "/api/household"); ok(r.code === 401, "household list needs a token once it exists");
  r = await req("POST", "/api/household/profiles", { email: "bob@x.com", password: "pw2" }); ok(r.code === 401, "adding a member needs a signed-in member");
  r = await req("POST", "/api/household/profiles", { email: "bob@x.com", password: "pw2" }, T(ann)); ok(r.code === 201 && !r.json.profile.owner, "member added by proving their JoolzApp login");
  const bob = r.json.token, bobId = r.json.profile.id;
  r = await req("POST", "/api/household/profiles", { email: "bob@x.com", password: "pw2" }, T(ann)); ok(r.code === 409 && r.json.code === "already_member", "same account cannot have two profiles");
  r = await req("GET", "/api/household", undefined, T(bob)); ok(r.json.profiles.length === 2 && r.json.profiles.filter(p => p.self)[0].id === bobId, "member sees the household and which one is them");
  r = await req("POST", "/api/household/profiles", { email: "p4@x.com", password: "pw4" }, T(bob)); ok(r.code === 201, "any member can add another (id 3)");
  for (let i = 5; i <= 13; i++) { r = await req("POST", "/api/household/profiles", { email: "p" + i + "@x.com", password: "pw" + i }, T(ann)); }
  ok((await req("GET", "/api/household", undefined, T(ann))).json.profiles.length === 12, "household reaches 12 profiles");
  r = await req("POST", "/api/household/profiles", { email: "p14@x.com", password: "pw14" }, T(ann)); ok(r.code === 409 && r.json.code === "household_full", "13th profile refused");
  // per-account data
  r = await req("POST", "/api/sync", { state: { resume: { tt1: { ts: 100, t: 5 } }, list: { tt9: { ts: 100, name: "x" }, bad: { name: "no ts" } } } }, T(ann));
  ok(r.code === 200 && r.json.state.resume.tt1 && r.json.state.list.tt9 && !r.json.state.list.bad, "ann's progress/list saved; invalid entry dropped");
  r = await req("POST", "/api/sync", { state: { resume: { tt1: { ts: 50, t: 99 }, tt2: { ts: 200, t: 1 } } } }, T(ann)); ok(r.json.state.resume.tt1.t === 5 && r.json.state.resume.tt2, "newest entry wins, new one added");
  r = await req("GET", "/api/state", undefined, T(bob)); ok(Object.keys(r.json.state.resume).length === 0 && Object.keys(r.json.state.list).length === 0, "bob cannot see ann's data (one account per profile)");
  // streaming through the sign-in
  r = await req("POST", "/api/stream-token", {}); ok(r.code === 401, "no stream token without sign-in");
  r = await req("POST", "/api/stream-token", {}, T(ann)); ok(r.code === 200 && r.json.st, "stream token for a signed-in profile");
  const st = r.json.st;
  r = await req("GET", "/s/" + st + "/" + HASH + "/0"); ok(r.code === 200 && r.text.length === 1000, "stream proxied");
  r = await req("GET", "/s/" + st + "/" + HASH + "/0", undefined, { range: "bytes=10-19" }); ok(r.code === 206 && r.text === "0123456789" && /bytes 10-19\/1000/.test(r.headers["content-range"]), "range requests (seeking) work");
  r = await req("GET", "/s/" + st.slice(0, -2) + "xx/" + HASH + "/0"); ok(r.code === 401, "tampered stream token refused");
  r = await req("GET", "/s/" + st + "/" + HASH + "/0/stats.json"); ok(r.code === 200, "torrent speed (stats.json) reachable through the signed-in proxy for smart buffering");
  r = await req("GET", "/s/" + st + "/proxy/secret"); ok(r.code === 404 && r.text.indexOf("SECRET") < 0, "only torrent/hls paths reach the streaming server");
  r = await req("GET", "/s/" + st + "/hlsv2/x/master.m3u8"); ok(r.text.indexOf("/s/" + st + "/hlsv2/x/video.m3u8") >= 0 && r.text.indexOf('URI="/s/' + st + '/hlsv2/x/audio.m3u8"') >= 0 && r.text.indexOf("127.0.0.1") < 0 && /\nrelative\.m3u8\n/.test(r.text), "HLS playlists rewritten to stay behind the sign-in");
  r = await req("GET", "/s/" + st + "/opensubHash?videoUrl=" + encodeURIComponent("http://127.0.0.1:11470/" + HASH + "/0")); ok(r.code === 200 && r.json.result.hash, "subtitle fingerprint of a streamed file works through the proxy");
  r = await req("GET", "/s/" + st + "/opensubHash?videoUrl=" + encodeURIComponent("http://evil.example/x.mkv")); ok(r.code === 400, "subtitle fingerprint refuses arbitrary URLs");
  r = await req("GET", "/s/" + st + "/opensubHash"); ok(r.code === 400, "subtitle fingerprint needs a file");
  const goodSub = Array.from({ length: 40 }, (_, i) => (i + 1) + "\n00:00:" + String(10 + i).padStart(2, "0") + ",000 --> 00:00:" + String(11 + i).padStart(2, "0") + ",000\nline number " + i + " of the subtitle").join("\n\n");
  r = await req("POST", "/api/subs/sync", { infoHash: HASH, fileIdx: 0, subtitle: goodSub }); ok(r.code === 401, "auto-sync needs a sign-in");
  r = await req("POST", "/api/subs/sync", { infoHash: "nothex", fileIdx: 0, subtitle: goodSub }, T(ann)); ok(r.code === 400, "auto-sync refuses a bad source id");
  r = await req("POST", "/api/subs/sync", { infoHash: HASH, fileIdx: 0, subtitle: "too short" }, T(ann)); ok(r.code === 400, "auto-sync refuses an unusable subtitle");
  r = await req("POST", "/api/subs/sync", { infoHash: HASH, fileIdx: 0, subtitle: goodSub }, T(ann)); ok(r.code === 503 && r.json.code === "sync_unavailable", "auto-sync says so clearly when ffmpeg is missing");
  r = await req("GET", "/devtest/index.json"); ok(r.code === 200 && r.json.clips.length === 1, "device-check list is served (before sign-in, it is just tiny test clips)");
  r = await req("GET", "/devtest/h264.mp4", undefined, { range: "bytes=0-99" }); ok(r.code === 206 && r.text.length === 100 && r.headers["content-type"] === "video/mp4", "device-check clip served with ranges and the right type");
  r = await req("GET", "/devtest/..%2fserver.js"); ok(r.code === 404, "device-check route cannot read other files");
  r = await req("GET", "/devtest/missing.mp4"); ok(r.code === 404, "unknown clip -> 404");
  // roles
  r = await req("DELETE", "/api/household/profiles/" + annId, undefined, T(bob)); ok(r.code === 403, "a member cannot remove the owner");
  r = await req("PATCH", "/api/household/profiles/" + bobId, { name: "Robert" }, T(bob)); ok(r.code === 200 && r.json.profile.name === "Robert", "a member can rename their own profile");
  r = await req("DELETE", "/api/household/profiles/" + bobId, undefined, T(ann)); ok(r.code === 200 && r.json.profiles.length === 11, "owner can remove a profile (removes that account's data)");
  r = await req("GET", "/api/state", undefined, T(bob)); ok(r.code === 403, "removed profile loses access to household data");
  // profile pictures: the JoolzApp photo (when there is one) or one of 24 built-in pictures
  r = await req("GET", "/api/household", undefined, T(ann)); const pa = r.json.profiles.filter(p => p.self)[0], pb2 = r.json.profiles.filter(p => !p.self)[0];
  ok(pa.hasPhoto && /^data:image\/png;base64,/.test(pa.photo), "a profile whose JoolzApp account has a photo gets it (as a small picture)");
  ok(!pb2.hasPhoto && pb2.photo === "" && /^a\d\d$/.test(pb2.avatar), "a profile without a photo is given a built-in picture (" + pb2.avatar + ")");
  ok(new Set(r.json.profiles.map(p => p.avatar)).size === r.json.profiles.length, "each profile starts with a different built-in picture");
  r = await req("PATCH", "/api/household/profiles/" + annId, { avatar: "a17" }, T(ann)); ok(r.code === 200 && r.json.profile.avatar === "a17", "a built-in picture can be chosen");
  r = await req("PATCH", "/api/household/profiles/" + annId, { avatar: "a25" }, T(ann)); ok(r.code === 400, "only the 24 built-in pictures are accepted");
  r = await req("PATCH", "/api/household/profiles/" + annId, { avatar: "photo" }, T(ann)); ok(r.code === 200 && r.json.profile.avatar === "photo" && r.json.profile.photo, "the JoolzApp photo can be chosen again");
  const other = r2 => r2.json.profiles.filter(p => !p.self)[0];
  r = await req("PATCH", "/api/household/profiles/" + (await req("GET", "/api/household", undefined, T(ann))).json.profiles.filter(p => !p.self)[0].id, { avatar: "photo" }, T(ann)); ok(r.code === 400, "a profile with no JoolzApp photo cannot pick \"photo\"");
  // sign-in lives while the HOUSEHOLD is used; settings live on the household
  const hf = path.join(dir, "household.json"), setLast = ms => { const h = JSON.parse(fs.readFileSync(hf, "utf8")); h.lastActive = ms; fs.writeFileSync(hf, JSON.stringify(h)); return h; };
  ok(/^s\./.test(ann) && !/^tok\./.test(ann), "sign-in is the server's own session token (not a PocketBase one)");
  r = await req("GET", "/api/household", undefined, T(ann)); ok(r.json.prefs && typeof r.json.prefs === "object", "household settings come with the household");
  r = await req("PUT", "/api/household/prefs", { quality: "8K" }, T(ann)); ok(r.code === 400, "an unknown preferred quality is refused");
  r = await req("PUT", "/api/household/prefs", { quality: "1080p", sources: { hide: { dv: true, hdr: 1, junk: true }, maxGb: 8, language: "english", providers: ["yts", "bad name!", "eztv"], custom: "javascript:alert(1)", extra: 1 } }, T(ann));
  ok(r.code === 200 && r.json.prefs.quality === "1080p" && r.json.prefs.sources.hide.dv === true && r.json.prefs.sources.hide.hdr === false && !("junk" in r.json.prefs.sources.hide) && r.json.prefs.sources.maxGb === 8 && r.json.prefs.sources.providers.join() === "yts,eztv" && r.json.prefs.sources.custom === "" && !("extra" in r.json.prefs.sources), "settings saved and cleaned (only known fields, safe values)");
  r = await req("GET", "/api/household", undefined, T(ann)); ok(r.json.prefs.quality === "1080p", "another request sees the saved quality");
  const carol = (await req("POST", "/api/account/login", { email: "p5@x.com", password: "pw5" })).json.token;
  r = await req("GET", "/api/household", undefined, T(carol)); ok(r.json.prefs.quality === "1080p", "every member sees the same household settings");
  const vw = (await req("POST", "/api/household/profiles", { email: "view@x.com", password: "pw20" }, T(ann))).json.token;
  r = await req("PUT", "/api/household/prefs", { quality: "720p" }, T(vw)); ok(r.code === 403 && r.json.code === "view_only", "a view-only account cannot change the household settings");
  setLast(Date.now() - 100 * 864e5);
  r = await req("GET", "/api/state", undefined, T(carol)); ok(r.code === 401, "household unused for 100 days: sign-in expired for everyone");
  r = await req("GET", "/api/state", undefined, T(ann)); ok(r.code === 401, "...including the owner's token");
  setLast(Date.now() - 80 * 864e5);
  r = await req("GET", "/api/state", undefined, T(carol)); ok(r.code === 200, "80 days idle is still signed in (carol had not been used for ages herself)");
  r = await req("GET", "/api/state", undefined, T(ann)); ok(r.code === 200, "any use refreshes the whole household's clock");
  const lastNow = JSON.parse(fs.readFileSync(hf, "utf8")).lastActive; ok(Date.now() - lastNow < 60e3, "household last-use moved to now (" + Math.round((Date.now() - lastNow) / 1000) + " s ago)");
  setLast(Date.now() - 95 * 864e5); r = await req("POST", "/api/account/login", { email: "p5@x.com", password: "pw5" }); ok(r.code === 200 && /^s\./.test(r.json.token), "signing in again always works");
  const again = r.json.token; r = await req("GET", "/api/state", undefined, T(again)); ok(r.code === 200, "...and the new sign-in works straight away (it restarts the household's 90 days)");
  r = await req("GET", "/api/state", undefined, T(ann)); ok(r.code === 200, "...which also revives everyone else's sign-in");
  setLast(Date.now());
  const tampered = ann.slice(0, -2) + (ann.slice(-2) === "aa" ? "bb" : "aa");
  r = await req("GET", "/api/state", undefined, T(tampered)); ok(r.code === 401, "a tampered session token is refused");
  r = await req("GET", "/api/state", undefined, T("s.dTE.zzzz." + "a".repeat(27))); ok(r.code === 401, "a forged session token is refused");
  const legacy = "legacy-ann";
  r = await req("GET", "/api/state", undefined, T(legacy)); ok(r.code === 200 && /^s\./.test(r.headers["x-jtv-renew"] || ""), "an older PocketBase token still works once and is swapped for a session token");
  // skip intro / credit scenes
  r = await req("POST", "/api/marks/scan", { infoHash: HASH, fileIdx: 0 }); ok(r.code === 401, "scan needs a sign-in");
  r = await req("POST", "/api/marks/scan", { infoHash: "nothex", fileIdx: 0 }, T(ann)); ok(r.code === 400, "scan only takes a torrent source");
  r = await req("POST", "/api/marks/scan", { infoHash: HASH, fileIdx: 0 }, T(ann)); ok(r.code === 422 && r.json.code === "unreadable", "a file that is not a video gives a clear 'could not read' (not a crash)");
  r = await req("POST", "/api/marks/lookup", { imdb: "tt0944947", season: 1, episode: 1, duration: 3000 }); ok(r.code === 401, "lookup needs a sign-in");
  r = await req("POST", "/api/marks/lookup", { imdb: "x", duration: 3000 }, T(ann)); ok(r.code === 400, "lookup: only real titles");
  r = await req("POST", "/api/marks/lookup", { imdb: "tt0944947", season: 1, duration: 3000 }, T(ann)); ok(r.code === 400, "lookup: season without episode is refused");
  r = await req("POST", "/api/marks/lookup", { imdb: "tt0944947", season: 1, episode: 1, duration: 3000 }, T(ann)); ok(r.code === 502 && r.json.code === "unreachable", "lookup: the databases being down is a clear answer (here they are unreachable on purpose)");
  r = await req("GET", "/api/marks/show?id=tt0944947", undefined, T(ann)); ok(r.code === 404, "no household-marked intros: the databases and the file's chapters are the only sources");
  // seek preview pictures
  r = await req("GET", "/api/thumb?hash=" + HASH + "&idx=0&t=10"); ok(r.code === 401, "thumb needs a sign-in");
  r = await req("GET", "/api/thumb?hash=nope&idx=0&t=10", undefined, T(ann)); ok(r.code === 400, "thumb only takes a torrent source");
  r = await req("GET", "/api/thumb?hash=" + HASH + "&idx=0&t=-5", undefined, T(ann)); ok(r.code === 400, "thumb: a negative time is refused");
  r = await req("GET", "/api/thumb?hash=" + HASH + "&idx=0&t=10", undefined, T(ann)); ok(r.code === 503 && r.json.code === "thumbs_unavailable", "thumb: missing ffmpeg gives a clear answer");
  // prefetch (reads part of the file on the server so it is downloaded ahead of playback)
  r = await req("POST", "/api/prefetch", { infoHash: HASH, fileIdx: 0, from: 0, to: 500 }); ok(r.code === 401, "prefetch needs a sign-in");
  r = await req("POST", "/api/prefetch", { infoHash: "nope", fileIdx: 0, from: 0, to: 500 }, T(ann)); ok(r.code === 400, "prefetch only takes a torrent source");
  r = await req("POST", "/api/prefetch", { infoHash: HASH, fileIdx: 0, from: 600, to: 100 }, T(ann)); ok(r.code === 400, "prefetch: the range must go forward");
  r = await req("POST", "/api/prefetch", { infoHash: HASH, fileIdx: 0, from: 0, to: 999999999 }, T(ann)); ok(r.code === 400, "prefetch: a range over 80 MB is refused");
  r = await req("POST", "/api/prefetch", { infoHash: HASH, fileIdx: 0, from: 100, to: 399 }, T(ann)); ok(r.code === 200 && r.json.ok === true && r.json.bytes === 300, "prefetch reads exactly that range and keeps nothing (" + (r.json && r.json.bytes) + " bytes)");
  // TMDB: key, details, lists, parental limits
  r = await req("GET", "/api/tmdb/status", undefined, T(ann)); ok(r.json.enabled === false && r.json.canSetKey === false, "TMDB starts off (no key); an ordinary member cannot set one");
  r = await req("GET", "/api/tmdb/title?imdb=tt0111161", undefined, T(ann)); ok(r.code === 503 && r.json.code === "tmdb_off", "without a key the TMDB routes say so (the app falls back to Cinemeta)");
  r = await req("PUT", "/api/tmdb/key", { key: "goodkey1234567890abcd" }, T(ann)); ok(r.code === 403, "only a JoolzApp admin can set the key");
  const adm = (await req("POST", "/api/account/login", { email: "admin@x.com", password: "pw21" })).json.token;
  r = await req("PUT", "/api/tmdb/key", { key: "not a key!!" }, T(adm)); ok(r.code === 400, "a key with odd characters is refused");
  r = await req("PUT", "/api/tmdb/key", { key: "goodkey1234567890abcd" }, T(adm)); ok(r.code === 200 && r.json.enabled === true, "an admin sets the key");
  ok(fs.existsSync(path.join(dir, "tmdb.key")) && (fs.statSync(path.join(dir, "tmdb.key")).mode & 0o077) === 0, "the key is stored on the server, readable by the server only");
  r = await req("GET", "/api/tmdb/status", undefined, T(adm)); ok(r.json.enabled === true && r.json.canSetKey === true && !/goodkey/.test(r.text), "the key is never sent back");
  r = await req("GET", "/api/tmdb/title?imdb=tt0111161&type=movie&locale=en-GB&region=ZA", undefined, T(ann)); ok(r.code === 200 && r.json.name === "The Shawshank Redemption" && r.json.cert.rating === "16" && !/goodkey/.test(r.text), "title details for the person's country (key not leaked)");
  r = await req("GET", "/api/tmdb/title?imdb=nope", undefined, T(ann)); ok(r.code === 400, "a bad id is refused");
  r = await req("GET", "/api/tmdb/title?imdb=tt9999999&type=movie", undefined, T(ann)); ok(r.code === 404, "an unknown title is a clean 404");
  r = await req("GET", "/api/tmdb/title?imdb=tt0111161&locale=../../x&region=zz", undefined, T(ann)); ok(r.code === 200, "bad locale/region are ignored, not passed on");
  ok(!tmdbStub.hits.some(h => /\.\.\//.test(h)), "nothing from the query string is passed to TMDB unchecked");
  r = await req("GET", "/api/tmdb/list?kind=trending&type=movie", undefined, T(ann)); ok(r.code === 200 && r.json.items.length >= 3 && !r.json.items.some(x => x.name === "Flagged Adult"), "trending list (adult-flagged titles left out)");
  r = await req("GET", "/api/tmdb/season?tmdb=1396&season=1", undefined, T(ann)); ok(r.code === 200 && r.json.episodes.length === 2, "season stills");
  r = await req("GET", "/api/tmdb/person?id=504", undefined, T(ann)); ok(r.code === 200 && r.json.name === "Tim Robbins", "person");
  r = await req("GET", "/api/tmdb/person?id=abc", undefined, T(ann)); ok(r.code === 400, "person id is a number");
  r = await req("GET", "/api/tmdb/search?q=t", undefined, T(ann)); ok(r.code === 200 && r.json.people.length === 0, "a one-letter search asks nothing");
  r = await req("GET", "/api/tmdb/collections", undefined, T(ann)); ok(r.code === 200 && r.json.collections.length === 2, "collections list");
  r = await req("GET", "/api/tmdb/collections?q=bear", undefined, T(ann)); ok(r.json.collections.length === 1, "collections search");
  r = await req("GET", "/api/tmdb/resolve?tmdb=1396&type=series", undefined, T(ann)); ok(r.json.imdb === "tt0903747", "resolve a TMDB id to an IMDb id");
  r = await req("GET", "/api/tmdb/title?imdb=tt0111161"); ok(r.code === 401, "TMDB routes need a sign-in");
  // age limits
  r = await req("POST", "/api/play-check", { imdb: "tt0111161", type: "movie", region: "GB" }, T(ann)); ok(r.json.ok === true && r.json.limit === null, "no age limit: everything plays");
  r = await req("POST", "/api/play-check", { imdb: "tt0111161", type: "movie", region: "GB" }, T(carol)); ok(r.json.ok === false && r.json.reason === "age" && /15/.test(r.json.message) && r.json.limit === 9, "an account that JoolzApp says is 9 cannot play a 15 (" + r.json.message + ")");
  r = await req("POST", "/api/play-check", { imdb: "tt0000777", type: "movie", region: "GB" }, T(carol)); ok(r.json.ok === true, "...but can play a U");
  r = await req("POST", "/api/play-check", { imdb: "tt0000888", type: "movie", region: "GB" }, T(carol)); ok(r.json.ok === false && r.json.reason === "unrated", "an unrated title is not available under a limit");
  r = await req("GET", "/api/tmdb/discover?type=movie", undefined, T(carol)); ok(r.json.items.length === 1 && tmdbStub.hits.some(h => /certification.lte=PG(&|$)/.test(h)), "browsing for that account only asks for age-appropriate films");
  const vwp = (await req("GET", "/api/household", undefined, T(vw))).json.profiles.filter(p => p.self)[0];
  r = await req("PATCH", "/api/household/profiles/" + vwp.id, { maxAge: 7 }, T(vw)); ok(r.code === 403, "a profile cannot set its own age limit");
  r = await req("PATCH", "/api/household/profiles/" + vwp.id, { maxAge: 5 }, T(ann)); ok(r.code === 400, "only the offered age limits are accepted");
  r = await req("PATCH", "/api/household/profiles/" + vwp.id, { maxAge: 7 }, T(ann)); ok(r.code === 200 && r.json.profile.maxAge === 7, "the household owner sets an age limit for a profile");
  r = await req("POST", "/api/play-check", { imdb: "tt0111161", type: "movie", region: "GB" }, T(vw)); ok(r.json.ok === false, "that limit is applied");
  r = await req("POST", "/api/play-check", { imdb: "tt0000777", type: "movie", region: "GB" }, T(vw)); ok(r.json.ok === true && r.json.rating === "U", "a title rated U plays under a 7 limit");
  r = await req("PATCH", "/api/household/profiles/" + vwp.id, { maxAge: null }, T(ann)); ok(r.code === 200 && r.json.profile.maxAge === null, "the limit can be removed");
  r = await req("PUT", "/api/household/prefs", { region: "za" }, T(ann)); ok(r.code === 400, "region must be a two-letter country code");
  r = await req("PUT", "/api/household/prefs", { region: "ZA", locale: "en-GB" }, T(ann)); ok(r.code === 200 && r.json.prefs.region === "ZA" && r.json.prefs.locale === "en-GB", "the household's country and language are saved");
  // the global adult block (everyone) and parent-only kid controls
  const chk = async (tok, imdb) => (await req("POST", "/api/title-check", { imdb, type: "movie", region: "GB" }, T(tok))).json;
  r = await chk(ann, "tt0000999"); ok(r.ok === false && r.reason === "adult", "a title TMDB flags adult is blocked, even for the owner");
  r = await chk(adm, "tt0000998"); ok(r.ok === false && r.reason === "adult", "a softcore keyword blocks it, even for an admin");
  r = await chk(ann, "tt0000997"); ok(r.ok === false && r.reason === "adult", "an adults-only rating (UK R18) blocks it");
  r = await chk(ann, "tt0000996"); ok(r.ok === false && r.reason === "adult", "Cinemeta's Adult genre blocks it when TMDB knows nothing");
  r = await chk(ann, "tt0000995"); ok(r.ok === true, "an ordinary 18-rated 'erotic thriller' is not treated as porn");
  r = await chk(ann, "tt0111161"); ok(r.ok === true, "an ordinary film is fine for an adult");
  r = await req("GET", "/api/state", undefined, T(carol));
  r = await req("GET", "/api/household", undefined, T(ann)); const carolId = r.json.profiles.filter(x => x.kid)[0] && r.json.profiles.filter(x => x.kid)[0].id;
  ok(!!carolId && r.json.manageable.includes(carolId), "the household owner who is the kid's guardian can manage the kid's profile");
  r = await req("GET", "/api/household", undefined, T(vw)); ok(r.json.manageable.length === 0, "another adult in the household manages nobody");
  r = await req("GET", "/api/household", undefined, T(carol)); ok(r.json.manageable.length === 0, "a kid manages nobody");
  r = await req("PATCH", "/api/household/profiles/" + carolId, { maxAge: 7 }, T(carol)); ok(r.code === 403, "a kid cannot change their own age limit");
  r = await req("PATCH", "/api/household/profiles/" + carolId, { mode: "allow" }, T(vw)); ok(r.code === 403, "another adult cannot change a kid's list mode");
  r = await req("GET", "/api/household/profiles/" + carolId + "/titles", undefined, T(vw)); ok(r.code === 403, "another adult cannot even read a kid's list");
  r = await req("PUT", "/api/household/profiles/" + carolId + "/titles", { add: [{ imdb: "tt0111161", name: "Shawshank" }] }, T(carol)); ok(r.code === 403, "a kid cannot edit their own list");
  r = await req("PUT", "/api/household/profiles/" + carolId + "/titles", { add: [{ imdb: "bad", name: "x" }] }, T(ann)); ok(r.code === 400, "titles must be real IMDb ids");
  r = await req("PATCH", "/api/household/profiles/" + carolId, { mode: "sometimes" }, T(ann)); ok(r.code === 400, "the list mode must be off, block or allow");
  r = await req("PUT", "/api/household/profiles/" + carolId + "/titles", { add: [{ imdb: "tt0000777", name: "Little Bear Adventures", type: "movie", poster: "https://img.test/p.jpg" }, { imdb: "tt0000999", name: "Flagged Adult" }] }, T(ann)); ok(r.code === 200 && r.json.titles.length === 2, "a parent adds titles to a kid's list");
  r = await req("PATCH", "/api/household/profiles/" + carolId, { mode: "allow" }, T(ann)); ok(r.code === 200 && r.json.profile.mode === "allow" && r.json.profile.titleCount === 2, "a parent turns on 'only allow these'");
  r = await chk(carol, "tt0000777"); ok(r.ok === true, "allow-list: a listed title plays");
  r = await chk(carol, "tt0111161"); ok(r.ok === false && r.reason === "not_allowed", "allow-list: anything else is refused");
  r = await chk(carol, "tt0000999"); ok(r.ok === false && r.reason === "adult", "allow-list: a listed title that is adult is still blocked (the adult block comes first)");
  r = await req("GET", "/api/policy", undefined, T(carol)); ok(r.json.kid === true && r.json.mode === "allow" && r.json.allowed.length === 2 && r.json.limit === 9, "the kid's policy: kid, allow-list with its titles, age limit 9");
  r = await req("GET", "/api/policy", undefined, T(ann)); ok(r.json.kid === false && r.json.mode === "off" && r.json.allowed.length === 0, "an adult's policy has no restrictions");
  r = await req("PUT", "/api/household/profiles/" + carolId + "/titles", { add: [{ imdb: "tt0111161", name: "Shawshank" }], remove: ["tt0000999", "tt0000777"] }, T(ann)); ok(r.json.titles.length === 1 && r.json.titles[0].imdb === "tt0111161", "titles can be removed (and added in the same call)");
  r = await chk(carol, "tt0111161"); ok(r.ok === true, "a parent-allowed title is not held back by the age limit (a 15 for a 9-year-old)");
  r = await req("PATCH", "/api/household/profiles/" + carolId, { mode: "block" }, T(ann)); ok(r.json.profile.mode === "block", "a parent switches to 'block these'");
  r = await chk(carol, "tt0111161"); ok(r.ok === false && r.reason === "blocked", "block-list: a listed title is refused");
  r = await chk(carol, "tt0000777"); ok(r.ok === true, "block-list: an unlisted title that the age limit allows plays");
  r = await req("PATCH", "/api/household/profiles/" + carolId, { mode: "off" }, T(ann)); ok(r.json.profile.mode === "off", "list off again");
  r = await chk(carol, "tt0111161"); ok(r.ok === false && r.reason === "age", "with the list off the age limit applies again (rated 15 for a 9-year-old)");
  r = await req("PATCH", "/api/household/profiles/" + vwp.id, { kid: true }, T(ann)); ok(r.code === 200 && r.json.profile.kid === true && r.json.profile.kidFlag === true, "a parent can flag a profile as a kids profile");
  r = await req("PATCH", "/api/household/profiles/" + vwp.id, { kid: false }, T(ann)); ok(r.json.profile.kid === false, "...and unflag it");
  // the 50 GB cache and download ahead
  r = await req("GET", "/api/server/cache", undefined, T(ann)); ok(r.code === 200 && r.json.reported === 50 * 1073741824 && r.json.ok === true && r.json.canSet === false && r.json.freeBytes > 0, "on start the cache was set to 50 GB and read back (" + (r.json.reported / 1073741824) + " GB, free disk reported)");
  ok(settingsVals.cacheSize === 50 * 1073741824 && JSON.parse(fs.readFileSync(path.join(dir, "stream-settings.json"), "utf8")).done === true, "the streaming server really has 50 GB, and it is remembered so it is not forced again");
  r = await req("PUT", "/api/server/cache", { gb: 25 }, T(ann)); ok(r.code === 403, "only an admin can change the cache");
  r = await req("PUT", "/api/server/cache", { gb: 25 }, T(adm)); ok(r.code === 200 && settingsVals.cacheSize === 25 * 1073741824, "an admin sets 25 GB");
  r = await req("PUT", "/api/server/cache", { gb: 7 }, T(adm)); ok(r.code === 400, "only the offered sizes");
  r = await req("PUT", "/api/server/cache", { gb: 200 }, T(adm)); ok(r.code === 409 && /did not accept 200 GB/.test(r.json.message), "when the streaming server does not take a size, the answer says so (" + r.json.message + ")");
  await req("PUT", "/api/server/cache", { gb: 50 }, T(adm));
  r = await req("POST", "/api/downloads", { imdb: "tt0111161", type: "movie", name: "Shawshank", infoHash: HASH, fileIdx: 0, region: "GB" }); ok(r.code === 401, "download ahead needs a sign-in");
  r = await req("POST", "/api/downloads", { imdb: "tt0111161", type: "movie", name: "Shawshank", infoHash: "nope", fileIdx: 0 }, T(ann)); ok(r.code === 400, "download ahead only takes a torrent source");
  r = await req("POST", "/api/downloads", { imdb: "tt0111161", type: "movie", name: "Shawshank", infoHash: HASH, fileIdx: 0, region: "GB" }, T(ann)); ok(r.code === 201 && (r.json.job.status === "queued" || r.json.job.status === "downloading"), "a download is accepted (" + r.code + " " + r.text.slice(0, 100) + ")");
  const jid = r.json.job.id; let job; for (let i = 0; i < 30; i++) { await new Promise(x => setTimeout(x, 150)); job = (await req("GET", "/api/downloads", undefined, T(ann))).json.jobs.filter(j => j.id === jid)[0]; if (job && job.status === "ready") break; }
  ok(job && job.status === "ready" && job.bytes === 1000 && job.size === 1000 && job.name === "Shawshank" && job.notified === false, "it reads the whole file and becomes ready (" + (job && job.bytes) + " of " + (job && job.size) + " bytes)");
  r = await req("POST", "/api/downloads", { imdb: "tt0111161", type: "movie", name: "Shawshank", infoHash: HASH, fileIdx: 0, region: "GB" }, T(ann)); ok(r.code === 200 && r.json.existing === true, "asking again for the same file does not start it twice");
  r = await req("POST", "/api/downloads/" + jid + "/notified", {}, T(ann)); ok(r.code === 200, "a notice can be marked as shown");
  r = await req("GET", "/api/downloads", undefined, T(ann)); ok(r.json.jobs[0].notified === true, "...and it stays marked");
  r = await req("GET", "/api/downloads", undefined, T(carol)); ok(r.json.jobs.length === 0, "someone else does not see your downloads");
  r = await req("DELETE", "/api/downloads/" + jid, undefined, T(carol)); ok(r.code === 404, "...and cannot remove them");
  r = await req("POST", "/api/downloads", { imdb: "tt0000999", type: "movie", name: "Adult", infoHash: HASH, fileIdx: 0, region: "GB" }, T(ann)); ok(r.code === 403 && r.json.code === "adult", "an adult title is refused, even for an adult");
  r = await req("POST", "/api/downloads", { imdb: "tt0111161", type: "movie", name: "Shawshank", infoHash: HASH, fileIdx: 0, region: "GB" }, T(carol)); ok(r.code === 403 && r.json.code === "age", "the age limit applies to downloads too (a 15 for a 9-year-old)");
  r = await req("POST", "/api/downloads", { imdb: "tt0111161", type: "movie", name: "Bad file", infoHash: "f".repeat(40), fileIdx: 0, region: "GB" }, T(ann)); const fid = r.json.job.id; let fj; for (let i = 0; i < 20; i++) { await new Promise(x => setTimeout(x, 150)); fj = (await req("GET", "/api/downloads", undefined, T(ann))).json.jobs.filter(j => j.id === fid)[0]; if (fj && fj.status === "failed") break; }
  ok(fj && fj.status === "failed" && /404/.test(fj.error), "a file the streaming server cannot give fails with a reason (" + (fj && fj.error) + ")");
  r = await req("POST", "/api/downloads", { imdb: "tt0111161", type: "movie", name: "Long one", infoHash: "c".repeat(40), fileIdx: 0, region: "GB" }, T(ann)); const sid = r.json.job.id; await new Promise(x => setTimeout(x, 900));
  let sj = (await req("GET", "/api/downloads", undefined, T(ann))).json.jobs.filter(j => j.id === sid)[0]; ok(sj.status === "downloading" && sj.bytes > 0 && sj.size === 100000000, "a long download shows progress (" + sj.bytes + " of " + sj.size + ")");
  r = await req("POST", "/api/downloads", { imdb: "tt0111161", type: "movie", name: "Long two", infoHash: "c".repeat(40), fileIdx: 1, region: "GB" }, T(ann)); const sid2 = r.json.job.id;
  r = await req("POST", "/api/downloads", { imdb: "tt0111161", type: "movie", name: "Long three", infoHash: "c".repeat(40), fileIdx: 2, region: "GB" }, T(ann)); ok(r.code === 201, "a third at the same time is accepted");
  r = await req("POST", "/api/downloads", { imdb: "tt0111161", type: "movie", name: "Long four", infoHash: "c".repeat(40), fileIdx: 3, region: "GB" }, T(ann)); ok(r.code === 429, "a fourth at the same time is refused (3 per person)");
  sj = (await req("GET", "/api/downloads", undefined, T(ann))).json.jobs; ok(sj.filter(j => j.status === "downloading").length === 2 && sj.filter(j => j.status === "queued").length === 1, "only 2 run at a time, the rest wait");
  r = await req("DELETE", "/api/downloads/" + sid, undefined, T(ann)); ok(r.code === 200, "a running download can be cancelled"); await new Promise(x => setTimeout(x, 400));
  sj = (await req("GET", "/api/downloads", undefined, T(ann))).json.jobs; ok(!sj.some(j => j.id === sid) && sj.filter(j => j.status === "downloading").length === 2, "it disappears and the waiting one takes its place");
  for (const x of sj.filter(j => j.status === "downloading" || j.status === "queued")) await req("DELETE", "/api/downloads/" + x.id, undefined, T(ann));
  // UI build selection
  r = await req("GET", "/", undefined, { "user-agent": "Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 Chrome/53.0.2785.34 Safari/537.36 WebAppManager" }); ok(r.text === "COMPAT" && /User-Agent/i.test(r.headers.vary), "LG webOS TV gets the compat build");
  r = await req("GET", "/", undefined, { "user-agent": "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/126.0 Safari/537.36" }); ok(r.text === "MODERN", "modern browser gets the modern build");
  r = await req("GET", "/", undefined, { "user-agent": "Mozilla/5.0 Chrome/60.0 Safari/537.36" }); ok(r.text === "COMPAT", "any old Chrome (<70) gets the compat build");
  r = await req("GET", "/?modern=1", undefined, { "user-agent": "Web0S" }); ok(r.text === "MODERN", "?modern=1 override");
  r = await req("GET", "/%2e%2e/server.js"); ok(r.code === 403 || r.code === 404, "path traversal blocked");
})().catch(e => { fails++; console.log("ERROR", e.stack); }).then(() => { child.kill(); upstream.close(); tmdbStub.srv.close(); console.log(fails ? fails + " FAILED" : "ALL PASSED"); process.exit(fails ? 1 : 0); });
