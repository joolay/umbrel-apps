// Seek preview pictures (thumbs.js): a real frame out of a real file served over HTTP with ranges, like the streaming server does.
"use strict";
const fs = require("fs"), os = require("os"), path = require("path"), http = require("http"), cp = require("child_process");
const T = require("./thumbs.js");
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log("FAIL", m); } else console.log("ok  ", m); };
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "thumbs-")), f = path.join(dir, "film.mp4");
  const g = cp.spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=640x360:r=10:d=60", "-c:v", "mpeg4", "-g", "10", "-pix_fmt", "yuv420p", f]);
  if (g.status !== 0) { console.log("skip  (no mpeg4 encoder here)"); process.exit(0); }
  const buf = fs.readFileSync(f); let reqs = 0;
  const srv = http.createServer((q, r) => {
    reqs++; const rg = /bytes=(\d+)-(\d*)/.exec(q.headers.range || "");
    if (rg) { const s = +rg[1], e = rg[2] ? Math.min(+rg[2], buf.length - 1) : buf.length - 1; r.writeHead(206, { "content-type": "video/mp4", "content-range": "bytes " + s + "-" + e + "/" + buf.length, "content-length": e - s + 1, "accept-ranges": "bytes" }); return r.end(buf.slice(s, e + 1)); }
    r.writeHead(200, { "content-type": "video/mp4", "content-length": buf.length, "accept-ranges": "bytes" }); r.end(buf);
  });
  await new Promise(r => srv.listen(0, r)); const url = "http://127.0.0.1:" + srv.address().port + "/film.mp4";
  const a = await T.frame(url, 20), b = await T.frame(url, 40);
  ok(a[0] === 0xff && a[1] === 0xd8 && a.length > 1000 && a.length < 60000, "a JPEG picture (" + a.length + " bytes) at 20 s");
  const probe = cp.spawnSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", "-f", "image2pipe", "-"], { input: a }); const st = JSON.parse(probe.stdout.toString()).streams[0];
  ok(st.width === 256 && st.height === 144, "256 pixels wide, the film's shape kept (" + st.width + "x" + st.height + ")");
  ok(!a.equals(b), "different seconds give different pictures");
  let e = null; try { await T.frame(url, 9999); } catch (x) { e = x; } ok(e && e.code === "no_frame", "a time past the end gives 'no picture', not a crash");
  e = null; try { await T.frame(url, 5, { ffmpeg: "/nonexistent/ffmpeg" }); } catch (x) { e = x; } ok(e && e.code === "no_ffmpeg", "missing ffmpeg gives a clear error");
  e = null; try { await T.frame("http://127.0.0.1:9/none.mp4", 5, { timeout: 4000 }); } catch (x) { e = x; } ok(!!e, "an unreachable file fails cleanly");
  ok(reqs < 40, "reading one picture only fetched part of the file (" + reqs + " requests)");
  srv.close(); fs.rmSync(dir, { recursive: true, force: true }); console.log(fails ? fails + " FAILED" : "ALL PASSED"); process.exit(fails ? 1 : 0);
})().catch(e => { console.log("ERROR", e.stack); process.exit(1); });
