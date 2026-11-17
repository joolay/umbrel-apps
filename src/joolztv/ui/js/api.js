/* Stremio data layer: account, addons, catalogs, meta, streams, subtitles. Stremio is used only as a source. */
var Api = (function () {
  var CINEMETA = 'https://v3-cinemeta.strem.io';
  var DEFAULT_TORRENTIO = 'https://torrentio.strem.fun/qualityfilter=scr,cam';
  var OLD_DEFAULT = 'https://torrentio.strem.fun/qualityfilter=brremux,hdrall,dolbyvision,dolbyvisionwithhdr,4k,scr,cam,unknown|sizefilter=12GB|limit=10';
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
  function torrentioUrl() { var v = Store.get('torrentio', undefined); return v === undefined || v === null || v === OLD_DEFAULT ? DEFAULT_TORRENTIO : v; }
  function builtinAddons() {
    var out = [], t = torrentioUrl();
    if (t) out.push({ base: baseOf(t), torrentio: true, manifest: { id: 'com.stremio.torrentio.addon', name: 'Torrentio', version: '0', resources: ['stream'], types: ['movie', 'series'], idPrefixes: ['tt'], catalogs: [] } });
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
    return getJSON(url).then(function (r) { return r.metas || []; });
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
  var AUTO = ['1080p', '720p', '4K', 'Other'];          // what plays automatically (first with sources, highest seeds)
  function organise(found) {
    var seen = {}, by = { '4K': [], '1080p': [], '720p': [], 'Other': [] };
    found.forEach(function (s) {
      if (s._q.score <= -400 || !s.infoHash && !s.url) return;
      if (/\bcam\b|camrip|hdcam|telesync|hdts|telecine/.test(((s.title || '') + (s.name || '')).toLowerCase())) return;
      var key = (s.infoHash || s.url) + ':' + (s.fileIdx == null ? '' : s.fileIdx);
      if (seen[key]) return; seen[key] = 1;
      s._cat = categoryOf(s); by[s._cat].push(s);
    });
    var groups = [];
    CATS.forEach(function (c) {
      by[c].sort(function (a, b) { return (b._q.seeds - a._q.seeds) || (b._q.score - a._q.score); });
      if (by[c].length) groups.push({ label: c, items: by[c].slice(0, 3) });
    });
    var list = [];
    AUTO.forEach(function (c) { groups.forEach(function (g) { if (g.label === c) list = list.concat(g.items); }); });
    return { list: list, groups: groups };
  }
  function getStreams(type, videoId, onPartial) {
    var found = [];
    var jobs = addons.filter(function (a) { return a.torrentio && supports(a, 'stream', type, videoId); }).map(function (a) {
      return getJSON(a.base + '/stream/' + type + '/' + encodeURIComponent(videoId) + '.json', 30000).then(function (r) {
        (r.streams || []).forEach(function (s) { s._q = describe(s); s._addon = 'Torrentio'; found.push(s); });
        if (onPartial) onPartial(found.length);
      }).catch(function () {});
    });
    return Promise.all(jobs).then(function () { return organise(found); });
  }
  function getSubtitles(type, videoId) {
    var jobs = addons.filter(function (a) { return supports(a, 'subtitles', type, videoId); }).map(function (a) {
      return getJSON(a.base + '/subtitles/' + type + '/' + encodeURIComponent(videoId) + '.json', 12000)
        .then(function (r) { return r.subtitles || []; }).catch(function () { return []; });
    });
    return Promise.all(jobs).then(function (p) {
      var all = [].concat.apply([], p);
      return all.sort(function (a, b) { return (b.lang === 'eng') - (a.lang === 'eng'); });
    });
  }

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
  function hlsUrl(s) {                                                  // transcoding: the streaming server reads the file from itself, not through the sign-in
    var src = s.url || (internal() + torrentPath(s));
    var id = Math.random().toString(36).slice(2) + Date.now().toString(36);
    return server() + '/hlsv2/' + id + '/master.m3u8?mediaURL=' + encodeURIComponent(src) + '&videoCodecs=h264&audioCodecs=aac&maxAudioChannels=2';
  }

  return {
    ensure: ensure, reload: function () { loaded = false; return loadAddons(); },
    catalogDefs: catalogDefs, fetchCatalog: fetchCatalog, search: search, getMeta: getMeta,
    getStreams: getStreams, torrentioUrl: torrentioUrl, defaultTorrentio: function () { return DEFAULT_TORRENTIO; },
    getSubtitles: getSubtitles, directUrl: directUrl, hlsUrl: hlsUrl, server: server,
    setStreamBase: function (b) { streamBase = b || ''; },
    addons: function () { return addons; }
  };
})();
