/* Subtitle matching: pick the subtitle that fits the file being watched.
   Ranking (highest first): exact file match by video hash, same release (group / source / resolution / codec) as the file name, then language order. */
var Subs = (function () {
  var LANGS = [['eng', 'English'], ['afr', 'Afrikaans'], ['ara', 'Arabic'], ['zho', 'Chinese'], ['hrv', 'Croatian'], ['cze', 'Czech'], ['dan', 'Danish'], ['dut', 'Dutch'], ['fin', 'Finnish'], ['fre', 'French'],
    ['ger', 'German'], ['ell', 'Greek'], ['heb', 'Hebrew'], ['hin', 'Hindi'], ['hun', 'Hungarian'], ['ita', 'Italian'], ['jpn', 'Japanese'], ['kor', 'Korean'], ['nor', 'Norwegian'], ['pol', 'Polish'],
    ['por', 'Portuguese'], ['pob', 'Portuguese (Brazil)'], ['rum', 'Romanian'], ['rus', 'Russian'], ['spa', 'Spanish'], ['swe', 'Swedish'], ['tur', 'Turkish'], ['ukr', 'Ukrainian']];
  var NAMES = {}; LANGS.forEach(function (l) { NAMES[l[0]] = l[1]; });
  function langName(code) { return NAMES[code] || String(code || 'Unknown').toUpperCase(); }

  var SRC = { bluray: 'bluray', brrip: 'bluray', bdrip: 'bluray', bdremux: 'remux', remux: 'remux', webdl: 'web', webrip: 'web', web: 'web', amzn: 'web', nf: 'web', hdtv: 'hdtv', dvdrip: 'dvd', dvd: 'dvd', hdrip: 'hdrip', hdcam: 'cam', cam: 'cam' };
  var CODEC = { x264: 'avc', h264: 'avc', avc: 'avc', x265: 'hevc', h265: 'hevc', hevc: 'hevc', xvid: 'xvid', divx: 'xvid', av1: 'av1' };
  function tokens(name) {
    return String(name || '').toLowerCase().replace(/\.(srt|sub|ass|ssa|vtt|mkv|mp4|avi|m4v|ts)\b/g, ' ').replace(/web[-. ]?dl/g, 'webdl').replace(/blu[-. ]?ray/g, 'bluray')
      .replace(/h[. ]?26([45])/g, 'h26$1').split(/[^a-z0-9]+/).filter(Boolean);
  }
  function parse(name) {
    var t = tokens(name), p = { tokens: t, res: '', src: '', codec: '', group: '' };
    t.forEach(function (x) {
      if (/^(2160p|1080p|1080i|720p|480p|4k)$/.test(x)) p.res = x === '4k' ? '2160p' : x === '1080i' ? '1080p' : x;
      if (SRC[x] && !p.src) p.src = SRC[x];
      if (CODEC[x] && !p.codec) p.codec = CODEC[x];
    });
    var m = /-\s*([a-z0-9]{2,12})(?:\[[^\]]*\])?\s*(?:\.[a-z0-9]{2,4})*\s*$/i.exec(String(name || '').replace(/\.(srt|sub|ass|ssa|vtt)$/i, '').replace(/\.(eng|en|english|[a-z]{3})$/i, ''));
    if (m) p.group = m[1].toLowerCase();
    return p;
  }
  function base(name) { return tokens(name).join(' '); }
  function score(sub, ctx) {
    var s = 0, want = parse(ctx && ctx.filename), got = parse(sub.subtitleFileName || sub.movieReleaseName || '');
    if (sub.m === 'f') s += 1000;                                        // matched by the video's own hash: same file
    if (ctx && ctx.filename && sub.subtitleFileName && base(ctx.filename).indexOf(base(sub.subtitleFileName).replace(/ (eng|en|english)$/, '')) === 0 && base(sub.subtitleFileName).length > 12) s += 200;
    if (want.group) {
      if (got.group === want.group) s += 60; else if (got.tokens.indexOf(want.group) >= 0) s += 40;
    }
    if (want.src && got.src === want.src) s += 30;
    if (want.res && got.res === want.res) s += 15;
    if (want.codec && got.codec === want.codec) s += 10;
    var shared = 0, seen = {}; want.tokens.forEach(function (x) { if (!seen[x] && x.length > 2 && got.tokens.indexOf(x) >= 0) { seen[x] = 1; shared++; } });
    s += Math.min(40, Math.round(shared / Math.max(6, want.tokens.length) * 60));
    return s;
  }
  /* list: addon subtitles; ctx: {filename}; prefs: {lang, lang2}. Returns groups in display order (preferred languages first). */
  function rank(list, ctx, prefs) {
    var pref = [prefs && prefs.lang || 'eng']; if (prefs && prefs.lang2 && prefs.lang2 !== pref[0]) pref.push(prefs.lang2);
    var by = {};
    (list || []).forEach(function (sub, i) { (by[sub.lang || 'und'] = by[sub.lang || 'und'] || []).push({ sub: sub, score: score(sub, ctx), i: i, file: sub.m === 'f' }); });
    var groups = [], codes = Object.keys(by);
    function add(code) { by[code].sort(function (a, b) { return (b.score - a.score) || (a.i - b.i); }); groups.push({ lang: code, label: langName(code), preferred: pref.indexOf(code) >= 0, items: by[code] }); }
    pref.forEach(function (c) { if (by[c]) add(c); });
    codes.filter(function (c) { return pref.indexOf(c) < 0; }).sort(function (a, b) { return langName(a).localeCompare(langName(b)); }).forEach(add);
    var best = groups.length && groups[0].preferred ? groups[0].items[0] : null;
    return { groups: groups, best: best };
  }
  /* shift every cue time of a WebVTT/SRT text by ms (positive = later) */
  function shift(text, ms) {
    if (!ms) return text;
    return text.replace(/(\d{2}):(\d{2}):(\d{2})[.,](\d{3})/g, function (m, h, mi, s, f) {
      var t = Math.max(0, ((+h * 60 + +mi) * 60 + +s) * 1000 + +f + ms), hh = Math.floor(t / 3600000), mm = Math.floor(t % 3600000 / 60000), ss = Math.floor(t % 60000 / 1000), ff = t % 1000;
      function p(n, l) { return String(n).padStart(l || 2, '0'); }
      return p(hh) + ':' + p(mm) + ':' + p(ss) + '.' + p(ff, 3);
    });
  }
  function toVtt(txt) {
    if (!/^\s*WEBVTT/.test(txt)) txt = 'WEBVTT\n\n' + txt.replace(/\r/g, '').replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
    return txt;
  }
  return { LANGS: LANGS, langName: langName, parse: parse, score: score, rank: rank, shift: shift, toVtt: toVtt };
})();
if (typeof module !== 'undefined') module.exports = Subs;
