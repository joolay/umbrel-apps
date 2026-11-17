/* First-run device check: plays a few tiny test clips (H.264, HEVC, 10-bit, AV1, MKV, TS, Dolby Digital, DTS ...) to learn what this device can decode.
   The results go into the device memory, so the first real film already starts the right way (direct or transcoded). */
var DeviceTest = (function () {
  function info() { return Store.get('devtest', null); }
  function done() { var d = info(); return !!d && d.ua === navigator.userAgent; }          // a new browser / firmware means test again
  function reset() { Store.del('devtest'); }
  function skip() { Store.set('devtest', { ts: Date.now(), ua: navigator.userAgent, skipped: true, results: [] }); }
  function manifest() {
    return fetch('/devtest/index.json?t=' + Date.now()).then(function (r) { if (!r.ok) throw new Error('no clips'); return r.json(); })
      .then(function (j) { if (!j || !j.clips || !j.clips.length) throw new Error('no clips'); return j.clips; });
  }
  /* play one clip muted off-screen. Resolves {ok: true|false|null, how}. null = this browser cannot tell (so nothing is learned). */
  function testClip(clip, ms) {
    return new Promise(function (resolve) {
      var v = document.createElement('video'), finished = false, poll = null;
      v.muted = true; v.preload = 'auto'; v.setAttribute('playsinline', ''); v.style.cssText = 'position:fixed;left:-9999px;top:0;width:256px;height:144px';
      document.body.appendChild(v);
      var timer = setTimeout(function () { end(false, 'timeout'); }, ms || 8000);
      function end(ok, how) {
        if (finished) return; finished = true; clearTimeout(timer); clearInterval(poll);
        try { v.pause(); v.removeAttribute('src'); v.load(); document.body.removeChild(v); } catch (e) {}
        resolve({ ok: ok, how: how });
      }
      v.addEventListener('error', function () { end(false, 'error'); });
      poll = setInterval(function () {
        if (v.currentTime < 0.3) return;                                            // not playing yet
        var frames = v.webkitDecodedFrameCount, audio = v.webkitAudioDecodedByteCount;
        if (clip.kind === 'video') { if (!(v.videoWidth > 0)) return end(false, 'no picture'); if (frames !== undefined && frames < 1) return end(false, 'no frames'); return end(true, 'played'); }
        if (audio === undefined) return end(null, 'cannot verify audio');           // audio decoding can only be proven where the browser reports it
        if (audio > 0) return end(true, 'audio decoded');
        if (v.currentTime > 1.2) end(false, 'audio not decoded');
      }, 150);
      v.src = '/devtest/' + clip.file;
      var p = v.play(); if (p && p.catch) p.catch(function () {});
    });
  }
  /* runs every clip one after the other; onUpdate(clip, state, result) lets the screen show progress */
  function run(onUpdate) {
    return manifest().then(function (clips) {
      var out = [], byId = {};
      return clips.reduce(function (chain, clip) {
        return chain.then(function () {
          if (onUpdate) onUpdate(clip, 'testing');
          if (clip.needs && byId[clip.needs] && byId[clip.needs].ok === false) {      // e.g. an MKV test uses H.264 video: if H.264 itself fails, that test proves nothing
            var r0 = { clip: clip, ok: null, how: 'needs ' + clip.needs }; out.push(r0); byId[clip.id] = r0; if (onUpdate) onUpdate(clip, 'done', r0); return;
          }
          return testClip(clip).then(function (r) { var r1 = { clip: clip, ok: r.ok, how: r.how }; out.push(r1); byId[clip.id] = r1; if (onUpdate) onUpdate(clip, 'done', r1); });
        });
      }, Promise.resolve()).then(function () {
        out.forEach(function (r) { if (r.ok !== null) Api.recordTest(r.clip.trait, r.ok); });
        Store.set('devtest', { ts: Date.now(), ua: navigator.userAgent, results: out.map(function (r) { return { id: r.clip.id, trait: r.clip.trait, ok: r.ok }; }) });
        return out;
      });
    });
  }
  return { done: done, skip: skip, reset: reset, run: run, info: info };
})();
