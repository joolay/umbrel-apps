// One small picture from a video at a given second (for the seek preview), made with ffmpeg from the file the streaming server is already serving.
"use strict";
const { spawn } = require("child_process");
function frame(url, t, { ffmpeg = "ffmpeg", timeout = 12000, width = 256 } = {}) {
  return new Promise((ok, bad) => {
    let p; try { p = spawn(ffmpeg, ["-v", "error", "-ss", String(Math.max(0, t)), "-i", url, "-frames:v", "1", "-vf", "scale=" + width + ":-2:flags=bilinear", "-q:v", "7", "-f", "image2pipe", "-vcodec", "mjpeg", "-"], { stdio: ["ignore", "pipe", "ignore"] }); }
    catch (e) { return bad(Object.assign(new Error("ffmpeg is not available"), { code: "no_ffmpeg" })); }
    const out = []; let n = 0, done = false;
    const timer = setTimeout(() => { if (!done) { done = true; p.kill("SIGKILL"); bad(Object.assign(new Error("timed out"), { code: "timeout" })); } }, timeout);
    p.stdout.on("data", d => { n += d.length; if (n < 400e3) out.push(d); });
    p.on("error", e => { if (done) return; done = true; clearTimeout(timer); bad(Object.assign(new Error(e.code === "ENOENT" ? "ffmpeg is not available" : e.message), { code: e.code === "ENOENT" ? "no_ffmpeg" : "spawn" })); });
    p.on("close", () => { if (done) return; done = true; clearTimeout(timer); const b = Buffer.concat(out); if (b.length > 200 && b[0] === 0xff && b[1] === 0xd8) ok(b); else bad(Object.assign(new Error("no picture at that time"), { code: "no_frame" })); });
  });
}
module.exports = { frame };
