/* Stremio data layer: account, addons, catalogs, meta, streams, subtitles. Stremio is used only as a source. */
var Api = (function () {
  var API = 'https://api.strem.io/api/';
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
  function post(method, body, ms) {
    return timeout(fetch(API + method, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j.error) throw new Error(typeof j.error === 'string' ? j.error : (j.error.message || 'Request failed'));
        return j.result;
      }), ms || 20000);
  }
  function baseOf(url) { return url.replace(/\/manifest\.json.*$/, '').replace(/\/+$/, ''); }
  function authKey() { return Store.get('auth', null); }
  function torrentioUrl() { var v = Store.get('torrentio', undefined); return v === undefined || v === null || v === OLD_DEFAULT ? DEFAULT_TORRENTIO : v; }
  function builtinAddons() {
    var out = [], t = torrentioUrl();
    if (t) out.push({ base: baseOf(t), torrentio: true, manifest: { id: 'com.stremio.torrentio.addon', name: 'Torrentio', version: '0', resources: ['stream'], types: ['movie', 'series'], idPrefixes: ['tt'], catalogs: [] } });
    out.push({ base: 'https://opensubtitles-v3.strem.io', manifest: { id: 'org.stremio.opensubtitlesv3', name: 'OpenSubtitles', version: '0', resources: ['subtitles'], types: ['movie', 'series'], idPrefixes: ['tt'], catalogs: [] } });
    return out;
  }

  /* ---- account ---- */
  function login(email, password) {
    return post('login', { type: 'Login', email: email, password: password, facebook: false }).then(function (r) {
      Store.set('auth', r.authKey); Store.set('email', email); return r;
    });
  }
  function logout() {
    var k = authKey(); Store.del('auth'); Store.del('email'); addons = []; loaded = false; libCache = null;
    if (k) post('logout', { type: 'Logout', authKey: k }, 8000).catch(function () {});
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

  /* ---- library (account): read, add/remove, progress sync ---- */
  var libCache = null, libAt = 0;
  function nowIso() { return new Date().toISOString(); }
  function getLibraryAll(force) {
    var k = authKey();
    if (!k) return Promise.resolve([]);
    if (libCache && !force && Date.now() - libAt < 60000) return Promise.resolve(libCache);
    return post('datastoreGet', { type: 'DatastoreGet', authKey: k, collection: 'libraryItem', ids: [], all: true }).then(function (items) {
      libCache = items || []; libAt = Date.now(); return libCache;
    });
  }
  function libItem(id) { if (!libCache) return null; for (var i = 0; i < libCache.length; i++) if (libCache[i]._id === id) return libCache[i]; return null; }
  function getLibrary() {
    return getLibraryAll().then(function (items) {
      return items.filter(function (i) { return !i.removed && (i.type === 'movie' || i.type === 'series'); })
        .sort(function (a, b) { return String(b._mtime).localeCompare(String(a._mtime)); });
    });
  }
  function idParts(videoId) { var m = /^[^:]+:(\d+):(\d+)$/.exec(videoId || ''); return m ? { season: +m[1], episode: +m[2] } : {}; }
  function getContinue() {
    return getLibraryAll().then(function (items) {
      return items.filter(function (i) {
        var st = i.state || {};
        return (!i.removed || i.temp) && (i.type === 'movie' || i.type === 'series') && st.timeOffset > 0 && st.duration > 0 && st.timeOffset / st.duration < 0.95;
      }).map(function (i) {
        var st = i.state, vid = st.video_id || i._id, ps = idParts(vid);
        return { type: i.type, id: i._id, videoId: vid, name: i.name, poster: i.poster, t: st.timeOffset, d: st.duration,
                 ts: Date.parse(st.lastWatched || i._mtime) || 0, season: ps.season, episode: ps.episode, remote: true };
      });
    });
  }
  /* newest known "where was I" for a title: remote library state vs local resume (caller merges) */
  function remoteLast(id) {
    var it = libItem(id), st = it && it.state;
    if (!st || !st.video_id) return null;
    var ps = idParts(st.video_id);
    return { id: id, videoId: st.video_id, t: st.timeOffset || 0, d: st.duration || 0, ts: Date.parse(st.lastWatched || it._mtime) || 0,
             done: !(st.timeOffset > 0), season: ps.season, episode: ps.episode, remote: true };
  }
  function putItem(item) {
    var k = authKey();
    return post('datastorePut', { type: 'DatastorePut', authKey: k, collection: 'libraryItem', changes: [item] }).then(function () {
      if (libCache) { var found = false; for (var i = 0; i < libCache.length; i++) if (libCache[i]._id === item._id) { libCache[i] = item; found = true; } if (!found) libCache.push(item); }
    });
  }
  function newItem(m) {
    var n = nowIso();
    return { _id: m.id, name: m.name, type: m.type, poster: m.poster || null, posterShape: 'poster', removed: true, temp: true, _ctime: n, _mtime: n,
      state: { lastWatched: null, timeWatched: 0, timeOffset: 0, overallTimeWatched: 0, timesWatched: 0, flaggedWatched: 0, duration: 0, video_id: null, watched: null, noNotif: false },
      behaviorHints: { defaultVideoId: null, featuredVideoId: null } };
  }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function inLibrary(id) { var it = libItem(id); return !!(it && !it.removed); }
  function setInLibrary(meta, yes) {
    if (!authKey()) return Promise.reject(new Error('Sign in first'));
    return getLibraryAll().then(function () {
      var it = libItem(meta.id); it = it ? clone(it) : newItem(meta);
      it.removed = !yes; it.temp = false; it._mtime = nowIso();
      if (!it.name) it.name = meta.name; if (!it.poster) it.poster = meta.poster || null;
      return putItem(it);
    });
  }
  function syncProgress(info, t, d, done) {
    if (!authKey() || Store.get('sync', true) === false) return Promise.resolve();
    return getLibraryAll().then(function () {
      var it = libItem(info.id); it = it ? clone(it) : newItem({ id: info.id, name: info.title, type: info.type, poster: info.poster });
      var st = it.state || (it.state = {});
      st.timeOffset = done ? 0 : Math.round(t); st.duration = Math.round(d); st.video_id = info.videoId || info.id; st.lastWatched = nowIso();
      if (done) { st.flaggedWatched = 1; st.timesWatched = (st.timesWatched || 0) + 1; }
      it._mtime = nowIso();
      return putItem(it);
    }).catch(function () {});
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

  /* ---- turning a stream into a playable URL on the Umbrel server ---- */
  function server() { return (Store.get('server', null) || (window.FLIX_CONFIG && FLIX_CONFIG.serverUrl) || '').replace(/\/+$/, ''); }
  function directUrl(s) {
    if (s.url) return s.url;
    if (!s.infoHash) return null;
    var idx = s.fileIdx != null ? s.fileIdx : -1, u = server() + '/' + s.infoHash + '/' + idx;
    var tr = (s.sources || []).filter(function (x) { return x.indexOf('tracker:') === 0; })
      .map(function (x) { return 'tr=' + encodeURIComponent(x.slice(8)); });
    return tr.length ? u + '?' + tr.join('&') : u;
  }
  function hlsUrl(url) {
    var id = Math.random().toString(36).slice(2) + Date.now().toString(36);
    return server() + '/hlsv2/' + id + '/master.m3u8?mediaURL=' + encodeURIComponent(url) +
      '&videoCodecs=h264&audioCodecs=aac&maxAudioChannels=2';
  }

  return {
    login: login, logout: logout, authKey: authKey, ensure: ensure, reload: function () { loaded = false; return loadAddons(); },
    catalogDefs: catalogDefs, fetchCatalog: fetchCatalog, search: search, getMeta: getMeta, getLibrary: getLibrary,
    resetAccount: function () { libCache = null; libAt = 0; }, getLibraryAll: getLibraryAll, getContinue: getContinue, remoteLast: remoteLast, inLibrary: inLibrary, setInLibrary: setInLibrary, syncProgress: syncProgress,
    getStreams: getStreams, torrentioUrl: torrentioUrl, defaultTorrentio: function () { return DEFAULT_TORRENTIO; }, getSubtitles: getSubtitles, directUrl: directUrl, hlsUrl: hlsUrl, server: server,
    addons: function () { return addons; }
  };
})();
