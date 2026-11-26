// Rep engine tests: synthetic body landmarks go in, rep counts come out. Run: node test-engine.js
"use strict";
const E = require("./public/engine.js");
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log("FAIL", m); } else console.log("ok  ", m); };
const FPS = 30, DT = 1000 / FPS;
const blank = () => Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 0.99 }));

// An arm hanging from the shoulder: elbow angle theta (180 = straight down, 0 = hand at the shoulder), upper arm 0.2 long.
function armPose(side, theta, base) {
  const lm = base || blank(), q = E.SIDES[side], sx = side === "L" ? 0.4 : 0.6;
  lm[11] = { x: 0.4, y: 0.3, visibility: 0.99 }; lm[12] = { x: 0.6, y: 0.3, visibility: 0.99 };
  lm[23] = { x: 0.43, y: 0.7, visibility: 0.99 }; lm[24] = { x: 0.57, y: 0.7, visibility: 0.99 };
  const r = theta * Math.PI / 180;
  lm[q.sh] = { x: sx, y: 0.3, visibility: 0.99 }; lm[q.el] = { x: sx, y: 0.5, visibility: 0.99 };
  lm[q.wr] = { x: sx + 0.2 * Math.sin(r), y: 0.5 - 0.2 * Math.cos(r) * -1 * -1 + 0, visibility: 0.99 };
  // wrist = elbow + 0.2 * (sin t, -cos t) with t measured from the "up to shoulder" direction -> straight down at 180
  lm[q.wr] = { x: sx + 0.2 * Math.sin(r), y: 0.5 - 0.2 * Math.cos(r), visibility: 0.99 };
  return lm;
}
// A sine-like path between two angles, `reps` times, with jitter.
function path(hi, lo, reps, perRep = 60, jitter = 3, seed = 1) {
  let s = seed; const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
  const out = [hi, hi, hi];
  for (let r = 0; r < reps; r++) for (let i = 0; i < perRep; i++) out.push(hi - (hi - lo) * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / perRep)) + rnd() * jitter);
  out.push(hi, hi, hi, hi);
  return out;
}
const run = (sess, frames) => { let t = 0, n = 0; for (const f of frames) { const r = sess.update(f, 1, 1, (t += DT)); if (r.rep) n++; } return n; };

// angle maths
{
  const a = armPose("L", 90), q = E.SIDES.L;
  ok(Math.abs(E.angle(a[q.sh], a[q.el], a[q.wr], 1, 1) - 90) < 0.01, "angle() reads a 90 degree elbow");
  const b = armPose("L", 175);
  ok(Math.abs(E.angle(b[q.sh], b[q.el], b[q.wr], 1, 1) - 175) < 0.01, "angle() reads a 175 degree elbow");
  ok(Math.abs(E.angle({ x: 0.5, y: 0.4 }, { x: 0.5, y: 0.5 }, { x: 0.7, y: 0.5 }, 2, 1) - 90) < 0.01, "angle() measures in pixels, so a wide picture keeps right angles right");
}

// curls, both arms together: 5 reps -> 5 (not 10)
{
  const s = E.createSession("curl", { mode: "both" });
  run(s, path(172, 35, 5).map(t => armPose("R", t, armPose("L", t))));
  ok(s.reps() === 5, "curl both arms together: 5 reps counted as 5 (got " + s.reps() + ")");
}
// automatic mode (the default): together counts once, taking turns counts each
{
  const t = E.createSession("curl"); run(t, path(172, 35, 5).map(x => armPose("R", x, armPose("L", x))));
  ok(t.mode === "auto" && t.reps() === 5, "automatic: both arms together, 5 reps = 5 (got " + t.reps() + ")");
  const a = E.createSession("curl"), L = path(172, 35, 3), frames = [];
  for (const x of L) frames.push(armPose("R", 172, armPose("L", x)));
  for (const x of L) frames.push(armPose("R", x, armPose("L", 172)));
  run(a, frames); ok(a.reps() === 6, "automatic: taking turns, 3 + 3 = 6 (got " + a.reps() + ")");
  const o = E.createSession("curl"), f2 = []; for (const x of path(172, 35, 4)) f2.push(armPose("R", 172, armPose("L", x)));
  run(o, f2); ok(o.reps() === 4, "automatic: one arm only, 4 reps = 4 (got " + o.reps() + ")");
  const z = E.createSession("curl"); run(z, path(172, 35, 3).map(x => armPose("R", x, armPose("L", x)))); z.reset(); ok(z.reps() === 0, "reset clears the automatic count");
}
// curls alternating: left 3, right 3 -> 6
{
  const s = E.createSession("curl", { mode: "alt" });
  const L = path(172, 35, 3), frames = [];
  for (const t of L) frames.push(armPose("R", 172, armPose("L", t)));
  for (const t of L) frames.push(armPose("R", t, armPose("L", 172)));
  run(s, frames);
  ok(s.reps() === 6, "curl alternating: 3 + 3 = 6 (got " + s.reps() + ")");
}
// half reps and a shaky top do not count
{
  const s = E.createSession("curl", { mode: "both" });
  run(s, path(172, 95, 4).map(t => armPose("R", t, armPose("L", t))));
  ok(s.reps() === 0, "half curls (stop at 95 degrees) are not counted (got " + s.reps() + ")");
  const j = E.createSession("curl", { mode: "both" });
  const frames = path(172, 35, 1, 90, 0).map(t => armPose("R", t, armPose("L", t)));
  // wobble hard around the middle of the way up: must still be 1 rep
  const wob = frames.map((f, i) => i > 30 && i < 50 ? armPose("R", 100 + (i % 2 ? 12 : -12), armPose("L", 100 + (i % 2 ? 12 : -12))) : f);
  run(j, wob);
  ok(j.reps() <= 1, "wobble mid-rep does not double count (got " + j.reps() + ")");
}
// fast reps closer than 350 ms are blocked
{
  const s = E.createSession("curl", { mode: "both" });
  run(s, path(172, 35, 4, 8, 0).map(t => armPose("R", t, armPose("L", t))));
  ok(s.reps() <= 2, "very fast flicks are not all counted (got " + s.reps() + ")");
}
// manual +1 / -1
{
  const s = E.createSession("curl"); s.manual = 2; ok(s.reps() === 2, "manual +2 shows 2");
  s.manual = -3; ok(s.reps() === 0, "reps never go below 0");
}
// lateral raise
{
  const s = E.createSession("lateral", { mode: "both" });
  const lm = (a) => { const l = blank(); l[11] = { x: 0.4, y: 0.3, visibility: 1 }; l[12] = { x: 0.6, y: 0.3, visibility: 1 }; l[23] = { x: 0.43, y: 0.7, visibility: 1 }; l[24] = { x: 0.57, y: 0.7, visibility: 1 };
    const r = a * Math.PI / 180; // abduction from the torso line, to the outside
    l[15] = { x: 0.4 - 0.3 * Math.sin(r), y: 0.3 + 0.3 * Math.cos(r), visibility: 1 }; l[16] = { x: 0.6 + 0.3 * Math.sin(r), y: 0.3 + 0.3 * Math.cos(r), visibility: 1 };
    l[13] = l[15]; l[14] = l[16]; return l; };
  run(s, path(8, 90, 4).map(lm));
  ok(s.reps() === 4, "lateral raise: 4 reps (got " + s.reps() + ")");
}
// shoulder press: needs the hands above the shoulders
{
  const press = (top) => { const l = blank(); l[11] = { x: 0.4, y: 0.5, visibility: 1 }; l[12] = { x: 0.6, y: 0.5, visibility: 1 };
    // top: arms straight up. bottom: elbows out and hands at shoulder height
    if (top) { l[13] = { x: 0.4, y: 0.3, visibility: 1 }; l[15] = { x: 0.4, y: 0.1, visibility: 1 }; l[14] = { x: 0.6, y: 0.3, visibility: 1 }; l[16] = { x: 0.6, y: 0.1, visibility: 1 }; }
    else { l[13] = { x: 0.3, y: 0.55, visibility: 1 }; l[15] = { x: 0.3, y: 0.4, visibility: 1 }; l[14] = { x: 0.7, y: 0.55, visibility: 1 }; l[16] = { x: 0.7, y: 0.4, visibility: 1 }; }
    return l; };
  const hang = () => { const l = blank(); l[11] = { x: 0.4, y: 0.3, visibility: 1 }; l[12] = { x: 0.6, y: 0.3, visibility: 1 }; l[13] = { x: 0.4, y: 0.5, visibility: 1 }; l[15] = { x: 0.4, y: 0.7, visibility: 1 }; l[14] = { x: 0.6, y: 0.5, visibility: 1 }; l[16] = { x: 0.6, y: 0.7, visibility: 1 }; return l; };
  const s = E.createSession("press");
  const seq = []; for (let r = 0; r < 3; r++) { for (let i = 0; i < 15; i++) seq.push(press(false)); for (let i = 0; i < 15; i++) seq.push(press(true)); }
  seq.push(press(false), press(false), press(false));
  run(s, seq);
  ok(s.reps() === 3, "shoulder press: 3 reps (got " + s.reps() + ")");
  const t = E.createSession("press"), seq2 = []; for (let r = 0; r < 3; r++) { for (let i = 0; i < 15; i++) seq2.push(press(false)); for (let i = 0; i < 15; i++) seq2.push(hang()); }
  run(t, seq2);
  ok(t.reps() === 0, "straight arms hanging down are not a press (got " + t.reps() + ")");
}
// push-up: the arm the camera sees best is used
{
  const s = E.createSession("pushup");
  const frames = path(172, 70, 5).map(t => { const l = armPose("L", t); l[12].visibility = 0.1; l[14].visibility = 0.1; l[16].visibility = 0.1; return l; });
  run(s, frames);
  ok(s.reps() === 5 && s.tracked[0] === "L", "push-up: 5 reps from the visible side (got " + s.reps() + ", " + s.tracked + ")");
}
// hidden arms
{
  const s = E.createSession("curl"), l = armPose("R", 100, armPose("L", 100));
  [13, 14, 15, 16].forEach(i => { l[i].visibility = 0.1; });
  s.update(l, 1, 1, 0); ok(s.status === "arms-hidden", "hidden arms are reported, not counted");
  s.update(null, 1, 1, 33); ok(s.status === "no-body", "no body reported");
}
// sensitivity: easy accepts a smaller range than strict
{
  const mk = sens => { const s = E.createSession("curl", { mode: "both", sens }); run(s, path(172, 60, 3).map(t => armPose("R", t, armPose("L", t)))); return s.reps(); };
  ok(mk("easy") === 3 && mk("strict") === 0, "easy counts a 60 degree curl, strict does not (" + mk("easy") + "/" + mk("strict") + ")");
}
// learn mode: a cable pushdown, wrists move 1.2 shoulder-widths down and up
{
  const mk = (y) => { const l = blank(); l[11] = { x: 0.4, y: 0.3, visibility: 1 }; l[12] = { x: 0.6, y: 0.3, visibility: 1 }; l[0] = { x: 0.5, y: 0.15, visibility: 1 };
    l[13] = { x: 0.38, y: 0.45, visibility: 1 }; l[14] = { x: 0.62, y: 0.45, visibility: 1 }; l[15] = { x: 0.38, y: y, visibility: 1 }; l[16] = { x: 0.62, y: y, visibility: 1 }; return l; };
  const wave = (reps) => { const o = []; for (let r = 0; r < reps; r++) for (let i = 0; i < 60; i++) o.push(mk(0.5 + 0.12 - 0.12 * Math.cos(2 * Math.PI * i / 60) * -1 * -1)); return o; };
  const L = E.createLearner(); wave(3).forEach(f => L.add(f));
  const res = L.result();
  ok(res && /Wr/.test(res.point) && res.axis === "y", "learn mode picks the wrist moving up and down (" + (res && res.point + " " + res.axis) + ")");
  const prof = E.profileFrom(res), s = E.createLearnedSession(prof);
  const frames = [mk(0.5), mk(0.5), mk(0.5)]; wave(5).forEach(f => frames.push(f)); frames.push(mk(0.5), mk(0.5), mk(0.5));
  run(s, frames);
  ok(s.reps() === 5, "learned session counts 5 reps (got " + s.reps() + ")");
  const flat = E.createLearner(); for (let i = 0; i < 90; i++) flat.add(mk(0.5));
  ok(flat.result() === null, "learn mode refuses when nothing moves");
  const json = JSON.stringify(prof); ok(JSON.parse(json).axis === "y", "profile survives saving as JSON");
}
console.log(fails ? "\n" + fails + " FAILED" : "\nAll engine tests passed"); process.exit(fails ? 1 : 0);
