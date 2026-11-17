/* Smart buffering: how much video to have ready before starting (and before resuming after a stall), from how fast the torrent is downloading
   compared with how fast the video plays (its bitrate). Pure functions, so they can be tested without a player. */
var Buf = (function () {
  function fmtSpeed(bps) { if (!(bps > 0)) return ''; return bps >= 1e6 ? (bps / 1e6).toFixed(1) + ' MB/s' : Math.round(bps / 1e3) + ' KB/s'; }
  var CAP = 90;                                           // never ask a TV to hold more than this many seconds
  /* in:  {bitrate: bytes/s of the file, speed: torrent download bytes/s, fill: seconds of video buffered per second (measured), duration, mode, hls}
     out: {ratio, startSecs, resumeSecs, lowSecs, maxWait, slow, note}
     ratio = how many times faster than real time the data arrives (2 = twice as fast as the video plays) */
  function plan(i) {
    var mode = i.mode || 'auto', ratio = null;
    if (i.speed > 0 && i.bitrate > 0) ratio = i.speed / i.bitrate;
    else if (i.fill != null && i.fill >= 0) ratio = i.fill;
    var start, resume, low, slow = false, note = '';
    if (ratio === null) { start = 10; resume = 20; low = 3; note = 'measuring the download speed'; }
    else if (ratio >= 4) { start = 5; resume = 8; low = 2; }
    else if (ratio >= 2) { start = 10; resume = 15; low = 3; }
    else if (ratio >= 1.2) { start = 20; resume = 30; low = 4; }
    else if (ratio >= 0.9) { start = 35; resume = 45; low = 5; }
    else {                                                   // slower than real time: it cannot be smooth all the way, so buffer what is needed to get through the film
      // seconds that must be in hand so that the rest of the download can finish before the playhead catches up: duration x (1 - ratio), with a margin
      var need = i.duration > 0 ? i.duration * (1 - ratio) * 1.1 + 10 : 60;
      start = Math.max(25, Math.min(60, Math.round(need))); resume = Math.max(30, start); low = 6; slow = true; note = 'the download is slower than the video plays';
    }
    var k = mode === 'quick' ? 0.5 : mode === 'safe' ? 1.7 : 1;
    start = Math.round(Math.min(CAP, start * k)); resume = Math.round(Math.min(CAP, resume * k)); low = Math.round(Math.max(2, low * (mode === 'safe' ? 1.5 : 1)));
    // how long it is reasonable to wait for the start buffer to fill; slower downloads get longer, but never forever
    var r = ratio === null ? 1 : Math.max(0.3, ratio), maxWait = Math.round(Math.max(12, Math.min(slow ? 90 : 45, start / r * 1.3 + 6)));
    return { ratio: ratio, startSecs: start, resumeSecs: resume, lowSecs: low, maxWait: maxWait, slow: slow, note: note };
  }
  return { plan: plan, fmtSpeed: fmtSpeed };
})();
if (typeof module !== 'undefined') module.exports = Buf;
