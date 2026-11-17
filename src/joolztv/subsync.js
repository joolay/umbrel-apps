// Auto-sync for subtitles: listens to a few short windows of the file's audio, marks where speech is, and lines that up with
// when the subtitle says people are talking (the idea behind ffsubsync). Finds a constant shift and, with two windows, clock drift
// (e.g. a subtitle made for 25 fps used on a 23.976 fps file). Needs ffmpeg + ffprobe.
"use strict";
const { spawn } = require("child_process");
const FRAME = 0.1;                                   // seconds per analysis frame

/* ---- subtitle text -> cues [{s, e}] in seconds ---- */
function parseCues(text) {
  const out = [], re = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})\s*-->\s*(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/g;
  let m; const t = (h, mi, s, f) => (+(h || 0)) * 3600 + (+mi) * 60 + (+s) + (+String(f).padEnd(3, "0")) / 1000;
  while ((m = re.exec(String(text || "")))) {
    const s = t(m[1], m[2], m[3], m[4]), e = t(m[5], m[6], m[7], m[8]);
    if (e > s && e - s < 15) out.push({ s, e });
  }
  return out.sort((a, b) => a.s - b.s);
}
/* cue coverage as 0/1 frames over [from - pad, from + len + pad] seconds */
function subMask(cues, from, len, pad) {
  const n = Math.ceil((len + 2 * pad) / FRAME), v = new Uint8Array(n), t0 = from - pad;
  for (const c of cues) {
    if (c.e < t0 || c.s > t0 + n * FRAME) continue;
    const a = Math.max(0, Math.floor((c.s - t0) / FRAME)), b = Math.min(n, Math.ceil((c.e - t0) / FRAME));
    for (let i = a; i < b; i++) v[i] = 1;
  }
  return v;
}
/* 16-bit mono PCM (8 kHz) -> 0/1 speech frames (loud relative to this window's own noise floor) */
function speechMask(pcm, rate) {
  const fl = Math.round(rate * FRAME), n = Math.floor(pcm.length / fl), rms = new Float64Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let j = i * fl; j < (i + 1) * fl; j++) s += pcm[j] * pcm[j]; rms[i] = Math.sqrt(s / fl); }
  const sorted = Array.from(rms).sort((a, b) => a - b), pick = q => sorted[Math.min(n - 1, Math.floor(q * n))];
  const floor = pick(0.2), top = pick(0.92), thr = floor + 0.3 * (top - floor);
  const m = new Uint8Array(n); for (let i = 0; i < n; i++) m[i] = rms[i] > thr && top > floor * 1.5 ? 1 : 0;
  for (let i = 1; i < n - 1; i++) if (!m[i] && m[i - 1] && m[i + 1]) m[i] = 1;          // close one-frame gaps
  for (let i = 1; i < n - 1; i++) if (m[i] && !m[i - 1] && !m[i + 1]) m[i] = 0;           // drop single-frame blips
  return m;
}
/* best shift k (frames) so that subtitle(t) + k*FRAME lines up with the audio; returns {k, z} (z = how clearly it stands out) */
function correlate(audio, sub, pad) {
  const n = audio.length; let ma = 0, mb = 0; for (let i = 0; i < n; i++) ma += audio[i]; ma /= n; for (let j = 0; j < sub.length; j++) mb += sub[j]; mb /= sub.length;
  const a = Float64Array.from(audio, x => x - ma), b = Float64Array.from(sub, x => x - mb), scores = new Float64Array(2 * pad + 1);
  for (let k = -pad; k <= pad; k++) { let s = 0; const off = pad - k; for (let i = 0; i < n; i++) { const j = i + off; if (j >= 0 && j < b.length) s += a[i] * b[j]; } scores[k + pad] = s; }
  let best = 0, mean = 0; for (let i = 0; i < scores.length; i++) { mean += scores[i]; if (scores[i] > scores[best]) best = i; } mean /= scores.length;
  let sd = 0; for (let i = 0; i < scores.length; i++) sd += (scores[i] - mean) * (scores[i] - mean); sd = Math.sqrt(sd / scores.length) || 1;
  const k = best - pad, edge = best < 3 || best > scores.length - 4;
  return { k, z: edge ? 0 : (scores[best] - mean) / sd };
}
function pcmOf(url, start, len, ffmpeg, ms) {
  return new Promise((ok, bad) => {
    const p = spawn(ffmpeg, ["-v", "error", "-nostdin", "-ss", String(Math.max(0, start)), "-t", String(len), "-i", url, "-vn", "-sn", "-ac", "1", "-ar", "8000", "-af", "highpass=f=200,lowpass=f=3400", "-f", "s16le", "pipe:1"], { stdio: ["ignore", "pipe", "pipe"] });
    const chunks = []; let done = false, err = "";
    const kill = setTimeout(() => { if (!done) { done = true; p.kill("SIGKILL"); bad(Object.assign(new Error("Reading the audio took too long"), { code: "timeout" })); } }, ms);
    p.stdout.on("data", c => chunks.push(c)); p.stderr.on("data", c => { err += c; });
    p.on("error", e => { if (done) return; done = true; clearTimeout(kill); bad(Object.assign(new Error(e.code === "ENOENT" ? "ffmpeg is not installed" : e.message), { code: e.code === "ENOENT" ? "no_ffmpeg" : "ffmpeg" })); });
    p.on("close", () => { if (done) return; done = true; clearTimeout(kill); const b = Buffer.concat(chunks); if (b.length < 8000 * 2 * 5) return bad(Object.assign(new Error("No audio could be read from this file" + (err ? " (" + err.trim().slice(0, 120) + ")" : "")), { code: "no_audio" })); ok(new Int16Array(b.buffer, b.byteOffset, Math.floor(b.length / 2))); });
  });
}
function durationOf(url, ffprobe, ms) {
  return new Promise(ok => {
    const p = spawn(ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", url], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "", done = false; const kill = setTimeout(() => { if (!done) { done = true; p.kill("SIGKILL"); ok(0); } }, ms);
    p.stdout.on("data", c => { out += c; }); p.on("error", () => { if (!done) { done = true; clearTimeout(kill); ok(0); } });
    p.on("close", () => { if (!done) { done = true; clearTimeout(kill); ok(parseFloat(out) || 0); } });
  });
}

/* frame-rate mismatches that cause clock drift: subtitle times are multiplied by these before lining up */
const SCALES = [1, 1.001, 0.999, 25 / 23.976, 23.976 / 25, 25 / 24, 24 / 25, 24 / 23.976 * 1.0, 23.976 / 24];

/* main entry. opts: {url, text, ffmpeg, ffprobe, maxShift (s), window (s), onProgress}
   Returns {offsetMs, scale, confidence, windows, note}: a subtitle time t (seconds) becomes  t * scale + offsetMs / 1000 */
async function sync(opts) {
  const ffmpeg = opts.ffmpeg || "ffmpeg", ffprobe = opts.ffprobe || "ffprobe", maxShift = opts.maxShift || 120, win = opts.window || 180, pad = Math.round(maxShift / FRAME);
  const cues = parseCues(opts.text);
  if (cues.length < 20) throw Object.assign(new Error("That subtitle has too few lines to line up."), { code: "few_cues" });
  const end = cues[cues.length - 1].e, dur = (await durationOf(opts.url, ffprobe, 30000)) || end * 1.05;
  const places = [0.12, 0.62, 0.38, 0.82, 0.25].map(f => Math.max(60, Math.min(dur - win - 30, f * dur)));
  const scaled = SCALES.map(sc => cues.map(c => ({ s: c.s * sc, e: c.e * sc })));
  const wins = [];
  for (const at of places) {
    if (wins.length >= 2 && wins.filter(w => w.best >= 5).length >= 2) break;
    if (wins.filter(w => Math.abs(w.t - (at + win / 2)) < 240).length) continue;
    const inWin = cues.filter(c => c.s * 1.1 >= at - maxShift && c.e * 0.9 <= at + win + maxShift).length;
    if (inWin < 25) continue;                                                    // not enough dialogue here to line up
    if (opts.onProgress) opts.onProgress(wins.length);
    const pcm = await pcmOf(opts.url, at, win, ffmpeg, opts.windowTimeout || 90000);
    const audio = speechMask(pcm, 8000), per = SCALES.map((sc, i) => { const r = correlate(audio, subMask(scaled[i], at, audio.length * FRAME, maxShift), pad); return { sc, b: r.k * FRAME, z: r.z }; });
    const best = Math.max.apply(null, per.map(x => x.z));
    if (best >= 4) wins.push({ t: at + win / 2, per, best });
  }
  if (!wins.length) throw Object.assign(new Error("Couldn't find a reliable match between the audio and this subtitle."), { code: "low_confidence" });
  wins.sort((a, b) => a.t - b.t);
  /* which scale explains the windows best? (several windows must agree on the same shift) */
  const cand = SCALES.map((sc, i) => {
    const items = wins.filter(w => w.per[i].z >= 4).map(w => ({ t: w.t, b: w.per[i].b, z: w.per[i].z }));
    if (!items.length) return null;
    const bs = items.map(x => x.b), spread = Math.max.apply(null, bs) - Math.min.apply(null, bs), zsum = items.reduce((s, x) => s + x.z, 0);
    return { sc, items, spread, consistent: items.length < 2 || spread <= 0.8, score: items.length < 2 || spread <= 0.8 ? zsum : zsum * 0.3 };
  });
  let pick = cand.filter(Boolean).sort((a, b) => b.score - a.score)[0];
  const plain = cand[0];
  if (plain && plain.score >= 0.85 * pick.score) pick = plain;                  // prefer "no drift" unless drift explains it clearly better
  let scale = pick.sc, offset, note = "shift";
  const zs = pick.items.reduce((s, x) => s + x.z, 0);
  if (pick.consistent) offset = pick.items.reduce((s, x) => s + x.b * x.z, 0) / zs;
  else {                                                                        // plain shift differs between windows: unusual drift, fit a line
    const f1 = pick.items[0], f2 = pick.items[pick.items.length - 1], slope = (f2.b - f1.b) / (f2.t - f1.t), a = 1 + slope;
    if (a > 0.93 && a < 1.08 && Math.abs(f2.b - f1.b) < 40) { scale = a; offset = f1.b - slope * f1.t; }
    else throw Object.assign(new Error("The timing changes during the film in a way that can't be fixed with a simple shift."), { code: "inconsistent" });
  }
  if (scale !== 1) note = "drift";
  const mid = dur / 2, atMid = Math.abs((scale - 1) * mid + offset);
  return { offsetMs: Math.round(offset * 1000), scale: Math.round(scale * 1e6) / 1e6, confidence: Math.round(Math.min.apply(null, pick.items.map(x => x.z)) * 10) / 10,
    windows: pick.items.map(x => ({ at: Math.round(x.t), offsetMs: Math.round(x.b * 1000), z: Math.round(x.z * 10) / 10 })), note: atMid < 0.2 && note === "shift" ? "in_sync" : note };
}
module.exports = { sync, parseCues, speechMask, subMask, correlate, FRAME };
