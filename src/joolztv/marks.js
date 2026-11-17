// Fallback for skip points when the community databases know nothing: the chapters inside the file (ffprobe), e.g. "Intro", "Opening", "Credits", "Post-credits scene".
// Nothing is detected from the picture or the sound.
"use strict";
const { spawn } = require("child_process");

function run(bin, args, { timeout = 20000, binary = false } = {}) {
  return new Promise((ok, bad) => {
    let p; try { p = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] }); } catch (e) { return bad(Object.assign(new Error("ffmpeg is not available"), { code: "no_ffmpeg" })); }
    const out = [], err = []; let done = false;
    const t = setTimeout(() => { if (!done) { done = true; p.kill("SIGKILL"); bad(Object.assign(new Error("timed out"), { code: "timeout" })); } }, timeout);
    p.stdout.on("data", d => out.push(d)); p.stderr.on("data", d => { if (err.length < 20) err.push(d); });
    p.on("error", e => { if (done) return; done = true; clearTimeout(t); bad(Object.assign(new Error(e.code === "ENOENT" ? "ffmpeg is not available" : e.message), { code: e.code === "ENOENT" ? "no_ffmpeg" : "spawn" })); });
    p.on("close", code => { if (done) return; done = true; clearTimeout(t); ok({ code, out: Buffer.concat(out), err: Buffer.concat(err).toString() }); });
  });
}

/* ---- chapters ---- */
const INTRO_RE = /^\s*(intro(duction)?|opening( credits?| sequence| titles?)?|op\d*|title sequence|main titles?|theme song|cold open end)\s*\d*\s*$/i;
const CREDITS_RE = /^\s*(end(ing)?( credits?| titles?| sequence)?|credits?|closing( credits?)?|outro|ed\d*|roll credits)\s*\d*\s*$/i;
const SCENE_RE = /(post.?credits?|after.?credits?|mid.?credits?|stinger|bonus( scene)?|extra scene|epilogue|teaser)/i;
/* chapters [{start, end, title}] and the file's duration -> what they say about the intro, the credits and any credit scene */
function fromChapters(chs, duration) {
  const out = { intro: null, credits: null, scenes: [] };
  if (!chs || !chs.length || !(duration > 0)) return out;
  for (const c of chs) {
    const len = c.end - c.start;
    if (!out.intro && INTRO_RE.test(c.title) && len >= 8 && len <= 300 && c.start < duration * 0.4) out.intro = { start: c.start, end: c.end };
    else if (!out.credits && c.start > duration * 0.5 && !SCENE_RE.test(c.title) && CREDITS_RE.test(c.title)) out.credits = { start: c.start, end: c.end };
    else if (c.start > duration * 0.5 && SCENE_RE.test(c.title) && len >= 5) out.scenes.push(c.start);
  }
  if (out.credits) {                                     // a chapter of real length after the credits chapter is a scene (named only "Chapter 31", say)
    const after = chs.filter(c => c.start >= out.credits.end - 0.5 && c.start > out.credits.start && !CREDITS_RE.test(c.title) && c.end - c.start >= 10);
    if (after.length && !out.scenes.length) out.scenes.push(after[0].start);
  }
  out.scenes = Array.from(new Set(out.scenes.map(x => Math.round(x * 10) / 10))).sort((a, b) => a - b);
  return out;
}
async function chapters(url, { ffprobe = "ffprobe", timeout = 25000 } = {}) {
  const r = await run(ffprobe, ["-v", "error", "-print_format", "json", "-show_chapters", "-show_entries", "format=duration", url], { timeout });
  if (r.code !== 0) throw Object.assign(new Error("could not read the file"), { code: "unreadable" });
  let j; try { j = JSON.parse(r.out.toString()); } catch { j = {}; }
  const duration = parseFloat(j.format && j.format.duration) || 0;
  const chs = (j.chapters || []).map(c => ({ start: parseFloat(c.start_time), end: parseFloat(c.end_time), title: String((c.tags && (c.tags.title || c.tags.TITLE)) || "") })).filter(c => isFinite(c.start) && isFinite(c.end));
  return Object.assign({ duration, hasChapters: chs.length > 0 }, fromChapters(chs, duration));
}

module.exports = { chapters, fromChapters, INTRO_RE, CREDITS_RE, SCENE_RE };
