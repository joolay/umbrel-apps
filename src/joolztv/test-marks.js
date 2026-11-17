// Intro / credits / credit-scene detection (marks.js): chapter names, the classifier, and a synthetic film made with ffmpeg.
"use strict";
const fs = require("fs"), os = require("os"), path = require("path"), cp = require("child_process");
const M = require("./marks.js");
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log("FAIL", m); } else console.log("ok  ", m); };

/* ---- chapter names ---- */
const ch = (t, s, e) => ({ title: t, start: s, end: e });
let r = M.fromChapters([ch("Intro", 20, 75), ch("Chapter 2", 75, 1500), ch("Credits", 2600, 2900)], 2900);
ok(r.intro && r.intro.start === 20 && r.intro.end === 75 && r.credits && r.credits.start === 2600 && !r.scenes.length, "Intro and Credits chapters are found");
r = M.fromChapters([ch("Opening", 0, 90), ch("Part A", 90, 700), ch("Ending", 1300, 1390)], 1400);
ok(r.intro && r.intro.end === 90 && r.credits && r.credits.start === 1300, "Opening / Ending (anime style) are found");
r = M.fromChapters([ch("Chapter 1", 0, 600), ch("End Credits", 6000, 6600), ch("Post-credits scene", 6600, 6680)], 6680);
ok(r.credits.start === 6000 && r.scenes.join() === "6600", "a chapter named post-credits scene is a scene");
r = M.fromChapters([ch("Chapter 1", 0, 600), ch("Credits", 6000, 6600), ch("Chapter 40", 6600, 6680)], 6680);
ok(r.scenes.join() === "6600", "a real-length chapter after the credits chapter is a scene");
r = M.fromChapters([ch("Chapter 1", 0, 600), ch("Chapter 2", 600, 1200)], 1200);
ok(!r.intro && !r.credits && !r.scenes.length, "plain chapters say nothing");
r = M.fromChapters([ch("Theme", 0, 400), ch("Introduction to the plan", 400, 900)], 1200);
ok(!r.intro, "a chapter that merely starts with the word is not an intro (too long / not a title)");
ok(!M.fromChapters([ch("Credits", 100, 150)], 4000).credits, "a 'credits' chapter near the start is not the end credits");

/* ---- classifying a frame ---- */
const flat = (v, n = 576) => Buffer.alloc(n * 3, v);
const noisy = () => { const b = Buffer.alloc(576 * 3); for (let i = 0; i < b.length; i++) b[i] = (i * 53) % 256; return b; };
ok(M.creditsLike(M.features(flat(0))) && M.creditsLike(M.features(flat(10))), "black is credits-like");
ok(!M.creditsLike(M.features(noisy())), "a detailed, bright picture is not");
ok(!M.creditsLike(M.features(flat(128))) || M.features(flat(128)).mean > 100, "a flat mid-grey picture is not black");
const sparse = Buffer.alloc(576 * 3, 6); for (let i = 0; i < 40; i++) { sparse[i * 40] = sparse[i * 40 + 1] = sparse[i * 40 + 2] = 255; }
ok(M.creditsLike(M.features(sparse)), "sparse white text on black is credits-like");

/* ---- finding credits and scenes in a series of labels ---- */
const mk = (s) => s.split("").map((c, i) => ({ t: 600 + i * 6, c: c === "c" })), A = (s, o) => M.analyse(mk(s), Object.assign({ step: 6 }, o || {}));
let a = A("pppppppp" + "c".repeat(20));
ok(a.creditsStart === 648 && !a.scenes.length, "picture, then credits to the end: credits start found, no scene (" + a.creditsStart + ")");
a = A("pppppppp" + "c".repeat(20) + "ppppp");
ok(a.creditsStart === 648 && a.scenes.length === 1 && a.scenes[0] === 648 + 120, "credits, then a scene at the end of the file");
a = A("pppp" + "c".repeat(10) + "ppp" + "c".repeat(12));
ok(a.creditsStart === 624 && a.scenes.length === 1 && a.scenes[0] === 624 + 60, "a scene in the middle of the credits (mid-credits scene)");
a = A("pppp" + "c".repeat(10) + "ppp" + "c".repeat(12) + "pppp");
ok(a.scenes.length === 2, "mid-credits and end-credits scenes are both found");
a = A("ppppcccccppppppppppp");
ok(a.creditsStart === null, "five dark samples are a dark scene, not credits (needs about 48 s)");
a = A("pppp" + "c".repeat(20) + "pp", { duration: 600 + 26 * 6 });
ok(!a.scenes.length, "a flash of picture at the very end is a studio logo, not a scene");

/* ---- a synthetic film: 40 s picture, 70 s rolling credits, a 25 s scene ---- */
const hasX264 = cp.spawnSync("ffmpeg", ["-hide_banner", "-encoders"]).stdout.toString().indexOf("libx264") > 0;
if (!hasX264) { console.log("skip  synthetic film (no libx264 here)"); }
else (async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "marks-")), f = path.join(dir, "film.mp4");
  const sz = "s=320x180:r=10";
  const g = cp.spawnSync("ffmpeg", ["-v", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=" + sz + ":d=40", "-f", "lavfi", "-i", "color=c=black:" + sz + ":d=70,geq=lum='if(lt(mod(floor(X/8)*7+floor((Y+T*40)/10)*13,23),2),230,10)':cb=128:cr=128",
    "-f", "lavfi", "-i", "testsrc=" + sz + ":d=25,hue=h=120", "-filter_complex", "[0][1][2]concat=n=3:v=1[v]", "-map", "[v]", "-c:v", "libx264", "-g", "10", "-pix_fmt", "yuv420p", f]);
  if (g.status !== 0) { ok(false, "could not make the synthetic film: " + g.stderr.toString().slice(-300)); return fin(); }
  const t0 = Date.now();
  const res = await M.tail(f, { from: 20, duration: 135, step: 6 });
  ok(res.creditsStart !== null && Math.abs(res.creditsStart - 40) <= 4, "synthetic film: credits start found near 40 s (" + res.creditsStart + ")");
  ok(res.scenes.length === 1 && Math.abs(res.scenes[0] - 110) <= 4, "synthetic film: the scene after the credits is found near 110 s (" + res.scenes.join() + ")");
  console.log("      (took " + ((Date.now() - t0) / 1000).toFixed(1) + " s)");
  const none = await M.tail(f, { from: 0, duration: 40, step: 6 }); ok(none.creditsStart === null, "synthetic film: no credits inside the picture-only first 40 s");
  const c = await M.chapters(f, {}); ok(Math.abs(c.duration - 135) < 1 && c.hasChapters === false && !c.intro, "ffprobe: duration read, no chapters in that file");
  // a file with chapters
  const meta = path.join(dir, "meta.txt"), mkv = path.join(dir, "ch.mkv");
  fs.writeFileSync(meta, ";FFMETADATA1\n" + [["Intro", 5, 35], ["Chapter 2", 35, 100], ["Credits", 100, 120], ["Post-credits scene", 120, 135]].map(x => "[CHAPTER]\nTIMEBASE=1/1000\nSTART=" + x[1] * 1000 + "\nEND=" + x[2] * 1000 + "\ntitle=" + x[0] + "\n").join(""));
  const g2 = cp.spawnSync("ffmpeg", ["-v", "error", "-y", "-i", f, "-i", meta, "-map_metadata", "1", "-c", "copy", mkv]);
  if (g2.status === 0) { const c2 = await M.chapters(mkv, {}); ok(c2.hasChapters && c2.intro && c2.intro.start === 5 && c2.intro.end === 35 && c2.credits.start === 100 && c2.scenes.join() === "120", "ffprobe: chapters of a real file give intro, credits and scene"); }
  else ok(false, "could not make the chapter file: " + g2.stderr.toString().slice(-200));
  try { await M.chapters(path.join(dir, "nope.mp4"), {}); ok(false, "unreadable file should fail"); } catch (e) { ok(e.code === "unreadable", "an unreadable file gives a clear error"); }
  try { await M.chapters(f, { ffprobe: "/nonexistent/ffprobe" }); ok(false, "missing ffprobe"); } catch (e) { ok(e.code === "no_ffmpeg", "missing ffprobe gives a clear error"); }
  fs.rmSync(dir, { recursive: true, force: true });
  fin();
})().catch(e => { fails++; console.log("ERROR", e.stack); fin(); });
function fin() { console.log(fails ? fails + " FAILED" : "ALL PASSED"); process.exit(fails ? 1 : 0); }
if (!hasX264) fin();
