// Starts server.js with a stand-in account service and a fake streaming server, then checks the rules.
"use strict";
const http = require("http"), fs = require("fs"), os = require("os"), path = require("path"), cp = require("child_process");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jtv-")), P = 39600 + Math.floor(Math.random() * 300), U = P + 1;
fs.mkdirSync(path.join(dir, "dist", "compat"), { recursive: true }); fs.mkdirSync(path.join(dir, "dist", "modern"), { recursive: true });
fs.writeFileSync(path.join(dir, "dist", "compat", "index.html"), "COMPAT"); fs.writeFileSync(path.join(dir, "dist", "modern", "index.html"), "MODERN");
fs.mkdirSync(path.join(dir, "devtest"), { recursive: true }); fs.writeFileSync(path.join(dir, "devtest", "index.json"), '{"v":1,"clips":[{"id":"h264","trait":"h264","label":"H.264","kind":"video","file":"h264.mp4"}]}'); fs.writeFileSync(path.join(dir, "devtest", "h264.mp4"), Buffer.alloc(3000, 1));
const HASH = "a".repeat(40), BODY = Buffer.from("0123456789".repeat(100));

const upstream = http.createServer((q, r) => {
  if (q.url.indexOf("/" + HASH + "/") === 0) {
    const rg = /bytes=(\d+)-(\d*)/.exec(q.headers.range || "");
    if (rg) { const s = +rg[1], e = rg[2] ? +rg[2] : BODY.length - 1; r.writeHead(206, { "content-type": "video/mp4", "content-range": "bytes " + s + "-" + e + "/" + BODY.length, "content-length": e - s + 1, "accept-ranges": "bytes" }); return r.end(BODY.slice(s, e + 1)); }
    r.writeHead(200, { "content-type": "video/mp4", "content-length": BODY.length, "accept-ranges": "bytes" }); return r.end(BODY);
  }
  if (q.url.indexOf("/hlsv2/x/master.m3u8") === 0) { r.writeHead(200, { "content-type": "application/vnd.apple.mpegurl" }); return r.end("#EXTM3U\n#EXT-X-MEDIA:URI=\"/hlsv2/x/audio.m3u8\"\n/hlsv2/x/video.m3u8\nhttp://127.0.0.1:11470/hlsv2/x/other.m3u8\nrelative.m3u8\n"); }
  if (q.url.indexOf("/opensubHash") === 0) { r.writeHead(200, { "content-type": "application/json" }); return r.end('{"result":{"hash":"8e245d9679d31e12","size":1000}}'); }
  if (q.url === "/settings") { r.writeHead(200, { "content-type": "application/json" }); return r.end("{}"); }
  r.writeHead(200); r.end("SECRET-" + q.url);
}).listen(U);

const child = cp.spawn(process.execPath, [path.join(__dirname, "server.js")], { env: Object.assign({}, process.env, { NODE_ENV: "test", JTV_PB: path.join(__dirname, "test", "mock-pb.js"), PORT: P, DATA_DIR: dir, JTV_CACHE_MS: "0", FFMPEG: "/nonexistent/ffmpeg", DEVTEST_DIR: path.join(dir, "devtest"), UI_DIST: path.join(dir, "dist"), STREAM_UPSTREAM: "http://127.0.0.1:" + U }), stdio: "ignore" });
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
  // UI build selection
  r = await req("GET", "/", undefined, { "user-agent": "Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 Chrome/53.0.2785.34 Safari/537.36 WebAppManager" }); ok(r.text === "COMPAT" && /User-Agent/i.test(r.headers.vary), "LG webOS TV gets the compat build");
  r = await req("GET", "/", undefined, { "user-agent": "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/126.0 Safari/537.36" }); ok(r.text === "MODERN", "modern browser gets the modern build");
  r = await req("GET", "/", undefined, { "user-agent": "Mozilla/5.0 Chrome/60.0 Safari/537.36" }); ok(r.text === "COMPAT", "any old Chrome (<70) gets the compat build");
  r = await req("GET", "/?modern=1", undefined, { "user-agent": "Web0S" }); ok(r.text === "MODERN", "?modern=1 override");
  r = await req("GET", "/%2e%2e/server.js"); ok(r.code === 403 || r.code === 404, "path traversal blocked");
})().catch(e => { fails++; console.log("ERROR", e.stack); }).then(() => { child.kill(); upstream.close(); console.log(fails ? fails + " FAILED" : "ALL PASSED"); process.exit(fails ? 1 : 0); });
