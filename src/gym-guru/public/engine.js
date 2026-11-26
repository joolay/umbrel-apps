/* Gym Guru rep engine: pure maths, no camera and no DOM, so it can be tested in Node (test-engine.js) and used by the page.
 * Input: BlazePose landmarks (33 points, x/y normalised 0..1 plus visibility) and the video size.
 * Output: a rep count per exercise, using angle signals with two thresholds (hysteresis) so wobble never counts twice. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.GymEngine = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  var LM = { nose: 0, lSh: 11, rSh: 12, lEl: 13, rEl: 14, lWr: 15, rWr: 16, lHip: 23, rHip: 24 };
  var SIDES = { L: { sh: 11, el: 13, wr: 15, hip: 23 }, R: { sh: 12, el: 14, wr: 16, hip: 24 } };
  var MIN_VIS = 0.5;

  // Angle at point b (degrees, 0..180) between a-b and c-b, measured in pixels so a wide video does not squash the angle.
  function angle(a, b, c, w, h) {
    var ax = (a.x - b.x) * w, ay = (a.y - b.y) * h, cx = (c.x - b.x) * w, cy = (c.y - b.y) * h;
    var m = Math.hypot(ax, ay) * Math.hypot(cx, cy);
    if (!m) return null;
    var cos = (ax * cx + ay * cy) / m;
    return Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI;
  }
  var seen = function (p) { return !!p && (p.visibility === undefined || p.visibility >= MIN_VIS); };

  /* ---------- built-in upper-body exercises ----------
   * signal(side, lm, w, h) -> number | null for one arm.
   * start / target: the two ends of one rep. A rep is counted when the signal goes start -> target -> start again.
   * "start" and "target" are zones: ge:true means "at least", ge:false means "at most".
   * mode: auto = works it out (reps by the two arms within 0.7 s of each other are ONE rep, otherwise each counts), both = both arms together (reps = the higher arm),
 * alt = arms take turns (reps add up), L / R = one arm only, best = one counter fed by the arm the camera sees best. */
  var elbow = function (s, lm, w, h) { var q = SIDES[s]; return seen(lm[q.sh]) && seen(lm[q.el]) && seen(lm[q.wr]) ? angle(lm[q.sh], lm[q.el], lm[q.wr], w, h) : null; };
  var raise = function (s, lm, w, h) { var q = SIDES[s]; return seen(lm[q.hip]) && seen(lm[q.sh]) && seen(lm[q.wr]) ? angle(lm[q.hip], lm[q.sh], lm[q.wr], w, h) : null; };
  var EXERCISES = {
    curl: {
      name: "Bicep curl", group: "Arms", mode: "auto", modes: ["auto", "both", "alt", "L", "R"], signal: elbow,
      start: { ge: true, at: 150 }, target: { ge: false, at: 55 }, unit: "°",
      tip: "Stand 2 to 3 m from the phone, facing it, with both arms in view. Let your arms hang fully straight at the bottom of each curl."
    },
    press: {
      name: "Shoulder press", group: "Shoulders", mode: "auto", modes: ["auto", "both", "alt", "L", "R"], signal: elbow,
      start: { ge: false, at: 100 }, target: { ge: true, at: 160 }, unit: "°",
      // hands must also finish above the shoulders, or a half press would count
      need: function (s, lm) { var q = SIDES[s]; return !!lm[q.wr] && !!lm[q.sh] && lm[q.wr].y < lm[q.sh].y; },
      tip: "Face the phone from 2 to 3 m away. Start with the weights at shoulder height and press until your arms are straight overhead."
    },
    lateral: {
      name: "Lateral raise", group: "Shoulders", mode: "auto", modes: ["auto", "both", "alt", "L", "R"], signal: raise,
      start: { ge: false, at: 30 }, target: { ge: true, at: 75 }, unit: "°",
      tip: "Face the phone from 2 to 3 m away so your hips, shoulders and both hands are in view. Raise to about shoulder height."
    },
    pushup: {
      name: "Push-up", group: "Chest", mode: "best", modes: ["best"], signal: elbow,
      start: { ge: true, at: 155 }, target: { ge: false, at: 95 }, unit: "°",
      tip: "Put the phone on the floor about 2 m away, side-on to you, so the arm nearest the phone is clear. Lock out at the top."
    },
    pullup: {
      name: "Pull-up", group: "Back", mode: "auto", modes: ["auto", "both", "alt"], signal: elbow,
      start: { ge: true, at: 150 }, target: { ge: false, at: 85 }, unit: "°",
      tip: "Face the phone from 2 to 3 m away with the whole bar and your arms in view. Hang with straight arms at the bottom."
    }
  };
  var SENS = { easy: 8, normal: 0, strict: -8 };   // degrees: easy asks for a little less range, strict a little more

  // The two zones, loosened or tightened by the sensitivity setting.
  function zones(ex, sens) {
    var d = SENS[sens] !== undefined ? SENS[sens] : 0;
    var shift = function (z, toward) { return { ge: z.ge, at: z.at + (z.ge ? -d : d) * toward }; };
    return { start: shift(ex.start, 1), target: shift(ex.target, 1) };
  }
  var inZone = function (v, z) { return z.ge ? v >= z.at : v <= z.at; };

  /* ---------- one counter ----------
   * feed(value, nowMs) with a signal value (or null when the body part is not seen). Returns true when a rep just finished.
   * Light smoothing (EMA) removes camera jitter; a minimum time between reps blocks double counts. */
  function createCounter(start, target, opt) {
    opt = opt || {};
    var alpha = opt.alpha || 0.45, minGap = opt.minGapMs || 350;
    var s = { reps: 0, phase: "", value: null, smooth: null, lastRep: -1e9, lastSeen: 0, progress: 0, depth: null };
    s.feed = function (v, now) {
      if (v == null || !isFinite(v)) { return false; }
      s.lastSeen = now;
      s.smooth = s.smooth == null ? v : s.smooth + alpha * (v - s.smooth);
      s.value = s.smooth;
      var x = s.smooth;
      // how far between the two ends, 0 at start, 1 at target (for the progress ring)
      var span = target.at - start.at;
      s.progress = span ? Math.max(0, Math.min(1, (x - start.at) / span)) : 0;
      if (s.phase === "target") s.depth = s.depth == null ? x : (target.ge ? Math.max(s.depth, x) : Math.min(s.depth, x));
      if (inZone(x, start)) {
        var done = s.phase === "target";
        s.phase = "start";
        s.depth = null;
        if (done && now - s.lastRep >= minGap) { s.reps++; s.lastRep = now; return true; }
      } else if (inZone(x, target) && s.phase === "start") {
        s.phase = "target";
        s.depth = x;
      }
      return false;
    };
    s.reset = function () { s.reps = 0; s.phase = ""; s.smooth = null; s.value = null; s.progress = 0; s.lastRep = -1e9; s.depth = null; };
    return s;
  }

  /* ---------- a whole exercise (built-in) ---------- */
  function createSession(exKey, opt) {
    opt = opt || {};
    var ex = EXERCISES[exKey];
    if (!ex) throw new Error("Unknown exercise " + exKey);
    var z = zones(ex, opt.sens), mode = opt.mode && ex.modes.indexOf(opt.mode) >= 0 ? opt.mode : ex.mode;
    var c = { L: createCounter(z.start, z.target, opt), R: createCounter(z.start, z.target, opt), B: createCounter(z.start, z.target, opt) };
    var api = { ex: ex, key: exKey, mode: mode, manual: 0, counters: c, tracked: [], status: "no-body", total: 0 }, last = null, MERGE_MS = 700;
    api.reps = function () {
      var n = mode === "best" ? c.B.reps : mode === "auto" ? api.total : mode === "alt" ? c.L.reps + c.R.reps : mode === "both" ? Math.max(c.L.reps, c.R.reps) : c[mode].reps;
      return Math.max(0, n + api.manual);
    };
    // lm: array of 33 landmarks. Returns { rep: bool } when a rep was just counted.
    api.update = function (lm, w, h, now) {
      var out = { rep: false }; api.tracked = [];
      if (!lm || !lm.length) { api.status = "no-body"; return out; }
      var val = { L: ex.signal("L", lm, w, h), R: ex.signal("R", lm, w, h) };
      // a press only counts as "target" when the hand is above the shoulder
      ["L", "R"].forEach(function (k) { if (val[k] != null && ex.need && inZone(val[k], z.target) && !ex.need(k, lm)) val[k] = z.target.ge ? z.target.at - 1 : z.target.at + 1; });
      if (val.L == null && val.R == null) { api.status = "arms-hidden"; return out; }
      api.status = "ok";
      if (mode === "best") {
        var vis = function (k) { var q = SIDES[k]; return Math.min(lm[q.sh].visibility == null ? 1 : lm[q.sh].visibility, lm[q.el].visibility == null ? 1 : lm[q.el].visibility, lm[q.wr].visibility == null ? 1 : lm[q.wr].visibility); };
        var pick = val.L == null ? "R" : val.R == null ? "L" : (vis("L") >= vis("R") ? "L" : "R");
        api.tracked = [pick]; api.value = val[pick];
        if (c.B.feed(val[pick], now)) out.rep = true;
      } else {
        var sides = mode === "L" ? ["L"] : mode === "R" ? ["R"] : ["L", "R"];
        sides.forEach(function (k) {
          if (val[k] == null) return; api.tracked.push(k);
          if (!c[k].feed(val[k], now)) return;
          if (mode !== "auto") { out.rep = true; return; }
          // the other arm finished a rep a moment ago: same rep, already counted
          if (last && last.side !== k && !last.merged && now - last.t <= MERGE_MS) { last.merged = true; return; }
          api.total++; last = { side: k, t: now, merged: false }; out.rep = true;
        });
        // when both arms finish a rep within the same moment in "both" mode they are one rep: the max handles that
        api.value = api.tracked.length ? val[api.tracked[0]] : null;
      }
      return out;
    };
    api.progress = function () { var k = api.tracked[0]; return k ? (mode === "best" ? c.B : c[k]).progress : 0; };
    api.reset = function () { c.L.reset(); c.R.reset(); c.B.reset(); api.manual = 0; api.total = 0; last = null; };
    return api;
  }

  /* ---------- "learn" mode: any machine or exercise ----------
   * The person does 2 to 3 slow reps. We record where the shoulders, elbows, wrists and nose go (in shoulder-widths, so distance to the phone does not matter),
   * pick the point and direction that moves most, and keep its two turning points. Counting later uses the same two-zone counter. */
  var POINTS = [["nose", 0], ["lSh", 11], ["rSh", 12], ["lEl", 13], ["rEl", 14], ["lWr", 15], ["rWr", 16]];
  function createLearner() {
    var samples = POINTS.map(function () { return { x: [], y: [] }; }), frames = 0;
    var api = {
      add: function (lm) {
        if (!lm || !seen(lm[11]) || !seen(lm[12])) return;
        var sw = Math.hypot(lm[11].x - lm[12].x, lm[11].y - lm[12].y) || 0;   // shoulder width in picture units
        if (sw < 0.03) return;
        var ox = (lm[11].x + lm[12].x) / 2, oy = (lm[11].y + lm[12].y) / 2;
        frames++;
        POINTS.forEach(function (p, i) {
          var q = lm[p[1]];
          if (seen(q)) { samples[i].x.push((q.x - ox) / sw); samples[i].y.push((q.y - oy) / sw); }
        });
        // the shoulders themselves are the origin so only moving parts show movement; the shoulders' own centre is kept for the vertical case below
      },
      frames: function () { return frames; },
      // Returns { point, axis, lo, hi, startHigh } or null when nothing moved enough.
      result: function () {
        var best = null;
        function pct(a, p) { var b = a.slice().sort(function (m, n) { return m - n; }); return b[Math.min(b.length - 1, Math.max(0, Math.round(p * (b.length - 1))))]; }
        POINTS.forEach(function (p, i) {
          ["x", "y"].forEach(function (axis) {
            var a = samples[i][axis]; if (a.length < Math.max(15, frames * 0.6)) return;
            var lo = pct(a, 0.05), hi = pct(a, 0.95), amp = hi - lo;
            if (amp > 0.35 && (!best || amp > best.amp)) best = { point: p[0], idx: p[1], axis: axis, lo: lo, hi: hi, amp: amp };
          });
        });
        if (!best) return null;
        // The person's own first position is the "start": the side the signal spent most time on.
        var a = samples[POINTS.findIndex(function (p) { return p[0] === best.point; })][best.axis], mid = (best.lo + best.hi) / 2, above = a.filter(function (v) { return v > mid; }).length;
        best.startHigh = above >= a.length / 2;
        return best;
      }
    };
    return api;
  }
  // Turn a learned result into a profile that can be saved on the account and counted with later.
  function profileFrom(r) {
    var span = r.hi - r.lo, near = 0.3 * span;
    return { v: 1, idx: r.idx, axis: r.axis, startHigh: !!r.startHigh, lo: +r.lo.toFixed(3), hi: +r.hi.toFixed(3), amp: +r.amp.toFixed(3), near: +near.toFixed(3) };
  }
  function createLearnedSession(profile, opt) {
    opt = opt || {};
    // Signal is already in shoulder-widths; zones are the outer 30% at each end of the learned range.
    var easy = opt.sens === "easy" ? 0.38 : opt.sens === "strict" ? 0.22 : 0.3, near = easy * (profile.hi - profile.lo);
    var start = profile.startHigh ? { ge: true, at: profile.hi - near } : { ge: false, at: profile.lo + near };
    var target = profile.startHigh ? { ge: false, at: profile.lo + near } : { ge: true, at: profile.hi - near };
    var c = createCounter(start, target, opt);
    var api = { learned: true, profile: profile, counter: c, manual: 0, status: "no-body", tracked: [], mode: "learned", ex: { name: profile.name || "Learned", unit: "" } };
    api.reps = function () { return Math.max(0, c.reps + api.manual); };
    api.update = function (lm) {
      var now = arguments[3], out = { rep: false };
      if (!lm || !lm.length || !seen(lm[11]) || !seen(lm[12]) || !seen(lm[profile.idx])) { api.status = lm && lm.length ? "arms-hidden" : "no-body"; return out; }
      var sw = Math.hypot(lm[11].x - lm[12].x, lm[11].y - lm[12].y);
      if (sw < 0.03) { api.status = "no-body"; return out; }
      var ox = (lm[11].x + lm[12].x) / 2, oy = (lm[11].y + lm[12].y) / 2, q = lm[profile.idx];
      var v = ((profile.axis === "x" ? q.x - ox : q.y - oy)) / sw;
      api.status = "ok"; api.value = v; api.tracked = [profile.idx];
      if (c.feed(v, now)) out.rep = true;
      return out;
    };
    api.progress = function () { return c.progress; };
    api.reset = function () { c.reset(); api.manual = 0; };
    return api;
  }

  return { LM: LM, SIDES: SIDES, EXERCISES: EXERCISES, angle: angle, zones: zones, createCounter: createCounter, createSession: createSession, createLearner: createLearner, profileFrom: profileFrom, createLearnedSession: createLearnedSession };
});
