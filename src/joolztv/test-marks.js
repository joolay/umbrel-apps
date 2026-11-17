// The file's own chapters as skip points (marks.js): chapter names, and a real file with chapters made with ffmpeg.
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

/* ---- a real file with chapters ---- */
const hasX264 = cp.spawnSync("ffmpeg", ["-hide_banner", "-encoders"]).stdout.toString().indexOf("libx264") > 0;
if (!hasX264) { console.log("skip  synthetic film (no libx264 here)"); }
else (async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "marks-")), f = path.join(dir, "film.mp4");
  const sz = "s=320x180:r=10";
  const g = cp.spawnSync("ffmpeg", ["-v", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=" + sz + ":d=40", "-f", "lavfi", "-i", "color=c=black:" + sz + ":d=70,geq=lum='if(lt(mod(floor(X/8)*7+floor((Y+T*40)/10)*13,23),2),230,10)':cb=128:cr=128",
    "-f", "lavfi", "-i", "testsrc=" + sz + ":d=25,hue=h=120", "-filter_complex", "[0][1][2]concat=n=3:v=1[v]", "-map", "[v]", "-c:v", "libx264", "-g", "10", "-pix_fmt", "yuv420p", f]);
  if (g.status !== 0) { ok(false, "could not make the synthetic film: " + g.stderr.toString().slice(-300)); return fin(); }
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
