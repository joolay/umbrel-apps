// Tests the subtitle auto-sync on synthetic audio where the right answer is known (needs ffmpeg + ffprobe on this machine).
"use strict";
const http = require("http"), fs = require("fs"), os = require("os"), path = require("path"), cp = require("child_process");
if (cp.spawnSync("ffmpeg", ["-version"]).error) { console.log("SKIPPED: ffmpeg not installed here"); process.exit(0); }
const sub = require("./subsync.js");
let seed = 12345; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;

/* 12 minutes of fake "film": speech-like bursts at known times (these are the true subtitle cues), plus loud non-speech events and a low background hum */
const RATE = 16000, DUR = 720, cues = [];
for (let t = 20; t < DUR - 20;) { const len = 1 + rnd() * 3.5; cues.push({ s: t, e: t + len }); t += len + 0.4 + rnd() * 5; }
const pcm = Buffer.alloc(RATE * DUR * 2); let lp = 0;
const loud = []; for (let t = 30; t < DUR; t += 37 + rnd() * 20) loud.push([t, t + 1.5 + rnd() * 2]);
for (let i = 0; i < RATE * DUR; i++) {
  const t = i / RATE; let v = (rnd() - 0.5) * 500 + Math.sin(2 * Math.PI * 60 * t) * 150;
  lp = lp * 0.6 + (rnd() - 0.5) * 0.4;
  for (const c of cues) { if (t >= c.s && t < c.e) { const env = Math.pow(Math.abs(Math.sin(Math.PI * 4 * (t - c.s))), 0.7) * Math.min(1, (t - c.s) * 8, (c.e - t) * 8); v += lp * 22000 * env; break; } }
  for (const l of loud) if (t >= l[0] && t < l[1]) { v += (rnd() - 0.5) * 14000; break; }
  pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v))), i * 2);
}
const hdr = Buffer.alloc(44); hdr.write("RIFF", 0); hdr.writeUInt32LE(36 + pcm.length, 4); hdr.write("WAVEfmt ", 8); hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(1, 22);
hdr.writeUInt32LE(RATE, 24); hdr.writeUInt32LE(RATE * 2, 28); hdr.writeUInt16LE(2, 32); hdr.writeUInt16LE(16, 34); hdr.write("data", 36); hdr.writeUInt32LE(pcm.length, 40);
const wav = Buffer.concat([hdr, pcm]);
const server = http.createServer((q, r) => { const rg = /bytes=(\d+)-(\d*)/.exec(q.headers.range || ""); if (rg) { const s = +rg[1], e = rg[2] ? +rg[2] : wav.length - 1; r.writeHead(206, { "content-type": "audio/wav", "content-range": `bytes ${s}-${e}/${wav.length}`, "content-length": e - s + 1, "accept-ranges": "bytes" }); return r.end(wav.slice(s, e + 1)); } r.writeHead(200, { "content-type": "audio/wav", "content-length": wav.length, "accept-ranges": "bytes" }); r.end(wav); }).listen(0);
const toSrt = list => list.map((c, i) => { const f = x => { const ms = Math.max(0, Math.round(x * 1000)), h = Math.floor(ms / 3600000), m = Math.floor(ms % 3600000 / 60000), s = Math.floor(ms % 60000 / 1000); return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0") + "," + String(ms % 1000).padStart(3, "0"); }; return (i + 1) + "\n" + f(c.s) + " --> " + f(c.e) + "\nline " + i + "\n"; }).join("\n");
// real subtitles start slightly before the speech and end a little after it, and are never perfect
const subtitleOf = (map) => toSrt(cues.map(c => ({ s: map(c.s - 0.15 + (rnd() - 0.5) * 0.2), e: map(c.e + 0.25 + (rnd() - 0.5) * 0.2) })));
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log("FAIL", m); } else console.log("ok  ", m); };
(async () => {
  const url = "http://127.0.0.1:" + server.address().port + "/film.wav";
  console.log("synthetic film:", cues.length, "subtitle lines,", DUR / 60, "minutes");
  let r = await sub.sync({ url, text: subtitleOf(t => t + 3.7) });
  ok(Math.abs(r.offsetMs + 3700) < 250 && r.scale === 1, "subtitles 3.7 s late -> correction " + r.offsetMs + " ms (want about -3700), confidence " + r.confidence);
  r = await sub.sync({ url, text: subtitleOf(t => t - 12.4) });
  ok(Math.abs(r.offsetMs - 12400) < 250, "subtitles 12.4 s early -> correction " + r.offsetMs + " ms (want about +12400)");
  r = await sub.sync({ url, text: subtitleOf(t => t) });
  ok(Math.abs(r.offsetMs) < 250 && r.note === "in_sync", "already in sync is recognised (" + r.offsetMs + " ms, " + r.note + ")");
  r = await sub.sync({ url, text: subtitleOf(t => t * 1.0427 + 1.5) });
  const err = [60, 300, 600, 700].map(tt => { const tSub = tt * 1.0427 + 1.5; return Math.abs(r.scale * tSub + r.offsetMs / 1000 - tt); });
  ok(r.note === "drift" && Math.abs(r.scale - 1 / 1.0427) < 0.004 && Math.max.apply(null, err) < 0.8, "25 vs 23.976 fps drift found: scale " + r.scale + " (want " + (1 / 1.0427).toFixed(4) + "), worst error " + Math.max.apply(null, err).toFixed(2) + " s");
  let threw = null; try { await sub.sync({ url, text: toSrt(Array.from({ length: 300 }, (_, i) => { const s = 20 + rnd() * 680; return { s, e: s + 1 + rnd() * 2 }; }).sort((a, b) => a.s - b.s)) }); } catch (e) { threw = e.code; }
  ok(threw === "low_confidence", "unrelated subtitles are refused instead of guessed (" + threw + ")");
  threw = null; try { await sub.sync({ url, text: "1\n00:00:01,000 --> 00:00:02,000\nhi\n" }); } catch (e) { threw = e.code; } ok(threw === "few_cues", "a subtitle with too few lines is refused");
  threw = null; try { await sub.sync({ url, text: subtitleOf(t => t), ffmpeg: "/nonexistent/ffmpeg" }); } catch (e) { threw = e.code; } ok(threw === "no_ffmpeg", "missing ffmpeg gives a clear error");
  ok(sub.parseCues("1\n00:01:02,500 --> 00:01:04,000\nx\n\n2\n01:00:00.250 --> 01:00:02.000\ny").length === 2 && sub.parseCues("WEBVTT\n\n00:05.000 --> 00:07.500\nz").length === 1, "parses SRT and WebVTT timestamps");
})().catch(e => { fails++; console.log("ERROR", e.stack); }).then(() => { server.close(); console.log(fails ? fails + " FAILED" : "ALL PASSED"); process.exit(fails ? 1 : 0); });
