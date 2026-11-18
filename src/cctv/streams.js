// Live video: one ffmpeg per camera and quality, started when the first viewer arrives and stopped shortly after the last one leaves.
// ffmpeg reads the camera's RTSP stream and writes JPEG pictures; every viewer of that camera gets the same pictures.
// (Browsers and the old TV browser can't play RTSP, but they can show a fast stream of JPEG pictures, with no plug-in or library.)
"use strict";
const cp = require("child_process");
const dev = require("./devices");

const QUALITY = {
  sub:  { fps: +process.env.CCTV_SUB_FPS || 6,  width: +process.env.CCTV_SUB_WIDTH || 640,  q: +process.env.CCTV_SUB_Q || 9 },
  main: { fps: +process.env.CCTV_MAIN_FPS || 10, width: +process.env.CCTV_MAIN_WIDTH || 1280, q: +process.env.CCTV_MAIN_Q || 5 },
};
const SOI = Buffer.from([0xff, 0xd8]), EOI = Buffer.from([0xff, 0xd9]);

// Splits ffmpeg's output into whole JPEG pictures (FFD8 ... FFD9; a 0xFF inside picture data is always escaped, so the first FFD9 is the end).
function makeSplitter(onFrame) {
  let buf = Buffer.alloc(0);
  return chunk => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      const s = buf.indexOf(SOI);
      if (s < 0) { buf = Buffer.alloc(0); return; }
      const e = buf.indexOf(EOI, s + 2);
      if (e < 0) { if (s > 0) buf = buf.slice(s); if (buf.length > 4e6) buf = Buffer.alloc(0); return; }
      onFrame(buf.slice(s, e + 2)); buf = buf.slice(e + 2);
    }
  };
}
function ffmpegArgs(url, quality) {
  const o = QUALITY[quality] || QUALITY.sub;
  const input = /^rtsps?:/i.test(url) ? ["-fflags", "nobuffer", "-flags", "low_delay", "-rtsp_transport", "tcp", "-timeout", "8000000"] : ["-re"];
  return ["-hide_banner", "-loglevel", "error", "-nostdin", ...input, "-i", url, "-an", "-sn",
    "-vf", `fps=${o.fps},scale=${o.width}:-2,format=yuvj420p`, "-q:v", String(o.q), "-f", "image2pipe", "-c:v", "mjpeg", "pipe:1"];
}

function createStreams(opts) {
  const ffmpeg = opts.ffmpegPath || "ffmpeg", maxProcs = opts.maxProcs || 24, idleMs = opts.idleMs == null ? 8000 : opts.idleMs, stallMs = opts.stallMs || 15000;
  const log = opts.log || (() => {});
  const entries = new Map();   // "camId|quality" -> entry

  function emit(e, state, message) { e.state = state; e.message = message || ""; for (const s of e.subs) { try { s.onState(state, message || ""); } catch {} } }
  function start(e) {
    if (e.proc || e.stopped) return;
    let url;
    try { url = opts.urlFor(e.camId, e.quality); } catch (err) { emit(e, "error", err.message); return; }
    const running = [...entries.values()].filter(x => x.proc).length;
    if (running >= maxProcs) { emit(e, "error", "Too many cameras are streaming at once"); e.retry = setTimeout(() => { e.retry = null; start(e); }, 5000); return; }
    emit(e, "connecting", "");
    const p = cp.spawn(ffmpeg, ffmpegArgs(url, e.quality), { stdio: ["ignore", "pipe", "pipe"] });
    e.proc = p; e.lastFrame = Date.now(); let err = "";
    const split = makeSplitter(frame => {
      e.lastFrame = Date.now(); e.backoff = 2000;
      if (e.state !== "live") emit(e, "live", "");
      e.last = frame;
      for (const s of e.subs) { try { s.onFrame(frame); } catch {} }
    });
    p.stdout.on("data", split);
    p.stderr.on("data", d => { err = (err + d).slice(-600); });
    p.on("error", er => { err = er.code === "ENOENT" ? "ffmpeg is not installed in this container" : er.message; });
    const watch = setInterval(() => { if (Date.now() - e.lastFrame > stallMs) { log("stalled " + e.key); try { p.kill("SIGKILL"); } catch {} } }, 3000);
    p.on("close", () => {
      clearInterval(watch); e.proc = null; e.last = null;
      if (e.stopped || !e.subs.size) return;
      const lines = dev.maskUrl(err).split(/\r?\n/).map(x => x.trim()).filter(Boolean);
      const last = lines[lines.length - 1] || "The camera stopped sending video";
      emit(e, "error", /401|Unauthorized/i.test(last) ? "The recorder refused the login" : /Connection (refused|timed out)|No route|timed out|Network is unreachable|Name or service not known/i.test(last) ? "Can't reach the recorder" : last.slice(0, 160));
      e.retry = setTimeout(() => { e.retry = null; start(e); }, e.backoff); e.backoff = Math.min(e.backoff * 2, 20000);
    });
  }
  function stopLater(e) {
    clearTimeout(e.idle);
    e.idle = setTimeout(() => {
      if (e.subs.size) return;
      e.stopped = true; clearTimeout(e.retry); if (e.proc) { try { e.proc.kill("SIGKILL"); } catch {} }
      entries.delete(e.key);
    }, idleMs);
  }
  return {
    // Starts (or joins) the stream for one camera. Returns a function that leaves it.
    subscribe(camId, quality, onFrame, onState) {
      quality = quality === "main" ? "main" : "sub";
      const key = camId + "|" + quality;
      let e = entries.get(key);
      if (!e) { e = { key, camId, quality, subs: new Set(), proc: null, state: "connecting", message: "", last: null, backoff: 2000, stopped: false }; entries.set(key, e); }
      clearTimeout(e.idle);
      const sub = { onFrame, onState }; e.subs.add(sub);
      onState(e.state, e.message); if (e.last) { try { onFrame(e.last); } catch {} }
      if (!e.proc && !e.retry) start(e);
      return () => { e.subs.delete(sub); if (!e.subs.size) stopLater(e); };
    },
    // Camera or site was changed or removed: drop its running streams so the next viewer starts with the new settings.
    reset(match) { for (const e of [...entries.values()]) if (match(e.camId)) { e.stopped = true; clearTimeout(e.retry); clearTimeout(e.idle); if (e.proc) { try { e.proc.kill("SIGKILL"); } catch {} } entries.delete(e.key); for (const s of e.subs) { try { s.onState("error", "Camera settings changed, reopen the view"); } catch {} } } },
    stats: () => [...entries.values()].map(e => ({ cam: e.camId, quality: e.quality, state: e.state, viewers: e.subs.size })),
    stopAll() { for (const e of entries.values()) { e.stopped = true; clearTimeout(e.retry); clearTimeout(e.idle); if (e.proc) { try { e.proc.kill("SIGKILL"); } catch {} } } entries.clear(); },
  };
}
module.exports = { createStreams, makeSplitter, ffmpegArgs, QUALITY };
