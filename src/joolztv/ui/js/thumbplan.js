/* Which seek-preview picture to make next. Pure logic (no browser objects) so it can be tested. ES5. */
var Thumbplan = (function () {
  var STEP = 10;
  /* May pictures for the part of the file that is NOT downloaded yet be made? Only when playback is well ahead of itself:
     playing for 45 s, download at least 3x faster than the film plays (and not flagged slow), and a considerable buffer:
     60 s ahead, or as full as this player lets it get (30 s or more and not growing for 15 s). */
  function farOk(o) {
    if (!o.ratio || o.slow || o.ratio < 3) return false;
    if (o.playedMs < 45000) return false;
    var full = o.ahead >= 60 || (o.ahead >= 30 && o.ahead >= o.aheadMax - 2 && o.sinceGrewMs > 15000);
    return !!full;
  }
  /* o: dur, t (playhead), seen [[start,end]...] (parts the player has loaded), have/bad/fly (sets of grid seconds), + the farOk inputs.
     Returns {pick, loaded} or null. Loaded parts first, nearest the playhead (ahead counts less than behind); then, if allowed, the rest. */
  function next(o) {
    var bestL = -1, dL = 1e9, bestF = -1, dF = 1e9, far = farOk(o) || !!o.forceFar;
    for (var g = 0; g <= o.dur - 3; g += STEP) {
      if (o.have[g] || o.bad[g] || o.fly[g]) continue;
      var d = g >= o.t ? g - o.t : (o.t - g) * 1.3, loaded = false;
      for (var i = 0; i < o.seen.length; i++) if (g >= o.seen[i][0] + 1 && g <= o.seen[i][1] - 2) { loaded = true; break; }
      if (loaded) { if (d < dL) { dL = d; bestL = g; } } else if (d < dF) { dF = d; bestF = g; }
    }
    if (bestL >= 0) return { pick: bestL, loaded: true };
    if (far && bestF >= 0) return { pick: bestF, loaded: false };
    return null;
  }
  return { STEP: STEP, farOk: farOk, next: next };
})();
if (typeof module !== 'undefined') module.exports = Thumbplan;
