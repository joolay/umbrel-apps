// Finds where the opening credits are, where the end credits start, and whether a mid- or end-credit scene follows.
//  1. Chapters inside the file (ffprobe): "Intro", "Opening", "Credits", "Post-credits scene", ...
//  2. Otherwise, for the end: one tiny frame every few seconds from the tail of the file, labelled "credits-like" (dark, little detail) or "picture".
//     A long run of credits-like frames is the credits; a run of picture frames inside or after it is a credit scene.
// Needs ffmpeg + ffprobe. Nothing here is guessed from sound.
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

/* ---- the picture ---- */
/* 32x18 RGB frame -> {mean, lit, dim}: average brightness, the share of bright pixels and the share of dark ones */
function features(buf) {
  const n = Math.floor(buf.length / 3); if (!n) return null;
  let sum = 0, lit = 0, dim = 0;
  for (let i = 0; i < n; i++) { const y = 0.299 * buf[i * 3] + 0.587 * buf[i * 3 + 1] + 0.114 * buf[i * 3 + 2]; sum += y; if (y > 140) lit++; if (y < 110) dim++; }
  return { mean: sum / n, lit: lit / n, dim: dim / n };
}
/* dark with only a few bright spots (black, or text on black: rolling credits), or the same on white */
const creditsLike = f => !!f && ((f.mean < 55 && f.lit < 0.15) || (f.mean > 205 && f.dim < 0.15));
/* samples [{t, c}] (c = credits-like) in time order -> where the credits start and where credit scenes begin.
   Credits = the longest run of credits-like samples that lasts at least minCredits seconds. A scene = at least minScene seconds of picture after that start,
   followed by credits again or by the end of the file. */
function analyse(samples, { step = 6, minCredits = 48, minScene = 15, duration = 0 } = {}) {
  const runs = []; let cur = null;
  for (const s of samples) { if (cur && cur.c === s.c) { cur.n++; cur.last = s.t; } else { cur = { c: s.c, start: s.t, last: s.t, n: 1 }; runs.push(cur); } }
  const len = r => r.n * step;
  let best = null; for (const r of runs) if (r.c && len(r) >= minCredits && (!best || len(r) > len(best))) best = r;
  // credits may be broken up by scenes: take the first credits run that is long enough, and carry on from there
  const first = runs.filter(r => r.c && len(r) >= minCredits)[0] || null;
  const startRun = first || best;
  if (!startRun) return { creditsStart: null, scenes: [] };
  const scenes = [];
  for (let i = runs.indexOf(startRun) + 1; i < runs.length; i++) {
    const r = runs[i]; if (r.c || len(r) < minScene) continue;
    if (duration && r.last >= duration - step) { if (len(r) < minScene * 1.5) continue; }          // a short flash at the very end is a logo, not a scene
    scenes.push(r.start);
  }
  return { creditsStart: startRun.start, scenes };
}
async function frameAt(url, t, { ffmpeg = "ffmpeg", timeout = 15000 } = {}) {
  const r = await run(ffmpeg, ["-v", "error", "-ss", String(Math.max(0, t)), "-i", url, "-frames:v", "1", "-vf", "scale=32:18:flags=area", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { timeout });
  return r.out.length >= 32 * 18 * 3 ? features(r.out.slice(0, 32 * 18 * 3)) : null;
}
/* looks at the file from `from` to its end; returns {creditsStart, scenes} in seconds (null / [] when nothing is found) */
async function tail(url, { from, duration, step = 6, ffmpeg = "ffmpeg", concurrency = 3, maxSamples = 220, budgetMs = 100000, log } = {}) {
  if (!(duration > 0) || !(from >= 0) || from >= duration - 20) return { creditsStart: null, scenes: [] };
  const t0 = Date.now(), times = []; for (let t = from; t < duration - 3 && times.length < maxSamples; t += step) times.push(t);
  const res = new Array(times.length); let next = 0, fails = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < times.length && Date.now() - t0 < budgetMs) {
      const i = next++;
      try { const f = await frameAt(url, times[i], { ffmpeg }); res[i] = f; if (!f) fails++; } catch (e) { fails++; if (e.code === "no_ffmpeg") throw e; }
    }
  }));
  const samples = []; times.forEach((t, i) => { if (res[i]) samples.push({ t, c: creditsLike(res[i]) }); });
  if (samples.length < times.length * 0.6) throw Object.assign(new Error("could not read enough of the file"), { code: "unreadable" });
  const a = analyse(samples, { step, duration });
  if (a.creditsStart === null) return a;
  // sharpen the edges: look between the last sample before each change and the first one after it
  const refine = async (tA, tB, wantCredits) => {            // tA is on one side of a change, tB on the other; returns the first time on tB's side
    let lo = tA, hi = tB;
    for (let k = 0; k < 3 && hi - lo > 1.5; k++) { const mid = (lo + hi) / 2; let f = null; try { f = await frameAt(url, mid, { ffmpeg }); } catch {} if (!f) break; if (creditsLike(f) === wantCredits) hi = mid; else lo = mid; }
    return Math.round(hi * 10) / 10;
  };
  try {
    const prev = t => { const i = samples.findIndex(s => s.t === t); return i > 0 ? samples[i - 1].t : t - step; };
    const cs = a.creditsStart; if (cs > from + 0.5) a.creditsStart = await refine(prev(cs), cs, true);
    a.scenes = await Promise.all(a.scenes.map(sc => refine(prev(sc), sc, false)));
  } catch {}
  return a;
}
module.exports = { chapters, fromChapters, features, creditsLike, analyse, tail, frameAt, INTRO_RE, CREDITS_RE, SCENE_RE };
