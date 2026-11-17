/* Player: finds sources, picks the best, plays through the signed-in streaming proxy, glass TV controls. */
var Player = (function () {
  var S = null;   // active session

  function $(sel) { return S && S.el.querySelector(sel); }
  function say(msg) { var m = $('.pmsg'); if (m) { m.textContent = msg || ''; m.style.display = msg ? 'block' : 'none'; } }
  function spin(msg) { var s = $('.pspin'); if (s) { s.textContent = msg || ''; s.style.display = msg ? 'block' : 'none'; } }

  function open(info) {
    if (S) close();
    var h = '<video id="pv" preload="auto"></video><div class="pspin" style="display:none"></div><div class="pmsg" style="display:none"></div>' +
      '<div class="pov"><div class="ptop"><div class="t1">' + Views.esc(info.title || '') + '</div><div class="t2">' + Views.esc([info.sub, info.epTitle].filter(Boolean).join(' · ')) + '</div><div class="pmode glass" id="pmode"></div></div>' +
      '<div class="pbar glass"><div class="seek f" id="seek"><div class="buf"></div><div class="pos"></div><div class="knob"></div></div>' +
      '<div class="times"><span id="tcur">0:00</span><span id="tdur">0:00</span></div>' +
      '<div class="pctl"><span class="cbtn f" data-pact="back10">⏪ 10</span><span class="cbtn big f" data-pact="toggle" id="bplay">❚❚</span><span class="cbtn f" data-pact="fwd10">10 ⏩</span>' +
      '<span class="cbtn f" data-pact="speed">Speed 1x</span><span class="cbtn f" data-pact="subs">Subtitles</span><span class="cbtn f" data-pact="sources">Sources</span></div></div></div>';
    var el = Views.mount('player', h, { cls: 'player', onBack: function () { close(); Views.pop(); return true; }, onClose: cleanup });
    S = { el: el, info: info, v: el.querySelector('#pv'), streams: [], groups: [], idx: -1, tried: {}, rate: 1, subs: null, ui: true, uiT: null, lastSave: 0, tick: null, buffT: null, ended: false, gotTime: false };
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
      var list = res.list; S.streams = list; S.groups = res.groups;
      if (!list.length) { spin(''); say('No sources found on Torrentio for this title.\nTry another title, or check the Torrentio link in Settings.'); return; }
      if (info.pick) { spin(''); return pickSource(); }
      start(0);
    }).catch(function (e) {
      if (!S || S.el !== el) return;
      if (e && e.status === 401) { close(); Views.pop(); return Views.signedOut(); }
      spin(''); say('Could not start: ' + e.message);
    });
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
    var p = v.play(); if (p && p.catch) p.catch(function () {});
    if (S.subsIdx !== i) { S.subsIdx = i; S.hash = null; S.size = 0; loadSubs(true); }     // new file: find subtitles for that file
    var btn = $('[data-pact=speed]'); if (btn) btn.textContent = 'Speed 1x';
  }
  function next(why) {
    if (!S) return;
    var i = S.idx, s = S.streams[i];
    S.why = why || 'playback problem';
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
      if (!alive()) return;
      var st = (sess.info.startMs || 0) / 1000;
      if (st > 5 && !sess.resumed && isFinite(v.duration) && st < v.duration - 20) { try { v.currentTime = st; } catch (e) {} }
      sess.resumed = true;
    });
    v.addEventListener('playing', function () { if (!alive()) return; sess.gotTime = true; spin(''); say(''); sess.failed = false; reapplyRate(); setPlayLabel(); showUi(); });
    v.addEventListener('waiting', function () { if (!alive()) return; clearTimeout(sess.buffT); sess.buffT = setTimeout(function () { if (alive() && !v.paused) spin('Buffering…'); }, 700); });
    v.addEventListener('canplay', function () { if (alive()) { clearTimeout(sess.buffT); spin(''); } });
    v.addEventListener('pause', function () { if (alive()) { setPlayLabel(); showUi(true); save(); } });
    v.addEventListener('play', function () { if (alive()) setPlayLabel(); });
    v.addEventListener('seeked', function () { if (alive()) reapplyRate(); });
    v.addEventListener('ended', function () {
      if (!alive()) return; sess.ended = true; save(true);
      var n = sess.info.getNext && sess.info.getNext(sess.info.videoId || sess.info.id);
      if (n) startUpNext(n); else { close(); Views.pop(); }
    });
    v.addEventListener('error', function () {
      if (!alive()) return;
      var code = v.error ? v.error.code : 0;
      next(code === 4 ? 'This file format is not supported directly' : 'Playback error');
    });
    sess.tick = setInterval(function () { if (alive()) update(); }, 500);
    sess.watchdog = setTimeout(function () { if (alive() && !sess.gotTime && !sess.failed && sess.streams.length) next('Taking too long to start'); }, 45000);
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
  function reapplyRate() { if (S && S.v && Math.abs(S.v.playbackRate - S.rate) > 0.01) { try { S.v.playbackRate = S.rate; } catch (e) {} } }
  function setPlayLabel() { var b = $('#bplay'); if (b && S) b.textContent = S.v.paused ? '▶' : '❚❚'; }

  function update() {
    var v = S.v, d = v.duration, t = v.currentTime;
    if (!isFinite(d) || !d) { return; }
    var pos = $('.seek .pos'), knob = $('.seek .knob'), buf = $('.seek .buf'), pct = Math.min(100, t / d * 100);
    if (pos) pos.style.width = pct + '%'; if (knob) knob.style.left = pct + '%';
    if (buf && v.buffered && v.buffered.length) { var e = v.buffered.end(v.buffered.length - 1); buf.style.width = Math.min(100, e / d * 100) + '%'; }
    $('#tcur').textContent = Views.fmtTime(t * 1000); $('#tdur').textContent = '-' + Views.fmtTime(Math.max(0, d - t) * 1000);
    if (Date.now() - S.lastSave > 10000 && !v.paused) save();
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
    var v = S.v; clearInterval(S.tick); clearTimeout(S.uiT); clearTimeout(S.buffT); clearTimeout(S.watchdog);
    try { v.pause(); v.removeAttribute('src'); v.load(); } catch (e) {}
    S = null;
    if (window.Sync) Sync.run();
  }
  function close() { if (S) cleanup(); }

  /* ---- UI ---- */
  function showUi(keep) {
    if (!S) return;
    S.ui = true; S.el.querySelector('.pov').style.display = 'block';
    clearTimeout(S.uiT);
    if (!(S.v && S.v.paused) || !keep) S.uiT = setTimeout(hideUi, 5000);
  }
  function hideUi() {
    if (!S || S.v.paused || Views.hasMenu()) return;
    S.ui = false; S.el.querySelector('.pov').style.display = 'none'; Nav.set(S.el.querySelector('#seek'), true);
  }
  function seekBy(sec) {
    if (!S || !isFinite(S.v.duration)) return;
    S.v.currentTime = Math.max(0, Math.min(S.v.duration - 2, S.v.currentTime + sec)); update(); showUi(); say('');
  }
  function toggle() { if (!S) return; if (S.failed) return pickSource(); if (S.v.paused) S.v.play(); else S.v.pause(); }

  /* ---- menus ---- */
  function pickSource() {
    if (!S) return;
    var opts = [];
    (S.groups || []).forEach(function (g) {
      opts.push({ header: g.label === 'Other' ? 'Other resolutions' : g.label });
      g.items.forEach(function (s) {
        var i = S.streams.indexOf(s), name = String(s.title || s.name || 'Stream').split('\n')[0], q = s._q || {};
        opts.push({ q: '👤 ' + q.seeds, label: name.slice(0, 90), sub: q.size, idx: i, selected: i === S.idx });
      });
    });
    Views.menu('Choose a source – top 3 by seeds per resolution', opts, function (o) {
      S.failed = false; S.tried = {}; S.resumed = false; S.subOn = false; S.subManual = false; S.info.startMs = S.v.currentTime * 1000 || S.info.startMs; S.why = ''; start(o.idx);
    }, 'If a source will not play, try a different resolution.');
  }
  function pickSpeed() {
    var rates = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
    Views.menu('Playback speed', rates.map(function (r) { return { label: r + 'x', selected: r === S.rate }; }), function (o, i) {
      S.rate = rates[i]; S.v.defaultPlaybackRate = S.rate; S.v.playbackRate = S.rate;
      var b = $('[data-pact=speed]'); if (b) b.textContent = 'Speed ' + S.rate + 'x';
      setTimeout(function () { if (S && Math.abs(S.v.playbackRate - S.rate) > 0.01) Views.toast('This TV cannot play at ' + S.rate + 'x'); }, 800);
    });
  }
  /* ---- subtitles matched to the file being watched ---- */
  function subPrefs() { var p = Store.get('subs', null) || {}; return { lang: p.lang || 'eng', lang2: p.lang2 || '', auto: !!p.auto }; }
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
    var r = Subs.rank(S.subs, fileCtx(), pr);
    if (r.best) applySub(r.best.sub, true);
  }
  function applySub(sub, quiet) {
    Array.prototype.forEach.call(S.v.querySelectorAll('track'), function (t) { t.parentNode.removeChild(t); });
    if (!sub) { S.subOn = false; S.subCur = null; if (!quiet) Views.toast('Subtitles off'); return; }
    if (!quiet) Views.toast('Loading subtitles…');
    var sess = S;
    function show(txt) {
      if (S !== sess) return;
      Array.prototype.forEach.call(S.v.querySelectorAll('track'), function (t) { t.parentNode.removeChild(t); });
      var vtt = Subs.shift(Subs.toVtt(txt), S.subOffset || 0), url = URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' })), tr = document.createElement('track');
      tr.kind = 'subtitles'; tr.label = sub.lang; tr.src = url; tr.default = true; S.v.appendChild(tr);
      setTimeout(function () { if (tr.track) tr.track.mode = 'showing'; }, 100);
      S.subOn = true; S.subCur = sub; if (!quiet) Views.toast('Subtitles on: ' + Subs.langName(sub.lang) + (S.subOffset ? ' (' + (S.subOffset > 0 ? '+' : '') + (S.subOffset / 1000) + 's)' : ''));
    }
    if (sub._text) return show(sub._text);
    fetch(sub.url).then(function (r) { return r.text(); }).then(function (txt) { sub._text = txt; show(txt); }).catch(function () { if (!quiet) Views.toast('Could not load those subtitles'); });
  }
  function pickSubs() {
    var list = S.subs || [], pr = subPrefs(), r = Subs.rank(list, fileCtx(), pr), opts = [{ label: 'Off', selected: !S.subOn }];
    if (!list.length) Views.toast('No subtitles found (yet)');
    var best = r.best && r.best.sub;
    r.groups.forEach(function (g) {
      opts.push({ header: (g.preferred ? '★ ' : '') + g.label });
      g.items.slice(0, g.preferred ? 8 : 3).forEach(function (it, n) {
        var tag = it.file ? 'Exact file' : (best === it.sub ? 'Best match' : '');
        opts.push({ q: tag, label: (it.sub.subtitleFileName || it.sub.movieReleaseName || it.sub.id || 'Subtitle').slice(0, 70), sub: it.score > 60 && !it.file ? 'similar release' : '', sort: it.sub, selected: S.subCur === it.sub });
      });
    });
    if (S.subOn) { opts.push({ header: 'Sync' }); opts.push({ label: 'Subtitles earlier  (-0.5 s)', shift: -500 }); opts.push({ label: 'Subtitles later  (+0.5 s)', shift: 500 }); }
    Views.menu('Subtitles – matched to this file', opts, function (o, i) {
      if (o.shift) { S.subOffset = (S.subOffset || 0) + o.shift; return applySub(S.subCur); }
      S.subManual = true;
      if (!o.sort) return applySub(null);
      S.subOffset = 0; applySub(o.sort);
    }, 'Best match first: the same file (by its fingerprint), then the same release (group, source, resolution), in your language (Settings).');
  }

  document.addEventListener('click', function (e) {
    var el = e.target.closest ? e.target.closest('[data-pact]') : null;
    if (!el || !S) return;
    var a = el.getAttribute('data-pact');
    if (a === 'toggle') toggle(); else if (a === 'back10') seekBy(-10); else if (a === 'fwd10') seekBy(10);
    else if (a === 'speed') pickSpeed(); else if (a === 'subs') pickSubs(); else if (a === 'sources') pickSource();
    showUi(true);
  });
  document.addEventListener('click', function (e) {
    if (S && e.target.id === 'seek' && S.v.duration) { var r = e.target.getBoundingClientRect(); S.v.currentTime = (e.clientX - r.left) / r.width * S.v.duration; showUi(); }
  });

  /* key handling: returns true when the key was consumed */
  function key(code, e) {
    if (!S || Views.hasMenu() || Views.current().name !== 'player') return false;
    if (S.upnext) { if (code === 13) { playNext(); return true; } return false; }
    var cur = Nav.cur(), onSeek = !cur || cur.id === 'seek' || !S.ui;
    if (code === 415 || code === 19 || code === 179) { if (code === 415 && !S.v.paused) return true; if (code === 19 && S.v.paused) return true; toggle(); return true; }
    if (code === 412) { seekBy(-30); return true; }
    if (code === 417) { seekBy(30); return true; }
    if (code === 413) { Views.back(); return true; }
    if (!S.ui && (code === 38 || code === 40)) { showUi(true); Nav.set(S.el.querySelector('#seek'), true); return true; }
    if (code === 13) {
      if (!S.ui) { toggle(); showUi(true); return true; }
      if (onSeek) { toggle(); return true; }
      return false;
    }
    if (code === 37 || code === 39) {
      if (onSeek) { seekBy(code === 37 ? -10 : 10); return true; }
      showUi(true); Nav.move(code === 37 ? 'left' : 'right'); return true;
    }
    if (code === 40 && cur && cur.id === 'seek') { showUi(true); Nav.set(S.el.querySelector('#bplay')); return true; }
    if (code === 38 || code === 40) { showUi(true); Nav.move(code === 38 ? 'up' : 'down'); return true; }
    return false;
  }

  return { open: open, key: key, close: close, active: function () { return !!S; } };
})();
