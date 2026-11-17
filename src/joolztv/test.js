// Starts server.js with a stand-in account service and a fake streaming server, then checks the rules.
"use strict";
const http = require("http"), fs = require("fs"), os = require("os"), path = require("path"), cp = require("child_process");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jtv-")), P = 39600 + Math.floor(Math.random() * 300), U = P + 1;
fs.mkdirSync(path.join(dir, "dist", "compat"), { recursive: true }); fs.mkdirSync(path.join(dir, "dist", "modern"), { recursive: true });
fs.writeFileSync(path.join(dir, "dist", "compat", "index.html"), "COMPAT"); fs.writeFileSync(path.join(dir, "dist", "modern", "index.html"), "MODERN");
const HASH = "a".repeat(40), BODY = Buffer.from("0123456789".repeat(100));

const upstream = http.createServer((q, r) => {
  if (q.url.indexOf("/" + HASH + "/") === 0) {
    const rg = /bytes=(\d+)-(\d*)/.exec(q.headers.range || "");
    if (rg) { const s = +rg[1], e = rg[2] ? +rg[2] : BODY.length - 1; r.writeHead(206, { "content-type": "video/mp4", "content-range": "bytes " + s + "-" + e + "/" + BODY.length, "content-length": e - s + 1, "accept-ranges": "bytes" }); return r.end(BODY.slice(s, e + 1)); }
    r.writeHead(200, { "content-type": "video/mp4", "content-length": BODY.length, "accept-ranges": "bytes" }); return r.end(BODY);
  }
  if (q.url.indexOf("/hlsv2/x/master.m3u8") === 0) { r.writeHead(200, { "content-type": "application/vnd.apple.mpegurl" }); return r.end("#EXTM3U\n#EXT-X-MEDIA:URI=\"/hlsv2/x/audio.m3u8\"\n/hlsv2/x/video.m3u8\nhttp://127.0.0.1:11470/hlsv2/x/other.m3u8\nrelative.m3u8\n"); }
  if (q.url === "/settings") { r.writeHead(200, { "content-type": "application/json" }); return r.end("{}"); }
  r.writeHead(200); r.end("SECRET-" + q.url);
}).listen(U);

const child = cp.spawn(process.execPath, [path.join(__dirname, "server.js")], { env: Object.assign({}, process.env, { NODE_ENV: "test", JTV_PB: path.join(__dirname, "test", "mock-pb.js"), PORT: P, DATA_DIR: dir, UI_DIST: path.join(dir, "dist"), STREAM_UPSTREAM: "http://127.0.0.1:" + U }), stdio: "ignore" });
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
  r = await req("GET", "/s/" + st + "/proxy/secret"); ok(r.code === 404 && r.text.indexOf("SECRET") < 0, "only torrent/hls paths reach the streaming server");
  r = await req("GET", "/s/" + st + "/hlsv2/x/master.m3u8"); ok(r.text.indexOf("/s/" + st + "/hlsv2/x/video.m3u8") >= 0 && r.text.indexOf('URI="/s/' + st + '/hlsv2/x/audio.m3u8"') >= 0 && r.text.indexOf("127.0.0.1") < 0 && /\nrelative\.m3u8\n/.test(r.text), "HLS playlists rewritten to stay behind the sign-in");
  // roles
  r = await req("DELETE", "/api/household/profiles/" + annId, undefined, T(bob)); ok(r.code === 403, "a member cannot remove the owner");
  r = await req("PATCH", "/api/household/profiles/" + bobId, { name: "Robert" }, T(bob)); ok(r.code === 200 && r.json.profile.name === "Robert", "a member can rename their own profile");
  r = await req("DELETE", "/api/household/profiles/" + bobId, undefined, T(ann)); ok(r.code === 200 && r.json.profiles.length === 11, "owner can remove a profile (removes that account's data)");
  r = await req("GET", "/api/state", undefined, T(bob)); ok(r.code === 403, "removed profile loses access to household data");
  // UI build selection
  r = await req("GET", "/", undefined, { "user-agent": "Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 Chrome/53.0.2785.34 Safari/537.36 WebAppManager" }); ok(r.text === "COMPAT" && /User-Agent/i.test(r.headers.vary), "LG webOS TV gets the compat build");
  r = await req("GET", "/", undefined, { "user-agent": "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/126.0 Safari/537.36" }); ok(r.text === "MODERN", "modern browser gets the modern build");
  r = await req("GET", "/", undefined, { "user-agent": "Mozilla/5.0 Chrome/60.0 Safari/537.36" }); ok(r.text === "COMPAT", "any old Chrome (<70) gets the compat build");
  r = await req("GET", "/?modern=1", undefined, { "user-agent": "Web0S" }); ok(r.text === "MODERN", "?modern=1 override");
  r = await req("GET", "/%2e%2e/server.js"); ok(r.code === 403 || r.code === 404, "path traversal blocked");
})().catch(e => { fails++; console.log("ERROR", e.stack); }).then(() => { child.kill(); upstream.close(); console.log(fails ? fails + " FAILED" : "ALL PASSED"); process.exit(fails ? 1 : 0); });
