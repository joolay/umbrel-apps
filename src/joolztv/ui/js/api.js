/* Stremio data layer: account, addons, catalogs, meta, streams, subtitles. Stremio is used only as a source. */
var Api = (function () {
  var CINEMETA = 'https://v3-cinemeta.strem.io';
  var addons = [];           // [{base, manifest, torrentio?}]
  var loaded = false;

  function timeout(p, ms) {
    return new Promise(function (res, rej) {
      var t = setTimeout(function () { rej(new Error('Timed out')); }, ms);
      p.then(function (v) { clearTimeout(t); res(v); }, function (e) { clearTimeout(t); rej(e); });
    });
  }
  function getJSON(url, ms) {
    return timeout(fetch(url).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }), ms || 15000);
  }
  function baseOf(url) { return url.replace(/\/manifest\.json.*$/, '').replace(/\/+$/, ''); }
  /* the household's settings (preferred quality + source filters) live on the server; this keeps a copy for start-up */
  function prefs() { return Store.get('hhprefs', null) || {}; }
  function setPrefs(p) { var before = JSON.stringify(sourcesCfg()); Store.set('hhprefs', p || {}); if (JSON.stringify(sourcesCfg()) !== before) loaded = false; }   // changed filters: addons are rebuilt on next use
  function quality() { var q = prefs().quality; return Sources.QUALITIES.indexOf(q) >= 0 ? q : ''; }
  function sourcesCfg() { return Sources.normalize(prefs().sources); }
  function torrentioUrl() { return Sources.url(sourcesCfg()); }
  function builtinAddons() {
    var out = [], t = torrentioUrl();
    if (t) out.push({ base: baseOf(t), torrentio: true, manifest: { id: 'jtv.sources', name: 'Sources', version: '0', resources: ['stream'], types: ['movie', 'series'], idPrefixes: ['tt'], catalogs: [] } });
    out.push({ base: 'https://opensubtitles-v3.strem.io', manifest: { id: 'org.stremio.opensubtitlesv3', name: 'OpenSubtitles', version: '0', resources: ['subtitles'], types: ['movie', 'series'], idPrefixes: ['tt'], catalogs: [] } });
    return out;
  }

  /* ---- addons ---- */
  function loadAddons() {
    var fallback = { id: 'com.linvo.cinemeta', name: 'Cinemeta', version: '0', resources: ['catalog', 'meta'], types: ['movie', 'series'], idPrefixes: ['tt'],
      catalogs: [{ type: 'movie', id: 'top', name: 'Popular' }, { type: 'series', id: 'top', name: 'Popular' }] };
    return getJSON(CINEMETA + '/manifest.json').catch(function () { return fallback; }).then(function (m) {
      addons = [{ base: CINEMETA, manifest: m }].concat(builtinAddons()); loaded = true; return addons;
    });
  }
  function ensure() { return loaded ? Promise.resolve(addons) : loadAddons(); }

  function supports(a, res, type, id) {
    var rs = a.manifest.resources || [];
    for (var i = 0; i < rs.length; i++) {
      var r = rs[i], name = typeof r === 'string' ? r : r.name;
      if (name !== res) continue;
      var types = (typeof r === 'string' ? null : r.types) || a.manifest.types;
      var pre = (typeof r === 'string' ? null : r.idPrefixes) || a.manifest.idPrefixes;
      if (types && type && types.indexOf(type) < 0) continue;
      if (pre && id && !pre.some(function (p) { return String(id).indexOf(p) === 0; })) continue;
      return true;
    }
    return false;
  }

  /* ---- catalogs ---- */
  function requiresExtra(c) {
    return (c.extra || []).some(function (e) { return e.isRequired; }) || (c.extraRequired && c.extraRequired.length);
  }
  function catalogDefs() {
    var defs = [];
    addons.forEach(function (a) {
      (a.manifest.catalogs || []).forEach(function (c) {
        if ((c.type !== 'movie' && c.type !== 'series') || requiresExtra(c)) return;
        if (!supports(a, 'catalog', c.type)) { /* some manifests omit resources; keep anyway */ }
        defs.push({ base: a.base, type: c.type, id: c.id, name: c.name || c.id, addon: a.manifest.name });
      });
    });
    return defs;
  }
  function fetchCatalog(def, extra) {
    var url = def.base + '/catalog/' + def.type + '/' + encodeURIComponent(def.id) + (extra ? '/' + extra : '') + '.json';
    return getJSON(url).then(function (r) { return Policy.cleanMetas(r.metas || []); });
  }
  function search(q) {
    var jobs = [];
    addons.forEach(function (a) {
      (a.manifest.catalogs || []).forEach(function (c) {
        if ((c.type !== 'movie' && c.type !== 'series') || jobs.length > 6) return;
        var hasSearch = (c.extra || []).some(function (e) { return e.name === 'search'; }) || (c.extraSupported || []).indexOf('search') >= 0;
        if (hasSearch) jobs.push(fetchCatalog({ base: a.base, type: c.type, id: c.id }, 'search=' + encodeURIComponent(q)).catch(function () { return []; }));
      });
    });
    return Promise.all(jobs).then(function (parts) {
      var seen = {}, out = [];
      [].concat.apply([], parts).forEach(function (m) { if (m && m.id && !seen[m.type + m.id]) { seen[m.type + m.id] = 1; out.push(m); } });
      return out;
    });
  }

  /* ---- meta ---- */
  function getMeta(type, id) {
    var a = addons.filter(function (x) { return supports(x, 'meta', type, id); })[0] || addons[0];
    return getJSON(a.base + '/meta/' + type + '/' + encodeURIComponent(id) + '.json').then(function (r) { return r.meta; });
  }

  /* ---- streams ---- */
  function qualityOf(t) {
    if (/2160p|4k|uhd/.test(t)) return '4K';
    if (/1080p|1080i/.test(t)) return '1080p';
    if (/720p/.test(t)) return '720p';
    if (/480p|dvdrip|sd\b/.test(t)) return 'SD';
    return '';
  }
  function describe(s) {
    var text = ((s.name || '') + ' ' + (s.title || '') + ' ' + (s.description || '') + ' ' + ((s.behaviorHints && s.behaviorHints.filename) || '')).toLowerCase();
    var q = qualityOf(text), sc = 0;
    if (q === '1080p') sc += 40; else if (q === '720p') sc += 28; else if (q === '4K') sc += 12; else if (q === 'SD') sc += 5;
    if (/\bcam\b|camrip|hdcam|\bts\b|telesync|hdts|telecine/.test(text)) sc -= 200;
    if (/hdr|dolby.?vision|\bdv\b/.test(text)) sc -= 12;
    if (/remux/.test(text)) sc -= 14;
    if (/x265|hevc|h\.?265/.test(text)) sc -= 4;
    if (/x264|h\.?264|avc/.test(text)) sc += 6;
    if (/10.?bit/.test(text)) sc -= 8;
    if (/atmos|truehd|dts-hd|dts.?x/.test(text)) sc -= 4;
    var seeds = (/(?:👤|seeders?:?)\s*(\d+)/.exec(text) || [])[1];
    seeds = seeds ? parseInt(seeds, 10) : 0;
    sc += Math.min(25, Math.round(Math.log(seeds + 1) * 4));
    var size = /(\d+(?:\.\d+)?)\s*(gb|mb)/.exec(text), gb = 0;
    if (size) { gb = parseFloat(size[1]) * (size[2] === 'gb' ? 1 : 1 / 1024); if (gb > 20) sc -= 15; else if (gb > 12) sc -= 6; }
    if (/[\u0400-\u04FF\u3040-\u30FF\u4E00-\u9FFF\u0600-\u06FF]/.test((s.title || '') + (s.name || ''))) sc -= 18;   // Cyrillic / CJK / Arabic titles
    if (!s.url && s.infoHash && seeds === 0) sc -= 25;                                                              // dead torrent
    if (s.url) sc += 15;                      // direct/debrid link: no torrent swarm to wait for
    if (!s.url && !s.infoHash) sc -= 500;    // not playable here (external/youtube)
    return { quality: q, seeds: seeds, size: size ? size[1] + ' ' + size[2].toUpperCase() : '', score: sc };
  }
  /* Category from Torrentio's own label ("Torrentio\n1080p"), falling back to the release text. */
  function categoryOf(s) {
    var tok = String(s.name || '').split('\n')[1] || '';
    tok = tok.split(/[\s|]/)[0].toLowerCase();
    if (tok === '4k' || tok === '2160p') return '4K';
    if (tok === '1080p') return '1080p';
    if (tok === '720p') return '720p';
    if (tok) return 'Other';
    var q = s._q ? s._q.quality : '';
    return q === '4K' || q === '1080p' || q === '720p' ? q : 'Other';
  }
  var CATS = ['4K', '1080p', '720p', 'Other'];          // display order
  /* what plays automatically: the preferred definition first, then the nearest ones */
  var ORDER = { '4K': ['4K', '1080p', '720p', 'Other'], '1080p': ['1080p', '720p', '4K', 'Other'], '720p': ['720p', '1080p', '4K', 'Other'] };
  function organise(found, pref) {
    var seen = {}, by = { '4K': [], '1080p': [], '720p': [], 'Other': [] }, counts = {};
    pref = ORDER[pref] ? pref : '1080p';
    found.forEach(function (s) {
      if (s._q.score <= -400 || !s.infoHash && !s.url) return;
      if (/\bcam\b|camrip|hdcam|telesync|hdts|telecine/.test(((s.title || '') + (s.name || '')).toLowerCase())) return;
      if (/\b(xxx|porn|nsfw|hentai|pornhub)\b/i.test((s.title || '') + ' ' + (s.name || '') + ' ' + ((s.behaviorHints && s.behaviorHints.filename) || ''))) return;       // adult material is never offered
      var key = (s.infoHash || s.url) + ':' + (s.fileIdx == null ? '' : s.fileIdx);
      if (seen[key]) return; seen[key] = 1;
      s._cat = categoryOf(s); by[s._cat].push(s);
    });
    var groups = [];
    CATS.forEach(function (c) {
      by[c].sort(function (a, b) { return (b._q.seeds - a._q.seeds) || (b._q.score - a._q.score); });     // most seeds first
      counts[c] = by[c].length;
      if (by[c].length) groups.push({ label: c, items: by[c].slice(0, 3) });
    });
    var list = [];
    ORDER[pref].forEach(function (c) { groups.forEach(function (g) { if (g.label === c) list = list.concat(g.items); }); });
    return { list: list, groups: groups, counts: counts, preferred: pref, hasPreferred: by[pref].length > 0, first: list.length ? list[0]._cat : '' };
  }
  function getStreams(type, videoId, onPartial) {
    var found = [];
    var jobs = addons.filter(function (a) { return a.torrentio && supports(a, 'stream', type, videoId); }).map(function (a) {
      return getJSON(a.base + '/stream/' + type + '/' + encodeURIComponent(videoId) + '.json', 30000).then(function (r) {
        (r.streams || []).forEach(function (s) { s._q = describe(s); s._addon = 'Sources'; found.push(s); });
        if (onPartial) onPartial(found.length);
      }).catch(function () {});
    });
    return Promise.all(jobs).then(function () { return organise(found, quality()); });
  }
  /* ctx: {filename, size, hash} of the file being watched. The subtitle addon uses them to find subtitles for exactly that file. */
  function getSubtitles(type, videoId, ctx) {
    var extra = [];
    if (ctx && ctx.hash) extra.push('videoHash=' + encodeURIComponent(ctx.hash));
    if (ctx && ctx.size) extra.push('videoSize=' + encodeURIComponent(ctx.size));
    if (ctx && ctx.filename) extra.push('filename=' + encodeURIComponent(ctx.filename));
    var jobs = addons.filter(function (a) { return supports(a, 'subtitles', type, videoId); }).map(function (a) {
      return getJSON(a.base + '/subtitles/' + type + '/' + encodeURIComponent(videoId) + (extra.length ? '/' + extra.join('&') : '') + '.json', 12000)
        .then(function (r) { return r.subtitles || []; }).catch(function () { return []; });
    });
    return Promise.all(jobs).then(function (p) { return [].concat.apply([], p); });
  }
  function fileInfo(s) {                                              // what we know about the file behind a stream
    var bh = s.behaviorHints || {};
    return { filename: bh.filename || String(s.title || s.name || '').split('\n')[0], size: bh.videoSize || 0 };
  }

  /* ---- will this device play the file directly, or does the server have to transcode it? ---- */
  function caps() {                                                     // what this browser/TV says it can decode
    var v = document.createElement('video'), ok = function (t) { try { return !!v.canPlayType(t); } catch (e) { return false; } };
    var ua = navigator.userAgent || '';
    return {
      hevc: ok('video/mp4; codecs="hvc1.1.6.L93.B0"') || ok('video/mp4; codecs="hev1.1.6.L93.B0"'),
      hevc10: ok('video/mp4; codecs="hvc1.2.4.L120.B0"'),
      ac3: ok('audio/mp4; codecs="ac-3"'), eac3: ok('audio/mp4; codecs="ec-3"'),
      dts: ok('audio/mp4; codecs="dtsc"') || ok('audio/mp4; codecs="dtse"'),
      tv: /Web0S|webOS|SMART-TV|SmartTV/i.test(ua)
    };
  }
  /* what a release is made of, as short trait ids (read from its name). Used to decide, and to remember what this device can play. */
  var TRAIT_LABELS = { av1: 'AV1 video', oldvid: 'older video formats (AVI/XviD)', h264hi10: '10-bit H.264', hevc: 'HEVC (H.265) video', hevc10: '10-bit HEVC', dv: 'Dolby Vision', hdr: 'HDR video',
    truehd: 'TrueHD audio', dts: 'DTS audio', eac3: 'Dolby Digital Plus audio', ac3: 'Dolby Digital audio', mkv: 'MKV files', ts: 'TS / M2TS files' };
  var BASELINE = { h264: 1, mp4: 1, aac: 1 };                                  // never blamed: if these fail the file or the network is at fault, not the device
  function textOf(s) { return (' ' + [s.name, s.title, s.description, s.behaviorHints && s.behaviorHints.filename].join(' ') + ' ').toLowerCase().replace(/[._\-\[\]()]+/g, ' '); }
  function traitsOf(s) {
    var t = textOf(s), has = function (re) { return re.test(t); }, out = [];
    if (has(/ av1 /)) out.push('av1');
    if (has(/ (xvid|divx|wmv|vc 1|mpeg2) /) || has(/ (avi|wmv|flv|mpg|mpeg|iso|vob) /)) out.push('oldvid');
    if (has(/ (hi10p|hi10) /)) out.push('h264hi10');
    if (has(/ (x265|h ?265|hevc) /)) { out.push('hevc'); if (has(/ (10 ?bit|main ?10) /)) out.push('hevc10'); }
    if (has(/ (dv|dovi|dolby vision) /)) out.push('dv');
    if (has(/ (hdr10?|hdr10plus|hdr) /)) out.push('hdr');
    if (has(/ truehd | true hd /)) out.push('truehd');
    if (has(/ (dts ?hd|dts ?x|dts) /)) out.push('dts');
    if (has(/ (ddp|dd\+|eac3|e ac3|ec 3|atmos) /)) out.push('eac3');
    else if (has(/ (ac3|dd ?[257] ?1?|dd5 1|dolby digital) /)) out.push('ac3');
    if (has(/ mkv /)) out.push('mkv'); if (has(/ (ts|m2ts) /)) out.push('ts');
    return out;
  }
  /* ---- device memory: what this device has (not) been able to play directly. Kept on the device; the next choice uses it. ---- */
  var STALE = 180 * 86400e3;
  function mem() { var m = Store.get('devcaps', null) || {}, now = Date.now(), out = {}; Object.keys(m).forEach(function (k) { if (m[k] && now - (m[k].ts || 0) < STALE) out[k] = m[k]; }); return out; }
  function traitState(t, m) { var e = (m || mem())[t]; if (!e) return 'unknown'; return e.fail > e.ok ? 'bad' : (e.ok > e.fail ? 'good' : 'unknown'); }
  /* every static reason this device might not play the file directly (from its capability report) */
  function risks(s, c) {
    c = c || caps();
    var t = textOf(s), has = function (re) { return re.test(t); }, out = [], tr = traitsOf(s);
    if (tr.indexOf('av1') >= 0) out.push({ trait: 'av1', reason: 'AV1 video' });
    if (tr.indexOf('oldvid') >= 0) out.push({ trait: 'oldvid', reason: 'older video format' });
    if (tr.indexOf('h264hi10') >= 0) out.push({ trait: 'h264hi10', reason: '10-bit H.264' });
    if (tr.indexOf('hevc') >= 0 && !c.hevc) out.push({ trait: 'hevc', reason: 'HEVC video' });
    if (tr.indexOf('hevc') >= 0 && c.hevc && !c.hevc10 && (tr.indexOf('hevc10') >= 0 || has(/ (hdr10?|hdr10plus|dv|dovi|dolby vision) /))) out.push({ trait: 'hevc10', reason: '10-bit HEVC' });
    if (tr.indexOf('dv') >= 0) out.push({ trait: 'dv', reason: 'Dolby Vision' });
    if ((tr.indexOf('dts') >= 0 || tr.indexOf('truehd') >= 0) && !c.dts) out.push({ trait: tr.indexOf('truehd') >= 0 ? 'truehd' : 'dts', reason: 'DTS / TrueHD audio' });
    if (tr.indexOf('eac3') >= 0 && !c.eac3) out.push({ trait: 'eac3', reason: 'Dolby Digital Plus audio' });
    if (tr.indexOf('ac3') >= 0 && !c.ac3) out.push({ trait: 'ac3', reason: 'Dolby Digital audio' });
    return out;
  }
  /* decides: transcode on the server, or play directly? From what this device has taught us, then from its capability report. */
  function assess(s, c) {
    var m = mem(), tr = traitsOf(s), i;
    for (i = 0; i < tr.length; i++) if (traitState(tr[i], m) === 'bad') return { transcode: true, reason: "this device couldn't play " + (TRAIT_LABELS[tr[i]] || tr[i]) + ' before', learned: true };
    var r = risks(s, c);
    for (i = 0; i < r.length; i++) if (traitState(r[i].trait, m) !== 'good') return { transcode: true, reason: r[i].reason };     // a format this device has played directly before is trusted
    return { transcode: false, reason: '' };
  }
  /* remember how a direct play went. ok=true: it played; ok=false: the decoder failed (only strong evidence is passed in). */
  function learn(s, ok) {
    var tr = traitsOf(s).filter(function (x) { return !BASELINE[x]; }); if (!tr.length) return;
    var m = mem(), now = Date.now(), targets = tr;
    if (!ok) {                                                                // blame what could plausibly be the cause, not what already played fine
      var risky = risks(s).map(function (x) { return x.trait; }).filter(function (x) { return traitState(x, m) !== 'good'; });
      var unproven = tr.filter(function (x) { return traitState(x, m) !== 'good'; });
      targets = risky.length ? risky : unproven;
    }
    targets.forEach(function (x) { var e = m[x] || (m[x] = { ok: 0, fail: 0 }); if (ok) e.ok++; else e.fail++; e.ts = now; });
    Store.set('devcaps', m);
  }
  /* result of the first-run device check: a measured fact, so it outweighs earlier guesses (real plays keep adjusting it afterwards) */
  function recordTest(trait, ok) {
    if (BASELINE[trait]) return;
    var m = mem(), e = m[trait] || (m[trait] = { ok: 0, fail: 0 });
    if (ok) e.ok = Math.max(e.ok, e.fail + 1); else e.fail = Math.max(e.fail, e.ok + 1);
    e.ts = Date.now(); e.test = true; Store.set('devcaps', m);
  }
  function deviceReport() { var m = mem(), good = [], bad = []; Object.keys(m).forEach(function (k) { var st = traitState(k, m); if (st === 'good') good.push(TRAIT_LABELS[k] || k); else if (st === 'bad') bad.push(TRAIT_LABELS[k] || k); }); return { good: good, bad: bad }; }
  function forgetDevice() { Store.del('devcaps'); }

  /* ---- turning a stream into a playable URL on the streaming server, always behind the sign-in (/s/<token>/...) ---- */
  var streamBase = '';
  function server() { return streamBase; }                              // https://<this site>/s/<stream token>
  function internal() { return (window.FLIX_CONFIG && FLIX_CONFIG.internalServerUrl) || 'http://127.0.0.1:11470'; }
  function torrentPath(s) {
    var idx = s.fileIdx != null ? s.fileIdx : -1, u = '/' + s.infoHash + '/' + idx;
    var tr = (s.sources || []).filter(function (x) { return x.indexOf('tracker:') === 0; })
      .map(function (x) { return 'tr=' + encodeURIComponent(x.slice(8)); });
    return tr.length ? u + '?' + tr.join('&') : u;
  }
  function directUrl(s) { if (s.url) return s.url; if (!s.infoHash) return null; return server() + torrentPath(s); }
  function hlsUrl(s, safe) {                                            // transcoding: the streaming server reads the file from itself, not through the sign-in
    var src = s.url || (internal() + torrentPath(s)), c = safe ? {} : caps();
    var video = ['h264'].concat(c.hevc && !c.tv ? ['hevc'] : []), audio = ['aac'].concat(c.ac3 ? ['ac3'] : []).concat(c.eac3 ? ['eac3'] : []);
    var id = Math.random().toString(36).slice(2) + Date.now().toString(36);
    return server() + '/hlsv2/' + id + '/master.m3u8?mediaURL=' + encodeURIComponent(src) + '&videoCodecs=' + video.join(',') + '&audioCodecs=' + audio.join(',') + '&maxAudioChannels=' + ((safe || c.tv) ? 2 : 6);
  }
  function statsUrl(s) { return s.infoHash ? server() + '/' + s.infoHash + '/' + (s.fileIdx != null ? s.fileIdx : -1) + '/stats.json' : null; }
  function opensubHashUrl(s) { return s.infoHash ? server() + '/opensubHash?videoUrl=' + encodeURIComponent(internal() + '/' + s.infoHash + '/' + (s.fileIdx != null ? s.fileIdx : -1)) : null; }

  return {
    ensure: ensure, reload: function () { loaded = false; return loadAddons(); },
    catalogDefs: catalogDefs, fetchCatalog: fetchCatalog, search: search, getMeta: getMeta,
    getStreams: getStreams, torrentioUrl: torrentioUrl, prefs: prefs, setPrefs: setPrefs, quality: quality, sourcesCfg: sourcesCfg, organise: organise,
    getSubtitles: getSubtitles, fileInfo: fileInfo, caps: caps, assess: assess, traitsOf: traitsOf, learn: learn, recordTest: recordTest, traitLabel: function (t) { return TRAIT_LABELS[t] || t; }, deviceReport: deviceReport, forgetDevice: forgetDevice, getJSON: getJSON, opensubHashUrl: opensubHashUrl, statsUrl: statsUrl, directUrl: directUrl, hlsUrl: hlsUrl, server: server,
    setStreamBase: function (b) { streamBase = b || ''; },
    addons: function () { return addons; }
  };
})();
