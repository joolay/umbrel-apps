/* Player: finds sources, picks the best, plays through the signed-in streaming proxy, glass TV controls. */
var Player = (function () {
  var S = null;   // active session
  var Warm = {};  // next episodes whose first minute was read ahead: videoId -> {infoHash, fileIdx}
  /* control icons: drawn here (not emoji, which TVs colour in orange) and filled with the button's own text colour */
  var ICON2 = {
    asy: '<svg class="ico" viewBox="0 0 48 48" width="46" height="46"><g fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 19h7l9-7v24l-9-7H6z"/><path d="M29 18a9 9 0 0 1 0 12M34 13a16 16 0 0 1 0 22"/></g></svg>',
    asp: '<svg class="ico" viewBox="0 0 48 48" width="46" height="46"><g fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="11" width="36" height="26" rx="4"/><path d="M14 18v-3h3M34 15h3v3M37 30v3h-3M17 33h-3v-3"/></g></svg>',
    fill: '<svg class="ico" viewBox="0 0 48 48" width="46" height="46"><g fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 18V7h11M41 18V7H30M7 30v11h11M41 30v11H30"/><path d="M7 7l9 9M41 7l-9 9M7 41l9-9M41 41l-9-9"/></g></svg>',
    speed: '<svg class="ico" viewBox="0 0 48 48" width="46" height="46"><g fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 33a17 17 0 1 1 34 0"/><path d="M24 33l8-10"/><path d="M12 33h3M33 33h3M24 17v3"/></g></svg>',
    subs: '<svg class="ico" viewBox="0 0 48 48" width="46" height="46"><g fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="10" width="38" height="28" rx="6"/><path d="M12 22h10M26 22h10M12 30h6M22 30h14"/></g></svg>',
    src: '<svg class="ico" viewBox="0 0 48 48" width="46" height="46"><g fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 14h32M8 24h32M8 34h32"/><circle cx="16" cy="14" r="3.5" fill="currentColor"/><circle cx="32" cy="24" r="3.5" fill="currentColor"/><circle cx="20" cy="34" r="3.5" fill="currentColor"/></g></svg>'
  };
  var ICON = { back: '<svg class="ico" viewBox="0 0 48 48" width="46" height="46"><g fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M24.4 14.9 L17.0 13.9 L19.8 6.9"/><path d="M17.0 13.9 A14 14 0 1 1 10.1 27.2"/></g><text x="24" y="31" text-anchor="middle" font-size="13.5" font-weight="800" fill="currentColor" style="font-family:inherit">10</text></svg>', fwd: '<svg class="ico" viewBox="0 0 48 48" width="46" height="46"><g transform="matrix(-1 0 0 1 48 0)" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M24.4 14.9 L17.0 13.9 L19.8 6.9"/><path d="M17.0 13.9 A14 14 0 1 1 10.1 27.2"/></g><text x="24" y="31" text-anchor="middle" font-size="13.5" font-weight="800" fill="currentColor" style="font-family:inherit">10</text></svg>', play: '<svg class="ico" viewBox="0 0 48 48" width="46" height="46"><path d="M17 11.5v25a1.6 1.6 0 0 0 2.4 1.4l21-12.5a1.6 1.6 0 0 0 0-2.8l-21-12.5A1.6 1.6 0 0 0 17 11.5z" fill="currentColor"/></svg>', pause: '<svg class="ico" viewBox="0 0 48 48" width="46" height="46"><rect x="13" y="11" width="7.5" height="26" rx="2.6" fill="currentColor"/><rect x="27.5" y="11" width="7.5" height="26" rx="2.6" fill="currentColor"/></svg>' };

  function $(sel) { return S && S.el.querySelector(sel); }
  function speedLabel(r) { var b = $('[data-pact=speed] .rt'); if (b) b.textContent = r + 'x'; }
  function say(msg) { var m = $('.pmsg'); if (m) { m.textContent = msg || ''; m.style.display = msg ? 'block' : 'none'; } }
  function spin(msg) { var s = $('.pspin'); if (s) { s.textContent = msg || ''; s.style.display = msg ? 'block' : 'none'; } }

  function open(info) {
    if (S) close();
    var h = '<video id="pv" preload="auto"></video><div class="pspin" style="display:none"></div><div class="pmsg" style="display:none"></div><div class="skips" id="skips"></div>' +
      '<div class="pov"><div class="ptop"><div class="t1">' + Views.esc(info.title || '') + '</div><div class="t2">' + Views.esc([info.sub, info.epTitle].filter(Boolean).join(' · ')) + '</div><div class="pmode glass" id="pmode"></div><div class="pdl glass" id="pdl" style="display:none"></div></div>' +
      '<div class="tprev glass" id="tprev" style="display:none"><div class="timg img" id="timg"></div><div class="tt" id="ttime"></div></div><div class="pbar glass"><div class="seek f" id="seek"><div class="buf"></div><div class="pos"></div><div class="knob"></div></div>' +
      '<div class="times"><span id="tcur">0:00</span><span id="tdur">0:00</span></div>' +
      '<div class="pctl"><div class="pz l">' +
      '<span class="cbtn ic f" data-pact="sources" aria-label="Sources" title="Sources">' + ICON2.src + '</span><span class="cbtn ic f" data-pact="subs" aria-label="Subtitles and subtitle sync" title="Subtitles">' + ICON2.subs + '</span><span class="cbtn ic f" data-pact="async" aria-label="Audio sync" title="Audio sync">' + ICON2.asy + '</span><span class="cbtn ic f" data-pact="speed" aria-label="Playback speed" title="Speed">' + ICON2.speed + '<b class="rt">1x</b></span></div>' +
      '<div class="pz c"><span class="cbtn ic f" data-pact="back10" aria-label="Back 10 seconds">' + ICON.back + '</span><span class="cbtn ic big f" data-pact="toggle" id="bplay" aria-label="Play or pause">' + ICON.pause + '</span><span class="cbtn ic f" data-pact="fwd10" aria-label="Forward 10 seconds">' + ICON.fwd + '</span></div>' +
      '<div class="pz r"><span class="cbtn ic f" data-pact="aspect" aria-label="Aspect ratio" title="Aspect ratio">' + ICON2.asp + '<b class="rt">Auto</b></span><span class="cbtn ic f" data-pact="fill" aria-label="Fill the screen" title="Fill the screen">' + ICON2.fill + '</span></div></div></div></div>';
    var el = Views.mount('player', h, { cls: 'player', onBack: function () { close(); Views.pop(); return true; }, onClose: cleanup });
    S = { el: el, info: info, v: el.querySelector('#pv'), learnedFor: {}, buf: { speed: 0, peers: 0, len: 0, fill: null }, hold: false, streams: [], groups: [], idx: -1, tried: {}, rate: 1, subs: null, ui: true, uiT: null, lastSave: 0, tick: null, buffT: null, ended: false, gotTime: false };
    keepPitch(S.v);
    bind();
    Nav.set(el.querySelector('#seek'), true);
    showUi();
    spin('Finding sources…');
    var vid = info.videoId || info.id;
    if (info._direct) { S.streams = [{ _direct: info._direct, name: 'Direct', _q: { quality: '', seeds: 0, size: '', score: 0 } }]; return start(0); }
    var streamReady = Backend.stream().then(function (base) { Api.setStreamBase(base); });
    Promise.all([Api.ensure().then(function () {
      return Api.getStreams(info.type, vid, function (n) { if (S && S.el === el) spin('Finding sources… ' + n + ' found'); });
    }), streamReady]).then(function (r) {
      var res = r[0];
      if (!S || S.el !== el) return;
      var list = preferStream(res.list, vid); S.streams = list; S.groups = res.groups;
      if (!list.length) { spin(''); say('No sources found for this title.\nTry another title, or show more files in Settings > Sources.'); return; }
      if (info.pick) { spin(''); return pickSource(); }
      if (!res.hasPreferred) {                                   // nothing in the preferred quality: say so, and let the person choose from what exists
        S.failed = true; S.missing = res.preferred; spin('');
        say(res.preferred + ' is not available for this title.\nChoose another version to watch (press OK to see them again).');
        Views.toast(res.preferred + ' is not available for this title. Pick an alternative.', 6000);
        return pickSource(res.preferred);
      }
      start(0);                                                  // the file in the preferred quality with the most seeds
    }).catch(function (e) {
      if (!S || S.el !== el) return;
      if (e && e.status === 401) { close(); Views.pop(); return Views.signedOut(); }
      spin(''); say('Could not start: ' + e.message);
    });
  }

  /* the copy that is already downloaded (or warmed up) comes first: it starts at once and plays from the cache */
  function preferStream(list, vid) {
    var j = Dl.forVideo(vid), w = Warm[vid], want = j && j.status !== 'failed' && j.infoHash ? { infoHash: j.infoHash, fileIdx: j.fileIdx } : w || null;
    if (!want) return list;
    for (var i = 0; i < list.length; i++) if (list[i].infoHash === want.infoHash && (list[i].fileIdx == null ? -1 : list[i].fileIdx) === want.fileIdx) { if (i === 0) return list; var c = list.slice(); c.unshift(c.splice(i, 1)[0]); return c; }
    return list;
  }
  /* how this file will be played: "direct" (the device decodes it) or "transcode" (the server converts it to HLS) */
  function playMode(s) { var m = Store.get('playback', null); if (m === null) m = Store.get('transcode', false) ? 'transcode' : 'auto'; return m; }
  function decide(s) {
    var m = playMode(s);
    if (s._direct) return { hls: false, label: 'Direct' };
    if (m === 'transcode') return { hls: true, label: 'Transcoding (your choice)' };
    if (m === 'direct') return { hls: false, label: 'Direct play (your choice)' };
    var a = Api.assess(s);
    return a.transcode ? { hls: true, label: 'Transcoding: ' + a.reason } : { hls: false, label: 'Direct play' };
  }
  function setMode(label) { var m = $('#pmode'); if (m) { m.textContent = label; m.style.display = label ? 'inline-block' : 'none'; } }
  function start(i, forceHls, safe) {
    if (!S) return;
    var s = S.streams[i]; if (!s) return;
    S.idx = i; S.ended = false; S.gotTime = false;
    clearTimeout(S.decodeT1); clearTimeout(S.decodeT2); clearTimeout(S.okT); clearTimeout(S.flowT); S.metaOk = false;
    var d = decide(s), hls = forceHls || d.hls;
    var url = s._direct || (hls ? Api.hlsUrl(s, safe) : Api.directUrl(s));
    if (!url) { return next('Unsupported source'); }
    S.hls = !!hls; S.safe = !!safe; S.tried[i] = (S.tried[i] || 0) + 1;
    setMode(forceHls ? 'Transcoding: ' + (S.why || 'compatibility') : d.label);
    spin((hls ? 'Starting transcoded stream…' : 'Starting stream…') + (s._q && s._q.quality ? ' (' + s._q.quality + ')' : ''));
    say('');
    var v = S.v;
    try { v.pause(); } catch (e) {}
    v.src = url; v.playbackRate = 1; S.rate = 1;
    try { v.defaultPlaybackRate = 1; } catch (e) {}
    v.load();
    // smart buffering: let the download get ahead first, by as much as the measured speed calls for, then play
    S.buf = { speed: 0, peers: 0, len: 0, fill: null, lastEnd: 0, lastT: 0, lastGrow: Date.now() };
    S.hold = bufMode() !== 'off' && !s._direct; S.rebuf = false; S.holdAt = Date.now(); S.autoPaused = S.hold; S.graceUntil = 0;
    if (S.hold) { spin('Buffering…'); pollStats(true); } else { var p = v.play(); if (p && p.catch) p.catch(function () {}); }
    // data is arriving (the first 64 KB can be read) but the TV never opens the file: an unsupported container or codec, not a slow download
    if (!hls && !s._direct) S.flowT = setTimeout(function () {
      var sess = S; if (!sess || sess.idx !== i || sess.metaOk || sess.hls) return;
      fetch(url, { headers: { Range: 'bytes=0-65535' } }).then(function (r) { return r.arrayBuffer(); }).then(function (b) {
        if (S === sess && sess.idx === i && !sess.metaOk && !sess.hls && b.byteLength >= 20000) next('Your TV could not read this file', true);
      }).catch(function () {});
    }, 9000);
    if (S.subsIdx !== i) { S.subsIdx = i; S.hash = null; S.size = 0; loadSubs(true); }     // new file: find subtitles for that file
    speedLabel(1);
  }
  function next(why, strong) {
    if (!S) return;
    var i = S.idx, s = S.streams[i];
    S.why = why || 'playback problem';
    if (strong && !S.hls && s && !s._direct) Api.learn(s, false);          // the decoder failed on this kind of file: remember it for next time
    if (!S.hls && s && !s._direct) { say((why || 'Playback problem') + ' – trying transcoding…'); return start(i, true, false); }
    if (S.hls && !S.safe && s && !s._direct) { say((why || 'Playback problem') + ' – trying safer transcoding…'); return start(i, true, true); }
    for (var j = i + 1; j < S.streams.length && j < i + 6; j++) { if (!S.tried[j]) { say((why || 'Playback problem') + ' – trying another source…'); return start(j); } }
    spin(''); say((why || 'Playback failed') + '.\nPress OK to choose another source.');
    S.failed = true;
  }

  function bind() {
    var v = S.v, sess = S;
    function alive() { return S === sess; }
    v.addEventListener('loadedmetadata', function () {
      if (S && (S.fillOn || S.aspect)) applyShape();
      if (!alive()) return;
      sess.metaOk = true;
      var st = (sess.info.startMs || 0) / 1000;
      if (st > 5 && !sess.resumed && isFinite(v.duration) && st < v.duration - 20) { try { v.currentTime = st; } catch (e) {} }
      sess.resumed = true;
      // direct play only: tell a decoder problem apart from a slow download, and fall back within seconds instead of waiting for the 45 s timeout
      clearTimeout(sess.decodeT1); clearTimeout(sess.decodeT2);
      if (!sess.hls) {
        sess.decodeT1 = setTimeout(function () { if (alive() && !sess.hls && !sess.gotTime && v.videoWidth === 0) next('Your TV could not show the picture of this file', true); }, 4000);
        sess.decodeT2 = setTimeout(function () {
          if (!alive() || sess.hls || sess.gotTime) return;
          var ahead = v.buffered && v.buffered.length ? v.buffered.end(v.buffered.length - 1) - v.currentTime : 0;
          if (ahead >= 3 && !v.paused) next('Your TV could not play this file', true);       // data is there but nothing plays: the decoder is stuck
        }, 12000);
      }
    });
    v.addEventListener('playing', function () {
      if (!alive()) return; sess.gotTime = true; spin(''); say(''); sess.failed = false; reapplyRate(); setPlayLabel(); showUi(); loadMarks();
      clearTimeout(sess.okT);
      if (!sess.hls) {                                          // played for a few seconds with a picture: remember this device can play these formats directly
        var base = v.currentTime, idx = sess.idx;
        sess.okT = setTimeout(function () {
          if (!alive() || sess.hls || sess.idx !== idx || sess.learnedFor[idx]) return;
          var fr = v.webkitDecodedFrameCount;
          if (!v.paused && v.currentTime - base >= 4 && v.videoWidth > 0 && (fr === undefined || fr > 0)) { sess.learnedFor[idx] = 1; Api.learn(sess.streams[idx], true); }
        }, 6500);
      }
    });
    v.addEventListener('waiting', function () { if (!alive()) return; clearTimeout(sess.buffT); sess.buffT = setTimeout(function () { if (alive() && !v.paused) spin('Buffering…'); }, 700); });
    v.addEventListener('canplay', function () { if (alive()) { clearTimeout(sess.buffT); spin(''); } });
    v.addEventListener('pause', function () { if (alive() && !sess.autoPaused) { setPlayLabel(); showUi(true); save(); } });
    v.addEventListener('play', function () { if (alive()) setPlayLabel(); });
    v.addEventListener('seeked', function () { if (alive()) reapplyRate(); });
    v.addEventListener('ended', function () {
      if (!alive()) return; sess.ended = true; save(true);
      var n = sess.info.getNext && sess.info.getNext(sess.info.videoId || sess.info.id);
      if (n) startUpNext(n); else { close(); Views.pop(); }
    });
    v.addEventListener('error', function () {
      if (!alive()) return;
      var code = v.error ? v.error.code : 0, msg = code === 4 ? 'This file format is not supported directly' : 'Playback error', idx = sess.idx, src = v.currentSrc || v.src;
      if (sess.hls || code !== 4) return next(msg, !sess.hls && code === 3);
      // a "source not supported" error is also what a missing file or a dead download looks like: only blame the decoder when the file itself is reachable
      fetch(src, { headers: { Range: 'bytes=0-1' } }).then(function (r) { if (alive() && sess.idx === idx) next(msg, r.ok); }, function () { if (alive() && sess.idx === idx) next(msg, false); });
    });
    sess.tick = setInterval(function () { if (alive()) update(); }, 500);
    sess.watchdog = setTimeout(function wd() {
      if (!alive() || sess.gotTime || sess.failed || !sess.streams.length) return;
      if (sess.hold && Date.now() - (sess.buf.lastGrow || 0) < 15000) { sess.watchdog = setTimeout(wd, 15000); return; }   // still filling the buffer on purpose
      next('Taking too long to start');
    }, 45000);
    sess.bufT = setInterval(function () { if (alive()) bufTick(); }, 500);
  }
  function startUpNext(n) {
    S.upnext = { n: n, left: 8 };
    function render() { if (S && S.upnext) say('Up next: ' + n.sub + (n.epTitle ? ' · ' + n.epTitle : '') + '\nStarting in ' + S.upnext.left + 's  –  OK to play now, Back to stop'); }
    render();
    S.upnext.timer = setInterval(function () { if (!S || !S.upnext) return; S.upnext.left--; if (S.upnext.left <= 0) playNext(); else render(); }, 1000);
  }
  function playNext() {
    if (!S || !S.upnext) return;
    var info = Object.assign({}, S.info, S.upnext.n); delete info.pick; info.startMs = 0; delete info._direct;
    close(); Views.pop(); open(info);
  }
  /* faster playback with matching audio: the sound speeds up with the picture but keeps its pitch (no chipmunk voices) */
  function keepPitch(v) { try { v.preservesPitch = true; } catch (e) {} try { v.webkitPreservesPitch = true; } catch (e) {} try { v.mozPreservesPitch = true; } catch (e) {} }
  function setRate(r) { var v = S.v; S.rate = r; keepPitch(v); try { v.defaultPlaybackRate = r; } catch (e) {} try { v.playbackRate = r; } catch (e) {} keepPitch(v); }
  function reapplyRate() { if (S && S.v) { keepPitch(S.v); if (Math.abs(S.v.playbackRate - S.rate) > 0.01) { try { S.v.playbackRate = S.rate; } catch (e) {} } } }
  function setPlayLabel() { var b = $('#bplay'); if (b && S) b.innerHTML = S.v.paused ? ICON.play : ICON.pause; }

  /* ---- skip intro, and the credit scene after the credits ---- */
  /* What is known about this file: the intro (from its chapters, or marked once for the show), where the credits start, and any mid-/end-credit scenes.
     The server finds them; the player only shows one small button at the right moment (OK on the remote presses it). */
  function showIdOf(info) { var id = String((info && (info.videoId || info.id)) || '').split(':')[0]; return /^tt\d{5,12}$/.test(id) ? id : ''; }
  function fileKey(s) { return s && s.infoHash ? { infoHash: s.infoHash, fileIdx: s.fileIdx == null ? -1 : s.fileIdx } : null; }
  /* Where the skip points come from, in this order: the community databases (by IMDb id, season and episode), the file's own chapters. */
  function loadMarks() {
    var sess = S, s = sess.streams[sess.idx], f = fileKey(s); if (!f) return;
    var key = f.infoHash + ':' + f.fileIdx; if (sess.marksFor === key) return;
    sess.marksFor = key; var M = sess.marks = { intro: null, credits: null, scenes: [], done: {} };
    var info = sess.info, show = showIdOf(info), mm = /^[^:]*:(\d+):(\d+)$/.exec(info.videoId || ''), series = info.type === 'series' && !!mm;
    function live() { return S === sess && sess.marks === M; }
    function take(r, from) {
      if (!live() || !r) return;
      if (!M.intro && r.intro) { M.intro = r.intro; }
      if (!M.credits && r.credits) M.credits = r.credits;
      (r.scenes || []).forEach(function (x) { if (M.scenes.indexOf(x) < 0) M.scenes.push(x); }); M.scenes.sort(function (a, b) { return a - b; });
    }
    var dur = isFinite(sess.v.duration) ? sess.v.duration : 0;
    (show ? Backend.call('POST', '/api/marks/lookup', { imdb: show, season: series ? +mm[1] : null, episode: series ? +mm[2] : null, duration: dur }, undefined, 20000).then(function (r) { take(r, 'community'); }).catch(function () {}) : Promise.resolve())
      .then(function () {
        if (!live() || (M.intro && M.credits)) return;
        return Backend.call('POST', '/api/marks/scan', f, undefined, 30000).then(function (r) {                // the file's own chapters
          take({ intro: r.intro, credits: r.credits, scenes: r.scenes }, 'file');
        }).catch(function () {});
      });
  }
  function wantSkip(t, d) {
    var M = S.marks; if (!M) return null;
    if (M.intro && t >= M.intro.start - 0.5 && t < M.intro.end - 2 && !M.done['intro']) return { kind: 'intro', label: 'Skip intro', to: M.intro.end };
    if (M.credits && t >= M.credits.start - 1) {
      for (var i = 0; i < M.scenes.length; i++) if (M.scenes[i] > t + 3 && !M.done['scene' + i]) return { kind: 'scene' + i, label: 'Skip to extra scene', to: M.scenes[i] };
      var n = S.info.getNext && S.info.getNext(S.info.videoId || S.info.id);
      if (n && !M.scenes.some(function (x) { return x > t; }) && !M.done['next']) return { kind: 'next', label: 'Next episode', next: n };
    }
    return null;
  }
  function marksTick(t, d) {
    if (!S.marks || S.hold || S.upnext) return;
    var w = wantSkip(t, d), K = S.skip, el = $('#skips'); if (!el) return;
    if (!w) { if (K) { S.skip = null; el.innerHTML = ''; } return; }
    if (!K || K.kind !== w.kind) {
      S.skip = K = { kind: w.kind, w: w, shownAt: Date.now(), hidden: false };
      el.innerHTML = '<div class="skip glass f" data-pact="skipgo">' + Views.esc(w.label) + ' <small>OK</small></div>'; el.className = 'skips' + (S.ui ? ' up' : '');
    } else if (!K.hidden && !S.ui && Date.now() - K.shownAt > 10000) { K.hidden = true; el.firstChild.style.display = 'none'; }     // discreet: fades after 10 s, back with the controls
  }
  function skipsUi() {
    var el = S && $('#skips'); if (!el) return;
    el.className = 'skips' + (S.ui ? ' up' : '');
    if (S.skip && S.ui && S.skip.hidden && el.firstChild) { S.skip.hidden = false; S.skip.shownAt = Date.now(); el.firstChild.style.display = ''; }
  }
  function doSkip() {
    var K = S && S.skip; if (!K) return false;
    var w = K.w, M = S.marks; M.done[w.kind] = 1;
    if (w.next) { S.upnext = { n: w.next, left: 0 }; playNext(); return true; }
    try { S.v.currentTime = w.to; } catch (e) {} S.skip = null; var el = $('#skips'); if (el) el.innerHTML = ''; update(); return true;
  }
  /* ---- smart buffering ---- */
  function bufMode() { return Store.get('bufmode', 'auto'); }
  function bufEnd(v) { var t = v.currentTime, b = v.buffered; for (var i = 0; i < b.length; i++) if (b.start(i) <= t + 0.4 && b.end(i) >= t) return b.end(i); return t; }
  function pollStats(first) {                                   // the torrent's live download speed and peers, from the streaming server
    var sess = S; if (!sess) return; clearTimeout(sess.statsT);
    var st = sess.streams[sess.idx], url = st && Api.statsUrl(st);
    if (url) Api.getJSON(url, 3000).then(function (j) {
      if (S !== sess || !j) return;
      var sp = +(j.downloadSpeed != null ? j.downloadSpeed : j.speed), B = sess.buf;
      if (isFinite(sp)) B.speed = B.speed ? B.speed * 0.5 + sp * 0.5 : sp;           // smoothed, so one quiet second doesn't swing the plan
      B.peers = +(j.unchoked != null ? j.unchoked : j.peers) || B.peers; B.len = +(j.streamLen || j.length) || B.len;
    }).catch(function () {});
    sess.statsT = setTimeout(function () { if (S === sess) pollStats(); }, sess.hold ? 2000 : 6000);
  }
  function release(why) {
    if (!S || !S.hold) return;
    S.hold = false; S.autoPaused = false; S.rebuf = false; S.graceUntil = Date.now() + 5000; spin('');
    var p = S.v.play(); if (p && p.catch) p.catch(function () {});
  }
  function bufMsg(ahead, target, plan) {
    var B = S.buf, bits = [Math.round(ahead) + ' of ' + target + ' s buffered'];
    if (B.speed > 0) bits.push(Buf.fmtSpeed(B.speed)); if (B.peers) bits.push(B.peers + ' peers');
    return (S.rebuf ? 'Rebuilding the buffer…' : 'Buffering…') + '\n' + bits.join(' · ') + (plan.slow ? '\nThis source downloads slower than it plays. Choose Sources for one with more seeds or a lower resolution.' : '');
  }
  function bufTick() {
    var v = S.v, B = S.buf, mode = bufMode(); if (!v || S.failed || S.upnext || S.ended) return;
    if (mode === 'off') { if (S.hold) release('off'); return; }
    var now = Date.now(), dur = v.duration, end = bufEnd(v), ahead = Math.max(0, end - v.currentTime);
    if (B.lastT) { var dt = (now - B.lastT) / 1000; if (dt >= 0.4) { var g = Math.max(0, (end - B.lastEnd) / dt); B.fill = B.fill == null ? g : B.fill * 0.7 + g * 0.3; if (end > B.lastEnd + 0.05) B.lastGrow = now; B.lastEnd = end; B.lastT = now; } }
    else { B.lastT = now; B.lastEnd = end; B.lastGrow = now; }
    if (!isFinite(dur) || !dur) return;                                               // not opened yet
    var st = S.streams[S.idx], size = (st && st.behaviorHints && st.behaviorHints.videoSize) || B.len || 0;
    var plan = Buf.plan({ bitrate: size ? size / dur : 0, speed: B.speed, fill: B.fill, duration: dur, mode: mode, hls: S.hls }), nearEnd = end >= dur - 1; B.plan = plan;
    if (S.hold) {
      var target = S.rebuf ? plan.resumeSecs : plan.startSecs, waited = (now - S.holdAt) / 1000;
      var idle = v.networkState === 1 && waited > 4 && ahead >= 3;                    // the browser has stopped fetching: its own buffer limit is reached
      if (ahead >= target || nearEnd || waited >= plan.maxWait || idle) return release();
      spin(bufMsg(ahead, target, plan));
    } else if (!v.paused && !v.seeking && S.gotTime && now > S.graceUntil && !nearEnd && ahead < plan.lowSecs && (B.fill == null || B.fill < 1.1)) {
      S.hold = true; S.rebuf = true; S.rebufs = (S.rebufs || 0) + 1; S.holdAt = now; S.autoPaused = true; v.pause();       // running dry: stop, rebuild a bigger cushion, then carry on smoothly (instead of stuttering)
      spin(bufMsg(ahead, plan.resumeSecs, plan));
    }
  }

  function update() {
    var v = S.v, d = v.duration, t = v.currentTime;
    if (!isFinite(d) || !d) { return; }
    var pos = $('.seek .pos'), knob = $('.seek .knob'), buf = $('.seek .buf'), pct = Math.min(100, t / d * 100);
    if (pos) pos.style.width = pct + '%'; if (knob) knob.style.left = pct + '%';
    if (buf) drawLoaded(buf, v, d);
    $('#tcur').textContent = Views.fmtTime(t * 1000); $('#tdur').textContent = '-' + Views.fmtTime(Math.max(0, d - t) * 1000);
    if (Date.now() - S.lastSave > 10000 && !v.paused) save();
    marksTick(t, d); thumbPump(); dlReport(t, d); warmNext(t, d);
  }
  function save(done) {
    if (!S || !S.v || !isFinite(S.v.duration) || !S.v.duration) return;
    var i = S.info, t = S.v.currentTime * 1000, d = S.v.duration * 1000; S.lastSave = Date.now();
    if (t < 20000 && !done) return;
    var mm = /^([^:]*):(\d+):(\d+)$/.exec(i.videoId || ''), isDone = !!done || t / d > 0.93;
    Resume.put(i.videoId || i.id, { type: i.type, id: i.id, videoId: i.videoId || i.id, name: i.title, poster: i.poster, t: done ? d : t, d: d, ts: Date.now(), done: isDone,
      season: mm ? +mm[2] : undefined, episode: mm ? +mm[3] : undefined });
  }
  function cleanup() {
    if (!S) return;
    save();
    if (S.upnext) clearInterval(S.upnext.timer);
    var v = S.v; clearInterval(S.bufT); clearTimeout(S.statsT); clearInterval(S.tick); clearTimeout(S.uiT); clearTimeout(S.buffT); clearTimeout(S.watchdog); clearTimeout(S.decodeT1); clearTimeout(S.decodeT2); clearTimeout(S.okT); clearTimeout(S.flowT);
    try { Dl.report({ stopped: true }); } catch (e) {}
    try { for (var tk in (S.thumbs || {})) URL.revokeObjectURL(S.thumbs[tk]); } catch (e) {}
    try { v.pause(); v.removeAttribute('src'); v.load(); } catch (e) {}
    S = null;
    if (window.Sync) Sync.run();
  }
  function close() { if (S) cleanup(); }

  /* ---- UI ---- */
  function showUi(keep) {
    if (!S) return;
    S.ui = true; S.el.querySelector('.pov').style.display = 'block'; skipsUi();
    clearTimeout(S.uiT);
    if (!(S.v && S.v.paused) || !keep) S.uiT = setTimeout(hideUi, 5000);
  }
  function hideUi() {
    if (!S || S.v.paused || Views.hasMenu()) return;
    S.ui = false; S.el.querySelector('.pov').style.display = 'none'; skipsUi(); Nav.set(S.el.querySelector('#seek'), true);
  }
  /* One tap = one jump. Holding the button or key keeps jumping once a second (rep = a repeat of a hold); going forward, the repeats stop where the download ends. */
  function seekBy(sec, rep) {
    if (!S || !isFinite(S.v.duration)) return;
    var v = S.v, t = v.currentTime, to = Math.max(0, Math.min(v.duration - 2, t + sec));
    if (rep && sec > 0) {
      var lim = loadedEnd(v) - 1.5;
      if (to > lim) to = lim;
      if (to <= t + 0.5) { if (!S.holdToast || Date.now() - S.holdToast > 3000) { S.holdToast = Date.now(); Views.toast('That is as far as is downloaded so far', 2500); } return; }
    }
    S.lastJump = Date.now(); v.currentTime = to; update(); showUi(); say(''); previewAt(to);
  }
  /* ---- downloads and playback together ---- */
  /* every 5 s: how much this player has buffered. The server pauses downloads while any player is running short and resumes them afterwards. */
  function dlReport(t, d) {
    var sess = S, f = fileKey(sess.streams[sess.idx]); if (!f || Date.now() - (sess.dlPingAt || 0) < 5000) return;
    sess.dlPingAt = Date.now();
    Dl.report({ infoHash: f.infoHash, fileIdx: f.fileIdx, ahead: Math.max(0, bufEnd(sess.v) - t), hold: !!(sess.hold || sess.rebuf) }).then(function (job) {
      if (S !== sess) return; sess.dlJob = job;
      var el = $('#pdl'); if (!el) return;
      if (job && job.status !== 'ready') { el.textContent = job.status === 'paused' ? 'Download paused while you watch (' + Dl.pct(job) + '%)' : 'Also downloading: ' + Dl.pct(job) + '%'; el.style.display = 'inline-block'; } else el.style.display = 'none';
    });
  }
  /* near the end of a fully downloaded episode: read the first minute of the next one ahead, so it starts at once */
  function warmNext(t, d) {
    var sess = S, info = sess.info; if (sess.warmDone || !info.getNext || !d || (d < 300 && !window.JTV_TEST_WARM) || sess.upnext) return;
    if (Date.now() < (sess.warmAt || 0) || d - t > Math.min(360, d * 0.15)) return;
    var done = sess.dlJob && sess.dlJob.status === 'ready', cov = 0; if (!done) { loadedRanges(sess.v).forEach(function (r) { cov += r[1] - r[0]; }); }
    if (!done && cov < d * 0.98) return;                                   // the current episode is not all downloaded yet
    var n = info.getNext(info.videoId || info.id), cur = sess.streams[sess.idx], len = (sess.buf && sess.buf.len) || (cur && cur.behaviorHints && cur.behaviorHints.videoSize) || (sess.dlJob && sess.dlJob.size) || 0;
    if (!n || !len) { sess.warmDone = true; return; }
    sess.warmDone = true;
    var rate = len / d, bytes = Math.max(2000000, Math.min(79000000, Math.ceil(rate * 60 * 1.2)));
    Api.getStreams(info.type, n.videoId).then(function (res) {
      var s = res.list[0], f = fileKey(s); if (!f) return;
      return Backend.call('POST', '/api/prefetch', { infoHash: f.infoHash, fileIdx: f.fileIdx, from: 0, to: bytes - 1 }, undefined, 160000).then(function () { Warm[n.videoId] = { infoHash: f.infoHash, fileIdx: f.fileIdx }; });
    }).catch(function (e) { if (e && e.status === 429 && S === sess) { sess.warmDone = false; sess.warmAt = Date.now() + 30000; } });
  }
  /* ---- seek preview pictures ---- */
  /* Pictures are made on the server (ffmpeg), one every 10 s, only for parts of the file that this player has already loaded (so nothing is
     pulled from the torrent ahead of the film), closest to the playhead first. A jump shows the picture of where you land. */
  var THUMB_STEP = Thumbplan.STEP;
  /* parts of the film that are downloaded: what this player has loaded (S.seen) and parts the server was asked to read ahead (S.pre), as [start, end] seconds */
  function addRange(list, a, e) {
    for (var k = 0; k < list.length; k++) if (a <= list[k][1] + 0.5 && e >= list[k][0] - 0.5) { list[k][0] = Math.min(list[k][0], a); list[k][1] = Math.max(list[k][1], e); return; }
    list.push([a, e]);
  }
  function seenUpdate(v) {
    var seen = S.seen || (S.seen = []), b = v.buffered;
    for (var i = 0; i < b.length; i++) addRange(seen, b.start(i), b.end(i));
  }
  function loadedRanges(v) {                              // everything above, merged into separate stretches, in order
    seenUpdate(v);
    var all = (S.seen || []).concat(S.pre || []).map(function (r) { return [r[0], r[1]]; }).sort(function (a, b) { return a[0] - b[0]; }), out = [];
    all.forEach(function (r) { var l = out[out.length - 1]; if (l && r[0] <= l[1] + 0.5) l[1] = Math.max(l[1], r[1]); else out.push(r); });
    return out;
  }
  function loadedEnd(v) {                                 // where the downloaded stretch that holds the playhead ends
    var t = v.currentTime, e = t, rs = loadedRanges(v);
    for (var i = 0; i < rs.length; i++) if (rs[i][0] <= t + 0.5 && rs[i][1] >= t) e = rs[i][1];
    return e;
  }
  /* the light shading of the progress bar: filled only where the film is downloaded (not necessarily one stretch from the start) */
  function drawLoaded(box, v, d) {
    var html = '';
    loadedRanges(v).forEach(function (r) { var l = Math.max(0, r[0] / d * 100), w = Math.min(100 - l, (r[1] - r[0]) / d * 100); if (w > 0.05) html += '<span class="bseg" style="left:' + l.toFixed(2) + '%;width:' + w.toFixed(2) + '%"></span>'; });
    if (html !== S.loadedHtml) { S.loadedHtml = html; box.innerHTML = html; }
  }
  /* Order of work: 1) pictures for what is already loaded, nearest the playhead first (this is the starting buffer, so it comes first and never waits);
     2) the rest of the file, but only while the download is comfortably faster than the film plays and the buffer ahead is healthy, so the torrent keeps feeding playback first. */
  function thumbPump() {
    var sess = S; if (!sess || sess.thumbOff || sess.hold || sess.rebuf || sess.failed || sess.ended) return;
    var v = sess.v, f = fileKey(sess.streams[sess.idx]); if (!f || !isFinite(v.duration) || v.duration < 60 || Date.now() < (sess.thumbNext || 0)) return;
    var ahead = bufEnd(v) - v.currentTime; if (ahead < 5 || (sess.thumbN || 0) >= 2) return;        // never compete with the start of playback
    seenUpdate(v);
    var th = sess.thumbs || (sess.thumbs = {}), bad = sess.thumbBad || (sess.thumbBad = {}), fly = sess.thumbFly || (sess.thumbFly = {}), t = v.currentTime;
    if (!sess.firstPlayAt) sess.firstPlayAt = Date.now();
    if (ahead > (sess.aheadMax || 0) + 1) { sess.aheadMax = ahead; sess.aheadGrewAt = Date.now(); }
    var plan = sess.buf && sess.buf.plan;
    var nx = Thumbplan.next({ forceFar: !!window.JTV_TEST_FAR, dur: v.duration, t: t, seen: sess.seen, have: th, bad: bad, fly: fly, ratio: plan && plan.ratio, slow: !plan || plan.slow, ahead: ahead, aheadMax: sess.aheadMax || 0,
      sinceGrewMs: Date.now() - (sess.aheadGrewAt || Date.now()), playedMs: Date.now() - sess.firstPlayAt });
    if (!nx) return;
    var pick = nx.pick, loadedPick = nx.loaded, st = sess.streams[sess.idx];
    if (!loadedPick && sess.farBusy) return;                            // one read-ahead at a time
    sess.thumbN = (sess.thumbN || 0) + 1; fly[pick] = 1; sess.thumbNext = Date.now() + (loadedPick ? 150 : 400);
    var hdr = { 'x-jtv-token': Backend.token() || '' };
    function picture() {
      return fetch('/api/thumb?hash=' + f.infoHash + '&idx=' + f.fileIdx + '&t=' + pick, { headers: hdr }).then(function (r) {
        if (r.status === 503) { sess.thumbOff = true; throw 0; }
        if (r.status === 429) { sess.thumbNext = Date.now() + 4000; throw 0; }
        if (!r.ok) { sess.thumbBad[pick] = 1; throw 0; }
        return r.blob();
      }).then(function (blob) { if (blob && S === sess) { try { sess.thumbs[pick] = URL.createObjectURL(blob); } catch (e) {} } });
    }
    var job;
    if (loadedPick) job = picture();
    else {                                                              // download it ahead first (on the server: nothing is sent to the TV), then make the picture from it
      var len = (sess.buf && sess.buf.len) || (st && st.behaviorHints && st.behaviorHints.videoSize) || 0, d = v.duration;
      if (!len) { job = picture(); }
      else {
        sess.farBusy = true;
        var a = Math.max(0, Math.floor(Math.max(0, pick - 1) / d * len)), b = Math.min(len - 1, Math.ceil((pick + THUMB_STEP) / d * len));
        job = fetch('/api/prefetch', { method: 'POST', headers: { 'x-jtv-token': hdr['x-jtv-token'], 'content-type': 'application/json' }, body: JSON.stringify({ infoHash: f.infoHash, fileIdx: f.fileIdx, from: a, to: b }) }).then(function (r) {
          if (r.status === 429) { sess.thumbNext = Date.now() + 4000; throw 0; }
          if (!r.ok) { sess.thumbBad[pick] = 1; throw 0; }
          if (S === sess) { sess.pre = sess.pre || []; addRange(sess.pre, pick, pick + THUMB_STEP); }
          return picture();
        });
      }
    }
    var farJob = !loadedPick && !!sess.farBusy;
    job.catch(function () {}).then(function () { sess.thumbN--; if (farJob) sess.farBusy = false; delete sess.thumbFly[pick]; });
  }
  function thumbNear(time) {
    var th = S.thumbs || {}, g = Math.round(time / THUMB_STEP) * THUMB_STEP;
    return th[g] || th[g - THUMB_STEP] || th[g + THUMB_STEP] || '';
  }
  function previewAt(time, keep) {
    var el = $('#tprev'), d = S && S.v.duration; if (!el || !isFinite(d) || !d) return;
    var pct = Math.max(0, Math.min(1, time / d)), left = 210 + 54 + pct * 1392 - 150;
    var img = $('#timg'), url = thumbNear(time);
    img.style.backgroundImage = url ? 'url("' + url + '")' : ''; img.style.opacity = url ? '1' : '.25';
    $('#ttime').textContent = Views.fmtTime(time * 1000);
    el.style.left = Math.max(40, Math.min(1920 - 340, left)) + 'px'; el.style.display = 'block';
    clearTimeout(S.prevT); if (!keep) S.prevT = setTimeout(function () { var e2 = S && $('#tprev'); if (e2) e2.style.display = 'none'; }, 1700);
  }
  var holdT = null, holdOn = false;
  function holdStop() { clearTimeout(holdT); clearInterval(holdT); holdT = null; }
  function toggle() { if (!S) return; if (S.failed) return pickSource(); if (S.hold) return release('you chose to start'); if (S.v.paused) S.v.play(); else S.v.pause(); }

  /* ---- menus ---- */
  function pickSource(missing) {
    if (!S) return;
    missing = typeof missing === 'string' ? missing : '';
    var opts = [];
    (S.groups || []).forEach(function (g) {
      opts.push({ header: g.label === 'Other' ? 'Other resolutions' : g.label });
      g.items.forEach(function (s) {
        var i = S.streams.indexOf(s), name = String(s.title || s.name || 'Stream').split('\n')[0], q = s._q || {};
        opts.push({ q: '👤 ' + q.seeds, label: name, sub: q.size, idx: i, selected: i === S.idx, file: true, now: i === S.idx, pref: i === 0 });
      });
    });
    Views.menu(missing ? missing + ' is not available – choose an alternative' : 'Choose a source – top 3 by seeds per resolution', opts, function (o) {
      S.failed = false; S.tried = {}; S.resumed = false; S.subOn = false; S.subManual = false; S.subOffset = 0; S.subScale = 1; S.info.startMs = S.v.currentTime * 1000 || S.info.startMs; S.why = ''; start(o.idx);
    }, missing ? 'Nothing was started. These are the files that exist, most seeds first in each resolution.' : 'If a source will not play, try a different resolution.');
  }

  /* ---- picture shape: Aspect cycles the common shapes; Fill scales the picture (at its current shape) until it covers the screen, so there are no black bars ---- */
  var ASPECTS = [['Auto', null], ['16:9', 16 / 9], ['4:3', 4 / 3], ['21:9', 21 / 9], ['1:1', 1]];
  function applyShape() {
    var v = S && S.v; if (!v) return;
    var mode = ASPECTS[S.aspect || 0], r = mode[1] || ((v.videoWidth && v.videoHeight) ? v.videoWidth / v.videoHeight : 16 / 9), W = 1920, H = 1080;
    var w = Math.min(W, H * r), h = w / r;
    if (!S.aspect && !S.fillOn) { v.style.cssText = ''; return; }                  // untouched: the normal full-screen video
    var k = S.fillOn ? Math.max(W / w, H / h) : 1;
    v.style.cssText = 'position:absolute;object-fit:fill;width:' + Math.round(w) + 'px;height:' + Math.round(h) + 'px;left:' + Math.round((W - w) / 2) + 'px;top:' + Math.round((H - h) / 2) + 'px;-webkit-transform:scale(' + k + ');transform:scale(' + k + ');';
  }
  function shapeLabels() {
    var a = $('[data-pact=aspect] .rt'); if (a) a.textContent = ASPECTS[S.aspect || 0][0];
    var f = $('[data-pact=fill]'); if (f) f.classList.toggle('on', !!S.fillOn);
  }
  function cycleAspect() { S.aspect = ((S.aspect || 0) + 1) % ASPECTS.length; applyShape(); shapeLabels(); Views.toast('Aspect ratio: ' + ASPECTS[S.aspect][0], 1800); }
  function toggleFill() { S.fillOn = !S.fillOn; applyShape(); shapeLabels(); Views.toast(S.fillOn ? 'Filling the screen (edges are cropped)' : 'Fill off', 2000); }

  /* ---- audio sync: delays the sound (0 to 5 s) when it arrives before the picture; a browser cannot play sound earlier than the picture ---- */
  function setAudioDelay(ms) {
    ms = Math.max(0, Math.min(5000, ms));
    var AC = window.AudioContext || window.webkitAudioContext; if (!AC) { Views.toast('This TV cannot adjust audio sync', 4000); return false; }
    try {
      if (!S.ac) { S.ac = new AC(); S.asrc = S.ac.createMediaElementSource(S.v); S.dly = S.ac.createDelay(5); S.asrc.connect(S.dly); S.dly.connect(S.ac.destination); }
      if (S.ac.state === 'suspended' && S.ac.resume) S.ac.resume();
      S.dly.delayTime.value = ms / 1000; S.audioMs = ms; return true;
    } catch (e) { Views.toast('Audio sync is not available for this video', 4000); return false; }
  }
  function pickAudioSync() {
    var cur = S.audioMs || 0;
    var opts = [{ label: 'Audio later  (+0.1 s)', d: 100 }, { label: 'Audio later  (+0.5 s)', d: 500 }, { label: 'Audio earlier  (-0.1 s)', d: -100 }, { label: 'Audio earlier  (-0.5 s)', d: -500 }];
    if (cur) opts.push({ label: 'Reset audio sync', reset: true });
    Views.menu('Audio sync' + (cur ? ' – now ' + (cur / 1000).toFixed(1) + ' s later' : ''), opts, function (o) {
      if (o.reset) { setAudioDelay(0); return Views.toast('Audio sync reset', 2000); }
      if (setAudioDelay(cur + o.d)) Views.toast('Audio ' + ((S.audioMs || 0) / 1000).toFixed(1) + ' s later than the picture', 2500);
    }, 'Use this when you hear things before you see them. Sound can only be moved later than the picture. Subtitle timing is under the Subtitles button.');
  }
  function pickSpeed() {
    var rates = [0.75, 1, 1.25, 1.5, 1.75];
    Views.menu('Playback speed', rates.map(function (r) { return { label: r + 'x' + (r > 1 ? '  (sound speeds up, same pitch)' : ''), selected: r === S.rate }; }), function (o, i) {
      var sess = S, r = rates[i], v = S.v, t0 = v.currentTime, w0 = Date.now(), paused = v.paused;
      setRate(r);
      speedLabel(r);
      if (r === 1 || paused || S.hold) return;
      // check the device really runs at that speed (some TVs ignore it); if not, go back to normal speed instead of leaving picture and sound out of step
      setTimeout(function () {
        if (S !== sess || sess.rate !== r || v.paused || sess.hold || v.seeking) return;
        var wall = (Date.now() - w0) / 1000, ran = (v.currentTime - t0) / wall;
        if (wall > 1.5 && ran < r * 0.75) { setRate(1); speedLabel(1); Views.toast('This device cannot play at ' + r + 'x, so it is back to normal speed', 5000); }
      }, 3500);
    });
  }
  /* ---- subtitles matched to the file being watched ---- */
  function subPrefs() { var p = Store.get('subs', null) || {}; return { lang: p.lang || 'eng', lang2: p.lang2 || '', auto: !!p.auto, autosync: !!p.autosync }; }
  function fileCtx() { var st = S.streams[S.idx]; var f = st ? Api.fileInfo(st) : {}; return { filename: f.filename, size: f.size || S.size || 0, hash: S.hash || '' }; }
  function loadSubs(fresh) {
    var sess = S, sig = S.idx;
    if (fresh) { sess.subs = []; sess.subsFor = sig; }
    var ctx = fileCtx(), vid = sess.info.videoId || sess.info.id;
    function fetchAll() {
      return Api.getSubtitles(sess.info.type, vid, ctx).then(function (list) { if (S === sess && S.idx === sig) { sess.subs = list; autoPick(); } });
    }
    fetchAll().then(function () {
      // second pass: the file's own hash (needs the streaming server to read the file's first and last bytes) finds the exact release
      var url = S === sess && Api.opensubHashUrl(sess.streams[sig]);
      if (!url || sess.hashTried === sig) return;
      sess.hashTried = sig;
      Api.getJSON(url, 20000).then(function (j) {
        var r = (j && j.result) || j || {}, h = r.hash || r.moviehash || '';
        if (S === sess && S.idx === sig && h) { sess.hash = h; sess.size = r.size || sess.size; ctx = fileCtx(); fetchAll(); }
      }).catch(function () {});
    });
  }
  function autoPick() {
    if (!S || S.subManual || S.subOn) return;
    var pr = subPrefs(); if (!pr.auto) return;
    var r = Subs.rank(S.subs, fileCtx(), pr, 10);
    if (r.best) applySub(r.best.sub, true);
  }
  function syncKey(sub) { var st = S.streams[S.idx]; return st && st.infoHash ? st.infoHash + ':' + (st.fileIdx != null ? st.fileIdx : -1) + ':' + (sub.id || sub.url) : ''; }
  function applySub(sub, quiet) {
    Array.prototype.forEach.call(S.v.querySelectorAll('track'), function (t) { t.parentNode.removeChild(t); });
    if (!sub) { S.subOn = false; S.subCur = null; if (!quiet) Views.toast('Subtitles off'); return; }
    if (!quiet) Views.toast('Loading subtitles…');
    var sess = S;
    function show(txt) {
      if (S !== sess) return;
      Array.prototype.forEach.call(S.v.querySelectorAll('track'), function (t) { t.parentNode.removeChild(t); });
      var vtt = Subs.shift(Subs.toVtt(txt), S.subOffset || 0, S.subScale || 1), url = URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' })), tr = document.createElement('track');
      tr.kind = 'subtitles'; tr.label = sub.lang; tr.src = url; tr.default = true; S.v.appendChild(tr);
      setTimeout(function () { if (tr.track) tr.track.mode = 'showing'; }, 100);
      var firstTime = S.subCur !== sub; S.subOn = true; S.subCur = sub;
      if (!quiet) Views.toast('Subtitles on: ' + Subs.langName(sub.lang) + (S.subOffset ? ' (' + (S.subOffset > 0 ? '+' : '') + (S.subOffset / 1000).toFixed(1) + ' s)' : ''));
      if (firstTime && subPrefs().autosync && !sub._synced) { sub._synced = true; setTimeout(function () { if (S === sess && S.subCur === sub) autoSync(true); }, 9000); }
    }
    // a timing fix found earlier for this subtitle on this file is reused
    var cached = (Store.get('subsync', {}) || {})[syncKey(sub)];
    if (cached && !S.subOffset && !S.subScale) { S.subOffset = cached.o; S.subScale = cached.s; }
    if (sub._text) return show(sub._text);
    fetch(sub.url).then(function (r) { return r.text(); }).then(function (txt) { sub._text = txt; show(txt); }).catch(function () { if (!quiet) Views.toast('Could not load those subtitles'); });
  }
  /* auto-sync: the server listens to the file's audio and lines the subtitle up with the speech */
  function autoSync(quiet) {
    if (!S || !S.subCur) return Views.toast('Turn on a subtitle first');
    var st = S.streams[S.idx], sub = S.subCur, sess = S;
    if (!st || !st.infoHash) return Views.toast('Auto-sync works for torrent sources');
    if (!sub._text) return Views.toast('Subtitles are still loading');
    if (S.syncing) return;
    S.syncing = true;
    Views.toast('Listening to the audio to line up the subtitles… this can take a minute', 150000);
    Backend.call('POST', '/api/subs/sync', { infoHash: st.infoHash, fileIdx: st.fileIdx != null ? st.fileIdx : -1, subtitle: sub._text }, undefined, 170000).then(function (r) {
      if (S !== sess || S.subCur !== sub) return;
      S.syncing = false; S.subOffset = r.offsetMs; S.subScale = r.scale;
      var c = Store.get('subsync', {}) || {}, k = syncKey(sub); if (k) { c[k] = { o: r.offsetMs, s: r.scale, ts: Date.now() }; var ks = Object.keys(c); if (ks.length > 100) { ks.sort(function (a, b) { return c[a].ts - c[b].ts; }).slice(0, ks.length - 100).forEach(function (x) { delete c[x]; }); } Store.set('subsync', c); }
      applySub(sub, true);
      var sec = (r.offsetMs / 1000).toFixed(1);
      Views.toast(r.note === 'in_sync' ? 'Subtitles were already in sync' : r.note === 'drift' ? 'Fixed subtitle timing drift (frame rate) and moved them ' + (r.offsetMs >= 0 ? 'later' : 'earlier') + ' by ' + Math.abs(sec) + ' s' : 'Subtitles moved ' + (r.offsetMs >= 0 ? 'later' : 'earlier') + ' by ' + Math.abs(sec) + ' s', 5000);
    }).catch(function (e) { if (S === sess) S.syncing = false; Views.toast((e.code === 'low_confidence' || e.code === 'inconsistent' ? e.message + ' Use earlier/later to adjust by hand, or try another subtitle.' : e.message), 7000); });
  }
  function pickSubs() {
    var list = S.subs || [], pr = subPrefs(), r = Subs.rank(list, fileCtx(), pr, 10), best = r.best && r.best.sub, two = r.langs.length > 1;
    var opts = [{ label: 'Off', selected: !S.subOn }];
    if (!r.items.length) Views.toast(list.length ? 'No ' + Subs.langName(pr.lang) + ' subtitles for this title (' + r.hidden + ' in other languages hidden)' : 'No subtitles found (yet)');
    r.items.forEach(function (it) {
      var tag = it.file ? 'Exact file' : (best === it.sub ? 'Best match' : '');
      opts.push({ q: tag, label: (it.sub.subtitleFileName || it.sub.movieReleaseName || it.sub.id || 'Subtitle').slice(0, 70), sub: (two ? Subs.langName(it.sub.lang) + (it.score > 100 ? ' · similar release' : '') : (it.score > 100 ? 'similar release' : '')), pick: it.sub, selected: S.subCur === it.sub });
    });
    if (S.subOn) {
      opts.push({ header: 'Timing' });
      opts.push({ label: 'Auto-sync: fix the timing from the audio', autosync: true });
      opts.push({ label: 'Subtitles earlier  (-0.5 s)', shift: -500 });
      opts.push({ label: 'Subtitles later  (+0.5 s)', shift: 500 });
      if (S.subOffset || (S.subScale && S.subScale !== 1)) opts.push({ label: 'Reset timing', reset: true });
    }
    Views.menu('Subtitles – best ' + Math.max(r.items.length, 0) + ' for this file', opts, function (o, i) {
      if (o.autosync) return autoSync();
      if (o.reset) { S.subOffset = 0; S.subScale = 1; return applySub(S.subCur, true); }
      if (o.shift) { S.subOffset = (S.subOffset || 0) + o.shift; return applySub(S.subCur); }
      S.subManual = true;
      if (!o.pick) return applySub(null);
      S.subOffset = 0; S.subScale = 1; applySub(o.pick);
    }, 'Only ' + r.langs.map(Subs.langName).join(' and ') + ' subtitles are listed (change in Settings), most likely match first.' + (r.hidden ? ' ' + r.hidden + ' in other languages hidden.' : ''));
  }

  document.addEventListener('click', function (e) {
    var el = e.target.closest ? e.target.closest('[data-pact]') : null;
    if (!el || !S) return;
    var a = el.getAttribute('data-pact');
    if (a === 'skipgo') { doSkip(); return; }
    var rep = !!window.JTV_REPEAT;                                         // the key is being held down (remote)
    if (rep && a !== 'back10' && a !== 'fwd10') return;                    // holding OK must not toggle play/pause again and again
    if ((a === 'back10' || a === 'fwd10') && holdOn) { holdOn = false; return; }      // the click that ends a screen hold is not another jump
    if ((a === 'back10' || a === 'fwd10') && rep && S.lastJump && Date.now() - S.lastJump < 1000) return;
    if (a === 'toggle') toggle(); else if (a === 'back10') seekBy(-10, rep); else if (a === 'fwd10') seekBy(10, rep);
    else if (a === 'speed') pickSpeed(); else if (a === 'aspect') cycleAspect(); else if (a === 'fill') toggleFill(); else if (a === 'async') pickAudioSync(); else if (a === 'subs') pickSubs(); else if (a === 'sources') pickSource();
    showUi(true);
  });
  document.addEventListener('mousemove', function (e) {
    if (!S || !e.target || e.target.id !== 'seek' || !S.v.duration) return;
    var r = e.target.getBoundingClientRect(); previewAt(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * S.v.duration);
  });
  document.addEventListener('click', function (e) {
    if (S && e.target.id === 'seek' && S.v.duration) { var r = e.target.getBoundingClientRect(); S.v.currentTime = (e.clientX - r.left) / r.width * S.v.duration; showUi(); }
  });

  /* holding a skip button with a mouse or finger: after a short hold it keeps jumping every second */
  function holdBegin(e) {
    var el = e.target.closest ? e.target.closest('[data-pact=back10],[data-pact=fwd10]') : null; if (!el || !S) return;
    var sec = el.getAttribute('data-pact') === 'back10' ? -10 : 10; holdStop(); holdOn = false;
    holdT = setTimeout(function () { holdOn = true; if (S) seekBy(sec, false); holdT = setInterval(function () { if (!S) return holdStop(); seekBy(sec, true); }, 1000); }, 600);
  }
  document.addEventListener('mousedown', holdBegin); document.addEventListener('touchstart', holdBegin);
  document.addEventListener('mouseup', holdStop); document.addEventListener('touchend', holdStop); document.addEventListener('touchcancel', holdStop);
  document.addEventListener('mouseleave', holdStop);

  /* key handling: returns true when the key was consumed */
  function key(code, e) {
    if (!S || Views.hasMenu() || Views.current().name !== 'player') return false;
    if (S.upnext) { if (code === 13) { playNext(); return true; } return false; }
    var cur = Nav.cur(), onSeek = !cur || cur.id === 'seek' || !S.ui;
    if (code === 415 || code === 19 || code === 179) { if (code === 415 && !S.v.paused) return true; if (code === 19 && S.v.paused) return true; toggle(); return true; }
    var held = !!(e && e.repeat), gate = held && S.lastJump && Date.now() - S.lastJump < 1000;
    if (code === 412) { if (!gate) seekBy(-30, held); return true; }
    if (code === 417) { if (!gate) seekBy(30, held); return true; }
    if (code === 413) { Views.back(); return true; }
    if (!S.ui && (code === 38 || code === 40)) { showUi(true); Nav.set(S.el.querySelector('#seek'), true); return true; }
    if (code === 13) {
      if (e && e.repeat && onSeek) return true;                                // holding OK on the bar does not toggle play/pause again and again
      if (S.skip && !S.skip.hidden && onSeek && doSkip()) return true;           // OK presses the button while it is showing (unless a control has the focus)
      if (!S.ui) { toggle(); showUi(true); return true; }
      if (onSeek) { toggle(); return true; }
      return false;
    }
    if (code === 37 || code === 39) {
      if (onSeek) { if (!gate) seekBy(code === 37 ? -10 : 10, held); return true; }
      showUi(true); Nav.move(code === 37 ? 'left' : 'right'); return true;
    }
    if (code === 40 && cur && cur.id === 'seek') { showUi(true); Nav.set(S.el.querySelector('#bplay')); return true; }
    if (code === 38 || code === 40) { showUi(true); Nav.move(code === 38 ? 'up' : 'down'); return true; }
    return false;
  }

  return { open: open, key: key, close: close, active: function () { return !!S; }, stats: function () { return S ? { rebufs: S.rebufs || 0, hold: !!S.hold, plan: S.buf && S.buf.plan || null, speed: S.buf && S.buf.speed } : null; } };
})();
